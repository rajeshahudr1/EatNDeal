'use strict';

/**
 * Helpers/idealPostcodes.js
 *
 * What:   Thin wrapper around api.ideal-postcodes.co.uk — the third-party
 *         UK postcode autocomplete service the existing Yii2 system already
 *         uses. Exposes three operations:
 *           • searchAddresses(query)     → autocomplete suggestions
 *           • retrieveAddress(id)        → full address for a picked UDPRN
 *           • coordsForPostcode(postcode)→ lat/lng for a known postcode
 * Why:    Centralises HTTP + error handling for the upstream API so the
 *         delivery controller stays readable. Same key + same endpoints as
 *         the legacy webordering/controllers/DeliveryController.php so
 *         behaviour matches the live UK platform.
 * Type:   READ (network calls, no DB writes).
 * Inputs: process.env.IDEAL_POSTCODES_API_KEY  (required)
 *         process.env.IDEAL_POSTCODES_BASE_URL (default v1 endpoint)
 *         process.env.IDEAL_POSTCODES_TIMEOUT_MS (default 8000)
 * Output: Each function resolves with a typed object on success and
 *         throws Error('<reason>') on failure. The controller catches
 *         and translates into the standard envelope.
 * Used:   api/Controllers/Customer/DeliveryController.js.
 *
 * Change log:
 *   2026-05-25 — initial port from the Yii2 implementation.
 */

const API_KEY = String(process.env.IDEAL_POSTCODES_API_KEY  || '').trim();
const BASE    = String(process.env.IDEAL_POSTCODES_BASE_URL || 'https://api.ideal-postcodes.co.uk/v1').replace(/\/$/, '');
const TIMEOUT = Math.max(1000, parseInt(process.env.IDEAL_POSTCODES_TIMEOUT_MS, 10) || 8000);

/**
 * httpGetJson (private)
 *
 * What:   Performs an HTTPS GET against the Ideal Postcodes API with a
 *         hard timeout and returns the parsed JSON body.
 * Why:    Browser-native fetch in Node 20 already supports AbortController;
 *         this wrapper just adds the timeout + JSON parse + error mapping.
 * Type:   READ.
 * Inputs: url (string) — fully-formed URL.
 * Output: parsed JSON object.
 * Used:   Inside this module only.
 */
async function httpGetJson(url) {
    if (!API_KEY) {
        // Fail loudly — the operator forgot to set the env. The endpoint
        // returns the standard 500 envelope when the controller catches.
        throw new Error('IDEAL_POSTCODES_API_KEY is not configured.');
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT);

    let response;
    try {
        response = await fetch(url, {
            method:  'GET',
            headers: {
                'Accept':     'application/json',
                'User-Agent': 'EatNDeal-API/0.1',
            },
            signal: controller.signal,
        });
    } catch (err) {
        // Most common case: AbortError when we hit the timeout, or a
        // network failure (DNS / connection refused / off-line).
        if (err && err.name === 'AbortError') {
            throw new Error('Address service timed out. Please try again.');
        }
        throw new Error('Could not reach the address service.');
    } finally {
        clearTimeout(timer);
    }

    if (response.status < 200 || response.status >= 300) {
        // Ideal Postcodes returns 404 for unknown postcodes, 402 when the
        // key is exhausted, 429 when rate-limited. We surface a generic
        // message; ops can read the api log for the raw body.
        const body = await safeReadText(response);
        throw new Error(`Address service returned HTTP ${response.status}.${body ? ' ' + truncate(body, 200) : ''}`);
    }

    try {
        return await response.json();
    } catch {
        throw new Error('Address service returned a non-JSON response.');
    }
}

/**
 * safeReadText (private)
 * What:  Reads the response body as text, returning '' on any failure.
 *        Used purely for richer error-log messages.
 * Type:  READ.
 */
async function safeReadText(response) {
    try { return await response.text(); } catch { return ''; }
}

/**
 * truncate (private)
 * What:  Caps a string at n characters with an ellipsis. Keeps log lines tidy.
 * Type:  READ.
 */
function truncate(str, n) {
    if (typeof str !== 'string') return '';
    if (str.length <= n) return str;
    return str.slice(0, n) + '…';
}

/**
 * highlightQuery (private)
 *
 * What:   Wraps every occurrence of `query` in <strong>…</strong> within
 *         the given suggestion text. HTML-escapes the surrounding text
 *         first so user input cannot bleed XSS into the response.
 * Why:    The legacy Yii2 controller did exactly this so the web UI could
 *         bold the matched fragment in the autocomplete dropdown. We
 *         mirror that contract; the client side renders with textContent
 *         (safe) and ignores the <strong> tags, but keeping them in the
 *         payload preserves future UI options.
 * Type:   READ (pure function).
 * Inputs: text (string), query (string).
 * Output: escaped string with <strong>…</strong> around case-insensitive
 *         occurrences of query.
 * Used:   searchAddresses below.
 */
function highlightQuery(text, query) {
    const safeText  = htmlEscape(String(text || ''));
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return safeText;
    // Escape regex specials in the query so user input cannot craft a
    // malformed pattern.
    const re = new RegExp(safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safeText.replace(re, function (match) { return '<strong>' + match + '</strong>'; });
}

/**
 * htmlEscape (private)
 * What:  Escapes the five XML entities so user-supplied address text
 *        cannot inject HTML / JS into our response.
 * Type:  READ (pure function).
 */
function htmlEscape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ───────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────

/**
 * searchAddresses
 *
 * What:   Calls /v1/autocomplete/addresses?api_key=...&q=... and shapes the
 *         response into our `suggestions` array.
 * Why:    First step of the two-step UK address picker — Ideal Postcodes
 *         returns lightweight suggestion records (suggestion string + UDPRN).
 * Type:   READ.
 * Inputs: query (string) — must be 3+ chars; caller validates.
 * Output: { suggestions: [ { id, address, highlight }, ... ] }
 * Used:   POST /api/v1/delivery/search-address (DeliveryController.searchAddress).
 */
async function searchAddresses(query) {
    const q   = String(query || '').trim();
    const url = `${BASE}/autocomplete/addresses?api_key=${encodeURIComponent(API_KEY)}&q=${encodeURIComponent(q)}`;
    const data = await httpGetJson(url);

    const hits = (data && data.result && Array.isArray(data.result.hits)) ? data.result.hits : [];
    const suggestions = hits.map(function (hit) {
        const suggestion = hit.suggestion || hit.address || '';
        return {
            id:        hit.udprn || hit.id || '',
            address:   suggestion,
            highlight: highlightQuery(suggestion, q),
        };
    });

    return { suggestions };
}

/**
 * retrieveAddress
 *
 * What:   Calls /v1/addresses/{id} when the id is purely numeric (a UDPRN)
 *         OR /v1/autocomplete/addresses/udprn/{id} otherwise — the exact
 *         pattern the Yii2 controller followed. Returns a normalised
 *         address object.
 * Why:    Second step of the picker — converts a suggestion id into a
 *         full delivery-ready address with coordinates.
 * Type:   READ.
 * Inputs: id (string|number) — the suggestion id from searchAddresses.
 * Output: { address: { udprn, line_1, line_2, line_3, post_town, postcode,
 *                      county, country, latitude, longitude,
 *                      building_number, building_name, thoroughfare } }
 * Used:   POST /api/v1/delivery/retrieve-address (DeliveryController.retrieveAddress).
 */
async function retrieveAddress(id) {
    const safeId = String(id || '').trim();
    if (!safeId) {
        throw new Error('Address ID is required.');
    }

    const isNumeric = /^\d+$/.test(safeId);
    const url = isNumeric
        ? `${BASE}/addresses/${encodeURIComponent(safeId)}?api_key=${encodeURIComponent(API_KEY)}`
        : `${BASE}/autocomplete/addresses/udprn/${encodeURIComponent(safeId)}?api_key=${encodeURIComponent(API_KEY)}`;

    const data = await httpGetJson(url);
    const r    = data && data.result;
    if (!r) {
        throw new Error('Address details were not returned.');
    }

    return {
        address: {
            udprn:           r.udprn || safeId,
            line_1:          r.line_1          || r.address_line_1 || '',
            line_2:          r.line_2          || r.address_line_2 || '',
            line_3:          r.line_3          || '',
            post_town:       r.post_town       || r.town_or_city   || '',
            postcode:        r.postcode        || '',
            county:          r.county          || '',
            country:         r.country         || 'England',
            latitude:        r.latitude        != null ? Number(r.latitude)  : null,
            longitude:       r.longitude       != null ? Number(r.longitude) : null,
            building_number: r.building_number || '',
            building_name:   r.building_name   || '',
            thoroughfare:    r.thoroughfare    || '',
        },
    };
}

/**
 * coordsForPostcode
 *
 * What:   Calls /v1/postcodes/{POSTCODE} to get the centroid lat/lng of a
 *         UK postcode.
 * Why:    Browser geolocation gives us lat/lng directly but free-text
 *         postcode entry needs a lookup before delivery-zone matching
 *         can happen. Mirrors getCoordinatesFromPostcode in the Yii2
 *         controller.
 * Type:   READ.
 * Inputs: postcode (string) — case-insensitive; we uppercase + trim.
 * Output: { latitude, longitude } — or throws if the postcode is unknown.
 * Used:   POST /api/v1/delivery/postcode-coords.
 */
async function coordsForPostcode(postcode) {
    const safe = String(postcode || '').toUpperCase().trim();
    if (!safe) {
        throw new Error('Postcode is required.');
    }
    const url  = `${BASE}/postcodes/${encodeURIComponent(safe)}?api_key=${encodeURIComponent(API_KEY)}`;
    const data = await httpGetJson(url);

    const first = data && Array.isArray(data.result) && data.result[0];
    if (!first || first.latitude == null || first.longitude == null) {
        throw new Error('That postcode could not be located.');
    }
    return {
        latitude:  Number(first.latitude),
        longitude: Number(first.longitude),
    };
}

module.exports = { searchAddresses, retrieveAddress, coordsForPostcode };
