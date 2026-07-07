'use strict';

/**
 * Controllers/LocationController.js
 *
 * What:   Handles the user's selected delivery location.
 *           • save  — write the picked location onto req.session.userLocation
 *                     (works for both guest and logged-in visitors)
 *           • clear — remove the saved location (used by "Change" flows)
 *           • get   — small JSON read used by client code that wants the
 *                     current value without parsing the page DOM
 * Why:    Food-delivery sites are unusable without a location set first
 *         (Zomato / Swiggy / Foodhub all enforce this). Storing it in the
 *         web session means:
 *           • Guests don't lose it on a page reload (session cookie lives
 *             for SESSION_MAX_AGE — 7 days by default).
 *           • The header chip, hero CTA, and every server-rendered
 *             restaurant search all read from the same place.
 *           • When the user later signs in, we can migrate this value
 *             into their saved addresses (future — see TODO below).
 * Type:   READ + WRITE (mutates req.session only — no DB writes).
 * Inputs: req, res — Express request/response.
 * Output: JSON envelope { status, msg, data? } matching the api shape so
 *         client code uses one parser everywhere.
 * Used:   POST /location/save, POST /location/clear, GET /location.
 *         Wired in web/index.js.
 *
 * TODO (after auth lands): when req.session.user becomes populated, copy
 *      session.userLocation into customer_address for that user (saves
 *      them re-picking on the next login from another device).
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const { validateLocation } = require('../Validators/location');
const { callApi } = require('../Helpers/apiClient');

/**
 * save
 *
 * What:   Validates the posted location and persists it onto req.session.userLocation.
 * Why:    Single endpoint for every channel that picks a location — postcode
 *         autocomplete, browser geolocation, popular-city chip.
 * Type:   WRITE (session only).
 * Inputs: req.body — {source, label, postcode?, lat?, lng?, raw?}
 *         req.session — required (express-session must be mounted before this).
 * Output: 200 { status:200, show:false, msg:'Location saved.', data: <location> }
 *         422 { status:422, show:true,  msg:<first error> }     on bad input
 *         500 { status:500, show:true,  msg:<generic>     }     on save failure
 * Used:   POST /location/save (called by js/ui/location-modal.js).
 */
function save(req, res) {
    // Defensive — should never fire if session middleware is mounted.
    if (!req.session) {
        return res.status(500).json({
            status: 500,
            show:   true,
            msg:    'Session is not available. Please try again later.',
        });
    }

    const check = validateLocation(req.body);
    if (!check.ok) {
        return res.status(200).json({
            status: 422,
            show:   true,
            msg:    check.errors[0],
        });
    }

    // Persist on session. We EXPLICITLY save before responding: the
    // file-backed session store writes asynchronously, so without this the
    // client's "navigate to /" can race the disk write — the home request
    // then reads no location and bounces back to this gate page (looked
    // like "selecting a location just reloads the page"). Saving first
    // guarantees the location is durable before the client navigates.
    req.session.userLocation = check.value;

    const respond = () => res.status(200).json({
        status: 200,
        show:   false,
        msg:    'Location saved.',
        data:   check.value,
    });
    if (typeof req.session.save === 'function') {
        return req.session.save(function (err) {
            if (err) {
                return res.status(200).json({ status: 500, show: true, msg: 'Could not save your location. Please try again.' });
            }
            return respond();
        });
    }
    return respond();
}

/**
 * clear
 *
 * What:   Removes req.session.userLocation, returning the user to the
 *         "no location set" state. The location modal opens automatically
 *         on the next page load (data-has-location goes from "true" to
 *         "false").
 * Why:    Reserved for future "Change location" flows that prefer wiping
 *         rather than overwriting.
 * Type:   WRITE (session only).
 * Inputs: req — uses req.session.
 * Output: 200 envelope.
 * Used:   POST /location/clear.
 */
function clear(req, res) {
    if (req.session && req.session.userLocation) {
        delete req.session.userLocation;
    }
    return res.status(200).json({
        status: 200,
        show:   false,
        msg:    'Location cleared.',
    });
}

/**
 * get
 *
 * What:   Returns the currently saved location (or null) as JSON.
 * Why:    Lets client code fetch the value without parsing the page DOM —
 *         useful when an SPA-style refresh happens.
 * Type:   READ.
 * Inputs: req — uses req.session.
 * Output: 200 envelope with data = location object or null.
 * Used:   GET /location.
 */
function get(req, res) {
    const location = (req.session && req.session.userLocation) || null;
    return res.status(200).json({
        status: 200,
        show:   false,
        msg:    'success',
        data:   location,
    });
}

/**
 * useDemo
 *
 * What:   TEMPORARY testing shortcut. Fetches a deliverable restaurant's own
 *         coordinates from the api (server-side), then saves them to the
 *         session exactly like save() — so the user lands in the feed with a
 *         working delivery location in one tap.
 * Why:    Browser/IP geolocation needs HTTPS + a secure context, unavailable
 *         in the demo setup. Critically, this runs the api call SERVER-SIDE:
 *         on a phone the browser can't reach the api's localhost:4501, but the
 *         web server can — so the demo works on a real device where a direct
 *         client → api call ("We could not reach the server") would fail.
 * Type:   READ (api) + WRITE (session).
 * Inputs: req.body.mode? — 'delivery' | 'pickup' (defaults delivery).
 * Output: 200 envelope with the saved location, or an error envelope.
 * Used:   POST /location/use-demo (called by /js/pages/location-page.js).
 *
 * REMOVE this (+ the route + the button) once real geolocation is available.
 */
async function useDemo(req, res) {
    if (!req.session) {
        return res.status(500).json({ status: 500, show: true, msg: 'Session is not available. Please try again later.' });
    }

    // Ask the api (server-side) for one deliverable restaurant's location.
    let loc = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/marketplace/demo-location');
        if (r && r.body && r.body.status === 200 && r.body.data) { loc = r.body.data; }
    } catch (e) { loc = null; }

    if (!loc || loc.lat == null || loc.lng == null) {
        return res.status(200).json({ status: 502, show: true, msg: 'No demo delivery location is available right now.' });
    }

    // Reuse the SAME validation + shape as a normal save.
    const mode  = (req.body && String(req.body.mode || '').toLowerCase() === 'pickup') ? 'pickup' : 'delivery';
    const check = validateLocation({
        source:   'demo',
        label:    loc.label || 'Demo location',
        postcode: loc.postcode || null,
        lat:      loc.lat,
        lng:      loc.lng,
        mode:     mode,
    });
    if (!check.ok) {
        return res.status(200).json({ status: 422, show: true, msg: check.errors[0] });
    }

    req.session.userLocation = check.value;

    const respond = () => res.status(200).json({
        status: 200, show: false, msg: 'Demo location set.', data: check.value,
    });
    if (typeof req.session.save === 'function') {
        return req.session.save(function (err) {
            if (err) { return res.status(200).json({ status: 500, show: true, msg: 'Could not save your location. Please try again.' }); }
            return respond();
        });
    }
    return respond();
}

module.exports = { save, clear, get, useDemo };
