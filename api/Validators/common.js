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

module.exports = { idRule };
