/**
 * Utility: Notifications & User Feedback
 * Path: /public/utils/notification.js
 * Version: [ NOTIFICATIONS : v.2.0.0 ]
 *
 * CR-01 Remediation
 * -----------------
 * This file is the SOLE owner of all user-visible feedback primitives.
 * No page controller or modal may define its own showError, showInlineError,
 * clearInlineError, or showToaster. Import from here instead.
 *
 * Canvas requirements (Master Page):
 *   #globalToaster  — collapsible container (Box or Strip)
 *   #toasterMsg     — Text element inside #globalToaster
 *
 * Exports:
 *   showToaster(message, type)
 *   showInlineError(selector, message, timeoutMs?)
 *   clearInlineError(selector)
 *   debugNotifications()
 */

const VERSION = '[ NOTIFICATIONS : v.2.0.0 ]';

// ─── SHARED CONSTANTS ─────────────────────────────────────────────────────────

export const MSG_GENERIC_ERROR  = "Something went wrong. Please try again or contact support.";
export const MSG_UPDATE_SUCCESS = "Settings updated successfully.";
export const MSG_SAVE_FAILED    = "Unable to save. Please try again.";

// How long the global toaster stays visible before auto-collapsing (ms).
const TOASTER_DURATION_MS      = 4000;
// Default duration for inline field errors (ms).
const INLINE_ERROR_DURATION_MS = 6000;

// ─── GLOBAL TOASTER ───────────────────────────────────────────────────────────

/**
 * Displays the site-wide feedback bar on the Master Page.
 *
 * Uses the canonical element IDs agreed in CR-02:
 *   #globalToaster  — the collapsible container
 *   #toasterMsg     — the text element inside it
 *
 * Safe to call from page controllers, modals, and utilities.
 * Falls back to a console warning if the elements are absent (e.g. during
 * unit testing or if called from a page that does not have the master page).
 *
 * @param {string} message - Human-readable message to display.
 * @param {'success'|'error'} [type='success'] - Visual style variant.
 */
export function showToaster(message, type = 'success') {
    const $toaster = $w('#globalToaster');
    const $text    = $w('#toasterMsg');

    // $w() never returns null in Velo — it returns an inert proxy when the
    // element does not exist on the page. Checking for .expand guards against
    // calling on that proxy, which has no methods.
    if (typeof $toaster?.expand !== 'function') {
        console.warn(`${VERSION} showToaster: #globalToaster not found on this page. Message was: "${message}"`);
        return;
    }

    if (typeof $text?.text === 'undefined') {
        console.warn(`${VERSION} showToaster: #toasterMsg not found on this page.`);
        return;
    }

    $text.text = message;

    if ($toaster.style) {
        $toaster.style.backgroundColor = (type === 'success') ? '#7bef8593' : '#FFEBEE';
    }

    $toaster.expand()
        .then(() => setTimeout(() => $toaster.collapse(), TOASTER_DURATION_MS))
        .catch(err => console.warn(`${VERSION} showToaster expand/collapse error:`, err));

    console.log(`${VERSION} [${type.toUpperCase()}] ${message}`);
}

// ─── INLINE FIELD ERRORS ──────────────────────────────────────────────────────

/**
 * Expands a collapsible error element on the page and auto-collapses it
 * after a timeout.
 *
 * Replaces all local showError() / showInlineError() implementations in
 * modals and page controllers.
 *
 * @param {string} selector    - The $w selector for the error element
 *                               (e.g. '#newProjectError', '#errorMsgCompanyDetails').
 * @param {string} message     - The error message to display.
 * @param {number} [timeoutMs] - Override the default auto-dismiss duration.
 */
export function showInlineError(selector, message, timeoutMs = INLINE_ERROR_DURATION_MS) {
    const $el = $w(selector);

    if (typeof $el?.expand !== 'function') {
        // Element not present on this page/modal — fall back to the global toaster
        // so the message is never silently dropped.
        console.warn(`${VERSION} showInlineError: ${selector} not found. Falling back to toaster.`);
        showToaster(message, 'error');
        return;
    }

    $el.text = message;
    $el.expand();

    setTimeout(() => {
        if (typeof $el.collapse === 'function') $el.collapse();
    }, timeoutMs);

    console.warn(`${VERSION} Inline error on ${selector}: "${message}"`);
}

/**
 * Collapses an inline error element without waiting for the timeout.
 * Call this when validation passes to immediately clear a previous error.
 *
 * @param {string} selector - The $w selector for the error element.
 */
export function clearInlineError(selector) {
    const $el = $w(selector);

    if (typeof $el?.collapse !== 'function') return;

    $el.collapse();
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

/** Smoke-tests the toaster. Call from the browser console or API Explorer. */
export function debugNotifications() {
    console.log(`${VERSION} Debug: firing test toaster...`);
    showToaster('Notification system operational.', 'success');
}