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

const crypto                 = require('crypto');
const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

// Context-specific 401 wording — kept tiny via the shared helper.
const needUser = (req, res) => requireUser(req, res, 'Please sign in to view your cart.');

/**
 * cartOwner
 *
 * What:  Resolves who owns the cart for THIS request:
 *          • signed-in  → { customer_id }
 *          • guest      → { guest_id } (a stable session token we mint on
 *                         first use so a not-signed-in visitor can build a
 *                         cart; login is only required at checkout). Mirrors
 *                         legacy, which keys guest carts by a session localID.
 * Type:  WRITE (may mint req.session.guestId).
 */
function cartOwner(req) {
    const user = (req.session && req.session.user) || null;
    if (user) { return { customer_id: user.id }; }
    if (req.session) {
        if (!req.session.guestId) {
            // Alphanumeric token (matches the api guest_id validator).
            req.session.guestId = 'MPG' + crypto.randomBytes(15).toString('hex');
        }
        return { guest_id: req.session.guestId };
    }
    return {};
}

/**
 * claimGuestCart
 *
 * What:  Right after a visitor signs in, hand their GUEST cart to their
 *        account (api adopts it — sets user_id). Best-effort + one-shot:
 *        the guest token is cleared whether or not anything was adopted, so
 *        we never re-claim on later requests. Called at the top of the cart
 *        entry points (the user lands on /cart after the checkout login).
 * Type:  WRITE (mutates req.session + api).
 */
async function claimGuestCart(req) {
    if (!req.session || !req.session.user || !req.session.guestId) { return; }
    const guestId = req.session.guestId;
    try {
        const apiRes = await callApi(req, 'POST', '/api/v1/customer/cart/claim', {
            customer_id: req.session.user.id, guest_id: guestId,
        });
        syncSessionCount(req, apiRes);
    } catch (e) { /* best-effort — never block the page on a claim hiccup */ }
    delete req.session.guestId;
}

/**
 * fetchCart
 *
 * What:  Calls the api, returns the parsed envelope OR null on network
 *        error. Used by both the page renderer and the JSON proxy so the
 *        upstream call is implemented once.
 */
async function fetchCart(req, owner) {
    // owner = { customer_id } | { guest_id }
    const qs = new URLSearchParams(owner);
    applyBrowseLoc(req, qs);
    // Carry the header's Delivery/Pickup choice so the api can bring the cart
    // into line with it — picking Pickup on the home page and then opening the
    // cart used to show Delivery, because the cart kept its own serve_type.
    qs.set('serve_type', String(browseMode(req).serve_type));
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/cart?' + qs.toString());
    if (!apiRes || apiRes.networkError || !apiRes.body) { return null; }
    return apiRes.body;
}

/**
 * browseLoc / applyBrowseLoc
 *
 * What:  The customer's ACTIVE header location (req.session.userLocation) as
 *        loc_* fields, forwarded to the api cart endpoints. This makes the
 *        cart's delivery address + the "delivers here?" check follow the
 *        location shown at the TOP of the site — instead of the api silently
 *        falling back to a stale DEFAULT saved address. `browseLoc` returns an
 *        object (for POST bodies); `applyBrowseLoc` sets them on a query string.
 * Type:  READ.
 */
function browseLoc(req) {
    const l = (req.session && req.session.userLocation) || null;
    if (!l) { return {}; }
    const out = {};
    if (l.postcode) { out.loc_postcode = String(l.postcode); }
    if (l.label)    { out.loc_label    = String(l.label); }
    if (l.lat != null && l.lat !== '') { out.loc_lat = l.lat; }
    if (l.lng != null && l.lng !== '') { out.loc_lng = l.lng; }
    return out;
}
function applyBrowseLoc(req, qs) {
    const o = browseLoc(req);
    Object.keys(o).forEach((k) => qs.set(k, String(o[k])));
}

/**
 * browseMode — the customer's ACTIVE order mode (header Delivery/Pickup toggle,
 * stored in session.userLocation.mode) as a serve_type the api understands:
 * 2 = pickup / collection, 3 = delivery. Forwarded on ADD so a FRESH cart is
 * created in the mode the customer actually chose — otherwise every new cart
 * defaulted to delivery and the "doesn't deliver here" gate fired even for a
 * Collection order. Ignored by the api for an existing cart (mode changes then
 * go through /cart/set-mode).
 */
function browseMode(req) {
    const l = (req.session && req.session.userLocation) || null;
    return { serve_type: (l && l.mode === 'pickup') ? 2 : 3 };
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
        // If they JUST signed in (e.g. landed back here from checkout login),
        // adopt the cart they built as a guest before rendering.
        await claimGuestCart(req);

        const user  = (req.session && req.session.user) || null;
        const owner = cartOwner(req);
        if (!owner.customer_id && !owner.guest_id) {
            return res.redirect('/signin?next=' + encodeURIComponent('/cart'));
        }
        const isGuest = !owner.customer_id;

        // Cart always; the customer-only extras (saved addresses / cards /
        // promos) only when signed in — a guest has none, and login is asked
        // at checkout, not while browsing.
        const [env, addresses, paymentMethods, promotions] = await Promise.all([
            fetchCart(req, owner),
            isGuest ? Promise.resolve([]) : fetchAddresses(req, user.id),
            isGuest ? Promise.resolve([]) : fetchPaymentMethods(req, user.id),
            isGuest ? Promise.resolve([]) : fetchPromotions(req, user.id),
        ]);
        const cart     = (env && env.status === 200 && env.data && env.data.cart)     || null;
        const warnings = (env && env.status === 200 && env.data && env.data.warnings) || [];

        // Restaurant lookup depends on cart, so chain it after the
        // first batch. Cheap: only fires when a cart exists.
        const restaurant = cart && cart.companyId
            ? await fetchRestaurantForCart(req, cart.companyId, user ? user.id : null)
            : null;

        // Keep the session-cached header count in sync with what we
        // just fetched (cart=null means there's no open cart).
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
            cart_is_guest:    isGuest,
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
    await claimGuestCart(req);
    const owner = cartOwner(req);
    if (!owner.customer_id && !owner.guest_id) { return needUser(req, res); }
    const qs = new URLSearchParams(owner);
    applyBrowseLoc(req, qs);
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/cart?' + qs.toString());
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
    await claimGuestCart(req);
    const owner = cartOwner(req);
    if (!owner.customer_id && !owner.guest_id) {
        return res.status(200).json({ status: 200, show: false, msg: 'success', data: { count: 0 } });
    }
    const qs = new URLSearchParams(owner);
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/cart/count?' + qs.toString());
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
    await claimGuestCart(req);
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = Object.assign({}, req.body, { customer_id: user.id });
    const apiRes  = await callApi(req, 'POST', apiPath, payload);
    syncSessionCount(req, apiRes);
    return relay(res, apiRes);
}

/**
 * forwardGuestWrite
 *
 * What:  Cart-BUILD proxy that works for a GUEST as well as a signed-in
 *        customer — add / update-qty / remove-item / clear / set-mode. The
 *        owner ({customer_id} | {guest_id}) is injected; login is NOT
 *        required (that's only enforced at checkout). A just-signed-in guest
 *        cart is adopted first.
 */
async function forwardGuestWrite(req, res, apiPath) {
    await claimGuestCart(req);
    const owner = cartOwner(req);
    if (!owner.customer_id && !owner.guest_id) { return needUser(req, res); }
    const payload = Object.assign({}, req.body, owner);
    const apiRes  = await callApi(req, 'POST', apiPath, payload);
    syncSessionCount(req, apiRes);
    return relay(res, apiRes);
}

// Cart-build actions — guest-allowed (login only at checkout).
// `add` forwards the active header location so the api sets the cart's delivery
// address to it (the "delivers here?" check then follows the header pick, not a
// stale default saved address). Only the add schema accepts these loc_* fields.
const add        = (req, res) => {
    // Mode precedence: the frontend sends serve_type from the ACTIVE mode
    // control (restaurant tab / header toggle) → that wins; browseMode (the
    // session's remembered mode) is only the fallback when the client didn't
    // send one. browseLoc (header location) is always applied last.
    req.body = Object.assign({}, browseMode(req), req.body, browseLoc(req));
    return forwardGuestWrite(req, res, '/api/v1/customer/cart/add');
};
// Surprise Box ("Too Good To Go"). Its own api endpoint because the box is a
// VIRTUAL product on the branch row with no `products` row for /cart/add to
// look up. serve_type is FORCED to 2 (pickup): the box is collection-only and
// the api rejects anything else, so we never send the header's Delivery mode
// and turn a normal add into a confusing error.
const addSurpriseBox = (req, res) => {
    req.body = Object.assign({}, req.body, { serve_type: 2 });
    return forwardGuestWrite(req, res, '/api/v1/customer/cart/surprise-box');
};
const updateQty  = (req, res) => forwardGuestWrite(req, res, '/api/v1/customer/cart/update-qty');
const removeItem = (req, res) => forwardGuestWrite(req, res, '/api/v1/customer/cart/remove-item');
const clear      = (req, res) => forwardGuestWrite(req, res, '/api/v1/customer/cart/clear');
/**
 * setMode
 *
 * What:  Switches the cart between Delivery and Pickup AND moves the header
 *        toggle to match.
 * Why:   Order mode is ONE choice the customer makes, shown in three places
 *        (header toggle, restaurant tabs, cart). They each used to hold their
 *        own copy: picking Pickup on the home page then opening the cart
 *        showed Delivery, because the cart kept its own serve_type and the
 *        session kept its own mode. Writing both here — and reading the
 *        session on cart load (see `page`/`data`) — keeps the three in step.
 */
const setMode = async (req, res) => {
    const wanted = Number(req.body && req.body.serve_type) === 2 ? 'pickup' : 'delivery';
    const apiRes = await (async () => {
        await claimGuestCart(req);
        const owner = cartOwner(req);
        if (!owner.customer_id && !owner.guest_id) { return null; }
        const payload = Object.assign({}, req.body, owner);
        const r = await callApi(req, 'POST', '/api/v1/customer/cart/set-mode', payload);
        syncSessionCount(req, r);
        return r;
    })();
    if (!apiRes) { return needUser(req, res); }
    // Only follow a SUCCESSFUL switch — a refused one (e.g. a Surprise Box
    // pins the cart to Pickup) must not move the header.
    if (apiRes.body && apiRes.body.status === 200 && req.session) {
        req.session.userLocation = Object.assign({}, req.session.userLocation, { mode: wanted });
    }
    return relay(res, apiRes);
};
// Charge a saved card for the open cart. The api clones the card onto the
// restaurant's connected account and confirms ON-SESSION, so the reply may be
// `requires_action` (3-D Secure) rather than an outright success.
const paySavedCard = (req, res) => forwardWrite(req, res, '/api/v1/customer/payment/saved-card');

/**
 * setAddress
 *
 * What:  Applies a saved address to the cart AND moves the header location to
 *        match it.
 * Why:   The api treats the header location as the source of truth and rewrites
 *        the cart's address back to it on the next load (Helpers/cart.js
 *        ensureDefaultDeliveryAddress). Picking an address at checkout without
 *        moving the header therefore "bounced" — most visibly when the customer
 *        picked their DEFAULT address, which that code can't tell apart from an
 *        auto-attached one. Choosing a delivery address IS choosing where you
 *        are ordering to, so the two now stay in step.
 */
async function setAddress(req, res) {
    await claimGuestCart(req);
    const user = needUser(req, res);
    if (!user) { return; }

    const payload = Object.assign({}, req.body, { customer_id: user.id });
    const apiRes  = await callApi(req, 'POST', '/api/v1/customer/cart/set-address', payload);
    syncSessionCount(req, apiRes);

    // Only follow a SUCCESSFUL change — a rejected address must not move the
    // header location.
    if (apiRes && apiRes.body && apiRes.body.status === 200 && req.session) {
        const addr = apiRes.body.data && apiRes.body.data.cart;
        if (addr && addr.deliveryPostcode) {
            req.session.userLocation = Object.assign({}, req.session.userLocation, {
                postcode: addr.deliveryPostcode,
                label:    addr.deliveryLabel || addr.deliveryAddress || '',
                lat:      addr.deliveryLat != null ? addr.deliveryLat : null,
                lng:      addr.deliveryLng != null ? addr.deliveryLng : null,
            });
        }
    }
    return relay(res, apiRes);
}
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
    add,
    addSurpriseBox, updateQty, removeItem, clear,
    setMode, setAddress, setSchedule, setInstructions, paySavedCard,
    applyCoupon, removeCoupon, applyVoucher, removeVoucher,
    applyLoyalty, removeLoyalty, setCharity,
};
