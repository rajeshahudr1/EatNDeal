'use strict';

/**
 * Helpers/locationProvider.js
 *
 * What:   Single facade in front of every postcode / address provider we
 *         support. The DeliveryController never imports a specific
 *         provider — it imports this facade, which dispatches to the
 *         implementation chosen by the LOCATION_PROVIDER env var.
 *
 * Why:    Operators flip providers without touching code. Examples:
 *           • LOCATION_PROVIDER=postcodes_io    (default — free, no key)
 *           • LOCATION_PROVIDER=ideal_postcodes (paid — needs key +
 *             a domain on the Ideal Postcodes whitelist)
 *
 *         Adding a new provider in future means: drop a new helper
 *         alongside the existing ones, exporting the three functions
 *         (searchAddresses, retrieveAddress, coordsForPostcode), and
 *         add one entry to PROVIDERS below. Controller code does not
 *         change.
 *
 * Type:   READ (no DB).
 * Inputs: process.env.LOCATION_PROVIDER — id of the provider to use.
 * Output: { searchAddresses, retrieveAddress, coordsForPostcode } —
 *         every function delegates to the active provider.
 * Used:   api/Controllers/Customer/DeliveryController.js.
 *
 * Change log:
 *   2026-05-25 — initial. Ships two providers: postcodes_io (default)
 *                and ideal_postcodes.
 */

const H = require('./helper');

// Provider registry — id → module. Add a new line here to wire up a
// new implementation.
const PROVIDERS = {
    nominatim:       require('./nominatim'),
    postcodes_io:    require('./postcodesIo'),
    ideal_postcodes: require('./idealPostcodes'),
};

// Default to nominatim because:
//   • free, no API key, no domain whitelist (works on localhost)
//   • accepts city names ("London"), street addresses AND postcodes —
//     postcodes_io is postcode-only and returned nothing when users
//     typed a city, which was confusing.
//   • restricted to the UK via countrycodes=gb (see nominatim.js).
// Operators should swap to ideal_postcodes (paid, whitelisted) for
// production-grade street autocomplete + higher rate limits, OR self-
// host Nominatim and override NOMINATIM_BASE_URL.
const DEFAULT_PROVIDER = 'nominatim';

/**
 * resolveProvider (private)
 *
 * What:  Picks the provider module based on env. Falls back to the
 *        default + logs a warning when LOCATION_PROVIDER points at an
 *        unknown id (typo in .env etc.).
 * Why:   We want loud-but-safe behaviour — a typo shouldn't crash the
 *        api at boot, but ops needs to see the misconfiguration in logs.
 * Type:  READ.
 * Inputs: none.
 * Output: { id, impl } — the selected provider's id + its module.
 * Used:   Internally on every call (cheap — just a Map lookup).
 */
function resolveProvider() {
    const requested = String(process.env.LOCATION_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
    const impl      = PROVIDERS[requested];

    if (impl) {
        return { id: requested, impl };
    }

    H.log.warn('locationProvider',
        `Unknown LOCATION_PROVIDER="${requested}". Falling back to "${DEFAULT_PROVIDER}". ` +
        `Valid options: ${Object.keys(PROVIDERS).join(', ')}.`);
    return { id: DEFAULT_PROVIDER, impl: PROVIDERS[DEFAULT_PROVIDER] };
}

// ───────────────────────────────────────────────────────────────────
// Public facade — same contract as each provider
// ───────────────────────────────────────────────────────────────────

/**
 * searchAddresses
 *
 * What:   Delegates to the active provider's searchAddresses.
 * Why:    Lets the controller stay provider-agnostic. The returned
 *         shape is identical regardless of which backend served it.
 * Type:   READ.
 * Inputs: query (string).
 * Output: { suggestions: [...] }.
 * Used:   DeliveryController.searchAddress.
 */
function searchAddresses(query) {
    return resolveProvider().impl.searchAddresses(query);
}

/**
 * retrieveAddress
 *
 * What:   Delegates to the active provider's retrieveAddress.
 * Type:   READ.
 * Inputs: id (string|number) — opaque suggestion id from the same provider.
 * Output: { address: {...} }.
 * Used:   DeliveryController.retrieveAddress.
 */
function retrieveAddress(id) {
    return resolveProvider().impl.retrieveAddress(id);
}

/**
 * coordsForPostcode
 *
 * What:   Delegates to the active provider's coordsForPostcode.
 * Type:   READ.
 * Inputs: postcode (string).
 * Output: { latitude, longitude }.
 * Used:   DeliveryController.postcodeCoords.
 */
function coordsForPostcode(postcode) {
    return resolveProvider().impl.coordsForPostcode(postcode);
}

/**
 * activeProviderId
 *
 * What:   Returns the id of the currently selected provider as a plain
 *         string. Useful for health-check endpoints and boot logs.
 * Type:   READ.
 * Inputs: none.
 * Output: string ('postcodes_io', 'ideal_postcodes', ...).
 * Used:   api/index.js boot banner.
 */
function activeProviderId() {
    return resolveProvider().id;
}

module.exports = {
    searchAddresses,
    retrieveAddress,
    coordsForPostcode,
    activeProviderId,
};
