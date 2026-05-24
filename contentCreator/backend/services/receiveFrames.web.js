// [ FILE NAME : receiveFrames.web.js : v1.2.0 ]
// Domain  : Storyboard
// Layer   : Backend — n8n Callback Receiver
// Purpose : Public-facing endpoint that accepts per-frame payloads from n8n.
//           Validates the shared secret on every request, enforces owner
//           scoping, implements idempotent writes, and stamps the project
//           'complete' on the 15th frame (frameIndex === 14).
//
// ─────────────────────────────────────────────────────────────────────────────
// Changelog v1.0.0 → v1.2.0
//
// [BUG-IMPORT-01] Remove 'crypto' import — not available in Wix Velo
//
//   ROOT CAUSE:
//     `import { createHmac } from 'crypto'` references a Node.js built-in
//     that is not exposed in the Wix Velo runtime. Wix evaluates all imports
//     at module load time before any function is executed. A single broken
//     import crashes the entire module, causing every call to receiveFrames()
//     to return HTTP 500 MODULE_LOAD_ERROR — the function body is never reached.
//
//   FIX:
//     Removed the 'crypto' import entirely. The refactored validation logic
//     (BUG-HMAC-01 below) does not use createHmac, so no replacement import
//     is needed. The debug export previously called createHmac directly and
//     has been rewritten to remove that dependency.
//
// [BUG-HMAC-01] HMAC contract mismatch — n8n sends secretKey, not hmacSignature
//
//   ROOT CAUSE:
//     v1.0.0 expected an `hmacSignature` field in the n8n payload and
//     re-serialised the remaining fields to verify a HMAC-SHA256 digest.
//     The n8n pipeline (Build Callback Payload node) sends the shared secret
//     directly in the body as `secretKey`, per Storyboarding MVP §5.3 and
//     Architecture Overview §4.2. No `hmacSignature` field is ever sent.
//
//   IMPACT:
//     Step 2 (required field validation) always pushed 'hmacSignature' into
//     missingFields[] and returned HTTP 400 VALIDATION_ERROR immediately,
//     before any HMAC logic ran. Every frame callback from n8n was rejected.
//     The `secretKey` field sent by n8n was never read.
//
//   FIX:
//     Removed `hmacSignature` from required fields and destructuring.
//     Added `secretKey` to required fields.
//     Validation is now a direct constant-time string comparison between the
//     `secretKey` value in the payload and the value stored in Wix Secrets
//     Manager under 'N8N_CALLBACK_SECRET_KEY'. timingSafeEqual() is retained.
//
//     Canonical references:
//       Storyboarding Feature MVP §5.3 (Frame Callback Payload Schema)
//       Architecture Overview §4.2 (receiveFrames security contract)
//       n8n Build Callback Payload node v1.0.0 output contract
//
// [BUG-IMAGEURL-01] imageUrl required check blocks legitimate failure frames
//
//   ROOT CAUSE:
//     v1.0.0 listed `imageUrl` as a required field (!imageUrl → push to missing).
//     n8n sends imageUrl: null on frame generation failures — these are valid
//     failure callbacks that must be written to storyboard_frames with
//     status: 'failed' so the frontend can surface partial storyboard state.
//     Requiring imageUrl caused all failure frame callbacks to return 400.
//
//   FIX:
//     Removed imageUrl from the required fields check. It is still destructured
//     and written to the frame record — null values are valid and intentional.
//
// [BUG-DBOPT-01] wixData.get() called without suppressAuth on project fetch
//
//   ROOT CAUSE:
//     Step 4 (project fetch) called wixData.get(PROJECTS_COLLECTION, projectId)
//     without DB_OPTIONS. Since receiveFrames() runs under Permissions.Anyone
//     (no Wix session), the call uses the visitor permission context, which
//     cannot read the projects collection. This caused the project fetch to
//     throw or return null even for valid projectIds, making every ownership
//     check fail with DATABASE_ERROR or NOT_FOUND.
//
//   FIX:
//     Added DB_OPTIONS ({ suppressAuth: true }) to the project fetch call,
//     consistent with all other wixData calls in this file and the rest of
//     the backend service layer.
// ─────────────────────────────────────────────────────────────────────────────



import { Permissions, webMethod } from 'wix-web-module';
import { getSecret }              from 'wix-secrets-backend';
import wixData                    from 'wix-data';

export function _moduleCheck() { return 'v1.2.0-loaded'; }

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION             = '[ RECEIVE FRAMES : v1.2.0 ]';
const FRAMES_COLLECTION   = 'storyboard_frames';
const PROJECTS_COLLECTION = 'projects';
const TOTAL_FRAMES        = 15;
const FINAL_FRAME_INDEX   = TOTAL_FRAMES - 1; // 14
const DB_OPTIONS          = { suppressAuth: true };

// ─── Structured response helpers ─────────────────────────────────────────────

const ok   = (data)                  => ({ ok: true,  status: 200, data });
const fail = (status, type, message) => ({ ok: false, status, error: { type, message } });

// ─── Constant-time string comparison ─────────────────────────────────────────
// Prevents timing-based secret inference. Both length mismatch and character
// mismatch are detected without short-circuiting.

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

// ─── receiveFrames ────────────────────────────────────────────────────────────

export const receiveFrames = webMethod(
  Permissions.Anyone, // Public — n8n has no Wix session; security is secret-key-gated
  async (framePayload) => {
    const requestId = `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`${VERSION} [${requestId}] receiveFrames() invoked`);

    // ── 1. Payload presence check ────────────────────────────────────────────
    if (!framePayload || typeof framePayload !== 'object') {
      console.warn(`${VERSION} [${requestId}] Empty or non-object payload received`);
      return fail(400, 'VALIDATION_ERROR', 'Request payload is missing or malformed.');
    }

    const {
      secretKey,      // [BUG-HMAC-01] shared secret sent by n8n — replaces hmacSignature
      projectId,
      owner,
      frameIndex,
      imageUrl,       // [BUG-IMAGEURL-01] may be null on failure frames — not required
      promptText,
      frameData,
      status = 'complete',
      failureReason,
    } = framePayload;

    // ── 2. Required field validation ─────────────────────────────────────────
    // [BUG-HMAC-01]     secretKey replaces hmacSignature
    // [BUG-IMAGEURL-01] imageUrl removed — null is valid on failure frames
    const missingFields = [];
    if (!secretKey)                                        missingFields.push('secretKey');
    if (!projectId)                                        missingFields.push('projectId');
    if (!owner)                                            missingFields.push('owner');
    if (frameIndex === undefined || frameIndex === null)   missingFields.push('frameIndex');
    if (promptText  === undefined || promptText  === null) missingFields.push('promptText');

    if (missingFields.length > 0) {
      console.warn(`${VERSION} [${requestId}] Missing required fields: ${missingFields.join(', ')}`);
      return fail(400, 'VALIDATION_ERROR', `Missing required fields: ${missingFields.join(', ')}`);
    }

    if (typeof frameIndex !== 'number' || frameIndex < 0 || frameIndex > FINAL_FRAME_INDEX) {
      console.warn(`${VERSION} [${requestId}] Invalid frameIndex: ${frameIndex}`);
      return fail(400, 'VALIDATION_ERROR', `frameIndex must be a number between 0 and ${FINAL_FRAME_INDEX}.`);
    }

    // ── 3. Secret key validation ─────────────────────────────────────────────
    // [BUG-HMAC-01] Direct constant-time comparison against Wix Secrets Manager.
    // Per MVP §5.3: secretKey in body is the canonical security contract.
    let storedSecret;
    try {
      storedSecret = await getSecret('N8N_CALLBACK_SECRET_KEY');
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Secret retrieval failed: ${err.message}`);
      return fail(500, 'CONFIG_ERROR', 'Callback validation is temporarily unavailable.');
    }

    if (!timingSafeEqual(secretKey, storedSecret)) {
      console.error(
        `${VERSION} [${requestId}] INVALID_SIGNATURE | SECURITY EVENT` +
        ` | projectId: ${projectId} | frameIndex: ${frameIndex}` +
        ` | timestamp: ${new Date().toISOString()} | DO NOT LOG SECRET VALUE`
      );
      return fail(403, 'INVALID_SIGNATURE', 'Request signature is invalid.');
    }

    console.log(`${VERSION} [${requestId}] Secret validated — frameIndex: ${frameIndex} | projectId: ${projectId}`);

    // ── 4. Project ownership enforcement ────────────────────────────────────
    // [BUG-DBOPT-01] DB_OPTIONS required — receiveFrames runs under Permissions.Anyone
    let project;
    try {
      project = await wixData.get(PROJECTS_COLLECTION, projectId, DB_OPTIONS);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Project fetch failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to verify project ownership.');
    }

    if (!project) {
      console.warn(`${VERSION} [${requestId}] Project not found: ${projectId}`);
      return fail(404, 'NOT_FOUND', 'Referenced project does not exist.');
    }

    if (project._owner !== owner) {
      console.warn(
        `${VERSION} [${requestId}] Ownership violation` +
        ` — payload owner: ${owner.substring(0, 6)}****` +
        ` | project _owner: ${project._owner.substring(0, 6)}****`
      );
      return fail(403, 'FORBIDDEN', 'Owner in payload does not match project record.');
    }

    // ── 5. Idempotency — skip duplicate frame writes ─────────────────────────
    let existingFrame;
    try {
      const existingResult = await wixData
        .query(FRAMES_COLLECTION)
        .eq('projectId', projectId)
        .eq('frameIndex', frameIndex)
        .eq('owner', owner)
        .limit(1)
        .find(DB_OPTIONS);

      existingFrame = existingResult.items[0];
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Idempotency check failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to check for existing frame.');
    }

    if (existingFrame) {
      console.log(
        `${VERSION} [${requestId}] Duplicate frame — silently skipping` +
        ` (frameIndex: ${frameIndex} | projectId: ${projectId})`
      );
      return ok({ skipped: true, frameIndex, written: false, reason: 'DUPLICATE_FRAME' });
    }

    // ── 6. Write frame record ────────────────────────────────────────────────
    const frameRecord = {
      projectId,
      owner,
      frameIndex,
      imageUrl:   imageUrl   ?? null,
      promptText: promptText ?? '',
      frameData:  frameData  ?? {},
      status,
      receivedAt: new Date().toISOString(),
      ...(failureReason ? { failureReason } : {}),
    };

    try {
      await wixData.insert(FRAMES_COLLECTION, frameRecord, DB_OPTIONS);
      console.log(`${VERSION} [${requestId}] Frame written — frameIndex: ${frameIndex} | status: ${status}`);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Frame write failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to persist frame data.');
    }

    // ── 7. Project status update ─────────────────────────────────────────────
    if (frameIndex === FINAL_FRAME_INDEX) {
      // Final frame — stamp project complete
      const completedAt = new Date().toISOString();
      try {
        await wixData.update(
          PROJECTS_COLLECTION,
          {
            ...project,                         // full spread — never wipe fields
            storyboardStatus:     'complete',
            storyboardFrameCount: TOTAL_FRAMES,
            completedAt,
          },
          DB_OPTIONS
        );
        console.log(
          `${VERSION} [${requestId}] Final frame received` +
          ` — project stamped complete | projectId: ${projectId} | completedAt: ${completedAt}`
        );
      } catch (err) {
        // Non-fatal: frame was written; log and continue
        console.error(`${VERSION} [${requestId}] Project completion stamp failed (non-fatal): ${err.message}`);
      }
    } else {
      // Intermediate frame — increment running frame count for polling progress
      try {
        await wixData.update(
          PROJECTS_COLLECTION,
          {
            ...project,                         // full spread — never wipe fields
            storyboardFrameCount: (project.storyboardFrameCount ?? 0) + 1,
          },
          DB_OPTIONS
        );
      } catch (err) {
        // Non-fatal: frame was written; count is a progress indicator only
        console.warn(`${VERSION} [${requestId}] Frame count increment failed (non-fatal): ${err.message}`);
      }
    }

    console.log(`${VERSION} [${requestId}] receiveFrames() completed successfully`);

    return ok({
      frameIndex,
      projectId,
      written:  true,
      isFinal:  frameIndex === FINAL_FRAME_INDEX,
    });
  }
);

// ─── Debug export ─────────────────────────────────────────────────────────────
// [BUG-IMPORT-01] createHmac removed — crypto is not available in Velo.

export async function debugReceiveFrames() {
  console.log(`${VERSION} [DEBUG] receiveFrames module loaded successfully`);
  return {
    debug:     true,
    version:   VERSION,
    timestamp: new Date().toISOString(),
  };
}