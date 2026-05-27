'use strict';

/**
 * Controllers/CountriesController.js
 *
 * What:   Surfaces the country list (ISO code, name, dialling code, flag
 *         emoji) at GET /api/v1/countries. Read-only, public.
 * Why:    The web sign-in page + future Flutter app both need a country
 *         picker (phone country code for the OTP flow). Centralising the
 *         list in api/data/countries.js means one source of truth that
 *         the web fetches once and caches.
 * Type:   READ (no DB).
 * Inputs: none.
 * Output: standard envelope with `data: { countries: [...] }`.
 * Used:   GET /api/v1/countries — wired in api/Routes/index.js.
 *
 * Change log:
 *   2026-05-25 — initial; ports CountryList.php::countrycode().
 */

const H               = require('../Helpers/helper');
const { countries }   = require('../data/countries');

/**
 * list
 *
 * What:   Returns the full list of countries.
 * Why:    Single fetch on splash / first interaction; the web caches it
 *         indefinitely (the list changes ~once a year and a server
 *         restart will roll out edits).
 * Type:   READ.
 * Inputs: req, res.
 * Output: 200 envelope, data = { countries: [...] }.
 * Used:   GET /api/v1/countries.
 */
function list(req, res) {
    return H.successResponse(res, { countries });
}

module.exports = { list };
