'use strict';

/*
 * Validators/auth.js
 *
 * What:  Joi schemas for the two public OTP endpoints —
 *          POST /api/v1/auth/send-otp
 *          POST /api/v1/auth/verify-otp
 *
 * Why:   Coding-Conventions rule #3 — every input the API accepts is
 *        validated server-side, even though the web/app already validated
 *        the same fields. The same wording in Validators/* turns Joi
 *        error messages directly into user-facing copy.
 *
 * Used:  api/Routes/index.js — wraps each /auth/* route via Middlewares/validate.
 *
 * Change log:
 *   2026-05-26 — initial.
 */

const Joi = require('joi');

// ── country + phone shapes (shared) ────────────────────────────────
// Country code: 1–4 digits, no '+', no spaces. Matches the dial codes in
// api/data/countries.js (e.g. '44', '91', '1', '353').
const countryCodeRule = Joi.string()
    .trim()
    .pattern(/^[0-9]{1,4}$/)
    .required()
    .messages({
        'string.empty':  'Please choose your country.',
        'string.pattern.base': 'Country code is not valid.',
        'any.required':  'Please choose your country.',
    });

// Contact no: 4–15 digits AFTER we strip spaces / dashes. Users paste in
// many shapes; we accept anything reasonable here and let the helper
// normalise it before DB writes. ITU-T E.164 caps the subscriber number
// at 15 digits including country code, so 15 here is a safe upper bound.
const contactNoRule = Joi.string()
    .trim()
    .pattern(/^[0-9\s\-()+]{4,20}$/)
    .required()
    .messages({
        'string.empty':  'Please enter your phone number.',
        'string.pattern.base': 'Please enter a valid phone number.',
        'any.required':  'Please enter your phone number.',
    });

// ── /auth/send-otp ────────────────────────────────────────────────
const sendOtpSchema = Joi.object({
    country_code: countryCodeRule,
    contact_no:   contactNoRule,
});

// ── /auth/verify-otp ──────────────────────────────────────────────
const verifyOtpSchema = Joi.object({
    country_code: countryCodeRule,
    contact_no:   contactNoRule,
    otp: Joi.string()
        .trim()
        .pattern(/^[0-9]{6}$/)
        .required()
        .messages({
            'string.empty':         'Please enter the verification code.',
            'string.pattern.base':  'The verification code must be 6 digits.',
            'any.required':         'Please enter the verification code.',
        }),
});

// ── /auth/save-profile ────────────────────────────────────────────
// Saves the Personal-Details step (after OTP). firstname is required;
// email + lastname are optional. The `name` field on the web form is
// split into firstname/lastname client-side before POSTing here.
const saveProfileSchema = Joi.object({
    country_code: countryCodeRule,
    contact_no:   contactNoRule,
    firstname: Joi.string()
        .trim()
        .min(1)
        .max(120)
        .required()
        .messages({
            'string.empty':  'Please enter your name.',
            'string.max':    'Name is too long.',
            'any.required':  'Please enter your name.',
        }),
    lastname: Joi.string()
        .trim()
        .max(120)
        .allow('', null)
        .messages({
            'string.max':    'Last name is too long.',
        }),
    email: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .max(180)
        .allow('', null)
        .messages({
            'string.email':  'Please enter a valid email address.',
            'string.max':    'Email is too long.',
        }),
});

// ── /auth/update-profile ──────────────────────────────────────────
// Update an existing registered customer. Identity key is customer_id
// (not phone) — phone itself may be one of the things being changed
// (social-signup users adding their mobile, etc.). country_code +
// contact_no are optional and must travel together if present.
const updateProfileSchema = Joi.object({
    customer_id: Joi.alternatives()
        .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/))
        .required()
        .messages({
            'any.required':       'Customer id is required.',
            'alternatives.match': 'Customer id is not valid.',
        }),
    firstname: Joi.string()
        .trim()
        .min(1)
        .max(120)
        .required()
        .messages({
            'string.empty':  'Please enter your name.',
            'string.max':    'Name is too long.',
            'any.required':  'Please enter your name.',
        }),
    lastname: Joi.string()
        .trim()
        .max(120)
        .allow('', null)
        .messages({ 'string.max': 'Last name is too long.' }),
    email: Joi.string()
        .trim()
        .email({ tlds: { allow: false } })
        .max(180)
        .allow('', null)
        .messages({
            'string.email':  'Please enter a valid email address.',
            'string.max':    'Email is too long.',
        }),
    // Optional — only present when the user is editing their phone.
    // The controller refuses a half-filled pair (only country or only
    // number) so we don't enforce "both required" here.
    country_code: Joi.string()
        .trim()
        .pattern(/^[0-9]{1,4}$/)
        .allow('', null)
        .messages({ 'string.pattern.base': 'Country code is not valid.' }),
    contact_no: Joi.string()
        .trim()
        .pattern(/^[0-9\s\-()+]{4,20}$/)
        .allow('', null)
        .messages({ 'string.pattern.base': 'Please enter a valid mobile number.' }),
});

// ── /auth/social-signin ───────────────────────────────────────────
// Provider-specific tokens — at least one of id_token (Google) or
// access_token (Facebook) must be present. Joi's `xor` enforces
// exactly-one-of so we don't get confused payloads. Tokens have
// generous length bounds: Google id_tokens average ~700 chars,
// Facebook access_tokens are smaller but can be ~300 with long-lived
// extension.
const socialSigninSchema = Joi.object({
    provider: Joi.string()
        .trim()
        .valid('google', 'facebook')
        .required()
        .messages({
            'any.only':      "Provider must be one of 'google' or 'facebook'.",
            'any.required':  'Provider is required.',
        }),
    id_token: Joi.string()
        .trim()
        .min(20)
        .max(4096)
        .messages({
            'string.min':    'Token looks too short.',
            'string.max':    'Token is too long.',
        }),
    access_token: Joi.string()
        .trim()
        .min(20)
        .max(4096)
        .messages({
            'string.min':    'Token looks too short.',
            'string.max':    'Token is too long.',
        }),
}).xor('id_token', 'access_token').messages({
    'object.missing': 'Either id_token (Google) or access_token (Facebook) is required.',
    'object.xor':     'Send exactly one of id_token or access_token, not both.',
});

module.exports = {
    sendOtpSchema,
    verifyOtpSchema,
    saveProfileSchema,
    updateProfileSchema,
    socialSigninSchema,
};
