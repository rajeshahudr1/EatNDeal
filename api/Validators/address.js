'use strict';

/*
 * Validators/address.js
 *
 * What:  Joi schemas for the signed-in customer's saved-address book —
 *          GET  /api/v1/customer/addresses          (list)
 *          POST /api/v1/customer/address/save        (create / update)
 *          POST /api/v1/customer/address/delete      (soft delete)
 *
 * Why:   Coding-Conventions rule #3 — every input is validated server-side
 *        even though the web already validated it. These back the Zomato-
 *        style location sheet + the "Address info" add/edit screen.
 *
 * Note:  Phase-1 identity model (see AuthController.updateProfile): the web
 *        layer supplies customer_id from req.session.user.id; the API is not
 *        yet public-facing. When JWT auth lands this collapses to req.auth.
 *
 * Used:  api/Routes/index.js — wraps each /customer/address* route.
 */

const Joi = require('joi');
const C = require('./common');

// Identity key shared by every endpoint (bigint id, sent as number or string).
const customerIdRule = C.idRule
    .required()
    .messages({
        'any.required':       'Customer id is required.',
        'alternatives.match': 'Customer id is not valid.',
    });

const addressIdRule = C.idRule
    .messages({ 'alternatives.match': 'Address id is not valid.' });

// Latitude / longitude — optional, but bounded to real-world ranges.
const latRule = Joi.number().min(-90).max(90).allow('', null)
    .messages({ 'number.min': 'Latitude is out of range.', 'number.max': 'Latitude is out of range.' });
const lngRule = Joi.number().min(-180).max(180).allow('', null)
    .messages({ 'number.min': 'Longitude is out of range.', 'number.max': 'Longitude is out of range.' });

// ── GET /customer/addresses ────────────────────────────────────────
// Lists the customer's active addresses. Optional lat/lng lets the API
// attach a distanceKm to each row (for the "3 km" labels in the sheet).
const addressListSchema = Joi.object({
    customer_id: customerIdRule,
    lat: latRule,
    lng: lngRule,
});

// ── POST /customer/address/save ────────────────────────────────────
// Upsert: when `id` is present + belongs to the customer → UPDATE, else
// INSERT a new address. `address` (the formatted one-line string) is the
// only content field we require — everything else is optional polish.
const addressSaveSchema = Joi.object({
    customer_id: customerIdRule,
    id:          addressIdRule,
    label: Joi.string().trim().max(60).allow('', null)
        .messages({ 'string.max': 'Label is too long.' }),
    address: Joi.string().trim().min(1).max(500).required()
        .messages({
            'string.empty': 'Please enter an address.',
            'string.max':   'Address is too long.',
            'any.required': 'Please enter an address.',
        }),
    post_code: Joi.string().trim().max(20).allow('', null)
        .messages({ 'string.max': 'Postcode is too long.' }),
    line1:     Joi.string().trim().max(255).allow('', null),
    line2:     Joi.string().trim().max(255).allow('', null),
    post_town: Joi.string().trim().max(120).allow('', null),
    latitude:  latRule,
    longitude: lngRule,
    address_type: Joi.string().trim().max(40).allow('', null)
        .messages({ 'string.max': 'Building type is too long.' }),
    additional_details: Joi.string().trim().max(255).allow('', null)
        .messages({ 'string.max': 'Additional details are too long.' }),
    drop_off_option: Joi.string().trim().max(60).allow('', null),
    delivery_instructions: Joi.string().trim().max(500).allow('', null)
        .messages({ 'string.max': 'Instructions are too long.' }),
    contact_no: Joi.string().trim().pattern(/^[0-9\s\-()+]{4,20}$/).allow('', null)
        .messages({ 'string.pattern.base': 'Please enter a valid contact number.' }),
    is_default: Joi.boolean().truthy(1, '1', 'true').falsy(0, '0', 'false', '').allow(null),
});

// ── POST /customer/address/delete ──────────────────────────────────
const addressDeleteSchema = Joi.object({
    customer_id: customerIdRule,
    id:          addressIdRule.required().messages({ 'any.required': 'Address id is required.' }),
});

module.exports = {
    addressListSchema,
    addressSaveSchema,
    addressDeleteSchema,
};
