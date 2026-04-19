// [ FILE NAME : generateStoryboard.web.js : v1.0.0 ]
// Domain  : Storyboard
// Layer   : Backend — Dispatch Gate
// Purpose : Validates caller ownership, guards duplicate runs, stamps project
//           status, assembles the full n8n payload, and fires the signed webhook
//           via postWithRetry (3 attempts, exponential back-off).

import { Permissions, webMethod } from 'wix-web-module';
import { getSecret }              from 'wix-secrets-backend';
import wixData                    from 'wix-data';
import { currentMember }         from 'wix-members-backend';
import { fetch }                  from 'wix-fetch';

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION       = '[ GENERATE STORYBOARD : v1.0.0 ]';
const COLLECTION    = 'projects';
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 500;

// ─── Structured response helpers ─────────────────────────────────────────────
const ok    = (data)          => ({ ok: true,  status: 200, data });
const fail  = (status, type, message) => ({ ok: false, status, error: { type, message } });

// ─── postWithRetry ────────────────────────────────────────────────────────────
async function postWithRetry(url, payload, requestId) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`${VERSION} [${requestId}] Webhook attempt ${attempt}/${MAX_RETRIES}`);

      const response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`${VERSION} [${requestId}] Webhook dispatched successfully on attempt ${attempt}`);
        return { success: true, status: response.status };
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`${VERSION} [${requestId}] Attempt ${attempt} failed — retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// ─── generateStoryboard ───────────────────────────────────────────────────────
export const generateStoryboard = webMethod(
  Permissions.Member,
  async (projectId) => {
    const requestId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`${VERSION} [${requestId}] generateStoryboard() invoked — projectId: ${projectId}`);

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      console.warn(`${VERSION} [${requestId}] Missing or invalid projectId`);
      return fail(400, 'VALIDATION_ERROR', 'projectId is required.');
    }

    // ── 2. Caller identity ───────────────────────────────────────────────────
    let member;
    try {
      member = await currentMember.getMember();
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Member resolution failed: ${err.message}`);
      return fail(401, 'AUTH_ERROR', 'Unable to resolve authenticated member.');
    }

    const callerId = member._id;

    // ── 3. Ownership check + project fetch ───────────────────────────────────
    let project;
    try {
      project = await wixData.get(COLLECTION, projectId);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Project fetch failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to retrieve project data.');
    }

    if (!project) {
      console.warn(`${VERSION} [${requestId}] Project not found: ${projectId}`);
      return fail(404, 'NOT_FOUND', 'Project not found.');
    }

    if (project._owner !== callerId) {
      console.warn(`${VERSION} [${requestId}] Ownership violation — caller: ${callerId}, owner: ${project._owner}`);
      return fail(403, 'FORBIDDEN', 'You do not have permission to generate this storyboard.');
    }

    // ── 4. Duplicate-run guard ───────────────────────────────────────────────
    if (project.storyboardStatus === 'generating') {
      console.warn(`${VERSION} [${requestId}] Concurrent run rejected — status: generating`);
      return fail(409, 'ALREADY_RUNNING', 'A storyboard generation is already in progress for this project.');
    }

    // ── 5. Stamp project — storyboardStatus: 'generating' ───────────────────
    const generationStartedAt = new Date().toISOString();
    try {
      await wixData.update(COLLECTION, {
        ...project,
        storyboardStatus:    'generating',
        generationStartedAt,
      });
      console.log(`${VERSION} [${requestId}] Project stamped — storyboardStatus: generating`);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Status stamp failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to update project status.');
    }

    // ── 6. Retrieve secrets ──────────────────────────────────────────────────
    let webhookUrl;
    try {
      webhookUrl = await getSecret('N8N_STORYBOARD_WEBHOOK_URL');
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Secret retrieval failed: ${err.message}`);
      // Roll back status before returning
      await wixData.update(COLLECTION, { ...project, storyboardStatus: 'failed' }).catch(() => {});
      return fail(500, 'CONFIG_ERROR', 'Pipeline configuration is unavailable. Please try again later.');
    }

    // ── 7. Assemble n8n payload ──────────────────────────────────────────────
    const n8nPayload = {
      submissionId:       requestId,
      timestamp:          generationStartedAt,
      projectId:          project._id,
      owner:              project._owner,
      companyName:        project.companyName        ?? '',
      companyDescription: project.companyDescription ?? '',
      primaryCategory:    project.primaryCategory    ?? '',
      customerType:       project.customerType       ?? '',
      title:              project.title              ?? '',
      goal:               project.goal               ?? '',
      offer:              project.offer              ?? '',
      misconception:      project.misconception      ?? '',
      targetAudience:     project.targetAudience     ?? '',
    };

    console.log(`${VERSION} [${requestId}] Payload assembled — dispatching to n8n`);

    // ── 8. Fire-and-forget webhook dispatch ──────────────────────────────────
    try {
      await postWithRetry(webhookUrl, n8nPayload, requestId);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] All webhook attempts failed: ${err.message}`);
      // Roll back — allow user retry
      await wixData.update(COLLECTION, { ...project, storyboardStatus: 'failed' }).catch(() => {});
      return fail(502, 'WEBHOOK_ERROR', 'Storyboard generation pipeline is unavailable. Please try again.');
    }

    console.log(`${VERSION} [${requestId}] generateStoryboard() completed — fire-and-forget dispatched`);

    return ok({
      projectId,
      storyboardStatus:    'generating',
      generationStartedAt,
      submissionId:        requestId,
    });
  }
);

// ─── Debug export ─────────────────────────────────────────────────────────────
export async function debugGenerateStoryboard(projectId) {
  console.log(`${VERSION} [DEBUG] Invoking generateStoryboard with projectId: ${projectId}`);
  return { debug: true, projectId, timestamp: new Date().toISOString() };
}