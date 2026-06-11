/*
 * public/js/common/format.js  (admin layer)
 *
 * What:  Shared browser string/format/validation helpers on window.AdminUi —
 *        HTML escaping, slugify, the 2dp money formatter, the email pattern,
 *        and an image-file (type + size) validator. Browser TWIN of the server
 *        Helpers/viewFormat.js + viewConstants.js — escapeHtml and money are
 *        intentionally duplicated across the server/browser boundary (no shared
 *        module loader); keep them in sync.
 * Load:  via <script defer src="/js/common/format.js"> in _layout.ejs, before
 *        the per-page scripts.
 */
(function () {
    'use strict';

    window.AdminUi = window.AdminUi || {};

    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Escape the 5 HTML entities — the single, reviewed client escaper.
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // URL-safe slug from a label.
    function slugify(s) {
        return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    // Bare 2-decimal money string (no symbol) — round-half-up.
    function money(n) {
        return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
    }

    function isEmail(s) { return EMAIL_PATTERN.test(String(s || '')); }

    // Validate an upload's type + size. Caller passes its OWN policy so each
    // upload keeps its limits (they differ across the admin):
    //   validateImageFile(file, { types:[...], maxBytes:N, typeMsg, sizeMsg })
    // Returns { ok:true } or { ok:false, msg }.
    function validateImageFile(file, opts) {
        opts = opts || {};
        var maxBytes = opts.maxBytes || (5 * 1024 * 1024);
        var types = opts.types || ['image/png', 'image/jpeg', 'image/webp'];
        if (!file) { return { ok: false, msg: opts.requiredMsg || 'Please choose an image.' }; }
        if (types.indexOf(file.type) === -1) { return { ok: false, msg: opts.typeMsg || 'Unsupported image type.' }; }
        if (file.size > maxBytes) { return { ok: false, msg: opts.sizeMsg || ('Image must be under ' + Math.round(maxBytes / 1024 / 1024) + ' MB.') }; }
        return { ok: true };
    }

    window.AdminUi.escapeHtml = escapeHtml;
    window.AdminUi.slugify = slugify;
    window.AdminUi.money = money;
    window.AdminUi.EMAIL_PATTERN = EMAIL_PATTERN;
    window.AdminUi.isEmail = isEmail;
    window.AdminUi.validateImageFile = validateImageFile;
})();
