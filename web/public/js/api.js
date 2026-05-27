/*
 * api.js
 *
 * What:  Thin browser-side wrapper around fetch() for calling our Node API.
 *        Exposed as window.EatNDealApi.{get,post,patch,delete}.
 * Why:   Every page that talks to /api/v1/... goes through here. Keeps the
 *        envelope-unwrap logic in one place, attaches device headers
 *        consistently, and surfaces errors the rest of the JS can handle
 *        uniformly via toast / dialog.
 * Used:  Imported by every page-level JS via window.EatNDealApi.
 */

(function () {
    'use strict';

    var API_BASE = (window.boot && window.boot.apiUrl) || '';

    /**
     * buildHeaders
     *
     * What:  Returns the standard header object for outgoing API calls.
     * Why:   Adds X-Device-OS=web so the api can write `web` into
     *        cart.devicetype / orders.created_from columns (the existing
     *        wtw_eatndeal schema already tracks device source). Mirrors
     *        the header contract the future Flutter app will use too.
     * Type:  READ.
     * Inputs: extra (object) — optional additional headers.
     * Output: object.
     * Used:   Only inside this module.
     */
    function buildHeaders(extra) {
        var headers = {
            'Accept':       'application/json',
            'X-Device-OS':  'web',
        };
        if (extra) {
            Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
        }
        return headers;
    }

    /**
     * unwrap
     *
     * What:  Resolves the api envelope `{status, show, msg, data}`.
     *        Returns `data` on status 200, otherwise throws an Error
     *        whose `.message` is the user-facing `msg` and whose
     *        `.envelope` carries the full payload (for callers who want
     *        the logical status code).
     * Why:   Page code can `await EatNDealApi.get('/foo')` and trust that
     *        it gets the resource OR a thrown error with a friendly msg.
     *        Network errors map to a generic message so the UI never sees
     *        a raw "Failed to fetch".
     * Type:  READ.
     * Inputs: response (Response), payload (object|null).
     * Output: the `data` field on success; throws on failure.
     * Used:   Only inside this module.
     */
    function unwrap(response, payload) {
        if (!payload || typeof payload !== 'object') {
            var err = new Error('We could not reach the server. Please try again.');
            err.envelope = { status: response.status, msg: 'transport' };
            throw err;
        }
        if (payload.status === 200) {
            return payload.data;
        }
        var failure = new Error(payload.msg || 'Something went wrong. Please try again.');
        failure.envelope = payload;
        throw failure;
    }

    /**
     * request
     *
     * What:  Single underlying call. Other verbs delegate here.
     * Why:   Keeps the fetch options + error handling in one place.
     * Type:  depends on method.
     * Inputs: method (string), path (string), body (object|null).
     * Output: Promise<data>.
     * Used:   Inside this module.
     */
    async function request(method, path, body) {
        var url     = API_BASE + path;
        var headers = buildHeaders();
        var init    = { method: method, headers: headers };

        if (body !== undefined && body !== null) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        var response;
        try {
            response = await fetch(url, init);
        } catch (err) {
            var transportErr = new Error('We could not reach the server. Please check your internet connection and try again.');
            transportErr.envelope = { status: 0, msg: 'transport' };
            throw transportErr;
        }

        var payload = null;
        try { payload = await response.json(); } catch (e) { /* leave null */ }
        return unwrap(response, payload);
    }

    // Public surface
    window.EatNDealApi = Object.freeze({

        /**
         * get(path) — convenience wrapper for GET requests.
         * Used by every read endpoint (e.g. EatNDealApi.get('/api/v1/brand')).
         */
        get: function (path) { return request('GET', path, null); },

        /**
         * post(path, body) — convenience wrapper for POST requests.
         * Used for login, OTP, place order, etc.
         */
        post: function (path, body) { return request('POST', path, body); },

        /**
         * patch(path, body) — convenience wrapper for PATCH requests.
         */
        patch: function (path, body) { return request('PATCH', path, body); },

        /**
         * delete(path) — convenience wrapper for DELETE requests.
         */
        'delete': function (path) { return request('DELETE', path, null); },
    });
})();
