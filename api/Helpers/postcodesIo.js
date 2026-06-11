'use strict';

/**
 * Helpers/postcodesIo.js
 *
 * What:   Free UK postcode provider — postcodes.io. No API key, no domain
 *         whitelist, no per-request cost. Mirrors the same three-function
 *         interface as Helpers/idealPostcodes.js so it can be plugged in
 *         behind locationProvider.js:
 *           • searchAddresses(query)     → autocomplete suggestions
 *           • retrieveAddress(id)        → full postcode info
 *           • coordsForPostcode(postcode)→ centroid lat/lng
 *
 * Why:    Ideal Postcodes is paid + whitelisted by domain — the dev key
 *         shipped with the Yii2 system 401s when called from any host the
 *         account hasn't approved. postcodes.io is the standard free
 *         alternative for UK postcode lookups; same data quality (it
 *         republishes ONS open data) and ample rate budget for dev /
 *         small production traffic.
 *
 *         Limitation vs Ideal Postcodes: postcodes.io is POSTCODE-only.
 *         "London" (a city name) returns no suggestions. The location
 *         modal already covers that case with the "Popular cities"
 *         chips, so the limitation is acceptable for the marketplace.
 *
 * Type:   READ (network calls, no DB writes).
 * Inputs: process.env.POSTCODES_IO_BASE_URL  (default https://api.postcodes.io)
 *         process.env.POSTCODES_IO_TIMEOUT_MS (default 6000)
 * Output: each function resolves with a typed object or throws
 *         Error('<reason>') with a user-safe message.
 * Used:   api/Helpers/locationProvider.js (selected when LOCATION_PROVIDER=postcodes_io).
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const F = require('./format');

const BASE    = String(process.env.POSTCODES_IO_BASE_URL  || 'https://api.postcodes.io').replace(/\/$/, '');
const TIMEOUT = Math.max(1000, parseInt(process.env.POSTCODES_IO_TIMEOUT_MS, 10) || 6000);

// ───────────────────────────────────────────────────────────────────
// Private helpers
// ───────────────────────────────────────────────────────────────────

/**
 * httpGetJson (private)
 * What:  HTTPS GET with an AbortController timeout + JSON parse.
 *        Returns the parsed body even on non-2xx responses for callers
 *        that want to read the API's status field (postcodes.io uses
 *        body.status in addition to HTTP status, e.g. 200/404).
 * Why:   Single place to centralise the timeout + parse logic.
 * Type:  READ.
 * Inputs: url (string).
 * Output: { httpStatus, body | null }.
 */
async function httpGetJson(url) {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT);

    let response;
    try {
        response = await fetch(url, {
            method:  'GET',
            headers: {
                'Accept':     'application/json',
                'User-Agent': 'EatNDeal-API/0.1 (+postcodes.io)',
            },
            signal: controller.signal,
        });
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error('Address service timed out. Please try again.');
        }
        throw new Error('Could not reach the address service.');
    } finally {
        clearTimeout(timer);
    }

    let body = null;
    try { body = await response.json(); } catch { /* leave null */ }
    return { httpStatus: response.status, body };
}

/**
 * htmlEscape (private)
 * What:  Escapes the five XML entities so user-supplied text can't inject
 *        HTML / JS into the response. Used by the suggestion highlighter.
 * Type:  READ (pure function).
 */
function htmlEscape(str) {
    return F.escapeHtml(str);
}

/**
 * highlightQuery (private)
 * What:  Wraps the user's query inside <strong>…</strong> within a
 *        suggestion string, after HTML-escaping. Mirrors the Yii2
 *        controller's behaviour so the UI can later bold the matched
 *        fragment.
 * Type:  READ (pure function).
 */
function highlightQuery(text, query) {
    const safeText  = htmlEscape(String(text || ''));
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return safeText;
    const re = new RegExp(safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safeText.replace(re, function (match) { return '<strong>' + match + '</strong>'; });
}

/**
 * normalisePostcode (private)
 * What:  Strips internal whitespace + uppercases. postcodes.io accepts
 *        either spaced or unspaced postcodes; we normalise to unspaced
 *        for cleaner URLs and stable ids.
 * Type:  READ (pure function).
 */
function normalisePostcode(value) {
    return String(value || '').toUpperCase().replace(/\s+/g, '');
}

// ───────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────

/**
 * searchAddresses
 *
 * What:   Calls /postcodes/{prefix}/autocomplete and shapes the
 *         postcodes.io response into our suggestion array. Each
 *         suggestion's `id` is the full postcode (e.g. "SW1A1AA") —
 *         later passed to retrieveAddress.
 * Why:    Powers the location-modal autocomplete dropdown when
 *         LOCATION_PROVIDER=postcodes_io.
 * Type:   READ.
 * Inputs: query (string) — caller already validated min length 3.
 * Output: { suggestions: [{id, address, highlight}, ...] }
 * Used:   locationProvider.js.
 */
async function searchAddresses(query) {
    const prefix = normalisePostcode(query);
    if (!prefix) {
        return { suggestions: [] };
    }

    const url = `${BASE}/postcodes/${encodeURIComponent(prefix)}/autocomplete`;
    const { httpStatus, body } = await httpGetJson(url);

    if (httpStatus !== 200 || !body) {
        throw new Error(`Address service returned HTTP ${httpStatus}.`);
    }

    // postcodes.io returns body.result as either:
    //   - an array of postcode strings, OR
    //   - null (when nothing matched)
    const hits = Array.isArray(body.result) ? body.result : [];

    const suggestions = hits.map(function (postcode) {
        return {
            id:        normalisePostcode(postcode),
            address:   String(postcode),
            highlight: highlightQuery(String(postcode), query),
        };
    });

    return { suggestions };
}

/**
 * retrieveAddress
 *
 * What:   Looks up the full record for a postcode id (returned earlier
 *         by searchAddresses). Returns the same shape as the
 *         Ideal Postcodes helper so the controller doesn't have to
 *         branch.
 * Why:    Second step of the picker. The web modal stores the resolved
 *         address on the session so future restaurant searches can
 *         filter by postcode / lat-lng.
 * Type:   READ.
 * Inputs: id (string) — a postcode produced by searchAddresses; can also
 *         be a user-entered postcode with or without spaces.
 * Output: { address: { line_1, line_2, post_town, postcode, county,
 *                       country, latitude, longitude, ... } }
 * Used:   locationProvider.js.
 */
async function retrieveAddress(id) {
    const postcode = normalisePostcode(id);
    if (!postcode) {
        throw new Error('Address ID is required.');
    }

    const url = `${BASE}/postcodes/${encodeURIComponent(postcode)}`;
    const { httpStatus, body } = await httpGetJson(url);

    if (httpStatus === 404 || (body && body.status === 404)) {
        throw new Error('That postcode could not be located.');
    }
    if (httpStatus !== 200 || !body || !body.result) {
        throw new Error('Address details were not returned.');
    }

    const r = body.result;

    // postcodes.io doesn't give us a street-level address — it's a
    // postcode-level service. We populate the fields we can and leave
    // line_1 etc. empty. Front-end UI uses the postcode + admin_district
    // as the label.
    return {
        address: {
            udprn:           String(r.codes && r.codes.admin_district ? r.codes.admin_district : ''),
            line_1:          '',
            line_2:          '',
            line_3:          '',
            post_town:       r.admin_district || r.parish || '',
            postcode:        r.postcode || postcode,
            county:          r.admin_county  || r.region || '',
            country:         r.country       || 'England',
            latitude:        r.latitude  != null ? Number(r.latitude)  : null,
            longitude:       r.longitude != null ? Number(r.longitude) : null,
            building_number: '',
            building_name:   '',
            thoroughfare:    '',
        },
    };
}

/**
 * coordsForPostcode
 *
 * What:   Returns just the centroid lat / lng for a postcode (a thin
 *         wrapper over retrieveAddress, kept for parity with the
 *         Ideal Postcodes helper).
 * Type:   READ.
 * Inputs: postcode (string).
 * Output: { latitude, longitude }.
 * Used:   locationProvider.js.
 */
async function coordsForPostcode(postcode) {
    const { address } = await retrieveAddress(postcode);
    if (address.latitude == null || address.longitude == null) {
        throw new Error('That postcode could not be located.');
    }
    return { latitude: address.latitude, longitude: address.longitude };
}

module.exports = { searchAddresses, retrieveAddress, coordsForPostcode };
