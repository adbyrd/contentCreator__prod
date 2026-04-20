/**
 * Utility: Notifications & User Feedback
 * Path: /public/utils/notification.js
 * Version: [ NOTIFICATIONS : v.2.2.0 ]
 *
 * v.2.2.0 — postMessage Toaster Bridge
 * ──────────────────────────────────────
 * PROBLEM: Both the direct $w('#globalToaster') approach (v.2.0.0) and the
 * exported function approach (v.2.1.0 / triggerGlobalToaster) produce
 * "#globalToaster not found" because Velo always binds $w() to the calling
 * module's runtime scope, not where the function was defined. Exporting a
 * function from masterPage.js does not transfer its $w scope to callers.
 *
 * SOLUTION: Use wixWindow.postMessage() to send a structured message to the
 * Master Page. masterPage.js listens via wixWindow.onMessage() and calls its
 * own _showToaster() which runs entirely in the Master Page scope, where
 * $w('#globalToaster') resolves correctly.
 *
 * Message contract:
 *   { channel: 'SHOW_TOASTER', message: string, type: 'success' | 'error' }
 *
 * This is the only Velo-supported mechanism for cross-scope Master Page
 * DOM operations from page code or public utilities.
 *
 * All existing showToaster() call sites are unchanged — the public API is
 * backward compatible. No other files require modification.
 *
 * showInlineError() and clearInlineError() are unchanged — they operate on
 * page-local elements where page-scoped $w() is correct.
 *
 * Canvas requirements:
 *   Master Page : #globalToaster, #toasterMsg  (managed by masterPage.js)
 *   Page-local  : per-selector inline error elements (managed by callers)
 *
 * Exports:
 *   showToaster(message, type)
 *   showInlineError(selector, message, timeoutMs?)
 *   clearInlineError(selector)
 *   debugNotifications()
 */

import wixWindow from 'wix-window';

const VERSION            = '[ NOTIFICATIONS : v.2.2.0 ]';
const TOASTER_CHANNEL    = 'SHOW_TOASTER';

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
 * Sends a postMessage to the Master Page, which runs _showToaster() in its
 * own scope where $w('#globalToaster') resolves correctly.
 *
 * Safe to call from page controllers, modals, and utilities on any page.
 *
 * @param {string} message
 * @param {'success'|'error'} [type='success']
 */
export function showToaster(message, type = 'success') {
    try {
        wixWindow.postMessage({ channel: TOASTER_CHANNEL, message, type });
        console.log(`${VERSION} [${type.toUpperCase()}] showToaster dispatched: "${message}"`);
    } catch (err) {
        // postMessage failure must never interrupt the calling flow.
        console.warn(`${VERSION} showToaster: postMessage failed. Message was: "${message}"`, err);
    }
}

// ─── INLINE FIELD ERRORS ──────────────────────────────────────────────────────

/**
 * Expands a collapsible error element on the current page and auto-collapses
 * it after a timeout.
 *
 * These elements are page-local — $w() is correctly page-scoped here.
 * Falls back to showToaster() if the element is not present so the message
 * is never silently dropped.
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