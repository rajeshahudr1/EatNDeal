'use strict';

/**
 * Helpers/jwt.js
 *
 * What:   Thin wrapper around jsonwebtoken for issuing + verifying our JWTs.
 * Why:    Centralising the secret + algorithm + default expiry in one place
 *         means changing the policy is a one-file edit. Also surfaces a
 *         consistent payload shape (sub, kind, iat, exp) every JWT we mint.
 * Type:   READ (no DB; mints / verifies tokens only).
 * Inputs: process.env.JWT_SECRET (required at boot — fails loudly if missing)
 *         process.env.JWT_EXPIRES_IN (default '24h')
 * Output: { sign(payload), verify(token), decodeUnsafe(token) }
 * Used:   Middlewares/auth.js (verify), every login controller (sign).
 *
 * Change log:
 *   2026-05-25 — initial; HS256 with env secret, 24-hour default expiry.
 */

const jwt = require('jsonwebtoken');

// Read secret + expiry once at module load. If JWT_SECRET is unset we throw
// IMMEDIATELY — a silently-blank secret means anyone can mint a valid token.
// Crash early > stay running insecurely.
const JWT_SECRET     = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
    // Throwing at require-time means index.js never reaches app.listen() if
    // the env is misconfigured. Operators see the error in PM2 / docker logs.
    throw new Error(
        '[Helpers/jwt] JWT_SECRET is missing or too short. Set a 32+ character '
        + 'random string in api/.env. Generate one with:\n'
        + '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
}

/**
 * sign
 *
 * What:   Signs a JWT with the given payload + the configured secret.
 * Why:    Used by every login flow (customer / rider / restaurant / admin)
 *         to mint the access token sent back to the client.
 * Type:   READ (no side-effects; mints a string).
 * Inputs: payload (object) — should include at minimum:
 *           sub     — the user id (number or string)
 *           kind    — one of: 'customer' | 'rider' | 'restaurant_owner' | 'admin'
 *           Plus any optional claims (company_id, role_id, permissions).
 *         options (object, optional) — overrides for expiresIn etc.
 * Output: signed JWT string.
 * Used:   Controllers/Customer/AuthController, Controllers/Restaurant/AuthController,
 *         Controllers/Rider/AuthController, Controllers/Admin/AuthController.
 */
function sign(payload, options = {}) {
    return jwt.sign(payload, JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: options.expiresIn || JWT_EXPIRES_IN,
    });
}

/**
 * verify
 *
 * What:   Verifies a JWT signature + expiry. Throws on any failure
 *         (bad signature, expired, malformed).
 * Why:    Used by Middlewares/auth.js to gate every protected endpoint.
 *         Throws on failure (caller catches + emits the standard 401 envelope).
 * Type:   READ.
 * Inputs: token (string) — the raw JWT.
 * Output: decoded payload object on success.
 * Used:   Middlewares/auth.js.
 */
function verify(token) {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

/**
 * decodeUnsafe
 *
 * What:   Decodes the payload of a JWT WITHOUT verifying its signature.
 * Why:    Used ONLY by the Flutter app's claim-overlay logic (it trusts the
 *         server-signed token and just wants to read the payload locally).
 *         Server-side code MUST use verify() instead — never trust decoded
 *         claims from an unverified token.
 * Type:   READ.
 * Inputs: token (string).
 * Output: decoded payload object, or null if the token is malformed.
 * Used:   (Server-side: do not use except in debug tooling.)
 */
function decodeUnsafe(token) {
    try {
        return jwt.decode(token) || null;
    } catch {
        return null;
    }
}

module.exports = { sign, verify, decodeUnsafe };
