'use strict';

/**
 * index.js — EatNDeal API entry point
 *
 * What:   Boots the Express app, wires middleware, mounts the /api/v1
 *         router, registers cron jobs, and handles graceful shutdown.
 * Why:    Single boot file the operator runs: `node index.js` or `npm start`.
 *         All other modules are libraries this file glues together.
 * Type:   READ + WRITE (handles every incoming HTTP request).
 * Inputs: process.env (see api/.env.example for every key consumed).
 * Output: HTTP server listening on PORT (default 4501).
 * Used:   Process entry. `npm start` / `npm run dev` / docker CMD.
 *
 * Boot sequence (top-to-bottom — copy this order, do not reshuffle):
 *   1. Load .env
 *   2. pg INT8 → JS Number override (so BIGINT columns return numbers)
 *   3. trust proxy + disable x-powered-by
 *   4. helmet (strict CSP — API serves JSON only)
 *   5. cors (env allowlist)
 *   6. compression (gzip >1 KB)
 *   7. request-id middleware (must come BEFORE the dev logger)
 *   8. body parsing (JSON + urlencoded, 2 MB cap)
 *   9. static serve for /brand/* (logo + favicon)
 *  10. dev request logger (only when APP_ENV !== production)
 *  11. mount /api/v1 router
 *  12. 404 + error handlers (always last)
 *  13. listen() → ping DB → register cron jobs → optionally start scheduler
 *  14. SIGTERM / SIGINT → graceful shutdown
 *
 * Change log:
 *   2026-05-25 — initial scaffold; /ping + /health + /brand only.
 */

require('dotenv').config();

// ── PG BIGINT → JS Number override ────────────────────────────────
// node-postgres returns INT8 (bigint) as STRING by default — JS Number can't
// safely represent values above 2^53 so pg plays safe. The Yii2 system
// returns these columns as JSON numbers though, and the web/app expect
// numbers. Auto-increment IDs in this DB are well under 2^53, so flipping
// the parser is safe. Done ONCE at boot — applies to every query.
const pgTypes = require('pg').types;
pgTypes.setTypeParser(pgTypes.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const path        = require('path');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const chalk       = require('chalk');

const { db, pingWithRetry } = require('./config/db');
const { brand }             = require('./config/brand');
const H                     = require('./Helpers/helper');
const MSG                   = require('./Helpers/messages');
const { requestId }         = require('./Middlewares/requestId');
const scheduler             = require('./Services/scheduler');

const app    = express();
const ENV    = process.env.APP_ENV || 'development';
const IS_DEV = ENV !== 'production';

// Behind nginx / PM2 / a load balancer? Trust the X-Forwarded-* headers
// so req.ip / req.protocol report the real client values. trust=true is
// equivalent to "trust all proxies" — fine when the LB is in front of us.
app.set('trust proxy', true);
app.disable('x-powered-by');

// ── Security headers (helmet) ──────────────────────────────────────
// The API serves JSON only — never HTML. So CSP is locked to
// default-src 'none'; that way any future XSS in an error page or
// debug response can't load arbitrary scripts. HSTS pins a 1-year
// max-age for browsers that hit the api directly over HTTPS.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            'default-src':     ["'none'"],
            'frame-ancestors': ["'none'"],
            // Logo + favicon are served from /brand/* so they need img-src
            // 'self'. Nothing else is allowed.
            'img-src':         ["'self'"],
        },
    },
    strictTransportSecurity: {
        maxAge: 31536000,          // 1 year
        includeSubDomains: true,
        preload: true,
    },
    referrerPolicy:            { policy: 'no-referrer' },
    crossOriginOpenerPolicy:   { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard:                { action: 'deny' },
}));

// ── CORS allowlist ────────────────────────────────────────────────
// dev:  CORS_ORIGIN=*                       (any origin, useful locally)
// prod: CORS_ORIGIN=https://a.com,https://b.com   (comma list of origins)
const corsOrigins = String(process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

app.use(cors({
    origin:      corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
}));

// ── Response compression ──────────────────────────────────────────
// threshold:1024 → don't gzip <1 KB responses. Tiny JSON envelopes
// (e.g. {status:200,show:false,msg:"success"}) are net-larger after
// gzip due to header overhead. The default level (6) is the sweet
// spot; not worth bumping to 9 for ~2% extra savings.
app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    },
}));

// ── Request-ID ────────────────────────────────────────────────────
// MUST sit before the dev logger so the logger can include the id.
app.use(requestId);

// ── Body parsing (JSON + urlencoded, 2 MB cap) ────────────────────
// `verify` stashes the raw bytes on req.rawBody so Stripe webhook
// signature verification (Helpers/payments.verifyWebhookSignature) can
// recompute the HMAC over the exact payload Stripe signed. Without
// this Express would only give us the parsed JSON and the signature
// check would never match.
app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Static serve: logo + favicon under /brand/* ───────────────────
// The brand assets live in api/public/brand/. The web PWA + Flutter
// app fetch them via the URL returned by GET /api/v1/brand. Serve
// with a 7-day cache because the URL is hash-busted by an
// asset_version query string (added by the web layer).
app.use('/brand', express.static(path.join(__dirname, 'public', 'brand'), {
    fallthrough: false,
    maxAge: '7d',
}));

// ── Dev request logger (off in production) ────────────────────────
if (IS_DEV) {
    app.use((req, res, next) => {
        console.log(
            chalk.gray(`[${new Date().toISOString()}]`),
            chalk.magenta(req.requestId.slice(0, 8)),
            chalk.yellow(req.method.padEnd(6)),
            req.originalUrl,
        );
        next();
    });
}

// ── Mount /api/v1 router ──────────────────────────────────────────
app.use('/api/v1', require('./Routes'));

// ── 404 handler ───────────────────────────────────────────────────
// Note: standard envelope shape, but real HTTP 404 — load balancers
// and automated tooling rely on the transport-level code for routing.
app.use((req, res) => {
    res.status(404).json({
        status: 404,
        show:   true,
        msg:    MSG.server.notFound,
    });
});

// ── Final error handler ───────────────────────────────────────────
// Express recognises 4-arg signature → error middleware. We log the
// stack, return a generic 500. In dev we include err.message for
// debugging; in production we never leak internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(chalk.red('[error]'), err.stack || err);
    const payload = {
        status: 500,
        show:   true,
        msg:    MSG.server.oops,
    };
    if (IS_DEV) payload.error = err.message;
    res.status(500).json(payload);
});

// ── Boot ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4501;

// ── Cron jobs ─────────────────────────────────────────────────────
// We REGISTER jobs here (so the registry is populated + manual runs
// work) but only START them when SCHEDULER_ENABLED is truthy. As real
// jobs are written, add their scheduler.register(...) calls below.

// Heartbeat — every minute on the minute. Cheap canary that proves the
// scheduler is firing + the DB is responsive.
scheduler.register('heartbeat', '0 * * * * *', async () => {
    let dbOk = false;
    try { await db.raw('SELECT 1'); dbOk = true; } catch { /* logged below */ }
    H.log.info('heartbeat', `tick ts=${new Date().toISOString()} db=${dbOk ? 'ok' : 'down'}`);
});

// ── Listen ────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.greenBright(`\n  🍽️  EatNDeal API running`));
    console.log(chalk.cyan      (`      Brand : ${brand.name}`));
    console.log(chalk.cyan      (`      URL   : http://localhost:${PORT}`));
    console.log(chalk.cyan      (`      Ping  : http://localhost:${PORT}/api/v1/ping`));
    console.log(chalk.cyan      (`      Brand : http://localhost:${PORT}/api/v1/brand`));
    console.log(chalk.gray      (`      Env   : ${ENV}`));

    // DB connectivity ping with retry/backoff. We DO NOT exit on failure —
    // /ping and /brand still work without the DB, and ops would rather have
    // the api respond "DB down" than have PM2 in a crash loop.
    const dbHost = process.env.DB_HOST     || '127.0.0.1';
    const dbPort = process.env.DB_PORT     || 5432;
    const dbName = process.env.DB_DATABASE || 'wtw_eatndeal';
    try {
        const attempts = await pingWithRetry({
            maxAttempts: Number(process.env.DB_PING_MAX_ATTEMPTS) || 5,
            baseDelayMs: Number(process.env.DB_PING_BASE_MS)      || 500,
            onAttempt: ({ attempt, err }) => console.log(chalk.yellow(
                `      DB    : ping attempt ${attempt} failed: ${err.code || err.message}`
            )),
        });
        const label = attempts > 1 ? ` (after ${attempts} attempts)` : '';
        console.log(chalk.greenBright(`      DB    : ${dbName}@${dbHost}:${dbPort} ✓ connected${label}`));
    } catch (err) {
        console.log(chalk.red(`      DB    : ${dbName}@${dbHost}:${dbPort} ✗ ${err.code || 'ERROR'}: ${err.message}`));
        console.log(chalk.yellow(`              → Check api/.env: DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD`));
        console.log(chalk.yellow(`              → Is PostgreSQL running on ${dbHost}:${dbPort}?`));
        console.log(chalk.yellow(`              → Does the database "${dbName}" exist?\n`));
    }

    // Location provider — surface which one is wired so ops sees it in
    // the boot log without having to grep .env. Useful when the postcode
    // search misbehaves and the first question is "which provider?".
    try {
        const locationProvider = require('./Helpers/locationProvider');
        console.log(chalk.greenBright(`      Loc   : provider="${locationProvider.activeProviderId()}"`));
    } catch (err) {
        console.log(chalk.yellow(`      Loc   : provider load failed: ${err && err.message}`));
    }

    // Scheduler — registered jobs stay dormant until SCHEDULER_ENABLED is on.
    const schedulerOn = /^(1|true|yes|on)$/i.test(String(process.env.SCHEDULER_ENABLED || ''));
    if (schedulerOn) {
        scheduler.start();
        console.log(chalk.greenBright(`      Sched : ON — ${scheduler._state().jobCount} job(s) scheduled`));
    } else {
        console.log(chalk.yellow(`      Sched : OFF (set SCHEDULER_ENABLED=true to boot) — ${scheduler._state().jobCount} job(s) registered`));
    }
    console.log('');
});

// ── Graceful shutdown ─────────────────────────────────────────────
// SIGTERM (deploy / scale-down) + SIGINT (Ctrl+C in dev) trigger a
// staged shutdown:
//   1. Stop accepting new connections (server.close).
//   2. Stop the cron scheduler so no new job starts mid-drain.
//   3. Destroy the DB pool.
//   4. Hard timeout — if drain takes more than DRAIN_TIMEOUT_MS, force exit.
//
// Idempotent: a second SIGTERM during shutdown forces a hard exit
// (operator's signal that they really want us gone).
const DRAIN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

/**
 * gracefulShutdown
 *
 * What:   Orchestrates the staged shutdown described above.
 * Why:    Drop in-flight connections cleanly during deploys so users don't
 *         see 5xx spam from half-killed processes.
 * Type:   WRITE (closes server + DB pool).
 * Inputs: signal (string) — 'SIGTERM' or 'SIGINT'; for log clarity only.
 * Output: process.exit(0) on success, process.exit(1) on timeout / repeat.
 * Used:   process.on('SIGTERM' / 'SIGINT', ...) below.
 */
async function gracefulShutdown(signal) {
    if (shuttingDown) {
        console.log(chalk.yellow(`\n[shutdown] second ${signal} received — force exit`));
        process.exit(1);
    }
    shuttingDown = true;
    console.log(chalk.yellow(`\n[shutdown] ${signal} received — draining ...`));

    // Hard kill if we miss the deadline.
    const killTimer = setTimeout(() => {
        console.log(chalk.red(`[shutdown] drain timeout (${DRAIN_TIMEOUT_MS} ms) — force exit`));
        process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    killTimer.unref();

    // 1. Stop accepting new connections. Yank keep-alive sockets that are
    //    idle (Node 18.2+); force the rest after a short grace window.
    if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
    }
    const forceCloseTimer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') {
            console.log(chalk.gray('[shutdown] forcing socket close on lingering connections'));
            server.closeAllConnections();
        }
    }, 2000);
    forceCloseTimer.unref();
    await new Promise((resolve) => {
        server.close((err) => {
            clearTimeout(forceCloseTimer);
            if (err) console.error('[shutdown] server.close error:', err.message);
            resolve();
        });
    });
    console.log(chalk.gray('[shutdown] http server closed'));

    // 2. Stop the cron scheduler (no new job ticks).
    try {
        await scheduler.stop();
    } catch (err) {
        console.error('[shutdown] scheduler.stop error:', err.message);
    }

    // 3. Drain the DB pool.
    try {
        await db.destroy();
        console.log(chalk.gray('[shutdown] db pool closed'));
    } catch (err) {
        console.error('[shutdown] db.destroy error:', err.message);
    }

    clearTimeout(killTimer);
    console.log(chalk.greenBright('[shutdown] bye'));
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Exports for tests + Windows (which can't deliver real signals to Node
// child processes — tests invoke gracefulShutdown directly).
module.exports = app;
module.exports.gracefulShutdown = gracefulShutdown;
module.exports._server = server;
