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

/*
 * ── The order review BEFORE it is published ─────────────────────────
 *
 * An order review lives in `customer_review` (the moderation record) until the
 * restaurant approves it; only then does the POS create the public
 * `review_rating` row. So the ORDER PAGE reads customer_review — review_rating
 * would show nothing until approval and the customer would think their review
 * had vanished.
 *
 * Ported from legacy: Orders::getCustomerOrdersReviews()
 * (common/models/transactions/Orders.php:658-668) — customer_review rows for
 * the order with admin_status IN (0,1), newest first.
 */
const CLAIM_TABLE = 'customer_review';
const TYPE_ORDER  = 2;                 // review_type 2 = the order review
const PENDING = 0, APPROVED = 1, REJECTED = 2;   // admin_status

/**
 * claimForOrder
 *
 * What:  The customer's LIVE review for this order — pending or approved — or
 *        null once it has been rejected (which is what brings the "Add review"
 *        button back, exactly as in legacy).
 * Type:  READ.
 *
 * NB:    the SECOND argument is the customer's APP_ID, not our customer.id —
 *        customer_review is keyed the way legacy keys it (see
 *        Helpers/customerLookup.appIdOf). Callers holding a customer.id must
 *        translate first.
 */
async function claimForOrder(orderId, customerAppId) {
    if (!orderId || !customerAppId) { return null; }
    return db(CLAIM_TABLE + ' as cr')
        // The restaurant's public reply lives on the review_rating row the POS
        // creates at approval — legacy reads it through the same link
        // (customer_review.reviewRating->review_reply, order/index.php:852).
        .leftJoin(TABLE + ' as rr', 'rr.customer_review_id', 'cr.id')
        .where({ 'cr.order_id': orderId, 'cr.customer_id': customerAppId })
        .whereIn('cr.admin_status', [PENDING, APPROVED])
        .orderBy('cr.id', 'desc')
        .first('cr.id', 'cr.rating', 'cr.notes', 'cr.review_photo',
               'cr.admin_status', 'cr.created_at', 'rr.review_reply');
}

/**
 * claimView — the shape the order page renders.
 * `pending` drives nothing user-visible on its own; the page shows the review
 * either way and hides the button, like legacy.
 */
function claimView(row) {
    if (!row) { return null; }
    return {
        id:        String(row.id),
        rating:    Number(row.rating) || 0,
        review:    row.notes || '',
        photo:     row.review_photo || '',
        reply:     row.review_reply || '',
        pending:   Number(row.admin_status) === PENDING,
        createdAt: toISODate(row.created_at),
    };
}

/**
 * listForCompany
 *
 * What:  A restaurant's PUBLISHED reviews with sort, star filter and offset
 *        pagination — backs the restaurant page's reviews panel.
 *        publish_online = 1 only — EXACT legacy parity (webordering
 *        actionReviews:1284-1292 filters list AND average on it). This is
 *        also what every card's avg_rating subquery uses, so the ★4.5 on
 *        the card, the popup headline and the legacy site all agree.
 *        (An earlier iteration mirrored the admin's full list; that made
 *        the popup say 3.8 while the card and legacy said 4.5 — reverted
 *        2026-07-23 per user.)
 *        The header aggregates (average / count / per-star breakdown) are
 *        computed over the same published set.
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
        .andWhere('r.publish_online', 1)   // legacy parity — published only
        .select('r.*', 'c.firstname as c_firstname');
    if (stars != null) { pageQ.andWhere('r.rating', stars); }
    const order = sort === 'best'  ? [{ column: 'r.rating', order: 'desc' }, { column: 'r.id', order: 'desc' }]
               :  sort === 'worst' ? [{ column: 'r.rating', order: 'asc'  }, { column: 'r.id', order: 'desc' }]
               :                      [{ column: 'r.id', order: 'desc' }];
    // limit+1 to detect a next page without a second count query.
    const rows    = await pageQ.orderBy(order).offset(offset).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page    = hasMore ? rows.slice(0, limit) : rows;

    // Header aggregates + per-star breakdown — same published set as the page.
    const agg = await db(TABLE)
        .where({ company_id: companyId, publish_online: 1 })
        .count({ c: '*' }).avg({ a: 'rating' }).first();
    const brkRows = await db(TABLE)
        .where({ company_id: companyId, publish_online: 1 })
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

module.exports = {
    TABLE, hasPhotoCol, publicView, forOrder, listForCompany,
    // Order-review moderation (customer_review) — see claimForOrder above.
    CLAIM_TABLE, TYPE_ORDER, PENDING, APPROVED, REJECTED,
    claimForOrder, claimView,
};
