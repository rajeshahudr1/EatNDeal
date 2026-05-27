/*
 * ui/loader.js
 *
 * What:  Global loading overlay helper. Exposes:
 *           window.EatNDealUi.showLoader(opts?)
 *           window.EatNDealUi.hideLoader()
 *
 *        Multiple concurrent callers are supported via a reference
 *        count — showLoader bumps the counter, hideLoader decrements
 *        it, and the overlay only hides when the counter returns to
 *        zero. That way two parallel "calling api" calls (e.g. brand +
 *        location) don't fight over the overlay.
 *
 *        Also auto-shows on form submits across the app, with a 180 ms
 *        delay so a quick submit doesn't flash the loader. Forms that
 *        opt out can carry `data-no-loader` on the <form>.
 *
 * Why:   Coding-Conventions rule #8 — consistent UI affordances across
 *        the PWA. A single branded loader reads as "EatNDeal is
 *        working" everywhere instead of mixing browser spinners + ad-
 *        hoc spinners per page.
 *
 * Used:  Loaded from views/_layout.ejs. Any page can call
 *           window.EatNDealUi.showLoader();
 *           …
 *           window.EatNDealUi.hideLoader();
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    var el      = null;     // resolved on first use
    var label   = null;
    var count   = 0;        // reference counter for nested callers
    var submitTimer = null;

    /**
     * resolve
     *
     * What:  Caches refs to the mount + label so we don't re-query the
     *        DOM on every call. Returns false (and a console warning)
     *        if the mount isn't on the page — typically means the
     *        layout-level include is missing.
     */
    function resolve() {
        if (el) { return true; }
        el    = document.getElementById('app-loader');
        label = document.getElementById('app-loader-label');
        if (!el && window.console) {
            window.console.warn('[loader] mount missing — include views/partials/loader.ejs in _layout');
        }
        return !!el;
    }

    /**
     * showLoader
     *
     * What:  Shows the global overlay. Optional opts.label overrides
     *        the default "Loading…" text. Increments the counter so
     *        nested callers stack cleanly.
     * Type:  WRITE (DOM).
     */
    function showLoader(opts) {
        if (!resolve()) { return; }
        count += 1;
        if (opts && typeof opts.label === 'string' && label) {
            label.textContent = opts.label || 'Loading…';
        } else if (label && count === 1) {
            // First call with no explicit label — reset to default in
            // case the previous use customised it.
            label.textContent = 'Loading…';
        }
        el.hidden = false;
        el.setAttribute('aria-hidden', 'false');
        el.setAttribute('aria-busy',   'true');
        // Body lock so the page underneath doesn't scroll while loading.
        document.body.classList.add('is-loading');
    }

    /**
     * hideLoader
     *
     * What:  Decrements the counter and hides the overlay when it
     *        reaches zero. Calling more times than show is a no-op,
     *        not an error — callers can be defensive without worrying
     *        about double-hides.
     */
    function hideLoader() {
        if (!resolve()) { return; }
        count = Math.max(0, count - 1);
        if (count > 0) { return; }
        el.setAttribute('aria-hidden', 'true');
        el.setAttribute('aria-busy',   'false');
        // Wait for the CSS transition so the fade-out plays.
        window.setTimeout(function () {
            if (count === 0) { el.hidden = true; }
        }, 180);
        document.body.classList.remove('is-loading');
    }

    /**
     * onSubmit (delegated, BUBBLE phase)
     *
     * What:  Catches every form submit at the document level and shows
     *        the loader after a short delay. Forms can opt out with
     *        the `data-no-loader` attribute (e.g. inline filters that
     *        navigate without a full request).
     *
     *        Critical: this listener runs on the BUBBLE phase (3rd arg
     *        false / default). That means every page-level submit
     *        handler (e.g. signin.js client-side phone validation) has
     *        already run and may have called ev.preventDefault() when
     *        validation failed. We check ev.defaultPrevented and bail
     *        in that case — otherwise the loader fires its 180 ms
     *        timer, the form never actually submits, the page never
     *        navigates, and the spinner is stuck forever.
     * Why:   Before this fix the listener was on capture phase: client
     *        validation errors on /signin left the loader spinning
     *        endlessly because no submission → no pagehide → no
     *        auto-hide. The bubble-phase + defaultPrevented check is
     *        the standard pattern for "do something only if the
     *        submit is really happening".
     */
    function onSubmit(ev) {
        if (ev.defaultPrevented) { return; }
        var form = ev.target;
        if (!form || form.tagName !== 'FORM') { return; }
        if (form.hasAttribute('data-no-loader')) { return; }
        if (submitTimer) { window.clearTimeout(submitTimer); }
        submitTimer = window.setTimeout(function () {
            showLoader();
        }, 180);
    }

    /**
     * onPageHide
     *
     * What:  Page is about to unload (navigation away, BFCache eject).
     *        Reset the counter so a return-via-back-button doesn't
     *        find a stuck loader.
     */
    function onPageHide() {
        if (submitTimer) { window.clearTimeout(submitTimer); submitTimer = null; }
        count = 0;
        if (el) {
            el.hidden = true;
            el.setAttribute('aria-hidden', 'true');
            el.setAttribute('aria-busy',   'false');
            document.body.classList.remove('is-loading');
        }
    }

    function bind() {
        // BUBBLE phase intentionally — see onSubmit doc-block for why
        // capture phase would cause stuck spinners on client-side
        // validation errors.
        document.addEventListener('submit', onSubmit, false);
        window.addEventListener('pagehide', onPageHide);
        // BFCache restore — Safari especially. Re-run the same reset.
        window.addEventListener('pageshow', function (ev) {
            if (ev.persisted) { onPageHide(); }
        });
    }

    // Public API — attached to the existing window.EatNDealUi namespace.
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.showLoader = showLoader;
    window.EatNDealUi.hideLoader = hideLoader;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
