'use strict';

/*
 * Controllers/Customer/OrderController.js
 *
 * What:  HTTP entry-point for the marketplace order endpoints.
 *
 *          POST /api/v1/customer/order/place  → Phase-2D (this file)
 *          GET  /api/v1/customer/orders       → Phase-2E
 *          GET  /api/v1/customer/order/:id    → Phase-2E
 *
 *        Phase-2D ships ONLY /place. The pre-write chain follows the same
 *        layering pattern as the cart endpoints:
 *
 *           1. Validate request (Joi via middleware — already done).
 *           2. Authenticate the customer (loadMarketplaceCustomer).
 *           3. Load the open marketplace cart + its line items + branch.
 *           4. cartValidate.validate(PLACE) — strictest level (stock,
 *              price-drift block, coupon revalidate, address present,
 *              min-order met, scheduled_time when pre_order, etc.).
 *           5. Helpers/orderPlace.placeOrder() — single transaction.
 *           6. Return { id, number, eta, grandTotal, serveType, ... }.
 *
 * Auth:  Login required. The validator marks customer_id required.
 */

const H            = require('../../Helpers/helper');
const MSG          = require('../../Helpers/messages');
const customers    = require('../../Helpers/customerLookup');
const Cart         = require('../../Helpers/cart');
const CartCheck    = require('../../Helpers/cartValidate');
const OrderTime    = require('../../Helpers/orderTime');
const OrderPlace   = require('../../Helpers/orderPlace');
const Orders       = require('../../Helpers/orders');
const OrderStatus  = require('../../Helpers/orderStatus');
const Payments     = require('../../Helpers/payments');
const M            = require('../../Helpers/marketplace');
const { db }       = require('../../config/db');

/**
 * place
 *
 * What:  Validates + places the customer's open marketplace cart as a
 *        marketplace order. See file header for the full chain.
 * Type:  WRITE (transactional).
 *
 * Body:   customer_id, payment_option?, customer_note?
 * Output: 200 envelope, data = { order: { id, number, grandTotal, eta,
 *                                          serveType, status } }
 *         422 envelope when validate(PLACE) fails — with `errors` array.
 */
async function place(req, res) {
    try {
        const b = req.body;
        const customerId = b.customer_id;

        // 1. Customer guard.
        const { row: customer, error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // 2. Open cart resolution.
        const open = await Cart.findOpenCart(customerId);
        if (!open) {
            return H.errorResponse(res, 'Your cart is empty.', 404);
        }

        // 3. Strict revalidate — stock, price drift, coupon, address,
        //    min-order, pre-order time.
        const v = await CartCheck.validate(open.id, customerId, { level: CartCheck.LEVEL.PLACE });
        if (!v.ok) {
            return H.errorResponse(res, v.errors[0].msg, 422, { errors: v.errors });
        }

        // 4. Live items + branch (validate already loaded them but
        // we re-read to be defensive about row freshness — and we need
        // track_stock_level on each line for the inventory decrement,
        // which validate didn't return on the row).
        const items = await OrderPlace.loadItemsForPlace(open.id);
        if (!items.length) {
            return H.errorResponse(res, 'Your cart is empty.', 422);
        }
        const branch = await M.loadActiveBranch(open.branch_id);
        if (!branch) {
            return H.errorResponse(res, 'This restaurant is no longer available.', 422);
        }

        // 5a. Card-payment verification (when payment_option = 2).
        // The browser confirms the PaymentIntent via Stripe.js; the
        // SERVER re-reads it here and refuses to write the order
        // unless intent.status === 'succeeded' AND the amount + cart_id
        // metadata match. Never trust the browser to declare success.
        let paymentIntentId = null;
        let paymentSucceeded = false;
        if (Number(b.payment_option) === 2) {
            if (!Payments.isConfigured()) {
                return H.errorResponse(res,
                    'Card payments aren\'t available right now. Please pick Cash on Delivery.', 503);
            }
            if (!b.payment_intent_id) {
                return H.errorResponse(res, 'Payment confirmation is missing.', 422);
            }
            try {
                const intent = await Payments.retrieveIntent(b.payment_intent_id);
                if (!intent || intent.status !== 'succeeded') {
                    return H.errorResponse(res,
                        'Payment hasn\'t completed yet. Please try again.', 422,
                        { stripeStatus: intent && intent.status });
                }
                const expectedMinor = Math.round((Number(v.cart.grandtotal) || 0) * 100);
                if (Number(intent.amount) !== expectedMinor) {
                    return H.errorResponse(res,
                        'Payment amount doesn\'t match your cart total. Please refresh and try again.', 422);
                }
                const metaCart = intent.metadata && String(intent.metadata.cart_id || '');
                if (metaCart !== String(v.cart.id)) {
                    return H.errorResponse(res,
                        'Payment doesn\'t match this cart. Please refresh and try again.', 422);
                }
                paymentIntentId  = intent.id;
                paymentSucceeded = true;
            } catch (stripeErr) {
                H.log.error('order.place.stripe', stripeErr && stripeErr.message);
                return H.errorResponse(res,
                    'We couldn\'t verify your payment. Please try again or pick Cash on Delivery.', 502);
            }
        }

        // 5b. The big one — single transaction.
        let order;
        try {
            order = await OrderPlace.placeOrder({
                customer,
                cart:           v.cart,
                branch,
                items,
                paymentOption:  b.payment_option || 1,
                paymentIntentId,
                paymentSucceeded,
                customerNote:   b.customer_note || '',
            });
        } catch (txErr) {
            // Race-time stock failure surfaces as a friendly 422.
            if (txErr && txErr.code === 'stock_unavailable') {
                return H.errorResponse(res,
                    'One of your items just sold out. Please refresh your cart and try again.', 422,
                    { code: 'stock_unavailable', productId: txErr.productId });
            }
            throw txErr;
        }

        // 6. Build a slim response — UI redirects to /order/<id>.
        const eta = OrderTime.formatRange(
            v.cart.serve_type === 2
                ? require('../../Helpers/marketplace').deliveryMinutesFromWaiting(branch.pickup_waiting_time)
                : require('../../Helpers/marketplace').deliveryMinutesFromWaiting(branch.delivery_waiting_time),
            order.advanced_order_waiting_time_minute,
        );

        return H.successResponse(res, {
            order: {
                id:          String(order.id),
                number:      order.order_number || '',
                grandTotal:  Number(order.grand_total) || 0,
                serveType:   Number(order.serve_type)  || 0,
                status:      String(order.order_status || ''),
                eta,
            },
        }, 'Order placed.');
    } catch (err) {
        H.log.error('order.place', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

// loadItemsForPlace moved into Helpers/orderPlace.js — both this
// controller and the Stripe webhook fallback in PaymentController call
// it from the same shared place.

/**
 * list
 *
 * What:  GET /api/v1/customer/orders — returns the customer's
 *        marketplace orders, newest first. Pagination via limit / offset.
 * Type:  READ.
 *
 * Query:  customer_id (required), limit?, offset?
 * Output: 200 envelope, data = { orders: [...] }
 */
async function list(req, res) {
    try {
        const customerId = req.query.customer_id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const orders = await Orders.listForCustomer(customerId, {
            limit:  req.query.limit,
            offset: req.query.offset,
        });
        return H.successResponse(res, { orders });
    } catch (err) {
        H.log.error('order.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * detail
 *
 * What:  GET /api/v1/customer/order/:id — full order shape. 404 when the
 *        id doesn't exist OR belongs to another customer OR is a legacy
 *        POS row (is_marketplace = 0).
 * Type:  READ.
 *
 * Query:  customer_id (required), id (required)
 * Output: 200 envelope, data = { order: {...} } | 404 envelope.
 */
async function detail(req, res) {
    try {
        const customerId = req.query.customer_id;
        const orderId    = req.query.id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await Orders.loadDetail(orderId, customerId);
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }
        return H.successResponse(res, { order });
    } catch (err) {
        H.log.error('order.detail', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * status
 *
 * What:  GET /api/v1/customer/order/status — slim polling payload for
 *        the order-detail page's auto-refresh. Returns just the bits
 *        that change as the kitchen advances the order (status code +
 *        label + class + progress timeline + ETA minutes).
 *
 *        Same ownership + marketplace filter as detail() so a customer
 *        can never poll another customer's order. 404 when missing.
 * Type:  READ.
 *
 * Query:  customer_id (required), id (required)
 * Output: 200 envelope, data = OrderStatus.statusSummary(order)
 */
async function status(req, res) {
    try {
        const customerId = req.query.customer_id;
        const orderId    = req.query.id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await db('orders')
            .where('id', orderId)
            .andWhere('user_id', customerId)
            .andWhere('is_marketplace', 1)
            .first(
                'id', 'order_status', 'serve_type', 'created_at', 'updated_at',
                'delivery_estimated_time', 'advanced_order_waiting_time_minute',
            );
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        return H.successResponse(res, OrderStatus.statusSummary(order));
    } catch (err) {
        H.log.error('order.status', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { place, list, detail, status };
