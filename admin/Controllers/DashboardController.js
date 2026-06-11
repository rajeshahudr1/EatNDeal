'use strict';

/*
 * Controllers/DashboardController.js
 *
 * What:  Renders the admin landing page — the Loyalty Dashboard from the
 *        mockup, now backed by real data from
 *        GET /api/v1/admin/loyalty/dashboard (company-scoped via the topbar
 *        selector). Shows cashback earned / redeemed / outstanding, loyalty
 *        on-off, pending review claims, and (for a super admin viewing "all
 *        companies") a per-company breakdown.
 * Why:   Gives the login flow a real destination + proves the company-scope
 *        plumbing end-to-end.
 * Type:  READ.
 * Used:  app.get('/', requireAdmin, companyContext, DashboardController.index).
 *
 * Change log:
 *   2026-06-09 — wired to the live loyalty dashboard endpoint.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');

/**
 * index — fetch + render the dashboard for the selected company (or all).
 */
async function index(req, res) {
    const ctx = res.locals.company_ctx || {};
    const qs = CC.companyQS(res);

    let ov = null;
    let sg = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/overview' + qs);
        if (r && r.body && r.body.status === 200) { ov = r.body.data; }
    } catch (e) {
        // Render the empty state below.
    }

    // Customer segments now live on the dashboard (no separate menu). Needs a
    // concrete company; for a super admin viewing "all companies" it stays null.
    if (ctx.selectedCompanyId != null && (ctx.isSuper || ctx.loyaltyEnabled)) {
        try {
            const sr = await callApi(req, 'GET', '/api/v1/admin/loyalty/segments' + qs);
            if (sr && sr.body && sr.body.status === 200) { sg = sr.body.data; }
        } catch (e) { /* segments are optional on the dashboard */ }
    }

    res.render('dashboard/index', {
        page_title:  'Dashboard',
        _layoutFile: '../_layout',
        active_nav:  'dashboard',
        extra_js:    '/js/pages/loyalty.js',
        ov,
        sg,
    });
}

module.exports = { index };
