'use strict';

/**
 * Validators/delivery.js
 *
 * What:   Joi schemas for the three public delivery endpoints —
 *           POST /api/v1/delivery/search-address
 *           POST /api/v1/delivery/retrieve-address
 *           POST /api/v1/delivery/postcode-coords
 * Why:    Coding-Conventions rule #3 (api-side validation). We refuse
 *         malformed input early so the upstream Ideal Postcodes call
 *         never sees junk and our session never receives broken data.
 * Type:   READ (schema definitions only).
 * Inputs: none — exported schemas.
 * Output: schemas consumable by api/Middlewares/validate.js.
 * Used:   api/Routes/index.js — wraps each delivery route.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const Joi = require('joi');

// ── /delivery/search-address ──────────────────────────────────────
// Same minimum-3-character contract as the Yii2 controller. Plain text,
// trimmed, max 100 chars (UK postcodes / street addresses fit easily).
const searchAddressSchema = Joi.object({
    query: Joi.string()
        .trim()
        .min(3)
        .max(100)
        .required()
        .messages({
            'string.min':    'Please type at least 3 characters.',
            'string.max':    'Search query is too long.',
            'any.required':  'Please type a postcode or street name.',
        }),
});

// ── /delivery/retrieve-address ────────────────────────────────────
// id comes from a prior /search-address call. Length + format depend on
// the active LOCATION_PROVIDER:
//   • ideal_postcodes — numeric UDPRN (e.g. 12345678)
//   • postcodes_io    — UK postcode (e.g. SW1A1AA, ≤ 12 chars)
//   • nominatim       — 'nm:' + base64-url(JSON of address) — typically
//                       200-600 chars, occasionally larger for rich data
// We cap at 4096 chars (well beyond any realistic encoded id) and allow
// base64-url characters + the ':' separator the providers use as a
// type prefix. We do NOT enforce a per-provider format here — the
// helper that owns the id decodes it and rejects malformed input with
// a friendlier message.
const retrieveAddressSchema = Joi.object({
    id: Joi.alternatives()
        .try(
            Joi.string().trim().min(1).max(4096).pattern(/^[A-Za-z0-9_:.\-]+$/),
            Joi.number().integer().positive(),
        )
        .required()
        .messages({
            'any.required':       'Address ID is required.',
            'alternatives.match': 'Address ID is not valid.',
        }),
});

// ── /delivery/postcode-coords ─────────────────────────────────────
// Simple postcode lookup. We accept UK postcode-like strings up to 12 chars;
// the upstream API rejects anything that doesn't resolve so we don't need
// strict format checking here.
const postcodeCoordsSchema = Joi.object({
    postcode: Joi.string()
        .trim()
        .min(2)
        .max(12)
        .required()
        .messages({
            'string.min':    'Postcode looks too short.',
            'string.max':    'Postcode looks too long.',
            'any.required':  'Please enter a postcode.',
        }),
});

// ── /delivery/reverse-geocode ─────────────────────────────────────
// Coordinates → nearest address (for "use my current location").
const reverseGeocodeSchema = Joi.object({
    lat: Joi.number().min(-90).max(90).required().messages({
        'any.required': 'Latitude is required.',
        'number.base':  'Latitude is not valid.',
    }),
    lng: Joi.number().min(-180).max(180).required().messages({
        'any.required': 'Longitude is required.',
        'number.base':  'Longitude is not valid.',
    }),
});

module.exports = {
    searchAddressSchema,
    retrieveAddressSchema,
    postcodeCoordsSchema,
    reverseGeocodeSchema,
};
