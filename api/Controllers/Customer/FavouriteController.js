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
const { db }    = require('../../config/db');

const TABLE          = 'mp_customer_favourite_restaurant';
const STATUS_ACTIVE  = 1;
const STATUS_REMOVED = 2;

/**
 * loadActiveCustomer
 *
 * What:  Same guard used by AddressController — confirms the caller is a
 *        marketplace customer (company_id IS NULL) and isn't disabled or
 *        banned. Returns { row } or { error: {msg,status} }.
 * Type:  READ.
 */
async function loadActiveCustomer(customerId) {
    const row = await db('customer')
        .where({ id: customerId })
        .whereNull('company_id')
        .first();
    if (!row) { return { error: { msg: MSG.resource.notFound, status: 404 } }; }

    const state = customers.classify(row);
    if (state === 'deleted' || state === 'disabled') {
        return { error: { msg: MSG.auth.accountDisabled, status: 403 } };
    }
    if (state === 'banned') {
        return { error: { msg: MSG.auth.accountBanned, status: 403 } };
    }
    return { row };
}

function numOrNull(v) {
    if (v == null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

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

        const { error } = await loadActiveCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // Newest hearts first. Joined to the canonical company/branch
        // pair (lowest branch.id per company — same as RestaurantsController).
        const rows = await db
            .from(TABLE + ' as f')
            .innerJoin('company as c', 'c.id', 'f.company_id')
            .innerJoin('branch as b',  'b.company_id', 'c.id')
            .where('f.customer_id', customerId)
            .andWhere('f.status', STATUS_ACTIVE)
            .andWhere('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .whereNull('c.deleted_at')
            .andWhere('b.status', '<>', '2')
            .select(
                'f.id as fav_id', 'f.created_at as fav_at',
                'c.id as company_id', 'c.business_name', 'c.domain_name', 'c.business_category',
                'b.id as branch_id', 'b.name as branch_name', 'b.trading_name as branch_trading_name',
                'b.banner_image', 'b.business_image',
                'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
                'b.start_time', 'b.end_time', 'b.open_as_usual', 'b.closed_until',
                'b.delivery_waiting_time',
                'b.pickup_waiting_time',
            )
            .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }, { column: 'f.id', order: 'desc' }]);

        // De-dupe: one canonical card per company even if two branches
        // somehow joined.
        const seen = new Set();
        const uniq = rows.filter(r => {
            if (seen.has(r.company_id)) { return false; }
            seen.add(r.company_id); return true;
        });

        const favourites = uniq.map(r => {
            const name = String(r.business_name || r.branch_trading_name || r.branch_name || '').trim();
            const km   = distance.kmBetween(lat, lng, r.branch_lat, r.branch_lng);
            // Legacy parity: time from merchant-set branch column only.
            // No distance fallback — 0/unset stays 0/null.
            const wMins  = M.deliveryMinutesFromWaiting(r.delivery_waiting_time);
            const pkMins = M.deliveryMinutesFromWaiting(r.pickup_waiting_time);
            return {
                id:              String(r.company_id),
                branchId:        r.branch_id ? String(r.branch_id) : null,
                slug:            r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
                name,
                cuisines:        M.cuisinesFor({ business_category: r.business_category }),
                rating:          4.4,
                isOpen:          M.isOpenNow(r),
                tint:            M.tintFor(r.company_id),
                initial:         M.initialFor(name),
                distanceKm:      km != null ? km : null,
                deliveryMinutes: wMins  != null ? (wMins  + ' min') : null,
                pickupMinutes:   pkMins != null ? (pkMins + ' min') : null,
                image:           M.yiiImageUrl('banner', r.company_id, r.banner_image)
                                  || M.yiiImageUrl('logo', r.company_id, r.business_image)
                                  || null,
                isFavourite:     true,
            };
        });

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

        const { error } = await loadActiveCustomer(customerId);
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
