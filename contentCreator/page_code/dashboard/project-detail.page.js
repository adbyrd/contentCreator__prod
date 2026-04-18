/**
 * Page: Project Detail (Dynamic)
 * Path: /page_code/dashboard/project-detail.page.js
 * Version: [ PROJECT DETAIL : v.2.1.0 ]
 *
 * CR-01 Remediation
 * -----------------
 * REMOVED: local showError() wrapper — calls showToaster() from notification.js directly
 * REMOVED: local toggleLoadingState() — replaced by setButtonLoading() + safeShow/safeHide from ui.js
 *
 * CR-04 Remediation (privacy flash)
 * ----------------------------------
 * safeHide('#pageContentContainer') is the FIRST statement inside $w.onReady —
 * before any await — so the content is guaranteed hidden on every navigation,
 * regardless of the Wix Editor 'Hidden on Load' setting.
 *
 * Storyboard polling (from v.2.0.0) is preserved unchanged.
 */

import wixLocation  from 'wix-location';
import wixWindow    from 'wix-window';
import { verifyProjectAccess, generateStoryboard }    from 'backend/services/project.web';
import { validateProjectForGeneration }               from 'public/utils/validation';
import { safeDisable, safeShow, safeHide, setButtonLoading } from 'public/utils/ui';
import { showToaster }                                from 'public/utils/notification';
import { startStoryboardPolling, stopStoryboardPolling } from 'public/utils/storyboard-poller';

const VERSION           = '[ PROJECT DETAIL : v.2.1.0 ]';
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
    // This must be the first operation. Do NOT rely solely on the Wix Editor
    // 'Hidden on Load' setting — that is a canvas config that can be
    // accidentally changed. This line is the code-enforced guarantee.
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
        const reason = accessResult.error?.type || 'UNKNOWN';
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

    // Resume polling if user navigated back mid-generation
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
                // Modal closed with an error — surface it via the global toaster
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

        // Stop any existing poller before dispatching a new generation
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
        }
    });
}

// ─── STORYBOARD POLLING ───────────────────────────────────────────────────────

function startPolling() {
    _activePoller = startStoryboardPolling({
        projectId: _currentProject._id,
        onFrame:   (frame) => renderFrame(frame),
        onComplete: () => {
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
        },
        onTimeout: () => {
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
            showToaster(MSG_POLL_TIMEOUT, 'error');
        },
        onError: () => {
            setButtonLoading(BTN_GENERATE, null, MSG_GENERATE_DEFAULT);
            safeHide('#ccLoadingPreloader');
            showToaster(MSG_POLL_ERROR, 'error');
        }
    });
}

function renderFrame(frame) {
    // Frame rendering logic is canvas-specific — implement as needed.
    console.log(`${VERSION} Frame received:`, frame);
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

export function debugPageState() {
    console.log(`${VERSION} _currentProject:`, _currentProject);
    console.log(`${VERSION} _activePoller:`,   _activePoller);
}