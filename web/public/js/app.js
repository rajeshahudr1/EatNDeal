/*
 * app.js
 *
 * What:  Per-page orchestrator. Runs on DOMContentLoaded across every
 *        page. Responsibilities:
 *         • Auto-open the location modal on first visit
 *           (when window.boot.hasLocation === false).
 *         • Register the PWA service worker.
 *         • Bind the mobile menu hamburger toggle.
 * Why:   Tiny glue. Anything page-specific lives in /js/pages/<name>.js
 *        and is loaded by the child view setting `extra_js`.
 * Used:  Loaded last in views/_layout.ejs (defer order matters).
 */

(function () {
    'use strict';

    /**
     * onReady
     *
     * What:  Initial dispatcher run when the DOM is parsed. Calls every
     *        feature-specific init below.
     * Why:   One controlled entry point keeps load order predictable.
     *
     *        NO auto-open of the location modal on first visit. Users
     *        always have a clear entry-point on the page itself (the
     *        header chip, the hero search pill, the "Set my location"
     *        empty state, the "Get started" promo CTA) — a forced popup
     *        is unnecessary and intrusive.
     *        The modal opens ONLY when the user explicitly clicks one
     *        of those entry-points, via the delegated
     *        data-action="open-location-modal" handler in
     *        /js/ui/location-modal.js.
     */
    function onReady() {
        registerServiceWorker();
        bindMobileMenu();
        bindNotificationsBell();
        bindOrderModeToggle();
        bindDrawerStubs();
        bindReorder();
        bindOfflineIndicator();
    }

    /**
     * bindOfflineIndicator
     *
     * What:   Toggles the app-wide "you're offline" strip
     *         (partials/offline-banner.ejs) from the browser's connectivity
     *         state — hidden while online, shown the moment the `offline`
     *         event fires, hidden again on `online`.
     * Why:    The app runs as a web-app on mobile; a dropped signal should
     *         read as a friendly offline message, not silently-failing
     *         actions. Complements the service-worker offline.html fallback
     *         (which only covers full-page navigations).
     * Type:   WRITE (DOM + event bindings).
     * Used:   Called once from onReady().
     */
    function bindOfflineIndicator() {
        var banner = document.getElementById('offline-banner');
        if (!banner) { return; }
        // navigator.onLine === false → offline → reveal the banner.
        function update() { banner.hidden = navigator.onLine !== false; }
        update();
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
    }

    /**
     * bindReorder
     *
     * What:   Click handler for the "Reorder" button on the order-detail
     *         page. POSTs to /order/:id/reorder (the api clones the past
     *         order's items into a fresh cart) and, on success, sends the
     *         customer to /cart. A note about any items that couldn't be
     *         re-added (now unavailable) is stashed for the cart page to
     *         surface as a toast.
     * Type:   WRITE (creates a cart server-side).
     */
    function bindReorder() {
        document.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('[data-action="order-reorder"]');
            if (!btn || btn.disabled) { return; }
            ev.preventDefault();
            var orderId = btn.getAttribute('data-order-id');
            if (!orderId) { return; }
            var orig = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Adding…';
            fetch('/order/' + encodeURIComponent(orderId) + '/reorder', {
                method:      'POST',
                credentials: 'same-origin',
                headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body:        '{}',
            }).then(function (r) {
                return r.json().catch(function () { return null; });
            }).then(function (env) {
                if (env && env.status === 401) {
                    window.location.href = '/signin?next=' + encodeURIComponent('/order/' + orderId);
                    return;
                }
                if (!env || env.status !== 200) {
                    if (window.EatNDealUi && window.EatNDealUi.showToast) {
                        window.EatNDealUi.showToast('error', (env && env.msg) || 'Could not reorder.');
                    }
                    btn.disabled = false;
                    btn.textContent = orig;
                    return;
                }
                // Carry the result message (incl. any skipped items) to /cart.
                try { sessionStorage.setItem('reorder.msg', env.msg || ''); } catch (e) { /* ignore */ }
                window.location.href = '/cart';
            }).catch(function () {
                if (window.EatNDealUi && window.EatNDealUi.showToast) {
                    window.EatNDealUi.showToast('error', 'Could not reorder. Please try again.');
                }
                btn.disabled = false;
                btn.textContent = orig;
            });
        });
    }

    /**
     * bindDrawerStubs
     *
     * What:   The profile drawer's not-yet-built rows (Wallet, Appearance,
     *         Payment methods, Address book) carry data-action="drawer-soon".
     *         Tapping one surfaces a "coming soon" toast instead of a dead
     *         link. Delegated so it covers the drawer whenever it's open.
     * Type:   WRITE (toast).
     */
    function bindDrawerStubs() {
        document.addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('[data-action="drawer-soon"]');
            if (!t) { return; }
            ev.preventDefault();
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('info', 'Coming soon.');
            }
        });
    }

    /**
     * bindOrderModeToggle
     *
     * What:   Delivery / Pickup segmented control in the header. Picking
     *         a segment is a full LAYOUT switch (delivery feed ↔ pickup
     *         map+list), so it triggers a real navigation rather than an
     *         in-page swap. Pickup → ?mode=pickup; Delivery → drop the
     *         param (delivery is the default). Any existing query (e.g.
     *         ?cuisine=) is preserved.
     * Why:    The toggle was pure-CSS (painted the segment but did
     *         nothing). It now actually changes mode.
     * Type:   WRITE (navigation). Delegated so it works regardless of
     *         when the header renders.
     */
    function bindOrderModeToggle() {
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (!t || t.name !== 'order-mode') { return; }
            var mode = t.value === 'pickup' ? 'pickup' : 'delivery';
            var url;
            try { url = new URL(window.location.href); }
            catch (e) { return; }
            // Land on the FEED, not a sub-view — drop any focused-view
            // params so toggling from a restaurant/all-list page shows
            // the pickup map / delivery feed itself.
            url.searchParams.delete('view');
            url.searchParams.delete('restaurant');
            // Always set the mode EXPLICITLY (including delivery). The
            // chosen mode is remembered in the session, so just dropping
            // the param would let a saved "pickup" win and the map would
            // stay — clicking Delivery must force the normal feed back.
            url.searchParams.set('mode', mode);
            // Pickup/Delivery always lives on the home feed.
            window.location.href = '/' + (url.search || '');
        });
    }

    /**
     * registerServiceWorker
     *
     * What:  Registers /service-worker.js at root scope (the header
     *        Service-Worker-Allowed: / set in web/index.js makes this
     *        legal). The SW caches the app shell and is required for the
     *        PWA "Add to Home Screen" prompt.
     * Why:   Coding-Conventions / project rule — web is a PWA.
     */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) { return; }

        // ── Dev mode: NO service worker ──────────────────────────────
        // On localhost / 127.* the SW only causes grief — it caches the
        // shell so CSS/JS changes don't show until you clear storage.
        // So in dev we DON'T register it AND actively UNREGISTER any
        // SW left over from a previous visit + wipe its caches. Result:
        // every code change shows on a plain refresh, no cache-clearing.
        var host = window.location.hostname;
        var isDev = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
        if (isDev) {
            navigator.serviceWorker.getRegistrations().then(function (regs) {
                regs.forEach(function (r) { r.unregister(); });
            }).catch(function () { /* noop */ });
            if (window.caches && caches.keys) {
                caches.keys().then(function (names) {
                    names.forEach(function (n) { caches.delete(n); });
                }).catch(function () { /* noop */ });
            }
            return;   // never register the SW in dev
        }

        // ── Production: register the PWA service worker ──────────────
        navigator.serviceWorker.register('/service-worker.js').catch(function (err) {
            if (window.console) { window.console.warn('[sw] register failed', err && err.message); }
        });
    }

    /**
     * bindMobileMenu
     *
     * What:  Hooks up the hamburger button in the header to open the
     *        mobile drawer (views/partials/mobile-drawer.ejs).
     *        Also binds every [data-action="close-mobile-menu"] surface
     *        (close button + backdrop) so taps anywhere outside the panel
     *        dismiss it. Esc on the keyboard closes it too.
     * Why:   The hamburger has to actually do something on mobile — it is
     *        the only entry point to Sign in / Sign up / secondary nav
     *        on small screens (header has room for logo + chip + button).
     * Type:  WRITE (DOM event bindings).
     * Inputs: none — looks up the DOM nodes itself.
     * Output: void.
     * Used:   Called once from onReady() above.
     *
     * Change log:
     *   2026-05-25 — initial: was a no-op class toggle, now drives the
     *                full slide-in drawer.
     */
    function bindMobileMenu() {
        var btn    = document.querySelector('[data-action="toggle-mobile-menu"]');
        var drawer = document.getElementById('mobile-drawer');
        if (!btn || !drawer) { return; }

        // Inline helpers keep state changes in one place — easy to audit
        // later when we add transitions or hooks.
        function open() {
            drawer.hidden = false;
            drawer.setAttribute('aria-hidden', 'false');
            document.body.classList.add('is-mobile-menu-open');
            btn.setAttribute('aria-expanded', 'true');
        }
        function close() {
            // Move focus out of the drawer BEFORE flipping aria-hidden,
            // else Chrome warns about aria-hidden on an ancestor of the
            // focused element. Forwarding focus to the hamburger button
            // is also good UX — returns the user to where the drawer
            // was triggered from.
            var active = document.activeElement;
            if (active && drawer.contains(active) && typeof active.blur === 'function') {
                active.blur();
                btn.focus({ preventScroll: true });
            }

            drawer.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('is-mobile-menu-open');
            btn.setAttribute('aria-expanded', 'false');
            // Wait for the CSS transition (220ms) before hiding from a11y
            // tree — that way the slide-out animation actually plays.
            window.setTimeout(function () {
                if (drawer.getAttribute('aria-hidden') === 'true') {
                    drawer.hidden = true;
                }
            }, 240);
        }

        // Hamburger → toggle
        btn.addEventListener('click', function () {
            if (drawer.getAttribute('aria-hidden') === 'false') { close(); } else { open(); }
        });

        // Close button + backdrop (both carry data-action="close-mobile-menu")
        drawer.querySelectorAll('[data-action="close-mobile-menu"]').forEach(function (el) {
            el.addEventListener('click', close);
        });

        // Esc closes when the drawer is open
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && drawer.getAttribute('aria-hidden') === 'false') { close(); }
        });

        // If the viewport grows past the mobile breakpoint (e.g. user
        // rotates a tablet), close the drawer so the desktop nav can
        // take over cleanly.
        var mq = window.matchMedia('(min-width: 768px)');
        function onBreakpoint(e) { if (e.matches) { close(); } }
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', onBreakpoint);
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(onBreakpoint);                  // older Safari
        }
    }

    /**
     * bindNotificationsBell
     *
     * What:   Click handler for the header notification bell. Until the
     *         /notifications page is built, every tap surfaces a friendly
     *         "coming soon" toast — clearer feedback than a dead link.
     * Why:    The bell is visually prominent (gold icon + red badge);
     *         clicking it must do SOMETHING obvious, otherwise users
     *         think the site is broken.
     * Type:   WRITE (DOM event binding).
     * Inputs: none — looks up nodes itself.
     * Output: void.
     * Used:   Called once from onReady().
     *
     * Change log:
     *   2026-05-25 — initial.
     */
    function bindNotificationsBell() {
        document.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('[data-action="open-notifications"]');
            if (!btn) { return; }
            ev.preventDefault();
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('info', 'Notifications are coming soon.');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
