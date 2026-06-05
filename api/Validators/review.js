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

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/))
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

module.exports = { submitReviewSchema, listReviewsSchema };
