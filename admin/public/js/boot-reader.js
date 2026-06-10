/*
 * boot-reader.js
 *
 * What:  Reads the <body data-*> runtime config into a single global
 *        window.boot object so other scripts never parse data-attrs
 *        themselves. Runs first (no dependencies).
 * Why:   Keeps configuration in ONE place and out of inline scripts
 *        (Conventions rule #6 — no inline JS).
 * Used:  Loaded before every other script in views/_layout.ejs.
 */
(function () {
    'use strict';
    var b = document.body || {};
    window.boot = {
        apiUrl:    (b.dataset && b.dataset.apiUrl) || '',
        activeNav: (b.dataset && b.dataset.activeNav) || '',
    };
})();
