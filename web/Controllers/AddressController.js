'use strict';

/**
 * Controllers/AddressController.js
 *
 * What:   Thin proxy between the browser and the api/ saved-address book.
 *         The location sheet's "Saved addresses" section + the "Address
 *         info" add/edit screen call these JSON endpoints:
 *           GET  /addresses        → list the signed-in customer's addresses
 *           POST /address/save     → create / update one
 *           POST /address/delete   → soft-delete one
 *
 * Why:    Project rule web → api → db. The browser never talks to the api
 *         directly; the web injects the customer identity (from the session)
 *         so the client can't spoof another customer_id. lat/lng from the
 *         active session location are forwarded so the api can attach the
 *         "3 km" distance labels.
 *
 * Note:   Guests (no req.session.user) get a 401 envelope — the client then
 *         routes them to sign-in. The "searched / recently used" addresses
 *         (the Nearby section) are a CLIENT-side cookie, not stored here.
 *
 * Used:   GET /addresses, POST /address/save, POST /address/delete
 *         (wired in web/index.js).
 */

const { callApi } = require('../Helpers/apiClient');

// Pull the signed-in customer off the session, or send a 401 envelope and
// return null so the caller bails out.
function requireUser(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
        res.status(200).json({
            status: 401,
            show:   true,
            msg:    'Please sign in to manage your saved addresses.',
        });
        return null;
    }
    return user;
}

// Relay the api envelope straight through to the browser (single parser on
// the client). Network / non-JSON failures become a friendly 502.
function relay(res, apiRes) {
    if (apiRes.networkError || !apiRes.body) {
        return res.status(200).json({
            status: 502,
            show:   true,
            msg:    'We could not reach the server. Please try again in a moment.',
        });
    }
    return res.status(200).json(apiRes.body);
}

/**
 * list — GET /addresses
 * Forwards customer_id (+ active lat/lng for distances) to the api.
 */
async function list(req, res) {
    const user = requireUser(req, res);
    if (!user) { return; }

    const loc = (req.session && req.session.userLocation) || {};
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    if (loc.lat != null && loc.lat !== '') { qs.set('lat', String(loc.lat)); }
    if (loc.lng != null && loc.lng !== '') { qs.set('lng', String(loc.lng)); }

    const apiRes = await callApi(req, 'GET', `/api/v1/customer/addresses?${qs.toString()}`);
    return relay(res, apiRes);
}

/**
 * save — POST /address/save
 * Upsert. customer_id is taken from the session, never the body.
 */
async function save(req, res) {
    const user = requireUser(req, res);
    if (!user) { return; }

    const payload = { ...req.body, customer_id: user.id };
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/address/save', payload);
    return relay(res, apiRes);
}

/**
 * remove — POST /address/delete
 */
async function remove(req, res) {
    const user = requireUser(req, res);
    if (!user) { return; }

    const payload = { customer_id: user.id, id: req.body.id };
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/address/delete', payload);
    return relay(res, apiRes);
}

module.exports = { list, save, remove };
