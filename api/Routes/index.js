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
    reverseGeocodeSchema,
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

router.post('/delivery/reverse-geocode',
    validate(reverseGeocodeSchema),
    DeliveryCtl.reverseGeocode);

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
    changePhoneSchema,
    deleteAccountSchema,
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

// Change (or add) the customer's mobile — OTP-verified for the new number.
router.post('/auth/change-phone',
    validate(changePhoneSchema),
    AuthCtl.changePhone);

// Soft-delete the customer's own account (status = '2').
router.post('/auth/delete-account',
    validate(deleteAccountSchema),
    AuthCtl.deleteAccount);

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

// ── Admin console auth (super-admin / staff + company) ─────────────
// Powers the admin/ layer (port 4503). Authenticates against the EXISTING
// live tables: `user` (role 6 = super admin) + `company` (owner login).
// Public endpoints — the whole point is to sign an admin in.
const AdminAuthCtl = require('../Controllers/Admin/AuthController');
const {
    adminLoginSchema,
    adminForgotSchema,
    adminResetSchema,
    adminProfileSchema,
    adminChangePasswordSchema,
} = require('../Validators/adminAuth');
const { authenticate: adminAuthMw } = require('../Middlewares/auth');
const { requireRole: adminRequireRole } = require('../Middlewares/requireRole');

router.post('/admin/auth/login',
    validate(adminLoginSchema),
    AdminAuthCtl.login);

router.post('/admin/auth/forgot-password',
    validate(adminForgotSchema),
    AdminAuthCtl.forgotPassword);

router.post('/admin/auth/reset-password',
    validate(adminResetSchema),
    AdminAuthCtl.resetPassword);

// My Profile + Change Password (authenticated admin account)
router.get('/admin/auth/me',
    adminAuthMw, adminRequireRole('admin'),
    AdminAuthCtl.me);

router.post('/admin/auth/profile',
    adminAuthMw, adminRequireRole('admin'), validate(adminProfileSchema),
    AdminAuthCtl.updateProfile);

router.post('/admin/auth/change-password',
    adminAuthMw, adminRequireRole('admin'), validate(adminChangePasswordSchema),
    AdminAuthCtl.changePassword);

// ── Admin console — loyalty management (JWT-gated) ─────────────────
// Every endpoint runs: authenticate (Bearer JWT) → requireRole('admin')
// (both super-admin + company logins carry kind='admin') → controller,
// which resolves the company scope via Helpers/adminScope. Super admins
// pass ?company_id= (selector); company logins are pinned to their own.
const { authenticate }          = require('../Middlewares/auth');
const { requireRole }           = require('../Middlewares/requireRole');
// Marketplace-level (global) admin screens are super-admin only — requireRole
// ('admin') admits company logins too, since both carry kind='admin'. 404s
// everyone else. See Middlewares/requireSuperAdmin.
const { requireSuperAdmin }     = require('../Middlewares/requireSuperAdmin');
const AdminCompaniesCtl         = require('../Controllers/Admin/CompaniesController');
const AdminLoyaltyCtl           = require('../Controllers/Admin/LoyaltyController');
const AdminReviewsCtl           = require('../Controllers/Admin/ReviewsController');

router.get('/admin/companies',
    authenticate, requireRole('admin'),
    AdminCompaniesCtl.list);

const AdminOverviewCtl = require('../Controllers/Admin/OverviewController');
router.get('/admin/overview',
    authenticate, requireRole('admin'),
    AdminOverviewCtl.overview);

// ── Admin console — Store Settings (branch config) ────────────────
const AdminStoreSettingsCtl = require('../Controllers/Admin/StoreSettingsController');
const {
    storeSettingsSchema, storeScopeQuery, websiteStatusSchema,
    tipsSaveSchema, advanceSaveSchema, advanceDeleteSchema, imageSaveSchema,
} = require('../Validators/adminStoreSettings');
router.get('/admin/store-settings',
    authenticate, requireRole('admin'), validateQuery(storeScopeQuery),
    AdminStoreSettingsCtl.getSettings);
router.post('/admin/store-settings',
    authenticate, requireRole('admin'), validate(storeSettingsSchema),
    AdminStoreSettingsCtl.saveSettings);
router.post('/admin/store-settings/website-status',
    authenticate, requireRole('admin'), validate(websiteStatusSchema),
    AdminStoreSettingsCtl.saveWebsiteStatus);
router.post('/admin/store-settings/tips',
    authenticate, requireRole('admin'), validate(tipsSaveSchema),
    AdminStoreSettingsCtl.saveTips);
router.get('/admin/store-settings/advance',
    authenticate, requireRole('admin'), validateQuery(storeScopeQuery),
    AdminStoreSettingsCtl.advanceList);
router.post('/admin/store-settings/advance',
    authenticate, requireRole('admin'), validate(advanceSaveSchema),
    AdminStoreSettingsCtl.advanceSave);
router.post('/admin/store-settings/advance/delete',
    authenticate, requireRole('admin'), validate(advanceDeleteSchema),
    AdminStoreSettingsCtl.advanceDelete);
router.post('/admin/store-settings/image',
    authenticate, requireRole('admin'), validate(imageSaveSchema),
    AdminStoreSettingsCtl.saveImage);

const {
    scopeQuerySchema,
    cashbackRowSchema,
    toggleSchema,
    configSchema,
    companyConfigSchema,
    tiersSchema,
    referralSchema,
    streakSchema,
    challengesSchema,
    eventsSchema,
    reviewListSchema,
    reviewRatingSaveSchema,
    reviewRatingReplySchema,
    reviewApproveSchema,
    reviewRejectSchema,
    specialOfferSchema,
    reviewRewardsSchema,
    productCashbackSchema,
    bogofSchema,
    cmsPageSchema,
} = require('../Validators/adminLoyalty');

router.get('/admin/loyalty/dashboard',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.dashboard);

// Company-level loyalty on/off (gates whether a company sees the Loyalty menu)
router.post('/admin/loyalty/master-toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.masterToggle);

// Company-level loyalty settings (commission % + phone-order toggle)
router.post('/admin/loyalty/company-config',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(companyConfigSchema),
    AdminLoyaltyCtl.companyConfigSave);

// Save All — the whole config page in one POST (dynamic nested body; the
// controller coerces every field safely, so no Joi schema is applied).
router.post('/admin/loyalty/save-all',
    authenticate, requireRole('admin'), requireSuperAdmin,
    AdminLoyaltyCtl.saveAll);

// Cashback Rules
router.get('/admin/loyalty/cashback',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.cashbackGet);

router.post('/admin/loyalty/cashback',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(cashbackRowSchema),
    AdminLoyaltyCtl.cashbackUpsert);

router.delete('/admin/loyalty/cashback/:id',
    authenticate, requireRole('admin'), requireSuperAdmin,
    AdminLoyaltyCtl.cashbackDelete);

router.post('/admin/loyalty/cashback/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.cashbackToggle);

router.post('/admin/loyalty/config',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(configSchema),
    AdminLoyaltyCtl.configSave);

// Tier Config
router.get('/admin/loyalty/tiers',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.tiersGet);

router.post('/admin/loyalty/tiers',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(tiersSchema),
    AdminLoyaltyCtl.tiersSave);

router.post('/admin/loyalty/tiers/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.tiersToggle);

// Referral & Streak
router.get('/admin/loyalty/referral-streak',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.referralStreakGet);

router.post('/admin/loyalty/referral',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(referralSchema),
    AdminLoyaltyCtl.referralSave);

router.post('/admin/loyalty/referral/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.referralToggle);

router.post('/admin/loyalty/streak',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(streakSchema),
    AdminLoyaltyCtl.streakUpsert);

router.delete('/admin/loyalty/streak/:id',
    authenticate, requireRole('admin'), requireSuperAdmin,
    AdminLoyaltyCtl.streakDelete);

router.post('/admin/loyalty/streak/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.streakToggle);

// Challenges (Smart Campaigns)
router.get('/admin/loyalty/challenges',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.challengesGet);

router.post('/admin/loyalty/challenges',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(challengesSchema),
    AdminLoyaltyCtl.challengesSave);

router.post('/admin/loyalty/challenges/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.challengesToggle);

// Event Rewards
router.get('/admin/loyalty/events',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.eventsGet);

router.post('/admin/loyalty/events',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(eventsSchema),
    AdminLoyaltyCtl.eventsSave);

router.post('/admin/loyalty/events/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.eventsToggle);

// Review Claims (approve / reject)
router.get('/admin/loyalty/review-claims',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(reviewListSchema),
    AdminLoyaltyCtl.reviewClaimsGet);

router.post('/admin/loyalty/review-claims/approve',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(reviewApproveSchema),
    AdminLoyaltyCtl.reviewApprove);

router.post('/admin/loyalty/review-claims/reject',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(reviewRejectSchema),
    AdminLoyaltyCtl.reviewReject);

// ── Marketplace reviews (super-admin only) ─────────────────────────
// EatNDeal's OWN public star-reviews (review_rating at company_id = 0) — the
// marketplace twin of the legacy POS /admin/pos/review-rating/index. A
// restaurant's reviews stay on that POS page; this is marketplace-scoped only,
// so it's requireSuperAdmin on top of requireRole('admin') — a company login
// gets a 404, exactly as if the route didn't exist.
// ══ DISABLED 2026-07-17 (user request) ═════════════════════════════
// The admin Reviews screen is switched off (menu commented in
// admin/views/partials/sidebar.ejs, URLs 404'd by the gate in admin/index.js),
// so nothing calls these. Off here too so the api can't be reached directly.
// Controllers/Admin/ReviewsController is untouched — restore = uncomment.
// router.get('/admin/reviews',
//     authenticate, requireRole('admin'), requireSuperAdmin,
//     AdminReviewsCtl.reviewsList);
//
// router.post('/admin/reviews',
//     authenticate, requireRole('admin'), requireSuperAdmin, validate(reviewRatingSaveSchema),
//     AdminReviewsCtl.reviewsSave);
//
// router.post('/admin/reviews/reply',
//     authenticate, requireRole('admin'), requireSuperAdmin, validate(reviewRatingReplySchema),
//     AdminReviewsCtl.reviewsReply);
// ═══════════════════════════════════════════════════════════════════

// Customer Segments (read-only analytics)
router.get('/admin/loyalty/segments',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.segmentsGet);

// Section 8 — Special Offer (date-based cashback rows)
router.get('/admin/loyalty/special-offer',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.specialOfferGet);
router.post('/admin/loyalty/special-offer',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(specialOfferSchema),
    AdminLoyaltyCtl.specialOfferUpsert);
router.delete('/admin/loyalty/special-offer/:id',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.specialOfferDelete);
router.post('/admin/loyalty/special-offer/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.specialOfferToggle);

// Section 6 — Review Cashback rewards (8 review/share types)
router.get('/admin/loyalty/review-rewards',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.reviewRewardsGet);
router.post('/admin/loyalty/review-rewards',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(reviewRewardsSchema),
    AdminLoyaltyCtl.reviewRewardsSave);
router.post('/admin/loyalty/review-rewards/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.reviewRewardsToggle);

// Section 4 — Product Cashback (rule + selected products)
router.get('/admin/loyalty/product-cashback',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.productCashbackGet);
router.post('/admin/loyalty/product-cashback',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(productCashbackSchema),
    AdminLoyaltyCtl.productCashbackUpsert);
router.delete('/admin/loyalty/product-cashback/:id',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.productCashbackDelete);
router.post('/admin/loyalty/product-cashback/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.productCashbackToggle);

// Section 7 — Buy X Get Y (BOGO)
router.get('/admin/loyalty/bogof',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.bogofGet);
router.post('/admin/loyalty/bogof',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(bogofSchema),
    AdminLoyaltyCtl.bogofUpsert);
router.delete('/admin/loyalty/bogof/:id',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.bogofDelete);
router.post('/admin/loyalty/bogof/toggle',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(toggleSchema),
    AdminLoyaltyCtl.bogofToggle);

// Review CMS Pages (loyalty_cms_pages — per review-type instructional content)
router.get('/admin/loyalty/cms-pages',
    authenticate, requireRole('admin'), requireSuperAdmin, validateQuery(scopeQuerySchema),
    AdminLoyaltyCtl.cmsPagesGet);
router.post('/admin/loyalty/cms-pages',
    authenticate, requireRole('admin'), requireSuperAdmin, validate(cmsPageSchema),
    AdminLoyaltyCtl.cmsPageSave);

// ── Products (Menu → Item) — Phase 1: the list page ────────────────
// Dynamic bodies (id/ids arrays, items arrays); the controller coerces every
// field safely, so no Joi schema is applied.
const AdminProductsCtl = require('../Controllers/Admin/ProductsController');
router.get ('/admin/products',               authenticate, requireRole('admin'), AdminProductsCtl.list);
router.get ('/admin/products/get',           authenticate, requireRole('admin'), AdminProductsCtl.getProduct);
router.get ('/admin/products/meta',          authenticate, requireRole('admin'), AdminProductsCtl.formMeta);
router.post('/admin/products/save',          authenticate, requireRole('admin'), AdminProductsCtl.save);

// Marketplace categories (GLOBAL master — not company-scoped)
const AdminMpCatCtl = require('../Controllers/Admin/MarketplaceCategoriesController');
router.get ('/admin/marketplace-categories',        authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.list);
router.get ('/admin/marketplace-categories/get',    authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.getCategory);
router.post('/admin/marketplace-categories/save',   authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.save);
router.post('/admin/marketplace-categories/delete', authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.remove);
router.post('/admin/marketplace-categories/status', authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.statusToggle);
router.get ('/admin/marketplace-categories/companies',   authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.companies);
router.get ('/admin/marketplace-categories/restaurants', authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.restaurants);
router.post('/admin/marketplace-categories/assign',      authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.assign);
router.post('/admin/marketplace-categories/reorder',     authenticate, requireRole('admin'), requireSuperAdmin, AdminMpCatCtl.reorder);

// ── Admin: marketplace collections (curated home-feed rows) ─────────
const AdminCollectionsCtl = require('../Controllers/Admin/CollectionsController');
router.get ('/admin/collections',             authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.list);
router.get ('/admin/collections/get',         authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.getCollection);
router.post('/admin/collections/save',        authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.save);
router.post('/admin/collections/delete',      authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.remove);
router.post('/admin/collections/status',      authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.statusToggle);
router.get ('/admin/collections/companies',   authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.companies);
router.get ('/admin/collections/restaurants', authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.restaurants);
router.post('/admin/collections/assign',      authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.assign);
router.post('/admin/collections/reorder',     authenticate, requireRole('admin'), requireSuperAdmin, AdminCollectionsCtl.reorder);

// ── Admin: featured / sponsored placements (paid home-feed boost) ───
const AdminFeaturedCtl = require('../Controllers/Admin/FeaturedController');
router.get ('/admin/featured',           authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.list);
router.get ('/admin/featured/get',       authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.getPlacement);
router.post('/admin/featured/save',      authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.save);
router.post('/admin/featured/delete',    authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.remove);
router.post('/admin/featured/status',    authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.statusToggle);
router.post('/admin/featured/reorder',   authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.reorder);
router.get ('/admin/featured/companies', authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedCtl.companies);

// ── Admin: featured PRODUCTS (admin-picked dishes → home product rows) ──
const AdminFeaturedProductsCtl = require('../Controllers/Admin/FeaturedProductsController');
router.get ('/admin/featured-products',           authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.list);
router.get ('/admin/featured-products/get',       authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.getGroup);
router.post('/admin/featured-products/save',      authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.save);
router.post('/admin/featured-products/delete',    authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.remove);
router.post('/admin/featured-products/status',    authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.statusToggle);
router.post('/admin/featured-products/reorder',   authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.reorder);
router.get ('/admin/featured-products/companies', authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.companies);
router.get ('/admin/featured-products/products',  authenticate, requireRole('admin'), requireSuperAdmin, AdminFeaturedProductsCtl.products);

// ── Admin: home-feed SECTION order (one master ordering of the 4 sections) ──
const AdminFeedSectionsCtl = require('../Controllers/Admin/FeedSectionsController');
router.get ('/admin/feed-sections',         authenticate, requireRole('admin'), requireSuperAdmin, AdminFeedSectionsCtl.list);
router.post('/admin/feed-sections/reorder', authenticate, requireRole('admin'), requireSuperAdmin, AdminFeedSectionsCtl.reorder);

// ── Admin: home WELCOME banner (super-admin — single config row) ──
const AdminWelcomeBannerCtl = require('../Controllers/Admin/WelcomeBannerController');
router.get ('/admin/welcome-banner/get',    authenticate, requireRole('admin'), requireSuperAdmin, AdminWelcomeBannerCtl.getConfig);
router.post('/admin/welcome-banner/save',   authenticate, requireRole('admin'), requireSuperAdmin, AdminWelcomeBannerCtl.save);
router.post('/admin/welcome-banner/delete', authenticate, requireRole('admin'), requireSuperAdmin, AdminWelcomeBannerCtl.remove);

// ── Admin: home OFFER BANNER carousel (super-admin — a list of banners) ──
const AdminOfferBannerCtl = require('../Controllers/Admin/OfferBannerController');
router.get ('/admin/offer-banner',             authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.list);
router.get ('/admin/offer-banner/get',         authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.getBanner);
router.post('/admin/offer-banner/save',        authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.save);
router.post('/admin/offer-banner/delete',      authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.remove);
router.post('/admin/offer-banner/status',      authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.statusToggle);
router.post('/admin/offer-banner/reorder',     authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.reorder);
router.get ('/admin/offer-banner/companies',   authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.companies);
router.get ('/admin/offer-banner/restaurants', authenticate, requireRole('admin'), requireSuperAdmin, AdminOfferBannerCtl.restaurants);

// ── Admin: COMMUNITY groups (Facebook-style; super-admin manages groups) ──
const AdminCommunityCtl = require('../Controllers/Admin/CommunityController');
router.get ('/admin/community',        authenticate, requireRole('admin'), AdminCommunityCtl.list);
router.get ('/admin/community/get',    authenticate, requireRole('admin'), AdminCommunityCtl.getGroup);
router.post('/admin/community/save',   authenticate, requireRole('admin'), AdminCommunityCtl.save);
router.post('/admin/community/delete', authenticate, requireRole('admin'), AdminCommunityCtl.remove);
router.post('/admin/community/status', authenticate, requireRole('admin'), AdminCommunityCtl.statusToggle);
// Phase 2 — admin participates in + moderates a group's feed.
router.get ('/admin/community/feed',           authenticate, requireRole('admin'), AdminCommunityCtl.feed);
router.get ('/admin/community/comments',       authenticate, requireRole('admin'), AdminCommunityCtl.comments);
router.post('/admin/community/post',           authenticate, requireRole('admin'), AdminCommunityCtl.createPost);
router.post('/admin/community/comment',        authenticate, requireRole('admin'), AdminCommunityCtl.addComment);
router.post('/admin/community/post-delete',    authenticate, requireRole('admin'), AdminCommunityCtl.deletePost);
router.post('/admin/community/comment-delete', authenticate, requireRole('admin'), AdminCommunityCtl.deleteComment);
// Phase 2 — super-admin AI-moderation review queue (approve / reject held items).
router.get ('/admin/community/pending',  authenticate, requireRole('admin'), AdminCommunityCtl.pending);
router.post('/admin/community/moderate', authenticate, requireRole('admin'), AdminCommunityCtl.moderate);
// Phase 2 — blocked users (a blocked customer can read but not post/like/comment).
router.get ('/admin/community/blocked',   authenticate, requireRole('admin'), AdminCommunityCtl.blockedList);
router.get ('/admin/community/customers', authenticate, requireRole('admin'), AdminCommunityCtl.searchCustomers);
router.post('/admin/community/block',     authenticate, requireRole('admin'), AdminCommunityCtl.blockUser);
router.post('/admin/community/unblock',   authenticate, requireRole('admin'), AdminCommunityCtl.unblockUser);
router.post('/admin/products/price',         authenticate, requireRole('admin'), AdminProductsCtl.updatePrice);
router.post('/admin/products/bulk-price',    authenticate, requireRole('admin'), AdminProductsCtl.bulkPrice);
router.post('/admin/products/marketplace',   authenticate, requireRole('admin'), AdminProductsCtl.marketplaceToggle);
router.post('/admin/products/status',        authenticate, requireRole('admin'), AdminProductsCtl.updateStatus);
router.post('/admin/products/delete',        authenticate, requireRole('admin'), AdminProductsCtl.remove);
router.post('/admin/products/online-prices', authenticate, requireRole('admin'), AdminProductsCtl.bulkOnlinePrice);

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

// "Order again" rail — the customer's recently-ordered restaurants (top 10).
// Reuses the favourites query schema (same customer_id + lat/lng params).
router.get('/customer/order-again',
    validateQuery(favouriteListSchema),
    require('../Controllers/Customer/OrderAgainController').list);

router.post('/customer/favourite/toggle',
    validate(favouriteToggleSchema),
    FavouriteCtl.toggle);

// ── Customer COMMUNITY (Facebook-style groups) ─────────────────────
// Reads (groups / feed / comments) are GUEST-OK — signed-out can browse.
// Writes (post / like / comment) need customer_id, which the web proxy
// only injects for a signed-in customer, so guests can't write.
const CommunityCtl = require('../Controllers/Customer/CommunityController');
router.get ('/customer/community/groups',   CommunityCtl.groups);
router.get ('/customer/community/feed',      CommunityCtl.feed);
router.get ('/customer/community/my-posts',  CommunityCtl.myPosts);
router.get ('/customer/community/comments',  CommunityCtl.comments);
router.post('/customer/community/post',      CommunityCtl.createPost);
router.post('/customer/community/like',      CommunityCtl.toggleLike);
router.post('/customer/community/comment',   CommunityCtl.addComment);
router.post('/customer/community/post-delete',    CommunityCtl.deletePost);
router.post('/customer/community/comment-delete', CommunityCtl.deleteComment);

// ── Public partner / contact lead form (emails the enquiry; no auth, no DB) ──
router.post('/partner/lead', require('../Controllers/PartnerController').lead);

// ── Marketplace help chatbot (personalises when a valid customer_id is sent) ──
router.post('/customer/chatbot/ask', require('../Controllers/Customer/ChatbotController').ask);

// ── Customer cart (signed-in marketplace customers only) ───────────
// Phase 2A.3 — read-only. Write endpoints (add / update / remove /
// place) land in 2A.4+ once this read path is verified.
const CartCtl = require('../Controllers/Customer/CartController');
const {
    cartGetSchema,
    cartClaimSchema,
    cartAddSchema,
    cartSurpriseBoxSchema,
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
    cartApplyLoyaltySchema,
    cartRemoveLoyaltySchema,
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

// Surprise Box ("Too Good To Go") — its own endpoint because the box is a
// VIRTUAL product configured on `branch`, with no `products` row for
// /cart/add to look up. Mirrors legacy's separate ToogoodtogoController.
router.post('/customer/cart/surprise-box',
    validate(cartSurpriseBoxSchema),
    CartCtl.addSurpriseBox);

router.post('/customer/cart/update-qty',
    validate(cartUpdateQtySchema),
    CartCtl.updateQty);

router.post('/customer/cart/remove-item',
    validate(cartRemoveItemSchema),
    CartCtl.removeItem);

router.post('/customer/cart/clear',
    validate(cartClearSchema),
    CartCtl.clear);

router.post('/customer/cart/claim',
    validate(cartClaimSchema),
    CartCtl.claim);

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

router.post('/customer/cart/apply-loyalty',
    validate(cartApplyLoyaltySchema),
    CartCtl.applyLoyalty);

router.post('/customer/cart/remove-loyalty',
    validate(cartRemoveLoyaltySchema),
    CartCtl.removeLoyalty);

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
    orderReportIssueSchema,
    orderIssueResponseSchema,
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

router.post('/customer/order/report-issue',
    validate(orderReportIssueSchema),
    OrderCtl.reportIssue);

router.get('/customer/order/issue-response',
    validateQuery(orderIssueResponseSchema),
    OrderCtl.issueResponse);

// ── Post-order reviews ──────────────────────────────────────────────
// The customer rates (1–5) + writes text + optional photo for one of their
// orders (saved to review_rating, one per order). The public list (read by
// the restaurant page) is registered with the marketplace routes below.
const ReviewCtl = require('../Controllers/Customer/ReviewController');
const { submitReviewSchema, listReviewsSchema, cashbackReviewSchema, siteReviewSchema } = require('../Validators/review');

router.post('/customer/review',
    validate(submitReviewSchema),
    ReviewCtl.submit);

// Cashback review — customer uploads a screenshot of an external review to
// earn cashback (customer_review, pending admin approval in the POS).
router.post('/customer/review-cashback',
    validate(cashbackReviewSchema),
    ReviewCtl.submitCashbackReview);

// ── Loyalty (per-restaurant reward cards) ───────────────────────────
const LoyaltyCtl = require('../Controllers/Customer/LoyaltyController');
const { walletSchema: loyaltyWalletSchema, balanceSchema: loyaltyBalanceSchema, historySchema: loyaltyHistorySchema, reviewTypesSchema: loyaltyReviewTypesSchema } = require('../Validators/loyalty');

router.get('/customer/loyalty/wallet',
    validateQuery(loyaltyWalletSchema),
    LoyaltyCtl.wallet);

router.get('/customer/loyalty/balance',
    validateQuery(loyaltyBalanceSchema),
    LoyaltyCtl.balance);

router.get('/customer/loyalty/history',
    validateQuery(loyaltyHistorySchema),
    LoyaltyCtl.history);

router.get('/customer/loyalty/review-types',
    validateQuery(loyaltyReviewTypesSchema),
    LoyaltyCtl.reviewTypes);

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

// Home welcome strip (super-admin configured) — public read for the home page.
router.get('/marketplace/welcome-banner', require('../Controllers/Marketplace/WelcomeBannerController').get);

// Home OFFER BANNER carousel (super-admin configured) — public read; each
// banner carries a resolved href to its filtered restaurant grid.
router.get('/marketplace/offer-banner', require('../Controllers/Marketplace/OfferBannerController').list);

// Location gate helpers — dynamic "popular cities" grid (branches grouped by
// city, top-N by restaurant count) + demo-location (backs the location page's
// currently-HIDDEN demo button; browser/IP geolocation needs HTTPS). Public reads.
const MarketplacePlacesCtl = require('../Controllers/Marketplace/PlacesController');
router.get('/marketplace/cities',        MarketplacePlacesCtl.cities);
router.get('/marketplace/demo-location', MarketplacePlacesCtl.demoLocation);

// Curated home FEED — Featured row + collection rows (Uber-Eats-style shelves).
const MarketplaceCollectionsCtl = require('../Controllers/Marketplace/CollectionsController');
router.get('/marketplace/home-feed',
    validateQuery(marketplaceListQuery),
    MarketplaceCollectionsCtl.homeFeed);

// Published reviews for one restaurant (+ average + count) — restaurant page.
router.get('/marketplace/reviews',
    validateQuery(listReviewsSchema),
    ReviewCtl.listForRestaurant);

// ── EatNDeal's OWN reviews (marketplace, company_id = 0) ───────────
// A review OF THE MARKETPLACE, not of a restaurant — the /reviews page.
// PUBLIC list shows APPROVED ones only; a customer's submit lands PENDING
// (publish_online = 0) and stays invisible until the super admin publishes it
// on the admin Reviews screen.
// ══ DISABLED 2026-07-17 (user request) ═════════════════════════════
// Switched off end-to-end: the web /reviews routes and the admin Reviews screen
// are commented out too, so nothing calls these. Off here as well so the api
// can't be hit directly either. Controllers/Customer/ReviewController keeps
// siteReviews + submitSiteReview intact — restore = uncomment these.
// router.get('/marketplace/site-reviews',
//     ReviewCtl.siteReviews);
//
// router.post('/customer/site-review',
//     validate(siteReviewSchema),
//     ReviewCtl.submitSiteReview);
// ═══════════════════════════════════════════════════════════════════

// ── Future namespaces ──────────────────────────────────────────────
// router.use('/customer',   require('./customer'));
// router.use('/restaurant', require('./restaurant'));
// router.use('/rider',      require('./rider'));
// router.use('/admin',      require('./admin'));

module.exports = router;
