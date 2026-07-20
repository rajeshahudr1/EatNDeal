'use strict';

/*
 * Controllers/LoyaltyController.js (admin layer)
 *
 * What:  Renders the loyalty management screens and proxies their writes to
 *        the api (admin -> api -> db). Every screen is company-scoped via the
 *        topbar selector (res.locals.company_ctx, set by companyContext).
 * Why:   The admin layer never touches the DB — it calls /api/v1/admin/loyalty/*
 *        which enforces the super-admin / company scoping.
 * Type:  READ + WRITE (via api).
 * Used:  Wired in admin/index.js (gated by requireAdmin + companyContext).
 *
 * Change log:
 *   2026-06-09 — Cashback Rules screen.
 */

const { callApi } = require('../Helpers/apiClient');

// ── Scope helpers (shared — see Helpers/controllerCommon) ────────────
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;
const { MARKETPLACE_COMPANY_ID } = require('../Helpers/viewConstants');

/*
 * SCOPE: this console's Loyalty screens are the MARKETPLACE's OWN programme —
 * company_id = 0 — and nothing else. A restaurant's loyalty is configured in
 * the legacy POS (backend/modules/pos/loyalty-configuration), not here.
 *
 * So the company SWITCHER at the top of the page is deliberately IGNORED on
 * these screens: they read and write scope 0 whatever it says. That's why the
 * shared CC.activeCompanyId / CC.companyQS / CC.needsCompanyPick are re-bound
 * below instead of being used directly — every one of the 30+ call sites in
 * this file then hits scope 0 without each one having to remember, and a new
 * screen added later can't silently pick the switcher's company back up.
 *
 * The routes are super-admin only (requireSuperPage in admin/index.js) and the
 * api re-checks independently (requireSuperAdmin), so a company login can
 * neither see these pages nor reach the endpoints behind them.
 */
const activeCompanyId = () => MARKETPLACE_COMPANY_ID;   // always 0
// NB the leading '?' — call sites append this straight onto a path
// ('/admin/loyalty/dashboard' + companyQS(res)), so dropping it silently
// produces '/dashboardcompany_id=0'. Matches CC.companyQS's contract.
const companyQS = () => '?company_id=' + MARKETPLACE_COMPANY_ID;
const needsCompanyPick = () => false;                   // never — 0 always resolves

// ── Loyalty Dashboard (the Loyalty menu landing / hub) ──────────────

async function loyaltyDashboard(req, res) {
    const qs = companyQS(res);
    let dash = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/dashboard' + qs);
        if (r && r.body && r.body.status === 200) { dash = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load the loyalty dashboard.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('loyalty/dashboard', {
        page_title:  'Loyalty',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'dashboard',
        extra_js:    '/js/pages/loyalty.js',
        dash,
        load_error,
    });
}

// ── Loyalty Configuration — ONE page, all 10 sections (legacy concept) ──
// Pulls every section's data in parallel and renders them as stacked boxes,
// mirroring the legacy admin/pos/loyalty-configuration single page. Each box
// keeps its own save (posting to the existing per-section endpoints, which
// redirect back here).
async function loyaltyConfig(req, res) {
    const d = {};
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to configure its loyalty program.';
    } else {
        const qs = companyQS(res);
        const paths = {
            company:       '/api/v1/admin/loyalty/dashboard',
            cashback:      '/api/v1/admin/loyalty/cashback',
            tiers:         '/api/v1/admin/loyalty/tiers',
            referral:      '/api/v1/admin/loyalty/referral-streak',
            challenges:    '/api/v1/admin/loyalty/challenges',
            events:        '/api/v1/admin/loyalty/events',
            reviewRewards: '/api/v1/admin/loyalty/review-rewards',
            product:       '/api/v1/admin/loyalty/product-cashback',
            bogof:         '/api/v1/admin/loyalty/bogof',
            special:       '/api/v1/admin/loyalty/special-offer',
        };
        const keys = Object.keys(paths);
        try {
            const results = await Promise.all(keys.map((k) =>
                callApi(req, 'GET', paths[k] + qs)
                    .then((r) => (r && r.body && r.body.status === 200) ? r.body.data : null)
                    .catch(() => null),
            ));
            keys.forEach((k, i) => { d[k] = results[i]; });
            if (keys.every((k) => d[k] == null)) { load_error = 'Could not load loyalty configuration.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/config', {
        page_title:  'Loyalty Configuration',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        extra_js:    '/js/pages/loyalty.js',
        d,
        load_error,
    });
}

// Company-level loyalty on/off (super admin enables loyalty for a company).
async function masterToggle(req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/master-toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update loyalty.');
    return res.redirect('/loyalty');
}

// Company-level loyalty settings (commission % + enable phone orders).
async function companyConfigSave(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/company-config', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save loyalty settings.');
    return res.redirect('/loyalty');
}

// Save All — the whole Loyalty Configuration page in one POST.
async function saveAll(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/save-all', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save the loyalty configuration.');
    return res.redirect('/loyalty');
}

// ── Screen 2: Cashback Rules ────────────────────────────────────────

/**
 * cashbackRules — GET /loyalty/cashback-rules
 */
async function cashbackRules(req, res) {
    let cb = null;
    let load_error = null;

    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage its cashback rules.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/cashback' + companyQS(res));
            if (r && r.body && r.body.status === 200) { cb = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load cashback rules.'; }
        } catch (e) {
            load_error = 'Could not reach the server.';
        }
    }

    res.render('loyalty/cashback-rules', {
        page_title:  'Cashback Rules',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'cashback',
        extra_js:    '/js/pages/loyalty.js',
        cb,
        load_error,
    });
}

/**
 * cashbackSave — POST /loyalty/cashback-rules/save  (add or edit a rule)
 */
async function cashbackSave(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/cashback', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save the rule.');
    return res.redirect('/loyalty');
}

/**
 * cashbackDelete — POST /loyalty/cashback-rules/delete  (soft delete)
 */
async function cashbackDelete(req, res) {
    const id = req.body && req.body.id;
    let apiRes;
    try { apiRes = await callApi(req, 'DELETE', '/api/v1/admin/loyalty/cashback/' + encodeURIComponent(id) + companyQS(res)); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the rule.');
    return res.redirect('/loyalty');
}

/**
 * cashbackToggle — POST /loyalty/cashback-rules/toggle  (master on/off)
 */
async function cashbackToggle(req, res) {
    const status = CC.parseToggleStatus(req);
    const body = { company_id: activeCompanyId(res), status };
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/cashback/toggle', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
}

/**
 * configSave — POST /loyalty/cashback-rules/config  (global knobs)
 */
async function configSave(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/config', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save settings.');
    return res.redirect('/loyalty');
}

// ── Screen 3: Tier Config ───────────────────────────────────────────

async function tierConfig(req, res) {
    let tc = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage its tiers.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/tiers' + companyQS(res));
            if (r && r.body && r.body.status === 200) { tc = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load tiers.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/tiers', {
        page_title:  'Tier Config',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'tiers',
        extra_js:    '/js/pages/loyalty.js',
        tc,
        load_error,
    });
}

async function tierSave(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/tiers', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save tiers.');
    return res.redirect('/loyalty');
}

async function tierToggle(req, res) {
    const status = CC.parseToggleStatus(req);
    const body = { company_id: activeCompanyId(res), status };
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/tiers/toggle', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
}

// ── Screen 4: Referral & Streak ─────────────────────────────────────

async function referralStreak(req, res) {
    let rs = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage referral & streak.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/referral-streak' + companyQS(res));
            if (r && r.body && r.body.status === 200) { rs = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load referral & streak.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/referral-streak', {
        page_title:  'Referral & Streak',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'referral',
        extra_js:    '/js/pages/loyalty.js',
        rs,
        load_error,
    });
}

// Build a POST proxy: forward the body (+ company scope) to an api path, flash
// the result, and redirect back to the given screen.
function proxyPost(path, redirectTo) {
    return async function (req, res) {
        const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
        let apiRes;
        try { apiRes = await callApi(req, 'POST', path, body); }
        catch (e) { apiRes = null; }
        flashFromApi(req, apiRes, 'Something went wrong.');
        return res.redirect(redirectTo);
    };
}

const referralSave   = proxyPost('/api/v1/admin/loyalty/referral', '/loyalty');
const referralToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/referral/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};
const streakSave = proxyPost('/api/v1/admin/loyalty/streak', '/loyalty');
const streakToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/streak/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};
async function streakDelete(req, res) {
    const id = req.body && req.body.id;
    let apiRes;
    try { apiRes = await callApi(req, 'DELETE', '/api/v1/admin/loyalty/streak/' + encodeURIComponent(id) + companyQS(res)); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the milestone.');
    return res.redirect('/loyalty');
}

// ── Screen 5: Challenges (Smart Campaigns) ──────────────────────────

async function challenges(req, res) {
    let ch = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage its challenges.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/challenges' + companyQS(res));
            if (r && r.body && r.body.status === 200) { ch = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load challenges.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/challenges', {
        page_title:  'Challenges',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'challenges',
        extra_js:    '/js/pages/loyalty.js',
        ch,
        load_error,
    });
}

const challengesSave   = proxyPost('/api/v1/admin/loyalty/challenges', '/loyalty');
const challengesToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/challenges/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};

// ── Screen 6: Event Rewards ─────────────────────────────────────────

async function events(req, res) {
    let ev = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage event rewards.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/events' + companyQS(res));
            if (r && r.body && r.body.status === 200) { ev = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load event rewards.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/events', {
        page_title:  'Event Rewards',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'events',
        extra_js:    '/js/pages/loyalty.js',
        ev,
        load_error,
    });
}

const eventsSave   = proxyPost('/api/v1/admin/loyalty/events', '/loyalty');
const eventsToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/events/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};

// ── Screen 7: Review Claims ─────────────────────────────────────────

async function reviewClaims(req, res) {
    // Review claims allow a super admin to see ALL companies (no company pick
    // required) — so no needsCompanyPick gate here.
    const params = new URLSearchParams();
    const cid = activeCompanyId(res);
    if (cid != null) { params.set('company_id', cid); }
    ['status', 'date_from', 'date_to', 'q'].forEach((k) => { if (req.query[k]) { params.set(k, req.query[k]); } });
    const qs = params.toString() ? ('?' + params.toString()) : '';

    let rc = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/review-claims' + qs);
        if (r && r.body && r.body.status === 200) { rc = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load review claims.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('loyalty/review-claims', {
        page_title:  'Cashback Review',
        _layoutFile: '../_layout',
        // 'review-claims', NOT 'reviews' — that key now belongs to the
        // marketplace star-reviews page (Controllers/ReviewsController), and
        // sharing it lit up the wrong sidebar item on this screen.
        active_nav:  'review-claims',
        active_sub:  'review-claims',
        extra_js:    '/js/pages/loyalty.js',
        rc,
        filters: {
            status:    req.query.status || '',
            date_from: req.query.date_from || '',
            date_to:   req.query.date_to || '',
            q:         req.query.q || '',
        },
        load_error,
    });
}

async function reviewApprove(req, res) {
    const body = { id: req.body && req.body.id, company_id: activeCompanyId(res) };
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/review-claims/approve', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not approve the claim.');
    return res.redirect(req.get('referer') || '/loyalty/review-claims');
}

async function reviewReject(req, res) {
    const body = {
        id: req.body && req.body.id,
        reject_reason: (req.body && req.body.reject_reason) || '',
        company_id: activeCompanyId(res),
    };
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/review-claims/reject', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not reject the claim.');
    return res.redirect(req.get('referer') || '/loyalty/review-claims');
}

// ── Screen 8: Customer Segments ─────────────────────────────────────

async function segments(req, res) {
    let sg = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to view its segments.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/segments' + companyQS(res));
            if (r && r.body && r.body.status === 200) { sg = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load segments.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/segments', {
        page_title:  'Customer Segments',
        _layoutFile: '../_layout',
        active_nav:  'segments',
        active_sub:  'segments',
        extra_js:    '/js/pages/loyalty.js',
        sg,
        load_error,
    });
}

// ── Section 8: Special Offer ────────────────────────────────────────

async function specialOffer(req, res) {
    let so = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage special offers.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/special-offer' + companyQS(res));
            if (r && r.body && r.body.status === 200) { so = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load special offers.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/special-offer', {
        page_title:  'Special Offer',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'special-offer',
        extra_js:    '/js/pages/loyalty.js',
        so,
        load_error,
    });
}

const specialOfferSave   = proxyPost('/api/v1/admin/loyalty/special-offer', '/loyalty');
const specialOfferToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/special-offer/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};
async function specialOfferDelete(req, res) {
    const id = req.body && req.body.id;
    let apiRes;
    try { apiRes = await callApi(req, 'DELETE', '/api/v1/admin/loyalty/special-offer/' + encodeURIComponent(id) + companyQS(res)); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the offer.');
    return res.redirect('/loyalty');
}

// ── Section 6: Review Cashback rewards (8 types) ────────────────────

async function reviewRewards(req, res) {
    let rr = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage review rewards.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/review-rewards' + companyQS(res));
            if (r && r.body && r.body.status === 200) { rr = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load review rewards.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/review-rewards', {
        page_title:  'Review Rewards',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'review-rewards',
        extra_js:    '/js/pages/loyalty.js',
        rr,
        load_error,
    });
}

const reviewRewardsSave   = proxyPost('/api/v1/admin/loyalty/review-rewards', '/loyalty');
const reviewRewardsToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/review-rewards/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};

// ── Section 4: Product Cashback ─────────────────────────────────────

async function productCashback(req, res) {
    let pc = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage product cashback.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/product-cashback' + companyQS(res));
            if (r && r.body && r.body.status === 200) { pc = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load product cashback.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/product-cashback', {
        page_title:  'Product Cashback',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'product-cashback',
        extra_js:    '/js/pages/loyalty.js',
        pc,
        load_error,
    });
}

const productCashbackSave   = proxyPost('/api/v1/admin/loyalty/product-cashback', '/loyalty');
const productCashbackToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/product-cashback/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};
async function productCashbackDelete(req, res) {
    const id = req.body && req.body.id;
    let apiRes;
    try { apiRes = await callApi(req, 'DELETE', '/api/v1/admin/loyalty/product-cashback/' + encodeURIComponent(id) + companyQS(res)); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the rule.');
    return res.redirect('/loyalty');
}

// ── Section 7: Buy X Get Y (BOGO) ───────────────────────────────────

async function bogof(req, res) {
    let bg = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage Buy X Get Y offers.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/bogof' + companyQS(res));
            if (r && r.body && r.body.status === 200) { bg = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load BOGO offers.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/bogof', {
        page_title:  'Buy X Get Y',
        _layoutFile: '../_layout',
        active_nav:  'loyalty',
        active_sub:  'bogof',
        extra_js:    '/js/pages/loyalty.js',
        bg,
        load_error,
    });
}

const bogofSave   = proxyPost('/api/v1/admin/loyalty/bogof', '/loyalty');
const bogofToggle = async function (req, res) {
    const status = CC.parseToggleStatus(req);
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/bogof/toggle', { company_id: activeCompanyId(res), status }); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update the setting.');
    return res.redirect('/loyalty');
};
async function bogofDelete(req, res) {
    const id = req.body && req.body.id;
    let apiRes;
    try { apiRes = await callApi(req, 'DELETE', '/api/v1/admin/loyalty/bogof/' + encodeURIComponent(id) + companyQS(res)); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the offer.');
    return res.redirect('/loyalty');
}

// ── Review CMS Pages (per review/share type) ────────────────────────

async function cmsPages(req, res) {
    let cms = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage review CMS pages.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/loyalty/cms-pages' + companyQS(res));
            if (r && r.body && r.body.status === 200) { cms = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load review CMS pages.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('loyalty/cms-pages', {
        page_title:  'Review CMS Pages',
        _layoutFile: '../_layout',
        active_nav:  'cms',
        active_sub:  'cms-pages',
        extra_js:    '/js/pages/cms-editor.js',
        cms,
        load_error,
    });
}

// Called after cmsUploadMw has (optionally) written the screenshot; forwards
// the text fields + any uploaded filename to the api.
async function cmsPageSave(req, res) {
    const body = {
        company_id:       activeCompanyId(res),
        review_type_slug: req.body && req.body.review_type_slug,
        title:            req.body && req.body.title,
        description:      req.body && req.body.description,
    };
    if (req.file && req.file.filename) { body.screenshot = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/loyalty/cms-pages', body); }
    catch (e) { apiRes = null; }

    // The tabbed editor saves each tab via fetch/FormData → reply with JSON so
    // it can toast + stay on the tab. Non-AJAX posts keep the flash + redirect.
    const isAjax = (req.get('X-Requested-With') === 'fetch') || (req.get('Accept') || '').indexOf('application/json') !== -1;
    if (isAjax) {
        const payload = (apiRes && apiRes.body) || { status: 0, msg: 'Could not reach the server.' };
        return res.status(200).json(payload);
    }
    flashFromApi(req, apiRes, 'Could not save the CMS page.');
    return res.redirect('/loyalty/cms-pages');
}

module.exports = {
    loyaltyDashboard, loyaltyConfig, masterToggle, companyConfigSave, saveAll,
    cashbackRules, cashbackSave, cashbackDelete, cashbackToggle, configSave,
    tierConfig, tierSave, tierToggle,
    referralStreak, referralSave, referralToggle, streakSave, streakToggle, streakDelete,
    challenges, challengesSave, challengesToggle,
    events, eventsSave, eventsToggle,
    reviewClaims, reviewApprove, reviewReject,
    segments,
    specialOffer, specialOfferSave, specialOfferToggle, specialOfferDelete,
    reviewRewards, reviewRewardsSave, reviewRewardsToggle,
    productCashback, productCashbackSave, productCashbackToggle, productCashbackDelete,
    bogof, bogofSave, bogofToggle, bogofDelete,
    cmsPages, cmsPageSave,
};
