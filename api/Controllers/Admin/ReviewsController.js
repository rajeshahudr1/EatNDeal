'use strict';

/*
 * Controllers/Admin/ReviewsController.js
 *
 * What:  The MARKETPLACE's public star-reviews screen for the super admin —
 *        the marketplace twin of the legacy POS page
 *        /admin/pos/review-rating/index (backend/modules/pos/…/ReviewRatingController).
 *        Lists EatNDeal's own reviews, lets the super admin post one manually,
 *        reply to one, and publish/unpublish it.
 *
 * Scope: MARKETPLACE ONLY — every read and write is pinned to
 *        review_rating.company_id = 0 (Loyalty.MARKETPLACE_COMPANY_ID). A
 *        restaurant's own reviews stay on the legacy POS page; this screen can
 *        neither see nor touch them, and the route is super-admin gated
 *        (Middlewares/requireSuperAdmin) on top of that.
 *
 * Identity: review_rating.customer_id is a REAL customer.id (even legacy
 *        resolves app_id -> customer.id before inserting here —
 *        CashbackReviewController.php:168-174), so the customer_review app_id
 *        rule does NOT apply to this table. See Helpers/loyalty joinReviewCustomer.
 *
 * Ported from legacy behaviour, with 5 legacy defects deliberately NOT copied:
 *   1. legacy's savereview/update-reply bypass its own permission gate entirely
 *      (beforeAction only guards create/update/delete, which don't exist) —
 *      ours is JWT + requireRole('admin') + requireSuperAdmin.
 *   2. legacy update-reply does findOne($id) with NO company scope (IDOR — any
 *      review in the DB, for any restaurant, editable by id) — ours re-checks
 *      company_id = 0 on the row before writing.
 *   3. legacy savereview sends no CSRF token — ours is a Bearer-JWT api call.
 *   4. legacy casts rating with (int) and never range-checks, so a crafted POST
 *      stores rating 0/99/-5 and corrupts the public average — ours clamps 1..5.
 *   5. legacy echoes customer_name unescaped (details.php:36 — stored XSS, and
 *      customer_name is attacker-controllable via the unguarded endpoint) —
 *      our EJS escapes with <%= %>.
 * Also: legacy validates customer_name on the CLIENT only; we validate server-side.
 *
 * Type:  READ + WRITE.
 * Used:  Routes/index.js  /admin/reviews*  ->  admin/Controllers/ReviewsController.
 *
 * Change log:
 *   2026-07-15 — initial (marketplace twin of the legacy review-rating page).
 */

const H       = require('../../Helpers/helper');
const { db }  = require('../../config/db');
const Loyalty = require('../../Helpers/loyalty');

const T = 'review_rating';

// The marketplace owns no branch and a manual review has no customer/order —
// these columns are NOT NULL with no default, so they're written as 0. That
// mirrors legacy savereview, which hardcodes customer_id = 0 / order_id = 0
// (ReviewRatingController.php:173-174) for an admin-entered review.
const MP  = Loyalty.MARKETPLACE_COMPANY_ID;   // 0
const NO_BRANCH = 0;
const NO_CUSTOMER = 0;
const NO_ORDER = 0;

const str = (v) => (v == null ? '' : String(v));

/**
 * reviewsList — GET /api/v1/admin/reviews?q=&status=&rating=
 *
 * What:  The marketplace's reviews + the rating summary the page header shows.
 * Why:   Mirrors legacy actionIndex (ReviewRatingController.php:65-99): a flat
 *        created_at DESC list plus avg + a 5..1 breakdown.
 *
 * Filters (all optional, and none exist in legacy — that page shows every
 * review with no way to narrow them):
 *   q       — matches customer_name OR the review text, case-insensitively.
 *   status  — 'published' (publish_online = 1, i.e. live to customers) or
 *             'unpublished' (everything else: never approved, or retracted).
 *             There is NO separate "rejected" state in review_rating — the one
 *             flag is publish_online, so unpublished covers both.
 *   rating  — 1..5, bucketed with ROUND() so it agrees with the summary bars.
 *
 * The filters narrow the LIST ONLY. avg/buckets/total stay global on purpose:
 * they describe the business's standing, and an average that moved every time
 * you searched would be worse than useless. `showing` reports the filtered size.
 *
 * NB:    Legacy computes its ADMIN average WITHOUT filtering publish_online
 *        (:79-81) while the PUBLIC page filters it (SiteController.php:1290) —
 *        so the two disagree. We return both so the screen can be honest about
 *        which number the customer actually sees.
 * Type:  READ.
 */
async function reviewsList(req, res) {
    try {
        const q       = str(req.query.q).trim().toLowerCase();
        const statusF = str(req.query.status);
        const ratingF = Number(req.query.rating);
        const hasRating = Number.isFinite(ratingF) && ratingF >= 1 && ratingF <= 5;

        const rows = await db(T)
            .where({ company_id: MP })
            .modify((qb) => {
                if (q) {
                    // Group the OR — a bare .orWhere here would escape the
                    // company_id scope and leak restaurants' reviews.
                    qb.andWhere((b) => {
                        b.whereRaw('LOWER(customer_name) LIKE ?', ['%' + q + '%'])
                         .orWhereRaw('LOWER(review) LIKE ?', ['%' + q + '%']);
                    });
                }
                // publish_online is 1 or 0, but treat anything not-1 as
                // unpublished so a NULL can't hide a review from both filters.
                if (statusF === 'published')        { qb.andWhere('publish_online', 1); }
                else if (statusF === 'unpublished') {
                    qb.andWhere((b) => { b.whereNot('publish_online', 1).orWhereNull('publish_online'); });
                }
                if (hasRating) { qb.andWhereRaw('ROUND(rating) = ?', [Math.round(ratingF)]); }
            })
            .orderBy('created_at', 'desc')
            .select(
                'id', 'rating', 'review', 'review_reply', 'publish_online',
                'is_verified', 'customer_id', 'customer_name', 'review_photo',
                'created_at',
            );

        // Live AVG on every render, exactly like legacy — there is no stored
        // average anywhere and no cache to invalidate.
        // Deliberately NOT filtered: the summary describes all of the
        // marketplace's reviews, whatever the list is currently narrowed to.
        const avgAll = await db(T).where({ company_id: MP }).avg({ a: 'rating' }).first();
        const avgPub = await db(T).where({ company_id: MP, publish_online: 1 }).avg({ a: 'rating' }).first();
        const cntAll = await db(T).where({ company_id: MP }).count('* as c').first();

        // 5 -> 1 breakdown. Legacy buckets with ROUND(rating) (:84-89), so a 4.5
        // counts as 5 — matched here so the bars agree with the POS page.
        const buckets = {};
        for (let i = 5; i >= 1; i--) {
            const r = await db(T).where({ company_id: MP }).whereRaw('ROUND(rating) = ?', [i]).count('* as c').first();
            buckets[i] = Number(r && r.c) || 0;
        }

        const reviews = rows.map((r) => ({
            id:             Number(r.id),
            rating:         Number(r.rating) || 0,
            review:         str(r.review),
            review_reply:   str(r.review_reply),
            publish_online: Number(r.publish_online) === 1,
            is_verified:    Number(r.is_verified) === 1,
            // Legacy name fallback (index.php:85-90): customer_name, else the
            // linked customer's firstname, else "Past Customer". Its `??` only
            // catches NULL so an EMPTY customer_name renders blank there; we
            // treat blank as absent, which is what it means.
            customer_name:  str(r.customer_name).trim() || 'Past Customer',
            is_manual:      Number(r.customer_id) === 0,
            review_photo:   str(r.review_photo),
            created_at:     r.created_at,
        }));

        return H.successResponse(res, {
            reviews,
            // total = EVERY marketplace review (what the summary band and its
            // percentage bars are about). showing = how many survived the
            // filters, i.e. the length of the list below. They differ only
            // while a filter is on; filtered = true drives the "showing X of Y"
            // line and the empty state's wording.
            total:       Number(cntAll && cntAll.c) || 0,
            showing:     reviews.length,
            filtered:    Boolean(q || statusF || hasRating),
            avg_all:     Math.round((Number(avgAll && avgAll.a) || 0) * 10) / 10,
            avg_public:  Math.round((Number(avgPub && avgPub.a) || 0) * 10) / 10,
            buckets,
        });
    } catch (err) {
        H.log.error('admin.reviews.list', err && err.message);
        return H.errorResponse(res, 'Could not load the reviews.', 500);
    }
}

/**
 * reviewsSave — POST /api/v1/admin/reviews  { customer_name, review, rating }
 *
 * What:  Posts a review manually, as the super admin. Legacy twin: actionSavereview
 *        (ReviewRatingController.php:151-200).
 * Why:   Same 3 inputs as legacy — no customer picker, no order, no photo.
 * NB:    Like legacy, this publishes IMMEDIATELY (publish_online = 1) with no
 *        moderation step; the Publish toggle is the only way to retract it.
 * Type:  WRITE.
 */
async function reviewsSave(req, res) {
    try {
        const b = req.body || {};
        const customerName = str(b.customer_name).trim();
        const review       = str(b.review).trim();
        const ratingRaw    = Number(b.rating);

        // Legacy validates customer_name on the CLIENT only (custom.js:8948) and
        // never server-side — so a direct POST stores a nameless review. We
        // check it here; the wording matches the legacy toast.
        if (!customerName) { return H.errorResponse(res, 'Please enter customer name', 422); }
        if (!review)       { return H.errorResponse(res, 'Review cannot be empty', 422); }

        // Legacy does (int)$rating with NO range check, so a crafted POST can
        // bank rating 0 / 99 / -5 and skew the public average forever. Clamp.
        if (!Number.isFinite(ratingRaw) || ratingRaw < 1 || ratingRaw > 5) {
            return H.errorResponse(res, 'Please choose a rating between 1 and 5 stars', 422);
        }
        const rating = Math.round(ratingRaw);

        const [row] = await db(T).insert({
            branch_id:      NO_BRANCH,
            company_id:     MP,
            customer_id:    NO_CUSTOMER,   // manual review — no real customer
            order_id:       NO_ORDER,      // …and no backing order
            review,
            rating,
            customer_name:  customerName.slice(0, 191),   // column is varchar(191)
            publish_online: 1,             // live immediately, like legacy
            is_verified:    1,
            is_marketplace: 1,             // created by the marketplace, not legacy POS
            created_by:     req.user && req.user.sub != null ? Number(req.user.sub) : null,
            updated_by:     req.user && req.user.sub != null ? Number(req.user.sub) : null,
            created_at:     db.fn.now(),
            updated_at:     db.fn.now(),
        }).returning('id');

        return H.successResponse(res, { id: row && (row.id || row) }, 'Review submitted successfully');
    } catch (err) {
        H.log.error('admin.reviews.save', err && err.message);
        return H.errorResponse(res, 'Failed to save review', 500);
    }
}

/**
 * reviewsReply — POST /api/v1/admin/reviews/reply  { id, review_reply, publish_online }
 *
 * What:  Saves the public reply and/or the Publish Online flag. Legacy twin:
 *        actionUpdateReply (ReviewRatingController.php:127-149) — which writes
 *        exactly these two fields (+ updated_by/at) and nothing else. Rating,
 *        review text and customer_name are NOT editable after creation, there
 *        as here.
 * NB:    Legacy scopes this to NOTHING — findOne($id) by id alone, so any admin
 *        could edit any restaurant's review (IDOR), and a bad id fatals on a
 *        null. We pin to company_id = 0 and 404 otherwise.
 * Type:  WRITE.
 */
async function reviewsReply(req, res) {
    try {
        const b  = req.body || {};
        const id = Number(b.id);
        if (!id) { return H.errorResponse(res, 'Missing review id.', 422); }

        // Scope check FIRST — a marketplace screen may only touch marketplace rows.
        const row = await db(T).where({ id, company_id: MP }).first('id');
        if (!row) { return H.errorResponse(res, 'That review no longer exists.', 404); }

        const patch = {
            updated_by: req.user && req.user.sub != null ? Number(req.user.sub) : null,
            updated_at: db.fn.now(),
        };
        // Both fields are optional — the page saves the reply and the publish
        // toggle through this one endpoint, exactly like legacy.
        if (b.review_reply !== undefined) { patch.review_reply = str(b.review_reply).trim().slice(0, 2000) || null; }
        if (b.publish_online !== undefined) {
            patch.publish_online = (b.publish_online === true || b.publish_online === 1
                || b.publish_online === '1' || b.publish_online === 'on') ? 1 : 0;
        }

        await db(T).where({ id, company_id: MP }).update(patch);
        return H.successResponse(res, { id }, 'Review updated successfully');
    } catch (err) {
        H.log.error('admin.reviews.reply', err && err.message);
        return H.errorResponse(res, 'Something went wrong', 500);
    }
}

module.exports = { reviewsList, reviewsSave, reviewsReply };
