// [ FILE NAME : generateStoryboard.web.js : v2.0.0 ]
// Domain  : Storyboard
// Layer   : Backend — Dispatch Gate + Cancel
// Path    : /backend/storyboard/generateStoryboard.web.js
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.9.4 → v2.0.0
//
// [BUG-CRYPTO-06] Web Crypto API inaccessible in .web.js compilation context
//
//   ROOT CAUSE:
//     Velo compiles .web.js files in a restricted client-boundary context
//     that rejects all global crypto identifiers at static analysis time.
//     Across v1.9.0–v1.9.4, the following were each attempted and rejected:
//       v1.9.0  — crypto.subtle          (no-undef: 'crypto')
//       v1.9.1  — /* global crypto */    (directive not honoured)
//       v1.9.2  — globalThis.crypto      (no-undef: 'globalThis')
//       v1.9.3  — self.crypto            (no-undef: 'self')
//       v1.9.4  — new Function(...)      (bundler rejects at compile time)
//
//     The underlying cause is architectural: .web.js modules are compiled
//     as public webMethod boundaries and do not have access to Node.js
//     built-ins OR browser globals in Velo's static analysis pass.
//
//   FIX:
//     Extracted buildHmacSignature() into a dedicated private backend module:
//       /backend/storyboard/hmac.js
//
//     Private .js files in /backend/ are compiled in the full server-side
//     Node.js context where `import { createHmac } from 'crypto'` is valid.
//     generateStoryboard.web.js imports buildHmacSignature from that module.
//
//     The function is synchronous again — Node.js createHmac is synchronous.
//     The `await` added in v1.9.0 has been removed from the call site.
//
//   REQUIRED COMPANION FILE:
//     /backend/storyboard/hmac.js must be created alongside this file.
//     See hmac.js for full implementation. Without it this file will throw
//     an import resolution error at module load time.
//
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.8.0 → v1.9.x — preserved for history
//
// [BUG-CRYPTO-01–05] Various failed attempts to access Web Crypto API
//   directly inside a .web.js module. Superseded by v2.0.0 architectural fix.
//
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.7.0 → v1.8.0 — preserved for history
//
// [BUG-03] generateStoryboard — status stamp wipes all project fields
//
//   wixData.update() with suppressAuth replaces the ENTIRE document. A
//   partial object wipes every field not included in the payload. Fix: spread
//   the full `project` record into the update payload, then overlay only the
//   storyboard status fields. No additional DB read required.
//
// [BUG-04] generateStoryboard — _currentProject not refreshed after cancel
//
//   After a confirmed cancel, wireCancelButton() now updates
//   _currentProject.storyboardStatus in memory to 'cancelled'. Handled in
//   the companion fix in project-detail.page.js v2.9.0.
//
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.6.0 → v1.7.0 — preserved for history
//
// [FIX-SIGNAL-01] postWithRetry — AbortController/signal removed
//
//   WixFetchRequest does not support AbortController/signal. Timeout enforced
//   via Promise.race() between the fetch promise and a manually constructed
//   rejection promise. Timer cleared in finally block on all code paths.
//
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.5.0 → v1.6.0 — preserved for history
//
// [BUG-02] cancelStoryboard — full-document-replace wipes all project fields
//
//   wixData.update() replaces the entire document. v1.5.0 cancel stamp wrote
//   only { _id, storyboardStatus, cancelledAt }, wiping all other fields.
//   Fix: spread the full project record and overlay only the cancel fields.
//
// ──────────────────────────────────────────────────────────────────────────────

import { Permissions, webMethod } from 'wix-web-module';
import { getSecret }              from 'wix-secrets-backend';
import wixData                    from 'wix-data';
import { currentMember }          from 'wix-members-backend';
import { fetch }                  from 'wix-fetch';
import { buildHmacSignature } from 'backend/security.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION              = '[ GENERATE STORYBOARD : v2.0.0 ]';
const CANCEL_VERSION       = '[ CANCEL STORYBOARD : v1.3.0 ]';

const COLLECTION_PROJECTS  = 'projects';
const COLLECTION_PROFILES  = 'profiles';

const SECRET_WEBHOOK_URL   = 'N8N_STORYBOARD_WEBHOOK_URL';
const SECRET_CALLBACK_KEY  = 'N8N_CALLBACK_SECRET_KEY';

const MAX_RETRIES          = 3;
const BASE_DELAY_MS        = 500;
const WEBHOOK_TIMEOUT_MS   = 8000;
const RETRYABLE_STATUSES   = [429, 502, 503, 504];

const STATUS_GENERATING    = 'generating';
const STATUS_FAILED        = 'failed';
const STATUS_CANCELLED     = 'cancelled';

const REQUIRED_PROFILE_FIELDS = [
  'companyName',
  'companyDescription',
  'primaryCategory',
  'subCategory',
  'customerType',
];
const REQUIRED_PROJECT_FIELDS = ['targetAudience'];

const DB_OPTIONS = { suppressAuth: true };

// ─── Structured response helpers ──────────────────────────────────────────────

const ok   = (data)                  => ({ ok: true,  status: 200, data });
const fail = (status, type, message) => ({ ok: false, status, error: { type, message } });

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getMemberId() {
  try {
    const member = await currentMember.getMember({ fieldsets: ['FULL'] });
    return member?._id ?? null;
  } catch (err) {
    console.error(`${VERSION} getMemberId failure: ${err.message}`);
    return null;
  }
}

/**
 * Best-effort status rollback to STATUS_FAILED.
 *
 * Uses full spread of the project record — rollback must not wipe fields.
 * The project record is already in scope at every call site, so no
 * additional DB read is required. Only storyboardStatus is overlaid.
 */
async function rollbackStatus(project, requestId) {
  try {
    await wixData.update(
      COLLECTION_PROJECTS,
      {
        ...project,
        storyboardStatus: STATUS_FAILED,
      },
      DB_OPTIONS
    );
    console.warn(`${VERSION} [${requestId}] Status rolled back to '${STATUS_FAILED}'`);
  } catch (err) {
    console.error(`${VERSION} [${requestId}] Rollback failed (non-fatal): ${err.message}`);
  }
}

// ─── Webhook dispatch with retry ──────────────────────────────────────────────

async function postWithRetry(url, rawBody, hmacSignature, requestId) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // [FIX-SIGNAL-01] WixFetchRequest does not support AbortController/signal.
    // Timeout enforced via Promise.race() — the fetch races against a rejection
    // promise that fires after WEBHOOK_TIMEOUT_MS milliseconds.
    // The timer is cleared in a finally block on every code path.
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('TIMEOUT')),
        WEBHOOK_TIMEOUT_MS
      );
    });

    try {
      console.log(`${VERSION} [${requestId}] Webhook attempt ${attempt}/${MAX_RETRIES}`);

      const fetchPromise = fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-HMAC-Signature': hmacSignature,
        },
        body: rawBody,
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        console.log(`${VERSION} [${requestId}] Webhook dispatched successfully on attempt ${attempt}`);
        return { ok: true, status: response.status, data };
      }

      await response.text().catch(() => {});

      if (!RETRYABLE_STATUSES.includes(response.status)) {
        console.error(`${VERSION} [${requestId}] Non-retryable HTTP ${response.status} — aborting`);
        return {
          ok:     false,
          status: response.status,
          error:  { type: 'HTTP_ERROR', message: `Non-retryable HTTP ${response.status}` },
        };
      }

      lastError = `HTTP ${response.status}`;
      console.warn(`${VERSION} [${requestId}] Attempt ${attempt} returned ${response.status}`);

    } catch (err) {
      // Catches both the timeout rejection ('TIMEOUT') and any network errors.
      lastError = err.message === 'TIMEOUT' ? 'TIMEOUT' : err.message;
      console.warn(`${VERSION} [${requestId}] Attempt ${attempt} failed: ${lastError}`);
    } finally {
      // Always clear the timeout timer to prevent it firing after resolution.
      clearTimeout(timeoutId);
    }

    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.error(
    `${VERSION} [${requestId}] All ${MAX_RETRIES} webhook attempts exhausted. Last error: ${lastError}`
  );
  return {
    ok:     false,
    status: 503,
    error:  { type: 'WEBHOOK_UNAVAILABLE', message: lastError },
  };
}

// ─── generateStoryboard ───────────────────────────────────────────────────────

export const generateStoryboard = webMethod(
  Permissions.SiteMember,
  async (projectId) => {
    const requestId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`${VERSION} [${requestId}] generateStoryboard() invoked — projectId: ${projectId}`);

    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      console.warn(`${VERSION} [${requestId}] Missing or invalid projectId`);
      return fail(400, 'VALIDATION_ERROR', 'projectId is required.');
    }

    const memberId = await getMemberId();
    if (!memberId) {
      console.warn(`${VERSION} [${requestId}] Unauthenticated attempt`);
      return fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    }

    let project;
    try {
      project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Project fetch failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to load project. Please try again.');
    }

    if (!project) {
      console.warn(`${VERSION} [${requestId}] Project not found: ${projectId}`);
      return fail(404, 'NOT_FOUND', 'Project not found.');
    }

    if (project._owner !== memberId) {
      console.warn(`${VERSION} [${requestId}] Ownership mismatch — caller: ${memberId}`);
      return fail(403, 'FORBIDDEN', 'You do not own this project.');
    }

    if (project.storyboardStatus === STATUS_GENERATING) {
      console.warn(`${VERSION} [${requestId}] Already generating — projectId: ${projectId}`);
      return fail(409, 'ALREADY_RUNNING', 'Storyboard generation is already in progress.');
    }

    let profile = null;
    let webhookUrl, callbackSecret;

    try {
      const [profileResult, webhookUrlValue, callbackSecretValue] = await Promise.all([
        wixData
          .query(COLLECTION_PROFILES)
          .eq('_owner', memberId)
          .limit(1)
          .find(DB_OPTIONS)
          .then((res) => res.items[0] ?? null),
        getSecret(SECRET_WEBHOOK_URL),
        getSecret(SECRET_CALLBACK_KEY),
      ]);

      profile        = profileResult;
      webhookUrl     = webhookUrlValue;
      callbackSecret = callbackSecretValue;

    } catch (err) {
      console.error(`${VERSION} [${requestId}] Profile/secret fetch failed: ${err.message}`);
      return fail(500, 'CONFIG_ERROR', 'Pipeline configuration is unavailable. Please try again later.');
    }

    if (!profile) {
      console.warn(`${VERSION} [${requestId}] No profile record found for member: ${memberId}`);
    } else {
      console.log(`${VERSION} [${requestId}] Profile loaded — enriching payload fields`);
    }

    const missingSecrets = [
      !webhookUrl     && SECRET_WEBHOOK_URL,
      !callbackSecret && SECRET_CALLBACK_KEY,
    ].filter(Boolean);

    if (missingSecrets.length > 0) {
      console.error(`${VERSION} [${requestId}] Empty secrets: ${missingSecrets.join(', ')}`);
      return fail(500, 'CONFIG_ERROR', 'Pipeline configuration is incomplete. Please contact support.');
    }

    const enriched = {
      companyName:        project.companyName        || profile?.companyName        || '',
      companyDescription: project.companyDescription || profile?.companyDescription || '',
      primaryCategory:    project.primaryCategory    || profile?.primaryCategory    || '',
      subCategory:        project.subCategory        || profile?.subCategory        || '',
      customerType:       project.customerType       || profile?.customerType       || '',
      targetAudience:     project.target_audience    || '',
    };

    console.log(
      `${VERSION} [${requestId}] Enriched` +
      ` | companyName: "${enriched.companyName}"` +
      ` | primaryCategory: "${enriched.primaryCategory}"` +
      ` | subCategory: "${enriched.subCategory}"` +
      ` | customerType: "${enriched.customerType}"` +
      ` | targetAudience: "${enriched.targetAudience}"`
    );

    const missingProfile = REQUIRED_PROFILE_FIELDS.filter((f) => !enriched[f]);
    const missingProject = REQUIRED_PROJECT_FIELDS.filter((f) => !enriched[f]);
    const missingFields  = [...missingProfile, ...missingProject];

    if (missingFields.length > 0) {
      const parts = [];
      if (missingProfile.length > 0) {
        parts.push(`Profile Settings missing: ${missingProfile.join(', ')}`);
      }
      if (missingProject.length > 0) {
        parts.push(`Project missing: ${missingProject.join(', ')} — please edit your project`);
      }
      const userMessage = `${parts.join('. ')}.`;
      console.warn(`${VERSION} [${requestId}] Pre-dispatch validation failed — ${userMessage}`);
      return {
        ok: false, status: 400,
        error: { type: 'INCOMPLETE_DATA', message: userMessage, missingProfile, missingProject },
      };
    }

    console.log(`${VERSION} [${requestId}] Pre-dispatch validation passed — all required fields resolved`);

    const generationStartedAt = new Date().toISOString();

    // ── [BUG-03] FIX: spread full project record, overlay storyboard fields ────
    // wixData.update() replaces the entire document. A partial object wipes
    // every field not explicitly included. Fix: spread `project` first (already
    // fetched above), then overlay only the storyboard status fields.
    try {
      await wixData.update(
        COLLECTION_PROJECTS,
        {
          ...project,
          storyboardStatus:      STATUS_GENERATING,
          storyboardFrameCount:  0,
          storyboardStartedAt:   generationStartedAt,
          storyboardCompletedAt: null,
        },
        DB_OPTIONS
      );
      console.log(`${VERSION} [${requestId}] Project stamped '${STATUS_GENERATING}'`);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Status stamp failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to update project status.');
    }

    const n8nPayload = {
      submissionId:       requestId,
      timestamp:          generationStartedAt,
      projectId:          project._id,
      owner:              project._owner,
      companyName:        enriched.companyName,
      companyDescription: enriched.companyDescription,
      primaryCategory:    enriched.primaryCategory,
      subCategory:        enriched.subCategory,
      customerType:       enriched.customerType,
      targetAudience:     enriched.targetAudience,
      title:              project.title         ?? '',
      description:        project.description   ?? '',
      goal:               project.goal          ?? '',
      offer:              project.offer         ?? '',
      misconception:      project.misconception ?? '',
    };

    const rawBody = JSON.stringify(n8nPayload);

    // [BUG-CRYPTO-06] buildHmacSignature imported from backend/storyboard/hmac.js.
    // Synchronous — no await required. Node.js createHmac is synchronous.
    const hmacSig = buildHmacSignature(rawBody, callbackSecret);

    console.log(`${VERSION} [${requestId}] Payload assembled — HMAC signed — dispatching to n8n`);

    const dispatchResult = await postWithRetry(webhookUrl, rawBody, hmacSig, requestId);

    if (!dispatchResult.ok) {
      console.error(
        `${VERSION} [${requestId}] All webhook attempts failed: ${dispatchResult.error?.message}`
      );
      await rollbackStatus(project, requestId);
      return fail(502, 'WEBHOOK_ERROR', 'Storyboard generation pipeline is unavailable. Please try again.');
    }

    console.log(
      `${VERSION} [${requestId}] DISPATCH_COMPLETE` +
      ` | submissionId: ${requestId}` +
      ` | projectId: ${project._id}` +
      ` | timestamp: ${generationStartedAt}`
    );

    return ok({
      projectId,
      storyboardStatus:    STATUS_GENERATING,
      generationStartedAt,
      submissionId:        requestId,
    });
  }
);

// ─── cancelStoryboard ─────────────────────────────────────────────────────────

/**
 * Stamps the project storyboardStatus as 'cancelled' to halt polling.
 *
 * [BUG-02] v1.6.0 — Full-document-replace bug fixed.
 *
 *   wixData.update() with suppressAuth replaces the full document. Every
 *   other field (target_audience, title, goal, offer, etc.) was wiped to null
 *   in v1.5.0. Fix: spread the full project record and overlay only the cancel
 *   fields. No additional DB read required — project is already in scope.
 */
export const cancelStoryboard = webMethod(
  Permissions.SiteMember,
  async (projectId) => {
    const requestId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`${CANCEL_VERSION} [${requestId}] cancelStoryboard() invoked — projectId: ${projectId}`);

    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      console.warn(`${CANCEL_VERSION} [${requestId}] Missing or invalid projectId`);
      return fail(400, 'VALIDATION_ERROR', 'projectId is required.');
    }

    const memberId = await getMemberId();
    if (!memberId) {
      console.warn(`${CANCEL_VERSION} [${requestId}] Unauthenticated attempt`);
      return fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    }

    let project;
    try {
      project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
    } catch (err) {
      console.error(`${CANCEL_VERSION} [${requestId}] Project fetch failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to load project.');
    }

    if (!project) {
      console.warn(`${CANCEL_VERSION} [${requestId}] Project not found: ${projectId}`);
      return fail(404, 'NOT_FOUND', 'Project not found.');
    }

    if (project._owner !== memberId) {
      console.warn(`${CANCEL_VERSION} [${requestId}] Ownership mismatch — caller: ${memberId}`);
      return fail(403, 'FORBIDDEN', 'You do not own this project.');
    }

    if (project.storyboardStatus !== STATUS_GENERATING) {
      console.warn(
        `${CANCEL_VERSION} [${requestId}] No-op — status is already: ${project.storyboardStatus}`
      );
      return ok({ projectId, storyboardStatus: project.storyboardStatus, cancelled: false });
    }

    // ── [BUG-02] FIX: spread full project record, overlay cancel fields ────────
    try {
      await wixData.update(
        COLLECTION_PROJECTS,
        {
          ...project,
          storyboardStatus: STATUS_CANCELLED,
          cancelledAt:      new Date().toISOString(),
        },
        DB_OPTIONS
      );
    } catch (err) {
      console.error(`${CANCEL_VERSION} [${requestId}] Cancel stamp failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to update project status.');
    }

    console.log(
      `${CANCEL_VERSION} [${requestId}] Project stamped '${STATUS_CANCELLED}' — projectId: ${projectId}`
    );
    return ok({ projectId, storyboardStatus: STATUS_CANCELLED, cancelled: true });
  }
);

// ─── Debug exports ────────────────────────────────────────────────────────────

export async function debugGenerateStoryboard(projectId = 'debug-project-id') {
  console.log(`${VERSION} [DEBUG] generateStoryboard simulation — projectId: ${projectId}`);
  return { debug: true, projectId, timestamp: new Date().toISOString() };
}

export async function debugCancelStoryboard(projectId = 'debug-project-id') {
  console.log(`${CANCEL_VERSION} [DEBUG] cancelStoryboard simulation — projectId: ${projectId}`);
  return { debug: true, projectId, timestamp: new Date().toISOString() };
}

export async function debugWebhookStatus() {
  console.log(`${VERSION} [DEBUG] debugWebhookStatus called`);
  return {
    debug:         true,
    version:       VERSION,
    cancelVersion: CANCEL_VERSION,
    timestamp:     new Date().toISOString(),
  };
}