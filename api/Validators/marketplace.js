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
    // Customer postcode — matched against each branch's delivery zones
    // (store_delivery_charge_setup) to resolve real fee / min-order /
    // deliverability.
    postcode: Joi.string().trim().max(12).allow(''),
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

    // ── Phase-2 filter sidebar / bottom-sheet params ────────────
    // Each is optional. They all map 1:1 onto the state object
    // built by /js/ui/filter-sidebar.js + /js/ui/filter-sheet.js.

    // Sort order. Default ('relevance') keeps the existing nearest-
    // first behaviour; the others remap the application-side sort.
    sort: Joi.string().valid('relevance', 'distance', 'rating', 'time', 'price-asc', 'price-desc'),

    // Minimum restaurant rating (3.5 / 4.0 / 4.5). Average computed
    // from the review_rating table in the controller.
    rating: Joi.number().min(0).max(5),

    // Maximum distance from the user, in kilometres. Restaurants
    // outside this radius are filtered out application-side after
    // the Haversine calc.
    max_km: Joi.number().positive().max(500),

    // Maximum delivery-time bucket, in minutes. Single-cap form still
    // used by the mobile bottom sheet.
    max_min: Joi.number().integer().min(1).max(720),

    // Delivery-time buckets — comma list of bucket keys (15,30,45,60).
    // Multi-select union of time bands. Used by the web sidebar.
    delivery: Joi.string().trim().max(40)
        .pattern(/^(15|30|45|60)(,(15|30|45|60))*$/)
        .messages({ 'string.pattern.base': 'Delivery filter is invalid.' }),

    // Open-now toggle. '1' = only restaurants whose branch is
    // currently accepting orders.
    open_now: Joi.string().valid('1'),

    // Pure-veg toggle. '1' = only restaurants where every
    // marketplace product is veg.
    veg: Joi.string().valid('1'),

    // Has-offer toggle. '1' = only restaurants with an active
    // discount or a product carrying an offer label.
    offer: Joi.string().valid('1'),

    // ── Offer-banner landing filters (from an OFFER BANNER click) ──
    // Joi strips unknown query keys, so these MUST be declared or the
    // banner links would silently drop their filter.
    //   min_discount  — max % ≥ this ("X% off or more")
    //   upto_discount — 0 < max % ≤ this ("up to X% off")
    //   amount_off    — max £ off ≥ this ("£X off or more")
    //   free_delivery — restaurants offering free delivery
    //   free_item     — restaurants with an item / free-item deal
    //   coupon        — restaurants owning this active coupon code
    //   category      — restaurants in this mp_marketplace_category id
    //   offer_banner  — this banner's hand-picked restaurants (MANUAL_PICK)
    min_discount:  Joi.number().min(0).max(100),
    upto_discount: Joi.number().min(0).max(100),
    amount_off:    Joi.number().min(0).max(100000),
    upto_amount:   Joi.number().min(0).max(100000),
    free_delivery: Joi.string().valid('1'),
    free_item:     Joi.string().valid('1'),
    coupon:        Joi.string().trim().max(40),
    category:      Joi.number().integer().min(1),
    offer_banner:  Joi.number().integer().min(1),

    // Dish price bucket (products endpoint). low ≤ £6, mid £6-12,
    // high > £12. Applies to the marketplace_price chain.
    price: Joi.string().valid('low', 'mid', 'high'),

    // Fulfilment mode from the header Delivery/Pickup toggle — filters the
    // restaurant list to those that OFFER the chosen mode (config-level).
    mode: Joi.string().valid('pickup', 'delivery'),

    // Single-product flags — used by the restaurant detail page.
    recommended: Joi.string().valid('1'),
    featured:    Joi.string().valid('1'),

    // Signed-in customer id (Phase-1 trust model — web supplies it
    // from session). When present, the controller attaches an
    // `isFavourite` flag to each restaurant card so the heart icon
    // can paint filled vs outline without a second request.
    customer_id: Joi.alternatives().try(
        Joi.number().integer().positive(),
        Joi.string().pattern(/^[0-9]+$/),
    ).messages({ 'alternatives.match': 'Customer id is not valid.' }),
});

// /api/v1/marketplace/restaurant — single restaurant detail page.
//   id?   — company id (preferred when known)
//   slug? — domain/name slug (resolved server-side when id is absent)
//   lat/lng — for distance + delivery-time estimate
const detailQuerySchema = Joi.object({
    id:   Joi.number().integer().min(1),
    slug: Joi.string().trim().max(160),
    // Product page (clean URL): rest = restaurant slug, item = product slug.
    rest: Joi.string().trim().max(160),
    item: Joi.string().trim().max(200),
    lat:  Joi.number().min(-90).max(90),
    lng:  Joi.number().min(-180).max(180),
    postcode: Joi.string().trim().max(12).allow(''),
    // Signed-in customer id — paints the heart icon on the detail
    // header without a second round trip.
    customer_id: Joi.alternatives().try(
        Joi.number().integer().positive(),
        Joi.string().pattern(/^[0-9]+$/),
    ).messages({ 'alternatives.match': 'Customer id is not valid.' }),
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

module.exports = { listQuerySchema, searchQuerySchema, detailQuerySchema };
