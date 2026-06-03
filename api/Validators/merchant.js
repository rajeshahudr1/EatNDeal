'use strict';

/*
 * Validators/merchant.js
 *
 * What:  Joi schemas for the merchant dashboard endpoints.
 *
 *          GET  /api/v1/merchant/orders
 *          GET  /api/v1/merchant/order/:id
 *          POST /api/v1/merchant/order/advance
 *
 * Auth:  Phase-1 trust model — customer_id injected by the web proxy.
 *        The controller layer THEN checks the env-driven staff
 *        allowlist via Helpers/merchant.companyForStaff(customer_id).
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/));

const customerIdRule = idRule.required().messages({
    'any.required':       'Please sign in to access the merchant dashboard.',
    'alternatives.match': 'Customer id is not valid.',
});

// ── GET /merchant/orders ──────────────────────────────────────────
// Lists the company's marketplace orders. Optional state filter:
//   'live'      (default)  pending + accepted + preparing + out + ready
//   'completed'            delivered
//   'cancelled'            cancelled
//   'all'                  any status
const merchantOrdersSchema = Joi.object({
    customer_id: customerIdRule,
    state:       Joi.string().valid('live', 'completed', 'cancelled', 'all').default('live'),
    limit:       Joi.number().integer().min(1).max(100).default(50),
    offset:      Joi.number().integer().min(0).max(1000).default(0),
});

// ── GET /merchant/order — single order ────────────────────────────
const merchantOrderSchema = Joi.object({
    customer_id: customerIdRule,
    id:          idRule.required(),
});

// ── POST /merchant/order/advance ─────────────────────────────────
// Body: customer_id, order_id, expected_status (the status the UI saw
// when it rendered the button — used for the atomic UPDATE WHERE),
// next_status (the value the button transitions to).
const merchantAdvanceSchema = Joi.object({
    customer_id:     customerIdRule,
    order_id:        idRule.required(),
    expected_status: Joi.string().trim().max(3).required(),
    next_status:     Joi.string().trim().max(3).required(),
});

module.exports = {
    merchantOrdersSchema,
    merchantOrderSchema,
    merchantAdvanceSchema,
};
