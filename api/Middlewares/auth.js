'use strict';

/**
 * Middlewares/auth.js
 *
 * What:   Express middleware that verifies the JWT from the Authorization
 *         Bearer header. On success: attaches the decoded payload to `req.user`
 *         and calls next(). On any failure: returns the standard auth-fail
 *         envelope and short-circuits the chain.
 * Why:    The single gatekeeper for every authenticated endpoint. Every
 *         protected route in Routes/index.js mounts this before its handler.
 * Type:   READ (verifies; no DB writes).
 * Inputs: req.headers.authorization — "Bearer <jwt>"
 * Output: side-effect — sets req.user to the decoded JWT payload, or sends
 *         a 401-shaped envelope and stops the chain.
 * Used:   Every authenticated route in Routes/index.js.
 *
 *   The same generic auth-fail message is returned for EVERY failure mode
 *   (missing header, bad signature, expired token, malformed token). Never
 *   leak which condition tripped — an attacker shouldn't be able to probe.
 *
 * Change log:
 *   2026-05-25 — initial; HS256 JWT, Bearer scheme.
 */

const H   = require('../Helpers/helper');
const MSG = require('../Helpers/messages');
const jwt = require('../Helpers/jwt');

/**
 * extractToken
 *
 * What:   Pulls the JWT string out of the Authorization header.
 * Why:    Header parsing is the same in every middleware that needs the
 *         token; extracting it keeps `authenticate` readable.
 * Type:   READ.
 * Inputs: req — Express request.
 * Output: string token, or null if no Bearer header is present / well-formed.
 * Used:   Only inside this module.
 */
function extractToken(req) {
    // Header keys are lowercased by Express, but we check both cases just in
    // case a future change in the upstream proxy preserves casing.
    const raw = req.headers.authorization || req.headers.Authorization || '';
    if (typeof raw !== 'string') return null;
    const match = raw.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : null;
}

/**
 * authenticate
 *
 * What:   Middleware — requires a valid Bearer JWT.
 * Why:    Gates every protected endpoint.
 * Type:   READ.
 * Inputs: req (with Authorization header), res, next.
 * Output: calls next() on success (with req.user populated);
 *         sends 401-shaped envelope on any failure.
 * Used:   Routes/index.js — before controllers that need an authed user.
 */
function authenticate(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return H.errorResponse(res, MSG.auth.failed, 401);
    }

    try {
        // verify() throws on bad sig / expired / malformed — caught below.
        req.user = jwt.verify(token);
        return next();
    } catch (err) {
        // Single generic message regardless of cause — see file header.
        return H.errorResponse(res, MSG.auth.failed, 401);
    }
}

module.exports = { authenticate, extractToken };
