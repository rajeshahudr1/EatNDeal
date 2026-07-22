'use strict';

/*
 * Controllers/Customer/ReviewController.js
 *
 * What:  Post-order reviews — the customer rates (1–5) + writes text + can
 *        attach ONE food photo, after their order. Saved to `review_rating`
 *        (publish_online=1, instantly public) — one review per order, edits
 *        overwrite. The restaurant page reads these back (list + average).
 *
 *        This is the normal public review. The moderated Google/Facebook
 *        screenshot review (`customer_review`, for loyalty cashback) is a
 *        separate feature that lands with the loyalty engine.
 *
 * Used:  Wired in api/Routes/index.js.
 *
 * Change log:
 *   2026-06-04 — initial.
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const reviews   = require('../../Helpers/reviews');
const imageUpload = require('../../Helpers/imageUpload');
const { db }    = require('../../config/db');

/**
 * submit
 *
 * What:  The customer's review of one of THEIR orders. ONE review per order,
 *        moderated by the restaurant — legacy parity, ported from
 *        webordering OrderController::actionReviewSubmit (:1417-1481).
 *
 *        Written to `customer_review` with review_type = 2 and
 *        admin_status = 0 (pending) — NOT straight into review_rating. That is
 *        how legacy does it, and it is what puts the review in front of the
 *        restaurant: the POS Cashback-Review screen lists customer_review rows,
 *        and ITS approve step (CashbackReviewController::actionUpdateReviewStatus
 *        :160-196) is what creates the public review_rating row
 *        (publish_online = 1) and fires the review cashback. Reject (:198-207)
 *        needs a reason and publishes nothing.
 *
 *        Re-submit rule, exactly legacy's (:1442-1456):
 *          admin_status IN (0,1) — pending or approved → refused, one per order
 *          admin_status = 2      — rejected            → a NEW row is allowed,
 *                                  which is why the button comes back
 *        There is no EDIT: legacy only ever inserts. An approved review can't
 *        be quietly rewritten after the restaurant has seen it.
 *
 *        Refuses orders that aren't the customer's, aren't marketplace, or
 *        were cancelled/refunded/voided (you review food you received).
 * Type:  WRITE.
 *
 * Inputs:  body — customer_id, order_id, rating (1–5), review?, photo?
 * Output:  200 envelope, data = { review: {...} }
 */
async function submit(req, res) {
    try {
        const { customer_id, order_id, rating, review, photo } = req.body;

        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        // The order must be this customer's marketplace order.
        const order = await db('orders')
            .where({ id: order_id, user_id: customer_id, is_marketplace: 1 })
            .first('id', 'company_id', 'branch_id', 'order_status');
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        // Can't review a cancelled / refunded / voided order.
        const badTerminals = ['0', '1', '2', '9'];
        if (badTerminals.indexOf(String(order.order_status || '')) !== -1) {
            return H.errorResponse(res, 'This order can’t be reviewed.', 422);
        }

        const reviewText = String(review || '').trim();
        if (!reviewText) { return H.errorResponse(res, 'Review is required.', 422); }

        // customer_review.customer_id holds the APP_ID, not our customer.id —
        // that is what legacy writes and what the restaurant's POS matches on
        // when it approves (see Helpers/customerLookup.appIdOf). Writing our id
        // here would hide the review from the POS, or attach it to whichever
        // customer happens to own that number as an app_id.
        const claimCustomerId = await customers.appIdOf(customer_id);
        if (claimCustomerId === null) {
            H.log.error('review.submit', 'customer ' + customer_id + ' has no app_id');
            return H.errorResponse(res, 'Could not submit your review.', 500);
        }

        // One live review per order — legacy's exact test. A REJECTED row
        // (admin_status 2) is deliberately not counted, so the customer can
        // write a fresh one after a rejection.
        const existing = await db(reviews.CLAIM_TABLE)
            .where({ order_id, customer_id: claimCustomerId, company_id: order.company_id })
            .whereIn('admin_status', [reviews.PENDING, reviews.APPROVED])
            .first('id');
        if (existing) {
            return H.errorResponse(res, 'You have already submitted a review for this order.', 409);
        }

        // Always an INSERT, never an update — legacy has no edit path, and a
        // rejected attempt stays on the record rather than being overwritten.
        await db(reviews.CLAIM_TABLE).insert({
            uuid:         require('node:crypto').randomUUID(),
            company_id:   order.company_id,
            customer_id:  claimCustomerId,      // app_id — see above
            order_id,
            review_type:  reviews.TYPE_ORDER,   // 2 — the order review
            rating:       Number(rating),
            notes:        reviewText,
            review_photo: (photo || null),
            admin_status: reviews.PENDING,      // 0 — awaits the restaurant
            review_date:  db.raw('CURRENT_DATE'),
            created_at:   db.fn.now(),
            created_by:   claimCustomerId,
        });
        // NB the review cashback is NOT fired here. It is fired by the
        // restaurant's POS when it APPROVES the row (CustomerRewards
        // ::customerCashback, ruleType 'review') — paying out for a review the
        // restaurant hasn't accepted yet is exactly what moderation prevents.

        const fresh = await reviews.claimForOrder(order_id, claimCustomerId);
        return H.successResponse(res, { review: reviews.claimView(fresh) },
            'Review submitted successfully.');
    } catch (err) {
        H.log.error('review.submit', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * listForRestaurant
 *
 * What:  Public list of a restaurant's published reviews (+ average + count)
 *        for the restaurant page. No customer guard — published reviews are
 *        public.
 * Type:  READ.
 *
 * Query:   company_id (required), limit?
 * Output:  200 envelope, data = { reviews:[...], average, count }
 */
async function listForRestaurant(req, res) {
    try {
        const data = await reviews.listForCompany(req.query.company_id, {
            sort:   req.query.sort,
            stars:  req.query.stars,
            offset: req.query.offset,
            limit:  req.query.limit,
        });
        return H.successResponse(res, data);
    } catch (err) {
        H.log.error('review.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * submitCashbackReview — POST /customer/review-cashback
 *
 * What:  Customer submits a screenshot of an external (Google/Facebook)
 *        review to earn cashback — the legacy customer_review flow (DISTINCT
 *        from the post-order star reviews on review_rating). Stored
 *        admin_status = 0 (pending); the RESTAURANT approves it in the POS,
 *        which fires the review cashback (loyalty_review_cashback_rule).
 *
 * Limit: ONE claim per (customer, company, review_type) — legacy parity. Once a
 *        row exists it is never replaced, whatever its admin_status, so a
 *        rejected claim cannot be retried. That is legacy's rule, not a choice
 *        made here (see the comment on the check below).
 * Type:  WRITE.
 */
async function submitCashbackReview(req, res) {
    try {
        const customerId = req.body.customer_id;
        const companyId  = req.body.company_id;
        const reviewType = Number(req.body.review_type) || 1;
        const notes      = String(req.body.notes || '').trim().slice(0, 1000);
        // `photo` now carries ONLY a Live-Video URL. Screenshots arrive as
        // base64 (image_data) and are routed to the right server below.
        const videoUrl   = String(req.body.photo || '').trim();
        const imageData  = String(req.body.image_data || '');
        const imageName  = String(req.body.image_name || '').trim();

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }
        // `== null`, NOT `!companyId` — 0 is the MARKETPLACE (EatNDeal's own
        // earn page) and a perfectly valid scope. The truthiness test rejected
        // it with "Restaurant is required.", so no claim could EVER be submitted
        // from /earn?restaurant=eatndeal-marketplace.
        if (companyId == null || companyId === '') {
            return H.errorResponse(res, 'Restaurant is required.', 422);
        }
        if (!imageData && !videoUrl) {
            return H.errorResponse(res, 'Please attach a screenshot of your review.', 422);
        }

        // ONE claim per (customer, company, review_type) — the legacy rule.
        // webordering/views/site/review-type/index.php:374 sets
        // $isReviewSubmitted = !empty($review->id) and :490 drops the submit
        // button on it, so once a row exists — PENDING, APPROVED or REJECTED —
        // legacy offers no way to send another. Same here, and for the
        // marketplace (company 0) exactly as for a restaurant.
        // Checked BEFORE the upload: a rejected resubmit used to push a file to
        // the restaurant's server and only then get turned away.
        // Keyed by APP_ID like every other customer_review row — that is what
        // the restaurant's POS matches when it approves the claim and pays the
        // cashback (Helpers/customerLookup.appIdOf).
        const claimAppId = await customers.appIdOf(customerId);
        if (claimAppId === null) {
            H.log.error('review.submitCashback', 'customer ' + customerId + ' has no app_id');
            return H.errorResponse(res, MSG.server.oops, 500);
        }

        const existing = await db('customer_review')
            .where({ customer_id: claimAppId, company_id: companyId, review_type: reviewType })
            .first('id', 'admin_status', 'reject_reason');
        // DELIBERATE DEPARTURE FROM LEGACY (user request, 2026-07-21): legacy
        // blocked every resubmit on row existence alone, so one rejection killed
        // the claim for good. A REJECTED claim may now be sent again — the
        // customer fixes whatever the admin flagged in reject_reason and retries.
        // Approved and pending stay closed, as before.
        let retryOf = null;
        if (existing) {
            const st = Number(existing.admin_status);
            if (st === 1) {
                return H.errorResponse(res, 'You have already earned cashback for this review.', 409);
            }
            if (st !== 2) {
                return H.errorResponse(res,
                    'Your review is already submitted and is waiting for approval.', 409);
            }
            retryOf = existing.id;
        }

        // Route the screenshot: marketplace (company 0) → our server, a
        // restaurant → its own legacy server (Helpers/imageUpload). Video types
        // have no image; their URL is stored as-is.
        let photo = videoUrl;
        if (imageData) {
            const up = await imageUpload.saveImage({
                companyId, folder: 'reviews', fileName: imageName, base64: imageData,
            });
            if (!up.ok) { return H.errorResponse(res, up.message || 'Could not save your screenshot.', 502); }
            photo = up.ref;
        }

        // A retry REUSES the rejected row rather than inserting a second one:
        // the POS queue, and reviewTypesFor's claim lookup, both assume at most
        // one row per (customer, company, review_type). Clearing reject_reason
        // matters — otherwise the stale reason would render over a claim that
        // is pending again.
        if (retryOf !== null) {
            await db('customer_review').where('id', retryOf).update({
                notes:         notes || null,
                review_photo:  photo,
                admin_status:  0,
                reject_reason: null,
                review_date:   db.raw('CURRENT_DATE'),
                updated_at:    db.fn.now(),
                updated_by:    claimAppId,   // app_id, like created_by
            });
            return H.successResponse(res, {},
                'Thanks! Your review is submitted again for verification — cashback is added once the restaurant approves it.');
        }

        await db('customer_review').insert({
            uuid:         require('node:crypto').randomUUID(),
            company_id:   companyId,
            customer_id:  claimAppId,      // app_id — see above
            review_type:  reviewType,
            notes:        notes || null,
            review_photo: photo,
            admin_status: 0,
            review_date:  db.raw('CURRENT_DATE'),
            created_by:   claimAppId,
            created_at:   db.fn.now(),
        });
        return H.successResponse(res, {},
            'Thanks! Your review is submitted for verification — cashback is added once the restaurant approves it.');
    } catch (err) {
        H.log.error('review.submitCashback', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/*
 * ── EatNDeal's OWN reviews (the MARKETPLACE, company_id = 0) ────────
 *
 * A review OF EATNDEAL ITSELF, not of a restaurant. Same `review_rating`
 * table, scope 0 — which is why these never appear on any restaurant page:
 * every restaurant query filters `rr.company_id = c.id`, and no company has
 * id 0. This is the surface those reviews were missing.
 *
 * MODERATED: a customer's review lands with publish_online = 0 and is INVISIBLE
 * until the super admin publishes it (admin Reviews screen). That's the whole
 * point — anyone can write about the marketplace, so nothing goes public
 * unreviewed. An admin-written one (customer_id = 0) publishes immediately,
 * exactly like legacy's POS page.
 */
const MP_ID = 0;

// Page size for the /reviews list. 50 is also the ceiling — a caller asking for
// more gets 50, so the endpoint can't be turned into a bulk export.
const SITE_PAGE_MAX = 50;

/**
 * siteReviews — GET /marketplace/site-reviews
 * PUBLIC: the APPROVED (publish_online = 1) marketplace reviews + the average.
 *
 * Moderation is INVISIBLE to the author: a pending review is merged into the
 * list — and into the average / count — for the caller who wrote it, and for
 * nobody else. So the author sees their review sitting live exactly as they
 * left it, while everyone else keeps seeing only what the admin approved.
 * The merge is per-response and driven by customer_id, so it can never leak a
 * pending review to another caller.
 *
 * Paged with offset/limit (default and max both 50) — the page renders the
 * first batch and "View more" fetches the next. Mirrors Helpers/reviews
 * listForRestaurant: the same limit+1 trick to spot a next page without a
 * second count query, and the same `hasMore` name.
 * Type: READ.
 */
async function siteReviews(req, res) {
    try {
        const limit  = Math.max(1, Math.min(SITE_PAGE_MAX, Number(req.query.limit) || SITE_PAGE_MAX));
        const offset = Math.max(0, Number(req.query.offset) || 0);

        // limit+1 rows to detect a next page without a second count query.
        const paged = await db('review_rating')
            .where({ company_id: MP_ID, publish_online: 1 })
            .orderBy('created_at', 'desc')
            .offset(offset)
            .limit(limit + 1)
            .select('id', 'rating', 'review', 'review_reply', 'customer_name', 'customer_id', 'created_at');
        const hasMore = paged.length > limit;
        const rows    = hasMore ? paged.slice(0, limit) : paged;

        const agg = await db('review_rating')
            .where({ company_id: MP_ID, publish_online: 1 })
            .avg({ a: 'rating' }).count({ c: '*' }).first();

        // The CALLER's own review, when they say who they are. Read separately
        // so the public list never has to carry customer_id, which would let
        // anyone enumerate customer ids.
        let mine = null;
        let ownPending = null;                 // their review, still unapproved
        const cid = req.query && req.query.customer_id;
        if (cid) {
            const m = await db('review_rating')
                .where({ company_id: MP_ID, customer_id: cid })
                .first('id', 'rating', 'review', 'review_reply', 'customer_name',
                       'publish_online', 'created_at');
            if (m) {
                mine = {
                    id:        Number(m.id),
                    rating:    Number(m.rating) || 0,
                    review:    String(m.review || ''),
                    reply:     String(m.review_reply || ''),
                    published: Number(m.publish_online) === 1,   // false = awaiting approval
                };
                if (!mine.published) { ownPending = m; }
            }
        }

        const list = rows.map((r) => ({
            id:      Number(r.id),
            rating:  Number(r.rating) || 0,
            review:  String(r.review || ''),
            reply:   String(r.review_reply || ''),
            name:    String(r.customer_name || '').trim() || 'Customer',
            created_at: r.created_at,
        }));

        const approvedAvg   = Number(agg && agg.a) || 0;
        const approvedCount = Number(agg && agg.c) || 0;
        let average = Math.round(approvedAvg * 10) / 10;
        let total   = approvedCount;

        // Author's own pending review — counted as if it were published. The
        // count/average move with it: showing the review but leaving the header
        // on "1 review" is exactly the tell we're avoiding. These two are
        // page-independent, so they're adjusted on EVERY page.
        if (ownPending) {
            const ownRating = Number(ownPending.rating) || 0;
            total   = approvedCount + 1;
            average = Math.round(((approvedAvg * approvedCount + ownRating) / total) * 10) / 10;

            // …but the row itself joins the FIRST page only. It isn't part of
            // the paged query, so merging it on every page would repeat it down
            // the list on each "View more".
            if (offset === 0) {
                list.push({
                    id:      Number(ownPending.id),
                    rating:  ownRating,
                    review:  String(ownPending.review || ''),
                    reply:   String(ownPending.review_reply || ''),
                    name:    String(ownPending.customer_name || '').trim() || 'Customer',
                    created_at: ownPending.created_at,
                });
                list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            }
        }

        // nextOffset counts APPROVED rows only — `list` may carry the author's
        // merged pending review, so its length would skip a real review here.
        return H.successResponse(res, {
            reviews: list, average, total, mine,
            hasMore, nextOffset: offset + rows.length,
        });
    } catch (err) {
        H.log.error('review.siteReviews', err && err.message);
        return H.errorResponse(res, 'Could not load the reviews.', 500);
    }
}

/**
 * submitSiteReview — POST /customer/site-review  { customer_id, rating, review }
 *
 * The customer reviews EATNDEAL. Saved PENDING (publish_online = 0) — it shows
 * publicly only after the super admin approves it.
 * One review per customer: a second submit EDITS the first and sends it back
 * for approval (an edited review must not keep an old approval).
 * Type: WRITE.
 */
async function submitSiteReview(req, res) {
    try {
        const customerId = req.body.customer_id;
        const rating     = Number(req.body.rating);
        const review     = String(req.body.review || '').trim().slice(0, 2000);

        // NB loadMarketplaceCustomer returns { row } (or { error }) — NOT
        // { customer }. Destructuring the wrong key silently left every review
        // signed "Customer".
        const { error, row: customer } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }
        if (!review) { return H.errorResponse(res, 'Please write your review.', 422); }
        if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
            return H.errorResponse(res, 'Please choose a rating between 1 and 5 stars.', 422);
        }

        const name = [customer && customer.firstname, customer && customer.lastname]
            .filter(Boolean).join(' ').trim() || 'Customer';

        const existing = await db('review_rating')
            .where({ company_id: MP_ID, customer_id: customerId })
            .first('id');

        if (existing) {
            await db('review_rating').where({ id: existing.id }).update({
                rating,
                review,
                customer_name:  name.slice(0, 191),
                publish_online: 0,           // edited → back to pending
                updated_by:     customerId,
                updated_at:     db.fn.now(),
            });
        } else {
            await db('review_rating').insert({
                branch_id:      0,
                company_id:     MP_ID,
                customer_id:    customerId,   // a REAL customer.id — see Helpers/loyalty
                order_id:       0,            // reviewing the marketplace, not an order
                rating,
                review,
                customer_name:  name.slice(0, 191),
                publish_online: 0,            // PENDING — invisible until approved
                is_verified:    1,
                is_marketplace: 1,            // marketplace's own review (company_id 0)
                created_by:     customerId,
                updated_by:     customerId,
                created_at:     db.fn.now(),
                updated_at:     db.fn.now(),
            });
        }

        // The review IS pending, but we don't say so: the author sees it live on
        // their own /reviews (siteReviews merges it back for them), so the copy
        // matches what they're about to see. Moderation stays a back-office
        // concern. `pending` is still returned for api callers that care.
        return H.successResponse(res, { pending: true },
            'Thanks! Your review has been posted.');
    } catch (err) {
        H.log.error('review.submitSiteReview', err && err.message);
        return H.errorResponse(res, 'Could not save your review.', 500);
    }
}

module.exports = { submit, listForRestaurant, submitCashbackReview, siteReviews, submitSiteReview };
