'use strict';

/**
 * config/db.js
 *
 * What:   Single shared Knex instance for the live wtw_eatndeal Postgres DB.
 *         Plus a tiny ping helper (used at boot to verify the DB is reachable).
 * Why:    EatNDeal Marketplace shares its database with the existing Yii2
 *         eatndealclean POS + webordering system. We connect to that same DB
 *         and reuse its 174 tables — we do NOT spin up a new database.
 *         A single Knex pool keeps the connection count low and reused.
 * Type:   READ + WRITE (every controller that touches data uses this).
 * Inputs: knexfile.js (which reads .env DB_* vars).
 * Output: { db, ping, pingWithRetry } — `db` is the Knex instance;
 *         `ping` runs SELECT 1; `pingWithRetry` is the same with backoff.
 * Used:   require('./config/db') from anywhere in the api that runs queries.
 *
 *   ⚠️  This DB is LIVE. Do not run migrations against it without explicit
 *       approval. See EatNDeal/CODING-CONVENTIONS.md rule (no schema changes).
 *
 * Change log:
 *   2026-05-25 — initial scaffold; points at wtw_eatndeal.
 */

const knex     = require('knex');
const knexfile = require('../knexfile');

const ENV = process.env.APP_ENV || 'development';

// One pool, one process. Created at require-time; cached by Node's module
// system so every controller shares it.
const db = knex(knexfile[ENV] || knexfile.development);

/**
 * ping
 *
 * What:   Runs `SELECT 1` against the master pool to confirm the DB is reachable.
 * Why:    Used by GET /health to report DB status and by the boot routine to
 *         fail loudly when the DB is unreachable.
 * Type:   READ.
 * Inputs: none.
 * Output: resolves on success; rejects with the underlying pg error on failure.
 * Used:   api/index.js boot + Routes/index.js /health endpoint.
 */
async function ping() {
    await db.raw('SELECT 1');
}

/**
 * pingWithRetry
 *
 * What:   Pings the DB repeatedly with exponential backoff until it succeeds
 *         OR maxAttempts is exhausted.
 * Why:    On Docker / k8s boot the DB may still be starting when the api
 *         comes up. Retrying smooths over that race instead of crash-looping.
 * Type:   READ (with side-effect: invokes onAttempt callback per failure).
 * Inputs: opts = { maxAttempts, baseDelayMs, onAttempt }
 *           - maxAttempts (int, default 5) — total tries before giving up
 *           - baseDelayMs (int, default 500) — first wait; doubles each try
 *           - onAttempt   (fn,  optional)   — called with { attempt, err }
 *                                             on every failure (for logging)
 * Output: resolves with the number of attempts taken on success;
 *         rejects with the LAST pg error if every attempt failed.
 * Used:   api/index.js at boot.
 */
async function pingWithRetry(opts = {}) {
    const maxAttempts = Number(opts.maxAttempts) >= 1 ? Number(opts.maxAttempts) : 5;
    const baseDelayMs = Number(opts.baseDelayMs) >= 1 ? Number(opts.baseDelayMs) : 500;
    const onAttempt   = typeof opts.onAttempt === 'function' ? opts.onAttempt : () => {};

    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await ping();
            return attempt + 1;
        } catch (err) {
            lastErr = err;
            onAttempt({ attempt: attempt + 1, err });
            if (attempt + 1 >= maxAttempts) break;
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastErr;
}

module.exports = { db, ping, pingWithRetry };
