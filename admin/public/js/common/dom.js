/*
 * public/js/common/dom.js  (admin layer)
 *
 * What:  Shared browser DOM/UI helpers on window.AdminUi (the namespace
 *        ui/toast.js already creates) — a safe toast shim, query/byId helpers,
 *        debounce, the [data-modal] show/hide, and the bulk-selection action
 *        bar — copied verbatim across products.js / mp-categories.js et al.
 * Load:  via <script defer src="/js/common/dom.js"> in _layout.ejs, after
 *        ui/toast.js and before the per-page scripts.
 */
(function () {
    'use strict';

    window.AdminUi = window.AdminUi || {};

    // Show a toast if the toast UI is loaded; no-op otherwise.
    function showToastSafe(type, msg) {
        if (window.AdminUi && window.AdminUi.showToast) { window.AdminUi.showToast(type, msg); }
    }

    function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
    function byId(id) { return id ? document.getElementById(id) : null; }

    function debounce(fn, ms) {
        var t;
        return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
    }

    // [data-modal="name"] show / hide-all (+ body scroll lock class).
    function showModal(name) { var m = document.querySelector('[data-modal="' + name + '"]'); if (m) { m.hidden = false; document.body.classList.add('pr-modal-open'); } }
    function hideModals() { var ms = document.querySelectorAll('[data-modal]'); for (var i = 0; i < ms.length; i++) { ms[i].hidden = true; } document.body.classList.remove('pr-modal-open'); }

    // Bulk-selection (.pr-check) ids + the action-bar refresh.
    function getSelectedIds() { return Array.prototype.map.call(document.querySelectorAll('.pr-check:checked'), function (c) { return Number(c.value); }); }
    function refreshActionBar() {
        var ids = getSelectedIds();
        var bar = document.querySelector('[data-actionbar]');
        if (bar) { bar.hidden = ids.length === 0; var c = bar.querySelector('[data-sel-count]'); if (c) { c.textContent = ids.length; } }
        var all = document.querySelector('[data-action="pr-checkall"]');
        var boxes = document.querySelectorAll('.pr-check');
        if (all) { all.checked = boxes.length > 0 && ids.length === boxes.length; }
    }

    window.AdminUi.showToastSafe = showToastSafe;
    window.AdminUi.qs = qs;
    window.AdminUi.byId = byId;
    window.AdminUi.debounce = debounce;
    window.AdminUi.showModal = showModal;
    window.AdminUi.hideModals = hideModals;
    window.AdminUi.getSelectedIds = getSelectedIds;
    window.AdminUi.refreshActionBar = refreshActionBar;
})();
