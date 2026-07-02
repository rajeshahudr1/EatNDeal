'use strict';

/*
 * Helpers/googleMaps.js — Google Maps location provider.
 *
 * Implements the locationProvider contract (searchAddresses, retrieveAddress,
 * coordsForPostcode) using Google's web-service APIs:
 *   • Places Autocomplete  → address suggestions (UK-restricted)
 *   • Place Details        → resolve a suggestion → full address + lat/lng
 *   • Geocoding            → postcode → lat/lng
 *
 * Requires GOOGLE_MAPS_API_KEY (server key with Places + Geocoding enabled).
 * Activate with LOCATION_PROVIDER=google. Same output shapes as nominatim.js
 * so the controller + frontend need no change.
 */

const KEY     = process.env.GOOGLE_MAPS_API_KEY || '';
const BASE    = (process.env.GOOGLE_MAPS_BASE_URL || 'https://maps.googleapis.com/maps/api').replace(/\/$/, '');
// Comma-separated ISO country codes to restrict address lookups to (e.g.
// "gb,in"). EMPTY / "all" / "*" = worldwide (no filter — every country shows).
// Line absent entirely = UK default. Google accepts up to 5 via "country:gb|country:in".
const _rawCountry = process.env.GOOGLE_MAPS_COUNTRY;
const COUNTRIES = (_rawCountry === undefined)
    ? ['gb']
    : (/^\s*(all|\*|any)?\s*$/i.test(_rawCountry)
        ? []
        : String(_rawCountry).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
const COMPONENTS = COUNTRIES.map((c) => 'country:' + c).join('|');   // "" = worldwide
const TIMEOUT = Number(process.env.GOOGLE_MAPS_TIMEOUT_MS) || 8000;

function ensureKey() {
    if (!KEY) { throw new Error('Google Maps is not configured (GOOGLE_MAPS_API_KEY missing).'); }
}

async function httpGetJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
        const res  = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) { throw new Error('Google Maps request failed.'); }
        // Google reports the real status in the BODY (HTTP is 200 even on errors).
        if (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
            throw new Error(json.error_message || ('Google Maps error: ' + json.status));
        }
        return json;
    } finally { clearTimeout(timer); }
}

function htmlEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function highlightQuery(text, q) {
    const safe = htmlEscape(text);
    const term = String(q || '').trim();
    if (!term) { return safe; }
    try {
        const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
        return safe.replace(re, '<mark>$1</mark>');
    } catch (e) { return safe; }
}

// Google Place Details address_components → our canonical address shape
// (identical keys to nominatim.js mapToOurAddress).
function mapComponents(components, geometry) {
    const get = (type) => {
        const c = (components || []).find((x) => (x.types || []).indexOf(type) !== -1);
        return c ? c.long_name : '';
    };
    const streetNo = get('street_number');
    const route    = get('route');
    const line1    = (streetNo && route) ? `${streetNo} ${route}`
        : (route || get('premise') || get('establishment') || get('point_of_interest') || '');
    const loc = (geometry && geometry.location) || {};
    return {
        udprn:           '',
        line_1:          line1,
        line_2:          get('neighborhood') || get('sublocality') || '',
        line_3:          '',
        post_town:       get('postal_town') || get('locality') || get('administrative_area_level_2') || '',
        postcode:        get('postal_code') || '',
        county:          get('administrative_area_level_2') || get('administrative_area_level_1') || '',
        country:         get('country') || 'United Kingdom',
        latitude:        loc.lat != null ? Number(loc.lat) : null,
        longitude:       loc.lng != null ? Number(loc.lng) : null,
        building_number: streetNo || '',
        building_name:   get('premise') || '',
        thoroughfare:    route || '',
    };
}

/**
 * searchAddresses — Google Places Autocomplete (UK-restricted).
 * Output: { suggestions: [{ id: place_id, address: label, highlight }] }.
 */
async function searchAddresses(query) {
    const q = String(query || '').trim();
    if (!q) { return { suggestions: [] }; }
    ensureKey();
    const params = new URLSearchParams({ input: q, key: KEY, types: 'geocode' });
    if (COMPONENTS) { params.set('components', COMPONENTS); }   // UK/India/… filter, if configured
    const data = await httpGetJson(`${BASE}/place/autocomplete/json?${params.toString()}`);
    const preds = Array.isArray(data.predictions) ? data.predictions : [];
    const suggestions = preds.map((p) => {
        const label = p.description || '';
        return { id: p.place_id, address: label, highlight: highlightQuery(label, q) };
    });
    return { suggestions };
}

/**
 * retrieveAddress — Google Place Details for a suggestion's place_id.
 * Output: { address: {...} } (canonical shape, with lat/lng).
 */
async function retrieveAddress(id) {
    const placeId = String(id || '').trim();
    if (!placeId) { throw new Error('Address details were not returned.'); }
    ensureKey();
    const params = new URLSearchParams({
        place_id: placeId,
        key:      KEY,
        fields:   'address_component,geometry,formatted_address',
    });
    const data = await httpGetJson(`${BASE}/place/details/json?${params.toString()}`);
    const r = data.result;
    if (!r) { throw new Error('Address details were not returned.'); }
    const address = mapComponents(r.address_components, r.geometry);
    // Towns/villages (and many non-street picks) carry no postcode in Place
    // Details — recover one by reverse-geocoding the point so the postcode
    // field still auto-fills wherever this is used.
    if (!address.postcode && address.latitude != null && address.longitude != null) {
        try {
            const rev = await reverseGeocode(address.latitude, address.longitude);
            if (rev && rev.address && rev.address.postcode) { address.postcode = rev.address.postcode; }
        } catch (e) { /* no postcode available — leave it empty */ }
    }
    return { address };
}

/**
 * coordsForPostcode — Google Geocoding for a postcode centroid.
 * Output: { latitude, longitude }.
 */
async function coordsForPostcode(postcode) {
    const safe = String(postcode || '').toUpperCase().trim();
    if (!safe) { throw new Error('Postcode is required.'); }
    ensureKey();
    const params = new URLSearchParams({ address: safe, key: KEY });
    if (COMPONENTS) { params.set('components', COMPONENTS); }   // UK/India/… filter, if configured
    const data = await httpGetJson(`${BASE}/geocode/json?${params.toString()}`);
    const first = Array.isArray(data.results) && data.results[0];
    const loc   = first && first.geometry && first.geometry.location;
    if (!loc || loc.lat == null || loc.lng == null) {
        throw new Error('That postcode could not be located.');
    }
    return { latitude: Number(loc.lat), longitude: Number(loc.lng) };
}

/**
 * reverseGeocode — Google Geocoding for coordinates → nearest address.
 * Used for "use my current location" so we show the real area name instead
 * of a generic label. Output: { address: {...}, label, formatted }.
 */
async function reverseGeocode(lat, lng) {
    const la = Number(lat), ln = Number(lng);
    if (!isFinite(la) || !isFinite(ln)) { throw new Error('Your location could not be located.'); }
    ensureKey();
    const params = new URLSearchParams({ latlng: la + ',' + ln, key: KEY });
    const data   = await httpGetJson(`${BASE}/geocode/json?${params.toString()}`);
    const first  = Array.isArray(data.results) && data.results[0];
    if (!first) { throw new Error('Your location could not be located.'); }
    const address   = mapComponents(first.address_components, first.geometry);
    const formatted = first.formatted_address || '';
    const label     = address.line_1 || address.line_2 || address.post_town || formatted.split(',')[0] || 'Current location';
    // ISO country code (short_name, e.g. "GB"/"IN") for the served-country gate.
    const ccComp      = (first.address_components || []).find((x) => (x.types || []).indexOf('country') !== -1);
    const countryCode = ccComp ? (ccComp.short_name || '') : '';
    return { address, label, formatted, country_code: countryCode };
}

module.exports = { searchAddresses, retrieveAddress, coordsForPostcode, reverseGeocode };
