'use strict';

/**
 * Controllers/MerchantController.js
 *
 * What:  Merchant dashboard routes — page renderer + JSON proxies.
 *
 *          GET  /merchant                 → renders the orders dashboard
 *          GET  /merchant/orders/data     → JSON proxy (used by polling)
 *          POST /merchant/order/advance   → status transition proxy
 *
 *        Auth happens api-side via the staff allowlist
 *        (Helpers/merchant.companyForStaff). The web layer just injects
 *        customer_id from the session.
 */

const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

const needUser = (req, res) => requireUser(req, res, 'Please sign in to access the merchant dashboard.');

/**
 * dashboardPage — GET /merchant
 *
 * Server-renders the orders dashboard with the FIRST list pre-loaded
 * (state=live). Subsequent state switches + polling refreshes hit
 * /merchant/orders/data without a full page reload.
 */
async function dashboardPage(req, res, next) {
    try {
        const user = (req.session && req.session.user) || null;
        if (!user) {
            return res.redirect('/signin?next=' + encodeURIComponent('/merchant'));
        }
        const state = String(req.query.state || 'live');
        const qs = new URLSearchParams({ customer_id: String(user.id), state });
        const apiRes = await callApi(req, 'GET', '/api/v1/merchant/orders?' + qs.toString());

        // Non-200 (e.g. 403 not-staff) → render the dashboard in an
        // "access denied" state instead of crashing the page.
        if (!apiRes || !apiRes.body || apiRes.body.status !== 200) {
            return res.render('merchant/orders', {
                page_title:       'Merchant',
                _layoutFile:      '../_layout',
                active_nav:       'merchant',
                show_promo_strip: false,
                orders:           [],
                state,
                blocked:          true,
                blockedMsg:       (apiRes && apiRes.body && apiRes.body.msg) || 'You do not have merchant access.',
            });
        }

        return res.render('merchant/orders', {
            page_title:       'Merchant — incoming orders',
            _layoutFile:      '../_layout',
            active_nav:       'merchant',
            show_promo_strip: false,
            orders:           (apiRes.body.data && apiRes.body.data.orders) || [],
            state,
            blocked:          false,
            blockedMsg:       '',
        });
    } catch (err) { next(err); }
}

/**
 * ordersData — GET /merchant/orders/data
 * JSON proxy for polling + state switches.
 */
async function ordersData(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    if (req.query.state)  { qs.set('state',  String(req.query.state)); }
    if (req.query.limit)  { qs.set('limit',  String(req.query.limit)); }
    if (req.query.offset) { qs.set('offset', String(req.query.offset)); }
    const apiRes = await callApi(req, 'GET', '/api/v1/merchant/orders?' + qs.toString());
    return relay(res, apiRes);
}

/**
 * advance — POST /merchant/order/advance
 * Forwards to the api with customer_id injected from the session.
 */
async function advance(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = Object.assign({}, req.body, { customer_id: user.id });
    const apiRes  = await callApi(req, 'POST', '/api/v1/merchant/order/advance', payload);
    return relay(res, apiRes);
}

/**
 * detailPage — GET /merchant/order/:id
 *
 * Full receipt view for one order on the merchant side. Same auth chain
 * as the dashboard (api gates on the staff allowlist). 404 + blocked
 * states render in the same shell so navigation stays consistent.
 */
async function detailPage(req, res, next) {
    try {
        const user = (req.session && req.session.user) || null;
        if (!user) {
            const here = '/merchant/order/' + encodeURIComponent(req.params.id || '');
            return res.redirect('/signin?next=' + encodeURIComponent(here));
        }
        const orderId = String(req.params.id || '').replace(/[^0-9]/g, '');
        if (!orderId) {
            return res.status(404).render('merchant/order-detail', {
                page_title:       'Order not found',
                _layoutFile:      '../_layout',
                active_nav:       'merchant',
                show_promo_strip: false,
                order:            null,
                blocked:          false,
            });
        }
        const qs = new URLSearchParams({ customer_id: String(user.id), id: orderId });
        const apiRes = await callApi(req, 'GET', '/api/v1/merchant/order?' + qs.toString());

        if (!apiRes || !apiRes.body) {
            return next(new Error('merchant detail upstream failed'));
        }
        // Staff-allowlist rejection → render the blocked shell so the
        // merchant nav stays consistent across all /merchant/* pages.
        if (apiRes.body.status === 403) {
            return res.render('merchant/order-detail', {
                page_title:       'Merchant',
                _layoutFile:      '../_layout',
                active_nav:       'merchant',
                show_promo_strip: false,
                order:            null,
                blocked:          true,
                blockedMsg:       apiRes.body.msg || 'You do not have merchant access.',
            });
        }
        const order = (apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.order) || null;
        return res.render('merchant/order-detail', {
            page_title:       order ? ('Order #' + (order.number || order.id)) : 'Order not found',
            _layoutFile:      '../_layout',
            active_nav:       'merchant',
            show_promo_strip: false,
            order,
            blocked:          false,
        });
    } catch (err) { next(err); }
}

module.exports = { dashboardPage, ordersData, advance, detailPage };
