'use strict';

/**
 * Middlewares/rateLimit.js
 *
 * What:   Pre-configured rate-limiter instances for sensitive endpoints —
 *         login attempts, password-reset requests, OTP sending.
 * Why:    Prevents brute-force credential stuffing + spam against costly
 *         endpoints. Coding-Conventions rule (security) + general hardening.
 * Type:   READ (counts hits in memory; rejects with 429-shape envelope).
 * Inputs: none (limiter config is fixed below; env can whitelist CIDRs).
 * Output: Three named middleware functions:
 *           - loginLimiter           — 10 attempts/min/IP
 *           - forgotPasswordLimiter  — 5 attempts/min/IP
 *           - otpLimiter             — 5 attempts/min/IP
 * Used:   Mounted before the controller on /login, /forgotPassword, /send-otp.
 *
 *   This in-memory limiter is fine for a single-process api. When we scale
 *   horizontally (PM2 cluster mode, multiple containers), swap the store
 *   for a Redis-backed one (express-rate-limit's `store` option). Not
 *   required for now.
 *
 * Change log:
 *   2026-05-25 — initial; in-memory store.
 */

const rateLimit = require('express-rate-limit');
const H         = require('../Helpers/helper');
const MSG       = require('../Helpers/messages');

// Comma-separated CIDRs from env. Requests from these IPs bypass rate-limit
// (useful for ops health-probe IPs + load testing). Empty string = no bypass.
const WHITELIST = String(process.env.RATE_LIMIT_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * shouldSkip
 *
 * What:   Returns true if the request's IP is in the env whitelist.
 * Why:    Allows ops to bypass limits from known-good origins.
 * Type:   READ.
 * Inputs: req — Express request.
 * Output: boolean.
 * Used:   `skip:` option on every limiter below.
 */
function shouldSkip(req) {
    if (WHITELIST.length === 0) return false;
    const ip = req.ip;
    return WHITELIST.includes(ip);
}

/**
 * buildLimiter
 *
 * What:   Factory that builds an express-rate-limit instance with our shared
 *         options (envelope shape, IP whitelist, standard headers).
 * Why:    Keeps the three limiter definitions DRY.
 * Type:   READ.
 * Inputs: { windowMs, max, label }.
 * Output: middleware function.
 * Used:   Only inside this module.
 */
function buildLimiter({ windowMs, max, label }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,        // sends RateLimit-* headers (RFC draft)
        legacyHeaders:   false,       // skip the deprecated X-RateLimit-* headers
        skip: shouldSkip,
        // Send our standard envelope on rejection — same shape every other
        // error response uses, so clients only have one parser.
        handler: (req, res) => {
            // 429 is the IETF status for rate-limit; we still send HTTP 200
            // and put 429 in the body to match envelope convention.
            H.log.warn('rate-limit.hit', `${label} blocked`, { ip: req.ip, path: req.originalUrl });
            return H.errorResponse(res, MSG.server.rateLimited, 429);
        },
    });
}

// ── Concrete limiters ──────────────────────────────────────────────

/**
 * loginLimiter
 * What:   Caps login attempts at 10 per minute per IP.
 * Why:    Slows credential stuffing without locking out legitimate users.
 * Used:   POST /api/v1/<actor>/login (customer / rider / restaurant / admin).
 */
const loginLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max:      10,
    label:    'login',
});

/**
 * forgotPasswordLimiter
 * What:   Caps password-reset requests at 5 per minute per IP.
 * Why:    Prevents email/SMS spam.
 * Used:   POST /api/v1/<actor>/forgot-password.
 */
const forgotPasswordLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max:      5,
    label:    'forgot-password',
});

/**
 * otpLimiter
 * What:   Caps OTP-send requests at 5 per minute per IP.
 * Why:    OTP delivery costs real money (SMS); prevent abuse.
 * Used:   POST /api/v1/customer/send-otp (and /rider/send-otp once added).
 */
const otpLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max:      5,
    label:    'otp',
});

module.exports = { loginLimiter, forgotPasswordLimiter, otpLimiter };
