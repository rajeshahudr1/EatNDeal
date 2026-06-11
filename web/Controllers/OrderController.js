'use strict';

/**
 * Controllers/OrderController.js
 *
 * What:  Marketplace order routes — proxies to the api + the basic
 *        confirmation page after a successful place.
 *
 *          POST /order/place       → JSON proxy to /api/v1/customer/order/place
 *          GET  /order/:id/confirm → renders views/order/confirmation.ejs
 *                                    (Phase-2D stub; Phase-2E expands to
 *                                     a full tracker)
 *
 *        Both routes are login-required.
 */

const fs                     = require('node:fs');
const path                   = require('node:path');
const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

const needUser = (req, res) => requireUser(req, res, 'Please sign in to place an order.');

/**
 * place — POST /order/place
 *
 * Forwards to the api with customer_id injected from the session. The
 * api returns the new order summary; the client redirects to the
 * confirmation page on success.
 */
async function place(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = Object.assign({}, req.body, { customer_id: user.id });
    const apiRes  = await callApi(req, 'POST', '/api/v1/customer/order/place', payload);
    return relay(res, apiRes);
}

/**
 * confirmation — GET /order/:id/confirm
 *
 * Phase-2D stub. Renders "Order placed — #N" with CTAs to the detail
 * page + back to home.
 */
function confirmation(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) {
        return res.redirect('/signin?next=' + encodeURIComponent('/'));
    }
    const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
    return res.render('order/confirmation', {
        page_title:       'Order placed',
        _layoutFile:      '../_layout',
        active_nav:       'orders',
        show_promo_strip: false,
        order_id:         orderId,
    });
}

/**
 * detailPage — GET /order/:id
 *
 * Renders views/order/detail.ejs server-rendered (order payload loaded
 * via the api, customer_id injected from the session). 404 page when
 * the order isn't this customer's or isn't a marketplace row.
 */
async function detailPage(req, res, next) {
    try {
        const user = (req.session && req.session.user) || null;
        if (!user) {
            const here = '/order/' + encodeURIComponent(req.params.id || '');
            return res.redirect('/signin?next=' + encodeURIComponent(here));
        }
        const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
        if (!orderId) { return res.status(404).render('errors/404'); }

        const qs = new URLSearchParams({ customer_id: String(user.id), id: orderId });
        const apiRes = await callApi(req, 'GET', '/api/v1/customer/order?' + qs.toString());
        const order = (apiRes && apiRes.body && apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.order) || null;
        if (!order) {
            return res.status(404).render('order/detail', {
                page_title:       'Order not found',
                _layoutFile:      '../_layout',
                active_nav:       'orders',
                show_promo_strip: false,
                order:            null,
            });
        }
        return res.render('order/detail', {
            page_title:       'Order #' + (order.number || order.id),
            _layoutFile:      '../_layout',
            active_nav:       'orders',
            show_promo_strip: false,
            order,
        });
    } catch (err) { next(err); }
}

/**
 * ordersPage — GET /orders
 *
 * The bottom-nav "Orders" tab. The full order-history list already lives
 * on the account page's Orders tab (account/index.ejs renders the live
 * .orders-list from the same /api/v1/customer/orders feed), so rather
 * than duplicate that markup + fetch we make /orders a stable shortcut
 * that lands on /account?tab=orders. Guests bounce through /signin first,
 * then return straight to the orders tab.
 */
function ordersPage(req, res) {
    const user = (req.session && req.session.user) || null;
    const dest = '/account?tab=orders';
    if (!user) {
        return res.redirect('/signin?next=' + encodeURIComponent(dest));
    }
    return res.redirect(dest);
}

/**
 * list — GET /orders/data
 *
 * JSON proxy used by the account page's Orders tab (when we hydrate
 * client-side) + by any future "Order history" page that wants the
 * raw list.
 */
async function list(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    if (req.query.limit)  { qs.set('limit',  String(req.query.limit)); }
    if (req.query.offset) { qs.set('offset', String(req.query.offset)); }
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/orders?' + qs.toString());
    return relay(res, apiRes);
}

/**
 * status — GET /order/:id/status
 *
 * Slim JSON pass-through used by /js/ui/order-track.js for polling.
 * customer_id is injected from session so the client can't poll someone
 * else's order id.
 */
async function status(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
    if (!orderId) {
        return res.status(200).json({ status: 404, show: false, msg: 'Order not found.' });
    }
    const qs = new URLSearchParams({ customer_id: String(user.id), id: orderId });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/order/status?' + qs.toString());
    return relay(res, apiRes);
}

/**
 * reorder — POST /order/:id/reorder
 *
 * Clones a past order into a fresh cart (api does the work). order_id
 * comes from the URL; customer_id is injected from the session. Relays
 * the JSON envelope; the client redirects to /cart on success.
 */
async function reorder(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = { customer_id: user.id, order_id: String(req.params.id || '').replace(/[^0-9]/g, '') };
    const apiRes  = await callApi(req, 'POST', '/api/v1/customer/order/reorder', payload);
    return relay(res, apiRes);
}

/**
 * submitReview — POST /order/:id/review  (multipart)
 *
 * multer (in index.js) has already stored the optional food photo on the
 * web disk + set req.file; rating + text arrive in req.body. We forward
 * { customer_id, order_id, rating, review, photo } to the api. On a failed
 * save we bin the orphaned upload so the folder doesn't grow. Returns the
 * api JSON envelope (the order page's review JS reads data.review).
 */
async function submitReview(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) { return res.status(200).json({ status: 401, show: true, msg: 'Please sign in to leave a review.' }); }

    const orderId   = String(req.params.id || '').replace(/[^0-9]/g, '');
    const photoPath = req.file ? '/review-images/' + req.file.filename : '';

    const payload = {
        customer_id: user.id,
        order_id:    orderId,
        rating:      Number((req.body && req.body.rating) || 0),
        review:      String((req.body && req.body.review) || '').trim(),
    };
    // Only send a photo when a NEW one was uploaded — omitting it on an edit
    // keeps whatever photo was there before.
    if (photoPath) { payload.photo = photoPath; }

    const apiRes = await callApi(req, 'POST', '/api/v1/customer/review', payload);
    const body   = apiRes.body || {};
    if (body.status !== 200 && req.file) {
        try { fs.unlinkSync(path.join(__dirname, '..', 'runtime', 'review-images', req.file.filename)); } catch (e) { /* ignore */ }
    }
    return relay(res, apiRes);
}

/**
 * reportIssue — POST /order/:id/report-issue
 *
 * Forwards the customer's order-issue note to the api (→ epos_complaints).
 */
async function reportIssue(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = {
        customer_id: user.id,
        order_id:    String(req.params.id || '').replace(/[^0-9]/g, ''),
        notes:       String((req.body && req.body.notes) || '').trim(),
    };
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/order/report-issue', payload);
    return relay(res, apiRes);
}

/**
 * issueResponse — GET /order/:id/issue-response
 *
 * Slim pass-through the order page polls for the restaurant's reply.
 */
async function issueResponse(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
    const qs = new URLSearchParams({ customer_id: String(user.id), order_id: orderId });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/order/issue-response?' + qs.toString());
    return relay(res, apiRes);
}

/**
 * receipt — GET /order/:id/receipt
 *
 * Standalone (bare) printable receipt for one order — the marketplace
 * equivalent of the legacy Mpdf receipt. Customer prints / saves as PDF
 * from the browser (Ctrl+P). Same order payload as the detail page.
 */
async function receipt(req, res, next) {
    try {
        const user = (req.session && req.session.user) || null;
        if (!user) {
            const here = '/order/' + encodeURIComponent(req.params.id || '') + '/receipt';
            return res.redirect('/signin?next=' + encodeURIComponent(here));
        }
        const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
        if (!orderId) { return res.status(404).render('errors/404'); }
        const qs = new URLSearchParams({ customer_id: String(user.id), id: orderId });
        const apiRes = await callApi(req, 'GET', '/api/v1/customer/order?' + qs.toString());
        const order = (apiRes && apiRes.body && apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.order) || null;
        if (!order) { return res.status(404).render('errors/404'); }
        return res.render('order/receipt', {
            page_title:       'Receipt — ' + (order.number || order.id),
            _layoutFile:      '../_layout',
            bare:             true,            // no header/footer/nav — clean print page
            show_promo_strip: false,
            order,
        });
    } catch (err) { next(err); }
}

/**
 * submitCashbackReview — POST /review-cashback  (multipart)
 *
 * A customer uploads a screenshot of an external (Google/Facebook) review to
 * earn cashback. multer stored the screenshot; we forward the path +
 * company to the api (→ customer_review, pending POS approval), then redirect
 * back to the restaurant page with a flash message.
 */
async function submitCashbackReview(req, res) {
    const user = (req.session && req.session.user) || null;
    const back = String((req.body && req.body.redirect) || req.get('referer') || '/');
    if (!user) { return res.redirect('/signin?next=' + encodeURIComponent(back)); }

    // Most types upload a screenshot; the Live Video type sends a video URL
    // instead (stored as-is in review_photo, like the legacy flow).
    const photoPath = req.file ? '/review-images/' + req.file.filename : String((req.body && req.body.video_url) || '').trim();
    const payload = {
        customer_id: user.id,
        company_id:  String((req.body && req.body.company_id) || '').replace(/[^0-9]/g, ''),
        review_type: Number((req.body && req.body.review_type) || 1),
        notes:       String((req.body && req.body.notes) || '').trim(),
        photo:       photoPath,
    };
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/review-cashback', payload);
    const body   = apiRes.body || {};
    if (body.status !== 200 && req.file) {
        try { fs.unlinkSync(path.join(__dirname, '..', 'runtime', 'review-images', req.file.filename)); } catch (e) { /* ignore */ }
    }
    if (req.flash) {
        req.flash(body.status === 200 ? 'success' : 'error', body.msg || (body.status === 200 ? 'Review submitted.' : 'Could not submit your review.'));
    }
    return res.redirect(back);
}

module.exports = { place, confirmation, detailPage, ordersPage, list, status, reorder, submitReview, reportIssue, issueResponse, receipt, submitCashbackReview };
