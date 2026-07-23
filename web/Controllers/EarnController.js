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
// chosen, else the restaurant picker). `slug` is the PUBLIC restaurant slug —
// the api resolves it to the company server-side, so the customer URL never
// carries the numeric company id. Never throws — renders empty on error.
async function fetchReviewTypes(req, user, slug) {
    try {
        const params = new URLSearchParams({ customer_id: String(user.id) });
        if (slug) { params.set('slug', String(slug)); }
        const r = await callApi(req, 'GET', '/api/v1/customer/loyalty/review-types?' + params.toString());
        if (r && r.body && r.body.status === 200 && r.body.data) { return r.body.data; }
    } catch (e) { /* fall through to empty */ }
    return { company: null, masterOn: false, types: [], restaurants: [] };
}

// GET /earn — the full page (picker or per-restaurant types).
async function earnPage(req, res) {
    const user = (req.session && req.session.user) || null;
    // Public URL carries the restaurant SLUG (/earn?restaurant=<slug>), never
    // the numeric company id. Slug charset matches M.slugify's output.
    const slug = req.query.restaurant ? String(req.query.restaurant).trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : '';
    const back = '/earn' + (slug ? '?restaurant=' + encodeURIComponent(slug) : '');
    if (!user) { return res.redirect('/signin?next=' + encodeURIComponent(back)); }
    // Loyalty master OFF (super-admin) → surface hidden, same as the nav.
    if (res.locals.loyalty_enabled === false) { return res.redirect('/account'); }

    const data = await fetchReviewTypes(req, user, slug);

    return res.render('earn/index', {
        page_title:       'Earn Cashback',
        _layoutFile:      '../_layout',
        active_nav:       'profile',
        extra_js:         '/js/pages/earn.js',
        show_promo_strip: false,
        bare:             false,
        earn:             data,
        earn_company:     slug,          // truthy → render the per-restaurant view
        earn_slug:        slug,
        earn_dining:      req.query.DiningMode ? String(req.query.DiningMode) : '',
    });
}

module.exports = { earnPage };
