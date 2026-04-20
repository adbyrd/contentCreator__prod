/**
 * Page: Project Detail (Dynamic)
 * Path: /page_code/dashboard/project-detail.page.js
 * Version: [ PROJECT DETAIL : v.2.3.0 ]
 *
 * v.2.3.0 — Poller Call Signature Fix
 * ──────────────────────────────────────
 * ISSUE: startStoryboardPolling() was being called with a single object
 * argument: startStoryboardPolling({ projectId, onFrame, ... }).
 * storyboard-poller.js v.2.0.0 expects a positional signature:
 *   startStoryboardPolling(projectId, { onFrame, onComplete, onTimeout, onError })
 * With the old call form, the poller received the entire config object as
 * `projectId` — a truthy non-string value — and passed it to
 * getStoryboardFrames(), which returned a terminal error on the first tick,
 * immediately firing onError() and surfacing "Unable to start generation."
 *
 * FIX: startPolling() now uses the correct positional signature.
 *
 * v.2.2.0 changes (preserved):
 *   - Import paths corrected to backend/services/project.web
 *   - stopStoryboardPolling imported and used before re-dispatch
 *   - onFrame(frame, frames) signature aligned to poller contract
 *   - accessResult.error read as flat string (no .type accessor)
 *
 * v.2.1.0 changes (preserved):
 *   - CR-01: showToaster() from notification.js, setButtonLoading() from ui.js
 *   - CR-04: safeHide('#pageContentContainer') as first statement in onReady
 */

import wixLocation  from 'wix-location';
import wixWindow    from 'wix-window';
import { verifyProjectAccess, generateStoryboard }           from 'backend/services/project.web';
import { validateProjectForGeneration }                      from 'public/utils/validation';
import { safeDisable, safeShow, safeHide, setButtonLoading } from 'public/utils/ui';
import { showToaster }                                       from 'public/utils/notification';
import { startStoryboardPolling, stopStoryboardPolling }     from 'public/utils/storyboard-poller';

const VERSION           = '[ PROJECT DETAIL : v.2.3.0 ]';
const PATH_UNAUTHORIZED = '/cc';

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

const MSG_GENERATION_FAILED = 'Unable to start generation. Please try again.';
const MSG_POLL_TIMEOUT      = "Generation is taking longer than expected. We'll notify you when it's ready.";
const MSG_POLL_ERROR        = 'Lost connection to the generation service. Please refresh the page.';
const MSG_PROJECT_UPDATED   = 'Project updated successfully.';
const MSG_GENERATING        = 'Generating...';
const MSG_GENERATE_DEFAULT  = 'Generate Storyboard';

const BTN_GENERATE = '#btnGenerateStoryboard';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _currentProject = null;
let _activePoller   = null;

// ─── BOOT ─────────────────────────────────────────────────────────────────────

$w.onReady(async function () {
    console.log(`${VERSION} Initializing...`);

    // ── 0. SECURITY GATE — hide content BEFORE any async work ────────────────
    // Must be the first operation. Code-enforced guarantee — do not rely on
    // the Wix Editor 'Hidden on Load' canvas setting alone.
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
            startPolling();
        } else {
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
            showToaster(MSG_GENERATION_FAILED, 'error');
            console.warn(`${VERSION} generateStoryboard failed:`, result.error);
        }
    });
}

// ─── STORYBOARD POLLING ───────────────────────────────────────────────────────

/**
 * Starts the adaptive storyboard poller.
 *
 * IMPORTANT — call signature:
 *   startStoryboardPolling(projectId, { onFrame, onComplete, onTimeout, onError })
 *
 * The poller (v.2.0.0) uses positional args: projectId first, callbacks object
 * second. Passing a single config object (old v.1.0.0 form) causes the poller
 * to treat the entire object as projectId, resulting in a terminal poll error
 * on the first tick and an immediate onError() invocation.
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
 * @param {object} frame  — individual frame record
 * @param {array}  frames — all frames delivered so far (ascending frameIndex)
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