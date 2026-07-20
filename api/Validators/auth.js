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
const C = require('./common');

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
// Digits-only, 9–15 after separators are stripped — the shared rule, so login,
// sign-up, profile and every other screen judge a number the same way. Was
// /^[0-9\s\-()+]{4,20}$/ here, which let "1234" through as a phone number.
// See Validators/common.js for how this maps onto legacy's /^[0-9]{11,15}$/.
const contactNoRule = C.mobileRule.required();

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
    // Shared rule — same strictness and wording everywhere. Optional here.
    email: C.emailRule.allow('', null),
    // Optional "Invite & Earn" code a friend shared (legacy "Referred Code").
    referred_code: Joi.string().trim().max(20).allow('', null).optional(),
});

// ── /auth/update-profile ──────────────────────────────────────────
// Update an existing registered customer. Identity key is customer_id
// (not phone) — phone itself may be one of the things being changed
// (social-signup users adding their mobile, etc.). country_code +
// contact_no are optional and must travel together if present.
const updateProfileSchema = Joi.object({
    customer_id: C.idRule
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
    // Shared rule — same strictness and wording everywhere. Optional here.
    email: C.emailRule.allow('', null),
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
    // Date of birth — YYYY-MM-DD (HTML date input). Optional.
    birthdate: Joi.string()
        .trim()
        .pattern(/^\d{4}-\d{2}-\d{2}$/)
        .allow('', null)
        .messages({ 'string.pattern.base': 'Please enter a valid date of birth.' }),
    // Gender — optional. Persisted only once the customer.gender column
    // exists (see m260529_140000); the controller guards the write.
    gender: Joi.string()
        .trim()
        .valid('male', 'female', 'other', 'na')
        .allow('', null)
        .messages({ 'any.only': 'Please choose a valid gender option.' }),
});

// ── /auth/change-phone ────────────────────────────────────────────
// Change (or add) the signed-in customer's mobile — the NEW number must be
// OTP-verified. customer_id identifies the account; the OTP proves the new
// number belongs to them, so it's safe for their loyalty to follow it.
const changePhoneSchema = Joi.object({
    customer_id: C.idRule
        .required()
        .messages({ 'any.required': 'Customer id is required.', 'alternatives.match': 'Customer id is not valid.' }),
    country_code: countryCodeRule,
    contact_no:   contactNoRule,
    otp: Joi.string()
        .trim()
        .pattern(/^[0-9]{6}$/)
        .required()
        .messages({
            'string.empty':        'Please enter the verification code.',
            'string.pattern.base': 'The verification code must be 6 digits.',
            'any.required':        'Please enter the verification code.',
        }),
});

// ── /auth/delete-account ──────────────────────────────────────────
// Soft-delete the signed-in customer's own marketplace account.
const deleteAccountSchema = Joi.object({
    customer_id: C.idRule
        .required()
        .messages({ 'any.required': 'Customer id is required.', 'alternatives.match': 'Customer id is not valid.' }),
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

// ── /auth/update-avatar ───────────────────────────────────────────
// Persist the profile-photo path (the web stores the file; we save the
// relative URL). image is a short server-relative path or '' to clear.
const updateAvatarSchema = Joi.object({
    customer_id: C.idRule
        .required()
        .messages({ 'any.required': 'Customer id is required.', 'alternatives.match': 'Customer id is not valid.' }),
    image: Joi.string()
        .trim()
        .pattern(/^\/[\w./-]{1,200}$/)
        .allow('', null)
        .messages({ 'string.pattern.base': 'Image path is not valid.' }),
});

// ── /auth/me ──────────────────────────────────────────────────────
// Re-fetch the current customer by id (web /account re-hydration). Also
// reused as the query schema for GET /auth/about (same single param).
const meSchema = Joi.object({
    customer_id: C.idRule
        .required()
        .messages({
            'any.required':       'Customer id is required.',
            'alternatives.match': 'Customer id is not valid.',
        }),
});

// ── /auth/update-about ────────────────────────────────────────────
// The optional "About You" marketplace profile (customer_profile).
// EVERY field is optional. Helpers/customerProfile.js does the final
// sanitising against the allowed option lists + JSON serialisation, so Joi
// here only enforces shape / length / known tokens — never "required".
//
// NOTE: gender, date-of-birth and photo are NOT part of this payload —
// they live on the `customer` row (handled by /auth/update-profile +
// /auth/update-avatar) and must not be duplicated here.
const yesNoRule = Joi.any().valid('0', '1', 0, 1, '').allow(null);
const multiRule = function (allowed) {
    return Joi.array().items(Joi.string().valid(...allowed)).single().allow(null);
};
const updateAboutSchema = Joi.object({
    customer_id: C.idRule
        .required()
        .messages({
            'any.required':       'Customer id is required.',
            'alternatives.match': 'Customer id is not valid.',
        }),
    // gender + dob moved here from the customer row (customer.gender
    // migration dropped) — saved into customer_profile.gender / .dob.
    gender: Joi.string().trim().valid('male', 'female', 'other', 'na').allow('', null)
        .messages({ 'any.only': 'Please choose a valid gender option.' }),
    dob: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null)
        .messages({ 'string.pattern.base': 'Please enter a valid date of birth.' }),
    anniversary_date: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null)
        .messages({ 'string.pattern.base': 'Please enter a valid anniversary date.' }),
    favorite_food_category: multiRule(['pizzas', 'kebabs', 'burgers', 'grill_food', 'desserts', 'curries', 'chinese', 'english', 'other']),
    other_food_category: Joi.string().trim().max(255).allow('', null)
        .messages({ 'string.max': 'That food name is too long.' }),
    order_type: Joi.string().trim().valid('collection', 'delivery', 'eat_in').allow('', null),
    takeaway_frequency: Joi.string().trim().valid('weekly', 'monthly', 'occasionally').allow('', null),
    offer_time: multiRule(['lunch', 'afternoon', 'evening', 'late_night', 'weekdays', 'weekends']),
    hear_about_us: Joi.string().trim().valid('tiktok', 'facebook', 'instagram', 'friend', 'google', 'walk_in').allow('', null),
    work_in_hospitality_industry: yesNoRule,
    family_size: Joi.alternatives()
        .try(Joi.number().integer().min(0).max(99), Joi.string().pattern(/^[0-9]{0,2}$/))
        .allow('', null)
        .messages({ 'alternatives.match': 'Please enter a valid family size.' }),
    has_children: yesNoRule,
    is_student:   yesNoRule,
    work_nearby:  yesNoRule,
    marketing_preferences: multiRule(['exclusive_discounts', 'birthday_rewards', 'early_access_offers', 'sms_updates', 'whatsapp_offers']),
});

module.exports = {
    sendOtpSchema,
    verifyOtpSchema,
    saveProfileSchema,
    updateProfileSchema,
    updateAvatarSchema,
    meSchema,
    updateAboutSchema,
    socialSigninSchema,
    changePhoneSchema,
    deleteAccountSchema,
};
