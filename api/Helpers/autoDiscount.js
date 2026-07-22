'use strict';

/*
 * Helpers/autoDiscount.js
 *
 * What:  Finds the BEST currently-valid auto-discount on the `discounts`
 *        table for a given cart and computes the amount it would shave
 *        off the cart. Caller (cart.recomputeTotals) writes the result
 *        into cart.discount_id + cart.discount.
 *
 *        Ports the legacy `Commonquery::GetDiscount()` rules:
 *          • `status = 1`
 *          • company_id matches the cart's restaurant
 *          • branch_id matches (or row is company-wide: branch_id NULL/0)
 *          • `start_date` / `end_date` window covers today
 *          • `start_time` / `end_time` covers now (when set; supports
 *            overnight windows)
 *          • `service_type` matches cart.serve_type (or row is any: 0)
 *          • `platform` allows online (0 or 1)
 *          • product-specific rows (product_id > 0) are skipped — those
 *            are line-level discounts handled by the line itself
 *          • cart.sub_total >= min_order_value
 *
 *        Discount math:
 *          • type 1 (percent) : (sub_total × value) / 100
 *          • type 2 (fixed)   : value
 *          • capped at max_discount when > 0
 *          • clamped at sub_total so discount can never exceed it
 *
 *        Returns the row that produces the LARGEST amount (best for
 *        the customer). Null when nothing matches.
 *
 * Auth:  Pure READ. Never writes. Never throws on data — only on real
 *        DB errors.
 *
 * Used:  api/Helpers/cart.recomputeTotals — auto-applies on every cart
 *        write, then clears itself when no rule matches anymore.
 */

const { db } = require('../config/db');
const M = require('./marketplace');   // matchDeliveryZone — postcode-zone restriction

// Service-type mapping — the EXACT legacy scheme from the POS discount form
// (backend/modules/pos/views/discounts/_form.php) and matched by
// Commonquery::validateAndApplyDiscount. discounts.service_type uses:
//   1 = Both      → applies to any fulfilment mode
//   2 = Delivery  → matches cart.serve_type = 3 (delivery)
//   3 = Pickup    → matches cart.serve_type = 2 (pickup)
// NOTE the numbers are CROSSED between the two columns: discount 2 (Delivery)
// pairs with cart serve_type 3, and discount 3 (Pickup) with serve_type 2.
// (Our earlier 0=any / direct-match reading never matched a "Both" discount,
// so free items/auto-discounts silently never applied.)
const SERVICE_BOTH = 1;

// Platform mapping (same form): 1 = Both, 2 = Website, 3 = EPOS. The
// marketplace IS the website, so an online cart matches Both or Website;
// an EPOS-only (3) discount never applies here.
const PLATFORM_BOTH    = 1;
const PLATFORM_WEBSITE = 2;

/**
 * parseClockMinutes
 *
 * What:  "HH:MM[:SS]" → minutes-of-day (0..1439). Null when unparseable.
 *        Used for the time-of-day window check.
 * Type:  READ (pure).
 */
function parseClockMinutes(t) {
    if (!t) { return null; }
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) { return null; }
    return (parseInt(m[1], 10) % 24) * 60 + parseInt(m[2], 10);
}

/**
 * inTimeWindow
 *
 * What:  True when "now" falls between start_time and end_time. Handles
 *        the overnight case (e.g. 18:00-02:00). Returns true when either
 *        end is missing — the rule is treated as "no time restriction".
 * Type:  READ (pure).
 */
function inTimeWindow(rule, now) {
    const start = parseClockMinutes(rule.start_time);
    const end   = parseClockMinutes(rule.end_time);
    if (start == null || end == null || start === end) { return true; }
    const m = now.getHours() * 60 + now.getMinutes();
    if (start < end) { return m >= start && m <= end; }
    return m >= start || m <= end;
}

/**
 * findBest
 *
 * What:  Returns { discount, amount } for the single best-matching row,
 *        or null when nothing applies. The cart row passed in must
 *        already have a fresh sub_total (recomputeTotals computes it
 *        BEFORE calling us).
 * Type:  READ.
 */
async function findBest(cart, branch) {
    if (!cart || !branch) { return null; }
    const subTotal = Number(cart.sub_total) || 0;
    if (subTotal <= 0) { return null; }
    const serve = Number(cart.serve_type) || 0;
    // Legacy only applies discounts to delivery (3) or pickup (2) carts — any
    // other serve_type blocks every rule (Commonquery: allowCoupon = false).
    if (serve !== 2 && serve !== 3) { return null; }
    // The discount service_type that a Both rule aside also matches: a delivery
    // cart (serve 3) matches Delivery discounts (service_type 2); a pickup cart
    // (serve 2) matches Pickup discounts (service_type 3). Numbers are crossed.
    const matchingServiceType = (serve === 3) ? 2 : 3;

    // One SQL pull for the candidate set — date window + status +
    // company + branch scope go in here. The lighter per-row filters
    // (time window, min order, product-specific) run application-side
    // so we can do them without N round trips.
    const candidates = await db('discounts')
        .where('status', 1)
        .andWhere('company_id', cart.company_id)
        .andWhere((qb) => {
            qb.whereNull('branch_id').orWhere('branch_id', 0).orWhere('branch_id', branch.id);
        })
        .andWhere((qb) => {
            qb.whereNull('start_date').orWhereRaw('start_date <= CURRENT_DATE');
        })
        .andWhere((qb) => {
            qb.whereNull('end_date').orWhereRaw('end_date >= CURRENT_DATE');
        })
        .andWhere((qb) => {
            // Both (1) applies to every mode; otherwise the crossed per-mode
            // match above (delivery cart → service_type 2, pickup → 3).
            qb.where('service_type', SERVICE_BOTH).orWhere('service_type', matchingServiceType);
        })
        .andWhere((qb) => {
            // The marketplace is the website: match Both (1) or Website (2).
            // EPOS-only (3) discounts never apply to an online cart.
            qb.where('platform', PLATFORM_BOTH).orWhere('platform', PLATFORM_WEBSITE);
        })
        .andWhere((qb) => {
            // Skip per-product rows — those are handled at the line level
            // (not yet wired). EXCEPT free-item rules (type 3), where
            // product_id is not a targeting filter at all: it names the GIFT
            // to add. Excluding them here meant no free-item rule could ever
            // be a candidate.
            qb.where('product_id', 0).orWhereNull('product_id')
              .orWhere('discount_type', 3);
        })
        // Legacy order — Commonquery::validateAndApplyDiscount:2373
        //   ->orderBy(['min_order_value' => SORT_DESC, 'id' => SORT_DESC])
        // It walks this list and RETURNS on the first rule the basket
        // qualifies for, so the rule with the HIGHEST min_order_value the
        // customer has reached wins (newest first on a tie).
        .orderBy([{ column: 'min_order_value', order: 'desc' }, { column: 'id', order: 'desc' }]);

    const now = new Date();
    // Legacy discount_type enum: 1 = %, 2 = fixed £, 3 = free item.
    const TYPE_FREE_ITEM = 3;
    // FIRST match wins — legacy returns as soon as a rule qualifies, walking
    // the list ordered by min_order_value DESC (see the query above). It does
    // NOT hunt for the biggest saving, and it does not prefer a money discount
    // over a free item: whichever rule sits highest in that order and the
    // basket qualifies for is the one applied.
    for (const d of candidates) {
        // Time-of-day window (when set).
        if (!inTimeWindow(d, now)) { continue; }
        // Min order.
        const min = Number(d.min_order_value) || 0;
        if (min > 0 && subTotal < min) { continue; }

        // Day-of-week restriction (discount_days). Legacy: only enforced when
        // the rule HAS day rows — then today must be one of them. day_of_week
        // uses ISO 1=Mon..7=Sun (legacy date('N')); JS getDay() is 0=Sun..6=Sat,
        // so Sunday (0) maps to 7.
        const dayRows = await db('discount_days').where({ discount_id: d.id }).select('day_of_week');
        if (dayRows.length) {
            const dow = (now.getDay() === 0) ? 7 : now.getDay();
            if (!dayRows.some((r) => Number(r.day_of_week) === dow)) { continue; }
        }

        // Delivery-zone restriction (discount_postcode). Legacy: when the
        // customer's postcode maps to a delivery-charge zone, the rule must
        // list that zone. Enforced only when the rule HAS postcode rows (same
        // optional-restriction shape as the day check — a rule with no zones is
        // unrestricted). Delivery orders only; pickup has no postcode.
        if (serve === 3 && cart.delivery_postcode) {
            const pcRows = await db('discount_postcode').where({ discount_id: d.id }).select('delivery_charge_id');
            if (pcRows.length) {
                const zrows = await db('store_delivery_charge_setup')
                    .where({ company_id: cart.company_id, branch_id: branch.id, status: 1 })
                    .select('id', 'postcode');
                const zone = M.matchDeliveryZone(String(cart.delivery_postcode).trim(), zrows);
                const zoneId = zone ? Number(zone.id) : 0;
                if (!zoneId || !pcRows.some((r) => Number(r.delivery_charge_id) === zoneId)) { continue; }
            }
        }

        // First-time-user only (discounts.first_time_user = 1): the rule is
        // barred once the customer has already placed an order that used THIS
        // discount. Legacy Commonquery checks orders by discount_id + user_id
        // (+ terminal); on marketplace the customer IS the user_id, so we match
        // on that alone. Guests (no user_id) always pass, exactly like legacy's
        // `!empty($orderData->user_id)` guard.
        if (Number(d.first_time_user) === 1 && Number(cart.user_id) > 0) {
            const prior = await db('orders')
                .where({ discount_id: d.id, user_id: cart.user_id })
                .first('id');
            if (prior) { continue; }                    // already used it → not eligible
        }

        const type  = Number(d.discount_type) || 0;
        const value = Number(d.discount_value) || 0;
        const maxD  = Number(d.max_discount) || 0;

        // Type 3 = FREE ITEM: nothing comes off the bill, a product goes into
        // the cart at £0 instead (legacy addFreeItem, granted by
        // checkFreeDiscount). product_id names the GIFT, not a target filter.
        if (type === TYPE_FREE_ITEM) {
            const pid = Number(d.product_id) || 0;
            if (pid <= 0) { continue; }                 // misconfigured — skip it
            return { discount: d, amount: 0, freeProductId: pid };
        }

        let amount = 0;
        if (type === 1)      { amount = (subTotal * value) / 100; }
        else if (type === 2) { amount = value; }

        if (maxD > 0 && amount > maxD) { amount = maxD; }
        if (amount > subTotal)         { amount = subTotal; }
        amount = Math.round(amount * 100) / 100;

        return { discount: d, amount: amount, freeProductId: 0 };
    }

    return null;
}

module.exports = {
    findBest,
};
