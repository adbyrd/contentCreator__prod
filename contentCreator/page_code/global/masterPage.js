/**
 * Page Code: Master Page (Global)
 * Path: /page_code/global/masterPage.js
 * Version: [ MASTER PAGE : v.1.5.0 ]
 *
 * v.1.5.0 — Cross-Scope Toaster via postMessage
 * ───────────────────────────────────────────────
 * PROBLEM: Velo's $w() is always bound to the scope of the module that
 * calls it at runtime, not the module where the function is defined.
 * Exporting a function from masterPage.js and calling it from a public
 * utility or page controller does NOT transfer the Master Page's $w scope
 * to that call — $w still resolves against the calling page's DOM, where
 * #globalToaster does not exist.
 *
 * SOLUTION: The Master Page owns its own elements exclusively and listens
 * for toaster requests via wixWindow.onMessage(). Page code and utilities
 * send requests via wixWindow.postMessage(). This is the only Velo-supported
 * pattern for cross-scope DOM operations targeting Master Page elements.
 *
 * Message contract (channel: 'SHOW_TOASTER'):
 *   Sender  → wixWindow.postMessage({ channel: 'SHOW_TOASTER', message, type })
 *   Receiver → masterPage.js onMessage handler calls _showToaster(message, type)
 *
 * notification.js is updated to use postMessage instead of $w() directly
 * or via an exported function. No other files need changes.
 *
 * v.1.4.0 changes preserved:
 *   - triggerGlobalToaster export REMOVED (did not work — see above)
 *   - Logout uses _showToaster() directly (same scope, works correctly)
 *
 * Canvas requirements (Master Page):
 *   #globalToaster  — collapsible container (Box or Strip)
 *   #toasterMsg     — Text element inside #globalToaster
 *   #btnLogOut      — Logout button
 */

import wixLocation        from 'wix-location';
import wixWindow          from 'wix-window';
import { authentication } from 'wix-members';

const VERSION             = '[ MASTER PAGE : v.1.5.0 ]';
const MSG_ERROR_GENERIC   = 'Technical error encountered. Please try again later.';
const PATH_HOME           = 'https://www.adbyrd.com/cc';
const TOASTER_DURATION_MS = 4000;
const TOASTER_CHANNEL     = 'SHOW_TOASTER';

// ─── BOOT ─────────────────────────────────────────────────────────────────────

$w.onReady(function () {
    console.log(`${VERSION} Global Master Page Initialized.`);

    // ── Listen for cross-scope toaster requests from page code / utilities ───
    // This is the only Velo-supported way for page-scoped code to trigger
    // an element that lives on the Master Page canvas.
    wixWindow.onMessage((event) => {
        const { channel, message, type } = event.data || {};
        if (channel === TOASTER_CHANNEL && message) {
            console.log(`${VERSION} onMessage received — channel: ${TOASTER_CHANNEL}`);
            _showToaster(message, type || 'success');
        }
    });

    // ── Wire logout button ───────────────────────────────────────────────────
    $w('#btnLogOut').onClick(async () => {
        await _handleLogOut();
    });
});

// ─── TOASTER (Master Page scope — $w resolves correctly here) ─────────────────

/**
 * Shows the global toaster. MUST be called only from within masterPage.js
 * so that $w() resolves against the Master Page canvas.
 * External callers must use wixWindow.postMessage({ channel: 'SHOW_TOASTER', ... }).
 *
 * @param {string} message
 * @param {'success'|'error'} [type='success']
 */
function _showToaster(message, type = 'success') {
    const $toaster = $w('#globalToaster');
    const $text    = $w('#toasterMsg');

    if (typeof $toaster?.expand !== 'function') {
        console.warn(`${VERSION} _showToaster: #globalToaster not found on Master Page canvas.`);
        return;
    }

    if (typeof $text?.text === 'undefined') {
        console.warn(`${VERSION} _showToaster: #toasterMsg not found on Master Page canvas.`);
        return;
    }

    $text.text = message;

    if ($toaster.style) {
        $toaster.style.backgroundColor = (type === 'success') ? '#7bef8593' : '#FFEBEE';
    }

    $toaster.expand()
        .then(() => setTimeout(() => $toaster.collapse(), TOASTER_DURATION_MS))
        .catch(err => console.warn(`${VERSION} _showToaster expand/collapse error:`, err));

    console.log(`${VERSION} [${type.toUpperCase()}] ${message}`);
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

async function _handleLogOut() {
    _safeDisable('#btnLogOut', true);
    console.log(`${VERSION} Logout initiated.`);

    try {
        await authentication.logout();
        console.log(`${VERSION} Logout successful. Redirecting to home.`);
        wixLocation.to(PATH_HOME);
    } catch (err) {
        console.error(`${VERSION} Logout failed:`, err);
        _safeDisable('#btnLogOut', false);
        _showToaster(MSG_ERROR_GENERIC, 'error');
    }
}

// ─── SAFE UI HELPERS ──────────────────────────────────────────────────────────

function _safeDisable(selector, disabled = true) {
    const el = $w(selector);
    if (el && typeof el.disable === 'function') {
        disabled ? el.disable() : el.enable();
    } else {
        console.warn(`${VERSION} _safeDisable: Element ${selector} not found.`);
    }
}