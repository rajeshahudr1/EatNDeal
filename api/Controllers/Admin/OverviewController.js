'use strict';

/*
 * Controllers/Admin/OverviewController.js
 *
 * What:  GET /api/v1/admin/overview — the top-level admin dashboard stats.
 *        Platform-wide for a super admin (all companies), or scoped to one
 *        company (selector / company login):
 *          companies — count of active companies (super) or 1
 *          revenue   — SUM(orders.grand_total) of completed orders
 *          orders    — count of completed orders
 *          customers — distinct ordering customers (scoped) or total (all)
 *          perCompany— super-only top companies by revenue
 * Why:   The main dashboard answers "how is the whole platform doing".
 *        Loyalty has its own dashboard under the Loyalty menu.
 * Type:  READ.
 * Used:  api/Routes/index.js (authenticate + requireRole('admin')).
 *
 * Completed orders = legacy convention status='1' AND order_status='' .
 *
 * Change log:
 *   2026-06-09 — initial.
 */

const H = require('../../Helpers/helper');
const { db } = require('../../config/db');
const { resolveCompanyScope } = require('../../Helpers/adminScope');

function scoped(q, cid) { return cid != null ? q.where('company_id', cid) : q; }

async function overview(req, res) {
    try {
        const scope = resolveCompanyScope(req);
        const cid = scope.companyId; // null = all (super)

        // Companies
        let companies = 1;
        if (scope.isSuper && cid == null) {
            const c = await db('company').where('is_active', 1).whereNull('deleted_at').count('* as n').first();
            companies = Number(c && c.n) || 0;
        }

        // Revenue + order count (completed)
        const o = await scoped(db('orders').where({ status: '1', order_status: '' }), cid)
            .count('* as n')
            .sum({ rev: 'grand_total' })
            .first();
        const orders = Number(o && o.n) || 0;
        const revenue = Number(o && o.rev) || 0;

        // Customers
        let customers = 0;
        if (cid != null) {
            const c = await db('orders')
                .where({ company_id: cid, status: '1', order_status: '' })
                .whereNotNull('user_id')
                .countDistinct('user_id as n').first();
            customers = Number(c && c.n) || 0;
        } else {
            const c = await db('customer').count('* as n').first();
            customers = Number(c && c.n) || 0;
        }

        // Per-company breakdown (super admin, all companies)
        let perCompany = null;
        if (scope.isSuper && cid == null) {
            const rows = await db('orders as o')
                .join('company as c', 'c.id', 'o.company_id')
                .where({ 'o.status': '1', 'o.order_status': '' })
                .whereNull('c.deleted_at')
                .groupBy('c.id', 'c.business_name')
                .select('c.id', 'c.business_name')
                .count('o.id as orders')
                .sum({ revenue: 'o.grand_total' })
                .orderBy('revenue', 'desc')
                .limit(20);
            perCompany = rows.map((r) => ({
                id: Number(r.id),
                business_name: r.business_name || ('Company #' + r.id),
                orders: Number(r.orders) || 0,
                revenue: Number(r.revenue) || 0,
            }));
        }

        // Platform customer segments (super admin, all companies) — every
        // ordering customer bucketed by their lifetime completed spend into
        // fixed bands. One aggregate query (≤4 rows).
        let platformSegments = null;
        if (scope.isSuper && cid == null) {
            const segRes = await db.raw(
                "SELECT band, COUNT(*)::int AS n, COALESCE(SUM(spend),0)::float AS total FROM ("
                + " SELECT user_id,"
                + "   CASE WHEN SUM(sub_total) >= 500 THEN 'vip'"
                + "        WHEN SUM(sub_total) >= 200 THEN 'high'"
                + "        WHEN SUM(sub_total) >= 50 THEN 'mid'"
                + "        ELSE 'low' END AS band,"
                + "   SUM(sub_total) AS spend"
                + " FROM orders WHERE status = '1' AND order_status = '' AND user_id IS NOT NULL"
                + " GROUP BY user_id"
                + ") s GROUP BY band",
            );
            const byBand = {};
            (segRes.rows || segRes || []).forEach((r) => { byBand[r.band] = { count: Number(r.n) || 0, total: Number(r.total) || 0 }; });
            platformSegments = [
                { key: 'vip',  label: 'VIP',     band: 'GBP 500+' },
                { key: 'high', label: 'High',    band: 'GBP 200–500' },
                { key: 'mid',  label: 'Regular', band: 'GBP 50–200' },
                { key: 'low',  label: 'New',     band: 'under GBP 50' },
            ].map((b) => ({ key: b.key, label: b.label, band: b.band, count: (byBand[b.key] || {}).count || 0, total: (byBand[b.key] || {}).total || 0 }));
        }

        return H.successResponse(res, {
            scope: { isSuper: scope.isSuper, companyId: cid },
            companies, revenue, orders, customers, perCompany, platformSegments,
        });
    } catch (err) {
        console.error('[admin.overview]', err && err.message);
        return H.errorResponse(res, 'Could not load the overview.', 500);
    }
}

module.exports = { overview };
