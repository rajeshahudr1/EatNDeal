'use strict';

/**
 * Controllers/CartController.js
 *
 * What:  Cart routes — both the rendered cart PAGE and the JSON proxy the
 *        browser polls after each write. customer_id is injected from the
 *        session so the client can't spoof another customer.
 *
 *        Phase 2A.3 ships ONLY the read path:
 *
 *          GET /cart       → renders views/cart/index.ejs with the cart
 *                            already loaded server-side (one round trip,
 *                            no client-side fetch needed for the first paint).
 *          GET /cart/data  → JSON envelope of the same cart, for client-
 *                            side refresh after item add / remove (used by
 *                            Phase 2A.4+).
 *
 *        Auth: required on every entry. Unauthenticated visitors get
 *              bounced to /signin?next=/cart so they land back here.
 */

const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

// Context-specific 401 wording — kept tiny via the shared helper.
const needUser = (req, res) => requireUser(req, res, 'Please sign in to view your cart.');

/**
 * fetchCart
 *
 * What:  Calls the api, returns the parsed envelope OR null on network
 *        error. Used by both the page renderer and the JSON proxy so the
 *        upstream call is implemented once.
 */
async function fetchCart(req, customerId) {
    const qs = new URLSearchParams({ customer_id: String(customerId) });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/cart?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return null; }
    return apiRes.body;
}

/**
 * fetchAddresses — pulls the customer's saved address book for the cart
 * page. Empty array when none / network failure (cart page still works).
 */
async function fetchAddresses(req, customerId) {
    const qs = new URLSearchParams({ customer_id: String(customerId) });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/addresses?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return []; }
    return (apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.addresses) || [];
}

/**
 * fetchPaymentMethods — saved Stripe cards (one-click payment at the
 * checkout popup). Empty array when Stripe isn't configured / customer
 * has none / network failure.
 */
async function fetchPaymentMethods(req, customerId) {
    const qs = new URLSearchParams({ customer_id: String(customerId) });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/payment-methods?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return []; }
    return (apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.paymentMethods) || [];
}

/**
 * fetchPromotions — redeemable coupons for the cart's restaurant, so
 * the Promotions row can show the count + the popup can list them at
 * first paint. Empty array on no-cart / failure.
 */
async function fetchPromotions(req, customerId) {
    const qs = new URLSearchParams({ customer_id: String(customerId) });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/cart/promotions?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return []; }
    return (apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.promotions) || [];
}

/**
 * fetchRestaurantForCart — looks up the restaurant card shape (banner,
 * name, address, slug) for the cart's company so the right-column chip
 * can link back. Reuses /api/v1/marketplace/restaurant?id=. Returns
 * null when the cart has no companyId or the call fails.
 */
async function fetchRestaurantForCart(req, companyId, customerId) {
    if (!companyId) { return null; }
    const qs = new URLSearchParams({ id: String(companyId) });
    if (customerId) { qs.set('customer_id', String(customerId)); }
    const apiRes = await callApi(req, 'GET', '/api/v1/marketplace/restaurant?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return null; }
    if (apiRes.body.status !== 200 || !apiRes.body.data) { return null; }
    return apiRes.body.data.restaurant || null;
}

/**
 * page — GET /cart
 *
 * Renders the cart EJS view. Customer must be signed in (any guest is
 * sent to /signin?next=/cart). The cart payload + the saved-address
 * book are loaded server-side and passed as render locals so the first
 * paint is data-ready.
 */
async function page(req, res, next) {
    try {
        const user = (req.session && req.session.user) || null;
        if (!user) {
            return res.redirect('/signin?next=' + encodeURIComponent('/cart'));
        }

        // Cart + addresses + saved cards + promos in parallel
        // (independent API calls — failure of any one degrades
        // gracefully, the page still renders).
        const [env, addresses, paymentMethods, promotions] = await Promise.all([
            fetchCart(req, user.id),
            fetchAddresses(req, user.id),
            fetchPaymentMethods(req, user.id),
            fetchPromotions(req, user.id),
        ]);
        const cart     = (env && env.status === 200 && env.data && env.data.cart)     || null;
        const warnings = (env && env.status === 200 && env.data && env.data.warnings) || [];

        // Restaurant lookup depends on cart, so chain it after the
        // first batch. Cheap: only fires when a cart exists.
        const restaurant = cart && cart.companyId
            ? await fetchRestaurantForCart(req, cart.companyId, user.id)
            : null;

        // Keep the session-cached header count in sync with what we
        // just fetched (cart=null means the customer has no open cart).
        if (req.session) {
            req.session.cartCount = cart ? (Number(cart.totalQty) || 0) : 0;
        }

        // No page-specific JS — cart interactions live in the global
        // /js/ui/cart.js module loaded by the layout, plus the new
        // /js/ui/checkout-popups.js for the redesigned popup actions.
        return res.render('cart/index', {
            page_title:       'Your Cart',
            _layoutFile:      '../_layout',
            active_nav:       'cart',
            show_promo_strip: false,
            cart,
            cart_warnings:    warnings,
            cart_addresses:   addresses,
            cart_payment_methods: paymentMethods,
            cart_restaurant:  restaurant,
            cart_promotions:  promotions,
        });
    } catch (err) {
        next(err);
    }
}

/**
 * data — GET /cart/data
 * JSON pass-through for client-side refresh.
 */
async function data(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const apiRes = await callApi(req, 'GET',
        '/api/v1/customer/cart?customer_id=' + encodeURIComponent(user.id));
    syncSessionCount(req, apiRes);
    return relay(res, apiRes);
}

/**
 * promotions — GET /cart/promotions
 * JSON pass-through: the redeemable coupons for the cart's restaurant.
 */
async function promotions(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const apiRes = await callApi(req, 'GET',
        '/api/v1/customer/cart/promotions?customer_id=' + encodeURIComponent(user.id));
    return relay(res, apiRes);
}

/**
 * count — GET /cart/count
 *
 * What:  Lightweight cart-count probe. Used by the global cart UI module
 *        as a safety-net after every cart write: even if the write
 *        response was missing/malformed, we re-pull the canonical count
 *        from the server so the header badge can never go stale.
 *        Returns `{count: N}` always (0 when no open cart / not signed
 *        in), so the client never has to branch on errors.
 */
async function count(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) {
        return res.status(200).json({ status: 200, show: false, msg: 'success', data: { count: 0 } });
    }
    const apiRes = await callApi(req, 'GET',
        '/api/v1/customer/cart/count?customer_id=' + encodeURIComponent(user.id));
    if (apiRes && apiRes.body && apiRes.body.status === 200 && apiRes.body.data) {
        // Mirror into session so subsequent page renders read the same
        // value without an additional round trip.
        if (req.session && typeof apiRes.body.data.count === 'number') {
            req.session.cartCount = apiRes.body.data.count;
        }
        return res.status(200).json(apiRes.body);
    }
    // Network blip: don't fail the badge over it — return last-known.
    const cached = (req.session && Number(req.session.cartCount)) || 0;
    return res.status(200).json({ status: 200, show: false, msg: 'success', data: { count: cached } });
}

/**
 * syncSessionCount
 *
 * What:  Inspects an API cart envelope and snapshots the new cart.totalQty
 *        into req.session.cartCount so every following page render
 *        already knows the header badge value without an extra round
 *        trip. No-op when the envelope didn't carry a cart payload (the
 *        helper is called from every write path, some of which fail).
 *
 *        Lives here (not in authProxy) because only the cart endpoints
 *        return a cart shape with totalQty.
 * Type:  WRITE (mutates req.session).
 */
function syncSessionCount(req, apiRes) {
    if (!req.session || !apiRes || !apiRes.body || apiRes.body.status !== 200) { return; }
    const cart = apiRes.body.data && apiRes.body.data.cart;
    if (cart && typeof cart.totalQty === 'number') {
        req.session.cartCount = cart.totalQty;
    } else if (cart === null) {
        // /cart returns cart=null when the open cart was cleared.
        req.session.cartCount = 0;
    }
}

/**
 * forwardWrite
 *
 * What:  Generic POST proxy for every cart-write endpoint. The body is
 *        passed through unchanged after customer_id is injected from the
 *        session — the api validates each field per route.
 * Why:   add / update-qty / remove-item / clear all do the same auth +
 *        inject + forward dance. One helper keeps the surface tiny.
 */
async function forwardWrite(req, res, apiPath) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = Object.assign({}, req.body, { customer_id: user.id });
    const apiRes  = await callApi(req, 'POST', apiPath, payload);
    syncSessionCount(req, apiRes);
    return relay(res, apiRes);
}

const add        = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/add');
const updateQty  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/update-qty');
const removeItem = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/remove-item');
const clear      = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/clear');
const setMode    = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/set-mode');
const setAddress  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/set-address');
const setSchedule  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/set-schedule');
const setInstructions = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/set-instructions');
const applyCoupon  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/apply-coupon');
const removeCoupon = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/remove-coupon');
const applyVoucher  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/apply-voucher');
const removeVoucher = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/remove-voucher');
const applyLoyalty  = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/apply-loyalty');
const removeLoyalty = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/remove-loyalty');
const setCharity   = (req, res) => forwardWrite(req, res, '/api/v1/customer/cart/set-charity');

module.exports = {
    page, data, count, promotions,
    add, updateQty, removeItem, clear,
    setMode, setAddress, setSchedule, setInstructions,
    applyCoupon, removeCoupon, applyVoucher, removeVoucher,
    applyLoyalty, removeLoyalty, setCharity,
};
