'use strict';

/*
 * Validators/common.js
 *
 * What:  Shared Joi rule building-blocks for the customer/merchant validators,
 *        so a cross-cutting rule (the id shape, …) is defined ONCE. Joi schemas
 *        are immutable — every caller chains .required()/.messages() to taste
 *        without affecting any other caller, so sharing a base is safe.
 *
 *        idRule — the canonical "positive integer OR numeric string" id, used
 *        for customer_id / company_id / order_id / product_id … Each validator
 *        keeps its OWN wording by chaining .messages() as before.
 *
 * Used:  required across api/Validators/*.js.
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/));

/*
 * ── Mobile number ───────────────────────────────────────────────────
 *
 * LEGACY RULE, COPIED EXACTLY: /^[0-9]{11,15}$/ — digits only, 11 to 15.
 * webordering/web/js/custom.js:696, message "Please enter a valid phone
 * number (11-15 digits)".
 *
 * Legacy validates the country code as a SEPARATE field (#countryCode,
 * custom.js:686) and still requires 11–15 digits in the phone box, so this is
 * the same shape as ours — the country chip is not part of the count.
 *
 * A UK mobile is therefore typed WITH its trunk zero: 07123456789 (11).
 * "7123456789" (10) is rejected — legacy rejects it too.
 *
 * Separators are stripped before the test so a pasted "07123 456789" is
 * judged on its digits, the same normalisation Helpers/format.normalisePhone
 * applies before a DB write. (The old rule here was
 * /^[0-9\s\-()+]{4,20}$/, which accepted "1234" as a phone number.)
 */
const MOBILE_MIN = 11;
const MOBILE_MAX = 15;
const MOBILE_RE  = /^[0-9]{11,15}$/;      // legacy, verbatim

// Digits after separators are removed. Exported so non-Joi callers (and the
// web/admin layers) can apply the same test instead of inventing their own.
function mobileDigits(raw) {
    return String(raw == null ? '' : raw).replace(/[\s\-().+]/g, '');
}

// True when the value passes legacy's phone test.
function isValidMobile(raw) {
    return MOBILE_RE.test(mobileDigits(raw));
}

const mobileRule = Joi.string()
    .trim()
    .custom((value, helpers) => (isValidMobile(value) ? value : helpers.error('mobile.invalid')))
    .messages({
        'string.empty':   'Please enter your mobile number.',
        'any.required':   'Please enter your mobile number.',
        'mobile.invalid': 'Please enter a valid phone number (11-15 digits).',
    });

/*
 * ── Email ───────────────────────────────────────────────────────────
 * LEGACY RULE, COPIED EXACTLY: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
 * (webordering/web/js/custom.js:680, "Please enter a valid email address").
 * No spaces, exactly one @, and a dot in the domain.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(raw) {
    return EMAIL_RE.test(String(raw == null ? '' : raw).trim());
}

const emailRule = Joi.string()
    .trim()
    .lowercase()
    .max(255)
    .custom((value, helpers) => (isValidEmail(value) ? value : helpers.error('email.invalid')))
    .messages({
        'string.empty':  'Please enter your email address.',
        'string.max':    'Email is too long.',
        'any.required':  'Please enter your email address.',
        'email.invalid': 'Please enter a valid email address.',
    });

/*
 * ── Name ────────────────────────────────────────────────────────────
 * LEGACY RULE, COPIED EXACTLY: 2–50 characters, letters and spaces only
 * (custom.js:672, "Please enter a valid name (2-50 characters, letters only)").
 */
const NAME_RE = /^[A-Za-z\s]+$/;

function isValidName(raw) {
    const v = String(raw == null ? '' : raw).trim();
    return v.length >= 2 && v.length <= 50 && NAME_RE.test(v);
}

const nameRule = Joi.string()
    .trim()
    .custom((value, helpers) => (isValidName(value) ? value : helpers.error('name.invalid')))
    .messages({
        'string.empty':  'Please enter your name.',
        'any.required':  'Please enter your name.',
        'name.invalid':  'Please enter a valid name (2-50 characters, letters only).',
    });

module.exports = {
    idRule, mobileRule, emailRule, nameRule,
    mobileDigits, isValidMobile, isValidEmail, isValidName,
    MOBILE_RE, EMAIL_RE, NAME_RE, MOBILE_MIN, MOBILE_MAX,
};
