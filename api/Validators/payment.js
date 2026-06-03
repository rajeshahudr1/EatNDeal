'use strict';

/*
 * Validators/payment.js
 *
 * What:  Joi schemas for the marketplace payment endpoints.
 *
 *          POST /api/v1/customer/payment/intent
 *
 *        Phase-2F: only Stripe PaymentIntent creation. Verification at
 *        order-place-time happens inside the OrderController via the
 *        helper directly (no separate endpoint).
 *
 * Auth:  Phase-1 — customer_id injected by the web proxy.
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/));

const customerIdRule = idRule.required().messages({
    'any.required':       'Please sign in to pay.',
    'alternatives.match': 'Customer id is not valid.',
});

// POST /customer/payment/intent — identity + optional "save card" flag.
// The cart total is resolved server-side so the browser can't influence
// the amount being charged. save_card opts the card into off_session
// re-use; default is false so we never silently attach a card.
const paymentIntentSchema = Joi.object({
    customer_id: customerIdRule,
    save_card:   Joi.boolean().truthy(1, '1', 'true').falsy(0, '0', 'false', '').default(false),
});

module.exports = {
    paymentIntentSchema,
};
