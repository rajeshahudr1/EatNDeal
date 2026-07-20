'use strict';

/*
 * Controllers/SiteReviewController.js
 *
 * What:  The customer-facing "Reviews" page (/reviews) — reviews of EATNDEAL
 *        ITSELF (the marketplace), not of any restaurant.
 *          GET  /reviews        → approved reviews + the average, and (signed
 *                                 in) the customer's own review to write/edit
 *          POST /reviews/submit → save the customer's review (lands PENDING)
 *
 * Why:   A restaurant's reviews live on its own page (review_rating scoped to
 *        that company). The marketplace's own reviews are scoped to
 *        company_id = 0, which no restaurant query can ever match — so without
 *        this page they'd be written in the admin and shown NOWHERE.
 *
 * Moderation: a customer's review is saved with publish_online = 0 and reaches
 *        OTHER people only once the super admin publishes it. The author is
 *        never told — the api merges their own pending review back into their
 *        copy of the list, so it reads as live to them and to nobody else.
 *
 * Used:  web/index.js
 *
 * Change log:
 *   2026-07-15 — initial.
 */

const { callApi } = require('../Helpers/apiClient');

// One batch of reviews. The api caps it at 50 too — this is the page's ask.
const PAGE = 50;

/**
 * apiQs — the site-reviews query string for a given caller + offset.
 * customer_id (when signed in) makes the api return `mine` and fold their own
 * pending review into the list; without it they'd see the public view.
 */
function apiQs(user, offset) {
    const p = ['limit=' + PAGE, 'offset=' + Math.max(0, Number(offset) || 0)];
    if (user) { p.push('customer_id=' + encodeURIComponent(user.id)); }
    return '?' + p.join('&');
}

/**
 * page — GET /reviews
 * Public: anyone can READ the approved reviews; writing needs a sign-in.
 * Renders the FIRST batch only; "View more" pulls the rest through more().
 */
async function page(req, res) {
    const user = (req.session && req.session.user) || null;

    let data = { reviews: [], average: 0, total: 0, mine: null, hasMore: false, nextOffset: 0 };
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/marketplace/site-reviews' + apiQs(user, 0));
        if (r && r.body && r.body.status === 200 && r.body.data) { data = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load the reviews.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    // Their own review — the form opens pre-filled so they EDIT rather than
    // write a duplicate (the api upserts one per customer).
    const mine = data.mine || null;

    return res.render('site-review/index', {
        page_title:       'Reviews',
        _layoutFile:      '../_layout',
        active_nav:       'profile',
        extra_js:         '/js/pages/site-review.js',
        show_promo_strip: false,
        bare:             false,
        reviews:          data.reviews || [],
        average:          data.average || 0,
        total:            data.total || 0,
        has_more:         !!data.hasMore,
        // Where the next batch starts. From the api, because the rendered list
        // can include the author's own pending review, which is NOT part of the
        // paged (approved-only) query and must not shift the offset.
        next_offset:      Number(data.nextOffset) || 0,
        mine,
        signed_in:        !!user,
        load_error,
    });
}

/**
 * more — GET /reviews/more?offset=
 * JSON proxy for the "View more" button, so the browser fetches from the web
 * origin (the api isn't reachable from the page — CSP, and no token there).
 * Mirrors SiteController.restaurantReviews, which does the same for the
 * restaurant page's reviews panel.
 */
async function more(req, res) {
    const user = (req.session && req.session.user) || null;
    try {
        const r = await callApi(req, 'GET',
            '/api/v1/marketplace/site-reviews' + apiQs(user, req.query.offset));
        return res.status(200).json((r && r.body) || { status: 502, show: false, msg: 'Could not load more reviews.' });
    } catch (e) {
        return res.status(200).json({ status: 500, show: false, msg: 'Could not load more reviews.' });
    }
}

/**
 * submit — POST /reviews/submit  { rating, review }
 * Sign-in required (a review is attributed to a real customer). Answers the
 * api envelope as JSON; the page JS shows the toast.
 */
async function submit(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) {
        return res.status(200).json({ status: 401, show: true, msg: 'Please sign in to leave a review.' });
    }
    let apiRes;
    try {
        apiRes = await callApi(req, 'POST', '/api/v1/customer/site-review',
            Object.assign({}, req.body, { customer_id: user.id }));
    } catch (e) { apiRes = null; }

    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        return res.status(200).json({ status: 200, show: true, msg: body.msg });
    }
    return res.status(200).json({
        status: (body && body.status) || 500,
        show:   true,
        msg:    (body && body.msg) || 'Could not save your review.',
    });
}

module.exports = { page, submit, more };
