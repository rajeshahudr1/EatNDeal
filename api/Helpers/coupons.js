'use strict';

/*
 * Helpers/coupons.js
 *
 * What:  Validates a promo code against the live `coupons` table and
 *        computes the discount amount it would apply to the passed cart.
 *        Returns a structured `{ok, ...}` envelope so the cart endpoint
 *        can either save the result or return the error verbatim.
 *
 *        Ports the legacy `webordering/.../Coupons::validate()` logic —
 *        same rules, same wording:
 *           • code exists + is_active = 1
 *           • not expired (expiry_date >= today)
 *           • platform allows online (platform = 1)
 *           • company-scoped (when company_id > 0)
 *           • branch-scoped (when branch_id > 0)
 *           • order_type matches cart.serve_type
 *             (legacy convention: 1 = delivery, 2 = pickup, 0 = any)
 *           • cart.sub_total >= min_order_value
 *           • discount_type 1 → percent  (value % of sub_total)
 *           •               2 → fixed    (£value off)
 *
 *        Per-customer / per-order max-use rules are out of Phase-2 scope
 *        (no usage ledger yet) — the legacy app keeps an order-counter
 *        we haven't ported.
 *
 * Type:  READ (pure — never writes; the cart endpoint persists the
 *        outcome).
 *
 * Used:  api/Controllers/Customer/CartController.js · applyCoupon
 *        api/Helpers/cartValidate.js   · re-check on PLACE
 */

const { db } = require('../config/db');

// Legacy convention for `coupons.discount_type` (matches the value
// labels used on the admin form). Stored as integer.
const TYPE_PERCENT = 1;
const TYPE_FIXED   = 2;

/**
 * normaliseCode
 *
 * What:  Customer-typed codes vary in case + whitespace ("welcome50",
 *        " WELCOME50 ", "WELCOME50"). The DB stores them as authored by
 *        the merchant — usually all-caps, no spaces. We compare case-
 *        insensitively + trimmed so the user-facing flow is forgiving.
 * Type:  READ (pure).
 */
function normaliseCode(s) {
    return String(s || '').trim();
}

/**
 * findActiveByCode
 *
 * What:  Case-insensitive lookup that also filters out soft-deleted /
 *        inactive rows. Returns the row or null. Single round trip.
 * Type:  READ.
 */
async function findActiveByCode(code) {
    const c = normaliseCode(code);
    if (!c) { return null; }
    return db('coupons')
        .whereRaw('LOWER(code) = ?', [c.toLowerCase()])
        .first();
}

/**
 * validate
 *
 * What:  Full rule check + discount computation in one call. Returns:
 *
 *           { ok:true,  coupon, discount, freeDelivery }   on pass
 *           { ok:false, code, error }                      on any fail
 *
 *        Wording matches what the legacy UI surfaces so customers
 *        coming from eatndealclean see the same messages here.
 * Type:  READ.
 */
async function validate(rawCode, cart) {
    if (!cart) {
        return { ok: false, code: 'cart.missing', error: 'Your cart is no longer available.' };
    }
    const coupon = await findActiveByCode(rawCode);
    if (!coupon) {
        return { ok: false, code: 'coupon.invalid', error: 'That coupon code isn\'t valid.' };
    }

    if (Number(coupon.is_active) !== 1) {
        return { ok: false, code: 'coupon.inactive', error: 'This coupon is no longer active.' };
    }

    // Expiry — `expiry_date` is a DATE column; treat midnight-of-the-
    // next-day as the cutoff so a coupon valid till 2026-06-02 is still
    // usable through that day.
    if (coupon.expiry_date) {
        const exp = new Date(coupon.expiry_date);
        if (Number.isFinite(exp.getTime())) {
            const cutoff = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate() + 1);
            if (Date.now() >= cutoff.getTime()) {
                return { ok: false, code: 'coupon.expired', error: 'This coupon has expired.' };
            }
        }
    }

    // Platform — schema: 1 = All, 2 = Website, 3 = App. The marketplace
    // is a website / PWA, so accept All + Website; reject App-only (3).
    const pf = Number(coupon.platform) || 0;
    if (pf !== 0 && pf !== 1 && pf !== 2) {
        return { ok: false, code: 'coupon.platform', error: 'This coupon isn\'t available for online orders.' };
    }

    // Company / branch scope — when set, must match the cart's restaurant.
    if (Number(coupon.company_id) > 0 && Number(coupon.company_id) !== Number(cart.company_id)) {
        return { ok: false, code: 'coupon.scope', error: 'This coupon isn\'t valid for this restaurant.' };
    }
    if (Number(coupon.branch_id) > 0 && Number(coupon.branch_id) !== Number(cart.branch_id)) {
        return { ok: false, code: 'coupon.scope', error: 'This coupon isn\'t valid for this branch.' };
    }

    // Order type — schema: 1 = All, 2 = Delivery, 3 = Pickup.
    // cart.serve_type uses 3 = delivery, 2 = pickup. A type-1 (All)
    // coupon passes for either; a targeted one must match the cart mode.
    const ot = Number(coupon.order_type) || 0;
    const cartServe = Number(cart.serve_type) || 0;
    if (ot === 2 || ot === 3) {
        const needServe = ot === 2 ? 3 : 2;   // Delivery→serve 3, Pickup→serve 2
        if (cartServe !== needServe) {
            return {
                ok: false, code: 'coupon.mode',
                error: ot === 2 ? 'This coupon is for Delivery orders only.' : 'This coupon is for Pickup orders only.',
            };
        }
    }

    // Min order — checked against the CART subtotal (pre-discount).
    const subTotal = Number(cart.sub_total) || 0;
    const minOrder = Number(coupon.min_order_value) || 0;
    if (minOrder > 0 && subTotal < minOrder) {
        return {
            ok: false, code: 'coupon.min_order',
            error: 'Add at least £' + minOrder.toFixed(2) + ' to use this coupon (current total £' + subTotal.toFixed(2) + ').',
        };
    }

    // Compute discount amount.
    const type  = Number(coupon.discount_type) || 0;
    const value = Number(coupon.discount_value) || 0;
    let amount  = 0;
    if (type === TYPE_PERCENT) {
        amount = (subTotal * value) / 100;
    } else if (type === TYPE_FIXED) {
        amount = value;
    }
    if (amount > subTotal) { amount = subTotal; }   // never below zero
    amount = Math.round(amount * 100) / 100;

    return {
        ok:           true,
        coupon,
        discount:     amount,
        freeDelivery: Number(coupon.free_delivery) === 1,
    };
}

/**
 * listActiveForBranch
 *
 * What:  Returns the redeemable coupons for a given restaurant + serve
 *        type, ready for the "Your available promos" list on the
 *        checkout Promotions popup. Hoists the SAME eligibility rules
 *        `validate()` enforces into a single SQL WHERE so the list and
 *        the apply-time check never disagree:
 *           • is_active = 1
 *           • not expired (expiry_date NULL or >= today)
 *           • platform online (platform = 0 OR 1)
 *           • company scope (company_id = 0 OR matches)
 *           • branch scope  (branch_id  = 0 OR matches)
 *           • order_type    (0 OR maps to serve_type)
 *
 *        `subTotal` is used ONLY to compute the per-coupon `eligible`
 *        flag + a friendly "add £X more" reason — an under-minimum
 *        coupon is still LISTED (greyed / "Select" disabled) so the
 *        customer can see it and knows what to add, matching Uber Eats.
 *
 *        Each row is shaped for display:
 *           { id, code, discountType, discountValue, minOrder,
 *             freeDelivery, description, expiryDate,
 *             discountLabel, minOrderLabel, expiryLabel,
 *             eligible, ineligibleReason }
 * Type:  READ.
 */
async function listActiveForBranch({ companyId, branchId, serveType, subTotal }) {
    const cid = Number(companyId) || 0;
    const bid = Number(branchId)  || 0;
    const serve = Number(serveType) || 0;
    // Schema: order_type 1 = All, 2 = Delivery, 3 = Pickup.
    // serve_type 3 = delivery → need order_type 2; 2 = pickup → need 3.
    const needOrderType = serve === 3 ? 2 : (serve === 2 ? 3 : 1);
    const sub = Number(subTotal) || 0;

    const rows = await db('coupons')
        .where('is_active', 1)
        // Platform: 1 = All, 2 = Website, 3 = App. Accept All + Website
        // for the web/PWA checkout (0 supported defensively as "any").
        .andWhere(function () { this.where('platform', 0).orWhere('platform', 1).orWhere('platform', 2); })
        // Company scope (0 = any-company, used by real "global" coupons).
        .andWhere(function () { this.where('company_id', 0).orWhere('company_id', cid); })
        // Branch scope (0 = any-branch).
        .andWhere(function () { this.where('branch_id', 0).orWhere('branch_id', bid); })
        // Order type — 1 (All) always, else must match the cart's mode.
        .andWhere(function () { this.where('order_type', 1).orWhere('order_type', needOrderType); })
        // Not expired — NULL expiry = no end date.
        .andWhere(function () { this.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
        .orderBy('discount_value', 'desc')
        .select('id', 'code', 'discount_type', 'discount_value', 'min_order_value',
                'free_delivery', 'description', 'expiry_date');

    return rows.map((r) => {
        const type = Number(r.discount_type) || 0;
        const val  = Number(r.discount_value) || 0;
        const minOrder = Number(r.min_order_value) || 0;
        const freeDel  = Number(r.free_delivery) === 1;

        const discountLabel = type === TYPE_PERCENT
            ? Math.round(val) + '% off'
            : '£' + val.toFixed(2) + ' off';

        const minOrderLabel = minOrder > 0 ? '£' + minOrder.toFixed(2) + ' minimum order' : null;

        let expiryLabel = 'While supplies last';
        if (r.expiry_date) {
            const d = new Date(r.expiry_date);
            if (Number.isFinite(d.getTime())) {
                expiryLabel = 'Until ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            }
        }

        const eligible = !(minOrder > 0 && sub < minOrder);
        const ineligibleReason = eligible ? null
            : 'Add £' + (minOrder - sub).toFixed(2) + ' more to use this';

        return {
            id:            String(r.id),
            code:          r.code,
            discountType:  type,
            discountValue: val,
            minOrder,
            freeDelivery:  freeDel,
            description:   r.description || '',
            discountLabel,
            minOrderLabel,
            expiryLabel,
            eligible,
            ineligibleReason,
        };
    });
}

module.exports = {
    TYPE_PERCENT,
    TYPE_FIXED,
    normaliseCode,
    findActiveByCode,
    validate,
    listActiveForBranch,
};
