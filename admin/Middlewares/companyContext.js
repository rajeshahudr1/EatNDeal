'use strict';

/*
 * Middlewares/companyContext.js
 *
 * What:  For a signed-in admin, loads the list of companies they may act on
 *        and resolves the currently-selected one, exposing it to every shell
 *        page as res.locals.company_ctx. The topbar renders a company SWITCHER
 *        from this (super admins only); company logins see a static label.
 * Why:   The whole loyalty console is company-scoped. One middleware resolves
 *        "which company am I looking at" so every screen + the topbar agree.
 * Type:  READ (calls the api; no DB).
 * Used:  Mounted before the gated admin routes in admin/index.js.
 *
 * Change log:
 *   2026-06-09 — initial.
 */

const { callApi } = require('../Helpers/apiClient');

/**
 * companyContext — middleware. Populates res.locals.company_ctx:
 *   { companies[], isSuper, selectedCompanyId, selectedCompany }
 * The selection lives in req.session.company_id (super admins only); company
 * logins are pinned to their own admin.company_id.
 */
async function companyContext(req, res, next) {
    res.locals.company_ctx = { companies: [], isSuper: false, selectedCompanyId: null, selectedCompany: null, loyaltyEnabled: false };

    const admin = (req.session && req.session.admin) || null;
    if (!admin) { return next(); }

    const isSuper = admin.role === 'super_admin';

    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/companies');
        const body = r && r.body;
        const companies = (body && body.status === 200 && body.data && body.data.companies) || [];

        let selectedCompanyId = null;
        if (isSuper) {
            const sel = (req.session.company_id != null && req.session.company_id !== '')
                ? Number(req.session.company_id) : null;
            // Only honour a selection that's still a valid company; else "all".
            selectedCompanyId = (sel && companies.some((c) => Number(c.id) === sel)) ? sel : null;
        } else {
            selectedCompanyId = Number(admin.company_id) || (companies[0] && Number(companies[0].id)) || null;
        }

        const selectedCompany = companies.find((c) => Number(c.id) === selectedCompanyId) || null;

        // loyaltyEnabled gates the Loyalty menu. A super admin always sees it
        // (they manage + enable loyalty for companies); a company login sees it
        // only when the super admin has turned loyalty ON for their company
        // (company_loyalty.loyalty_status === 1, surfaced as company.loyaltyOn).
        const ownCompany = isSuper ? null : (companies[0] || null);
        const loyaltyEnabled = isSuper ? true : !!(ownCompany && ownCompany.loyaltyOn);

        res.locals.company_ctx = { companies, isSuper, selectedCompanyId, selectedCompany, loyaltyEnabled };
    } catch (e) {
        // Leave the safe defaults — the screen can still render an empty state.
    }

    return next();
}

/**
 * requireLoyalty — route guard. Lets the request through only when the
 * Loyalty menu is available (super admin, or a company whose loyalty the
 * super admin has switched ON). Otherwise bounces to the dashboard. MUST be
 * mounted AFTER companyContext (it reads res.locals.company_ctx).
 */
function requireLoyalty(req, res, next) {
    const ctx = res.locals.company_ctx || {};
    if (ctx.isSuper || ctx.loyaltyEnabled) { return next(); }
    if (req.flash) { req.flash('error', 'Loyalty isn’t enabled for your company yet — contact the EatNDeal team.'); }
    return res.redirect('/');
}

module.exports = { companyContext, requireLoyalty };
