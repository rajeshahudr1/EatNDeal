'use strict';

/**
 * web/index.js — EatNDeal Web (PWA) entry point
 *
 * What:   Boots the Express server, wires middleware, mounts routes, and
 *         renders EJS views for the public marketplace pages.
 * Why:    Single boot file. The web layer is intentionally thin — it does
 *         NOT touch the database. Every data call goes through api/ via
 *         Helpers/apiClient.js.
 * Type:   READ + WRITE (request → render or proxy to api).
 * Inputs: process.env (see web/.env.example).
 * Output: HTTP server listening on PORT (default 4502).
 * Used:   Process entry. `npm start` / `npm run dev`.
 *
 * Boot order (top-to-bottom — do not reshuffle):
 *   1. Load .env
 *   2. EJS engine + ejs-locals (for layouts) + views path
 *   3. helmet (strict CSP — no inline scripts/styles per CODING-CONVENTIONS #6)
 *   4. compression
 *   5. body parsers
 *   6. static /  (with PWA-aware headers on service-worker.js)
 *   7. session + flash
 *   8. res.locals injector (brand, asset_version, flash, etc.)
 *   9. routes
 *  10. 404 + error handlers
 *  11. listen + brand pre-fetch
 *
 * Change log:
 *   2026-05-25 — initial scaffold; one public route ( / ).
 */

require('dotenv').config();

const path        = require('path');
const fs          = require('fs');
const express     = require('express');
const multer      = require('multer');
const session     = require('express-session');
const FileStore    = require('session-file-store')(session);
const flash       = require('express-flash');
const helmet      = require('helmet');
const compression = require('compression');
const ejsLocals   = require('ejs-locals');
const chalk       = require('chalk');

const { fetchBrand, callApi } = require('./Helpers/apiClient');
const SiteController       = require('./Controllers/SiteController');
const LocationController   = require('./Controllers/LocationController');
const AddressController     = require('./Controllers/AddressController');
const FavouriteController   = require('./Controllers/FavouriteController');
const CartController        = require('./Controllers/CartController');
const OrderController       = require('./Controllers/OrderController');
const PaymentController     = require('./Controllers/PaymentController');
const MerchantController    = require('./Controllers/MerchantController');
const AuthController       = require('./Controllers/AuthController');
const WalletController      = require('./Controllers/WalletController');
const EarnController        = require('./Controllers/EarnController');
// Reviews of EATNDEAL itself (marketplace, company_id = 0) — moderated.
const SiteReviewController  = require('./Controllers/SiteReviewController');
const CommunityController   = require('./Controllers/CommunityController');
const StaticPageController = require('./Controllers/StaticPageController');
const AppController         = require('./Controllers/AppController');

const app    = express();
const ENV    = process.env.APP_ENV || 'development';
const IS_DEV = ENV !== 'production';

// ── Writable runtime data dir (sessions + uploaded photos) ──────
// Defaults to web/runtime. On a server where the app directory is read-only
// (e.g. /var/www/html/...), set RUNTIME_DIR to a writable path the node user
// owns (e.g. /var/lib/eatndeal/web-runtime) so the session store + uploads
// don't fail to boot with EACCES.
const RUNTIME_DIR = process.env.RUNTIME_DIR
    ? path.resolve(process.env.RUNTIME_DIR)
    : path.join(__dirname, 'runtime');
try { 
    if (!fs.existsSync(RUNTIME_DIR)) {
            fs.mkdirSync(RUNTIME_DIR);
        }
} catch (e) { /* per-subdir mkdirs below surface the real error */ }

app.set('trust proxy', true);
app.disable('x-powered-by');

// ── View engine ─────────────────────────────────────────────────
// ejs-locals adds layout / partial support on top of plain EJS. We pin
// EJS to v3 (see package.json overrides) so ejs-locals plays nicely.
app.set('views', path.join(__dirname, 'views'));
app.engine('ejs', ejsLocals);
app.set('view engine', 'ejs');

// ── Security headers ────────────────────────────────────────────
// We split the policy between dev and prod:
//
//   • DEV  — Helmet runs WITHOUT a CSP. On plain-HTTP localhost a strict
//            CSP (especially `upgrade-insecure-requests` from Helmet's
//            defaults) can silently block our own CSS / fonts and leave
//            the page looking unstyled with no obvious error. Skipping
//            CSP in dev keeps the design visible and lets browser
//            DevTools show real network / JS errors un-masked.
//
//   • PROD — CSP is locked to our own origin (Coding-Conventions rule #6):
//            no inline scripts, no inline styles, no third-party hosts.
//            Anything trying to violate this is blocked AND logged by
//            the browser, which is what we want once we ship.
//
// img-src adds 'data:' for tiny SVG/PNG data-urls used inside our own CSS
// (component icons). font-src is 'self' — every font we ship is in
// /fonts/ on our own origin. NO Google Fonts, NO CDN.
// In production the CSP locks img-src to our own origin. The legacy Yii uploads
// (product / restaurant images) may live on ANOTHER host — the marketplace then
// references them by ABSOLUTE URL, so we allow that host (derived from
// YII_UPLOADS_URL) plus any extra hosts / CDNs listed in IMG_HOSTS.
function hostOf(u) { try { return new URL(u).origin; } catch (e) { return null; } }
const EXTRA_IMG_HOSTS = [];
const uploadsOrigin = hostOf(process.env.YII_UPLOADS_URL || '');
if (uploadsOrigin) { EXTRA_IMG_HOSTS.push(uploadsOrigin); }
// The api serves marketplace + community images at <api>/upload — allow the
// api host in img-src (API_URL must be the api's PUBLIC url in production).
const mediaOrigin = hostOf(process.env.API_URL || 'http://localhost:4501');
if (mediaOrigin && EXTRA_IMG_HOSTS.indexOf(mediaOrigin) === -1) { EXTRA_IMG_HOSTS.push(mediaOrigin); }
(process.env.IMG_HOSTS || '').split(/[\s,]+/).filter(Boolean).forEach((h) => { if (EXTRA_IMG_HOSTS.indexOf(h) === -1) { EXTRA_IMG_HOSTS.push(h); } });

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
                // Stripe.js v3 is served from js.stripe.com. We allow
                // exactly that origin and Stripe's hosted-fields iframe
                // domain (hooks.stripe.com) so card input renders.
                'script-src':      ["'self'", 'https://js.stripe.com'],
                'style-src':       ["'self'"],
                // maps.googleapis.com → Google Static Maps image (pickup map).
                'img-src':         ["'self'", 'data:', 'https://maps.googleapis.com'].concat(EXTRA_IMG_HOSTS),
                'font-src':        ["'self'"],
                // Card confirmation hits the Stripe API directly from
                // the browser; allow it on the connect-src list.
                'connect-src':     ["'self'", process.env.API_URL || 'http://localhost:4501', 'https://api.stripe.com'],
                // Google Maps Embed API renders the location maps in an iframe.
                'frame-src':       ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com', 'https://www.google.com'],
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
// Special-case for /service-worker.js: it MUST be served with
// `Service-Worker-Allowed: /` so the browser registers it at root scope
// (otherwise the SW controls only /public/* and skips the rest of the site).
// We also bust its cache aggressively so SW updates roll out immediately.
app.use(express.static(path.join(__dirname, 'public'), {
    // PRODUCTION: cache assets hard. Every CSS/JS URL in the layout carries
    // ?v=<ASSET_VERSION>, which changes on each deploy (boot-time stamp), so a
    // new build is fetched under a NEW url — the cached copy of the old one can
    // never be served by mistake. That is what makes `immutable` safe here.
    //
    // Without this express.static defaults to max-age=0, so every navigation
    // re-validated all ~47 stylesheets: 47 round trips before the browser could
    // paint anything, which is the blank-white-page-then-content people saw.
    // Dev keeps maxAge 0 and the no-store header below.
    maxAge: ENV === 'production' ? '365d' : 0,
    immutable: ENV === 'production',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(path.sep + 'service-worker.js')) {
            // The SW itself must never be cached — it is what ships updates.
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.endsWith(path.sep + 'manifest.json')) {
            // Small, unversioned, and read on install — a day is plenty.
            res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (ENV !== 'production') {
            // DEV: never let the browser cache CSS / JS / images. Combined
            // with the SW being disabled on localhost (see app.js), this
            // means a code change shows on a plain refresh — no "clear
            // cache" dance.
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
    },
}));

// ── Yii uploads passthrough ────────────────────────────────────
// Bridges the legacy Yii backend uploads folder so the marketplace
// dashboard can render product / category / restaurant images
// without a separate media server. Two env knobs:
//   YII_UPLOADS_PATH  — absolute disk path to the Yii uploads root
//                       (e.g. D:\…\backend\web\uploads)
//   YII_UPLOADS_URL   — public URL prefix the api builds (matches
//                       the marketplace.yiiImageUrl helper). Defaults
//                       to /yii-uploads on both sides.
// When the path env is blank the mount is skipped — useful in CI /
// containers where the Yii folder isn't present.
const yiiUploadsPath = process.env.YII_UPLOADS_PATH;
const yiiUploadsUrl  = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
if (yiiUploadsPath) {
    app.use(yiiUploadsUrl, express.static(yiiUploadsPath, {
        // Cache aggressively in prod — image filenames are content-
        // hashed by the Yii admin so they're effectively immutable.
        maxAge: ENV === 'production' ? '7d' : 0,
        fallthrough: true,
    }));
}

// ── Media: the NEW project's OWN image uploads (community post photos) ──
// These live on THIS (new) server and serve at /media; legacy product /
// restaurant images keep coming from the old server (YII_UPLOADS_URL). Default
// <runtime>/media (always writable); set MEDIA_DIR to a persistent path. Stored
// DB values are "/media/<sub>/<file>" so the api passes them through unchanged.
// Uploads land in the api's shared folder (api/public/upload); the API serves
// them + returns the FULL url, so the web only WRITES the file and stores a
// RELATIVE "/upload/<sub>/<file>". It does NOT build or serve the url — the api
// owns that (no api/media url configured here). On separate servers, point
// MEDIA_DIR at a shared mount the api also reads.
const MEDIA_DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(__dirname, '..', 'api', 'public', 'upload');
const MEDIA_URL = (process.env.MEDIA_URL || '/upload').replace(/\/$/, '');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* shared api folder */ }

// ── Profile avatar uploads ─────────────────────────────────────
// Avatar is ONE of the 4 "our-server" media types (community, home feed,
// avatar, marketplace category). NEW photos go into the shared api upload
// tree at MEDIA_DIR/avatar (the api serves it at /upload/avatar/) and are
// stored as a relative "/upload/avatar/<file>" in customer.image — the api
// builds the FULL url on read (customerLookup.publicView → mediaUrl), so the
// web only WRITES the file and never builds the url. The old web-origin
// /avatars mount stays so photos uploaded before this change still load.
const AVATAR_MEDIA_DIR = path.join(MEDIA_DIR, 'avatar');
try { fs.mkdirSync(AVATAR_MEDIA_DIR, { recursive: true }); } catch (e) { /* shared api folder */ }
const AVATAR_DIR = path.join(RUNTIME_DIR,'avatars');   // legacy (pre-/upload) photos only
try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (e) { /* ignore */ }
app.use('/avatars', express.static(AVATAR_DIR, { maxAge: ENV === 'production' ? '7d' : 0, fallthrough: true }));

// ── Restaurant images ──────────────────────────────────────────
// Demo/marketplace restaurant photos (seeded by api/scripts/
// seed-restaurant-images.js) live in gitignored web/runtime/
// restaurant-images and are served from the web origin so the strict
// img-src 'self' CSP allows them. branch.banner_image stores the
// relative path "/restaurant-images/<file>".
const RESTO_IMG_DIR = path.join(RUNTIME_DIR,'restaurant-images');
try { fs.mkdirSync(RESTO_IMG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
app.use('/restaurant-images', express.static(RESTO_IMG_DIR, { maxAge: ENV === 'production' ? '7d' : 0, fallthrough: true }));

// ── Internal docs (the data-map slide deck etc.) ───────────────────
// Plain static HTML/MD served from project-root/docs. Not linked from
// the public site; reachable directly at /docs/<file>. The deck has
// inline CSS + JS so a strict CSP elsewhere doesn't apply here — the
// static middleware just streams the file as-is.
const DOCS_DIR = path.join(__dirname, '..', 'docs');
app.use('/docs', express.static(DOCS_DIR, { maxAge: 0, fallthrough: true }));
const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, AVATAR_MEDIA_DIR),   // shared /upload/avatar
        filename: (req, file, cb) => {
            const uid = (req.session && req.session.user && req.session.user.id) || 'anon';
            const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
            cb(null, uid + '-' + Date.now() + ext);
        },
    }),
    limits: { fileSize: 3 * 1024 * 1024 },   // 3 MB
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});
// Exposed so the route wiring below can use it.
app.locals.avatarUpload = avatarUpload;

// ── Review photo uploads ───────────────────────────────────────
// Optional food photo on a post-order review. Stored on the web disk
// (web/runtime/review-images, gitignored) + served from the web origin so
// the strict img-src 'self' CSP allows it; the api stores only the relative
// path in review_rating.review_photo. Mirrors the avatar flow.
const REVIEW_IMG_DIR = path.join(RUNTIME_DIR,'review-images');
try { fs.mkdirSync(REVIEW_IMG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
app.use('/review-images', express.static(REVIEW_IMG_DIR, { maxAge: ENV === 'production' ? '7d' : 0, fallthrough: true }));
const reviewUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, REVIEW_IMG_DIR),
        filename: (req, file, cb) => {
            const uid = (req.session && req.session.user && req.session.user.id) || 'anon';
            const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg' })[file.mimetype] || '.png';
            cb(null, 'rv-' + uid + '-' + Date.now() + ext);
        },
    }),
    limits: { fileSize: 4 * 1024 * 1024 },   // 4 MB
    // JPG / JPEG / PNG only — the legacy upload API (a restaurant's server)
    // rejects webp/gif with "Only JPG, JPEG, and PNG files are allowed"
    // (backend/controllers/api/DefaultController::actionUploadFile). Restricting
    // here keeps both flows (marketplace + restaurant) consistent and fails at
    // pick-time instead of after a confusing round trip.
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g)$/.test(file.mimetype)),
});

// ── Community post photos ──────────────────────────────────────
// Optional photo on a community post. Stored on the web disk
// (web/runtime/community-images, gitignored) + served from the web origin so
// the strict img-src 'self' CSP allows it; the api stores only the relative
// path "/community-images/<file>" on mp_community_post.image. Mirrors the
// avatar / review-photo flow.
const COMMUNITY_IMG_DIR = path.join(RUNTIME_DIR,'community-images');
try { fs.mkdirSync(COMMUNITY_IMG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
app.use('/community-images', express.static(COMMUNITY_IMG_DIR, { maxAge: ENV === 'production' ? '7d' : 0, fallthrough: true }));
const communityUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            // Community photos live in the NEW server's media tree, served at
            // /media and stored as a "/media/community/<file>" path (shown on
            // both the web + admin feeds when they share this server's MEDIA_DIR).
            const dir = path.join(MEDIA_DIR, 'community');
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const uid = (req.session && req.session.user && req.session.user.id) || 'anon';
            const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype] || '.img';
            cb(null, 'cm-' + uid + '-' + Date.now() + ext);
        },
    }),
    limits: { fileSize: 4 * 1024 * 1024 },   // 4 MB
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

// ── Session ────────────────────────────────────────────────────
// Server-side session (the cookie carries only the session id). The
// data is persisted to disk (session-file-store) under runtime/sessions
// so a server RESTART no longer logs users out — the default in-memory
// store would wipe every session on restart. The sessions dir is
// gitignored (web/runtime/).
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE, 10) || 7 * 24 * 60 * 60 * 1000;
app.use(session({
    name:              process.env.SESSION_NAME   || 'eatndeal_web',
    secret:            process.env.SESSION_SECRET || 'change_me_in_production',
    resave:            false,
    saveUninitialized: false,
    store: new FileStore({
        path:         path.join(RUNTIME_DIR,'sessions'),
        ttl:          Math.floor(SESSION_MAX_AGE / 1000),   // seconds
        retries:      1,
        reapInterval: 60 * 60,        // purge expired files hourly
        logFn:        function () {},  // silence "missing file" noise on first read
    }),
    cookie: {
        maxAge:   SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        secure:   ENV === 'production',
    },
}));

app.use(flash());

/**
 * hydrateLocationFromCookie
 *
 * What:  Middleware. If req.session.userLocation is empty but the
 *        client carries the long-lived `eatndeal_location` cookie
 *        (set by /js/ui/location-modal.js after consent is accepted),
 *        copy the cookie value into the session so SSR + downstream
 *        code see the location.
 * Why:   The express-session cookie lasts 7 days AND lives in MemoryStore
 *        (so it's lost on every server restart). The 30-day client-
 *        readable `eatndeal_location` cookie survives both. This bridge
 *        means a user who accepted cookies + picked a location stays
 *        recognised across:
 *          • server restarts
 *          • days/weeks of inactivity
 *          • new browser sessions
 *        We only run when the session is empty — once hydrated, the
 *        location lives in the session for the rest of the request.
 * Type:  WRITE (only to req.session).
 * Used:  app.use(...) — runs on every request, after session middleware
 *        and before route handlers.
 *
 * Note on cookie parsing — we read the raw header string instead of
 * pulling in the `cookie-parser` package. Only one cookie name matters
 * here, the parsing is trivial, and it keeps the dependency list lean.
 */
app.use((req, res, next) => {
    if (!req.session || req.session.userLocation) { return next(); }

    const header = req.headers.cookie || '';
    if (!header.includes('eatndeal_location=')) { return next(); }

    const parts = header.split(';');
    for (let i = 0; i < parts.length; i++) {
        const pair = parts[i].trim();
        if (pair.indexOf('eatndeal_location=') !== 0) { continue; }
        const raw = pair.substring('eatndeal_location='.length);
        try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            if (parsed && typeof parsed === 'object' && parsed.label) {
                // Re-stamp savedAt so downstream code knows when this
                // hydration happened (the cookie may be days old).
                parsed.hydratedFromCookie = true;
                req.session.userLocation = parsed;
            }
        } catch (e) {
            // Corrupt or out-of-date cookie shape — ignore. The client
            // will rewrite it on the next save() call.
        }
        break;
    }
    next();
});

// ── Asset cache-busting ────────────────────────────────────────
// Every CSS / JS link in the layout has ?v=<ASSET_VERSION>. Bumped to the
// current ms on every server start so a fresh deploy invalidates the
// browser cache without users needing a hard refresh. In production swap
// this for a git SHA or build hash.
app.locals.ASSET_VERSION = String(Date.now());

// Dev only: re-stamp the asset version on EVERY request so CSS/JS edits show
// on a plain reload — no server restart needed (this was a constant friction:
// fixes looked broken because the browser / app WebView served cached CSS).
// Production keeps the stable boot-time value so assets stay cacheable.
// Set NODE_ENV=production to disable.
if (process.env.NODE_ENV !== 'production') {
    app.use(function (req, res, next) {
        res.locals.ASSET_VERSION = String(Date.now());
        next();
    });
}

// Shared server-side render helpers (money / esc / date / initial) available
// in EVERY EJS view as `fmt.*` — one home for display formatting. Browser twin
// is /js/common/format.js (window.EatNDealFormat). See Helpers/viewHelpers.js.
app.locals.fmt = require('./Helpers/viewHelpers');

// ── Cached brand ───────────────────────────────────────────────
// On boot we fetch GET /api/v1/brand once and cache it in-process. Every
// view gets it via res.locals.brand. We refresh in the background on a
// loose interval so changes to the api/ brand config propagate without a
// web restart. If the api is briefly unreachable, the cached copy keeps
// rendering working.
let cachedBrand = null;
let lastBrandFetchMs = 0;
const BRAND_REFRESH_MS = 60 * 1000;   // refresh at most once per minute

/**
 * ensureBrand
 *
 * What:   Express middleware. Makes sure cachedBrand is populated + reasonably
 *         fresh, then attaches it as res.locals.brand for every view.
 * Why:    Single source of truth — change brand once on the api side, every
 *         page on the web reflects it within a minute.
 * Type:   READ.
 * Inputs: req, res, next.
 * Output: calls next() after attaching res.locals.brand.
 * Used:   app.use(ensureBrand) — runs before routes.
 */
async function ensureBrand(req, res, next) {
    const now = Date.now();
    if (!cachedBrand || (now - lastBrandFetchMs) > BRAND_REFRESH_MS) {
        try {
            cachedBrand = await fetchBrand();
            lastBrandFetchMs = now;
        } catch (err) {
            // fetchBrand already returns a fallback; this catch is belt-and-braces.
            console.error('[ensureBrand] unexpected error', err && err.message);
        }
    }
    res.locals.brand = cachedBrand;
    next();
}

app.use(ensureBrand);

// ── Header cart-count primer ────────────────────────────────────
// Keeps `req.session.cartCount` populated so the header badge survives
// page navigations. Strategy:
//
//   • Cart writes (add / update-qty / remove / clear / set-mode /
//     set-address / set-schedule / apply-coupon / remove-coupon) and
//     /cart, /cart/data all snapshot the post-write totalQty back into
//     req.session.cartCount themselves (see web/Controllers/Cart
//     Controller.syncSessionCount). That covers most flow naturally.
//
//   • This middleware handles the LAZY path: a signed-in customer who
//     navigates around without ever hitting a cart endpoint (e.g. just
//     opened the home page on a fresh session). We hit the cheap
//     /api/v1/customer/cart/count endpoint once and cache the result.
//
//   • Sign-out clears the count via destroy(); fresh logins start
//     undefined → the next page render triggers a single fetch.
//
// Guarded with:
//   • Only HTML page requests (anything Accept'ing text/html or with no
//     Accept set — XHRs, fonts, JSON polls skip the work).
//   • Only when the user is signed in.
//   • Never on /api/* / /js/* / /css/* / static asset paths.
//   • Cached for the whole session once set — write paths refresh.
app.use(async (req, res, next) => {
    try {
        const user = req.session && req.session.user;
        if (!user) { return next(); }
        if (req.session.cartCount != null) { return next(); }
        // Cheap path: skip non-HTML calls.
        if (req.method !== 'GET') { return next(); }
        const accept = String(req.headers.accept || '');
        if (accept && accept.indexOf('text/html') === -1 && accept.indexOf('*/*') === -1) {
            return next();
        }
        // Skip API + static paths.
        if (/^\/(api|js|css|images?|fonts?|favicon|yii-uploads|sw\.js|service-worker)/i.test(req.path)) {
            return next();
        }
        const apiRes = await callApi(req, 'GET',
            '/api/v1/customer/cart/count?customer_id=' + encodeURIComponent(user.id));
        const body = apiRes && apiRes.body;
        if (body && body.status === 200 && body.data && typeof body.data.count === 'number') {
            req.session.cartCount = body.data.count;
        } else {
            req.session.cartCount = 0;
        }
    } catch (_) {
        // Network blip — don't crash the page over a badge value.
        if (req.session) { req.session.cartCount = req.session.cartCount || 0; }
    }
    next();
});

// ── Per-request locals (other than brand) ──────────────────────
// Make a few commonly-used values available inside every EJS template
// without each controller having to pass them in explicitly.
app.use((req, res, next) => {
    res.locals.flash_success    = (req.flash('success') || [])[0] || null;
    res.locals.flash_error      = (req.flash('error')   || [])[0] || null;
    res.locals.user_session     = (req.session && req.session.user) || null;
    res.locals.user_location    = (req.session && req.session.userLocation) || null;
    // True when the page is loaded inside the mobile app's WebView (the app
    // sets a custom User-Agent containing "EatNDealApp"). Views use it to
    // adapt — e.g. the sign-in page routes Google/Facebook through the
    // Custom-Tab + deep-link handoff (adds ?app=1) instead of a web redirect.
    res.locals.is_app           = /EatNDealApp/i.test(String(req.headers['user-agent'] || ''));
    res.locals.google_maps_key  = process.env.GOOGLE_MAPS_BROWSER_KEY || '';   // Embed API (browser key)
    res.locals.page_title       = '';
    res.locals.active_nav       = '';
    // Cart count — primed by the middleware above; 0 when not signed in.
    res.locals.cart_count       = (req.session && req.session.cartCount) || 0;
    // Promo strip ("50% OFF first order — WELCOME50") is shown on every
    // page by default. Auth controllers (and any future focused-flow
    // pages — checkout, OTP, etc.) opt out by passing
    // `show_promo_strip: false` to res.render.
    res.locals.show_promo_strip = true;
    // Search box visibility. The header search input + the mobile
    // search/filter row only make sense on browse surfaces — the home
    // feed, the "all restaurants / cuisines" grids, search results and
    // a single restaurant's menu. Everywhere else (cart, account,
    // orders, merchant, offers, product detail, static pages) there is
    // nothing to search, so it is hidden. Default OFF here; the few
    // renders that should show it opt IN by passing `show_search: true`
    // (see SiteController.index). Always-defined so the header + layout
    // can read it directly with no typeof guard.
    res.locals.show_search = false;
    // Delivery / Pickup mode toggle in the header — only relevant while
    // browsing the marketplace (home / restaurant / product). Default OFF;
    // SiteController.index opts in. Hidden on cart / account / orders /
    // merchant / offers / static / signin.
    res.locals.show_mode_toggle = false;
    // Stripe publishable key — exposed to the cart so the checkout
    // flow can mount Elements without a round trip just to discover
    // whether card payments are enabled. Empty string when the env
    // var isn't set; the UI then hides the Card option.
    res.locals.stripe_publishable_key = process.env.STRIPE_PUBLISHABLE_KEY || '';
    next();
});

// ── Dev request logger ─────────────────────────────────────────
// Logs every request in dev (off in prod). OAuth callback URLs carry
// the `?code=...` one-time secret in the query string — we never want
// that in the logs, so we strip the query for those paths. Everything
// else logs unchanged.
if (IS_DEV) {
    app.use((req, res, next) => {
        var url = req.originalUrl;
        if (/^\/signin\/oauth\/[^/]+\/callback/.test(url)) {
            url = url.split('?')[0] + ' ?<redacted>';
        }
        console.log(
            chalk.gray(`[${new Date().toISOString()}]`),
            chalk.yellow(req.method.padEnd(6)),
            url,
        );
        next();
    });
}

// ── No-store for dynamic pages ─────────────────────────────────
// Every request that reaches here is a page / JSON route (static assets
// were already served + ended by express.static above, with their own
// long-cache headers). Authenticated pages embed the signed-in user
// (header username, profile) server-side, so they must NEVER be served
// from the browser/back-forward cache — otherwise after login or logout
// the user sees a stale page until they manually refresh. `no-store`
// also disables the BFCache for these responses.
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
});

// ── Routes ─────────────────────────────────────────────────────
// Phase 0: landing page + delivery-location endpoints. Login / sign-up
// will be added as separate routes when those flows are built (Phase 1).
app.get('/', SiteController.index);

// JSON product detail — drives the fullscreen product modal that replaces
// the standalone product page. Always returns the same shape the
// /marketplace/product API returns (product / groups / related). The
// standalone /?rest=X&item=Y URL still works as a deep-link fallback.
app.get('/product/json', async (req, res) => {
    try {
        const qs = new URLSearchParams();
        if (req.query.item) { qs.set('item', String(req.query.item)); }
        if (req.query.rest) { qs.set('rest', String(req.query.rest)); }
        if (req.query.id)   { qs.set('id',   String(req.query.id)); }
        const loc = (req.session && req.session.userLocation) || {};
        if (loc.lat != null && loc.lat !== '') { qs.set('lat', String(loc.lat)); }
        if (loc.lng != null && loc.lng !== '') { qs.set('lng', String(loc.lng)); }
        const r = await callApi(req, 'GET', '/api/v1/marketplace/product?' + qs.toString());
        if (!r || !r.body) {
            return res.status(200).json({ status: 502, show: true, msg: 'Could not load the item.' });
        }
        return res.status(200).json(r.body);
    } catch (err) {
        return res.status(200).json({ status: 500, show: true, msg: 'Could not load the item.' });
    }
});

// Offers page — all restaurants' active offers, grouped per restaurant.
app.get('/offers', SiteController.offersPage);

// Restaurant reviews panel data (sort / star filter / load-more) — JSON
// proxy used by /js/ui/reviews-list.js.
app.get('/restaurant-reviews', SiteController.restaurantReviews);

// ── Location (works WITHOUT login — stored on the web session) ──
// Picked locations live on req.session.userLocation. Every page render
// reads it via res.locals.user_location and the header chip + hero
// reflect the chosen area. Used by every future restaurant-search call.
app.post('/location/save',  LocationController.save);
app.post('/location/clear', LocationController.clear);
app.get ('/location',       LocationController.get);
// Demo shortcut (backs the location page's currently-HIDDEN "Use a demo delivery
// location" button) — picks a deliverable restaurant's location server-side and
// saves it to the session. Routed through the web (not the api directly) so it
// works on a phone, where the browser can't reach the api's localhost.
app.post('/location/use-demo', LocationController.useDemo);

// ── Saved addresses (signed-in customers; proxied to the api) ───
// Backs the location sheet's "Saved addresses" section + the
// "Address info" add/edit screen. customer_id is injected from the
// session inside the controller — never trusted from the body.
app.get ('/addresses',       AddressController.list);
app.post('/address/save',    AddressController.save);
app.post('/address/delete',  AddressController.remove);

// Saved payment methods (Stripe Customer + payment_methods)
const PaymentMethodController = require('./Controllers/PaymentMethodController');
app.get ('/payment-methods',          PaymentMethodController.list);
app.post('/payment-method/setup',     PaymentMethodController.setupIntent);
app.post('/payment-method/delete',    PaymentMethodController.remove);

// ── Favourite restaurants (signed-in customers; proxied to the api) ──
// Heart icon on cards / detail + Favourites tab on the account page.
// customer_id is injected from the session inside the controller.
app.get ('/favourites',         FavouriteController.list);
app.post('/favourite/toggle',   FavouriteController.toggle);

// ── Cart (signed-in marketplace customers only) ─────────────────────
// Phase 2A.3 — read paths only. /cart renders the page; /cart/data is
// the JSON proxy for client-side refresh.
app.get ('/cart',              CartController.page);
app.get ('/cart/data',         CartController.data);
app.get ('/cart/count',        CartController.count);
app.get ('/cart/promotions',   CartController.promotions);
app.post('/cart/add',          CartController.add);
// Surprise Box ("Too Good To Go") — separate endpoint: the box is a virtual
// product on the branch row, with no products row for /cart/add to resolve.
app.post('/cart/surprise-box', CartController.addSurpriseBox);
app.post('/cart/update-qty',   CartController.updateQty);
app.post('/cart/remove-item',  CartController.removeItem);
app.post('/cart/clear',        CartController.clear);
app.post('/cart/set-mode',     CartController.setMode);
app.post('/cart/set-address',  CartController.setAddress);
app.post('/cart/pay-saved-card', CartController.paySavedCard);
app.post('/cart/set-schedule', CartController.setSchedule);
app.post('/cart/set-instructions', CartController.setInstructions);
app.post('/cart/set-cooking-instructions', CartController.setCookingInstructions);
app.post('/cart/apply-coupon', CartController.applyCoupon);
app.post('/cart/remove-coupon',CartController.removeCoupon);
app.post('/cart/apply-voucher', CartController.applyVoucher);
app.post('/cart/remove-voucher',CartController.removeVoucher);
app.post('/cart/apply-loyalty', CartController.applyLoyalty);
app.post('/cart/remove-loyalty',CartController.removeLoyalty);
app.post('/cart/set-charity',  CartController.setCharity);

// ── Orders (signed-in marketplace customers only) ───────────────────
// Phase-2D: /place writes the order; /:id/confirm renders the stub page.
// Phase-2E will add /orders (list) + /order/:id (full detail).
app.post('/order/place',           OrderController.place);
app.post('/order/:id/reorder',     OrderController.reorder);
app.post('/order/:id/report-issue', OrderController.reportIssue);
app.get ('/order/:id/issue-response', OrderController.issueResponse);
app.get ('/order/:id/receipt',     OrderController.receipt);
app.get ('/orders',                OrderController.ordersPage);
app.get ('/order/:id/confirm',     OrderController.confirmation);
app.get ('/orders/data',           OrderController.list);
app.get ('/order/:id/status',      OrderController.status);
app.get ('/order/:id',             OrderController.detailPage);

// ── Payments (Stripe-backed) ────────────────────────────────────────
// Returns a PaymentIntent client_secret + publishable key the browser
// uses to confirm via Stripe.js.
app.post('/payment/intent',        PaymentController.intent);

// ── Merchant dashboard (staff-allowlist gated) ──────────────────────
// Page renders the dashboard server-side; data + advance go through
// the api with customer_id injected from the session.
app.get ('/merchant',                MerchantController.dashboardPage);
app.get ('/merchant/orders/data',    MerchantController.ordersData);
app.post('/merchant/order/advance',  MerchantController.advance);
app.get ('/merchant/order/:id',      MerchantController.detailPage);

// ── Auth (single mobile-OTP entry) ──────────────────────────────
// Both /signin and /signup point at the same page — the api decides
// whether the entered phone is a new signup or existing sign-in once
// the OTP is verified. Marketing links can still say "Sign up".
//
// Flow:
//   GET  /signin                        → step 1 (mobile entry)
//   POST /signin/start                  → send OTP; advances to step 2
//   GET  /signin?step=otp               → step 2 (6-digit OTP)
//   POST /signin/verify                 → verify OTP; existing → next,
//                                          new/pending → step 3
//   GET  /signin?step=profile           → step 3 (Personal Details)
//   POST /signin/save-profile           → insert/finish customer; → next
//   GET  /account                       → view + edit profile
//   POST /account                       → save name / email updates
//   POST /logout                        → clear session, → home
app.get ('/signin',              AuthController.signinPage);
app.get ('/signup',              AuthController.signinPage);
app.post('/signin/start',        AuthController.startOtp);
app.post('/signin/verify',       AuthController.verifyOtp);
app.post('/signin/save-profile', AuthController.saveProfile);
app.get ('/account',             AuthController.accountPage);
app.post('/account',             AuthController.updateProfile);
// Change mobile — OTP-verified (send code to the new number, then verify).
app.post('/account/phone/send-otp', AuthController.changePhoneSendOtp);
app.post('/account/phone/verify',   AuthController.changePhoneVerify);
// Delete my account (soft-delete) — then the client redirects home.
app.post('/account/delete',         AuthController.deleteAccount);

// Loyalty Wallet — multi-restaurant cards + transaction history.
app.get ('/wallet',              WalletController.walletPage);
app.get ('/wallet/json',         WalletController.walletJson);
// Earn Cashback — review/share a restaurant to earn its cashback (picker +
// per-restaurant types). Submitting posts to POST /review-cashback below.
app.get ('/earn',                EarnController.earnPage);
// Reviews of EatNDeal itself. The PAGE is public (anyone can read); the submit
// requires a sign-in and lands PENDING until the super admin approves it.
// ══ DISABLED 2026-07-17 (user request) ═════════════════════════════
// EatNDeal's own reviews page is switched off — menu items are commented out
// in partials/header.ejs + partials/mobile-drawer.ejs and the "Rate us" button
// in views/site/index.ejs, and these routes are off so the URL 404s too (the
// catch-all at the bottom of this file answers). The controller, view, CSS and
// JS are all left in place; restore = uncomment these three lines + the three
// view blocks. The api endpoints are commented out in api/Routes/index.js.
// NB this is EatNDeal's OWN reviews — a RESTAURANT's star-reviews
// (/restaurant-reviews, review_rating scoped to that company) are untouched.
// app.get ('/reviews',             SiteReviewController.page);
// app.get ('/reviews/more',        SiteReviewController.more);
// app.post('/reviews/submit',      SiteReviewController.submit);
// ═══════════════════════════════════════════════════════════════════
// Loyalty Program — "how rewards work" explainer (legacy loyalty_program.php).
app.get ('/loyalty-program', function (req, res) {
    res.render('loyalty/program', {
        page_title:       'EatNDeal Rewards',
        _layoutFile:      '../_layout',
        active_nav:       'profile',
        show_promo_strip: false,
        bare:             false,
    });
});

// ── Community (Facebook-style groups; reads work for guests) ────
// Group browsing + feed are open to everyone; posting / liking /
// commenting require a session (the controller injects customer_id and
// returns a 401 envelope for guests → the JS bounces to /signin).
app.get ('/community',            CommunityController.groupsPage);
app.get ('/community/feed',       CommunityController.feedData);
app.get ('/community/my-posts',   CommunityController.myPostsData);
app.get ('/community/comments',   CommunityController.commentsData);
app.get ('/community/g/:id',      CommunityController.groupPage);
app.post('/community/like',       CommunityController.like);
app.post('/community/comment',    CommunityController.comment);
app.post('/community/post-delete',    CommunityController.deletePost);
app.post('/community/comment-delete', CommunityController.deleteComment);
// Create a post — optional photo (multipart). multer stores it on the web
// disk; the wrapper turns size/type errors into a friendly JSON envelope.
app.post('/community/post', (req, res) => {
    communityUpload.single('image')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Photo must be under 4 MB.'
                : 'Could not upload that photo. Please try a PNG or JPG.';
            return res.status(200).json({ status: 400, show: true, msg });
        }
        return CommunityController.createPost(req, res);
    });
});
// Profile photo upload (multipart). multer stores the file on the web
// disk; the controller forwards the relative path to the api to persist.
// The wrapper turns multer errors (too big / wrong type) into a friendly
// JSON envelope instead of the 500 page.
app.post('/account/avatar', (req, res) => {
    avatarUpload.single('avatar')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Image must be under 3 MB.'
                : 'Could not upload that image. Please try a PNG or JPG.';
            return res.status(200).json({ status: 400, show: true, msg });
        }
        return AuthController.uploadAvatar(req, res);
    });
});

// Post-order review submit (multipart — rating + text + optional food photo).
// multer stores the photo on the web disk; the controller forwards the
// rating/text/path to the api. Wrapper turns multer errors into JSON.
app.post('/order/:id/review', (req, res) => {
    reviewUpload.single('photo')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Photo must be under 4 MB.'
                : 'Could not upload that photo. Please try a PNG or JPG.';
            return res.status(200).json({ status: 400, show: true, msg });
        }
        return OrderController.submitReview(req, res);
    });
});

// Cashback review — upload a screenshot of an external (Google/FB) review.
app.post('/review-cashback', (req, res) => {
    reviewUpload.single('photo')(req, res, (err) => {
        if (err) {
            if (req.flash) { req.flash('error', 'Could not upload that screenshot. Use a PNG/JPG under 4 MB.'); }
            return res.redirect(req.get('referer') || '/');
        }
        return OrderController.submitCashbackReview(req, res);
    });
});

// Social sign-in (Google + Facebook redirect flow).
// :provider is constrained to google | facebook inside the handler.
app.get('/signin/oauth/:provider',          AuthController.oauthRedirect);
app.get('/signin/oauth/:provider/callback', AuthController.oauthCallback);
// Mobile-app social-sign-in handoff: the app loads this INSIDE its WebView
// with the one-time token it caught from the "<scheme>://auth?token=…" deep
// link, and we establish the session in the WebView. See AuthController.appAuth.
app.get('/app-auth',                        AuthController.appAuth);

app.post('/logout',              AuthController.signOut);

// ── Static / marketing pages ───────────────────────────────────
// Nine pages, one controller, one shared view, content driven by
// web/data/staticPages.js. Editors update copy by changing that file
// (no markup change needed). See StaticPageController for the flow.
app.get('/about',    StaticPageController.about);
app.get('/help',     StaticPageController.help);
app.get('/terms',    StaticPageController.terms);
app.get('/privacy',  StaticPageController.privacy);
app.get('/contact',  StaticPageController.contact);
app.get('/partner',  StaticPageController.partner);
app.get('/ride',     StaticPageController.ride);
app.get('/business', StaticPageController.business);
app.get('/careers',  StaticPageController.careers);
// Smart app-download link: device-detect (or ?platform=) → store, else a
// download page. The home "Get the app" QRs encode <site>/app?platform=…
app.get('/app',      AppController.appRedirect);
// Partner / contact lead form submit (AJAX → api emails the enquiry).
app.post('/partner/apply', StaticPageController.partnerApply);
// Help chatbot (AJAX → api answers from the customer's real data).
app.post('/chatbot/ask', require('./Controllers/ChatbotController').ask);

// ── Same-origin API proxy (public reads) ────────────────────────
// The browser's EatNDealApi base is now same-origin (data-api-url=""), so
// client-side calls land here and we forward them to the api. This is what
// makes the country list / postcode search / "use my location" / live search
// work on a real PHONE: the device can't reach the api's localhost, but it
// CAN reach this web server. The session JWT is forwarded by callApi, so
// personalised reads still work; only PUBLIC endpoints are called client-side
// (countries / marketplace / delivery), so no customer_id injection is needed.
app.all('/api/v1/*', async (req, res) => {
    const method = req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    try {
        const upstream = await callApi(req, method, req.originalUrl, hasBody ? (req.body || {}) : undefined);
        if (upstream && upstream.body) {
            return res.status(upstream.status || 200).json(upstream.body);
        }
        // Upstream unreachable / non-JSON → a clean envelope the client parses.
        return res.status(502).json({ status: 502, show: true, msg: 'We could not reach the server. Please try again.' });
    } catch (e) {
        return res.status(502).json({ status: 502, show: true, msg: 'We could not reach the server. Please try again.' });
    }
});

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).render('errors/404', {
        page_title:  'Page not found',
        _layoutFile: '../_layout',
        active_nav:  '',
    });
});

// ── Error handler ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(chalk.red('[error]'), err.stack || err);
    res.status(500).render('errors/500', {
        page_title:  'Something went wrong',
        _layoutFile: '../_layout',
        active_nav:  '',
        error_msg:   IS_DEV ? err.message : null,
    });
});

// ── Boot ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4502;

app.listen(PORT, '0.0.0.0', async () => {
    // Warm the brand cache so the first request doesn't pay the latency.
    try {
        cachedBrand = await fetchBrand();
        lastBrandFetchMs = Date.now();
    } catch (err) {
        console.error('[boot] brand fetch failed', err && err.message);
    }

    const apiUrl = process.env.API_URL || 'http://localhost:4501';
    const brandLabel = (cachedBrand && cachedBrand.name) || 'EatNDeal';

    console.log(chalk.greenBright(`\n  🍴  ${brandLabel} Web (PWA) running`));
    console.log(chalk.cyan      (`      URL  : http://localhost:${PORT}`));
    console.log(chalk.cyan      (`      API  : ${apiUrl}`));
    console.log(chalk.gray      (`      Env  : ${ENV}`));
    if (cachedBrand && cachedBrand._fallback) {
        console.log(chalk.yellow(`      Brand: FALLBACK (api unreachable — using web/.env defaults)`));
    } else {
        console.log(chalk.greenBright(`      Brand: live from ${apiUrl}/api/v1/brand`));
    }
    console.log('');
});

module.exports = app;
