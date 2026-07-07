/*
 * ui/cookie-consent.js
 *
 * What:  Drives the first-visit cookie-consent banner:
 *          • On DOM-ready, checks the `eatndeal_consent` cookie. If
 *            present (value 'accepted' or 'rejected') the banner stays
 *            hidden — the user has already decided.
 *          • Otherwise shows the banner with the slide-up animation
 *            from cookie-consent.css.
 *          • Clicking Accept   → set cookie to 'accepted' (1 year),
 *                                 dismiss banner, fire a custom event
 *                                 so other code (analytics later, etc.)
 *                                 can pick up.
 *          • Clicking Reject   → set cookie to 'rejected' (1 year),
 *                                 dismiss banner, fire 'eatndeal:cookies:rejected'.
 * Why:   UK GDPR requires explicit consent before we set non-essential
 *        cookies. This is the consent surface. The session-state /
 *        JWT cookies the api issues are considered "strictly necessary"
 *        for the service to function, but we still surface the choice
 *        so users know what's going on.
 * Used:  Loaded from views/_layout.ejs. CSP-safe (no inline JS).
 *
 * Cookie storage:
 *   • eatndeal_consent=accepted|rejected
 *   • Max-Age: 365 days
 *   • Path: /  (so it's visible to every route)
 *   • SameSite: Lax  (the same default express-session uses)
 *   • Secure: only when the page is on https
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    var COOKIE_NAME = 'eatndeal_consent';
    var MAX_AGE_S   = 60 * 60 * 24 * 365;   // 1 year

    /**
     * readConsent
     *
     * What:  Returns the current consent value from document.cookie, or
     *        an empty string when the cookie isn't set yet.
     * Why:   We use the cookie as the source of truth (not localStorage)
     *        so the choice survives across browsers / devices when the
     *        same user signs in later — the server sees the same cookie.
     * Type:  READ.
     */
    function readConsent() {
        var pairs = document.cookie.split(';');
        for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i].trim();
            if (pair.indexOf(COOKIE_NAME + '=') === 0) {
                return decodeURIComponent(pair.substring(COOKIE_NAME.length + 1));
            }
        }
        return '';
    }

    /**
     * writeConsent
     *
     * What:  Writes the consent cookie with a 1-year lifetime + the
     *        cross-site / secure flags appropriate for the current page.
     * Why:   See file header for storage rationale.
     * Type:  WRITE (sets document.cookie).
     */
    function writeConsent(value) {
        var parts = [
            COOKIE_NAME + '=' + encodeURIComponent(value),
            'Max-Age='  + MAX_AGE_S,
            'Path=/',
            'SameSite=Lax',
        ];
        // `Secure` is REQUIRED for cookies set over https. Setting it on
        // http://localhost would prevent the cookie from sticking (the
        // browser drops `Secure` cookies on plain-http origins), so we
        // gate it on protocol.
        if (window.location.protocol === 'https:') {
            parts.push('Secure');
        }
        document.cookie = parts.join('; ');
    }

    /**
     * showBanner
     *
     * What:  Reveals the banner with the slide-up animation. The
     *        `is-visible` class triggers the CSS transform transition.
     * Type:  WRITE (DOM).
     */
    function showBanner(banner) {
        banner.hidden = false;
        // Force a reflow so the transition picks up the class change.
        // Without this, browsers can batch the removed `hidden` and the
        // class add into one paint — no animation plays.
        // eslint-disable-next-line no-unused-expressions
        banner.offsetHeight;
        banner.classList.add('is-visible');
    }

    /**
     * hideBanner
     *
     * What:  Reverses the slide-up and then hides the element from the
     *        layout flow after the transition ends.
     * Type:  WRITE (DOM).
     */
    function hideBanner(banner) {
        banner.classList.remove('is-visible');
        window.setTimeout(function () { banner.hidden = true; }, 320);
    }

    /**
     * dispatch
     *
     * What:  Emits a CustomEvent on `document` so any future analytics /
     *        user-pref hook can react to the consent choice without
     *        polling.
     */
    function dispatch(name) {
        try {
            document.dispatchEvent(new CustomEvent(name));
        } catch (e) { /* IE11 doesn't matter for us */ }
    }

    /**
     * isMobileApp
     *
     * What:  True when we're on a phone-sized screen OR running as an
     *        installed PWA (standalone display-mode / iOS navigator.standalone).
     * Why:   The app is used as a web-app on mobile, where a GDPR banner over
     *        the small screen is intrusive. Per the user, on mobile we
     *        auto-accept (the session / saved-location cookies are strictly
     *        necessary anyway) and never show the banner. Desktop still asks.
     * Type:  READ.
     */
    function isMobileApp() {
        try {
            if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) { return true; }
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) { return true; }
            if (window.navigator && window.navigator.standalone === true) { return true; }
        } catch (e) { /* matchMedia unsupported — fall through */ }
        return false;
    }

    /**
     * onReady
     *
     * What:  Boot. Looks up the banner, checks the consent cookie, and
     *        wires the Accept / Reject buttons (delegated).
     */
    function onReady() {
        var banner = document.getElementById('cookie-consent');
        if (!banner) { return; }

        // Already decided? Stay hidden.
        if (readConsent()) { return; }

        // Mobile / installed PWA → auto-accept silently, no banner.
        if (isMobileApp()) {
            writeConsent('accepted');
            dispatch('eatndeal:cookies:accepted');
            return;
        }

        // Wire the buttons BEFORE we show the banner so a fast tap still
        // works (mobile users sometimes tap during the slide-in).
        document.addEventListener('click', function (ev) {
            var accept = ev.target.closest && ev.target.closest('[data-action="accept-cookies"]');
            var reject = ev.target.closest && ev.target.closest('[data-action="reject-cookies"]');
            if (accept) {
                ev.preventDefault();
                writeConsent('accepted');
                hideBanner(banner);
                dispatch('eatndeal:cookies:accepted');
                return;
            }
            if (reject) {
                ev.preventDefault();
                writeConsent('rejected');
                hideBanner(banner);
                dispatch('eatndeal:cookies:rejected');
                if (window.EatNDealUi && window.EatNDealUi.showToast) {
                    window.EatNDealUi.showToast(
                        'info',
                        'Some features (sign-in, saved location) will be unavailable. You can change this later.'
                    );
                }
            }
        });

        // Show on the next animation frame so the layout has settled.
        window.requestAnimationFrame(function () { showBanner(banner); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
