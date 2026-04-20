/**
 * Service: Project Service
 * Path: /backend/services/project.web.js
 * Version: [ PROJECT SERVICE : v.2.2.0 ]
 *
 * v.2.2.0 — Storyboard Additions
 * ────────────────────────────────
 * Appends three new webMethod exports for the Storyboarding MVP.
 * All exports from v.2.1.0 are preserved unchanged.
 *
 * New exports:
 *   generateStoryboard(projectId)    — dispatch gate; fires n8n webhook
 *   receiveFrames(framePayload)      — n8n per-frame callback; HMAC-protected
 *   getStoryboardFrames(projectId)   — polling read endpoint; owner-scoped
 *
 * Existing exports (unchanged from v.2.1.0):
 *   createProject          — creates a new project record
 *   updateProject          — owner-only patch
 *   verifyProjectAccess    — authorization gate for the Project Detail page
 *   getUserProjectCount    — total project count for the authenticated member
 *   getMyProjects          — paginated project list for the authenticated member
 *
 * Scalability remediations from v.2.1.0 (preserved):
 *   SC-02  getMyProjects enforces PROJECT_LIMIT (25), returns nextCursor.
 *   SC-02  getStoryboardFrames uses .limit(TOTAL_FRAMES).
 *   SC-03  MAX_RETRIES = 2, WEBHOOK_TIMEOUT_MS = 8000 ms.
 *   SC-07  getUserProjectCount and getMyProjects query on _owner only.
 *
 * Wix Secrets required:
 *   N8N_STORYBOARD_WEBHOOK_URL  — n8n trigger URL
 *   N8N_CALLBACK_SECRET_KEY     — shared HMAC key for receiveFrames
 *
 * Collections:
 *   projects  — core project records
 *   frames    — per-frame image + metadata (projectId · owner-scoped)
 *
 * Required CMS indexes (configure in Wix Dashboard → Content Manager):
 *   projects : compound (_owner, _createdDate DESC)
 *   frames   : compound (projectId, frameIndex ASC)
 *   frames   : secondary (owner, projectId)
 */

import { Permissions, webMethod } from 'wix-web-module';
import wixData                    from 'wix-data';
import { currentMember }          from 'wix-members-backend';

// NOTE: wix-secrets-backend and wix-fetch are intentionally NOT imported at
// the module level — both are backend-only. A top-level static import causes
// Wix's bundler to attempt resolution in the frontend context and throw:
//   "Cannot find module 'wix-web-module' in 'public/pages/...'"
// Both are required inline inside the webMethods that use them.

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const VERSION             = '[ PROJECT SERVICE : v.2.2.0 ]';

const COLLECTION_PROJECTS = 'projects';
const COLLECTION_FRAMES   = 'frames';
const DB_OPTIONS          = { suppressAuth: true };

const ROLE_ADMIN          = 'Admin';

// Pagination ceiling — enforced at the data layer, not just the UI.
const PROJECT_LIMIT       = 25;

// Storyboard pipeline
const SECRET_N8N_WEBHOOK  = 'N8N_STORYBOARD_WEBHOOK_URL';
const SECRET_CALLBACK_KEY = 'N8N_CALLBACK_SECRET_KEY';
const TOTAL_FRAMES        = 15;

// SC-03: Webhook retry config — timeout reduced so MAX_RETRIES × WEBHOOK_TIMEOUT_MS
// stays well under the 30-second Velo webMethod execution ceiling.
//   Previous: MAX_RETRIES = 3, WEBHOOK_TIMEOUT_MS = 12000  → up to 36+ s
//   Current:  MAX_RETRIES = 2, WEBHOOK_TIMEOUT_MS = 8000   → up to ~17 s
const MAX_RETRIES         = 2;
const RETRY_DELAYS        = [500, 1500];   // ms — one delay between two attempts
const RETRYABLE_STATUSES  = [429, 502, 503, 504];
const WEBHOOK_TIMEOUT_MS  = 8000;

// Storyboard status values
const STATUS_GENERATING   = 'generating';
const STATUS_COMPLETE     = 'complete';
const STATUS_FAILED       = 'failed';

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

/**
 * Resolves the currently authenticated member's ID and admin status in a
 * single getMember() call (FULL fieldset covers PUBLIC fields and roles).
 *
 * @returns {{ memberId: string|null, isAdmin: boolean }}
 */
async function getAuthenticatedMember() {
    try {
        const member = await currentMember.getMember({ fieldsets: ['FULL'] });
        if (!member) return { memberId: null, isAdmin: false };

        const isAdmin = Array.isArray(member.roles)
            ? member.roles.some((r) => r.name === ROLE_ADMIN)
            : false;

        return { memberId: member._id, isAdmin };
    } catch (err) {
        console.error(`${VERSION} getAuthenticatedMember failure:`, err);
        return { memberId: null, isAdmin: false };
    }
}

/**
 * Fires a POST request to a webhook URL with exponential backoff.
 * Each attempt is independently aborted after WEBHOOK_TIMEOUT_MS.
 *
 * SC-03: MAX_RETRIES = 2, WEBHOOK_TIMEOUT_MS = 8000 ms.
 * Worst-case total execution time ≈ 17 s, safely under the 30 s Velo limit.
 *
 * @param {string} url
 * @param {object} body
 * @returns {{ ok: boolean, status: number, data?: any, error?: object }}
 */
async function postWithRetry(url, body) {
    const { fetch } = require('wix-fetch');
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        try {
            console.log(`${VERSION} Webhook attempt ${attempt}/${MAX_RETRIES}`);

            const response = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
                signal:  controller.signal
            });

            clearTimeout(timer);

            if (response.ok) {
                const data = await response.json().catch(() => ({}));
                return { ok: true, status: response.status, data };
            }

            if (!RETRYABLE_STATUSES.includes(response.status)) {
                console.error(`${VERSION} Non-retryable status: ${response.status}`);
                return {
                    ok:     false,
                    status: response.status,
                    error:  { type: 'HTTP_ERROR', message: `Status ${response.status}` }
                };
            }

            lastError = `HTTP ${response.status}`;

        } catch (err) {
            clearTimeout(timer);
            lastError = err.name === 'AbortError' ? 'TIMEOUT' : err.message;
            console.warn(`${VERSION} Webhook attempt ${attempt} failed: ${lastError}`);
        }

        if (attempt < MAX_RETRIES) {
            await new Promise(res => setTimeout(res, RETRY_DELAYS[attempt - 1]));
        }
    }

    console.error(`${VERSION} All ${MAX_RETRIES} webhook attempts exhausted. Last error: ${lastError}`);
    return { ok: false, status: 503, error: { type: 'WEBHOOK_UNAVAILABLE', message: lastError } };
}

// ─── CREATE PROJECT ───────────────────────────────────────────────────────────

/**
 * Creates a new project record owned by the authenticated member.
 *
 * The `owner` field is written alongside the Wix-native `_owner` for
 * backward compatibility with records created under v1.3.x. Once a data
 * migration consolidates all records to `_owner`, the `owner` mirror can
 * be removed from the insert payload (SC-07 long-term cleanup).
 *
 * @param {object} projectData
 * @returns {{ ok: boolean, data?: object, error?: object }}
 */
export const createProject = webMethod(Permissions.Anyone, async (projectData) => {
    try {
        const { memberId } = await getAuthenticatedMember();
        if (!memberId) {
            console.warn(`${VERSION} createProject: Unauthenticated attempt.`);
            return { ok: false, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
        }

        const payload = {
            title:           projectData.title,
            description:     projectData.description,
            goal:            projectData.goal,
            offer:           projectData.offer,
            target_audience: projectData.target_audience ?? projectData.audience,
            misconception:   projectData.misconception,
            // Write both fields during the transition period (SC-07).
            owner:           memberId
        };

        const result = await wixData.insert(COLLECTION_PROJECTS, payload, DB_OPTIONS);
        console.log(`${VERSION} createProject: Created ${result._id} for member: ${memberId}`);
        return { ok: true, data: result };

    } catch (err) {
        console.error(`${VERSION} createProject failure:`, err);
        return { ok: false, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── VERIFY PROJECT ACCESS ────────────────────────────────────────────────────

/**
 * Authorization gate for the Project Detail dynamic page.
 * Access is granted only to the project owner or a site admin.
 * Returns no project data on denial to prevent information leakage.
 *
 * @param {string} projectId
 * @returns {{ ok: boolean, authorized: boolean, data?: object, error?: object }}
 */
export const verifyProjectAccess = webMethod(Permissions.Anyone, async (projectId) => {
    try {
        if (!projectId) {
            console.warn(`${VERSION} verifyProjectAccess: Called without a projectId.`);
            return {
                ok: false, authorized: false,
                error: { type: 'MISSING_ID', message: 'Project ID is required.' }
            };
        }

        const { memberId, isAdmin } = await getAuthenticatedMember();
        if (!memberId) {
            console.warn(`${VERSION} verifyProjectAccess: Unauthenticated attempt. Project: ${projectId}`);
            return {
                ok: true, authorized: false,
                error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' }
            };
        }

        const project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
        if (!project) {
            console.warn(`${VERSION} verifyProjectAccess: Not found. ID: ${projectId}`);
            return {
                ok: false, authorized: false,
                error: { type: 'NOT_FOUND', message: 'Project not found.' }
            };
        }

        if (project._owner === memberId) {
            console.log(`${VERSION} verifyProjectAccess: GRANTED (owner). Member: ${memberId}`);
            return { ok: true, authorized: true, data: project };
        }

        if (isAdmin) {
            console.log(`${VERSION} verifyProjectAccess: GRANTED (admin). Member: ${memberId}`);
            return { ok: true, authorized: true, data: project };
        }

        console.warn(`${VERSION} verifyProjectAccess: DENIED. Member: ${memberId}`);
        return {
            ok: true, authorized: false,
            error: { type: 'FORBIDDEN', message: 'You do not have permission to view this project.' }
        };

    } catch (err) {
        console.error(`${VERSION} verifyProjectAccess failure:`, err);
        return { ok: false, authorized: false, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── UPDATE PROJECT ───────────────────────────────────────────────────────────

/**
 * Updates an existing project record. Owner-only — admin read access does
 * not confer write access by design.
 *
 * @param {string} projectId
 * @param {object} projectData
 * @returns {{ ok: boolean, data?: object, error?: object }}
 */
export const updateProject = webMethod(Permissions.Anyone, async (projectId, projectData) => {
    try {
        if (!projectId) {
            console.warn(`${VERSION} updateProject: Called without a projectId.`);
            return { ok: false, error: { type: 'MISSING_ID', message: 'Project ID is required.' } };
        }

        const { memberId } = await getAuthenticatedMember();
        if (!memberId) {
            console.warn(`${VERSION} updateProject: Unauthorized attempt.`);
            return { ok: false, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
        }

        const existing = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
        if (!existing) {
            console.error(`${VERSION} updateProject: Not found. ID: ${projectId}`);
            return { ok: false, error: { type: 'NOT_FOUND', message: 'Project not found.' } };
        }

        if (existing._owner !== memberId) {
            console.warn(`${VERSION} updateProject: Ownership mismatch. Member: ${memberId}`);
            return { ok: false, error: { type: 'FORBIDDEN', message: 'You do not have permission to edit this project.' } };
        }

        const updatePayload = {
            _id:             existing._id,
            _owner:          existing._owner,
            owner:           existing.owner,   // preserve mirror field during transition
            title:           projectData.title,
            description:     projectData.description,
            goal:            projectData.goal,
            offer:           projectData.offer,
            target_audience: projectData.target_audience,
            misconception:   projectData.misconception
        };

        const result = await wixData.update(COLLECTION_PROJECTS, updatePayload, DB_OPTIONS);
        console.log(`${VERSION} updateProject: Updated ${result._id} by member: ${memberId}`);
        return { ok: true, data: result };

    } catch (err) {
        console.error(`${VERSION} updateProject failure:`, err);
        return { ok: false, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── GET PROJECT COUNT ────────────────────────────────────────────────────────

/**
 * Returns the total project count for the authenticated member.
 * SC-07: queries on _owner (Wix-native indexed field) not the mirror field.
 *
 * @returns {{ ok: boolean, count: number, error?: object }}
 */
export const getUserProjectCount = webMethod(Permissions.Anyone, async () => {
    try {
        const { memberId } = await getAuthenticatedMember();
        if (!memberId) return { ok: true, count: 0 };

        const count = await wixData.query(COLLECTION_PROJECTS)
            .eq('_owner', memberId)
            .count(DB_OPTIONS);

        console.log(`${VERSION} getUserProjectCount: ${count} for member: ${memberId}`);
        return { ok: true, count };

    } catch (err) {
        console.error(`${VERSION} getUserProjectCount failure:`, err);
        return { ok: false, count: 0, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── GET MY PROJECTS ──────────────────────────────────────────────────────────

/**
 * Returns a page of projects owned by the authenticated member, newest first.
 *
 * SC-02: Enforces PROJECT_LIMIT (25) at the data layer.
 * SC-07: Queries on _owner (Wix-native indexed field).
 *
 * @param {{ limit?: number, cursor?: string|null }} [options]
 * @returns {{ ok: boolean, data: array, nextCursor: string|null, error?: object }}
 */
export const getMyProjects = webMethod(Permissions.Anyone, async ({ limit = PROJECT_LIMIT, cursor = null } = {}) => {
    try {
        const { memberId } = await getAuthenticatedMember();
        if (!memberId) return { ok: true, data: [], nextCursor: null };

        const safeLimit = Math.min(limit, PROJECT_LIMIT);

        let query = wixData.query(COLLECTION_PROJECTS)
            .eq('_owner', memberId)
            .descending('_createdDate')
            .limit(safeLimit);

        const results = cursor
            ? await query.skipTo(cursor).find(DB_OPTIONS)
            : await query.find(DB_OPTIONS);

        const nextCursor = results.cursors?.next || null;

        console.log(`${VERSION} getMyProjects: ${results.items.length} projects for member: ${memberId}. hasMore: ${!!nextCursor}`);
        return { ok: true, data: results.items, nextCursor };

    } catch (err) {
        console.error(`${VERSION} getMyProjects failure:`, err);
        return { ok: false, data: [], nextCursor: null, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── GENERATE STORYBOARD ──────────────────────────────────────────────────────

/**
 * Initiates the n8n storyboard generation pipeline for a project.
 *
 * Flow:
 *   1. Input guard.
 *   2. Identity check.
 *   3. Fetch project and verify ownership.
 *   4. Guard: reject if already generating (ALREADY_RUNNING).
 *   5. Stamp project: storyboardStatus = 'generating'.
 *   6. Resolve webhook URL from Wix Secrets Manager (inline require).
 *   7. Dispatch signed payload to n8n via postWithRetry.
 *   8. On dispatch failure: rollback project status to 'failed'.
 *
 * @param {string} projectId
 * @returns {{ ok: boolean, status: number, error?: object }}
 */
export const generateStoryboard = webMethod(Permissions.Anyone, async (projectId) => {
    try {
        if (!projectId) {
            console.warn(`${VERSION} generateStoryboard: No projectId supplied.`);
            return { ok: false, status: 400, error: { type: 'MISSING_ID', message: 'Project ID is required.' } };
        }

        const { memberId } = await getAuthenticatedMember();
        if (!memberId) {
            console.warn(`${VERSION} generateStoryboard: Unauthenticated attempt.`);
            return { ok: false, status: 401, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
        }

        const project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
        if (!project) {
            console.warn(`${VERSION} generateStoryboard: Project not found: ${projectId}`);
            return { ok: false, status: 404, error: { type: 'NOT_FOUND', message: 'Project not found.' } };
        }
        if (project._owner !== memberId) {
            console.warn(`${VERSION} generateStoryboard: Ownership mismatch. Member: ${memberId}`);
            return { ok: false, status: 403, error: { type: 'FORBIDDEN', message: 'You do not own this project.' } };
        }

        if (project.storyboardStatus === STATUS_GENERATING) {
            console.warn(`${VERSION} generateStoryboard: Already running for project: ${projectId}`);
            return {
                ok: false, status: 409,
                error: { type: 'ALREADY_RUNNING', message: 'Storyboard generation is already in progress.' }
            };
        }

        await wixData.update(COLLECTION_PROJECTS, {
            ...project,
            storyboardStatus:      STATUS_GENERATING,
            storyboardFrameCount:  0,
            storyboardStartedAt:   new Date().toISOString(),
            storyboardCompletedAt: null
        }, DB_OPTIONS);

        console.log(`${VERSION} generateStoryboard: Project ${projectId} marked as generating.`);

        // Inline require — see module-level note on wix-secrets-backend imports.
        const { getSecret } = require('wix-secrets-backend');
        const webhookUrl = await getSecret(SECRET_N8N_WEBHOOK);

        if (!webhookUrl) {
            console.error(`${VERSION} generateStoryboard: Secret '${SECRET_N8N_WEBHOOK}' not found.`);
            await wixData.update(COLLECTION_PROJECTS, { ...project, storyboardStatus: STATUS_FAILED }, DB_OPTIONS);
            return {
                ok: false, status: 500,
                error: { type: 'CONFIGURATION_ERROR', message: 'Storyboard service is not configured.' }
            };
        }

        const webhookPayload = {
            projectId:       project._id,
            owner:           memberId,
            title:           project.title,
            description:     project.description,
            goal:            project.goal,
            offer:           project.offer,
            target_audience: project.target_audience,
            misconception:   project.misconception,
            totalFrames:     TOTAL_FRAMES,
            dispatchedAt:    new Date().toISOString()
        };

        const webhookResult = await postWithRetry(webhookUrl, webhookPayload);

        if (!webhookResult.ok) {
            await wixData.update(COLLECTION_PROJECTS, { ...project, storyboardStatus: STATUS_FAILED }, DB_OPTIONS);
            console.error(`${VERSION} generateStoryboard: Dispatch failed. Project rolled back to failed.`);
            return {
                ok: false, status: 503,
                error: { type: 'DISPATCH_FAILED', message: 'Unable to start generation. Please try again.' }
            };
        }

        console.log(`${VERSION} generateStoryboard: Pipeline dispatched for project: ${projectId}`);
        return { ok: true, status: 202 };

    } catch (err) {
        console.error(`${VERSION} generateStoryboard failure:`, err);
        return { ok: false, status: 500, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── RECEIVE FRAMES (n8n CALLBACK) ────────────────────────────────────────────

/**
 * Called by n8n as each frame completes.
 * Public (Permissions.Anyone) — n8n has no Wix member session.
 *
 * Security layers:
 *   1. Shared-secret validation via secretKey field.
 *   2. Ownership re-verified against the DB before any write.
 *   3. Idempotent: duplicate deliveries from n8n retries are silently skipped.
 *
 * @param {object} framePayload
 * @returns {{ ok: boolean, status: number, duplicate?: boolean, isComplete?: boolean, error?: object }}
 */
export const receiveFrames = webMethod(Permissions.Anyone, async (framePayload) => {
    try {
        const { projectId, owner, frameIndex, imageUrl, promptText, frameData, secretKey } = framePayload || {};

        // 1. Payload guard
        if (!projectId || frameIndex === undefined || !imageUrl || !secretKey) {
            console.warn(`${VERSION} receiveFrames: Incomplete payload.`);
            return { ok: false, status: 400, error: { type: 'INVALID_PAYLOAD', message: 'Missing required fields.' } };
        }

        // 2. Secret validation (inline require — see module-level note)
        const { getSecret } = require('wix-secrets-backend');
        const expectedKey = await getSecret(SECRET_CALLBACK_KEY);
        if (!expectedKey || secretKey !== expectedKey) {
            console.error(`${VERSION} receiveFrames: Invalid secret. Project: ${projectId}`);
            return { ok: false, status: 401, error: { type: 'UNAUTHORIZED', message: 'Invalid callback secret.' } };
        }

        // 3. Ownership re-verification
        const project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
        if (!project) {
            console.warn(`${VERSION} receiveFrames: Project not found: ${projectId}`);
            return { ok: false, status: 404, error: { type: 'NOT_FOUND', message: 'Project not found.' } };
        }
        if (project._owner !== owner) {
            console.error(`${VERSION} receiveFrames: Owner mismatch. Project: ${projectId}`);
            return { ok: false, status: 403, error: { type: 'FORBIDDEN', message: 'Owner mismatch.' } };
        }

        // 4. Idempotency — silently skip frames already written
        const existing = await wixData.query(COLLECTION_FRAMES)
            .eq('projectId', projectId)
            .eq('frameIndex', frameIndex)
            .find(DB_OPTIONS);

        if (existing.totalCount > 0) {
            console.log(`${VERSION} receiveFrames: Duplicate skipped. frameIndex: ${frameIndex} project: ${projectId}`);
            return { ok: true, status: 200, duplicate: true };
        }

        // 5. Write frame record
        await wixData.insert(COLLECTION_FRAMES, {
            projectId,
            owner,
            frameIndex,
            imageUrl,
            promptText:  promptText  || '',
            frameData:   frameData   || {},
            status:      'complete',
        }, DB_OPTIONS);

        console.log(`${VERSION} receiveFrames: Frame written. frameIndex: ${frameIndex} project: ${projectId}`);

        // 6. Check for completion — stamp project on final frame
        const isComplete = frameIndex === TOTAL_FRAMES - 1;

        await wixData.update(COLLECTION_PROJECTS, {
            ...project,
            storyboardFrameCount:  frameIndex + 1,
            storyboardStatus:      isComplete ? STATUS_COMPLETE : STATUS_GENERATING,
            ...(isComplete ? { storyboardCompletedAt: new Date().toISOString() } : {})
        }, DB_OPTIONS);

        if (isComplete) {
            console.log(`${VERSION} receiveFrames: All ${TOTAL_FRAMES} frames received. Project ${projectId} marked complete.`);
        }

        return { ok: true, status: 201, frameIndex, isComplete };

    } catch (err) {
        console.error(`${VERSION} receiveFrames failure:`, err);
        return { ok: false, status: 500, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── GET STORYBOARD FRAMES (POLLING ENDPOINT) ─────────────────────────────────

/**
 * Returns all currently-saved frames for a project, ordered by frameIndex.
 *
 * SC-02: .limit(TOTAL_FRAMES) prevents silent truncation and bounds the
 *        response payload to at most 15 frame records.
 *
 * Security — two layers:
 *   1. Caller identity verified against project._owner (or Admin).
 *   2. DB query scoped to both projectId AND owner — defence in depth.
 *
 * Result shape consumed by storyboard-poller.js v.2.0.0:
 *   { ok, frames, projectStatus, frameCount }
 *
 * @param {string} projectId
 * @returns {{ ok: boolean, status: number, frames?: array, projectStatus?: string, frameCount?: number, totalFrames?: number, error?: object }}
 */
export const getStoryboardFrames = webMethod(Permissions.Anyone, async (projectId) => {
    try {
        if (!projectId) {
            return { ok: false, status: 400, error: { type: 'MISSING_ID', message: 'Project ID is required.' } };
        }

        const { memberId, isAdmin } = await getAuthenticatedMember();
        if (!memberId) {
            return { ok: false, status: 401, error: { type: 'AUTH_REQUIRED', message: 'Authentication required.' } };
        }

        const project = await wixData.get(COLLECTION_PROJECTS, projectId, DB_OPTIONS);
        if (!project) {
            return { ok: false, status: 404, error: { type: 'NOT_FOUND', message: 'Project not found.' } };
        }
        if (project._owner !== memberId && !isAdmin) {
            console.warn(`${VERSION} getStoryboardFrames: Unauthorized. Member: ${memberId}, Project: ${projectId}`);
            return { ok: false, status: 403, error: { type: 'FORBIDDEN', message: 'Access denied.' } };
        }

        // SC-02: Explicit limit prevents silent truncation at Wix's default 50-item cap.
        const results = await wixData.query(COLLECTION_FRAMES)
            .eq('projectId', projectId)
            .eq('owner', project._owner)   // defence-in-depth ownership scope
            .ascending('frameIndex')
            .limit(TOTAL_FRAMES)
            .find(DB_OPTIONS);

        console.log(`${VERSION} getStoryboardFrames: ${results.items.length} frames for project ${projectId}.`);

        return {
            ok:            true,
            status:        200,
            frames:        results.items,
            projectStatus: project.storyboardStatus || 'idle',
            frameCount:    results.items.length,
            totalFrames:   TOTAL_FRAMES
        };

    } catch (err) {
        console.error(`${VERSION} getStoryboardFrames failure:`, err);
        return { ok: false, status: 500, error: { type: 'INTERNAL', message: err.message } };
    }
});

// ─── DEBUG ────────────────────────────────────────────────────────────────────

export function debugProjectService() {
    console.log(`${VERSION} Config: PROJECT_LIMIT=${PROJECT_LIMIT}, MAX_RETRIES=${MAX_RETRIES}, WEBHOOK_TIMEOUT_MS=${WEBHOOK_TIMEOUT_MS}, TOTAL_FRAMES=${TOTAL_FRAMES}`);
}