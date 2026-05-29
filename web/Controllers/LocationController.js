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

module.exports = { save, clear, get };
