'use strict';

/*
 * Controllers/Customer/OrderAgainController.js
 *
 * What:  The signed-in customer's "Order again" rail — the restaurants they
 *        most recently ordered from (distinct company, newest order first,
 *        TOP 10). Powers GET /api/v1/customer/order-again.
 * Why:   Zomato/Uber-style reorder shortcut on the home feed. Mirrors
 *        FavouriteController.list (same card shape + open/closed + time
 *        labels) but the SOURCE is the `orders` table, not the favourites
 *        table — newest order wins, cancelled/void/refunded orders excluded.
 * Used:  api/Routes/index.js — GET /customer/order-again.
 */

const H          = require('../../Helpers/helper');
const MSG        = require('../../Helpers/messages');
const customers  = require('../../Helpers/customerLookup');
const M          = require('../../Helpers/marketplace');
const OrderTime  = require('../../Helpers/orderTime');
const StoreHours = require('../../Helpers/storeHours');
const { db }     = require('../../config/db');

const numOrNull = customers.coerceNum;
const FAV_TABLE = 'mp_customer_favourite_restaurant';
// orders.order_status (VARCHAR) codes that DON'T count as "ordered from":
// 1 = refund, 2 = cancelled, 9 = void. Everything else (placed/active/'' done).
const SKIP_STATUS = ['1', '2', '9'];
const MAX = 10;

/** list — GET /customer/order-again?customer_id=&lat=&lng= */
async function list(req, res) {
    try {
        const customerId = req.query.customer_id;
        const lat = numOrNull(req.query.lat);
        const lng = numOrNull(req.query.lng);

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // Top-N distinct restaurants this customer last ordered from, newest first.
        const recent = await db('orders')
            .where({ user_id: customerId, is_marketplace: 1 })
            .whereNotIn('order_status', SKIP_STATUS)
            .whereNotNull('company_id')
            .groupBy('company_id')
            .select('company_id')
            .max('created_at as last_at')
            .orderBy('last_at', 'desc')
            .limit(MAX);

        const companyIds = recent.map((r) => r.company_id);
        if (!companyIds.length) { return H.successResponse(res, { restaurants: [] }); }
        // Recency rank → re-sort the cards (the build below orders by company id).
        const rank = new Map(companyIds.map((id, i) => [String(id), i]));
        const rankOf = (id) => (rank.has(String(id)) ? rank.get(String(id)) : 999);

        // Same canonical company/branch join + columns the favourites rail uses.
        const rows = await db.from('company as c')
            .innerJoin('branch as b', 'b.company_id', 'c.id')
            .whereIn('c.id', companyIds)
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            .select(
                'c.id as company_id', 'c.business_name', 'c.domain_name', 'c.business_category',
                'b.id as branch_id', 'b.name as branch_name', 'b.trading_name as branch_trading_name',
                'b.banner_image', 'b.business_image',
                'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
                'b.start_time', 'b.end_time', 'b.open_as_usual', 'b.closed_until',
                'b.closed', 'b.closed_reopen_date', 'b.clossed_repoen_time', 'b.clossed_text',
                'b.closed_for', 'b.closed_for_time',
                'b.show_delivery_option', 'b.show_delivery_option_tab', 'b.delivery_closed_util_date',
                'b.show_pickup_option', 'b.show_pickup_option_tab', 'b.pickup_closed_util_date',
                'b.delivery_waiting_time', 'b.pickup_waiting_time',
                M.avgRatingSubq(db, 'c'),
            )
            .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }]);

        // One canonical card per company (lowest branch.id wins).
        const seen = new Set();
        const uniq = rows.filter((r) => {
            if (seen.has(r.company_id)) { return false; }
            seen.add(r.company_id); return true;
        });

        // Which of these are also hearted? → correct heart state on each card.
        let favSet = new Set();
        try {
            const favRows = await db(FAV_TABLE).where({ customer_id: customerId, status: 1 })
                .whereIn('company_id', companyIds).pluck('company_id');
            favSet = new Set(favRows.map(String));
        } catch (e) { H.log.error('orderAgain.favSet', e && e.message); /* degrade to empty hearts */ }

        const timesByBranch = await OrderTime.computeForBranches(uniq);
        const availByBranch = await StoreHours.availabilityForBranches(uniq);

        const cards = uniq.map((r) => {
            const card = M.toRestaurantCard(r, {
                lat, lng,
                times:       timesByBranch[String(r.branch_id)],
                isFavourite: favSet.has(String(r.company_id)),
            });
            const av = availByBranch.get(String(r.branch_id));
            if (av) { card.isOpen = av.isOpen; card.openStatus = av.status; card.hours = av.hours; card.opensAt = av.reopenAt; }
            return card;
        });
        // Re-sort to recency order (newest order first).
        cards.sort((a, b) => rankOf(a.id) - rankOf(b.id));

        return H.successResponse(res, { restaurants: cards });
    } catch (err) {
        H.log.error('orderAgain.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list };
