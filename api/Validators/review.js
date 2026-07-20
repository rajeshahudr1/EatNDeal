'use strict';

/*
 * Validators/review.js
 *
 * What:  Joi schemas for the post-order review endpoints —
 *          POST /api/v1/customer/review        (submit / edit)
 *          GET  /api/v1/marketplace/reviews     (public list)
 *
 * Why:   Coding-Conventions #3 — every API input validated server-side.
 *
 * Change log:
 *   2026-06-04 — initial.
 */

const Joi = require('joi');
const C = require('./common');

const idRule = C.idRule
    .messages({ 'alternatives.match': 'Id is not valid.' });

// ── POST /customer/review ─────────────────────────────────────────
const submitReviewSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    order_id:    idRule.required().messages({ 'any.required': 'Order id is required.' }),
    rating: Joi.number().integer().min(1).max(5).required().messages({
        'number.base': 'Please choose a star rating.',
        'number.min':  'Please choose a star rating.',
        'number.max':  'Rating can be at most 5 stars.',
        'any.required':'Please choose a star rating.',
    }),
    // Review text — optional; a rating alone is a valid review.
    review: Joi.string().trim().max(1500).allow('', null).messages({
        'string.max': 'Your review is a little long — please shorten it.',
    }),
    // Photo — the web layer stores the file + sends the relative path here.
    photo: Joi.string().trim().pattern(/^\/[\w./-]{1,200}$/).allow('', null).messages({
        'string.pattern.base': 'Photo path is not valid.',
    }),
});

// ── GET /marketplace/reviews ──────────────────────────────────────
const listReviewsSchema = Joi.object({
    company_id: idRule.required().messages({ 'any.required': 'Restaurant id is required.' }),
    limit:  Joi.number().integer().min(1).max(20).default(5),
    offset: Joi.number().integer().min(0).default(0),
    sort:   Joi.string().valid('recent', 'best', 'worst').default('recent'),
    stars:  Joi.number().integer().min(1).max(5),   // optional single-star filter
});

// ── POST /customer/review-cashback ────────────────────────────────
// Customer submits a screenshot of an external review for cashback.
const cashbackReviewSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    // min(0), NOT idRule/positive: 0 is the MARKETPLACE's own earn page
    // (EatNDeal itself), a valid scope with no `company` row. positive()
    // rejected it, so no claim could ever be submitted from there.
    company_id: Joi.number().integer().min(0).required()
        .messages({ 'any.required': 'Restaurant id is required.' }),
    // All EIGHT types the earn page offers (Helpers/constants REVIEW_TYPES) —
    // this allowed only 1 and 2, so Transfer Your Loyalty / Facebook / TikTok /
    // Instagram / Live Video / Whatsapp were rejected at the door even though
    // the page renders a Submit button for each.
    review_type: Joi.number().integer().valid(1, 2, 3, 4, 5, 6, 7, 8).default(1),
    notes:       Joi.string().trim().max(1000).allow('', null),
    // `photo` now carries ONLY a Live-Video URL (or empty). Screenshots come as
    // base64 in image_data and are routed server-side (Helpers/imageUpload).
    photo:       Joi.string().trim().max(500).allow('', null),
    image_data:  Joi.string().base64().max(8 * 1024 * 1024).allow('', null),   // ~6 MB image
    image_name:  Joi.string().trim().max(200).allow('', null),
});

// ── POST /customer/site-review ─────────────────────────────────────
// The customer reviews EATNDEAL ITSELF (marketplace, company_id = 0) — not a
// restaurant, so there's no company_id and no order_id to send. Lands PENDING;
// the super admin publishes it.
const siteReviewSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    rating: Joi.number().integer().min(1).max(5).required().messages({
        'number.base':  'Please choose a rating between 1 and 5 stars.',
        'number.min':   'Please choose a rating between 1 and 5 stars.',
        'number.max':   'Please choose a rating between 1 and 5 stars.',
        'any.required': 'Please choose a rating between 1 and 5 stars.',
    }),
    review: Joi.string().trim().min(1).max(2000).required().messages({
        'string.empty': 'Please write your review.',
        'any.required': 'Please write your review.',
    }),
});

module.exports = { submitReviewSchema, listReviewsSchema, cashbackReviewSchema, siteReviewSchema };
