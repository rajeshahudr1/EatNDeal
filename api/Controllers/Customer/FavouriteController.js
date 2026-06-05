'use strict';

/*
 * Controllers/Customer/FavouriteController.js
 *
 * What:  The signed-in marketplace customer's saved (heart-icon)
 *        restaurants, backing:
 *
 *          GET  /api/v1/customer/favourites        — list saved restaurants
 *          POST /api/v1/customer/favourite/toggle  — heart / unheart one
 *
 *        Storage: `mp_customer_favourite_restaurant` (status=1 active,
 *        2 removed). Toggle flips the status of an existing row so the
 *        unique (customer_id, company_id) index never breaks on a re-heart.
 *
 * Auth:  Signed-in only. Phase-1 trust model — the web supplies
 *        customer_id from req.session.user.id; the API is not yet
 *        public-facing. The validator rejects requests with no id.
 *
 * Used:  api/Routes/index.js under /customer/favourite*.
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const M         = require('../../Helpers/marketplace');
const distance  = require('../../Helpers/distance');
const OrderTime = require('../../Helpers/orderTime');
const { db }    = require('../../config/db');

const TABLE          = 'mp_customer_favourite_restaurant';
const STATUS_ACTIVE  = 1;
const STATUS_REMOVED = 2;

// Marketplace-customer guard + numOrNull live in Helpers/customerLookup
// (loadMarketplaceCustomer, coerceNum) — kept DRY across all authed endpoints.
const numOrNull = customers.coerceNum;

/**
 * list
 *
 * What:  Returns the customer's active favourites as restaurant cards
 *        (same shape as /marketplace/restaurants so the existing card
 *        template can render them with no extra branching).
 * Type:  READ.
 *
 * Query: customer_id (required), lat?, lng?
 * Output: 200 envelope, data = { favourites: [...] }
 */
async function list(req, res) {
    try {
        const customerId = req.query.customer_id;
        const lat = numOrNull(req.query.lat);
        const lng = numOrNull(req.query.lng);

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // Newest hearts first. Joined to the canonical company/branch
        // pair (lowest branch.id per company — same as RestaurantsController).
        const rows = await db
            .from(TABLE + ' as f')
            .innerJoin('company as c', 'c.id', 'f.company_id')
            .innerJoin('branch as b',  'b.company_id', 'c.id')
            .where('f.customer_id', customerId)
            .andWhere('f.status', STATUS_ACTIVE)
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            .select(
                'f.id as fav_id', 'f.created_at as fav_at',
                'c.id as company_id', 'c.business_name', 'c.domain_name', 'c.business_category',
                'b.id as branch_id', 'b.name as branch_name', 'b.trading_name as branch_trading_name',
                'b.banner_image', 'b.business_image',
                'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
                'b.start_time', 'b.end_time', 'b.open_as_usual', 'b.closed_until',
                'b.delivery_waiting_time',
                'b.pickup_waiting_time',
                // Real average rating (NULL when no reviews) — toRestaurantCard
                // reads row.avg_rating; without this the favourites rail showed
                // no rating even for restaurants that have reviews.
                M.avgRatingSubq(db, 'c'),
            )
            .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }, { column: 'f.id', order: 'desc' }]);

        // De-dupe: one canonical card per company even if two branches
        // somehow joined.
        const seen = new Set();
        const uniq = rows.filter(r => {
            if (seen.has(r.company_id)) { return false; }
            seen.add(r.company_id); return true;
        });

        // Single batched call → per-branch formatted time labels.
        const timesByBranch = await OrderTime.computeForBranches(uniq);

        // Shared card mapper from Helpers/marketplace — same shape every
        // surface gets (home grid, account favourites tab, etc.).
        const favourites = uniq.map((r) => M.toRestaurantCard(r, {
            lat, lng,
            times:       timesByBranch[String(r.branch_id)],
            isFavourite: true,
        }));

        return H.successResponse(res, { favourites });
    } catch (err) {
        H.log.error('favourite.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * toggle
 *
 * What:  Flips the heart for one (customer, restaurant) pair.
 *         • No row yet           → INSERT status=1     → isFavourite=true
 *         • Existing status=2    → UPDATE status=1     → isFavourite=true
 *         • Existing status=1    → UPDATE status=2     → isFavourite=false
 *        The unique (customer_id, company_id) index means we never have
 *        two rows for the same pair, so the flip stays deterministic.
 * Type:  WRITE.
 *
 * Inputs: req.body — customer_id, company_id, branch_id?
 * Output: 200 envelope, data = { isFavourite: bool, companyId, count }
 */
async function toggle(req, res) {
    try {
        const customerId = req.body.customer_id;
        const companyId  = req.body.company_id;
        const branchId   = req.body.branch_id || null;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // The restaurant must exist + be marketplace-eligible — guards
        // against hearting a deleted / hidden company.
        const co = await db('company')
            .where({ id: companyId, is_marketplace: 1, is_active: 1 })
            .whereNull('deleted_at')
            .first();
        if (!co) { return H.errorResponse(res, 'Restaurant not found.', 404); }

        const existing = await db(TABLE)
            .where({ customer_id: customerId, company_id: companyId })
            .first();

        let isFavourite;
        if (!existing) {
            await db(TABLE).insert({
                customer_id: customerId,
                company_id:  companyId,
                branch_id:   branchId,
                status:      STATUS_ACTIVE,
                created_by:  customerId,
                updated_by:  customerId,
            });
            isFavourite = true;
        } else if (Number(existing.status) === STATUS_ACTIVE) {
            await db(TABLE).where({ id: existing.id }).update({
                status:     STATUS_REMOVED,
                updated_by: customerId,
                updated_at: db.fn.now(),
            });
            isFavourite = false;
        } else {
            await db(TABLE).where({ id: existing.id }).update({
                status:     STATUS_ACTIVE,
                branch_id:  branchId || existing.branch_id,
                updated_by: customerId,
                updated_at: db.fn.now(),
            });
            isFavourite = true;
        }

        // Live count for the header / account badge.
        const cntRow = await db(TABLE)
            .where({ customer_id: customerId, status: STATUS_ACTIVE })
            .count('* as c').first();
        const count = Number(cntRow && cntRow.c || 0);

        return H.successResponse(
            res,
            { isFavourite, companyId: String(companyId), count },
            isFavourite ? 'Added to favourites.' : 'Removed from favourites.',
        );
    } catch (err) {
        H.log.error('favourite.toggle', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * favouriteIdSet
 *
 * What:  Helper for other controllers — given a customer id and a list of
 *        company ids, returns a Set of the ones that customer has hearted.
 *        Used by RestaurantsController.list/detail to attach `isFavourite`
 *        to each card without a per-card subquery. Single round trip.
 * Type:  READ.
 */
async function favouriteIdSet(customerId, companyIds) {
    if (!customerId || !Array.isArray(companyIds) || !companyIds.length) {
        return new Set();
    }
    const rows = await db(TABLE)
        .where({ customer_id: customerId, status: STATUS_ACTIVE })
        .whereIn('company_id', companyIds)
        .select('company_id');
    return new Set(rows.map(r => String(r.company_id)));
}

module.exports = { list, toggle, favouriteIdSet };
