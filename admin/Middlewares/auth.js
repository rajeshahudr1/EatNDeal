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
 * tokenExpired
 *
 * What:  True when the session's api JWT has passed its `exp`. Decoded
 *        locally (base64 payload — no signature check needed: we only
 *        read the expiry; the api still verifies the signature on every
 *        call). Missing/undecodable token counts as expired — the api
 *        would reject every call anyway.
 * Why:   Without this the SESSION could outlive the TOKEN: the admin
 *        stayed "signed in" while every api call quietly failed — dead
 *        screens instead of a clean logout (user report 28 Jul 2026).
 */
function tokenExpired(session) {
    const token = session && session.token;
    if (!token) { return true; }
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        return !payload.exp || (payload.exp * 1000) <= Date.now();
    } catch (e) {
        return true;
    }
}

/**
 * requireAdmin
 *
 * What:  Express middleware. Passes the request to the next handler when
 *        req.session carries a signed-in admin AND a still-valid api
 *        token; otherwise clears the login and bounces to /login with a
 *        `next` hint and a friendly flash. AJAX callers get a 401 JSON
 *        envelope instead (common/api.js redirects on it).
 * Inputs: req, res, next.
 * Output: next() when authenticated; res.redirect('/login?...') otherwise.
 */
function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        if (!tokenExpired(req.session)) {
            return next();
        }
        // Token ran out mid-session — force a real logout so the admin
        // re-authenticates instead of clicking around a dead console.
        req.session.admin = null;
        req.session.token = null;
        if (req.xhr || /application\/json/.test(String(req.headers.accept || ''))) {
            return res.status(200).json({ status: 401, msg: 'Your session has expired. Please sign in again.', redirect: '/login' });
        }
        if (req.flash) { req.flash('error', 'Your session has expired. Please sign in again.'); }
        return res.redirect('/login?next=' + encodeURIComponent(req.method === 'GET' ? (req.originalUrl || '/') : '/'));
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
