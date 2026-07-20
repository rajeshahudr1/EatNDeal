'use strict';

/*
 * Controllers/ReviewsController.js
 *
 * What:  Super-admin page for the MARKETPLACE's own public star-reviews —
 *        EatNDeal's twin of the legacy POS page /admin/pos/review-rating/index.
 *          GET  /reviews            → summary + review list + Add Review modal
 *          POST /reviews/save       → post a review by hand (3 fields)
 *          POST /reviews/reply      → public reply / Publish Online toggle
 *
 * Why:   A restaurant's reviews are managed on the legacy POS page. The
 *        marketplace has no POS, so its reviews (review_rating at company_id = 0)
 *        need their own screen. Super-admin only — mounted behind
 *        requireSuperPage in admin/index.js, and the api re-checks with
 *        requireSuperAdmin (the client is never trusted).
 *
 * Used:  admin/index.js
 *
 * Change log:
 *   2026-07-15 — initial.
 */

const { callApi }  = require('../Helpers/apiClient');
const CC           = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

/**
 * list — GET /reviews?q=&status=&rating=
 * Renders the summary band (avg + 5..1 bars) and the review cards.
 *
 * The three filters are just forwarded to the api, which does the actual
 * narrowing — the admin layer never touches the DB. They round-trip through the
 * URL (a GET form, like every other admin list) so a filtered view is
 * shareable, bookmarkable and survives the reload that a reply/publish does.
 */
async function list(req, res) {
    let data = null;
    let load_error = null;

    const params = [];
    ['q', 'status', 'rating'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') {
            params.push(k + '=' + encodeURIComponent(String(req.query[k])));
        }
    });
    const url = '/api/v1/admin/reviews' + (params.length ? ('?' + params.join('&')) : '');

    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200 && r.body.data) { data = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load the reviews.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('reviews/index', {
        page_title:  'Reviews',
        _layoutFile: '../_layout',
        active_nav:  'reviews',
        extra_js:    '/js/pages/reviews.js',
        reviews:     (data && data.reviews) || [],
        total:       (data && data.total) || 0,
        showing:     (data && data.showing) || 0,
        filtered:    Boolean(data && data.filtered),
        avg_all:     (data && data.avg_all) || 0,
        avg_public:  (data && data.avg_public) || 0,
        buckets:     (data && data.buckets) || { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        search_q:    req.query.q ? String(req.query.q) : '',
        cur_status:  req.query.status ? String(req.query.status) : '',
        cur_rating:  req.query.rating ? String(req.query.rating) : '',
        load_error,
    });
}

/**
 * save — POST /reviews/save
 * The Add Review modal. The api validates (name + text required, rating 1..5)
 * and returns the legacy wording, so we just surface its message.
 */
async function save(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/reviews', req.body || {}); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Failed to save review');
    return res.redirect('/reviews');
}

/**
 * reply — POST /reviews/reply
 * Public reply and/or the Publish Online toggle (both optional — one endpoint,
 * like legacy update-reply). Answers JSON: the toggle saves without a reload.
 */
async function reply(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/reviews/reply', req.body || {}); }
    catch (e) { apiRes = null; }
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        return res.status(200).json({ status: 200, show: true, msg: body.msg || 'Review updated successfully' });
    }
    return res.status(200).json({
        status: (body && body.status) || 500,
        show:   true,
        msg:    (body && body.msg) || 'Something went wrong',
    });
}

module.exports = { list, save, reply };
