'use strict';

/*
 * Helpers/stripeCustomer.js
 *
 * What:  Maps marketplace customer ids ↔ Stripe Customer ids via the
 *        `mp_customer_stripe` table. The marketplace's saved-card
 *        endpoints all start by calling `ensureStripeCustomer(customer)`
 *        to guarantee a Stripe Customer exists, then operate against
 *        Stripe's `payment_methods` API for that customer.
 *
 *        Why a side table: the shared `customer` row is owned by the
 *        legacy Yii POS — we keep marketplace-only columns in their
 *        own `mp_…` table so we can iterate without coordinating
 *        every change with the legacy app.
 *
 * Used:  api/Controllers/Customer/PaymentMethodController.js, and the
 *        cart's payment-intent path when we want intents bound to a
 *        Stripe Customer (so saved cards become available + receipts
 *        flow through).
 */

const { db }     = require('../config/db');
const payments   = require('./payments');

const TABLE = 'mp_customer_stripe';

/**
 * find — returns the existing mapping row for one customer, or null.
 * Type: READ.
 */
async function find(customerId) {
    if (!customerId) { return null; }
    const row = await db(TABLE).where({ customer_id: customerId }).first();
    return row || null;
}

/**
 * ensure
 *
 * What:  Returns the Stripe Customer id for the given marketplace
 *        customer, creating one (and the mapping row) on first use.
 *        `customer` is the wtw_eatndeal customer row (has email +
 *        firstname/lastname). Caller must have already authed.
 * Type:  WRITE (only on first use; subsequent calls are READ-only).
 */
async function ensure(customer) {
    if (!customer || !customer.id) {
        throw new Error('stripeCustomer.ensure: missing customer');
    }
    const existing = await find(customer.id);
    if (existing && existing.stripe_customer_id) {
        return existing.stripe_customer_id;
    }

    if (!payments.isConfigured()) {
        // Caller decides how to surface — typically a 503 to the UI.
        const e = new Error('Card payments are not configured.');
        e.code = 'stripe.not_configured';
        throw e;
    }

    const name = [customer.firstname, customer.lastname]
        .map((s) => String(s || '').trim()).filter(Boolean).join(' ');
    const created = await payments.createCustomer({
        email:      customer.email || undefined,
        name:       name || undefined,
        customerId: customer.id,
    });

    if (!created || !created.id) {
        throw new Error('stripeCustomer.ensure: Stripe did not return a customer id');
    }

    await db(TABLE).insert({
        customer_id:        customer.id,
        stripe_customer_id: created.id,
        created_at:         db.fn.now(),
        updated_at:         db.fn.now(),
    });

    return created.id;
}

module.exports = { find, ensure };
