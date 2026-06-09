'use strict';

/**
 * Middlewares/auth.js
 *
 * What:  Route guard for the admin console. requireAdmin lets a request
 *        through only when the session carries a signed-in admin; otherwise
 *        it bounces to /login (remembering where the admin was headed via
 *        ?next= so they land back there after authenticating).
 * Why:   Every admin screen except the login page itself is private. One
 *        gate, applied per-route in index.js, keeps that rule in one place.
 * Type:  READ (only reads req.session).
 * Used:  app.get('/', requireAdmin, ...) and every future admin route.
 */

/**
 * requireAdmin
 *
 * What:  Express middleware. Passes the request to the next handler when
 *        req.session.admin exists; redirects to /login with a `next` hint
 *        and a friendly flash when it does not.
 * Inputs: req, res, next.
 * Output: next() when authenticated; res.redirect('/login?...') otherwise.
 */
function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }

    // Remember the intended destination so doLogin can send the admin
    // straight back after a successful sign-in. Only GET targets are
    // worth preserving (POSTs can't be safely replayed via a redirect).
    let next_url = '/';
    if (req.method === 'GET' && req.originalUrl && req.originalUrl !== '/login') {
        next_url = req.originalUrl;
    }

    if (req.flash) { req.flash('error', 'Please sign in to continue.'); }
    return res.redirect('/login?next=' + encodeURIComponent(next_url));
}

module.exports = { requireAdmin };
