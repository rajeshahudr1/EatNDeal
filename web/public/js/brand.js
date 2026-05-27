/*
 * brand.js
 *
 * What:  Intentionally empty placeholder.
 * Why:   Colours and design tokens are owned by CSS now —
 *        web/public/css/base.css (:root block). The brand identity
 *        (name, logo, support info) is rendered into the HTML directly
 *        by the EJS layout from res.locals.brand. There is no longer
 *        anything for JS to set at runtime.
 *
 *        This file is kept so the existing <script defer src="/js/brand.js">
 *        tag in views/_layout.ejs continues to 200 (no 404), and so
 *        future brand-related runtime behaviour (e.g. applying a saved
 *        theme preference from localStorage) has an obvious home.
 *
 *        To re-skin the platform:
 *          • Change name / logo / support info  → api/brand.config.js
 *          • Change colours / spacing / radius  → web/public/css/base.css
 *
 * Used:  Loaded by views/_layout.ejs.
 *
 * Change log:
 *   2026-05-25 — emptied. Was previously setting --color-primary and
 *                --color-accent from data-brand-* attrs; per the user's
 *                instruction colours now live exclusively in CSS.
 */

(function () {
    'use strict';
    // No-op. See the file header for the rationale.
})();
