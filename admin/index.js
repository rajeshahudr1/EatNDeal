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
const AuthController      = require('./Controllers/AuthController');
const DashboardController = require('./Controllers/DashboardController');

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

// Dashboard (gated). Landing page after a successful login. The full
// loyalty-management screens (Cashback Rules, Tiers, Challenges, Review
// Claims, Segments — per the mockup) hang off this in later phases.
app.get('/', requireAdmin, DashboardController.index);

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
