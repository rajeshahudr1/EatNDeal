'use strict';

/*
 * Helpers/reviews.js
 *
 * What:  Read + write the customer's NORMAL post-order review — a star
 *        rating + text + an OPTIONAL food photo — stored in `review_rating`
 *        (the same table whose average drives the rating shown on restaurant
 *        cards). One review per order. Published instantly (publish_online=1)
 *        — this is NOT the moderated Google-screenshot `customer_review`
 *        used for loyalty cashback.
 *
 * Used:  api/Controllers/Customer/ReviewController.js + Helpers/orders.js
 *        (loadDetail surfaces the order's own review).
 *
 * Change log:
 *   2026-06-04 — initial.
 */

const { db } = require('../config/db');

const TABLE = 'review_rating';

// Whether review_rating.review_photo exists yet (added by m260604_170000).
// Cached so the endpoints degrade gracefully before the migration runs.
let _hasPhoto = null;
async function hasPhotoCol() {
    if (_hasPhoto !== null) { return _hasPhoto; }
    try {
        const r = await db.raw(
            "select 1 from information_schema.columns where table_name = 'review_rating' and column_name = 'review_photo' limit 1",
        );
        const rows = r && (r.rows || r);
        _hasPhoto = Array.isArray(rows) ? rows.length > 0 : false;
    } catch (e) { _hasPhoto = false; }
    return _hasPhoto;
}

function toISODate(v) {
    if (!v) { return ''; }
    if (v instanceof Date) { return v.toISOString(); }
    return String(v);
}

/**
 * publicView
 *
 * What:  The web/app-facing shape of one review row. Photo is the stored
 *        web-relative path ('' when none / column absent).
 * Type:  READ (pure).
 */
function publicView(row) {
    if (!row) { return null; }
    // Name priority mirrors the legacy storefront (webordering reviews.php):
    // the live customer.firstname wins (joined in as c_firstname), then the
    // stored customer_name column, then a generic fallback. Old POS reviews
    // have a NULL customer_name but a valid customer_id, so the join is what
    // surfaces the real name instead of "Customer" for everyone.
    const name = (row.c_firstname && String(row.c_firstname).trim())
              || (row.customer_name || '').trim()
              || 'Customer';
    return {
        id:           String(row.id),
        rating:       Number(row.rating) || 0,
        review:       row.review || '',
        photo:        row.review_photo || '',
        customerName: name,
        reply:        row.review_reply || '',
        createdAt:    toISODate(row.created_at),
    };
}

/**
 * forOrder
 *
 * What:  The customer's existing review for a specific order (or null).
 *        Used to prefill the edit form + show the reviewed state.
 * Type:  READ.
 */
async function forOrder(orderId, customerId) {
    if (!orderId || !customerId) { return null; }
    return db(TABLE)
        .where({ order_id: orderId, customer_id: customerId })
        .orderBy('id', 'desc')
        .first();
}

/**
 * listForCompany
 *
 * What:  ALL of a restaurant's (company's) reviews with sort, star filter
 *        and offset pagination — backs the restaurant page's reviews panel.
 *        Shows every review the legacy admin (pos/review-rating) lists, i.e.
 *        NOT gated on publish_online — per user request the storefront mirrors
 *        the admin (all active reviews, including admin-added ones). review_rating
 *        has no soft-delete column, so every row is active.
 *        The header aggregates (average / count / per-star breakdown) are
 *        computed over the same full set so the totals match the admin.
 * Type:  READ.
 *
 * Opts:   sort   — 'recent' (default) | 'best' (high→low) | 'worst' (low→high)
 *         stars  — 1..5 to show only that star (omit/null = all)
 *         offset — page offset (default 0)
 *         limit  — page size (default 5, max 20)
 *
 * Output: { reviews:[...], average, count, breakdown:{1..5}, hasMore }
 */
async function listForCompany(companyId, opts) {
    opts = opts || {};
    const empty = { reviews: [], average: null, count: 0, breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, hasMore: false };
    if (!companyId) { return empty; }

    const limit  = Math.max(1, Math.min(20, Number(opts.limit) || 5));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const stars  = [1, 2, 3, 4, 5].indexOf(Number(opts.stars)) !== -1 ? Number(opts.stars) : null;
    const sort   = ['recent', 'best', 'worst'].indexOf(opts.sort) !== -1 ? opts.sort : 'recent';

    // Filtered page query. LEFT JOIN customer so we can show the reviewer's
    // real name: old POS reviews have a NULL customer_name column but a valid
    // customer_id, so the live customer.firstname supplies the name (otherwise
    // everyone showed as "Customer"). Mirrors the legacy storefront which
    // prefers $review->customer->firstname over the stored customer_name.
    const pageQ = db(TABLE + ' as r')
        .leftJoin('customer as c', 'c.id', 'r.customer_id')
        .where('r.company_id', companyId)
        .select('r.*', 'c.firstname as c_firstname');
    if (stars != null) { pageQ.andWhere('r.rating', stars); }
    const order = sort === 'best'  ? [{ column: 'r.rating', order: 'desc' }, { column: 'r.id', order: 'desc' }]
               :  sort === 'worst' ? [{ column: 'r.rating', order: 'asc'  }, { column: 'r.id', order: 'desc' }]
               :                      [{ column: 'r.id', order: 'desc' }];
    // limit+1 to detect a next page without a second count query.
    const rows    = await pageQ.orderBy(order).offset(offset).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page    = hasMore ? rows.slice(0, limit) : rows;

    // Unfiltered header aggregates + per-star breakdown.
    const agg = await db(TABLE)
        .where({ company_id: companyId })
        .count({ c: '*' }).avg({ a: 'rating' }).first();
    const brkRows = await db(TABLE)
        .where({ company_id: companyId })
        .select('rating').count({ n: '*' }).groupBy('rating');
    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    brkRows.forEach((r) => {
        const s = Math.round(Number(r.rating));
        if (breakdown[s] != null) { breakdown[s] += Number(r.n) || 0; }
    });

    return {
        reviews:   page.map(publicView),
        average:   agg && agg.a != null ? Math.round(Number(agg.a) * 10) / 10 : null,
        count:     agg ? Number(agg.c) || 0 : 0,
        breakdown,
        hasMore,
    };
}

module.exports = { TABLE, hasPhotoCol, publicView, forOrder, listForCompany };
