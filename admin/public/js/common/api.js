/*
 * public/js/common/api.js  (admin layer)
 *
 * What:  Shared browser fetch/JSON wrappers on window.AdminApi — the POST and
 *        GET-JSON helpers + the envelope success check that admin page scripts
 *        re-implemented per page (with subtly different formatting). One copy
 *        removes the drift on these correctness-sensitive paths (money / status
 *        toggles / deletes).
 * Load:  via <script defer src="/js/common/api.js"> in _layout.ejs, BEFORE the
 *        per-page scripts (extra_js) that use it.
 */
(function () {
    'use strict';

    // POST a JSON body; resolves to the parsed envelope, or a {status:0} shape
    // on a bad/unreachable response (never rejects).
    function post(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return { status: 0, msg: 'Bad response.' }; }); })
            .catch(function () { return { status: 0, msg: 'Could not reach the server.' }; });
    }

    // GET JSON; same envelope/fallback contract as post().
    //
    // Always hits the server. These GETs read data the admin has JUST
    // changed (assign restaurants, then reopen the count popup), so a
    // cached copy shows the OLD list and the change looks lost until a
    // couple of page refreshes. Three layers, because on live a proxy/CDN
    // sits in front and only one of them is under our control:
    //   • cache: 'no-store'     — the browser's HTTP cache
    //   • Cache-Control header  — asks intermediaries not to serve a copy
    //   • _ts cache-buster      — defeats anything that ignores both
    function getJson(url) {
        var bust = (url.indexOf('?') === -1 ? '?' : '&') + '_ts=' + Date.now();
        return fetch(url + bust, {
            cache: 'no-store',
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        })
            .then(function (r) { return r.json().catch(function () { return { status: 0, msg: 'Bad response.' }; }); })
            .catch(function () { return { status: 0, msg: 'Could not reach the server.' }; });
    }

    // True for a successful api envelope.
    function isSuccess(res) { return res && res.status === 200; }

    window.AdminApi = { post: post, getJson: getJson, isSuccess: isSuccess };
})();
