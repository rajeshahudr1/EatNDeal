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

router.post('/auth/social-signin',
    validate(socialSigninSchema),
    AuthCtl.socialSignin);

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

// ── Future namespaces ──────────────────────────────────────────────
// router.use('/customer',   require('./customer'));
// router.use('/restaurant', require('./restaurant'));
// router.use('/rider',      require('./rider'));
// router.use('/admin',      require('./admin'));

module.exports = router;
