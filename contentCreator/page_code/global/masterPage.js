/**
 * Page Code: Master Page (Global)
 * Path: /page_code/global/masterPage.js
 * Version: [ MASTER PAGE : v.1.3.0 ]
 */

import wixLocation from 'wix-location';
import { authentication } from 'wix-members';

const VERSION = '[ MASTER PAGE : v.1.3.0 ]';
const MSG_ERROR_GENERIC = 'Technical error encountered. Please try again later.';
const PATH_HOME = 'https://www.adbyrd.com/cc';

$w.onReady(function () {
    console.log(`${VERSION} Global Master Page Initialized.`);
    bootUI();

    $w("#btnLogOut").onClick(async () => {
        await handleLogOut();
    });
});

function bootUI() {}

async function handleLogOut() {
    safeDisable("#btnLogOut", true);
    console.log(`${VERSION} Logout initiated.`);

    try {
        await authentication.logout();
        console.log(`${VERSION} Logout successful. Redirecting to home.`);
        wixLocation.to(PATH_HOME);
    } catch (err) {
        console.error(`${VERSION} Logout failed:`, err);
        safeDisable("#btnLogOut", false);
        showUserError(MSG_ERROR_GENERIC);
    }
}

function safeDisable(selector, disabled = true) {
    const el = $w(selector);
    if (el && typeof el.disable === 'function') {
        disabled ? el.disable() : el.enable();
    } else {
        console.warn(`${VERSION} safeDisable: Element ${selector} not found.`);
    }
}

function safeExpand(selector) {
    const el = $w(selector);
    if (el && typeof el.expand === 'function') el.expand();
}

function safeCollapse(selector) {
    const el = $w(selector);
    if (el && typeof el.collapse === 'function') el.collapse();
}

function showUserError(message) {
    console.warn(`${VERSION} User Error Displayed: ${message}`);
}