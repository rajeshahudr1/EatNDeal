'use strict';

/**
 * Helpers/apiClient.js
 *
 * What:   Thin wrapper around Node's built-in fetch() that every admin
 *         controller uses to talk to the api/ layer. The admin NEVER touches
 *         the database directly — every read or write goes through this.
 * Why:    Centralises auth-header forwarding, base-URL construction, and
 *         JSON parsing so each controller stays one-liner short.
 *         Project rule: admin -> api -> db. Never admin -> db.
 * Type:   READ + WRITE (depends on the endpoint being called).
 * Inputs: req (Express request — used to read session token), method, path,
 *         body (optional).
 * Output: { status, body, networkError? }
 * Used:   Every Controllers/*.js file. Plus once at boot from index.js to
 *         pre-fetch /brand for the layout.
 *
 * Change log:
 *   2026-06-09 — initial (mirror of web/Helpers/apiClient.js).
 */

const API_URL = String(process.env.API_URL || 'http://localhost:4501').replace(/\/$/, '');

/**
 * callApi
 *
 * What:   Sends an HTTP request to the api/ layer, forwarding the session
 *         JWT as a Bearer token when present.
 * Inputs: req (Express req) — used to read req.session.token
 *         method (string)   — GET / POST / PATCH / DELETE
 *         path (string)     — must start with "/api/v1/..."
 *         body (object|null)— request body; serialised as JSON
 * Output: { status, body, networkError? }
 */
async function callApi(req, method, path, body) {
    const headers = { Accept: 'application/json' };

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
        return { status: 0, body: null, networkError: err && err.message };
    }

    let parsed = null;
    try {
        parsed = await response.json();
    } catch {
        // Not JSON — leave parsed as null; the controller treats that as a
        // server problem (a contract violation by the api).
    }
    return { status: response.status, body: parsed };
}

/**
 * fetchBrand
 *
 * What:   One-shot fetch of GET /api/v1/brand. Used at boot AND on every
 *         request (lightweight; api caches at the JSON level).
 * Output: brand object on success, or a small fallback object on failure
 *         so the admin shell still renders if the api is briefly down.
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
        return {
            name:           process.env.BRAND_NAME    || 'EatNDeal',
            tagline:        process.env.BRAND_TAGLINE || 'Admin Console',
            logoUrl:        '/brand/logo.png',
            faviconUrl:     '/brand/favicon.png',
            supportEmail:   '',
            supportPhone:   '',
            websiteUrl:     '',
            copyright:      process.env.BRAND_COPYRIGHT || '© EatNDeal. All rights reserved.',
            currency:       'GBP',
            currencySymbol: '£',
            locale:         'en-GB',
            timezone:       'Europe/London',
            primaryColor:   '#E5252A',
            _fallback:      true,
            _error:         err && err.message,
        };
    }
}

module.exports = { callApi, fetchBrand, API_URL };
