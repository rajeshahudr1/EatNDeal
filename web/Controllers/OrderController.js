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

module.exports = { place, confirmation, detailPage, ordersPage, list, status };
