/**
 * [ FILE NAME : settings-project.modal__v.1.5.0 ]
 * Modal: Project Settings
 * Path: /page_code/modals/settings-project.modal.js
 * Version: [ PROJECT SETTINGS : v.1.5.0 ]
 *
 * Refactor notes (v.1.4.0 → v.1.5.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * CR-01 FIX — Import alignment
 *   REMOVED: import of showInlineError / clearInlineError from notification.js
 *            → notification.js does not export these functions (only showToaster,
 *              showError, debugNotifications). Reverted to local helpers.
 *   REMOVED: import of setButtonLoading from ui.js
 *            → ui.js only exports showModalError. setButtonLoading does not exist
 *              in the repo. Reverted to local updateLoadingState().
 *
 * ISSUE#4 FIX — Cancel button element name
 *   Corrected element selector from #btnClose → #btnCancel per the Issue#4
 *   ticket spec and canvas element naming convention.
 *   #btnCancel is also disabled during save and re-enabled on completion or
 *   failure, preventing a close race during async operations.
 *
 * CATCH BLOCK FIX
 *   v.1.4.0 was calling wixWindow.lightbox.close({ updated: false }) inside the
 *   catch block. This incorrectly dismissed the modal on error, preventing the
 *   user from seeing the inline error message or retrying. Removed. The modal
 *   now stays open on failure; only inline error + loading state reset occur.
 *
 * Behaviour otherwise identical to v.1.3.1:
 *   CREATE mode — two-step wizard (Details → Next → Scope → Save)
 *   EDIT mode   — opens at step 1 with all fields pre-filled; user advances normally
 */

import wixWindow             from 'wix-window';
import { createProject, updateProject } from 'backend/services/project.web';

const VERSION = '[ PROJECT SETTINGS : v.1.5.0 ]';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ALPHANUMERIC_REGEX = /^[a-z0-9 ]*$/i;

const MAX_TITLE_LENGTH = 70;
const MAX_DESC_LENGTH  = 250;

const MSG_INVALID_TITLE       = 'Project name cannot contain special characters.';
const MSG_INVALID_DESCRIPTION = 'Project description cannot contain special characters.';
const MSG_INVALID_BOTH        = 'Project name and description cannot contain special characters.';
const MSG_TITLE_TOO_LONG      = `Project name cannot exceed ${MAX_TITLE_LENGTH} characters.`;
const MSG_DESC_TOO_LONG       = `Project description cannot exceed ${MAX_DESC_LENGTH} characters.`;
const MSG_SAVE_FAILED         = 'Unable to save your project. Please try again.';
const MSG_SAVING              = 'Saving...';
const MSG_SAVE_CREATE         = 'Save';
const MSG_SAVE_EDIT           = 'Save Changes';

// Canvas element selectors — defined as constants so a rename only touches one place
const SEL_INLINE_ERROR = '#newProjectError';
const SEL_BTN_SAVE     = '#btnSave';
const SEL_BTN_CANCEL   = '#btnCancel';   // Issue#4: correct element name per canvas spec

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _isSaving   = false;
let _isEditMode = false;
let _projectId  = null;

// ─── BOOT ─────────────────────────────────────────────────────────────────────

$w.onReady(function () {
    console.log(`${VERSION} Modal Initializing...`);

    const context = wixWindow.lightbox.getContext();
    _isEditMode   = !!(context?.project?._id);
    _projectId    = _isEditMode ? context.project._id : null;

    console.log(`${VERSION} Mode: ${_isEditMode ? 'EDIT' : 'CREATE'}${_isEditMode ? ` | ID: ${_projectId}` : ''}`);

    initModal(context?.project || null);
    wireEventHandlers();
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

/**
 * Configures the modal for CREATE or EDIT mode.
 *
 * CREATE — two-step wizard starting at projectDetails (step 1).
 * EDIT   — all fields pre-filled via hydrateForm(); opens at step 1 so the
 *          user can review Details before advancing to Scope.
 */
function initModal(project = null) {
    $w('#projectName').maxLength        = MAX_TITLE_LENGTH;
    $w('#projectDescription').maxLength = MAX_DESC_LENGTH;

    clearInlineError();

    if (_isEditMode && project) {
        $w('#projectHeading').text = 'Update Project';
        hydrateForm(project);
        $w('#setUpNewProject').changeState('projectDetails');
        $w('#btnNext').show();
        $w(SEL_BTN_SAVE).hide();
        $w(SEL_BTN_SAVE).label = MSG_SAVE_EDIT;
        console.log(`${VERSION} Edit mode: form hydrated for "${project.title}".`);
    } else {
        $w('#setUpNewProject').changeState('projectDetails');
        $w('#btnNext').show();
        $w(SEL_BTN_SAVE).hide();
        $w(SEL_BTN_SAVE).label = MSG_SAVE_CREATE;
        console.log(`${VERSION} Create mode: step 1 (Project Details).`);
    }
}

// ─── HYDRATION ────────────────────────────────────────────────────────────────

/**
 * Populates all form fields with existing project data.
 * Called exclusively in EDIT mode.
 *
 * @param {object} project - Project item from the dynamic dataset / lightbox context.
 */
function hydrateForm(project) {
    $w('#projectName').value          = project.title           || '';
    $w('#projectDescription').value   = project.description     || '';
    $w('#projectGoal').value          = project.goal            || '';
    $w('#projectOffer').value         = project.offer           || '';
    $w('#projectAudience').value      = project.target_audience || '';
    $w('#projectMisconception').value = project.misconception   || '';
    console.log(`${VERSION} Form hydration complete.`);
}

// ─── EVENT WIRING ─────────────────────────────────────────────────────────────

/**
 * Registers all interactive element handlers.
 *
 * Issue#4 — Cancel: wixWindow.lightbox.close() is called with no payload,
 * signalling to the caller that the user dismissed without saving.
 */
function wireEventHandlers() {
    // Real-time inline validation — fires on every keystroke in Step 1
    $w('#projectName').onInput(()        => validateFieldsInline());
    $w('#projectDescription').onInput(() => validateFieldsInline());

    // Step navigation
    $w('#btnNext').onClick(() => {
        if (validateSummaryState()) transitionToScope();
    });

    // Save / submit
    $w(SEL_BTN_SAVE).onClick(() => handleSave());

    // Issue#4 — Cancel button: close the lightbox without saving
    $w(SEL_BTN_CANCEL).onClick(() => {
        console.log(`${VERSION} User cancelled. Closing modal without saving.`);
        wixWindow.lightbox.close();
    });
}

// ─── REAL-TIME INLINE VALIDATION ─────────────────────────────────────────────

/**
 * Fires on every keystroke in Step 1.
 * Length limits are checked before special-character constraints.
 * Clears the error element the moment both fields pass all rules.
 */
function validateFieldsInline() {
    const title = $w('#projectName').value;
    const desc  = $w('#projectDescription').value;

    if (title.length > MAX_TITLE_LENGTH) { showInlineError(MSG_TITLE_TOO_LONG); return; }
    if (desc.length  > MAX_DESC_LENGTH)  { showInlineError(MSG_DESC_TOO_LONG);  return; }

    const titleInvalid = title.length > 0 && !ALPHANUMERIC_REGEX.test(title);
    const descInvalid  = desc.length  > 0 && !ALPHANUMERIC_REGEX.test(desc);

    if      (titleInvalid && descInvalid) showInlineError(MSG_INVALID_BOTH);
    else if (titleInvalid)                showInlineError(MSG_INVALID_TITLE);
    else if (descInvalid)                 showInlineError(MSG_INVALID_DESCRIPTION);
    else                                  clearInlineError();
}

// ─── INLINE ERROR HELPERS ─────────────────────────────────────────────────────

/**
 * Surfaces a validation message in the Step 1 inline error element.
 * Local implementation — notification.js does not export this function.
 *
 * @param {string} message
 */
function showInlineError(message) {
    const $error = $w(SEL_INLINE_ERROR);
    if (!$error) return;
    $error.text = message;
    if (typeof $error.expand === 'function') $error.expand();
    console.warn(`${VERSION} Validation error: ${message}`);
}

/**
 * Hides the Step 1 inline error element.
 * Local implementation — notification.js does not export this function.
 */
function clearInlineError() {
    const $error = $w(SEL_INLINE_ERROR);
    if (!$error) return;
    if (typeof $error.collapse === 'function') $error.collapse();
}

// ─── STATE TRANSITION ─────────────────────────────────────────────────────────

function transitionToScope() {
    console.log(`${VERSION} Advancing to Project Scope...`);
    $w('#setUpNewProject').changeState('projectScope');
    $w('#btnNext').hide();
    $w(SEL_BTN_SAVE).show();
}

// ─── STEP 1 VALIDATION ────────────────────────────────────────────────────────

/**
 * Gate validation called when the user clicks Next.
 * Mirrors real-time inline validation but returns a boolean for flow control.
 */
function validateSummaryState() {
    const title = $w('#projectName').value;
    const desc  = $w('#projectDescription').value;

    if (!title || !desc)                  { showInlineError('Project name and description are required.'); return false; }
    if (title.length > MAX_TITLE_LENGTH)  { showInlineError(MSG_TITLE_TOO_LONG); return false; }
    if (desc.length  > MAX_DESC_LENGTH)   { showInlineError(MSG_DESC_TOO_LONG);  return false; }
    if (!ALPHANUMERIC_REGEX.test(title))  { showInlineError(MSG_INVALID_TITLE);  return false; }
    if (!ALPHANUMERIC_REGEX.test(desc))   { showInlineError(MSG_INVALID_DESCRIPTION); return false; }

    clearInlineError();
    return true;
}

// ─── STEP 2 VALIDATION ────────────────────────────────────────────────────────

function validateScopeState() {
    const fields = [
        $w('#projectGoal').value,
        $w('#projectOffer').value,
        $w('#projectAudience').value,
        $w('#projectMisconception').value
    ];

    const isValid = fields.every(v => v && v.trim() !== '');
    if (!isValid) console.warn(`${VERSION} Scope validation failed: all fields are required.`);
    return isValid;
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates project creation (CREATE mode) or update (EDIT mode).
 *
 * On success — closes the lightbox with { updated: true }.
 * On failure — shows the inline error and resets the loading state so the
 *              user can correct the issue and retry. The modal stays open.
 */
async function handleSave() {
    if (_isSaving) return;

    // In edit mode the user sees both steps; validate Step 1 as a safety net.
    if (_isEditMode && !validateSummaryState()) return;
    if (!validateScopeState()) return;

    _isSaving = true;
    updateLoadingState(true);

    const projectData = {
        title:           $w('#projectName').value,
        description:     $w('#projectDescription').value,
        goal:            $w('#projectGoal').value,
        offer:           $w('#projectOffer').value,
        target_audience: $w('#projectAudience').value,
        misconception:   $w('#projectMisconception').value
    };

    try {
        let response;

        if (_isEditMode) {
            console.log(`${VERSION} Dispatching updateProject for ID: ${_projectId}`);
            response = await updateProject(_projectId, projectData);
        } else {
            console.log(`${VERSION} Dispatching createProject.`);
            response = await createProject(projectData);
        }

        if (response.ok) {
            const action = _isEditMode ? 'updated' : 'created';
            console.log(`${VERSION} Project ${action} successfully.`);
            wixWindow.lightbox.close({ updated: true, mode: _isEditMode ? 'edit' : 'create' });
        } else {
            throw new Error(response.error?.message || MSG_SAVE_FAILED);
        }

    } catch (err) {
        console.error(`${VERSION} Save failed:`, err);
        // Keep the modal open so the user can see the error and retry.
        // Do NOT call wixWindow.lightbox.close() here.
        showInlineError(err.message || MSG_SAVE_FAILED);
        updateLoadingState(false);
    }
}

// ─── LOADING STATE ────────────────────────────────────────────────────────────

/**
 * Manages the save button and cancel button enabled/disabled states during
 * async operations.
 *
 * Local implementation — ui.js does not export setButtonLoading.
 *
 * @param {boolean} isLoading
 */
function updateLoadingState(isLoading) {
    if (isLoading) {
        $w(SEL_BTN_SAVE).label = MSG_SAVING;
        $w(SEL_BTN_SAVE).disable();
        $w(SEL_BTN_CANCEL).disable();
    } else {
        $w(SEL_BTN_SAVE).label = _isEditMode ? MSG_SAVE_EDIT : MSG_SAVE_CREATE;
        $w(SEL_BTN_SAVE).enable();
        $w(SEL_BTN_CANCEL).enable();
        _isSaving = false;
    }
}

// ─── DEBUG EXPORT ─────────────────────────────────────────────────────────────

export function debugModalState() {
    return {
        version:    '1.5.0',
        isEditMode: _isEditMode,
        projectId:  _projectId,
        isSaving:   _isSaving,
        timestamp:  new Date().toISOString()
    };
}