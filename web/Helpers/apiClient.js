'use strict';

/**
 * Helpers/apiClient.js
 *
 * What:   Thin wrapper around Node's built-in fetch() that every web
 *         controller uses to talk to the api/ layer. The web NEVER touches
 *         the database directly — every read or write goes through this.
 * Why:    Centralises auth-header forwarding, base-URL construction, and
 *         JSON parsing so each controller stays one-liner short.
 *         Project rule: web -> api -> db. Never web -> db.
 * Type:   READ + WRITE (depends on the endpoint being called).
 * Inputs: req (Express request — used to read session token), method, path,
 *         body (optional).
 * Output: { status, body, networkError? }
 *           - status       — HTTP status of the API response (0 if network failed)
 *           - body         — parsed JSON envelope, or null if not JSON
 *           - networkError — only present when transport failed (timeout, dns)
 * Used:   Every Controllers/*.js file. Plus once at boot from index.js to
 *         pre-fetch /brand for the layout.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const API_URL = String(process.env.API_URL || 'http://localhost:4501').replace(/\/$/, '');

/**
 * callApi
 *
 * What:   Sends an HTTP request to the api/ layer, forwarding the session
 *         JWT as a Bearer token when present.
 * Why:    See file header.
 * Type:   READ + WRITE.
 * Inputs: req      (Express req) — used to read req.session.token
 *         method   (string)      — GET / POST / PATCH / DELETE
 *         path     (string)      — must start with "/api/v1/..."
 *         body     (object|null) — request body; serialised as JSON
 * Output: { status, body, networkError? } — see file header.
 * Used:   Every controller method that needs API data.
 */
async function callApi(req, method, path, body) {
    const headers = {
        Accept: 'application/json',
    };

    // Forward the session JWT (issued by api/<actor>/login) as Bearer so the
    // api can authenticate the request. Unauthenticated calls (e.g. /brand)
    // simply lack this header — that's fine, those endpoints are public.
    if (req && req.session && req.session.token) {
        headers.Authorization = `Bearer ${req.session.token}`;
    }

    let payload;
    if (body !== undefined && body !== null) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${API_URL}${path}`, { method, headers, body: payload });
    } catch (err) {
        // Transport-level failure (DNS, timeout, refused). Surface as a
        // structured error so controllers can show a friendly message
        // instead of crashing.
        return { status: 0, body: null, networkError: err && err.message };
    }

    let parsed = null;
    try {
        parsed = await response.json();
    } catch {
        // Not JSON — leave parsed as null. The controller treats that as a
        // server problem (it's a contract violation by the api).
    }
    return { status: response.status, body: parsed };
}

/**
 * fetchBrand
 *
 * What:   One-shot fetch of GET /api/v1/brand. Used at boot AND on every
 *         request (lightweight; api caches at the JSON level).
 * Why:    Single source of truth for the brand identity — web layout reads
 *         this object and passes it into every EJS view as res.locals.brand.
 *         Means changing config/brand.js OR the BRAND_* env vars on the api
 *         side reflects on every page after the next request, with no
 *         redeploy on the web side.
 * Type:   READ.
 * Inputs: none.
 * Output: brand object on success, or a small fallback object on failure
 *         (so the web doesn't crash if the api is briefly down).
 * Used:   web/index.js — middleware that runs on every request, AND once
 *         at boot to populate the initial fallback.
 */
async function fetchBrand() {
    const headers = { Accept: 'application/json' };
    try {
        const response = await fetch(`${API_URL}/api/v1/brand`, { method: 'GET', headers });
        if (!response.ok) throw new Error(`brand http ${response.status}`);
        const body = await response.json();
        if (body && body.status === 200 && body.data) {
            return body.data;
        }
        throw new Error('brand envelope missing data');
    } catch (err) {
        // Fallback used only when GET /api/v1/brand is unreachable.
        // Keeps the page rendering (with sensible defaults) instead of
        // crashing the EJS render. No colour fields here — colours live
        // in /css/base.css and don't need a runtime fallback.
        return {
            name:           process.env.BRAND_NAME      || 'EatNDeal',
            tagline:        process.env.BRAND_TAGLINE   || 'Delicious food delivered',
            logoUrl:        '/brand/logo.png',
            faviconUrl:     '/brand/favicon.png',
            supportEmail:   '',
            supportPhone:   '',
            websiteUrl:     '',
            privacyUrl:     '',
            termsUrl:       '',
            copyright:      process.env.BRAND_COPYRIGHT || '© EatNDeal. All rights reserved.',
            currency:       'GBP',
            currencySymbol: '£',
            locale:         'en-GB',
            timezone:       'Europe/London',
            _fallback:      true,
            _error:         err && err.message,
        };
    }
}

module.exports = { callApi, fetchBrand, API_URL };
