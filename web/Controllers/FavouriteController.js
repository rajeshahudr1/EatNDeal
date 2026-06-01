'use strict';

/**
 * Controllers/FavouriteController.js
 *
 * What:   Thin proxy between the browser and the api/ favourites endpoints.
 *         The heart icon on restaurant cards + the Favourites tab on the
 *         account page call these JSON endpoints:
 *           GET  /favourites          → list the signed-in customer's hearts
 *           POST /favourite/toggle    → heart / unheart one restaurant
 *
 * Why:    Project rule web → api → db. The browser never talks to the api
 *         directly; the web injects the customer identity (from the session)
 *         so the client can't spoof another customer_id. lat/lng from the
 *         active session location are forwarded so the cards can show the
 *         right distance / delivery-time label.
 *
 * Note:   Guests get a 401 envelope — the UI never even renders the heart
 *         icon for a guest, so this branch is defence-in-depth (curl).
 *
 * Used:   GET /favourites, POST /favourite/toggle (wired in web/index.js).
 */

const { callApi } = require('../Helpers/apiClient');

function requireUser(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
        res.status(200).json({
            status: 401,
            show:   true,
            msg:    'Please sign in to use favourites.',
        });
        return null;
    }
    return user;
}

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
 * list — GET /favourites
 */
async function list(req, res) {
    const user = requireUser(req, res);
    if (!user) { return; }

    const loc = (req.session && req.session.userLocation) || {};
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    if (loc.lat != null && loc.lat !== '') { qs.set('lat', String(loc.lat)); }
    if (loc.lng != null && loc.lng !== '') { qs.set('lng', String(loc.lng)); }

    const apiRes = await callApi(req, 'GET', `/api/v1/customer/favourites?${qs.toString()}`);
    return relay(res, apiRes);
}

/**
 * toggle — POST /favourite/toggle
 */
async function toggle(req, res) {
    const user = requireUser(req, res);
    if (!user) { return; }

    const payload = {
        customer_id: user.id,
        company_id:  req.body.company_id,
    };
    // Only forward branch_id when the card actually carried one — an
    // empty string fails the alternatives validator on the api side
    // even though the field is optional.
    if (req.body.branch_id) { payload.branch_id = req.body.branch_id; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/favourite/toggle', payload);
    return relay(res, apiRes);
}

module.exports = { list, toggle };
