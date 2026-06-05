'use strict';

/**
 * Routes/index.js
 *
 * What:   Master router mounted at /api/v1 by api/index.js. As the project
 *         grows, every new namespace (customer / restaurant / rider / admin)
 *         adds one router.use(...) line here.
 * Why:    Centralised route table keeps all surface area visible in one
 *         file — easy to audit + easy to spot collisions.
 * Type:   READ + WRITE (each route may read or write the DB; this file just
 *         dispatches).
 * Inputs: Express request.
 * Output: standard API envelope (status / show / msg / data).
 * Used:   api/index.js → app.use('/api/v1', require('./Routes')).
 *
 * Endpoint inventory (initial scaffold — Phase 0):
 *   GET  /api/v1/ping       — minimal sanity check (no DB)
 *   GET  /api/v1/health     — readiness probe (DB ping + uptime + version)
 *   GET  /api/v1/brand      — brand identity (logo / colours / support info)
 *   GET  /api/v1/countries  — country / dial-code list
 *   POST /api/v1/delivery/*           — location autocomplete trio
 *   POST /api/v1/auth/send-otp        — issue (and in live mode send) 6-digit OTP
 *   POST /api/v1/auth/verify-otp      — verify + consume OTP; returns customer_status
 *   POST /api/v1/auth/save-profile    — insert/update marketplace customer (NULL company_id)
 *   POST /api/v1/auth/update-profile  — update existing registered customer
 *   GET  /api/v1/marketplace/restaurants — homepage restaurant grid
 *   GET  /api/v1/marketplace/products    — homepage "For you" dish rail
 *   GET  /api/v1/marketplace/categories  — homepage "What's on your mind?" pills
 *   GET  /api/v1/marketplace/search      — relationship-expanded live search
 *
 * Future namespaces (added as phases land):
 *   /customer/*, /restaurant/*, /rider/*, /admin/*, /payment/*, /upload
 *
 * Change log:
 *   2026-05-25 — initial; ping + health + brand only.
 */

const express = require('express');
const router  = express.Router();

const H          = require('../Helpers/helper');
const { db, ping } = require('../config/db');
const apiPkg     = require('../package.json');
const BrandCtl   = require('../Controllers/BrandController');

// Process start time — used by /health to report uptime in seconds.
const PROCESS_START_MS = Date.now();

/**
 * GET /ping
 *
 * What:   Minimal "is the process alive" probe. No DB call.
 * Why:    Liveness probe for load balancers. Hot path — must respond fast
 *         even when the DB is down (so the LB doesn't pull the instance
 *         while we're still serving cached / DB-less endpoints).
 * Type:   READ.
 * Inputs: none.
 * Output: { ok: true, ts: <ISO timestamp> }
 * Used:   Load balancer liveness probe.
 */
router.get('/ping', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /health
 *
 * What:   Readiness probe — includes a real DB SELECT 1 + uptime + version.
 * Why:    Distinct from /ping. /health failing (HTTP 503) means the
 *         instance is alive but not ready to serve real traffic; load
 *         balancers + container orchestrators pull it out of rotation.
 * Type:   READ.
 * Inputs: none.
 * Output: 200 envelope with { ok, version, uptime_seconds, node, master_db, latency_ms, ts }
 *         OR HTTP 503 with the same shape if the DB ping failed.
 * Used:   k8s / PM2 / ECS readiness probes; ops dashboards.
 */
router.get('/health', async (req, res) => {
    const startedAtNs = process.hrtime.bigint();

    // Run the DB ping inside its own try so a failure doesn't crash the
    // probe — we want to RETURN the failure shape, not throw.
    let dbOk      = false;
    let dbMs      = null;
    let dbError   = null;
    try {
        const dbStartNs = process.hrtime.bigint();
        await ping();
        dbMs = Number((process.hrtime.bigint() - dbStartNs) / 1_000_000n);
        dbOk = true;
    } catch (err) {
        dbError = err && err.message;
    }

    const totalMs = Number((process.hrtime.bigint() - startedAtNs) / 1_000_000n);

    const payload = {
        ok:             dbOk,
        version:        apiPkg.version,
        uptime_seconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
        node:           process.version,
        master_db: {
            ok:         dbOk,
            latency_ms: dbMs,
            error:      dbError,
        },
        latency_ms:     totalMs,
        ts:             new Date().toISOString(),
    };

    // Real HTTP status here (NOT inside our standard envelope) because health
    // probes parse HTTP status, not JSON body. 503 takes the instance out of
    // rotation; 200 keeps it in.
    res.status(dbOk ? 200 : 503).json(payload);
});

/**
 * GET /brand
 *
 * What:   Returns the brand identity (name, logo URL, colours, support info).
 * Why:    Single fetch on web/app splash — caches the brand client-side so
 *         every screen shows the same logo + copy without bundling it into
 *         the build.
 * Type:   READ.
 * Inputs: none.
 * Output: standard 200 envelope with the brand object as `data`.
 * Used:   Web PWA layout, Flutter splash screen.
 */
router.get('/brand', BrandCtl.get);

/**
 * GET /countries
 *
 * What:   Returns the full country list (ISO code, name, dial code, flag).
 * Why:    Web sign-in + future Flutter signup need a country picker for
 *         the phone-number field. Ported from Yii CountryList.php.
 * Type:   READ.
 * Output: standard envelope; data = { countries: [{iso,name,dial,flag}, ...] }.
 */
const CountriesCtl = require('../Controllers/CountriesController');
router.get('/countries', CountriesCtl.list);

// ── Delivery / location (public — no auth) ─────────────────────────
// Three endpoints ported from the Yii2 webordering DeliveryController.
// They power the location modal in the web (and the future Flutter app).
// All three are PUBLIC — a guest visitor must be able to pick a delivery
// area before they can be asked to sign in. Validators in
// api/Validators/delivery.js gate the input before the controller runs.
const DeliveryCtl   = require('../Controllers/Customer/DeliveryController');
const { validate, validateQuery } = require('../Middlewares/validate');
const {
    searchAddressSchema,
    retrieveAddressSchema,
    postcodeCoordsSchema,
}                   = require('../Validators/delivery');

router.post('/delivery/search-address',
    validate(searchAddressSchema),
    DeliveryCtl.searchAddress);

router.post('/delivery/retrieve-address',
    validate(retrieveAddressSchema),
    DeliveryCtl.retrieveAddress);

router.post('/delivery/postcode-coords',
    validate(postcodeCoordsSchema),
    DeliveryCtl.postcodeCoords);

// ── Customer auth (public — no auth yet) ───────────────────────────
// Two OTP endpoints powering the web sign-in flow:
//   /auth/send-otp   → issues + (in live mode) sends a 6-digit code
//   /auth/verify-otp → checks the code, consumes it on success
// Provider is selected by SMS_PROVIDER env (demo | connexa). See
// api/Helpers/otpSender.js for the dispatch logic.
const AuthCtl = require('../Controllers/Customer/AuthController');
const {
    sendOtpSchema,
    verifyOtpSchema,
    saveProfileSchema,
    updateProfileSchema,
    updateAvatarSchema,
    meSchema,
    updateAboutSchema,
    socialSigninSchema,
}             = require('../Validators/auth');

router.post('/auth/send-otp',
    validate(sendOtpSchema),
    AuthCtl.sendOtp);

router.post('/auth/verify-otp',
    validate(verifyOtpSchema),
    AuthCtl.verifyOtp);

router.post('/auth/save-profile',
    validate(saveProfileSchema),
    AuthCtl.saveProfile);

router.post('/auth/update-profile',
    validate(updateProfileSchema),
    AuthCtl.updateProfile);

router.get('/auth/me',
    validateQuery(meSchema),
    AuthCtl.me);

router.post('/auth/update-avatar',
    validate(updateAvatarSchema),
    AuthCtl.updateAvatar);

// Optional "About You" marketplace profile (customer_profile) backing
// the account page's "Complete your profile" section. Reuses meSchema for
// the GET (single customer_id query param).
router.get('/auth/about',
    validateQuery(meSchema),
    AuthCtl.getAbout);

router.post('/auth/update-about',
    validate(updateAboutSchema),
    AuthCtl.updateAbout);

router.post('/auth/social-signin',
    validate(socialSigninSchema),
    AuthCtl.socialSignin);

// ── Customer saved addresses ───────────────────────────────────────
// The signed-in customer's address book (Home / Work / ...) backing the
// location sheet + "Address info" add/edit screen. Scoped to one
// customer_id (Phase-1 trust model — the web supplies it from session).
const AddressCtl = require('../Controllers/Customer/AddressController');
const {
    addressListSchema,
    addressSaveSchema,
    addressDeleteSchema,
} = require('../Validators/address');

router.get('/customer/addresses',
    validateQuery(addressListSchema),
    AddressCtl.list);

router.post('/customer/address/save',
    validate(addressSaveSchema),
    AddressCtl.save);

router.post('/customer/address/delete',
    validate(addressDeleteSchema),
    AddressCtl.remove);

// ── Customer favourite restaurants (heart icon) ────────────────────
// Signed-in only. The web layer supplies customer_id from session;
// the validator rejects requests with no id.
const FavouriteCtl = require('../Controllers/Customer/FavouriteController');
const {
    favouriteListSchema,
    favouriteToggleSchema,
} = require('../Validators/favourite');

router.get('/customer/favourites',
    validateQuery(favouriteListSchema),
    FavouriteCtl.list);

router.post('/customer/favourite/toggle',
    validate(favouriteToggleSchema),
    FavouriteCtl.toggle);

// ── Customer cart (signed-in marketplace customers only) ───────────
// Phase 2A.3 — read-only. Write endpoints (add / update / remove /
// place) land in 2A.4+ once this read path is verified.
const CartCtl = require('../Controllers/Customer/CartController');
const {
    cartGetSchema,
    cartAddSchema,
    cartUpdateQtySchema,
    cartRemoveItemSchema,
    cartClearSchema,
    cartSetModeSchema,
    cartSetAddressSchema,
    cartSetScheduleSchema,
    cartSetInstructionsSchema,
    cartApplyCouponSchema,
    cartRemoveCouponSchema,
    cartApplyVoucherSchema,
    cartRemoveVoucherSchema,
    cartSetCharitySchema,
} = require('../Validators/cart');

router.get('/customer/cart',
    validateQuery(cartGetSchema),
    CartCtl.get);

router.get('/customer/cart/count',
    validateQuery(cartGetSchema),
    CartCtl.count);

router.get('/customer/cart/promotions',
    validateQuery(cartGetSchema),
    CartCtl.promotions);

router.post('/customer/cart/add',
    validate(cartAddSchema),
    CartCtl.add);

router.post('/customer/cart/update-qty',
    validate(cartUpdateQtySchema),
    CartCtl.updateQty);

router.post('/customer/cart/remove-item',
    validate(cartRemoveItemSchema),
    CartCtl.removeItem);

router.post('/customer/cart/clear',
    validate(cartClearSchema),
    CartCtl.clear);

router.post('/customer/cart/set-mode',
    validate(cartSetModeSchema),
    CartCtl.setMode);

router.post('/customer/cart/set-address',
    validate(cartSetAddressSchema),
    CartCtl.setAddress);

router.post('/customer/cart/set-schedule',
    validate(cartSetScheduleSchema),
    CartCtl.setSchedule);

router.post('/customer/cart/set-instructions',
    validate(cartSetInstructionsSchema),
    CartCtl.setInstructions);

router.post('/customer/cart/apply-coupon',
    validate(cartApplyCouponSchema),
    CartCtl.applyCoupon);

router.post('/customer/cart/remove-coupon',
    validate(cartRemoveCouponSchema),
    CartCtl.removeCoupon);

router.post('/customer/cart/apply-voucher',
    validate(cartApplyVoucherSchema),
    CartCtl.applyVoucher);

router.post('/customer/cart/remove-voucher',
    validate(cartRemoveVoucherSchema),
    CartCtl.removeVoucher);

router.post('/customer/cart/set-charity',
    validate(cartSetCharitySchema),
    CartCtl.setCharity);

// ── Customer orders (place + list + detail) ─────────────────────────
// Phase-2D ships only /place. List + detail land in Phase-2E.
const OrderCtl = require('../Controllers/Customer/OrderController');
const {
    orderPlaceSchema,
    orderListSchema,
    orderDetailSchema,
    orderStatusSchema,
    orderReorderSchema,
} = require('../Validators/order');

router.post('/customer/order/place',
    validate(orderPlaceSchema),
    OrderCtl.place);

router.get('/customer/orders',
    validateQuery(orderListSchema),
    OrderCtl.list);

router.get('/customer/order',
    validateQuery(orderDetailSchema),
    OrderCtl.detail);

router.get('/customer/order/status',
    validateQuery(orderStatusSchema),
    OrderCtl.status);

router.post('/customer/order/reorder',
    validate(orderReorderSchema),
    OrderCtl.reorder);

// ── Post-order reviews ──────────────────────────────────────────────
// The customer rates (1–5) + writes text + optional photo for one of their
// orders (saved to review_rating, one per order). The public list (read by
// the restaurant page) is registered with the marketplace routes below.
const ReviewCtl = require('../Controllers/Customer/ReviewController');
const { submitReviewSchema, listReviewsSchema } = require('../Validators/review');

router.post('/customer/review',
    validate(submitReviewSchema),
    ReviewCtl.submit);

// ── Customer payments (Stripe-backed) ───────────────────────────────
// createIntent returns a Stripe PaymentIntent the browser confirms via
// Stripe.js. Verification at order-place time happens inside
// OrderController.place (server reads the intent + checks succeeded).
const PaymentCtl = require('../Controllers/Customer/PaymentController');
const { paymentIntentSchema } = require('../Validators/payment');

router.post('/customer/payment/intent',
    validate(paymentIntentSchema),
    PaymentCtl.createIntent);

// Stripe webhook — Stripe POSTs signed events here. No Joi validation:
// the body is verified via HMAC against req.rawBody (set by the
// express.json verify hook in api/index.js).
router.post('/customer/payment/webhook',
    PaymentCtl.webhook);

// ── Customer saved payment methods (Stripe Customer + SetupIntents) ─
// list pulls cards from Stripe at read time (no PAN stored locally);
// setup returns a SetupIntent client_secret for Stripe.js confirm;
// delete detaches the payment_method from the customer.
const PaymentMethodCtl = require('../Controllers/Customer/PaymentMethodController');
const { paymentMethodListSchema,
        paymentMethodSetupSchema,
        paymentMethodDeleteSchema } = require('../Validators/paymentMethod');

router.get('/customer/payment-methods',
    validateQuery(paymentMethodListSchema),
    PaymentMethodCtl.list);

router.post('/customer/payment-method/setup',
    validate(paymentMethodSetupSchema),
    PaymentMethodCtl.setupIntent);

router.post('/customer/payment-method/delete',
    validate(paymentMethodDeleteSchema),
    PaymentMethodCtl.remove);

// ── Merchant dashboard (staff-allowlist gated) ──────────────────────
// Phase 4 ships with an env-driven allowlist (Helpers/merchant.js); a
// proper mp_merchant_staff table comes in Phase-5.
const MerchOrdersCtl = require('../Controllers/Merchant/OrdersController');
const {
    merchantOrdersSchema,
    merchantOrderSchema,
    merchantAdvanceSchema,
} = require('../Validators/merchant');

router.get('/merchant/orders',
    validateQuery(merchantOrdersSchema),
    MerchOrdersCtl.list);

router.get('/merchant/order',
    validateQuery(merchantOrderSchema),
    MerchOrdersCtl.detail);

router.post('/merchant/order/advance',
    validate(merchantAdvanceSchema),
    MerchOrdersCtl.advance);

// ── Marketplace dashboard (public read-only feeds) ─────────────────
// Powers the homepage restaurant grid + "For you" dish rail. Both are
// filtered by company.is_marketplace=1 (+ products.show_marketplace=1
// for dishes). Distance + delivery-time estimates are derived from
// the user's saved lat/lng query-string vs each branch's stored
// direction_latitude / direction_longitude.
const RestaurantsCtl = require('../Controllers/Marketplace/RestaurantsController');
const ProductsCtl    = require('../Controllers/Marketplace/ProductsController');
const CategoriesCtl  = require('../Controllers/Marketplace/CategoriesController');
const SearchCtl      = require('../Controllers/Marketplace/SearchController');
const {
    listQuerySchema:   marketplaceListQuery,
    searchQuerySchema: marketplaceSearchQuery,
    detailQuerySchema: marketplaceDetailQuery,
} = require('../Validators/marketplace');

router.get('/marketplace/restaurants',
    validateQuery(marketplaceListQuery),
    RestaurantsCtl.list);

// Single restaurant detail page (info + menu categories + products).
router.get('/marketplace/restaurant',
    validateQuery(marketplaceDetailQuery),
    RestaurantsCtl.detail);

// Single product detail page (product + selectable option groups).
router.get('/marketplace/product',
    validateQuery(marketplaceDetailQuery),
    ProductsCtl.detail);

router.get('/marketplace/products',
    validateQuery(marketplaceListQuery),
    ProductsCtl.list);

router.get('/marketplace/categories',
    validateQuery(marketplaceListQuery),
    CategoriesCtl.list);

router.get('/marketplace/search',
    validateQuery(marketplaceSearchQuery),
    SearchCtl.search);

// Active store-offer banners across marketplace restaurants (home rail).
router.get('/marketplace/offers', RestaurantsCtl.offers);

// Published reviews for one restaurant (+ average + count) — restaurant page.
router.get('/marketplace/reviews',
    validateQuery(listReviewsSchema),
    ReviewCtl.listForRestaurant);

// ── Future namespaces ──────────────────────────────────────────────
// router.use('/customer',   require('./customer'));
// router.use('/restaurant', require('./restaurant'));
// router.use('/rider',      require('./rider'));
// router.use('/admin',      require('./admin'));

module.exports = router;
