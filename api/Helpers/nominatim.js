'use strict';

/**
 * Helpers/nominatim.js
 *
 * What:   Free, key-less location provider backed by OpenStreetMap's
 *         Nominatim service. Handles city names, street addresses, AND
 *         postcodes — unlike postcodes.io which is postcode-only.
 *
 * Why:    The marketplace landing search should accept any reasonable
 *         input ("London", "Manchester", "Buckingham Palace", "SW1A 1AA").
 *         Nominatim is the standard free option. We restrict results to
 *         the UK (countrycodes=gb) so the autocomplete stays focused.
 *
 *         Stateless id trick: Nominatim doesn't expose a stable
 *         "retrieve by id" lookup that returns the same address shape as
 *         a search result. Rather than carry a server-side cache, we
 *         encode the full address into the suggestion's id field
 *         (base64-url JSON). retrieveAddress decodes it. Bounded size —
 *         autocomplete returns max 10 suggestions, each id ~300 bytes.
 *
 * Type:   READ (network calls, no DB writes).
 * Inputs: process.env.NOMINATIM_BASE_URL          (default: official server)
 *         process.env.NOMINATIM_TIMEOUT_MS        (default: 8000)
 *         process.env.NOMINATIM_USER_AGENT        (default: project tag)
 *         process.env.NOMINATIM_COUNTRY_CODES     (default: 'gb')
 * Output: each function resolves with a typed object or throws
 *         Error('<user-safe message>').
 * Used:   api/Helpers/locationProvider.js (selected when LOCATION_PROVIDER=nominatim).
 *
 * Notes (operations):
 *   • The public Nominatim server is rate-limited to ~1 req/sec per IP
 *     and asks for a meaningful User-Agent. Both are honoured. For
 *     production load, point NOMINATIM_BASE_URL at a self-hosted
 *     Nominatim or a paid mirror (Maptiler, LocationIQ, etc. all have
 *     Nominatim-compatible endpoints).
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const F = require('./format');

const BASE        = String(process.env.NOMINATIM_BASE_URL    || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const TIMEOUT     = Math.max(1000, parseInt(process.env.NOMINATIM_TIMEOUT_MS, 10) || 8000);
const USER_AGENT  = String(process.env.NOMINATIM_USER_AGENT  || 'EatNDeal-API/0.1 (https://eatndeal.local; bookings@eatsndeals.co.uk)');
const COUNTRIES   = String(process.env.NOMINATIM_COUNTRY_CODES || 'gb');

const ID_PREFIX = 'nm:';

// ───────────────────────────────────────────────────────────────────
// Private helpers
// ───────────────────────────────────────────────────────────────────

/**
 * httpGetJson (private)
 * What:  HTTPS GET with AbortController timeout + JSON parse.
 *        Sets User-Agent (Nominatim usage policy requirement).
 * Why:   Single place to centralise transport + error mapping.
 * Type:  READ.
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
                'User-Agent': USER_AGENT,
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

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Address service returned HTTP ${response.status}.`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error('Address service returned a non-JSON response.');
    }
}

/**
 * htmlEscape (private)
 * What:  Escapes XML entities so user-supplied text can't inject HTML
 *        into the response (the suggestion highlighter wraps matches
 *        in <strong>, so the surrounding text must be safe).
 * Type:  READ (pure function).
 */
function htmlEscape(str) {
    return F.escapeHtml(str);
}

/**
 * highlightQuery (private)
 * What:  Wraps the user's query in <strong>…</strong> within the
 *        suggestion text (HTML-escaped). Mirrors the same shape every
 *        other provider returns.
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
 * encodeId (private)
 * What:   Encodes a small JSON object as a base64url string with a
 *         'nm:' prefix. retrieveAddress decodes it.
 * Why:    Nominatim has no stable retrieve-by-id endpoint that returns
 *         the same address shape as a search result, so we ship the
 *         full address back to the client and decode it on retrieve.
 *         Avoids any server-side cache.
 * Type:   READ (pure function).
 */
function encodeId(data) {
    const json = JSON.stringify(data);
    const b64  = Buffer.from(json, 'utf8').toString('base64url');
    return ID_PREFIX + b64;
}

/**
 * decodeId (private)
 * What:   Inverse of encodeId. Returns the decoded object, or null when
 *         the input isn't a valid Nominatim id (e.g. an Ideal Postcodes
 *         UDPRN — caller should fall back to a real lookup).
 * Type:   READ (pure function).
 */
function decodeId(id) {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
    try {
        const json = Buffer.from(id.slice(ID_PREFIX.length), 'base64url').toString('utf8');
        return JSON.parse(json);
    } catch { return null; }
}

/**
 * mapToOurAddress (private)
 * What:  Maps a Nominatim search result (the bits we kept inside the
 *        encoded id) into the canonical address shape every provider
 *        emits.
 * Type:  READ (pure function).
 */
function mapToOurAddress(item) {
    const addr = (item && item.address) || {};

    // Prefer the most specific street component Nominatim returns;
    // amenities (e.g. "Buckingham Palace") sit under different keys.
    const line1 = addr.house_number && addr.road
        ? `${addr.house_number} ${addr.road}`
        : (addr.road
            || addr.tourism
            || addr.attraction
            || addr.amenity
            || addr.building
            || '');

    const postTown = addr.city
        || addr.town
        || addr.village
        || addr.municipality
        || addr.suburb
        || addr.county
        || '';

    return {
        udprn:           '',
        line_1:          line1,
        line_2:          addr.neighbourhood || addr.suburb || '',
        line_3:          '',
        post_town:       postTown,
        postcode:        addr.postcode || '',
        county:          addr.county || addr.state_district || addr.state || '',
        country:         addr.country || 'United Kingdom',
        latitude:        item && item.lat ? Number(item.lat) : null,
        longitude:       item && item.lon ? Number(item.lon) : null,
        building_number: addr.house_number || '',
        building_name:   addr.building || addr.tourism || addr.attraction || '',
        thoroughfare:    addr.road || '',
    };
}

// ───────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────

/**
 * searchAddresses
 *
 * What:   Calls Nominatim /search with the query, restricted to the UK
 *         by default. Returns up to 10 suggestions, each carrying a
 *         self-contained encoded id (no retrieve-by-id needed).
 * Why:    Powers the location-modal autocomplete dropdown when
 *         LOCATION_PROVIDER=nominatim.
 * Type:   READ.
 * Inputs: query (string) — caller validates min length 3.
 * Output: { suggestions: [{id, address, highlight}, ...] }
 * Used:   locationProvider.js.
 */
async function searchAddresses(query) {
    const q = String(query || '').trim();
    if (!q) return { suggestions: [] };

    const params = new URLSearchParams({
        q,
        format:          'jsonv2',
        addressdetails:  '1',
        limit:           '10',
        countrycodes:    COUNTRIES,
    });

    const url = `${BASE}/search?${params.toString()}`;
    const data = await httpGetJson(url);

    if (!Array.isArray(data)) {
        return { suggestions: [] };
    }

    const suggestions = data.map(function (item) {
        // Only keep the fields we actually need on retrieve. Keeps the
        // encoded id small (each suggestion's id sits ~300 bytes).
        const slim = {
            lat:     item.lat,
            lon:     item.lon,
            address: item.address || {},
        };
        const label = item.display_name || '';

        return {
            id:        encodeId(slim),
            address:   label,
            highlight: highlightQuery(label, q),
        };
    });

    return { suggestions };
}

/**
 * retrieveAddress
 *
 * What:   Decodes the suggestion id (which carries the full address
 *         data inline) and returns the canonical address shape.
 * Why:    See encodeId — stateless retrieve without a server cache.
 * Type:   READ (no network call when the id is well-formed).
 * Inputs: id (string) — must start with 'nm:'.
 * Output: { address: {...} }
 * Used:   locationProvider.js.
 */
async function retrieveAddress(id) {
    const decoded = decodeId(id);
    if (!decoded) {
        throw new Error('Address details were not returned.');
    }
    return { address: mapToOurAddress(decoded) };
}

/**
 * coordsForPostcode
 *
 * What:   Returns the centroid lat/lng for a postcode by running a
 *         Nominatim search restricted to the postcode token. Slower
 *         than postcodes.io for this specific case but keeps the
 *         provider self-contained.
 * Type:   READ.
 * Inputs: postcode (string).
 * Output: { latitude, longitude }.
 * Used:   locationProvider.js.
 */
async function coordsForPostcode(postcode) {
    const safe = String(postcode || '').toUpperCase().trim();
    if (!safe) {
        throw new Error('Postcode is required.');
    }

    const params = new URLSearchParams({
        postalcode:     safe,
        format:         'jsonv2',
        addressdetails: '1',
        limit:          '1',
        countrycodes:   COUNTRIES,
    });
    const url  = `${BASE}/search?${params.toString()}`;
    const data = await httpGetJson(url);

    const first = Array.isArray(data) && data[0];
    if (!first || first.lat == null || first.lon == null) {
        throw new Error('That postcode could not be located.');
    }
    return {
        latitude:  Number(first.lat),
        longitude: Number(first.lon),
    };
}

module.exports = { searchAddresses, retrieveAddress, coordsForPostcode };
