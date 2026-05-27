/*
 * service-worker.js
 *
 * What:  PWA service worker. Precaches the app shell (HTML, CSS, JS, fonts,
 *        brand assets) so the landing page loads instantly on repeat
 *        visits and works offline at a basic level.
 * Why:   Required for the "Add to Home Screen" PWA install prompt and for
 *        the offline shell. Kept intentionally small — runtime caching
 *        rules will be expanded once we have real API responses to cache.
 * Used:  Registered by /js/app.js at navigator.serviceWorker.register('/').
 *
 * Cache strategy:
 *   • install — precache the shell + fonts
 *   • activate — purge stale caches whose name doesn't match
 *   • fetch:
 *       - HTML navigations  → network-first, fallback to cached shell
 *       - Static assets     → cache-first
 *       - API calls (/api/) → network-only (always go through)
 */

/* eslint-env serviceworker */

// Bump CACHE_NAME (eg shell-v1 -> shell-v2) any time you change the SHELL
// list or any precached file's contents. The activate handler purges
// caches whose name doesn't match, so bumping the name flushes stale
// entries cleanly.
var CACHE_NAME = 'eatndeal-shell-v68';
var SHELL = [
    '/',

    // Stylesheets — keep this list in sync with views/_layout.ejs.
    '/css/base.css',
    '/css/components/header.css',
    '/css/components/mobile-search.css',
    '/css/components/promo-strip.css',
    '/css/components/footer.css',
    '/css/components/hero.css',
    '/css/components/cuisine.css',
    '/css/components/restaurant-card.css',
    '/css/components/dish-card.css',
    '/css/components/loader.css',
    '/css/components/search-overlay.css',
    '/css/components/how-step.css',
    '/css/components/promo-banner.css',
    '/css/components/location-modal.css',
    '/css/components/toast.css',
    '/css/components/dialog.css',
    '/css/components/bottom-nav.css',
    '/css/components/mobile-drawer.css',
    '/css/components/account-menu.css',
    '/css/desktop.css',
    '/css/mobile.css',

    // Scripts
    '/js/boot-reader.js',
    '/js/api.js',
    '/js/brand.js',
    '/js/ui/toast.js',
    '/js/ui/dialog.js',
    '/js/ui/loader.js',
    '/js/ui/search-overlay.js',
    '/js/ui/location-modal.js',
    '/js/ui/account-menu.js',
    '/js/app.js',

    // Brand assets
    '/brand/logo.png',
    '/brand/favicon.png',

    // Self-hosted fonts (Coding-Conventions rule #5)
    '/fonts/Poppins-Regular.woff2',
    '/fonts/Poppins-Medium.woff2',
    '/fonts/Poppins-SemiBold.woff2',
    '/fonts/Poppins-Bold.woff2',

    '/manifest.webmanifest',
];

self.addEventListener('install', function (event) {
    // Skip waiting so updates roll out immediately (the existing tab will
    // pick up the new SW on its next navigation).
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // addAll is atomic — if any URL fails, none are cached.
            // Use individual put() to be tolerant of single missing files
            // during development (e.g. an icon we haven't created yet).
            return Promise.all(SHELL.map(function (url) {
                return fetch(url).then(function (resp) {
                    if (resp && resp.ok) { return cache.put(url, resp); }
                }).catch(function () { /* ignore one-off misses in dev */ });
            }));
        })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(names.map(function (name) {
                if (name !== CACHE_NAME) { return caches.delete(name); }
            }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    var req = event.request;

    // Only handle GETs — POST / PATCH / DELETE always go through.
    if (req.method !== 'GET') { return; }

    var url = new URL(req.url);

    // Bypass cross-origin requests + the API entirely.
    if (url.origin !== self.location.origin) { return; }
    if (url.pathname.indexOf('/api/') === 0) { return; }

    // Navigation requests (HTML pages) — network-first, fall back to the
    // cached root so users see SOMETHING when offline.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(function () {
                return caches.match('/') || new Response('Offline', { status: 503 });
            })
        );
        return;
    }

    // Static assets — cache-first, populate on miss.
    event.respondWith(
        caches.match(req).then(function (cached) {
            if (cached) { return cached; }
            return fetch(req).then(function (resp) {
                // Only cache successful, basic-type responses.
                if (resp && resp.status === 200 && resp.type === 'basic') {
                    var copy = resp.clone();
                    caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
                }
                return resp;
            }).catch(function () { return cached; });
        })
    );
});
