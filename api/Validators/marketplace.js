'use strict';

/*
 * Validators/marketplace.js
 *
 * What:  Joi schemas for the public marketplace dashboard endpoints —
 *          GET /api/v1/marketplace/restaurants?lat=&lng=&limit=
 *          GET /api/v1/marketplace/products?lat=&lng=&limit=
 *        Both share the same query-string shape, so one schema covers
 *        both. Used via Middlewares/validateQuery in api/Routes/index.js.
 *
 * Why:   Coding-Conventions rule #3 — every query param the api
 *        accepts is validated even when nothing logically requires it
 *        (defense-in-depth against accidentally passing junk into the
 *        SQL builder or the Haversine helper).
 */

const Joi = require('joi');

// lat:  -90..90  (UK is ~50..60, but the schema is global)
// lng: -180..180 (UK is roughly -8..2)
// limit: bounded so a curl flood can't pull the whole product table.
const listQuerySchema = Joi.object({
    lat: Joi.number()
        .min(-90).max(90)
        .messages({
            'number.min': 'Latitude is out of range.',
            'number.max': 'Latitude is out of range.',
        }),
    lng: Joi.number()
        .min(-180).max(180)
        .messages({
            'number.min': 'Longitude is out of range.',
            'number.max': 'Longitude is out of range.',
        }),
    limit: Joi.number()
        .integer()
        .min(1)
        // 500 is the absolute cap — only the categories endpoint
        // actually accepts limits above 50 (its controller raises
        // its internal cap for the View-all-cuisines surface that
        // needs every distinct pill at once). Restaurants and
        // products both Math.min(50, ...) internally, so the wider
        // schema bound here doesn't affect their behaviour.
        .max(500)
        .messages({
            'number.min': 'Limit must be at least 1.',
            'number.max': 'Limit cannot exceed 500.',
        }),
    // Pagination offset — how many rows to skip before slicing the
    // page. Bounded at 1000 to defend against a curl-style offset
    // bomb. The home page's "See more" / mobile auto-load passes
    // the count of items already rendered as the offset value.
    offset: Joi.number()
        .integer()
        .min(0)
        .max(1000)
        .messages({
            'number.min': 'Offset must be non-negative.',
            'number.max': 'Offset is too large.',
        }),
    // Optional cuisine filter — when present, restaurants/products
    // are restricted to that category. Used by the Zomato-style
    // "tap a cuisine pill → home filters to that cuisine" flow.
    cuisine: Joi.string()
        .trim()
        .max(120)
        .allow('')
        .messages({ 'string.max': 'Cuisine name is too long.' }),
    // Optional restaurant filter — restricts the products endpoint
    // to a single restaurant. Used by the home page's
    // /?restaurant=<slug> view which shows one restaurant's full
    // menu. Accepted as an integer company id; the web side
    // resolves slug → id before calling.
    restaurant: Joi.alternatives().try(
        Joi.number().integer().min(1),
        Joi.string().trim().max(50),
    ).messages({ 'any.invalid': 'Restaurant filter is invalid.' }),
    // Categories-only flag — when '1', the categories endpoint
    // includes sub-categories (Chicken Kebab, Donner Kebab, …)
    // alongside top-level pills. Used by the View-all-cuisines
    // surface; the home strip omits it and only sees top-level.
    all: Joi.string().valid('1').messages({ 'any.only': 'all must be 1.' }),
    // Categories-only parent lookup — when set, the categories
    // endpoint returns children of every top-level row whose name
    // matches. Sub-cuisine drill-down (e.g. parent=kebab → Chicken
    // Kebab, Donner Kebab, …).
    parent: Joi.string().trim().max(120).messages({ 'string.max': 'Parent name is too long.' }),
});

// /api/v1/marketplace/search — the home page live-filter.
//   q  — typed query. Capped at 120 chars (bigger than any realistic
//        search; defends against URL bombing).
const searchQuerySchema = Joi.object({
    q: Joi.string()
        .trim()
        .max(120)
        .allow('')
        .messages({
            'string.max': 'Search query is too long.',
        }),
});

module.exports = { listQuerySchema, searchQuerySchema };
