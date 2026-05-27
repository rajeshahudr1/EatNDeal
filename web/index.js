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
const express     = require('express');
const session     = require('express-session');
const flash       = require('express-flash');
const helmet      = require('helmet');
const compression = require('compression');
const ejsLocals   = require('ejs-locals');
const chalk       = require('chalk');

const { fetchBrand }       = require('./Helpers/apiClient');
const SiteController       = require('./Controllers/SiteController');
const LocationController   = require('./Controllers/LocationController');
const AuthController       = require('./Controllers/AuthController');
const StaticPageController = require('./Controllers/StaticPageController');

const app    = express();
const ENV    = process.env.APP_ENV || 'development';
const IS_DEV = ENV !== 'production';

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
// Special-case for /service-worker.js: it MUST be served with
// `Service-Worker-Allowed: /` so the browser registers it at root scope
// (otherwise the SW controls only /public/* and skips the rest of the site).
// We also bust its cache aggressively so SW updates roll out immediately.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(path.sep + 'service-worker.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

// ── Session ────────────────────────────────────────────────────
// We use a server-side session (cookie carries only the session id) so
// the JWT issued by api/<actor>/login never lives on the client. The
// session cookie is httpOnly + sameSite=lax + secure-in-prod.
app.use(session({
    name:              process.env.SESSION_NAME   || 'eatndeal_web',
    secret:            process.env.SESSION_SECRET || 'change_me_in_production',
    resave:            false,
    saveUninitialized: false,
    cookie: {
        maxAge:   parseInt(process.env.SESSION_MAX_AGE, 10) || 7 * 24 * 60 * 60 * 1000,
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

// ── Per-request locals (other than brand) ──────────────────────
// Make a few commonly-used values available inside every EJS template
// without each controller having to pass them in explicitly.
app.use((req, res, next) => {
    res.locals.flash_success    = (req.flash('success') || [])[0] || null;
    res.locals.flash_error      = (req.flash('error')   || [])[0] || null;
    res.locals.user_session     = (req.session && req.session.user) || null;
    res.locals.user_location    = (req.session && req.session.userLocation) || null;
    res.locals.page_title       = '';
    res.locals.active_nav       = '';
    // Promo strip ("50% OFF first order — WELCOME50") is shown on every
    // page by default. Auth controllers (and any future focused-flow
    // pages — checkout, OTP, etc.) opt out by passing
    // `show_promo_strip: false` to res.render.
    res.locals.show_promo_strip = true;
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

// ── Routes ─────────────────────────────────────────────────────
// Phase 0: landing page + delivery-location endpoints. Login / sign-up
// will be added as separate routes when those flows are built (Phase 1).
app.get('/', SiteController.index);

// ── Location (works WITHOUT login — stored on the web session) ──
// Picked locations live on req.session.userLocation. Every page render
// reads it via res.locals.user_location and the header chip + hero
// reflect the chosen area. Used by every future restaurant-search call.
app.post('/location/save',  LocationController.save);
app.post('/location/clear', LocationController.clear);
app.get ('/location',       LocationController.get);

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

// Social sign-in (Google + Facebook redirect flow).
// :provider is constrained to google | facebook inside the handler.
app.get('/signin/oauth/:provider',          AuthController.oauthRedirect);
app.get('/signin/oauth/:provider/callback', AuthController.oauthCallback);

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
