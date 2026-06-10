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
const { db }    = require('../../config/db');

/**
 * submit
 *
 * What:  Create or update the customer's review for one of THEIR orders.
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

        const custName = [guard.row.firstname, guard.row.lastname].filter(Boolean).join(' ').trim();

        const base = {
            rating:         Number(rating),
            review:         (review || '').trim() || null,
            publish_online: 1,
            is_verified:    1,
            customer_name:  custName || null,
            updated_at:     db.fn.now(),
            updated_by:     customer_id,
        };
        // Photo only when the column exists (m260604_170000). Empty string
        // clears it; undefined leaves whatever was there on an edit.
        if (photo !== undefined && (await reviews.hasPhotoCol())) {
            base.review_photo = photo || null;
        }

        const existing = await db(reviews.TABLE)
            .where({ order_id, customer_id })
            .orderBy('id', 'desc')
            .first('id');

        if (existing) {
            await db(reviews.TABLE).where({ id: existing.id }).update(base);
        } else {
            await db(reviews.TABLE).insert(Object.assign({}, base, {
                branch_id:   order.branch_id,
                company_id:  order.company_id,
                customer_id,
                order_id,
                created_at:  db.fn.now(),
                created_by:  customer_id,
            }));
            // FIRST review = the legacy loyalty 'review' cashback trigger
            // (loyalty_review_cashback_rule). Not built in Node yet.
            // TODO(loyalty): CustomerRewards.event({ customerId, event: 'review' })
        }

        const fresh = await reviews.forOrder(order_id, customer_id);
        return H.successResponse(res, { review: reviews.publicView(fresh) }, MSG.resource.updated);
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
 *        Upsert per (customer, company, review_type).
 * Type:  WRITE.
 */
async function submitCashbackReview(req, res) {
    try {
        const customerId = req.body.customer_id;
        const companyId  = req.body.company_id;
        const reviewType = Number(req.body.review_type) || 1;
        const notes      = String(req.body.notes || '').trim().slice(0, 1000);
        const photo      = String(req.body.photo || '').trim();

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }
        if (!companyId) { return H.errorResponse(res, 'Restaurant is required.', 422); }
        if (!photo) { return H.errorResponse(res, 'Please attach a screenshot of your review.', 422); }

        const existing = await db('customer_review')
            .where({ customer_id: customerId, company_id: companyId, review_type: reviewType })
            .first('id', 'admin_status');
        if (existing) {
            if (Number(existing.admin_status) === 1) {
                return H.errorResponse(res, 'You have already earned cashback for this review.', 409);
            }
            await db('customer_review').where({ id: existing.id }).update({
                notes: notes || null, review_photo: photo, admin_status: 0, reject_reason: null,
                updated_by: customerId, updated_at: db.fn.now(),
            });
        } else {
            await db('customer_review').insert({
                uuid:         require('node:crypto').randomUUID(),
                company_id:   companyId,
                customer_id:  customerId,
                review_type:  reviewType,
                notes:        notes || null,
                review_photo: photo,
                admin_status: 0,
                review_date:  db.raw('CURRENT_DATE'),
                created_by:   customerId,
                created_at:   db.fn.now(),
            });
        }
        return H.successResponse(res, {},
            'Thanks! Your review is submitted for verification — cashback is added once the restaurant approves it.');
    } catch (err) {
        H.log.error('review.submitCashback', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { submit, listForRestaurant, submitCashbackReview };
