'use strict';

/*
 * Controllers/Admin/CompaniesController.js
 *
 * What:  GET /api/v1/admin/companies — the company list that powers the admin
 *        console's company switcher.
 *          • super_admin → all active, non-deleted companies (selectable).
 *          • company     → just their own company (single forced entry).
 * Why:   A super admin manages loyalty company-by-company; everyone else is
 *        pinned to one company. The list drives the topbar selector.
 * Type:  READ.
 * Used:  api/Routes/index.js (authenticate + requireRole('admin')).
 *
 * Change log:
 *   2026-06-09 — initial.
 */

const H = require('../../Helpers/helper');
const { db } = require('../../config/db');
const { resolveCompanyScope } = require('../../Helpers/adminScope');

/**
 * list — return the companies the signed-in admin may act on.
 */
async function list(req, res) {
    try {
        const scope = resolveCompanyScope(req);

        // `loyaltyOn` = company_loyalty.loyalty_status === 1. This gates whether
        // a company login sees the Loyalty menu (the super admin enables it).
        const mapRow = (r) => ({
            id: Number(r.id),
            business_name: r.business_name,
            email: r.email,
            loyaltyOn: Number(r.loyalty_status) === 1,
        });

        if (!scope.isSuper) {
            // Company / staff login — only ever their own company.
            if (!scope.companyId) {
                return H.successResponse(res, { companies: [], isSuper: false, scopedCompanyId: null });
            }
            const c = await db('company as c')
                .leftJoin('company_loyalty as cl', 'cl.company_id', 'c.id')
                .where('c.id', scope.companyId)
                .select('c.id', 'c.business_name', 'c.email', 'cl.loyalty_status')
                .first();
            return H.successResponse(res, {
                companies: c ? [mapRow(c)] : [],
                isSuper: false,
                scopedCompanyId: scope.companyId,
            });
        }

        // Super admin — every active, non-deleted company (+ its loyalty flag).
        const rows = await db('company as c')
            .leftJoin('company_loyalty as cl', 'cl.company_id', 'c.id')
            .where('c.is_active', 1)
            .whereNull('c.deleted_at')
            .select('c.id', 'c.business_name', 'c.email', 'cl.loyalty_status')
            .orderBy('c.business_name', 'asc');

        return H.successResponse(res, { companies: rows.map(mapRow), isSuper: true, scopedCompanyId: null });
    } catch (err) {
        console.error('[admin.companies.list]', err && err.message);
        return H.errorResponse(res, 'Could not load companies.', 500);
    }
}

module.exports = { list };
