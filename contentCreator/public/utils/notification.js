/**
 * Utility: Notifications & User Feedback
 * Path: /public/utils/notification.js
 * Version: [ NOTIFICATIONS : v.2.1.0 ]
 *
 * v.2.1.0 — Master Page Toaster Fix
 * ────────────────────────────────────
 * ISSUE: showToaster() used $w('#globalToaster') directly. In Velo, $w()
 * is page-scoped. When this utility is called from a page controller or
 * another public utility, $w() resolves against that page's element tree —
 * NOT the Master Page canvas. #globalToaster and #toasterMsg live on the
 * Master Page and are therefore unreachable, producing the warning:
 *   "showToaster: #globalToaster not found on this page."
 *
 * FIX: All $w() access for the global toaster is now delegated to
 * `triggerGlobalToaster()` exported from masterPage.js. Because that
 * function executes within the Master Page module scope, its $w() calls
 * resolve correctly against the Master Page canvas at runtime.
 *
 * showInlineError() and clearInlineError() are unaffected — they operate
 * on page-local elements and their $w() calls are intentionally page-scoped.
 *
 * Existing export signatures are fully backward compatible.
 *
 * Canvas requirements:
 *   Master Page: #globalToaster, #toasterMsg  (managed by masterPage.js)
 *   Page-local:  per-selector inline error elements (managed by callers)
 *
 * Exports:
 *   showToaster(message, type)
 *   showInlineError(selector, message, timeoutMs?)
 *   clearInlineError(selector)
 *   debugNotifications()
 */

import { triggerGlobalToaster } from 'public/pages/masterPage';

const VERSION = '[ NOTIFICATIONS : v.2.1.0 ]';

// ─── SHARED CONSTANTS ─────────────────────────────────────────────────────────

export const MSG_GENERIC_ERROR  = 'Something went wrong. Please try again or contact support.';
export const MSG_UPDATE_SUCCESS = 'Settings updated successfully.';
export const MSG_SAVE_FAILED    = 'Unable to save. Please try again.';

// Default duration for inline field errors (ms).
const INLINE_ERROR_DURATION_MS = 6000;

// ─── GLOBAL TOASTER ───────────────────────────────────────────────────────────

/**
 * Displays the site-wide feedback bar on the Master Page.
 *
 * Delegates to triggerGlobalToaster() in masterPage.js so that the
 * $w('#globalToaster') call executes in the Master Page scope, where
 * the element actually exists.
 *
 * Safe to call from page controllers, modals, and utilities.
 *
 * @param {string} message
 * @param {'success'|'error'} [type='success']
 */
export function showToaster(message, type = 'success') {
    try {
        triggerGlobalToaster(message, type);
    } catch (err) {
        // Defensive fallback — log and do not throw so callers are never
        // interrupted by a notification failure.
        console.warn(`${VERSION} showToaster: triggerGlobalToaster failed. Message was: "${message}"`, err);
    }
}

// ─── INLINE FIELD ERRORS ──────────────────────────────────────────────────────

/**
 * Expands a collapsible error element on the current page and auto-collapses
 * it after a timeout.
 *
 * These elements are page-local — $w() is correctly page-scoped here.
 * Falls back to the global toaster if the element is not found, so the
 * message is never silently dropped.
 *
 * @param {string} selector    - e.g. '#newProjectError'
 * @param {string} message
 * @param {number} [timeoutMs]
 */
export function showInlineError(selector, message, timeoutMs = INLINE_ERROR_DURATION_MS) {
    const $el = $w(selector);

    if (typeof $el?.expand !== 'function') {
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
 * Collapses an inline error element immediately.
 * Call when validation passes to clear a previous error without waiting.
 *
 * @param {string} selector
 */
export function clearInlineError(selector) {
    const $el = $w(selector);
    if (typeof $el?.collapse === 'function') $el.collapse();
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

/** Smoke-tests the toaster. Call from the browser console or API Explorer. */
export function debugNotifications() {
    console.log(`${VERSION} Debug: firing test toaster...`);
    showToaster('Notification system operational.', 'success');
}