'use strict';

/*
 * Controllers/EarnController.js
 *
 * What:  The customer "Earn Cashback" page (/earn) — the proper, multi-type
 *        version of the legacy webordering review-type screen. The customer
 *        reviews or shares a restaurant on an external platform (Google,
 *        Facebook, TikTok, Instagram, WhatsApp, a live video, …) and uploads
 *        proof to earn that restaurant's configured cashback once the POS
 *        approves it.
 *
 *        ?company= → that restaurant's offered review/share types, each with
 *        the admin CMS instructions + example screenshot + reward amount + the
 *        customer's current claim status. No ?company= → the picker: the
 *        restaurants currently offering review cashback. ?DiningMode= is
 *        passed through (legacy context). Submitting posts to the existing
 *        POST /review-cashback (OrderController.submitCashbackReview).
 * Type:  READ (proxies the JWT-gated /customer/loyalty/review-types endpoint).
 * Used:  web/index.js — GET /earn.
 */

const { callApi } = require('../Helpers/apiClient');

// Pull the review-types payload from the api (types when a restaurant is
// chosen, else the restaurant picker). Never throws — renders empty on error.
async function fetchReviewTypes(req, user, company) {
    try {
        const params = new URLSearchParams({ customer_id: String(user.id) });
        if (company) { params.set('company_id', String(company)); }
        const r = await callApi(req, 'GET', '/api/v1/customer/loyalty/review-types?' + params.toString());
        if (r && r.body && r.body.status === 200 && r.body.data) { return r.body.data; }
    } catch (e) { /* fall through to empty */ }
    return { company: null, masterOn: false, types: [], restaurants: [] };
}

// GET /earn — the full page (picker or per-restaurant types).
async function earnPage(req, res) {
    const user = (req.session && req.session.user) || null;
    const company = req.query.company ? String(req.query.company).replace(/[^0-9]/g, '') : '';
    const back = '/earn' + (company ? '?company=' + encodeURIComponent(company) : '');
    if (!user) { return res.redirect('/signin?next=' + encodeURIComponent(back)); }

    const data = await fetchReviewTypes(req, user, company);

    return res.render('earn/index', {
        page_title:       'Earn Cashback',
        _layoutFile:      '../_layout',
        active_nav:       'profile',
        extra_js:         '/js/pages/earn.js',
        show_promo_strip: false,
        bare:             false,
        earn:             data,
        earn_company:     company,
        earn_dining:      req.query.DiningMode ? String(req.query.DiningMode) : '',
    });
}

module.exports = { earnPage };
