'use strict';

/**
 * Middlewares/requireRole.js
 *
 * What:   Middleware factory — returns a middleware that allows the request
 *         through only if `req.user.kind` matches one of the accepted roles.
 * Why:    EatNDeal has four actor types — customer, rider, restaurant_owner,
 *         admin — each authenticating through its own login endpoint. Their
 *         JWTs all carry a `kind` claim that names the actor type. This
 *         middleware gates a route by that claim:
 *
 *           router.get('/me/orders',  authenticate, requireRole('customer'),  ...);
 *           router.post('/dispatch',  authenticate, requireRole('admin'),     ...);
 *
 *         A route can accept multiple roles by passing them all:
 *
 *           router.get('/orders/:id', authenticate, requireRole('customer','rider','restaurant_owner','admin'), ...);
 *
 * Type:   READ.
 * Inputs: ...allowed (string[]) — accepted role names. Must be non-empty.
 * Output: middleware function.
 * Used:   Routes/index.js — after `authenticate`, before the controller.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const H   = require('../Helpers/helper');
const MSG = require('../Helpers/messages');

// The full set of actor types the system knows about. Anything outside this
// list passed into requireRole() is a programmer error (typo, removed role),
// so we throw at module load to catch it during dev rather than at runtime.
const KNOWN_ROLES = new Set([
    'customer',
    'rider',
    'restaurant_owner',
    'admin',
]);

/**
 * requireRole
 *
 * What:   Build a middleware that checks req.user.kind against the allowlist.
 * Why:    See file header.
 * Type:   READ.
 * Inputs: ...allowed (string[]) — accepted roles. At least one required.
 * Output: middleware function (req, res, next) => void.
 * Used:   Throughout Routes/index.js — after `authenticate`, before controller.
 */
function requireRole(...allowed) {
    if (allowed.length === 0) {
        throw new TypeError('requireRole(...allowed): need at least one role');
    }
    for (const role of allowed) {
        if (!KNOWN_ROLES.has(role)) {
            throw new TypeError(
                `requireRole: unknown role "${role}". Known roles: ${[...KNOWN_ROLES].join(', ')}`
            );
        }
    }

    return function requireRoleMiddleware(req, res, next) {
        // Defensive — should never fire if mounted after `authenticate`.
        // If it does, treat as an auth failure (don't expose the misconfig).
        const u = req.user;
        if (!u || typeof u !== 'object' || !u.kind) {
            return H.errorResponse(res, MSG.auth.failed, 401);
        }

        if (!allowed.includes(u.kind)) {
            // Use the forbidden message (403-style) — the user is authed but
            // not in the right role group.
            return H.errorResponse(res, MSG.auth.forbidden, 403);
        }

        return next();
    };
}

module.exports = { requireRole, KNOWN_ROLES };
