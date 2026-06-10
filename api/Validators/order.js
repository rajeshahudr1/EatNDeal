'use strict';

/*
 * Validators/order.js
 *
 * What:  Joi schemas for the marketplace order endpoints.
 *
 *          POST /api/v1/customer/order/place
 *          GET  /api/v1/customer/orders     (Phase-2E)
 *          GET  /api/v1/customer/order/:id  (Phase-2E)
 *
 *        Phase 2D ships only place + a placeholder for list/detail.
 *        The strict per-row revalidate happens inside
 *        Helpers/cartValidate.validate(PLACE) — this layer just guards
 *        against junk input.
 *
 * Auth:  Phase-1 — customer_id injected by the web proxy.
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/));

const customerIdRule = idRule.required().messages({
    'any.required':       'Please sign in to place an order.',
    'alternatives.match': 'Customer id is not valid.',
});

// ── POST /customer/order/place ─────────────────────────────────────
//   payment_option = 1 → Cash on Delivery / Pickup
//   payment_option = 2 → Card (Stripe); requires payment_intent_id
//                         that the server then verifies against Stripe
//                         and the cart total.
const orderPlaceSchema = Joi.object({
    customer_id:    customerIdRule,
    payment_option: Joi.number().integer().valid(1, 2).default(1).messages({
        'any.only': 'Payment method must be Cash or Card.',
    }),
    payment_intent_id: Joi.string().trim().max(120).allow('', null)
        .messages({ 'string.max': 'Payment confirmation is invalid.' }),
    customer_note:  Joi.string().trim().max(240).allow('', null)
        .messages({ 'string.max': 'Note is too long.' }),
});

// ── GET /customer/orders ────────────────────────────────────────────
// Lists the customer's marketplace orders. Optional pagination.
const orderListSchema = Joi.object({
    customer_id: customerIdRule,
    limit:  Joi.number().integer().min(1).max(50),
    offset: Joi.number().integer().min(0).max(1000),
    // Filters (status bucket / date range / order-number search).
    status:    Joi.string().valid('active', 'completed', 'cancelled').optional(),
    search:    Joi.string().trim().max(60).allow('', null).optional(),
    date_from: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
    date_to:   Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
});

// ── GET /customer/order/:id ────────────────────────────────────────
// Full detail for a single order. `id` comes from the URL param so we
// validate it through validateQuery alongside customer_id.
const orderDetailSchema = Joi.object({
    customer_id: customerIdRule,
    id:          idRule.required().messages({
        'any.required': 'Order id is required.',
    }),
});

// ── GET /customer/order/status ─────────────────────────────────────
// Slim polling endpoint — same identity check as the detail endpoint
// but returns only the changing fields (status / ETA / progress).
// The detail page polls this every ~30 s and stops when isTerminal.
const orderStatusSchema = orderDetailSchema;

// ── POST /customer/order/reorder ───────────────────────────────────
// Clones a past order's items into a fresh open cart (mirrors the
// legacy webordering actionReorder). order_id comes in the body.
const orderReorderSchema = Joi.object({
    customer_id: customerIdRule,
    order_id:    idRule.required().messages({
        'any.required': 'Order id is required.',
    }),
});

// ── POST /customer/order/report-issue ──────────────────────────────
// Customer reports a problem with an order (→ epos_complaints).
const orderReportIssueSchema = Joi.object({
    customer_id: customerIdRule,
    order_id:    idRule.required().messages({ 'any.required': 'Order id is required.' }),
    notes:       Joi.string().trim().min(1).max(2000).required().messages({
        'string.empty': 'Please describe the problem with your order.',
        'any.required': 'Please describe the problem with your order.',
        'string.max':   'That message is too long.',
    }),
});

// ── GET /customer/order/issue-response ──────────────────────────────
const orderIssueResponseSchema = Joi.object({
    customer_id: customerIdRule,
    order_id:    idRule.required().messages({ 'any.required': 'Order id is required.' }),
});

module.exports = {
    orderPlaceSchema,
    orderListSchema,
    orderDetailSchema,
    orderStatusSchema,
    orderReorderSchema,
    orderReportIssueSchema,
    orderIssueResponseSchema,
};
