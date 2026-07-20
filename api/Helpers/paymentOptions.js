'use strict';

/*
 * Helpers/paymentOptions.js
 *
 * What:  Maps the marketplace's payment_option ENUM (1 = Cash, 2 = Card/Stripe)
 *        onto the RESTAURANT's own `paymentoptions` row.
 *
 * Why:   `paymentoptions` is PER-COMPANY — the same method has a different id at
 *        every restaurant:
 *            company 1  → 1 'cash',  2 'credit card', 10 'stripe'
 *            company 15 → 11 'cash', 12 'card',       13 'stripe'
 *        `orders.orders_payments.payment_id` is a paymentoptions ID, and the
 *        legacy POS reads it to show how the customer paid. Writing our raw 1/2
 *        enum there is only correct for company 1 — for every other restaurant
 *        it points at ANOTHER company's payment option.
 *
 *        It's also what decides `cash_king` cashback: legacy awards it only when
 *        the order's payment option has slug = 'cash'
 *        (webordering OrderController: Paymentoptions::find()->where(['id'=>…,
 *        'slug'=>'cash'])->exists()) — never by a hardcoded id.
 *
 * Type:  READ.
 */

const { db } = require('../config/db');

// Our marketplace enum.
const PAY_CASH = 1;
const PAY_CARD = 2;

// Slug preference per enum value. Card = Stripe first (the marketplace charges
// through Stripe, which the legacy checkout relabels "Card"), then a plain card
// option as a fallback.
const SLUGS = {
    [PAY_CASH]: ['cash'],
    [PAY_CARD]: ['stripe', 'card', 'credit card'],
};

/**
 * resolveForCompany
 *
 * What:  The restaurant's own paymentoptions row for the chosen enum value.
 *        Picks the first matching slug in preference order, favouring an ACTIVE
 *        (status=1) row but accepting an inactive one rather than returning
 *        nothing (the order still has to record how it was paid).
 * Type:  READ.
 *
 * Inputs:  companyId, paymentOption (1 = cash, 2 = card)
 * Output:  { id, slug, name } | null when the restaurant has no such option.
 */
async function resolveForCompany(companyId, paymentOption) {
    const want = Number(paymentOption) === PAY_CARD ? PAY_CARD : PAY_CASH;
    const slugs = SLUGS[want];
    if (!companyId) { return null; }
    try {
        const rows = await db('paymentoptions')
            .where('company_id', companyId)
            .select('id', 'slug', 'name', 'status');
        if (!rows.length) { return null; }
        const norm = (s) => String(s || '').trim().toLowerCase();
        for (const slug of slugs) {
            // Prefer an enabled option; fall back to a disabled one of the same
            // slug before moving on to the next preference.
            const hit = rows.find((r) => norm(r.slug) === slug && Number(r.status) === 1)
                     || rows.find((r) => norm(r.slug) === slug);
            if (hit) { return { id: Number(hit.id), slug: norm(hit.slug), name: hit.name || '' }; }
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * isCashPayment
 *
 * What:  TRUE when this order's payment option is the restaurant's CASH option —
 *        resolved by SLUG exactly like legacy, never by a hardcoded id. Drives
 *        the `cash_king` award (cash-only).
 * Type:  READ.
 */
async function isCashPayment(companyId, paymentOption) {
    const opt = await resolveForCompany(companyId, paymentOption);
    // No paymentoptions row for this restaurant → fall back to the enum so a
    // mis-configured restaurant behaves as it did before this helper existed.
    if (!opt) { return Number(paymentOption) !== PAY_CARD; }
    return opt.slug === 'cash';
}

module.exports = { PAY_CASH, PAY_CARD, resolveForCompany, isCashPayment };
