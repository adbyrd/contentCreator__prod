/**
 * Page: Project Detail (Dynamic)
 * Path: /page_code/dashboard/project-detail.page.js
 * Version: [ PROJECT DETAIL : v.2.4.0 ]
 *
 * v.2.4.0 — ALREADY_RUNNING handling + DISPATCH_FAILED error routing
 * ────────────────────────────────────────────────────────────────────
 * ISSUE A — DISPATCH_FAILED treated the same as all other errors.
 *   The previous version treated every !result.ok response with a single
 *   generic showToaster(MSG_GENERATION_FAILED). This meant ALREADY_RUNNING
 *   (which should resume the active poller) and DISPATCH_FAILED (a real
 *   infrastructure failure) produced the same UX — both blocked the user.
 *
 * FIX: wireGenerateButton() now routes each error type explicitly:
 *   ALREADY_RUNNING  → resume polling (attach to the in-progress run)
 *   DISPATCH_FAILED  → user-safe message + button restored for retry
 *   CONFIG_ERROR     → user-safe message + button restored for retry
 *   All others       → generic fallback message + button restored
 *
 * ISSUE B — DISPATCH_FAILED is a backend infrastructure issue, not a
 *   code bug. The n8n webhook URL must be configured in Wix Secrets
 *   Manager as 'N8N_STORYBOARD_WEBHOOK_URL' and the n8n workflow must
 *   be active and reachable. See deployment checklist below.
 *
 * DEPLOYMENT CHECKLIST (resolve DISPATCH_FAILED):
 *   1. In Wix Dashboard → Secrets Manager:
 *      - N8N_STORYBOARD_WEBHOOK_URL must be set to the live n8n webhook URL
 *      - N8N_CALLBACK_SECRET_KEY must be set to the shared HMAC secret
 *   2. In n8n workspace:
 *      - Storyboard workflow must be ACTIVE (not draft)
 *      - Webhook trigger node must be listening (production URL, not test URL)
 *   3. Verify with: debugGenerateStoryboard() in Wix API Explorer
 *
 * v.2.3.0 changes preserved:
 *   - startStoryboardPolling() positional signature fix
 *   - onFrame(frame, frames) aligned to poller v.2.0.0 contract
 *   - stopStoryboardPolling() called before re-dispatch
 *   - Import paths: backend/services/project.web
 */

import wixLocation  from 'wix-location';
import wixWindow    from 'wix-window';
import { verifyProjectAccess, generateStoryboard }           from 'backend/services/project.web';
import { validateProjectForGeneration }                      from 'public/utils/validation';
import { safeDisable, safeShow, safeHide, setButtonLoading } from 'public/utils/ui';
import { showToaster }                                       from 'public/utils/notification';
import { startStoryboardPolling, stopStoryboardPolling }     from 'public/utils/storyboard-poller';

const VERSION           = '[ PROJECT DETAIL : v.2.4.0 ]';
const PATH_UNAUTHORIZED = '/cc';

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

const MSG_GENERATION_FAILED   = 'Unable to start generation. Please try again.';
const MSG_DISPATCH_FAILED     = 'The generation pipeline is currently unavailable. Please try again in a moment.';
const MSG_CONFIG_ERROR        = 'Generation is not yet configured. Please contact support.';
const MSG_ALREADY_RUNNING     = 'Generation is already in progress — resuming display.';
const MSG_POLL_TIMEOUT        = "Generation is taking longer than expected. We'll notify you when it's ready.";
const MSG_POLL_ERROR          = 'Lost connection to the generation service. Please refresh the page.';
const MSG_PROJECT_UPDATED     = 'Project updated successfully.';
const MSG_GENERATING          = 'Generating...';
const MSG_GENERATE_DEFAULT    = 'Generate Storyboard';

const BTN_GENERATE = '#btnGenerateStoryboard';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _currentProject = null;
let _activePoller   = null;

// ─── BOOT ─────────────────────────────────────────────────────────────────────

$w.onReady(async function () {
    console.log(`${VERSION} Initializing...`);

    // ── 0. SECURITY GATE — hide content BEFORE any async work ────────────────
    // Must be the first operation. Code-enforced — do not rely on the Wix
    // Editor 'Hidden on Load' canvas setting alone (can be accidentally changed).
    safeHide('#pageContentContainer');

    // ── 1. Read project ID from the dynamic dataset ───────────────────────────
    const datasetItem = $w('#dynamicDataset').getCurrentItem();

    if (!datasetItem?._id) {
        console.warn(`${VERSION} No dataset item found. Redirecting.`);
        wixLocation.to(PATH_UNAUTHORIZED);
        return;
    }

    // ── 2. Server-side access verification ───────────────────────────────────
    console.log(`${VERSION} Verifying access for project: ${datasetItem._id}`);
    const accessResult = await verifyProjectAccess(datasetItem._id);

    if (!accessResult.ok || !accessResult.authorized) {
        const reason = accessResult.error?.type || accessResult.error || 'UNKNOWN';
        console.warn(`${VERSION} Access denied. Reason: ${reason}. Redirecting.`);
        wixLocation.to(PATH_UNAUTHORIZED);
        return;
    }

    // ── 3. Populate authoritative module state ────────────────────────────────
    _currentProject = accessResult.data;
    console.log(`${VERSION} Access granted. Rendering: "${_currentProject.title}"`);

    // ── 4. Render, wire, then reveal ──────────────────────────────────────────
    setupPageUI();
    wireEditButton();
    wireGenerateButton();

    // Resume polling if the user navigated back mid-generation
    if (_currentProject.storyboardStatus === 'generating') {
        console.log(`${VERSION} Generation in progress on load — resuming poll.`);
        startPolling();
    }

    // Reveal only after ownership is confirmed and UI is ready
    safeShow('#pageContentContainer');
});

// ─── PAGE SETUP ───────────────────────────────────────────────────────────────

function setupPageUI() {
    $w('#txtBreadcrumb').text = `Projects / ${_currentProject.title}`;
    $w('#btnBack').onClick(() => wixLocation.to('/projects'));
}

// ─── EDIT BUTTON ──────────────────────────────────────────────────────────────

function wireEditButton() {
    $w('#btnEditProject').onClick(async () => {
        if (!_currentProject) {
            console.warn(`${VERSION} Edit triggered but _currentProject is null.`);
            return;
        }

        try {
            console.log(`${VERSION} Opening edit modal for project: ${_currentProject._id}`);
            const result = await wixWindow.openLightbox('Project', { project: _currentProject });

            if (result?.updated) {
                console.log(`${VERSION} Edit confirmed. Re-syncing project state...`);

                // Re-fetch from backend — never read from dataset after a mutation
                const refreshed = await verifyProjectAccess(_currentProject._id);

                if (refreshed.ok && refreshed.authorized) {
                    _currentProject = refreshed.data;
                    console.log(`${VERSION} _currentProject synced: "${_currentProject.title}"`);
                } else {
                    console.warn(`${VERSION} Re-sync access check failed. Redirecting.`);
                    wixLocation.to(PATH_UNAUTHORIZED);
                    return;
                }

                await $w('#dynamicDataset').refresh();
                showToaster(MSG_PROJECT_UPDATED, 'success');

            } else if (result?.errorMessage) {
                showToaster(result.errorMessage, 'error');
            }

        } catch (err) {
            console.error(`${VERSION} Edit modal error:`, err);
        }
    });
}

// ─── GENERATE STORYBOARD BUTTON ───────────────────────────────────────────────

function wireGenerateButton() {
    $w(BTN_GENERATE).onClick(async () => {

        // ── Validate project fields before dispatch ───────────────────────────
        const validation = validateProjectForGeneration(_currentProject);
        if (!validation.isValid) {
            showToaster(validation.message, 'error');
            return;
        }

        setButtonLoading(BTN_GENERATE, MSG_GENERATING, MSG_GENERATE_DEFAULT);
        safeShow('#ccLoadingPreloader');

        // Stop any existing poller before dispatching a new generation run
        if (_activePoller) {
            stopStoryboardPolling(_activePoller);
            _activePoller = null;
        }

        const result = await generateStoryboard(_currentProject._id);

        if (result.ok) {
            // Dispatch succeeded — start polling for incoming frames
            startPolling();
            return;
        }

        // ── Route error types explicitly ──────────────────────────────────────
        const errorType = result.error?.type || 'UNKNOWN';
        console.warn(`${VERSION} generateStoryboard failed: type=${errorType}`, result.error);

        if (errorType === 'ALREADY_RUNNING') {
            // A generation is already in progress — attach to it rather than
            // showing an error. The user gets a soft confirmation and the
            // poller reveals frames as they arrive.
            console.log(`${VERSION} ALREADY_RUNNING — resuming active generation poll.`);
            showToaster(MSG_ALREADY_RUNNING, 'success');
            startPolling();
            return;
        }

        // All other errors: restore button so the user can retry.
        setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
        safeHide('#ccLoadingPreloader');

        if (errorType === 'DISPATCH_FAILED' || errorType === 'WEBHOOK_ERROR' || errorType === 'WEBHOOK_UNAVAILABLE') {
            // n8n pipeline unreachable after all retries.
            // RESOLUTION: Verify N8N_STORYBOARD_WEBHOOK_URL secret in Wix Secrets
            // Manager and ensure the n8n workflow is active (not in test/draft mode).
            showToaster(MSG_DISPATCH_FAILED, 'error');
            return;
        }

        if (errorType === 'CONFIG_ERROR' || errorType === 'CONFIGURATION_ERROR') {
            // Secret not configured in Wix Secrets Manager.
            showToaster(MSG_CONFIG_ERROR, 'error');
            return;
        }

        // Generic fallback for unexpected error types
        showToaster(MSG_GENERATION_FAILED, 'error');
    });
}

// ─── STORYBOARD POLLING ───────────────────────────────────────────────────────

/**
 * Starts the adaptive storyboard poller for the current project.
 *
 * SIGNATURE: startStoryboardPolling(projectId, { callbacks })
 *   — positional args per storyboard-poller.js v.2.0.0.
 *   — Do NOT use the old single-object form: startStoryboardPolling({ projectId, ... })
 *     That causes the poller to receive the config object as projectId, producing
 *     a terminal poll error on the first tick.
 */
function startPolling() {
    _activePoller = startStoryboardPolling(_currentProject._id, {
        onFrame(frame, frames) {
            renderFrame(frame, frames);
        },
        onComplete(frames) {
            console.log(`${VERSION} Generation complete. Total frames: ${frames.length}`);
            _activePoller = null;
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
        },
        onTimeout() {
            console.warn(`${VERSION} Polling timed out.`);
            _activePoller = null;
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
            showToaster(MSG_POLL_TIMEOUT, 'error');
        },
        onError(error) {
            console.error(`${VERSION} Polling terminal error:`, error);
            _activePoller = null;
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
            showToaster(MSG_POLL_ERROR, 'error');
        },
    });
}

/**
 * Renders a newly delivered storyboard frame into the page UI.
 * Canvas-specific — adapt element IDs to the Wix Editor layout.
 *
 * @param {object} frame  — individual frame record (frameIndex, imageUrl, promptText, frameData)
 * @param {array}  frames — all frames delivered so far, ascending by frameIndex
 */
function renderFrame(frame, frames) {
    console.log(`${VERSION} Frame received: index ${frame.frameIndex} | total so far: ${frames.length}`);
    // TODO: wire to repeater / canvas elements
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

export function debugPageState() {
    console.log(`${VERSION} _currentProject:`, _currentProject);
    console.log(`${VERSION} _activePoller:`,   _activePoller);
}