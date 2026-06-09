'use strict';

/*
 * Validators/loyalty.js — Joi schemas for the customer loyalty reads.
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/))
    .messages({ 'alternatives.match': 'Id is not valid.' });

const walletSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
});

const balanceSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    company_id:  idRule.required().messages({ 'any.required': 'Restaurant id is required.' }),
});

module.exports = { walletSchema, balanceSchema };
