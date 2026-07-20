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
const C = require('./common');

const idRule = C.idRule;

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

// POST /customer/payment/saved-card — charge an already-saved card. The
// payment method must belong to this customer; the controller re-checks that
// against Stripe rather than trusting the id off the wire.
const savedCardSchema = Joi.object({
    customer_id:       customerIdRule,
    payment_method_id: Joi.string().trim().max(255).required().messages({
        'any.required':  'Please choose a card.',
        'string.empty':  'Please choose a card.',
    }),
});

module.exports = {
    paymentIntentSchema,
    savedCardSchema,
};
