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

// Service-type mapping. discounts.service_type uses:
//   0 = any / unrestricted
//   1 = in-store     (we never match this on marketplace)
//   2 = pickup       (legacy convention — matches our cart.serve_type=2)
//   3 = delivery     (legacy convention — matches our cart.serve_type=3)
const SERVICE_ANY = 0;

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
            qb.where('service_type', SERVICE_ANY).orWhere('service_type', serve);
        })
        .andWhere((qb) => {
            // platform 0 = any, 1 = online. Anything else (2/3 = POS,
            // app-only, etc.) is rejected.
            qb.where('platform', 0).orWhere('platform', 1);
        })
        .andWhere((qb) => {
            // Skip per-product rows — those are handled at the line level
            // (not yet wired). EXCEPT free-item rules (type 3), where
            // product_id is not a targeting filter at all: it names the GIFT
            // to add. Excluding them here meant no free-item rule could ever
            // be a candidate.
            qb.where('product_id', 0).orWhereNull('product_id')
              .orWhere('discount_type', 3);
        });

    const now = new Date();
    // Legacy discount_type enum: 1 = %, 2 = fixed £, 3 = free item.
    const TYPE_FREE_ITEM = 3;
    let bestRow = null;
    let bestAmount = 0;
    let bestFree = null;      // first matching free-item rule, if any

    for (const d of candidates) {
        // Time-of-day window (when set).
        if (!inTimeWindow(d, now)) { continue; }
        // Min order.
        const min = Number(d.min_order_value) || 0;
        if (min > 0 && subTotal < min) { continue; }

        const type  = Number(d.discount_type) || 0;
        const value = Number(d.discount_value) || 0;
        const maxD  = Number(d.max_discount) || 0;

        // Type 3 = FREE ITEM: no money comes off the bill, a product is added
        // to the cart at £0 instead (legacy Commonquery::addFreeItem, granted
        // by checkFreeDiscount). It carries no discount_value, so it can never
        // win the "biggest amount" contest below — keep it aside and let it
        // apply only when no money discount beat it.
        if (type === TYPE_FREE_ITEM) {
            const pid = Number(d.product_id) || 0;
            if (pid > 0 && !bestFree) { bestFree = { discount: d, productId: pid }; }
            continue;
        }

        let amount  = 0;
        if (type === 1)      { amount = (subTotal * value) / 100; }
        else if (type === 2) { amount = value; }

        if (maxD > 0 && amount > maxD) { amount = maxD; }
        if (amount > subTotal)         { amount = subTotal; }
        amount = Math.round(amount * 100) / 100;

        if (amount > bestAmount) {
            bestRow    = d;
            bestAmount = amount;
        }
    }

    if (bestRow) { return { discount: bestRow, amount: bestAmount, freeProductId: 0 }; }
    if (bestFree) {
        // A free-item rule: zero money off, but tell the caller which product
        // to put in the basket.
        return { discount: bestFree.discount, amount: 0, freeProductId: bestFree.productId };
    }
    return null;
}

module.exports = {
    findBest,
};
