'use strict';

/**
 * api/brand.config.js
 *
 * What:  Single source of truth for BRAND IDENTITY across the stack —
 *        name, tagline, logo, favicon, support contacts, legal URLs,
 *        currency / locale. Edit this ONE file to rebrand the whole
 *        platform; restart the api; web + future Flutter app pick up
 *        the change on the next /api/v1/brand request.
 * Why:   User instruction: "sirf brand me name aur logo image rakhna hai,
 *        color aur vo sab UI me CSS me rakhna hai" — brand controls
 *        IDENTITY (name, logo, support info). All COLOURS / DESIGN
 *        TOKENS live in web CSS (web/public/css/base.css :root block).
 *        That keeps the two concerns cleanly separate:
 *          • Rebrand (new client, new identity) → edit this file
 *          • Restyle (palette tweak, design refresh) → edit base.css
 * Used:  Required by api/config/brand.js (which exposes the same object
 *        to controllers). NOT read from process.env — there are no
 *        BRAND_* environment variables.
 *
 * Change log:
 *   2026-05-25 — initial; split out of api/config/brand.js. Colour fields
 *                removed entirely (now lives in CSS).
 */

module.exports = {

    // ── Identity ────────────────────────────────────────────────
    name:    'EatNDeal',
    tagline: 'Delicious food delivered',

    // ── Logo + favicon ──────────────────────────────────────────
    // Served from api/public/brand/* under the /brand/* static route.
    // To change the logo: drop the new file at api/public/brand/logo.png
    // (and api/public/brand/favicon.png). No code change needed.
    logoUrl:    '/brand/logo.png',
    faviconUrl: '/brand/favicon.png',

    // ── Support / legal ─────────────────────────────────────────
    supportEmail: 'bookings@eatsndeals.co.uk',
    supportPhone: '',
    websiteUrl:   'https://eatsndeals.co.uk',
    // App-store download links for the home "Get the app" card + QR. Empty
    // until the apps are published (buttons then link nowhere — href="#").
    appStoreUrl:  '',
    playStoreUrl: '',
    privacyUrl:   '',
    termsUrl:     '',
    copyright:    '© EatNDeal. All rights reserved.',

    // ── Locale / currency (UK platform per the live wtw_eatndeal DB) ──
    currency:       'GBP',
    currencySymbol: '£',
    locale:         'en-GB',
    timezone:       'Europe/London',
};
