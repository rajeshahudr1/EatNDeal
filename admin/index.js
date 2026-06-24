'use strict';

/**
 * admin/index.js — EatNDeal Admin (PWA) entry point
 *
 * What:   Boots the Express server for the admin console, wires middleware,
 *         mounts routes, and renders EJS views for the loyalty / marketplace
 *         management screens.
 * Why:    Mirror of web/index.js. The admin layer is intentionally thin — it
 *         does NOT touch the database. Every data call goes through api/ via
 *         Helpers/apiClient.js (project rule: admin -> api -> db).
 * Type:   READ + WRITE (request -> render or proxy to api).
 * Inputs: process.env (see admin/.env.example).
 * Output: HTTP server listening on PORT (default 4503).
 * Used:   Process entry. `npm start` / `npm run dev`.
 *
 * Boot order (top-to-bottom — do not reshuffle):
 *   1. Load .env
 *   2. EJS engine + ejs-locals (layouts) + views path
 *   3. helmet (CSP off in dev, strict 'self' in prod — no inline JS/CSS)
 *   4. compression
 *   5. body parsers
 *   6. static / (with PWA-aware headers on service-worker.js)
 *   7. session + flash
 *   8. res.locals injector (brand, asset_version, flash, admin)
 *   9. routes (login is public; everything else is gated by requireAdmin)
 *  10. 404 + error handlers
 *  11. listen + brand pre-fetch
 *
 * Change log:
 *   2026-06-09 — initial scaffold; login page + gated dashboard stub.
 */

require('dotenv').config();

const path        = require('path');
const fs          = require('fs');
const express     = require('express');
const session     = require('express-session');
const FileStore   = require('session-file-store')(session);
const flash       = require('express-flash');
const helmet      = require('helmet');
const compression = require('compression');
const ejsLocals   = require('ejs-locals');
const chalk       = require('chalk');

const { fetchBrand } = require('./Helpers/apiClient');
const { requireAdmin } = require('./Middlewares/auth');
const { companyContext, requireLoyalty } = require('./Middlewares/companyContext');
const AuthController      = require('./Controllers/AuthController');
const DashboardController = require('./Controllers/DashboardController');
const LoyaltyController   = require('./Controllers/LoyaltyController');
const StoreSettingsController = require('./Controllers/StoreSettingsController');
const ProductsController  = require('./Controllers/ProductsController');
const MpCategoriesController = require('./Controllers/MarketplaceCategoriesController');
const CollectionsController  = require('./Controllers/CollectionsController');
const FeaturedController     = require('./Controllers/FeaturedController');
const FeaturedProductsController = require('./Controllers/FeaturedProductsController');
const FeedSectionsController      = require('./Controllers/FeedSectionsController');
const CommunityController         = require('./Controllers/CommunityController');

const app    = express();
const ENV    = process.env.APP_ENV || 'development';
const IS_DEV = ENV !== 'production';

app.set('trust proxy', true);
app.disable('x-powered-by');

// ── View engine ─────────────────────────────────────────────────
// ejs-locals adds layout / partial support on top of plain EJS (pinned
// to EJS v3 via package.json overrides so the two play nicely).
app.set('views', path.join(__dirname, 'views'));
app.engine('ejs', ejsLocals);
app.set('view engine', 'ejs');

// ── Security headers ────────────────────────────────────────────
// DEV runs without a CSP (a strict policy on plain-HTTP localhost can
// silently block our own CSS/fonts). PROD locks everything to our own
// origin — no inline scripts, no inline styles, no CDN (Conventions #6).
if (IS_DEV) {
    app.use(helmet({ contentSecurityPolicy: false }));
} else {
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                'default-src':     ["'self'"],
                'base-uri':        ["'self'"],
                'object-src':      ["'none'"],
                'form-action':     ["'self'"],
                'frame-ancestors': ["'none'"],
                'script-src':      ["'self'"],
                'style-src':       ["'self'"],
                'img-src':         ["'self'", 'data:'],
                'font-src':        ["'self'"],
                'connect-src':     ["'self'", process.env.API_URL || 'http://localhost:4501'],
                'worker-src':      ["'self'"],
                'manifest-src':    ["'self'"],
            },
        },
    }));
}

app.use(compression());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Static assets ──────────────────────────────────────────────
// /service-worker.js needs `Service-Worker-Allowed: /` so it registers at
// root scope. In dev we never cache CSS/JS/images so a code change shows
// on a plain refresh.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(path.sep + 'service-worker.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (ENV !== 'production') {
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
    },
}));

// ── Yii uploads passthrough ────────────────────────────────────
// Bridges the legacy Yii uploads folder so the admin can render product /
// restaurant images without a separate media server. Skipped when the path
// env is blank (CI / containers).
const yiiUploadsPath = process.env.YII_UPLOADS_PATH;
const yiiUploadsUrl  = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
if (yiiUploadsPath) {
    app.use(yiiUploadsUrl, express.static(yiiUploadsPath, {
        maxAge: ENV === 'production' ? '7d' : 0,
        fallthrough: true,
    }));
}

// Customer review screenshots live in the web app's runtime folder
// (web/runtime/review-images). Serve them here too so the Cashback Review
// page shows them same-origin, even when the customer web app isn't running.
app.use('/review-images', express.static(path.join(__dirname, '..', 'web', 'runtime', 'review-images'), {
    maxAge: ENV === 'production' ? '7d' : 0,
    fallthrough: true,
}));

// ── Session ────────────────────────────────────────────────────
// Server-side session persisted to disk (session-file-store) so a server
// restart does not log admins out. The cookie carries only the session id.
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE, 10) || 24 * 60 * 60 * 1000;
app.use(session({
    name:              process.env.SESSION_NAME   || 'eatndeal_admin',
    secret:            process.env.SESSION_SECRET || 'change_me_in_production',
    resave:            false,
    saveUninitialized: false,
    store: new FileStore({
        path:         path.join(__dirname, 'runtime', 'sessions'),
        ttl:          Math.floor(SESSION_MAX_AGE / 1000),
        retries:      1,
        reapInterval: 60 * 60,
        logFn:        function () {},
    }),
    cookie: {
        maxAge:   SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        secure:   ENV === 'production',
    },
}));

app.use(flash());

// ── Asset cache-busting ────────────────────────────────────────
// Every CSS / JS link in the layout has ?v=<ASSET_VERSION>. Bumped on each
// server start so a fresh deploy invalidates the browser cache.
app.locals.ASSET_VERSION = String(Date.now());

// Shared server-side render helpers + constants, available in EVERY admin EJS
// view as fmt.* / C.* (one home for sym/money/num + status/tier maps).
app.locals.fmt = require('./Helpers/viewFormat');
app.locals.C = require('./Helpers/viewConstants');

// ── Cached brand ───────────────────────────────────────────────
// Fetch GET /api/v1/brand once at boot and refresh loosely so the admin
// shell shows the live brand identity. Cached copy keeps rendering working
// if the api is briefly unreachable.
let cachedBrand = null;
let lastBrandFetchMs = 0;
const BRAND_REFRESH_MS = 60 * 1000;

async function ensureBrand(req, res, next) {
    const now = Date.now();
    if (!cachedBrand || (now - lastBrandFetchMs) > BRAND_REFRESH_MS) {
        try {
            cachedBrand = await fetchBrand();
            lastBrandFetchMs = now;
        } catch (err) {
            console.error('[ensureBrand] unexpected error', err && err.message);
        }
    }
    res.locals.brand = cachedBrand;
    next();
}
app.use(ensureBrand);

// ── Per-request locals ─────────────────────────────────────────
app.use((req, res, next) => {
    res.locals.flash_success = (req.flash('success') || [])[0] || null;
    res.locals.flash_error   = (req.flash('error')   || [])[0] || null;
    res.locals.admin         = (req.session && req.session.admin) || null;
    res.locals.page_title    = '';
    res.locals.active_nav    = '';
    // Current path — so forms (e.g. the company switcher) can post a `next`
    // and return the user to the SAME page. We can't rely on the Referer
    // header: Helmet's default Referrer-Policy: no-referrer strips it.
    res.locals.current_path  = req.originalUrl || '/';
    next();
});

// ── Persist the session before every redirect ──────────────────
// connect-flash stores messages on req.session, and session-file-store writes
// to disk ASYNCHRONOUSLY. A bare res.redirect() can race that write: the
// browser fetches the redirect target before the flash is persisted, so the
// success/error toast never shows. Wrapping redirect to save first guarantees
// the flash survives — globally, for every current and future handler.
app.use((req, res, next) => {
    const nativeRedirect = res.redirect.bind(res);
    res.redirect = function patchedRedirect(...args) {
        if (req.session && typeof req.session.save === 'function') {
            return req.session.save(() => nativeRedirect(...args));
        }
        return nativeRedirect(...args);
    };
    next();
});

// ── Dev request logger ─────────────────────────────────────────
if (IS_DEV) {
    app.use((req, res, next) => {
        console.log(
            chalk.gray(`[${new Date().toISOString()}]`),
            chalk.yellow(req.method.padEnd(6)),
            req.originalUrl,
        );
        next();
    });
}

// ── No-store for dynamic pages ─────────────────────────────────
// Authenticated pages embed the signed-in admin server-side, so they must
// never be served from the browser/back-forward cache after login/logout.
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
});

// ── Routes ─────────────────────────────────────────────────────
// Auth (public). The login page is the entry point; everything else is
// gated by requireAdmin which redirects unauthenticated visitors here.
app.get ('/login',  AuthController.loginPage);
app.post('/login',  AuthController.doLogin);
app.post('/logout', AuthController.logout);

// Forgot / reset password (public).
app.get ('/forgot-password', AuthController.forgotPage);
app.post('/forgot-password', AuthController.doForgot);
app.get ('/reset-password',  AuthController.resetPage);
app.post('/reset-password',  AuthController.doReset);

// Super-admin company switcher — store the picked company on the session.
// Company logins are pinned to their own company on the api side, so this is
// a no-op for them.
//
// IMPORTANT: the session-file-store writes to disk ASYNCHRONOUSLY, so we MUST
// wait for req.session.save() to finish before redirecting — otherwise the
// browser loads the next page before the file is written and companyContext
// reads the OLD session (no company), making the selection appear not to
// stick. We also sanitise the redirect target to a same-origin path so the
// referer can never bounce us off-site or into a loop.
app.post('/select-company', requireAdmin, (req, res) => {
    const id = req.body && req.body.company_id;
    req.session.company_id = (id != null && id !== '') ? Number(id) : null;

    // Return to the SAME page the switch was made on. Use the hidden `next`
    // field — the Referer header can't be trusted (Helmet's Referrer-Policy:
    // no-referrer strips it). Only same-origin absolute paths are honoured.
    let back = '/';
    const raw = String((req.body && req.body.next) || '').trim();
    if (raw.startsWith('/') && !raw.startsWith('//') && raw.indexOf('/select-company') !== 0) {
        back = raw;
    }

    req.session.save(() => res.redirect(back));
});

// Dashboard (gated). Landing page after a successful login. companyContext
// loads the company list + selected company for the topbar switcher and the
// loyalty screens. The full loyalty-management screens (Cashback Rules, Tiers,
// Challenges, Review Claims, Segments) mount the same middleware.
app.get('/', requireAdmin, companyContext, DashboardController.index);

// ── Account pages (topbar menu) ────────────────────────────────────
app.get ('/profile',         requireAdmin, companyContext, AuthController.profilePage);
app.post('/profile',         requireAdmin, companyContext, AuthController.updateProfile);
app.get ('/change-password', requireAdmin, companyContext, AuthController.changePasswordPage);
app.post('/change-password', requireAdmin, companyContext, AuthController.doChangePassword);

// ── Store-settings image uploads (written into the Yii uploads tree) ──
// multer is required lazily so the admin still boots if the package isn't
// installed yet — uploads just stay unavailable until `npm install`.
let storeImgUpload = null;
try {
    const multer = require('multer');
    const STORE_IMG = {
        business_image: { sub: 'branch',          prefix: 'branch' },
        discount_icon:  { sub: 'discount_logos', prefix: 'discount' },
        surprise_image: { sub: 'surprise_image', prefix: 'surprise' },
        banner_image:   { sub: 'banner_image',   prefix: 'banner' },
    };
    const uploadCompanyId = (req) => {
        const a = (req.session && req.session.admin) || {};
        if (a.role && a.role !== 'super_admin' && Number(a.company_id) > 0) { return Number(a.company_id); }
        return (req.session && req.session.company_id != null) ? Number(req.session.company_id) : null;
    };
    storeImgUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const cfg = STORE_IMG[file.fieldname];
                const cid = uploadCompanyId(req);
                if (!cfg || !cid || !process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, String(cid), cfg.sub);
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const cfg = STORE_IMG[file.fieldname];
                const cid = uploadCompanyId(req);
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })[file.mimetype] || '.img';
                cb(null, cfg.prefix + '_' + cid + '_' + Date.now() + ext);
            },
        }),
        limits: { fileSize: 4 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp)$/.test(file.mimetype)),
    });
} catch (e) {
    console.warn('[admin] multer not installed — store image uploads disabled until `npm install`.');
}

app.post('/store-settings/upload', requireAdmin, companyContext, (req, res) => {
    if (!storeImgUpload || !process.env.YII_UPLOADS_PATH) {
        if (req.flash) { req.flash('error', 'Image uploads aren’t configured on this environment yet.'); }
        return res.redirect('/store-settings');
    }
    const mw = storeImgUpload.fields([
        { name: 'business_image', maxCount: 1 },
        { name: 'discount_icon', maxCount: 1 },
        { name: 'surprise_image', maxCount: 1 },
        { name: 'banner_image', maxCount: 1 },
    ]);
    mw(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 4 MB.' : 'Could not upload that image. Use a PNG, JPG or WEBP.';
            if (req.flash) { req.flash('error', msg); }
            return res.redirect('/store-settings');
        }
        return StoreSettingsController.uploadImage(req, res);
    });
});

// ── Loyalty Review-CMS screenshot uploads (uploads/<companyId>/loyalty/) ──
// Matches the legacy getSubDomainDir() = "<companyId>/" path. multer parses the
// multipart edit form (screenshot optional); the filename is posted to the api.
let loyaltyCmsUpload = null;
try {
    const multer = require('multer');
    const cmsCompanyId = (req) => {
        const a = (req.session && req.session.admin) || {};
        if (a.role && a.role !== 'super_admin' && Number(a.company_id) > 0) { return Number(a.company_id); }
        return (req.session && req.session.company_id != null) ? Number(req.session.company_id) : null;
    };
    loyaltyCmsUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const cid = cmsCompanyId(req);
                if (!cid || !process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, String(cid), 'loyalty');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
                cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
            },
        }),
        limits: { fileSize: 4 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
    });
} catch (e) { /* store block already warned about missing multer */ }

function cmsUploadMw(req, res, next) {
    if (!loyaltyCmsUpload || !process.env.YII_UPLOADS_PATH) {
        if (req.flash) { req.flash('error', 'Image uploads aren’t configured on this environment yet.'); }
        return res.redirect('/loyalty/cms-pages');
    }
    loyaltyCmsUpload.single('screenshot')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 4 MB.' : 'Could not upload that image. Use a PNG, JPG, GIF or WEBP.';
            if (req.flash) { req.flash('error', msg); }
            return res.redirect('/loyalty/cms-pages');
        }
        return next();
    });
}

// ── Product image uploads (uploads/<companyId>/products/) ──
let productImgUpload = null;
try {
    const multer = require('multer');
    const pCompanyId = (req) => {
        const a = (req.session && req.session.admin) || {};
        if (a.role && a.role !== 'super_admin' && Number(a.company_id) > 0) { return Number(a.company_id); }
        return (req.session && req.session.company_id != null) ? Number(req.session.company_id) : null;
    };
    productImgUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const cid = pCompanyId(req);
                if (!cid || !process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, String(cid), 'products');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
                cb(null, 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
            },
        }),
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
    });
} catch (e) { /* store block already warned about missing multer */ }

function productImgMw(req, res, next) {
    if (!productImgUpload || !process.env.YII_UPLOADS_PATH) {
        if (req.flash) { req.flash('error', 'Image uploads aren’t configured on this environment yet.'); }
        return res.redirect('/products/new');
    }
    productImgUpload.single('image')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5 MB.' : 'Could not upload that image. Use a PNG, JPG, GIF or WEBP.';
            if (req.flash) { req.flash('error', msg); }
            return res.redirect((req.body && req.body.id) ? ('/products/edit/' + req.body.id) : '/products/new');
        }
        return next();
    });
}

// Products (Menu → Item) — Phase 1: the list page + its AJAX actions.
app.get ('/products',               requireAdmin, companyContext, ProductsController.list);
app.get ('/products/new',           requireAdmin, companyContext, ProductsController.form);
app.get ('/products/view/:id',      requireAdmin, companyContext, ProductsController.view);
app.get ('/products/edit/:id',      requireAdmin, companyContext, ProductsController.form);
app.post('/products/save',          requireAdmin, companyContext, productImgMw, ProductsController.save);
app.post('/products/price',         requireAdmin, companyContext, ProductsController.updatePrice);
app.post('/products/status',        requireAdmin, companyContext, ProductsController.updateStatus);
app.post('/products/delete',        requireAdmin, companyContext, ProductsController.remove);
app.post('/products/online-prices', requireAdmin, companyContext, ProductsController.bulkOnlinePrice);
app.post('/products/bulk-price',    requireAdmin, companyContext, ProductsController.bulkPrice);
app.post('/products/marketplace',   requireAdmin, companyContext, ProductsController.marketplaceToggle);

// ── Marketplace category image uploads (GLOBAL — uploads/marketplace/category/) ──
let mpCatUpload = null;
try {
    const multer = require('multer');
    mpCatUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                if (!process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, 'marketplace', 'category');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' })[file.mimetype] || '.img';
                cb(null, 'mpcat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
            },
        }),
        limits: { fileSize: 3 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.mimetype)),
    });
} catch (e) { /* multer not installed; uploads disabled */ }

function mpCatImgMw(req, res, next) {
    if (!mpCatUpload || !process.env.YII_UPLOADS_PATH) {
        if (req.flash) { req.flash('error', 'Image uploads aren’t configured on this environment yet.'); }
        return res.redirect('/marketplace-categories');
    }
    mpCatUpload.single('image')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 3 MB.' : 'Could not upload that image. Use a PNG, JPG, GIF, WEBP or SVG.';
            if (req.flash) { req.flash('error', msg); }
            return res.redirect((req.body && req.body.id) ? ('/marketplace-categories/edit/' + req.body.id) : '/marketplace-categories/new');
        }
        return next();
    });
}

// Marketplace Categories (global master — super admin).
app.get ('/marketplace-categories',           requireAdmin, companyContext, MpCategoriesController.list);
app.get ('/marketplace-categories/arrange',   requireAdmin, companyContext, MpCategoriesController.arrange);
app.get ('/marketplace-categories/new',       requireAdmin, companyContext, MpCategoriesController.form);
app.get ('/marketplace-categories/edit/:id',  requireAdmin, companyContext, MpCategoriesController.form);
app.post('/marketplace-categories/save',      requireAdmin, companyContext, mpCatImgMw, MpCategoriesController.save);
app.post('/marketplace-categories/delete',    requireAdmin, companyContext, MpCategoriesController.remove);
app.post('/marketplace-categories/status',    requireAdmin, companyContext, MpCategoriesController.statusToggle);
app.get ('/marketplace-categories/companies', requireAdmin, companyContext, MpCategoriesController.companies);
app.get ('/marketplace-categories/restaurants', requireAdmin, companyContext, MpCategoriesController.restaurants);
app.post('/marketplace-categories/assign',    requireAdmin, companyContext, MpCategoriesController.assign);
app.post('/marketplace-categories/reorder',   requireAdmin, companyContext, MpCategoriesController.reorder);

// ── Collection cover-image uploads (GLOBAL — uploads/marketplace/collection/) ──
let mpColUpload = null;
try {
    const multer = require('multer');
    mpColUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                if (!process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, 'marketplace', 'collection');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' })[file.mimetype] || '.img';
                cb(null, 'mpcol_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
            },
        }),
        limits: { fileSize: 3 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.mimetype)),
    });
} catch (e) { /* multer not installed; uploads disabled */ }

// The collection cover image is OPTIONAL — unlike categories, a missing
// multer / uploads path must NOT block the save (the form may carry no file).
// So we parse the multipart body best-effort and continue regardless.
function mpColImgMw(req, res, next) {
    if (!mpColUpload || !process.env.YII_UPLOADS_PATH) { return next(); }
    mpColUpload.single('image')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            if (req.flash) { req.flash('error', 'Cover image must be under 3 MB.'); }
            return res.redirect((req.body && req.body.id) ? ('/collections/edit/' + req.body.id) : '/collections/new');
        }
        return next();
    });
}

// Collections (curated home-feed rows — super admin).
app.get ('/collections',             requireAdmin, companyContext, CollectionsController.list);
app.get ('/collections/arrange',     requireAdmin, companyContext, CollectionsController.arrange);
app.get ('/collections/new',         requireAdmin, companyContext, CollectionsController.form);
app.get ('/collections/edit/:id',    requireAdmin, companyContext, CollectionsController.form);
app.post('/collections/save',        requireAdmin, companyContext, mpColImgMw, CollectionsController.save);
app.post('/collections/delete',      requireAdmin, companyContext, CollectionsController.remove);
app.post('/collections/status',      requireAdmin, companyContext, CollectionsController.statusToggle);
app.post('/collections/reorder',     requireAdmin, companyContext, CollectionsController.reorder);
app.get ('/collections/companies',   requireAdmin, companyContext, CollectionsController.companies);

// Featured / sponsored placements (super admin).
app.get ('/featured',           requireAdmin, companyContext, FeaturedController.list);
app.get ('/featured/new',       requireAdmin, companyContext, FeaturedController.form);
app.get ('/featured/edit/:id',  requireAdmin, companyContext, FeaturedController.form);
app.post('/featured/save',      requireAdmin, companyContext, FeaturedController.save);
app.post('/featured/delete',    requireAdmin, companyContext, FeaturedController.remove);
app.post('/featured/status',    requireAdmin, companyContext, FeaturedController.statusToggle);
app.post('/featured/reorder',   requireAdmin, companyContext, FeaturedController.reorder);
app.get ('/featured/companies', requireAdmin, companyContext, FeaturedController.companies);

// Featured Products (admin-picked dishes → home product rows — super admin).
app.get ('/featured-products',                requireAdmin, companyContext, FeaturedProductsController.list);
app.get ('/featured-products/new',            requireAdmin, companyContext, FeaturedProductsController.form);
app.get ('/featured-products/edit/:companyId', requireAdmin, companyContext, FeaturedProductsController.form);
app.post('/featured-products/save',           requireAdmin, companyContext, FeaturedProductsController.save);
app.post('/featured-products/delete',         requireAdmin, companyContext, FeaturedProductsController.remove);
app.post('/featured-products/status',         requireAdmin, companyContext, FeaturedProductsController.statusToggle);
app.post('/featured-products/reorder',        requireAdmin, companyContext, FeaturedProductsController.reorder);
app.get ('/featured-products/companies',      requireAdmin, companyContext, FeaturedProductsController.companies);
app.get ('/featured-products/products',       requireAdmin, companyContext, FeaturedProductsController.products);

// Feed Order (one master ordering of the 4 home-feed sections — super admin).
app.get ('/feed-sections',         requireAdmin, companyContext, FeedSectionsController.page);
app.post('/feed-sections/reorder', requireAdmin, companyContext, FeedSectionsController.reorder);

// ── Community group cover uploads (GLOBAL — uploads/marketplace/community_group/) ──
// Shared yii-uploads tree so BOTH web + admin serve the cover via /yii-uploads.
let mpCommUpload = null;
try {
    const multer = require('multer');
    mpCommUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                if (!process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, 'marketplace', 'community_group');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
                cb(null, 'mpcomm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
            },
        }),
        limits: { fileSize: 3 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
    });
} catch (e) { /* multer not installed; uploads disabled */ }

// Cover image is OPTIONAL — a missing multer / uploads path must not block save.
function mpCommImgMw(req, res, next) {
    if (!mpCommUpload || !process.env.YII_UPLOADS_PATH) { return next(); }
    mpCommUpload.single('image')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            if (req.flash) { req.flash('error', 'Cover image must be under 3 MB.'); }
            return res.redirect((req.body && req.body.id) ? ('/community/edit/' + req.body.id) : '/community/new');
        }
        return next();
    });
}

// Community POST photos (GLOBAL — uploads/marketplace/community/, SHARED with
// the web so an admin's photo shows on both feeds). Optional, like the cover.
let mpCommPostUpload = null;
try {
    const multer = require('multer');
    mpCommPostUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                if (!process.env.YII_UPLOADS_PATH) { return cb(new Error('upload_unavailable')); }
                const dir = path.join(process.env.YII_UPLOADS_PATH, 'marketplace', 'community');
                try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
                cb(null, 'cmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
            },
        }),
        limits: { fileSize: 4 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
    });
} catch (e) { /* multer not installed */ }
function mpCommPostMw(req, res, next) {
    if (!mpCommPostUpload || !process.env.YII_UPLOADS_PATH) { return next(); }
    mpCommPostUpload.single('image')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') { return res.status(200).json({ status: 400, show: true, msg: 'Photo must be under 4 MB.' }); }
        return next();
    });
}
// Group management + moderation are super-admin only; company admins only join
// the feeds. Runs after companyContext (reads res.locals.company_ctx).
function requireSuper(req, res, next) {
    if (res.locals.company_ctx && res.locals.company_ctx.isSuper) { return next(); }
    if (req.method === 'GET') { return res.redirect('/community'); }
    return res.status(200).json({ status: 403, show: true, msg: 'Only the super-admin can do that.' });
}

// ── Community ──────────────────────────────────────────────────────
// List + a group's feed are open to ALL admins (company admins join to post /
// comment / reply). Group management + moderation (delete) are super-admin.
app.get ('/community',                requireAdmin, companyContext, CommunityController.list);
app.get ('/community/new',            requireAdmin, companyContext, requireSuper, CommunityController.form);
app.get ('/community/edit/:id',       requireAdmin, companyContext, requireSuper, CommunityController.form);
app.post('/community/save',           requireAdmin, companyContext, requireSuper, mpCommImgMw, CommunityController.save);
app.post('/community/delete',         requireAdmin, companyContext, requireSuper, CommunityController.remove);
app.post('/community/status',         requireAdmin, companyContext, requireSuper, CommunityController.statusToggle);
app.get ('/community/feed/:id',       requireAdmin, companyContext, CommunityController.feedPage);
app.get ('/community/feed',           requireAdmin, companyContext, CommunityController.feedData);
app.get ('/community/comments',       requireAdmin, companyContext, CommunityController.commentsData);
app.post('/community/post',           requireAdmin, companyContext, mpCommPostMw, CommunityController.createPost);
app.post('/community/comment',        requireAdmin, companyContext, CommunityController.addComment);
app.post('/community/post-delete',    requireAdmin, companyContext, requireSuper, CommunityController.deletePost);
app.post('/community/comment-delete', requireAdmin, companyContext, requireSuper, CommunityController.deleteComment);

// Store Settings — branch config (port of legacy admin/pos/store-settings).
app.get ('/store-settings',                requireAdmin, companyContext, StoreSettingsController.index);
app.post('/store-settings/save',           requireAdmin, companyContext, StoreSettingsController.save);
app.post('/store-settings/website-status', requireAdmin, companyContext, StoreSettingsController.saveWebsiteStatus);
app.post('/store-settings/tips',           requireAdmin, companyContext, StoreSettingsController.saveTips);
app.get ('/store-settings/advance',        requireAdmin, companyContext, StoreSettingsController.advanceIndex);
app.post('/store-settings/advance',        requireAdmin, companyContext, StoreSettingsController.advanceSave);
app.post('/store-settings/advance/delete', requireAdmin, companyContext, StoreSettingsController.advanceDelete);

// ── Loyalty management screens (gated + company-scoped) ────────────
// Shared gate: signed-in admin → company context → loyalty availability
// (a company login only reaches these when its loyalty is switched ON).
const loyaltyGate = [requireAdmin, companyContext, requireLoyalty];
// Loyalty Dashboard (the Loyalty menu landing / hub).
app.get ('/loyalty', loyaltyGate, LoyaltyController.loyaltyConfig);
// Company-level loyalty on/off (super admin enables loyalty for a company).
app.post('/loyalty/master-toggle', loyaltyGate, LoyaltyController.masterToggle);
// Company-level loyalty settings (commission % + phone orders).
app.post('/loyalty/company-config', loyaltyGate, LoyaltyController.companyConfigSave);
// Save All — the whole config page in one POST.
app.post('/loyalty/save-all', loyaltyGate, LoyaltyController.saveAll);
// ── Per-section save endpoints (the combined /loyalty page posts here; each
// redirects back to /loyalty). The old standalone GET screens now just bounce
// to the single Loyalty Configuration page. ──
const toConfig = (req, res) => res.redirect('/loyalty');
// Cashback Rules.
app.get ('/loyalty/cashback-rules',        loyaltyGate, toConfig);
app.post('/loyalty/cashback-rules/save',   loyaltyGate, LoyaltyController.cashbackSave);
app.post('/loyalty/cashback-rules/delete', loyaltyGate, LoyaltyController.cashbackDelete);
app.post('/loyalty/cashback-rules/toggle', loyaltyGate, LoyaltyController.cashbackToggle);
app.post('/loyalty/cashback-rules/config', loyaltyGate, LoyaltyController.configSave);
// Tier Config.
app.get ('/loyalty/tiers',        loyaltyGate, toConfig);
app.post('/loyalty/tiers/save',   loyaltyGate, LoyaltyController.tierSave);
app.post('/loyalty/tiers/toggle', loyaltyGate, LoyaltyController.tierToggle);
// Referral & Streak.
app.get ('/loyalty/referral-streak',                 loyaltyGate, toConfig);
app.post('/loyalty/referral-streak/referral/save',   loyaltyGate, LoyaltyController.referralSave);
app.post('/loyalty/referral-streak/referral/toggle', loyaltyGate, LoyaltyController.referralToggle);
app.post('/loyalty/referral-streak/streak/save',     loyaltyGate, LoyaltyController.streakSave);
app.post('/loyalty/referral-streak/streak/toggle',   loyaltyGate, LoyaltyController.streakToggle);
app.post('/loyalty/referral-streak/streak/delete',   loyaltyGate, LoyaltyController.streakDelete);
// Challenges.
app.get ('/loyalty/challenges',        loyaltyGate, toConfig);
app.post('/loyalty/challenges/save',   loyaltyGate, LoyaltyController.challengesSave);
app.post('/loyalty/challenges/toggle', loyaltyGate, LoyaltyController.challengesToggle);
// Event Rewards.
app.get ('/loyalty/events',        loyaltyGate, toConfig);
app.post('/loyalty/events/save',   loyaltyGate, LoyaltyController.eventsSave);
app.post('/loyalty/events/toggle', loyaltyGate, LoyaltyController.eventsToggle);
// Review Claims.
app.get ('/loyalty/review-claims',         loyaltyGate, LoyaltyController.reviewClaims);
app.post('/loyalty/review-claims/approve', loyaltyGate, LoyaltyController.reviewApprove);
app.post('/loyalty/review-claims/reject',  loyaltyGate, LoyaltyController.reviewReject);
// Customer Segments — now shown on the Dashboard; old link redirects there.
app.get ('/loyalty/segments', loyaltyGate, (req, res) => res.redirect('/'));
// Special Offer (date-based cashback).
app.get ('/loyalty/special-offer',        loyaltyGate, toConfig);
app.post('/loyalty/special-offer/save',   loyaltyGate, LoyaltyController.specialOfferSave);
app.post('/loyalty/special-offer/toggle', loyaltyGate, LoyaltyController.specialOfferToggle);
app.post('/loyalty/special-offer/delete', loyaltyGate, LoyaltyController.specialOfferDelete);
// Review Rewards (per review/share type).
app.get ('/loyalty/review-rewards',        loyaltyGate, toConfig);
app.post('/loyalty/review-rewards/save',   loyaltyGate, LoyaltyController.reviewRewardsSave);
app.post('/loyalty/review-rewards/toggle', loyaltyGate, LoyaltyController.reviewRewardsToggle);
// Product Cashback (rule + selected products).
app.get ('/loyalty/product-cashback',        loyaltyGate, toConfig);
app.post('/loyalty/product-cashback/save',   loyaltyGate, LoyaltyController.productCashbackSave);
app.post('/loyalty/product-cashback/toggle', loyaltyGate, LoyaltyController.productCashbackToggle);
app.post('/loyalty/product-cashback/delete', loyaltyGate, LoyaltyController.productCashbackDelete);
// Buy X Get Y (BOGO).
app.get ('/loyalty/bogof',        loyaltyGate, toConfig);
app.post('/loyalty/bogof/save',   loyaltyGate, LoyaltyController.bogofSave);
app.post('/loyalty/bogof/toggle', loyaltyGate, LoyaltyController.bogofToggle);
app.post('/loyalty/bogof/delete', loyaltyGate, LoyaltyController.bogofDelete);
// Review CMS Pages (per review-type instructional content + screenshot).
app.get ('/loyalty/cms-pages',      loyaltyGate, LoyaltyController.cmsPages);
app.post('/loyalty/cms-pages/save', loyaltyGate, cmsUploadMw, LoyaltyController.cmsPageSave);

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).render('errors/404', {
        page_title:  'Page not found',
        _layoutFile: '../_layout',
        bare:        true,
    });
});

// ── Error handler ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(chalk.red('[error]'), err.stack || err);
    res.status(500).render('errors/500', {
        page_title:  'Something went wrong',
        _layoutFile: '../_layout',
        bare:        true,
        error_msg:   IS_DEV ? err.message : null,
    });
});

// ── Boot ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4503;

// Make sure the sessions dir exists before the store writes to it.
try { fs.mkdirSync(path.join(__dirname, 'runtime', 'sessions'), { recursive: true }); } catch (e) { /* ignore */ }

app.listen(PORT, '0.0.0.0', async () => {
    try {
        cachedBrand = await fetchBrand();
        lastBrandFetchMs = Date.now();
    } catch (err) {
        console.error('[boot] brand fetch failed', err && err.message);
    }

    const apiUrl = process.env.API_URL || 'http://localhost:4501';
    const brandLabel = (cachedBrand && cachedBrand.name) || 'EatNDeal';

    console.log(chalk.magentaBright(`\n  🛠️  ${brandLabel} Admin (PWA) running`));
    console.log(chalk.cyan      (`      URL  : http://localhost:${PORT}`));
    console.log(chalk.cyan      (`      API  : ${apiUrl}`));
    console.log(chalk.gray      (`      Env  : ${ENV}`));
    console.log('');
});

module.exports = app;
