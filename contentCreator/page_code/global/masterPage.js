/**
 * Page Code: Master Page (Global)
 * Path: /page_code/global/masterPage.js
 * Version: [ MASTER PAGE : v.1.4.0 ]
 *
 * v.1.4.0 — Global Toaster Bridge
 * ─────────────────────────────────
 * ISSUE: showToaster() in notification.js calls $w('#globalToaster') from
 * a /public/utils/ module. In Velo, $w() is page-scoped — public utilities
 * run in the calling page's context, not the Master Page's context. Elements
 * that belong to the Master Page canvas (#globalToaster, #toasterMsg) are
 * therefore unreachable via $w() from any utility or page controller.
 *
 * FIX: The Master Page owns and controls its own elements exclusively.
 * It exposes a module-level function `triggerGlobalToaster(message, type)`
 * that notification.js imports and calls. Because this export lives in
 * masterPage.js, $w() inside it resolves correctly against the Master Page
 * canvas at runtime.
 *
 * notification.js updated to import and delegate to this function.
 *
 * Canvas requirements (unchanged):
 *   #globalToaster  — collapsible container (Box or Strip) on the Master Page
 *   #toasterMsg     — Text element inside #globalToaster
 *   #btnLogOut      — Logout button
 */

import wixLocation        from 'wix-location';
import { authentication } from 'wix-members';

const VERSION              = '[ MASTER PAGE : v.1.4.0 ]';
const MSG_ERROR_GENERIC    = 'Technical error encountered. Please try again later.';
const PATH_HOME            = 'https://www.adbyrd.com/cc';
const TOASTER_DURATION_MS  = 4000;

// ─── BOOT ─────────────────────────────────────────────────────────────────────

$w.onReady(function () {
    console.log(`${VERSION} Global Master Page Initialized.`);

    $w('#btnLogOut').onClick(async () => {
        await handleLogOut();
    });
});

// ─── GLOBAL TOASTER (exported — called by notification.js) ────────────────────

/**
 * Displays the site-wide feedback bar.
 *
 * This function MUST live in masterPage.js so that $w() resolves against
 * the Master Page element tree. It is exported so notification.js can
 * delegate to it from any page context.
 *
 * @param {string} message
 * @param {'success'|'error'} [type='success']
 */
export function triggerGlobalToaster(message, type = 'success') {
    const $toaster = $w('#globalToaster');
    const $text    = $w('#toasterMsg');

    if (typeof $toaster?.expand !== 'function') {
        console.warn(`${VERSION} triggerGlobalToaster: #globalToaster not found on Master Page canvas.`);
        return;
    }

    if (typeof $text?.text === 'undefined') {
        console.warn(`${VERSION} triggerGlobalToaster: #toasterMsg not found on Master Page canvas.`);
        return;
    }

    $text.text = message;

    if ($toaster.style) {
        $toaster.style.backgroundColor = (type === 'success') ? '#7bef8593' : '#FFEBEE';
    }

    $toaster.expand()
        .then(() => setTimeout(() => $toaster.collapse(), TOASTER_DURATION_MS))
        .catch(err => console.warn(`${VERSION} triggerGlobalToaster expand/collapse error:`, err));

    console.log(`${VERSION} [${type.toUpperCase()}] ${message}`);
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

async function handleLogOut() {
    safeDisable('#btnLogOut', true);
    console.log(`${VERSION} Logout initiated.`);

    try {
        await authentication.logout();
        console.log(`${VERSION} Logout successful. Redirecting to home.`);
        wixLocation.to(PATH_HOME);
    } catch (err) {
        console.error(`${VERSION} Logout failed:`, err);
        safeDisable('#btnLogOut', false);
        triggerGlobalToaster(MSG_ERROR_GENERIC, 'error');
    }
}

// ─── SAFE UI HELPERS ──────────────────────────────────────────────────────────

function safeDisable(selector, disabled = true) {
    const el = $w(selector);
    if (el && typeof el.disable === 'function') {
        disabled ? el.disable() : el.enable();
    } else {
        console.warn(`${VERSION} safeDisable: Element ${selector} not found.`);
    }
}