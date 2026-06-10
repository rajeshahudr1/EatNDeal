'use strict';

/*
 * Controllers/Customer/PaymentMethodController.js
 *
 * What:  Saved-card management for the signed-in marketplace customer.
 *        Three endpoints:
 *
 *          GET  /api/v1/customer/payment-methods       → list saved cards
 *          POST /api/v1/customer/payment-method/setup  → SetupIntent for adding a card
 *          POST /api/v1/customer/payment-method/delete → detach a saved card
 *
 *        Each card lives on Stripe — we store only the Stripe Customer
 *        id (mp_customer_stripe). Brand / last4 / expiry are pulled from
 *        Stripe at read time; no PAN ever touches our DB.
 *
 * Auth:  customer_id is injected by the web proxy from the session.
 *        Stripe is only consulted when it's configured (env var set);
 *        otherwise a 503 surfaces so the UI hides the Card option.
 */

const H              = require('../../Helpers/helper');
const MSG            = require('../../Helpers/messages');
const customers      = require('../../Helpers/customerLookup');
const payments       = require('../../Helpers/payments');
const stripeCustomer = require('../../Helpers/stripeCustomer');

function gateConfigured(res) {
    if (payments.isConfigured()) { return true; }
    H.errorResponse(res, 'Card payments are not configured.', 503);
    return false;
}

/**
 * list — GET /payment-methods
 *
 * Output: 200 envelope, data = { paymentMethods: [{id, brand, last4, expMonth, expYear}] }
 */
async function list(req, res) {
    try {
        const customerId = req.query.customer_id;
        const { row: cust, error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        if (!gateConfigured(res)) { return; }

        // No mapping yet → no saved cards. Skip provisioning at list time
        // (we only create the Stripe Customer when the user actually adds
        // a card) so a fresh signup doesn't generate empty Stripe rows.
        const mapping = await stripeCustomer.find(cust.id);
        if (!mapping) {
            return H.successResponse(res, { paymentMethods: [] });
        }

        const cards = await payments.listPaymentMethods({ customer: mapping.stripe_customer_id });
        return H.successResponse(res, { paymentMethods: cards });
    } catch (err) {
        H.log.error('paymentMethod.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setupIntent — POST /payment-method/setup
 *
 * What:  Returns a SetupIntent's client_secret bound to the customer's
 *        Stripe Customer (creating one if it doesn't exist yet). The
 *        browser confirms it with Stripe.js + the new payment_method is
 *        auto-attached for re-use.
 *
 * Output: 200 envelope, data = { clientSecret, publishableKey }
 */
async function setupIntent(req, res) {
    try {
        const customerId = req.body.customer_id;
        const { row: cust, error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        if (!gateConfigured(res)) { return; }

        const stripeCustId = await stripeCustomer.ensure(cust);
        const intent = await payments.createSetupIntent({ customer: stripeCustId });
        if (!intent || !intent.client_secret) {
            return H.errorResponse(res, 'Could not start the card setup.', 502);
        }
        return H.successResponse(res, {
            clientSecret:   intent.client_secret,
            publishableKey: payments.publishableKey(),
        });
    } catch (err) {
        H.log.error('paymentMethod.setupIntent', err && err.message);
        const msg = (err && err.code === 'stripe.not_configured')
            ? 'Card payments are not configured.'
            : MSG.server.oops;
        return H.errorResponse(res, msg, 500);
    }
}

/**
 * remove — POST /payment-method/delete
 *
 * Body:  { customer_id, payment_method_id }
 */
async function remove(req, res) {
    try {
        const customerId = req.body.customer_id;
        const pmId       = String(req.body.payment_method_id || '').trim();
        if (!pmId) { return H.errorResponse(res, 'Missing payment_method_id.', 400); }

        const { row: cust, error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        if (!gateConfigured(res)) { return; }

        const mapping = await stripeCustomer.find(cust.id);
        if (!mapping) {
            // No Stripe Customer ⇒ nothing to detach. Idempotent OK.
            return H.successResponse(res, { deleted: true }, MSG.resource.deleted);
        }

        await payments.detachPaymentMethod(pmId);
        return H.successResponse(res, { deleted: true }, MSG.resource.deleted);
    } catch (err) {
        H.log.error('paymentMethod.remove', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, setupIntent, remove };
