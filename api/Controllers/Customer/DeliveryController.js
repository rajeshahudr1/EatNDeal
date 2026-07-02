'use strict';

/**
 * Controllers/Customer/DeliveryController.js
 *
 * What:   Public delivery / location endpoints — the same flow the legacy
 *         Yii2 webordering/controllers/DeliveryController.php exposes,
 *         ported to Node and bound under /api/v1/delivery/*:
 *
 *           POST /search-address    — UK postcode autocomplete
 *           POST /retrieve-address  — full address from a picked UDPRN
 *           POST /postcode-coords   — centroid lat/lng for a postcode
 *
 * Why:    The web location modal calls these three endpoints. They are
 *         PUBLIC (no auth) because picking a delivery area is the first
 *         thing a guest visitor does before the menu can be shown. Joi
 *         validators (see Validators/delivery.js) gate the input;
 *         Helpers/idealPostcodes.js owns the upstream call.
 * Type:   READ (network calls to Ideal Postcodes, no DB writes).
 * Inputs: req.body — see each function's docstring.
 * Output: standard EatNDeal envelope { status, show, msg, data }.
 * Used:   Wired in api/Routes/index.js under /delivery/*.
 *
 * Change log:
 *   2026-05-25 — initial port from Yii2 DeliveryController.
 */

const H        = require('../../Helpers/helper');
const MSG      = require('../../Helpers/messages');
// Provider-agnostic facade — dispatches to postcodes.io / Ideal Postcodes
// / whichever future provider based on the LOCATION_PROVIDER env var.
// See api/Helpers/locationProvider.js for the registry.
const location = require('../../Helpers/locationProvider');

/**
 * searchAddress
 *
 * What:   Returns a list of address-suggestion records that match the
 *         user's typed query. Powers the autocomplete dropdown in the
 *         web location modal.
 * Why:    First step of the two-step picker. Min 3 chars is a hard rule
 *         from Ideal Postcodes — enforced by the Joi schema too.
 * Type:   READ.
 * Inputs: req.body.query (string, 3..100 chars after trim)
 * Output: 200 { ..., data: { suggestions: [...] } }
 *         422 / 500 envelope on validation / transport failure.
 * Used:   POST /api/v1/delivery/search-address.
 */
async function searchAddress(req, res) {
    try {
        const { suggestions } = await location.searchAddresses(req.body.query);
        return H.successResponse(res, { suggestions });
    } catch (err) {
        H.log.warn('delivery.searchAddress', err && err.message);
        return H.errorResponse(res, friendly(err), 502);
    }
}

/**
 * retrieveAddress
 *
 * What:   Resolves a suggestion id (UDPRN) to the full address record so
 *         the client can save line_1 / line_2 / postcode / lat / lng to
 *         the session.
 * Why:    Second step of the picker. Always called immediately after a
 *         user taps a result from /search-address.
 * Type:   READ.
 * Inputs: req.body.id (string|number)
 * Output: 200 { ..., data: { address: {...} } }
 *         422 / 502 on failure.
 * Used:   POST /api/v1/delivery/retrieve-address.
 */
async function retrieveAddress(req, res) {
    try {
        const { address } = await location.retrieveAddress(req.body.id);
        return H.successResponse(res, { address });
    } catch (err) {
        H.log.warn('delivery.retrieveAddress', err && err.message);
        return H.errorResponse(res, friendly(err), 502);
    }
}

/**
 * postcodeCoords
 *
 * What:   Looks up the centroid latitude / longitude for a UK postcode.
 * Why:    Postcode-only flows (e.g. user typed "SW1A 1AA" without picking
 *         a suggestion) still need coordinates so we can match
 *         restaurants by distance later. Mirrors the legacy
 *         getCoordinatesFromPostcode helper.
 * Type:   READ.
 * Inputs: req.body.postcode (string, 2..12 chars).
 * Output: 200 { ..., data: { latitude, longitude } }
 *         422 / 502 on failure.
 * Used:   POST /api/v1/delivery/postcode-coords.
 */
async function postcodeCoords(req, res) {
    try {
        const coords = await location.coordsForPostcode(req.body.postcode);
        return H.successResponse(res, coords);
    } catch (err) {
        H.log.warn('delivery.postcodeCoords', err && err.message);
        return H.errorResponse(res, friendly(err), 502);
    }
}

/**
 * friendly (private)
 *
 * What:   Maps an upstream error message to a user-facing string. We do
 *         NOT pass raw upstream error text through to the client (it can
 *         leak the key, internal hostnames, etc.) — instead we keep a
 *         short whitelist of safe messages and fall back to MSG.server.oops.
 * Why:    Defensive — single place to control what we surface.
 * Type:   READ.
 */
function friendly(err) {
    const raw = (err && err.message) || '';
    // The helper module throws messages we wrote ourselves; those are
    // already user-safe. Pass them through. Anything else (e.g. an
    // unexpected throw) falls back to the generic oops.
    if (/timed out|reach the address service|non-JSON|not be located|details were not returned|not configured|not supported/i.test(raw)) {
        return raw;
    }
    return MSG.server.oops;
}

/**
 * reverseGeocode
 *
 * What:   Resolves geolocation coordinates to the nearest address + a concise
 *         label, so "use my current location" shows the real area name.
 * Type:   READ.
 * Inputs: req.body.lat, req.body.lng (numbers).
 * Output: 200 { ..., data: { address, label, formatted } }
 *         502 on failure.
 * Used:   POST /api/v1/delivery/reverse-geocode.
 */
async function reverseGeocode(req, res) {
    try {
        const result = await location.reverseGeocode(req.body.lat, req.body.lng);
        // Served-country gate: ALLOWED_COUNTRIES is a comma list (e.g. "gb,in").
        // Blank/unset = deliver everywhere. We tell the client whether the
        // detected country is one we serve so it can block "use my location"
        // outside our area with a clear message instead of silently proceeding.
        const allowedList = String(process.env.ALLOWED_COUNTRIES || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
        const cc = String(result.country_code || '').toLowerCase();
        const allowed = allowedList.length === 0 || (!!cc && allowedList.indexOf(cc) !== -1);
        return H.successResponse(res, Object.assign({}, result, { allowed }));
    } catch (err) {
        H.log.warn('delivery.reverseGeocode', err && err.message);
        return H.errorResponse(res, friendly(err), 502);
    }
}

module.exports = { searchAddress, retrieveAddress, postcodeCoords, reverseGeocode };
