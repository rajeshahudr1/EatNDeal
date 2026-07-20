'use strict';

/**
 * Middlewares/requireSuperAdmin.js
 *
 * What:   Route guard — lets a request through ONLY for a super_admin
 *         (legacy user.role 6, company_id 0). Everyone else gets a 404.
 *
 * Why:    `requireRole('admin')` is NOT enough for marketplace-level screens.
 *         Both a super admin AND every restaurant's own company login carry
 *         kind='admin' in their JWT, so requireRole('admin') admits both. That
 *         is correct for company-scoped screens (loyalty rules, products —
 *         Helpers/adminScope pins a company login to its own company_id), but
 *         WRONG for global, marketplace-owned data: marketplace categories,
 *         collections, feed sections, offer/welcome banners, and the
 *         marketplace's own loyalty programme (company_id = 0). Those aren't
 *         owned by any restaurant, so adminScope has nothing to pin — a company
 *         login could otherwise read and mutate data affecting EVERY restaurant.
 *
 * Why 404 and not 403:
 *         A 403 confirms the endpoint exists. These screens are super-admin-only
 *         and shouldn't be discoverable by a company login probing URLs, so we
 *         answer exactly as if the route didn't exist — the same thing the admin
 *         web layer renders for an unauthorised URL.
 *
 * Type:   READ (pure — only reads req.user).
 * Inputs: req.user (from `authenticate`) — .role must be 'super_admin'.
 * Used:   Routes/index.js — after `authenticate` + `requireRole('admin')`, e.g.
 *           router.post('/admin/collections/save',
 *               authenticate, requireRole('admin'), requireSuperAdmin, Ctl.save);
 *
 * Change log:
 *   2026-07-15 — initial (marketplace loyalty: company_id 0 is super-admin-only).
 */

const H   = require('../Helpers/helper');
const MSG = require('../Helpers/messages');

// The role string adminScope + the admin console already agree on.
const SUPER_ROLE = 'super_admin';

/**
 * requireSuperAdmin
 *
 * What:   Middleware. next() for a super_admin; 404 for anyone else.
 * Type:   READ.
 */
function requireSuperAdmin(req, res, next) {
    const u = req.user;
    // Defensive — should never fire when mounted after `authenticate`.
    if (!u || typeof u !== 'object') {
        return H.errorResponse(res, MSG.auth.failed, 401);
    }
    if (u.role !== SUPER_ROLE) {
        return H.errorResponse(res, MSG.server.notFound, 404);
    }
    return next();
}

module.exports = { requireSuperAdmin, SUPER_ROLE };
