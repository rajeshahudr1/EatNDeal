/*
 * app.js
 *
 * What:  Global admin bindings that run on every page:
 *          • Registers the service worker (PWA) — skipped on localhost so
 *            a stale cache never masks a code change during development.
 *          • Off-canvas sidebar open / close (mobile) via the topbar
 *            hamburger and the dim scrim.
 * Why:   One place for app-wide behaviour; per-page logic lives in
 *        pages/*.js (Conventions rule #6 — no inline JS).
 * Used:  Loaded last (after boot-reader + toast) in views/_layout.ejs.
 */
(function () {
    'use strict';

    // ── Service worker (PWA) ────────────────────────────────────────
    // Register at root scope so the SW controls the whole origin. On
    // localhost we deliberately DO NOT register (and unregister any
    // existing one) so active development never fights a cached shell.
    if ('serviceWorker' in navigator) {
        var host = location.hostname;
        var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
        if (isLocal) {
            navigator.serviceWorker.getRegistrations().then(function (regs) {
                regs.forEach(function (r) { r.unregister(); });
            }).catch(function () {});
        } else {
            window.addEventListener('load', function () {
                navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(function () {});
            });
        }
    }

    // ── Sidebar off-canvas (mobile) ─────────────────────────────────
    function openSidebar()  { document.body.classList.add('sidebar-open'); }
    function closeSidebar() { document.body.classList.remove('sidebar-open'); }

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }
        if (t.closest('[data-action="open-sidebar"]'))  { ev.preventDefault(); openSidebar();  return; }
        if (t.closest('[data-action="close-sidebar"]')) { ev.preventDefault(); closeSidebar(); return; }
        // Tapping a nav link closes the drawer so the destination is visible.
        if (t.closest('.admin-nav__item') && document.body.classList.contains('sidebar-open')) {
            closeSidebar();
        }
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { closeSidebar(); }
    });
})();
