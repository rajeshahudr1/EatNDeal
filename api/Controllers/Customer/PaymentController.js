'use strict';

/*
 * Controllers/Customer/PaymentController.js
 *
 * What:  HTTP entry-points for the Stripe-backed payment flow.
 *
 *          POST /api/v1/customer/payment/intent  → returns PaymentIntent
 *                                                   {clientSecret, publishableKey}
 *
 *        The amount + metadata are resolved SERVER-SIDE from the open
 *        cart — the browser doesn't get to lie about the price. The
 *        intent's metadata.cart_id is used at order-place time so we
 *        can verify the customer paid for THIS specific cart.
 *
 *        When STRIPE_SECRET_KEY isn't set we return 503 with a friendly
 *        message so the cart UI can disable the Card option without
 *        crashing.
 *
 * Auth:  Login required (validator marks customer_id required).
 */

const H              = require('../../Helpers/helper');
const MSG            = require('../../Helpers/messages');
const customers      = require('../../Helpers/customerLookup');
const Cart           = require('../../Helpers/cart');
const CartCheck      = require('../../Helpers/cartValidate');
const Payments       = require('../../Helpers/payments');
const OrderPlace     = require('../../Helpers/orderPlace');
const M              = require('../../Helpers/marketplace');
const stripeCustomer = require('../../Helpers/stripeCustomer');
const { db }         = require('../../config/db');

/**
 * createIntent
 *
 * What:  Creates a Stripe PaymentIntent for the customer's current
 *        cart total. Returns the bits the browser needs to confirm
 *        the payment via Stripe.js.
 * Type:  WRITE (Stripe-side; nothing in our DB).
 *
 * Output: 200 envelope, data = {
 *           clientSecret, intentId, amount, currency, publishableKey
 *         }
 *         503 when STRIPE_SECRET_KEY isn't configured.
 *         404 when the customer has no open cart.
 */
async function createIntent(req, res) {
    try {
        if (!Payments.isConfigured()) {
            return H.errorResponse(res,
                'Card payments aren\'t available right now. Please choose Cash on Delivery.', 503);
        }

        const customerId = req.body.customer_id;
        const { row: cust, error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is empty.', 404); }

        // Recompute first so we always charge the FRESH total — handles
        // the corner case where the page sat open long enough for an
        // auto-discount window to lapse.
        await Cart.recomputeTotals(open.id);
        const cart = await Cart.loadActiveCart(open.id, customerId);
        if (!cart) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const baseAmount = Number(cart.grandtotal) || 0;
        if (baseAmount <= 0) {
            return H.errorResponse(res, 'Add at least one item before paying.', 422);
        }
        // Card payments add the company's service charge (cash never does).
        // Charge base + surcharge so Stripe collects the exact card total;
        // orderPlace records the same figures from the same source.
        const cardCharge = await Cart.cardServiceCharge(cart.company_id);
        const amount = Cart.round2(baseAmount + cardCharge);

        try {
            // Bind the intent to the customer's Stripe Customer so
            // saved cards become available at checkout. The card itself
            // is only attached for re-use when the customer ticked
            // "Save this card for future orders" on the cart UI.
            const wantsSave    = req.body.save_card === true;
            const stripeCustId = await stripeCustomer.ensure(cust);
            const intent = await Payments.createIntent({
                amount,
                customer:           stripeCustId,
                savePaymentMethod:  wantsSave,
                metadata: {
                    cart_id:     String(cart.id),
                    customer_id: String(customerId),
                    company_id:  String(cart.company_id || ''),
                    branch_id:   String(cart.branch_id  || ''),
                    card_service_charge: String(cardCharge),
                    is_marketplace: '1',
                },
            });
            return H.successResponse(res, {
                clientSecret:    intent.client_secret,
                intentId:        intent.id,
                amount:          (Number(intent.amount) || 0) / 100,
                currency:        intent.currency,
                publishableKey:  Payments.publishableKey(),
                stripeCustomer:  stripeCustId,
            });
        } catch (stripeErr) {
            H.log.error('payment.createIntent.stripe', stripeErr && stripeErr.message);
            return H.errorResponse(res,
                stripeErr.code === 'stripe.not_configured'
                    ? 'Card payments aren\'t configured. Please choose Cash on Delivery.'
                    : (stripeErr.message || 'Could not start the payment.'),
                502);
        }
    } catch (err) {
        H.log.error('payment.createIntent', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * webhook
 *
 * What:  Receives signed events from Stripe and uses
 *        `payment_intent.succeeded` to close the recovery gap — if a
 *        customer's card was charged but the browser closed BEFORE
 *        `/order/place` fired, this handler places the order from the
 *        intent's metadata so the customer doesn't pay for nothing.
 *
 *        Auth model: Stripe-signed body (HMAC-SHA256 of
 *        "<timestamp>.<rawBody>" with STRIPE_WEBHOOK_SECRET). Never
 *        trusts request payload until the signature matches.
 *
 *        Idempotency: orders_payments.payment_transaction_id is the
 *        natural dedupe key. If we already have an order for this
 *        intent, we return 200 immediately and do nothing.
 *
 *        Failure handling (best-effort):
 *           • Cart still open + valid → place the order
 *           • Cart closed (customer already succeeded /order/place) → skip
 *           • Cart open but validate(PLACE) fails (e.g. stock raced) →
 *             log + return 200 (Stripe should NOT retry; manual support
 *             handles the refund)
 *
 *        We always return 200 to Stripe once the signature passes, so
 *        Stripe doesn't keep retrying on errors we can't recover from.
 * Type:  WRITE (transactional via OrderPlace.placeOrder).
 *
 * Route:  POST /api/v1/customer/payment/webhook
 *         (no Joi — body is raw bytes; req.rawBody is set by the
 *          express.json verify hook in api/index.js).
 */
async function webhook(req, res) {
    if (!Payments.isWebhookConfigured()) {
        return res.status(503).send('webhook not configured');
    }

    // 1. Verify the Stripe-Signature header.
    const sig = req.headers['stripe-signature'];
    try {
        Payments.verifyWebhookSignature(req.rawBody, sig);
    } catch (sigErr) {
        H.log.error('payment.webhook.signature', sigErr && sigErr.message);
        return res.status(400).send('invalid signature');
    }

    // 2. Parse the event JSON (re-use req.body — express.json already did).
    const event = req.body && req.body.id ? req.body : null;
    if (!event) {
        return res.status(400).send('bad payload');
    }

    try {
        if (event.type === 'payment_intent.succeeded') {
            await handleIntentSucceeded(event.data && event.data.object);
        } else if (event.type === 'payment_intent.payment_failed') {
            // Best-effort log; nothing in our DB to clean up since we
            // never placed an order without a verified success.
            H.log.warn('payment.webhook.failed_intent', {
                intentId: event.data && event.data.object && event.data.object.id,
            });
        }
        // We ack every signed event with 200 so Stripe stops retrying.
        return res.status(200).send('ok');
    } catch (err) {
        // Any unexpected throw is logged + still acked — we don't want
        // Stripe to retry on a code bug; manual support will reconcile.
        H.log.error('payment.webhook.handler', err && err.message);
        return res.status(200).send('logged');
    }
}

/**
 * handleIntentSucceeded
 *
 * What:  Best-effort fallback order placement for a confirmed
 *        PaymentIntent. See webhook() for the full failure matrix.
 * Type:  WRITE.
 */
async function handleIntentSucceeded(intent) {
    if (!intent || !intent.id) { return; }

    // ── Idempotency: do we already have this intent on an order? ────
    const existing = await db('orders_payments')
        .where('payment_transaction_id', intent.id)
        .first('orders_id');
    if (existing) {
        H.log.info('payment.webhook.dup', { intentId: intent.id, orderId: existing.orders_id });
        return;
    }

    // ── Metadata: cart_id + customer_id were stamped at createIntent ─
    const metaCart     = intent.metadata && String(intent.metadata.cart_id     || '');
    const metaCustomer = intent.metadata && String(intent.metadata.customer_id || '');
    if (!metaCart || !metaCustomer) {
        H.log.error('payment.webhook.missing_metadata', { intentId: intent.id });
        return;
    }

    const cart = await Cart.loadActiveCart(metaCart, metaCustomer);
    if (!cart) {
        // Cart already closed — likely /order/place ran successfully
        // in the same flow. Idempotency covers it.
        H.log.info('payment.webhook.cart_closed', { intentId: intent.id, cartId: metaCart });
        return;
    }

    // Customer + branch reload (the customer COULD have been banned
    // between intent + webhook).
    const { row: customer, error: custErr } = await customers.loadMarketplaceCustomer(metaCustomer);
    if (custErr) {
        H.log.error('payment.webhook.customer_blocked', { intentId: intent.id, err: custErr.msg });
        return;
    }
    const branch = await M.loadActiveBranch(cart.branch_id);
    if (!branch) {
        H.log.error('payment.webhook.branch_missing', { intentId: intent.id });
        return;
    }

    // ── Strict re-validate (PLACE) ──────────────────────────────────
    // Same gate the sync /order/place runs. If anything drifted
    // (stock raced, coupon expired, …) we LOG + return — manual
    // support can refund the customer via Stripe dashboard.
    const v = await CartCheck.validate(cart.id, customer.id, { level: CartCheck.LEVEL.PLACE });
    if (!v.ok) {
        H.log.error('payment.webhook.validate_failed', {
            intentId: intent.id, errors: v.errors,
        });
        return;
    }

    const items = await OrderPlace.loadItemsForPlace(cart.id);
    if (!items.length) {
        H.log.error('payment.webhook.empty_cart', { intentId: intent.id });
        return;
    }

    // Full payment detail for the order record (best-effort).
    let paymentDetail = null;
    try {
        paymentDetail = await Payments.retrieveIntentDetail(intent.id);
    } catch (detailErr) {
        H.log.warn('payment.webhook.detail', detailErr && detailErr.message);
    }

    // ── Place ───────────────────────────────────────────────────────
    try {
        const order = await OrderPlace.placeOrder({
            customer,
            cart:             v.cart,
            branch,
            items,
            paymentOption:    2,
            paymentIntentId:  intent.id,
            paymentSucceeded: true,
            paymentDetail,
            customerNote:     cart.remark || '',
        });
        H.log.info('payment.webhook.order_placed', {
            intentId: intent.id, orderId: order.id, orderNumber: order.order_number,
        });
    } catch (txErr) {
        // Stock race or schema error — log + leave for manual reconciliation.
        H.log.error('payment.webhook.place_failed', {
            intentId: intent.id, err: txErr && txErr.message, code: txErr && txErr.code,
        });
    }
}

module.exports = { createIntent, webhook };
