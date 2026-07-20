'use strict';

/*
 * Helpers/vouchers.js
 *
 * What:  Customer-specific reward-voucher validation for the marketplace
 *        checkout. A voucher lives in `customer_voucher`, is ISSUED to one
 *        customer at one branch/company, and discounts the order — either
 *        a percentage of sub-total or a fixed £ amount. Unlike a coupon
 *        (a public code anyone can type), a voucher is tied to the
 *        signed-in customer. A voucher and a coupon are mutually exclusive.
 *
 *        Mirrors the legacy common\constants\Vouchers::validate:
 *          • match by code + branch_id + company_id, and the customer — where
 *            "the customer" is EVERY account sharing their mobile number, not
 *            just the signed-in row (see validate; legacy matched the single
 *            customer_id, which hid a person's POS-issued vouchers from their
 *            marketplace account)
 *          • reject expired (voucher_expiry_date < today)
 *          • reject already-used single-use (used_once=1 AND is_used=1)
 *          • reject inactive (is_used != 0)
 *          • discount = percent ? sub_total × amount/100 : fixed amount,
 *            clamped to ≤ sub_total
 *
 * Type:  READ (validate) + WRITE (markUsed).
 * Used:  api/Controllers/Customer/CartController.applyVoucher
 */

const F = require('./format');

const { db } = require('../config/db');

// customer_voucher.voucher_type
const VOUCHER_TYPE_PERCENT = 1;
const VOUCHER_TYPE_FIXED   = 2;
// customer_voucher.is_used (0 = active/unused, 1 = used)
const IS_USED_ACTIVE = 0;
const IS_USED_USED   = 1;

function round2(n) { return F.round2(n); }

function fail(error, code) {
    return { ok: false, error, code: code || 'voucher.invalid' };
}

/**
 * validate
 *
 * What:  Validates a voucher code for THIS customer + cart and computes
 *        the discount. The cart supplies branch_id / company_id / sub_total.
 * Returns:
 *   { ok: true, voucher: { id, code }, discount }   on success
 *   { ok: false, error, code }                       on any failure
 * Type:  READ.
 */
async function validate(rawCode, cart, customerId) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code)        { return fail('Enter a voucher code.', 'voucher.empty'); }
    if (!customerId)  { return fail('Please sign in to use a voucher.', 'voucher.auth'); }
    if (!cart)        { return fail('Your cart is no longer available.', 'voucher.no_cart'); }

    // ONE PERSON, MANY ACCOUNTS — a voucher issued to any account this person
    // holds counts as theirs. Somebody who ordered at a restaurant through the
    // legacy POS has a separate `customer` row there; a voucher issued to that
    // row was invisible to their marketplace account, so a real voucher of
    // theirs came back "not assigned to you".
    // Identity is the mobile number, via the same loyalty.linkedCustomerIds the
    // wallet uses — so the two features agree on who a person is (mobile AND
    // country code must match; +44 and +376 are different people).
    //
    // The RESTAURANT scope is unchanged: branch_id + company_id still pin the
    // voucher to the cart's restaurant, exactly as legacy does
    // (common/constants/Vouchers::validate). A voucher issued by one restaurant
    // is not spendable at another — the same rule the loyalty redeem follows.
    const linkedIds = await require('./loyalty').linkedCustomerIds(customerId);
    const ids = (linkedIds && linkedIds.length) ? linkedIds : [customerId];

    const v = await db('customer_voucher')
        .whereIn('customer_id', ids)
        .andWhere({
            voucher_code: code,
            branch_id:    cart.branch_id,
            company_id:   cart.company_id,
        })
        .first();
    if (!v) {
        return fail('Invalid voucher code or this voucher is not assigned to you.', 'voucher.not_found');
    }

    // Expired? (date-only compare against the start of today, local time).
    if (v.voucher_expiry_date) {
        const exp = new Date(String(v.voucher_expiry_date).trim().replace(' ', 'T'));
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (Number.isFinite(exp.getTime()) && exp.getTime() < today.getTime()) {
            return fail('This voucher has expired.', 'voucher.expired');
        }
    }

    // Already used (single-use only).
    if (Number(v.used_once) === 1 && Number(v.is_used) === IS_USED_USED) {
        return fail('You have already used this voucher.', 'voucher.used');
    }

    // Active (not consumed).
    if (Number(v.is_used) !== IS_USED_ACTIVE) {
        return fail('This voucher is no longer valid.', 'voucher.inactive');
    }

    const subTotal = Number(cart.sub_total) || 0;
    const amount = (Number(v.voucher_type) === VOUCHER_TYPE_PERCENT)
        ? subTotal * (Number(v.voucher_amount) / 100)
        : Number(v.voucher_amount) || 0;
    const discount = Math.min(round2(amount), subTotal);   // never exceed sub-total

    return { ok: true, voucher: { id: v.id, code: v.voucher_code }, discount };
}

/**
 * markUsed
 *
 * What:  Flips a single-use voucher to "used" after a successful order so
 *        it can't be redeemed twice. No-op for multi-use vouchers
 *        (used_once != 1). Called from the place-order transaction.
 * Type:  WRITE.
 */
async function markUsed(voucherId, conn) {
    if (!voucherId) { return; }
    const q = (conn || db)('customer_voucher')
        .where({ id: voucherId, used_once: 1 })
        .update({ is_used: IS_USED_USED });
    return q;
}

module.exports = {
    validate,
    markUsed,
    VOUCHER_TYPE_PERCENT,
    VOUCHER_TYPE_FIXED,
};
