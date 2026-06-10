'use strict';

/*
 * Helpers/authProxy.js
 *
 * What:  Shared boilerplate every signed-in web proxy controller needs:
 *
 *          requireUser(req, res)        → req.session.user OR 401 envelope
 *          relay(res, apiRes)           → api envelope → browser response,
 *                                          with friendly 502 on network fail
 *
 *        The web layer always: (1) checks the session, (2) forwards to
 *        /api/v1/..., (3) relays the api envelope back. These two helpers
 *        cover that contract end-to-end so each new authed controller is
 *        ~5 lines of glue instead of ~25 lines of duplicated boilerplate.
 *
 * Why:   Was previously copy-pasted in AddressController + FavouriteController
 *        with subtly different wording. Single source of truth keeps the
 *        401/502 envelopes identical site-wide.
 *
 * Used:  web/Controllers/AddressController.js
 *        web/Controllers/FavouriteController.js
 *        any future authed proxy.
 */

/**
 * requireUser
 *
 * What:  Returns the signed-in user from the session, or sends a 401
 *        envelope to the browser and returns null so the caller bails out
 *        with a single `if (!user) return;` check.
 *
 *        Optional `message` overrides the default copy (e.g. "Please
 *        sign in to use favourites." vs "...manage your addresses.").
 * Type:  READ + WRITE (writes the 401 response on the unauth path).
 */
function requireUser(req, res, message) {
    const user = (req.session && req.session.user) || null;
    if (!user || !user.id) {
        res.status(200).json({
            status: 401,
            show:   true,
            msg:    message || 'Please sign in to continue.',
        });
        return null;
    }
    return user;
}

/**
 * relay
 *
 * What:  Forwards the api envelope to the browser unchanged so the client
 *        has a single parser. Network errors / non-JSON failures become a
 *        consistent 502 envelope.
 * Type:  WRITE.
 */
function relay(res, apiRes) {
    if (!apiRes || apiRes.networkError || !apiRes.body) {
        return res.status(200).json({
            status: 502,
            show:   true,
            msg:    'We could not reach the server. Please try again in a moment.',
        });
    }
    return res.status(200).json(apiRes.body);
}

module.exports = { requireUser, relay };
