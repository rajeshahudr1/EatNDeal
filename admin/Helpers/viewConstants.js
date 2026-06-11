'use strict';

/*
 * Helpers/viewConstants.js  (admin layer)
 *
 * What:  Frozen single-source-of-truth for the admin's server-rendered domain
 *        constants — status code→label lists and the loyalty tier meta — that
 *        were hardcoded at the top of multiple EJS views. Injected onto
 *        app.locals.C in admin/index.js so views read C.* instead of
 *        re-declaring the arrays.
 *
 * Used:  app.locals.C in admin/index.js → admin EJS views.
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

// product.status code → label (products list + form).
const PRODUCT_STATUSES = Object.freeze([
    Object.freeze([1, 'Available']),
    Object.freeze([0, 'Unavailable']),
    Object.freeze([4, 'Unavailable Today']),
    Object.freeze([5, 'Unavailable Until']),
    Object.freeze([3, 'Sold Out']),
]);

// Loyalty tier → [emoji label, colour] (dashboard + segments).
const TIER_META = Object.freeze({
    bronze: Object.freeze(['🥉 Bronze', '#cd7f32']),
    silver: Object.freeze(['🥈 Silver', '#b9b9b9']),
    gold:   Object.freeze(['🏅 Gold', '#e7b400']),
});

module.exports = { PRODUCT_STATUSES, TIER_META };
