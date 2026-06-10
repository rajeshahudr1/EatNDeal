/*
 * service-worker.js — EatNDeal Admin PWA
 *
 * What:  Precaches the admin app shell (CSS, JS, fonts, brand) so the
 *        console loads fast on repeat visits and is installable.
 * Why:   Required for "Add to Home Screen" + a basic offline shell.
 * Used:  Registered by /js/app.js (production hostnames only — localhost
 *        unregisters it so dev never fights a stale cache).
 *
 * Strategy:
 *   • install  — precache the shell + fonts
 *   • activate — purge stale caches
 *   • fetch:
 *       - navigations  → network-first, fall back to /login
 *       - CSS / JS     → network-first (latest styles/scripts always win)
 *       - other assets → cache-first
 *       - /api/        → never handled (always go to network)
 */

/* eslint-env serviceworker */

var CACHE_NAME = 'eatndeal-admin-shell-v1';
var SHELL = [
    '/login',
    '/css/base.css',
    '/css/components/toast.css',
    '/css/components/auth-login.css',
    '/css/components/shell.css',
    '/css/desktop.css',
    '/css/mobile.css',
    '/js/boot-reader.js',
    '/js/ui/toast.js',
    '/js/app.js',
    '/js/pages/login.js',
    '/brand/logo.png',
    '/brand/favicon.png',
    '/fonts/Poppins-Regular.woff2',
    '/fonts/Poppins-Medium.woff2',
    '/fonts/Poppins-SemiBold.woff2',
    '/fonts/Poppins-Bold.woff2',
    '/fonts/Poppins-ExtraBold.woff2',
    '/manifest.webmanifest',
];

self.addEventListener('install', function (event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return Promise.all(SHELL.map(function (url) {
                return fetch(url).then(function (resp) {
                    if (resp && resp.ok) { return cache.put(url, resp); }
                }).catch(function () { /* tolerate one-off misses */ });
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
    if (req.method !== 'GET') { return; }

    var url = new URL(req.url);
    if (url.origin !== self.location.origin) { return; }
    if (url.pathname.indexOf('/api/') === 0) { return; }

    // HTML navigations — network-first, fall back to the cached login shell.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(function () {
                return caches.match('/login') || new Response('Offline', { status: 503 });
            })
        );
        return;
    }

    // CSS + JS — network-first so the latest always loads.
    if (/\.(css|js)$/i.test(url.pathname)) {
        event.respondWith(
            fetch(req).then(function (resp) {
                if (resp && resp.status === 200 && resp.type === 'basic') {
                    var copy = resp.clone();
                    caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
                }
                return resp;
            }).catch(function () { return caches.match(req); })
        );
        return;
    }

    // Other static assets (fonts, images, manifest) — cache-first.
    event.respondWith(
        caches.match(req).then(function (cached) {
            if (cached) { return cached; }
            return fetch(req).then(function (resp) {
                if (resp && resp.status === 200 && resp.type === 'basic') {
                    var copy = resp.clone();
                    caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
                }
                return resp;
            }).catch(function () { return cached; });
        })
    );
});
