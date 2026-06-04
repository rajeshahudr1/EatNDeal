'use strict';

/*
 * Helpers/otpSender.js
 *
 * What:  Generates + sends + verifies 6-digit OTPs for phone-based sign-in.
 *        Ported from the Yii eatndealclean Commonquery::generateOtp +
 *        sendSmsConnexa pair, but driven by env instead of the per-branch
 *        sms_configuration table (we only have one tenant in the marketplace).
 *
 *        Two providers, picked by SMS_PROVIDER env:
 *          • demo    — fixed OTP "123456", NO SMS sent. For local + screenshots.
 *          • connexa — random 6-digit OTP, POSTed to Connexa.
 *
 *        Both store the OTP in the existing `customer_otp` table with a
 *        1-minute expiry, so the verify path is identical regardless of
 *        provider.
 *
 * Why:   Coding-Conventions rule — reuse the existing schema (customer_otp
 *        already has 174-table parity with the Yii system; the columns
 *        match exactly). One helper means swapping demo ↔ live is a single
 *        env flip with zero code change.
 *
 * Used:  api/Controllers/Customer/AuthController.js — sendOtp + verifyOtp.
 *
 * Env vars:
 *   SMS_PROVIDER          — 'demo' (default in dev) | 'connexa'
 *   CONNEXA_API_URL       — full POST URL (default https://cnxa.io/api/schedule-message)
 *   CONNEXA_API_KEY       — X-API-KEY header value
 *   CONNEXA_SENDER_ID     — short alphanumeric sender id (e.g. DAHNALOUNGE)
 *   OTP_EXPIRY_SECONDS    — override OTP lifetime; defaults to 60 (matches Yii)
 *   OTP_DEMO_CODE         — override the fixed demo OTP; default '123456'
 *
 * Change log:
 *   2026-05-26 — initial; port of Commonquery::generateOtp + sendSmsConnexa.
 */

const { db } = require('../config/db');
const H      = require('./helper');

const TABLE              = 'customer_otp';
const DEFAULT_EXPIRY_SEC = 300;   // 5 minutes — 60s was too tight to even type the code in
const DEFAULT_DEMO_CODE  = '123456';
const OTP_LENGTH         = 6;

/**
 * activeProvider
 *
 * What:  Returns the active provider name. Falls back to 'demo' when
 *        SMS_PROVIDER is unset or unknown, so we never accidentally hit a
 *        paid gateway from a half-configured environment.
 * Type:  READ.
 * Used:  generateAndSend, sendSms.
 */
function activeProvider() {
    const want = String(process.env.SMS_PROVIDER || 'demo').toLowerCase();
    if (want === 'connexa') return 'connexa';
    return 'demo';
}

/**
 * randomOtp
 *
 * What:  Random 6-digit OTP as a zero-padded string ("000000".."999999").
 * Why:   6 digits is the modern food-delivery / fintech default
 *        (Zomato, Swiggy, Uber, Stripe, etc.) — gives 1,000,000 possible
 *        codes versus 10,000 for 4 digits, which is a meaningful step up
 *        against brute force given the 1-minute expiry. Leading zeros
 *        are allowed so the space is uniform.
 * Type:  READ.
 * Inputs: none.
 * Output: 6-character numeric string.
 */
function randomOtp() {
    const max = Math.pow(10, OTP_LENGTH);          // 1_000_000
    const n   = Math.floor(Math.random() * max);
    return String(n).padStart(OTP_LENGTH, '0');
}

/**
 * normaliseContact
 *
 * What:   Strips spaces / hyphens / parentheses from a phone string so the
 *         value we write into customer_otp matches what the verify call
 *         later passes back. Also trims a leading + so the column (which
 *         is plain text in the Yii schema) stays consistent.
 * Why:    Users paste numbers in many shapes; we want one canonical key.
 * Type:   READ (pure).
 */
function normaliseContact(raw) {
    return String(raw || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
}

/**
 * expirySeconds
 *
 * What:  The OTP lifetime in seconds — OTP_EXPIRY_SECONDS env or the
 *        300s default.
 * Type:  READ.
 */
function expirySeconds() {
    return Number(process.env.OTP_EXPIRY_SECONDS) > 0
        ? Number(process.env.OTP_EXPIRY_SECONDS)
        : DEFAULT_EXPIRY_SEC;
}

/**
 * expiryDate
 *
 * What:  A JS Date `expirySeconds()` in the future — used ONLY for the
 *        send response's `expires_in` countdown. The value actually STORED
 *        in customer_otp is computed on the DB clock (now() + interval),
 *        see generateAndSend, so the stored expiry can't drift with the
 *        server's timezone.
 * Type:  READ.
 */
function expiryDate() {
    return new Date(Date.now() + expirySeconds() * 1000);
}

/**
 * sendConnexa
 *
 * What:  POSTs the OTP message to Connexa's schedule-message endpoint.
 *        Mirrors Yii Commonquery::sendSmsConnexa shape:
 *          POST <api_url>
 *          Headers: Content-Type: application/json, X-API-KEY: <key>
 *          Body:    { sender_id, message, contact_number }
 *        Connexa replies with `{ status, status_code, message, data: { uuid } }`.
 * Why:   This is the gateway the live Yii system already uses (sender id
 *        DAHNALOUNGE on branch_id=1).
 * Type:  WRITE (external HTTP).
 * Inputs: contactNo (already normalised, country-prefixed), message text.
 * Output: { ok: true, providerRef } on success
 *         { ok: false, error }      on failure (caller surfaces friendly msg).
 */
async function sendConnexa(contactNo, message) {
    const url       = process.env.CONNEXA_API_URL || 'https://cnxa.io/api/schedule-message';
    const apiKey    = process.env.CONNEXA_API_KEY;
    const senderId  = process.env.CONNEXA_SENDER_ID;

    if (!apiKey || !senderId) {
        return { ok: false, error: 'CONNEXA_API_KEY / CONNEXA_SENDER_ID not configured' };
    }

    try {
        const res = await fetch(url, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY':    apiKey,
            },
            body: JSON.stringify({
                sender_id:      senderId,
                message,
                contact_number: contactNo,
            }),
        });

        const json = await res.json().catch(() => ({}));
        // Connexa returns `status: true` on success. Anything else is a failure.
        if (res.ok && json && (json.status === true || json.status === 'success')) {
            return { ok: true, providerRef: json && json.data && json.data.uuid };
        }
        return { ok: false, error: (json && json.message) || `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, error: err && err.message };
    }
}

/**
 * generateAndSend
 *
 * What:  Creates an OTP, writes it to `customer_otp`, and (if the active
 *        provider is `connexa`) sends it over SMS. In demo mode the SMS
 *        step is skipped — the OTP is still written to the DB so the
 *        verify endpoint accepts it identically.
 *
 *        Replaces any prior unexpired row for the same number first
 *        (matches Yii — the latest OTP is the one that counts).
 * Why:   One function = one source of truth for "what does the user
 *        actually type to get past the OTP screen".
 * Type:  WRITE (insert into customer_otp + optional external SMS).
 *
 * Inputs:
 *   countryCode — e.g. '44' (no '+', no spaces)
 *   contactNo   — raw phone string; normalised internally
 *
 * Output:
 *   {
 *     ok:        true | false,
 *     provider:  'demo' | 'connexa',
 *     expiresAt: Date,
 *     // only present in dev / demo so the developer can read the code
 *     // without inspecting the DB:
 *     devOtp?:   '123456',
 *     // present only on send failure (live):
 *     error?:    'reason'
 *   }
 *
 * Used:  AuthController.sendOtp.
 */
async function generateAndSend({ countryCode, contactNo }) {
    const provider = activeProvider();
    const contact  = normaliseContact(contactNo);
    const country  = normaliseContact(countryCode);
    const secs     = expirySeconds();
    const expireAt = expiryDate();   // for the response countdown only

    const otp = provider === 'demo'
        ? String(process.env.OTP_DEMO_CODE || DEFAULT_DEMO_CODE)
        : randomOtp();

    // Wipe any prior OTPs for this number so verify only ever sees the
    // newest one. Matches Yii — `generateOtp` deletes then inserts.
    await db(TABLE)
        .where({ country_code: country, contact_no: contact })
        .del();

    await db(TABLE).insert({
        country_code: country,
        contact_no:   contact,
        otp,
        // Compute expiry on the DB CLOCK (now() + interval), NOT a JS Date.
        // expire_at is `timestamp without time zone`, so inserting a JS Date
        // saved the SERVER's local wall-clock — on a non-UTC server that
        // made the DB-side `expire_at > now()` check wrong. now()+interval
        // keeps it consistent with created_at (both UTC).
        expire_at:    db.raw("now() + (? * interval '1 second')", [secs]),
        created_at:   db.fn.now(),
        updated_at:   db.fn.now(),
    });

    // Demo: don't touch Connexa. Always succeeds.
    if (provider === 'demo') {
        H.log.info('otp', 'demo OTP issued', { country, contact, otp });
        return { ok: true, provider, expiresAt: expireAt, devOtp: otp };
    }

    // Live: ship via Connexa.
    const message  = `Your EatNDeal verification code is ${otp}. It expires in 5 minutes.`;
    const fullPhone = `+${country}${contact}`;
    const result   = await sendConnexa(fullPhone, message);

    if (!result.ok) {
        H.log.warn('otp', 'connexa send failed', { country, contact, err: result.error });
        return { ok: false, provider, expiresAt: expireAt, error: result.error };
    }

    H.log.info('otp', 'connexa OTP sent', { country, contact, ref: result.providerRef });
    return { ok: true, provider, expiresAt: expireAt };
}

/**
 * verify
 *
 * What:  Looks up the latest customer_otp row for (country_code, contact_no)
 *        and returns true when `otp` matches AND `expire_at > now()`.
 *        Removes the row on success so a code can't be reused.
 * Why:   Matches the Yii actionVerifyOtp behaviour. Single-use codes are a
 *        baseline security expectation for SMS OTPs.
 * Type:  READ + WRITE (deletes on success).
 *
 * Inputs:
 *   countryCode, contactNo, otp (4-character string)
 *
 * Output:
 *   { ok: true }                       — verified, row consumed
 *   { ok: false, reason: 'expired' }   — found but expired
 *   { ok: false, reason: 'mismatch' }  — no row matches code
 *
 * Used:  AuthController.verifyOtp.
 */
async function verify({ countryCode, contactNo, otp }) {
    const contact = normaliseContact(contactNo);
    const country = normaliseContact(countryCode);
    const code    = String(otp || '').trim();

    // Expiry is checked DB-side (`expire_at > now()`) so it stays correct
    // regardless of the server's timezone — a JS `new Date(expire_at)`
    // comparison broke because expire_at is a timezone-naive column.
    const row = await db(TABLE)
        .where({ country_code: country, contact_no: contact, otp: code })
        .andWhere('expire_at', '>', db.fn.now())
        .orderBy('id', 'desc')
        .first();

    if (!row) {
        // No match OR expired — deliberately ONE outcome (the API surfaces a
        // single "invalid or expired" message so wording can't leak which).
        return { ok: false, reason: 'invalid' };
    }

    // Single-use: consume on success.
    await db(TABLE).where({ id: row.id }).del();
    return { ok: true };
}

module.exports = {
    activeProvider,
    generateAndSend,
    verify,
};
