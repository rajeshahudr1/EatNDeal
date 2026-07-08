'use strict';

/**
 * Helpers/helper.js
 *
 * What:   Reusable helpers used across every controller — response envelopes,
 *         current-UTC formatter, UUID, slugify, structured logger.
 * Why:    Centralises the "shape of every API response" so the web + future
 *         Flutter app can rely on a single envelope contract. This shape
 *         (status / show / msg / data) is FROZEN once the app ships — never
 *         rename keys.
 * Type:   READ (helpers + factories — no DB writes).
 * Inputs: per function (documented below).
 * Output: per function (documented below).
 * Used:   require('./Helpers/helper') as `H` in every controller / middleware.
 *
 * Change log:
 *   2026-05-25 — initial; envelope shape + logger ported from IOT reference.
 */

const { randomUUID, randomInt } = require('node:crypto');
const fs   = require('node:fs');
const path = require('node:path');

// ───────────────────────────────────────────────────────────────────
// Error-log file sink
// ───────────────────────────────────────────────────────────────────
// Every H.log.error(...) line is ALSO appended to a daily text file so an
// API function's failures survive even when nobody is watching the console.
// Dir is <api>/logs (helper.js lives in <api>/Helpers → one level up),
// overridable via LOG_DIR. One file per day: error-YYYY-MM-DD.log.
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');

/**
 * _appendErrorFile (private)
 * What:   Append one already-formatted line to today's error log file.
 * Why:    Persist server errors for post-mortem / ops. Best-effort — logging
 *         must NEVER throw or crash the request, so every fs call is guarded.
 *         Synchronous append so the line is flushed even if the process is
 *         about to exit on an uncaught exception (errors are rare → cost nil).
 */
function _appendErrorFile(line) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const day  = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
        fs.appendFileSync(path.join(LOG_DIR, `error-${day}.log`), line + '\n');
    } catch (e) { /* never let logging break the app */ }
}

// ───────────────────────────────────────────────────────────────────
// Response envelopes
// ───────────────────────────────────────────────────────────────────

/**
 * successResponse
 *
 * What:   Sends a 200-OK JSON envelope in the standard EatNDeal shape:
 *           { status: 200, show: false, msg: "success", data: <any> }
 * Why:    Every consumer (web PWA, future Flutter app) reads body.status
 *         instead of HTTP status, so we always send HTTP 200 and put the
 *         logical code inside the body. `show:false` tells clients NOT to
 *         pop a toast for plain successful reads.
 * Type:   READ (writes to res; no DB).
 * Inputs: res    — Express response object
 *         data   — payload to attach as `data` (omit to send no data field)
 *         msg    — display text (default "success")
 *         extra  — extra top-level fields merged into the body (rare)
 * Output: Express response (chain-friendly).
 * Used:   Every controller that completes successfully.
 */
function successResponse(res, data, msg = 'success', extra = {}) {
    const body = { status: 200, show: false, msg };
    if (data !== undefined) body.data = data;
    return res.status(200).json({ ...body, ...extra });
}

/**
 * errorResponse
 *
 * What:   Sends a JSON error envelope:
 *           { status: <code>, show: true, msg: "<reason>" }
 * Why:    Same frozen shape — clients read body.status, NOT HTTP. We keep
 *         HTTP 200 on logical errors so a client behind a strict load balancer
 *         still gets the JSON (some LBs eat 4xx bodies). HTTP 4xx/5xx is
 *         reserved for transport-level failures (handled in api/index.js).
 * Type:   READ (writes to res; no DB).
 * Inputs: res    — Express response object
 *         msg    — user-facing message (use Helpers/messages.js, not literals)
 *         status — logical status code in body (default 422; common: 401, 404)
 *         extra  — extra fields nested under `data` (`code`, `errors`, etc.)
 *
 * Phase-2X normalisation: every error envelope now nests its extras
 * under `data` so the client always reads them at `env.data.<field>`,
 * matching the success-response shape. The standard fields are:
 *           data.code   — stable string id for client-side branching
 *           data.errors — array of {code, msg, field} from validators
 * Anything else passed in `extra` also lands under `data`.
 *
 * Output: Express response (chain-friendly).
 * Used:   Every middleware / controller that needs to surface an error.
 */
function errorResponse(res, msg, status = 422, extra = {}) {
    const body = { status, show: true, msg };
    if (extra && Object.keys(extra).length) { body.data = extra; }
    return res.status(200).json(body);
}

// ───────────────────────────────────────────────────────────────────
// Time
// ───────────────────────────────────────────────────────────────────

/**
 * now
 *
 * What:   Returns the current UTC moment formatted as "YYYY-MM-DD HH:mm:ss".
 * Why:    Matches the format the existing Yii2 system writes (PHP Carbon's
 *         toDateTimeString) — keeps response payloads visually consistent
 *         across both systems when timestamps are surfaced.
 * Type:   READ.
 * Inputs: none.
 * Output: string.
 * Used:   Anywhere we hand-format a timestamp for a response.
 */
function now() {
    const d   = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ───────────────────────────────────────────────────────────────────
// IDs / tokens
// ───────────────────────────────────────────────────────────────────

/**
 * uuid
 *
 * What:   RFC 4122 v4 UUID, generated with Node's crypto.
 * Why:    Used wherever the existing Yii2 system used `Helpers::getUuid()`
 *         (which was MySQL `uuid()`). Same shape, generated locally.
 * Type:   READ.
 * Inputs: none.
 * Output: string (36 chars, e.g. "f47ac10b-58cc-4372-a567-0e02b2c3d479").
 * Used:   New customer rows, password-reset tokens, idempotency keys.
 */
function uuid() {
    return randomUUID();
}

/**
 * randomToken
 *
 * What:   Generates a random alphanumeric token of length n, appended with
 *         the unix-second timestamp. Default n=60 → ~70-char string.
 * Why:    Used for opaque tokens (e.g. download links, password-reset URLs)
 *         where a UUID is overkill but we want unguessability + a built-in
 *         timestamp marker. Uses crypto.randomInt — CSPRNG, not Math.random.
 * Type:   READ.
 * Inputs: n — desired alphanumeric length (default 60).
 * Output: string.
 * Used:   Email reset links, export download tokens.
 */
function randomToken(n = 60) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = '';
    for (let i = 0; i < n; i++) {
        out += chars[randomInt(0, chars.length)];
    }
    return out + Math.floor(Date.now() / 1000);
}

// ───────────────────────────────────────────────────────────────────
// String helpers
// ───────────────────────────────────────────────────────────────────

/**
 * slugify
 *
 * What:   Converts a string to a URL-safe lowercase slug.
 *           "Acme Corp"  → "acme-corp"
 *           "Hello!"     → "hello"
 *           ""           → "n-a"
 * Why:    Companies + branches in the existing DB use slug-like URLs;
 *         keeps anything we generate from drifting.
 * Type:   READ (pure function).
 * Inputs: str — any string-coercible value.
 * Output: string.
 * Used:   Generating new restaurant / branch slugs, file-name sanitisers.
 */
function slugify(str) {
    if (str === null || str === undefined) return 'n-a';
    const out = String(str)
        .normalize('NFKD')                       // split combining marks
        .replace(/[̀-ͯ]/g, '')         // strip diacritics
        .replace(/[^a-z0-9\- ]/gi, '')           // drop punctuation
        .replace(/\s+/g, '-')                    // spaces → hyphen
        .replace(/^-+|-+$/g, '')                 // trim hyphens
        .toLowerCase();
    return out || 'n-a';
}

// ───────────────────────────────────────────────────────────────────
// Null-safe response normaliser
// ───────────────────────────────────────────────────────────────────

/**
 * nullsToEmpty
 *
 * What:   Recursively replaces null values with empty string in any value.
 *         Arrays + plain objects are walked; Date / Buffer / Map / Set pass
 *         through unchanged.
 * Why:    Mirrors the Yii2 `Helpers::replaceNullWithEmptyString` behaviour.
 *         Some legacy mobile clients crash on JSON null; flat empty strings
 *         are safer. Use sparingly — only on response payloads where you
 *         KNOW null → "" is the desired UX.
 * Type:   READ (pure function).
 * Inputs: input — any value.
 * Output: same shape, nulls replaced with "".
 * Used:   Customer-facing endpoints where we want to keep legacy parity.
 */
function nullsToEmpty(input) {
    if (input === null) return '';
    if (Array.isArray(input)) return input.map(nullsToEmpty);
    if (input && typeof input === 'object'
        && !(input instanceof Date)
        && !(input instanceof Buffer)
        && !(input instanceof Map)
        && !(input instanceof Set)) {
        const out = {};
        for (const k of Object.keys(input)) {
            out[k] = nullsToEmpty(input[k]);
        }
        return out;
    }
    return input;
}

// ───────────────────────────────────────────────────────────────────
// Structured logger
// ───────────────────────────────────────────────────────────────────

// Numeric severities so we can compare against process.env.LOG_LEVEL.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * _currentMin (private)
 * What:   Reads LOG_LEVEL from env (default 'info') and returns its numeric
 *         severity. Anything below this level is silently dropped.
 * Why:    Lets ops crank the verbosity to 'debug' without code changes.
 */
function _currentMin() {
    const want = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVELS[want] != null ? LEVELS[want] : LEVELS.info;
}

/**
 * _emit (private)
 * What:   Formats and prints a log line:
 *           [ISO timestamp] [LEVEL] [tag] message  {...meta}
 * Why:    A predictable shape that log shippers (fluentd / vector) can parse.
 */
function _emit(level, tag, msg, meta) {
    if (LEVELS[level] < _currentMin()) return;
    const ts   = new Date().toISOString();
    const sink = level === 'error' ? console.error
               : level === 'warn'  ? console.warn
               : console.log;
    const head = `[${ts}] [${level.toUpperCase()}]` + (tag ? ` [${tag}]` : '');
    let line;
    if (meta !== undefined && meta !== null) {
        const rendered = typeof meta === 'object' ? JSON.stringify(meta) : String(meta);
        line = `${head} ${msg} ${rendered}`;
    } else {
        line = `${head} ${msg}`;
    }
    sink(line);
    // Persist ERROR lines to a daily file (every controller catch-block's
    // H.log.error lands here). info/warn/debug stay console-only to keep the
    // file small and high-signal.
    if (level === 'error') { _appendErrorFile(line); }
}

/**
 * H.log — tiny structured logger
 *
 * What:   .debug / .info / .warn / .error methods that produce structured
 *         log lines gated by env LOG_LEVEL.
 * Why:    Avoids ad-hoc console.log calls scattered everywhere; gives ops a
 *         single env knob to control verbosity in production.
 * Type:   READ (writes to stdout/stderr only).
 * Inputs: tag (string), msg (string), meta (object — optional)
 * Output: void.
 * Used:   Anywhere we'd otherwise call console.log.
 */
const log = {
    debug: (tag, msg, meta) => _emit('debug', tag, msg, meta),
    info:  (tag, msg, meta) => _emit('info',  tag, msg, meta),
    warn:  (tag, msg, meta) => _emit('warn',  tag, msg, meta),
    error: (tag, msg, meta) => _emit('error', tag, msg, meta),
};

/**
 * getUploadsBaseUrl
 * What:   The base URL the Yii2 uploads tree is published under, trailing
 *         slash stripped. One place to resolve the YII_UPLOADS_URL env knob —
 *         move the whole uploads tree (CDN / other host) by changing the env
 *         var, with every image-URL builder following automatically.
 * Type:   READ (pure but for the env read).
 * Output: string (defaults to '/yii-uploads').
 * Used:   marketplace.yiiImageUrl, loyalty.cmsShotUrl, the admin Store/Product/
 *         Category/Loyalty image-URL builders.
 */
function getUploadsBaseUrl() {
    return (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
}

/**
 * mediaUrl
 * What:   Turns a stored image reference into the URL the browser loads, so the
 *         API hands back the FULL path and web/admin just display it:
 *           • already absolute (http…)  → unchanged
 *           • "/upload/…"  (NEW marketplace + community uploads, served by THIS
 *             api at /upload) → prefixed with the api's own public base
 *           • any other "/path" or bare filename → unchanged (the caller
 *             resolves legacy ones against YII_UPLOADS_URL).
 *         Base = MEDIA_BASE_URL, else APP_URL (the api's url). web + admin DON'T
 *         configure any media url — the api owns it.
 * Type:   READ (pure but for the env read).
 */
function mediaUrl(f) {
    const s = String(f || '');
    if (!s) { return s; }
    if (/^https?:\/\//i.test(s)) { return s; }
    if (s.indexOf('/upload/') === 0) {
        const base = (process.env.MEDIA_BASE_URL || process.env.APP_URL || '').replace(/\/$/, '');
        return base ? (base + s) : s;
    }
    return s;
}

module.exports = {
    successResponse,
    errorResponse,
    now,
    uuid,
    randomToken,
    slugify,
    nullsToEmpty,
    getUploadsBaseUrl,
    mediaUrl,
    log,
};
