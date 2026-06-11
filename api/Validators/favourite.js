'use strict';

/*
 * Validators/favourite.js
 *
 * What:  Joi schemas for the signed-in customer's "favourite restaurants"
 *        (heart icon on cards / detail page) —
 *          GET  /api/v1/customer/favourites         (list)
 *          POST /api/v1/customer/favourite/toggle    (heart / unheart)
 *
 *        Both endpoints are signed-in only — a guest sees no heart at all,
 *        so the controller never has to deal with an anonymous caller.
 *        Phase-1 identity model (same as AddressController): the web layer
 *        supplies customer_id from req.session.user.id.
 *
 * Used:  api/Routes/index.js — wraps each /customer/favourite* route.
 */

const Joi = require('joi');
const C = require('./common');

// Identity key shared by every endpoint (bigint id, sent as number or string).
const customerIdRule = C.idRule
    .required()
    .messages({
        'any.required':       'Please sign in to use favourites.',
        'alternatives.match': 'Customer id is not valid.',
    });

const companyIdRule = C.idRule
    .required()
    .messages({
        'any.required':       'Restaurant is required.',
        'alternatives.match': 'Restaurant id is not valid.',
    });

// Optional — the toggle endpoint accepts null / '' / missing because
// some cards (My Favourites rail, account tab) re-render without
// knowing the original branch id; the controller falls back to the
// existing row's branch when missing.
const branchIdRule = C.idRule
    .allow('', null)
    .messages({ 'alternatives.match': 'Branch id is not valid.' });

// GET /customer/favourites — list saved restaurants for one customer.
// lat/lng are optional so we can attach distance / delivery-time labels.
const favouriteListSchema = Joi.object({
    customer_id: customerIdRule,
    lat: Joi.number().min(-90).max(90).allow('', null),
    lng: Joi.number().min(-180).max(180).allow('', null),
});

// POST /customer/favourite/toggle — flip heart for one (customer, company).
// branch_id is optional analytics (lowest branch is used when missing).
const favouriteToggleSchema = Joi.object({
    customer_id: customerIdRule,
    company_id:  companyIdRule,
    branch_id:   branchIdRule,
});

module.exports = { favouriteListSchema, favouriteToggleSchema };
