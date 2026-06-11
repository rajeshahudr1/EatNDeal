'use strict';

/*
 * Helpers/controllerCommon.js  (admin layer)
 *
 * What:  Shared server-side controller helpers for the admin PWA — the
 *        company-scope trio (read from res.locals.company_ctx, set by the
 *        companyContext middleware), the api-envelope → flash bridge, and the
 *        toggle status parser. These were copy-pasted verbatim across the admin
 *        controllers; one home means scoping + flash wording can't drift.
 *        Pure (no DB, no api) — the admin layer stays a thin proxy.
 *
 * Used:  admin/Controllers/{Loyalty,Products,StoreSettings,MarketplaceCategories,
 *        Dashboard}Controller.js.
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

// The company the topbar selector is pointing at (null = none / super "all").
function activeCompanyId(res) {
    const ctx = res.locals.company_ctx || {};
    return ctx.selectedCompanyId != null ? ctx.selectedCompanyId : null;
}

// "?company_id=N" for api calls (empty string when no company is active).
function companyQS(res) {
    const id = activeCompanyId(res);
    return id != null ? ('?company_id=' + encodeURIComponent(id)) : '';
}

// True when a super admin must pick a company before a single-company screen
// can do anything.
function needsCompanyPick(res) {
    const ctx = res.locals.company_ctx || {};
    return ctx.isSuper && activeCompanyId(res) == null;
}

// Flash a success/error toast from an api envelope. Returns whether it was a
// success (status 200).
function flashFromApi(req, apiRes, fallback) {
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        if (req.flash) { req.flash('success', body.msg || 'Saved.'); }
        return true;
    }
    if (req.flash) { req.flash('error', (body && body.msg) || fallback || 'Something went wrong.'); }
    return false;
}

// A status toggle posts status="1" (on) / anything else (off) → 1 | 2.
function parseToggleStatus(req) {
    return (req.body && req.body.status) === '1' ? 1 : 2;
}

module.exports = { activeCompanyId, companyQS, needsCompanyPick, flashFromApi, parseToggleStatus };
