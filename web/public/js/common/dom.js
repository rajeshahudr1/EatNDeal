/*
 * public/js/common/dom.js
 *
 * What:  The web layer's shared BROWSER-SIDE DOM / UI utilities on the global
 *        window.EatNDealDom — the querySelectorAll wrapper, a safe toast
 *        shim, a fetch-JSON unwrap, a modal visibility toggle, debounce and a
 *        digit stripper. Page scripts call these instead of re-declaring the
 *        same one-liners. Change a behaviour here → every caller follows.
 *
 *        The toast member is a thin shim over the EXISTING window.EatNDealUi
 *        (defined by ui/toast.js) read at CALL time, so load order between this
 *        file and toast.js does not matter.
 *
 * Load:  via <script defer src="/js/common/dom.js"> in _layout.ejs, BEFORE the
 *        ui/* and pages/* scripts that use it.
 */
(function () {
    'use strict';

    // querySelectorAll → real Array (so .forEach/.map/.filter work).
    function queryAll(sel, ctx) {
        return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
    }

    // Show a toast if the toast UI is loaded; no-op otherwise.
    function showToastSafe(type, msg) {
        if (window.EatNDealUi && window.EatNDealUi.showToast) {
            window.EatNDealUi.showToast(type, msg);
        }
    }

    // Parse a fetch Response as JSON, resolving to `fallback` (default null)
    // on a malformed/empty body instead of throwing.
    function parseJson(response, fallback) {
        var fb = (arguments.length > 1) ? fallback : null;
        return response.json().catch(function () { return fb; });
    }

    // Toggle a dialog/overlay element: hidden + aria-hidden, and (opt-in via
    // opts.lockScroll) the body scroll lock.
    function setModalVisible(el, visible, opts) {
        if (!el) { return; }
        opts = opts || {};
        el.hidden = !visible;
        el.setAttribute('aria-hidden', visible ? 'false' : 'true');
        if (opts.lockScroll) { document.body.style.overflow = visible ? 'hidden' : ''; }
    }

    // Trailing-edge debounce.
    function debounce(fn, ms) {
        var t;
        return function () {
            var ctx = this, args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(ctx, args); }, ms);
        };
    }

    // Keep digits only (phone-number normalisation in inputs).
    function stripNonDigits(s) {
        return String(s == null ? '' : s).replace(/\D/g, '');
    }

    window.EatNDealDom = {
        queryAll: queryAll,
        showToastSafe: showToastSafe,
        parseJson: parseJson,
        setModalVisible: setModalVisible,
        debounce: debounce,
        stripNonDigits: stripNonDigits,
    };
})();
