'use strict';

/*
 * Helpers/orderTime.js
 *
 * What:  EXACT port of the legacy webordering `Commonquery::getAdvancedTime`
 *        + `Commonquery::displayRealOrderTime` logic for computing a
 *        restaurant's delivery / pickup time. The full formula is:
 *
 *            total_minutes  =  baseTime (branch.delivery_waiting_time)
 *                           +  valueTime  (advance_order_waiting_time order_type=1)
 *                           +  volumeTime (advance_order_waiting_time order_type=2)
 *
 *        For pickup the only difference is the column (`pickup_waiting_time`)
 *        and the service_type code passed to the threshold table.
 *
 * Why:   The list / detail pages need only the baseTime (we don't have a
 *        cart yet). Checkout / order-placement code needs the full sum.
 *        Putting it in one helper means the cart screen, the order tracker
 *        and any future "ETA" surface all read from the same well, exactly
 *        the way the legacy POS does.
 *
 * Service-type codes (legacy convention):
 *   advance_order_waiting_time.service_type
 *     1  → pickup
 *     4  → delivery
 *   (orders.serve_type uses 2/3 — converted at order placement; this
 *    helper takes the threshold-table values directly.)
 *
 * Active rules:
 *   • baseTime    — parsed from `branch.delivery_waiting_time` /
 *                   `pickup_waiting_time` via marketplace.deliveryMinutesFromWaiting
 *                   (matches legacy displayRealOrderTime's SS + MM×60
 *                   reading of strtotime output).
 *   • valueTime   — first row of `advance_order_waiting_time` where
 *                   status=1, order_type=1, service_type matches, and
 *                   the customer's cart subtotal sits in [min, max].
 *   • volumeTime  — first row where order_type=2 and TODAY'S active
 *                   order count on the branch sits in [min, max].
 *                   "Active" = orders.status IN (4, 5, 6, 10) AND
 *                   date(created_at) = today.
 *
 * Used:  Cart / checkout (Phase-2). The marketplace list+detail
 *        endpoints currently surface only baseTime (no cart context),
 *        but they re-use the same parser via marketplace.js so the
 *        format handling is shared.
 */

const { db } = require('../config/db');
const M      = require('./marketplace');

// Service-type code on the threshold table.
const SVC_PICKUP   = 1;
const SVC_DELIVERY = 4;

// orders.status values that legacy considers "still active" when counting
// volume. From OrderController + StatusList in legacy.
const ACTIVE_ORDER_STATUSES = [4, 5, 6, 10];

/**
 * baseMinutes
 *
 * What:  Reads the merchant cooking baseline from the branch row.
 *        Returns whole minutes (number) or 0 when unset.
 * Why:   Same parser as the list/detail pages so both surfaces show
 *        the same number for a given branch.
 * Type:  READ (pure).
 */
function baseMinutes(branchRow, mode) {
    if (!branchRow) { return 0; }
    const col = mode === 'pickup' ? 'pickup_waiting_time' : 'delivery_waiting_time';
    const mins = M.deliveryMinutesFromWaiting(branchRow[col]);
    return mins != null && mins > 0 ? mins : 0;
}

/**
 * valueTime
 *
 * What:  Order-VALUE based extra minutes. Looks up a threshold row in
 *        `advance_order_waiting_time` where:
 *          status = 1
 *          order_type = 1   (value rule)
 *          service_type = <pickup|delivery>
 *          branch + company match
 *          min_subtotal_amount ≤ cartSubtotal ≤ max_subtotal_amount
 *        Returns `time_for_new_order_min` of the first match, else 0.
 * Type:  READ.
 */
async function valueTime(branchId, companyId, cartSubtotal, mode) {
    const svc = mode === 'pickup' ? SVC_PICKUP : SVC_DELIVERY;
    const amount = Number(cartSubtotal);
    if (!branchId || !companyId || !Number.isFinite(amount)) { return 0; }

    const row = await db('advance_order_waiting_time')
        .where({ branch_id: branchId, company_id: companyId, status: 1, order_type: 1, service_type: svc })
        .andWhereRaw('min_subtotal_amount <= ?', [amount])
        .andWhereRaw('max_subtotal_amount >= ?', [amount])
        .orderBy('id', 'asc')
        .first('time_for_new_order_min');
    return row ? Number(row.time_for_new_order_min) || 0 : 0;
}

/**
 * volumeTime
 *
 * What:  Order-VOLUME based extra minutes. Counts active orders on the
 *        branch TODAY (status in 4/5/6/10), then looks up a threshold row
 *        where:
 *          status = 1
 *          order_type = 2   (volume rule)
 *          service_type = <pickup|delivery>
 *          branch + company match
 *          min_subtotal_amount ≤ activeCount ≤ max_subtotal_amount
 *        (legacy reuses the min/max columns for the volume range too —
 *         field name is misleading but the data model is the same.)
 *        Returns `time_for_new_order_min` of the first match, else 0.
 * Type:  READ.
 */
async function volumeTime(branchId, companyId, mode) {
    const svc = mode === 'pickup' ? SVC_PICKUP : SVC_DELIVERY;
    if (!branchId || !companyId) { return 0; }

    const cntRow = await db('orders')
        .where({ branch_id: branchId, company_id: companyId })
        .whereIn('status', ACTIVE_ORDER_STATUSES)
        .andWhereRaw('DATE(created_at) = CURRENT_DATE')
        .count('* as c').first();
    const count = Number(cntRow && cntRow.c || 0);

    const row = await db('advance_order_waiting_time')
        .where({ branch_id: branchId, company_id: companyId, status: 1, order_type: 2, service_type: svc })
        .andWhereRaw('min_subtotal_amount <= ?', [count])
        .andWhereRaw('max_subtotal_amount >= ?', [count])
        .orderBy('id', 'asc')
        .first('time_for_new_order_min');
    return row ? Number(row.time_for_new_order_min) || 0 : 0;
}

/**
 * advancedTime
 *
 * What:  Sum of valueTime + volumeTime — what the legacy
 *        getAdvancedTime() returns and stores in
 *        `orders.advanced_order_waiting_time_minute` at order placement.
 *        cartSubtotal can be null when we're querying volume-only.
 * Type:  READ.
 */
async function advancedTime(branchId, companyId, cartSubtotal, mode) {
    const [vt, ot] = await Promise.all([
        valueTime(branchId, companyId, cartSubtotal, mode),
        volumeTime(branchId, companyId, mode),
    ]);
    return Number(vt) + Number(ot);
}

/**
 * totalMinutes
 *
 * What:  Final legacy formula — baseTime + valueTime + volumeTime in one
 *        call. Hand it the branch row + cart total + mode and it returns
 *        the integer-minutes total the customer would see at checkout.
 * Type:  READ.
 */
async function totalMinutes(branchRow, cartSubtotal, mode) {
    if (!branchRow) { return 0; }
    const branchId  = branchRow.branch_id || branchRow.id;
    const companyId = branchRow.company_id;
    const base = baseMinutes(branchRow, mode);
    const adv  = await advancedTime(branchId, companyId, cartSubtotal, mode);
    return base + adv;
}

/**
 * formatMinutes
 *
 * What:  Legacy display format — "N mins" when total < 60, else
 *        "H hours" (Math.floor). Matches webordering's formatWaitingTime.
 * Type:  READ (pure).
 */
function formatMinutes(mins) {
    const n = Number(mins) || 0;
    if (n <= 0) { return null; }
    if (n >= 60) { return Math.floor(n / 60) + ' hours'; }
    return n + ' mins';
}

/**
 * maxAdvancedExtraByBranch
 *
 * What:  Batched lookup — given a list of branch ids, returns a map
 *          { [branchId]: { delivery: number, pickup: number } }
 *        where each value is the SUM of `time_for_new_order_min` across
 *        every active threshold row on that branch for that service.
 *        Listing pages don't have a cart total or a real-time volume
 *        count, so they can't pick the EXACT row that would apply — but
 *        they CAN preview the maximum possible extra so the customer
 *        sees a range like "20-50 min".
 * Type:  READ.
 */
async function maxAdvancedExtraByBranch(branchIds) {
    const out = {};
    if (!Array.isArray(branchIds) || !branchIds.length) { return out; }
    const ids = Array.from(new Set(branchIds.map(String).filter(Boolean)));
    if (!ids.length) { return out; }

    const rows = await db('advance_order_waiting_time')
        .whereIn('branch_id', ids)
        .andWhere('status', 1)
        .select('branch_id', 'service_type', 'time_for_new_order_min');

    rows.forEach((r) => {
        const bid  = String(r.branch_id);
        const mins = Number(r.time_for_new_order_min) || 0;
        if (!out[bid]) { out[bid] = { delivery: 0, pickup: 0 }; }
        const svc = Number(r.service_type);
        if      (svc === SVC_DELIVERY) { out[bid].delivery += mins; }
        else if (svc === SVC_PICKUP)   { out[bid].pickup   += mins; }
    });
    return out;
}

/**
 * formatRange
 *
 * What:  Builds the customer-facing label from a (base, extra) pair.
 *        Returns the SINGLE upper-bound figure (base + extra) — the
 *        most pessimistic-but-realistic wait time given the merchant's
 *        configured advance rules. Crosses into hours once the total
 *        reaches 60 min so the chip reads naturally instead of "75 min".
 *
 *          base = 20, extra =  0   →  "20 min"
 *          base = 20, extra = 30   →  "50 min"
 *          base = 30, extra = 30   →  "1 hour"
 *          base = 30, extra = 45   →  "1h 15m"
 *          base = 60, extra = 60   →  "2 hours"
 *          base =  0, extra =  0   →  null  (chip hides)
 * Type:  READ (pure).
 */
function formatRange(base, extra) {
    const b = Number(base) || 0;
    const e = Number(extra) || 0;
    const total = b + e;
    if (total <= 0) { return null; }
    if (total < 60) { return total + ' min'; }
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (m === 0) { return h + (h === 1 ? ' hour' : ' hours'); }
    return h + 'h ' + m + 'm';
}

/**
 * computeForBranches
 *
 * What:  THE one function the marketplace surfaces (list / detail /
 *        favourites / dishes) call to get formatted delivery + pickup
 *        time labels for every branch in one round trip. Avoids each
 *        controller re-doing the parse + advance lookup + formatRange
 *        dance.
 *
 *        Input:  array of rows that contain at least
 *                  { branch_id, delivery_waiting_time, pickup_waiting_time }
 *                (the rows the controllers already SELECT for cards).
 *        Output: { [branchId]: { delivery: "20-50 min" | null,
 *                                pickup:   "30-60 min" | null } }
 *
 *        For a SINGLE branch (the detail page) just pass [row]; the
 *        result has one entry. For listings pass the full array; one
 *        SQL round-trip covers the whole page.
 *
 * Type:  READ.
 */
async function computeForBranches(branchRows) {
    const out = {};
    if (!Array.isArray(branchRows) || !branchRows.length) { return out; }
    const ids = branchRows.map(r => r && r.branch_id).filter(Boolean);
    const adv = await maxAdvancedExtraByBranch(ids);
    branchRows.forEach((r) => {
        if (!r || !r.branch_id) { return; }
        const bid    = String(r.branch_id);
        const ext    = adv[bid] || { delivery: 0, pickup: 0 };
        const wMins  = M.deliveryMinutesFromWaiting(r.delivery_waiting_time);
        const pkMins = M.deliveryMinutesFromWaiting(r.pickup_waiting_time);
        out[bid] = {
            delivery: formatRange(wMins, ext.delivery),
            pickup:   formatRange(pkMins, ext.pickup),
        };
    });
    return out;
}

module.exports = {
    SVC_PICKUP,
    SVC_DELIVERY,
    baseMinutes,
    valueTime,
    volumeTime,
    advancedTime,
    totalMinutes,
    formatMinutes,
    maxAdvancedExtraByBranch,
    formatRange,
    computeForBranches,
};
