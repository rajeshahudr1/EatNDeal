'use strict';

/*
 * Validators/paymentMethod.js
 *
 * What:   Joi schemas for the customer's saved-card endpoints:
 *           GET  /customer/payment-methods       (list)
 *           POST /customer/payment-method/setup  (create SetupIntent)
 *           POST /customer/payment-method/delete (detach)
 *
 *         customer_id is required everywhere (web layer injects from
 *         session). payment_method_id on delete is the Stripe `pm_…` id.
 */

const Joi = require('joi');
const C = require('./common');

const customerIdRule = C.idRule
    .required()
    .messages({
        'any.required':       'Customer id is required.',
        'alternatives.match': 'Customer id is not valid.',
    });

const paymentMethodListSchema = Joi.object({
    customer_id: customerIdRule,
});

const paymentMethodSetupSchema = Joi.object({
    customer_id: customerIdRule,
});

const paymentMethodDeleteSchema = Joi.object({
    customer_id:       customerIdRule,
    payment_method_id: Joi.string().trim().pattern(/^pm_[A-Za-z0-9_]+$/).required()
        .messages({
            'string.empty':   'Payment method id is required.',
            'string.pattern.base': 'Payment method id is not valid.',
            'any.required':   'Payment method id is required.',
        }),
});

module.exports = {
    paymentMethodListSchema,
    paymentMethodSetupSchema,
    paymentMethodDeleteSchema,
};
