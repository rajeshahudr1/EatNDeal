'use strict';

/*
 * Validators/loyalty.js — Joi schemas for the customer loyalty reads.
 */

const Joi = require('joi');
const C = require('./common');

const idRule = C.idRule
    .messages({ 'alternatives.match': 'Id is not valid.' });

const walletSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
});

const balanceSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    company_id:  idRule.required().messages({ 'any.required': 'Restaurant id is required.' }),
});

const reviewTypesSchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    company_id:  idRule.optional().allow('', null),                  // omit → restaurant picker
});

const historySchema = Joi.object({
    customer_id: idRule.required().messages({ 'any.required': 'Customer id is required.' }),
    company_id:  idRule.optional().allow('', null),                  // scope to one restaurant
    filter:      Joi.string().valid('', 'earned', 'redeemed', 'expired', 'reversed').optional(),
    limit:       Joi.number().integer().min(1).max(100).optional(),
    offset:      Joi.number().integer().min(0).optional(),
});

module.exports = { walletSchema, balanceSchema, historySchema, reviewTypesSchema };
