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
const PaymentOptions = require('../../Helpers/paymentOptions');  // cash_king gate: resolve slug='cash' per company
const StripeConnect = require('../../Helpers/stripeConnect');   // legacy StripeController.js port
const M            = require('../../Helpers/marketplace');
const A            = require('../../Helpers/availability');
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

        // 3. Strict revalidate — availability, price drift, coupon,
        //    address, min-order, pre-order time.
        const v = await CartCheck.validate(open.id, customerId, { level: CartCheck.LEVEL.PLACE });
        if (!v.ok) {
            return H.errorResponse(res, v.errors[0].msg, 422, { errors: v.errors });
        }

        // 4. Live items + branch (validate already loaded them but we
        // re-read to be defensive about row freshness).
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
        let paymentDetail = null;
        if (Number(b.payment_option) === 2) {
            // A £0 total (full discount / voucher / reward) can't go through
            // Stripe at all — there is nothing to charge. Such orders are
            // allowed, but Cash is the only method that makes sense.
            if ((Number(v.cart.grandtotal) || 0) <= 0) {
                return H.errorResponse(res,
                    'Your total is £0.00 — please select Cash to place this order.', 422);
            }
            if (!Payments.isConfigured()) {
                return H.errorResponse(res,
                    'Card payments aren\'t available right now. Please pick Cash on Delivery.', 503);
            }
            if (!b.session_id) {
                return H.errorResponse(res, 'Payment confirmation is missing.', 422);
            }
            try {
                // Connect DIRECT charge — the Checkout Session lives ON the
                // restaurant's connected account. Legacy checkoutSessionRetrieve:
                // verify payment_status='paid', polling a few times like the legacy.
                const css = await db('company_stripe_settings')
                    .where({ company_id: v.cart.company_id, is_enable: 1 })
                    .first('stripe_account_id');
                const stripeAccount = (css && css.stripe_account_id) || null;
                let session = await StripeConnect.checkoutSessionRetrieve({ session_id: b.session_id, account_id: stripeAccount });
                for (let i = 0; i < 10 && session && session.payment_status !== 'paid'; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    session = await StripeConnect.checkoutSessionRetrieve({ session_id: b.session_id, account_id: stripeAccount });
                }
                if (!session || session.payment_status !== 'paid') {
                    return H.errorResponse(res,
                        'Payment hasn\'t completed yet. Please try again.', 422,
                        { stripeStatus: session && session.payment_status });
                }
                // Customer pays grand total + the restaurant's card service charge
                // — the SAME figure createIntent charged. Compare to the session
                // total (pence) so a tampered amount can't slip through.
                const cardCharge    = await Cart.cardServiceCharge(v.cart.company_id);
                const expectedMinor = Math.round(((Number(v.cart.grandtotal) || 0) + cardCharge) * 100);
                if (Number(session.amount_total) !== expectedMinor) {
                    return H.errorResponse(res,
                        'Payment amount doesn\'t match your cart total. Please refresh and try again.', 422);
                }
                paymentIntentId  = session.payment_intent;
                paymentSucceeded = true;
                // Capture the FULL payment detail (method, card brand/last4, …) to
                // store on the order. Best-effort — a hiccup must never block a paid order.
                try {
                    paymentDetail = await Payments.retrieveIntentDetail(session.payment_intent, stripeAccount);
                } catch (detailErr) {
                    H.log.warn('order.place.detail', detailErr && detailErr.message);
                }
            } catch (stripeErr) {
                H.log.error('order.place.stripe', stripeErr && stripeErr.message);
                return H.errorResponse(res,
                    'We couldn\'t verify your payment. Please try again or pick Cash on Delivery.', 502);
            }
        }

        // 5b. The big one — single transaction. Availability is validated
        // up front by cartValidate(PLACE); there is no stock step inside
        // placeOrder, so any throw here is a real error → the outer catch
        // returns the generic 500.
        const order = await OrderPlace.placeOrder({
            customer,
            cart:           v.cart,
            branch,
            items,
            paymentOption:  b.payment_option || 1,
            paymentIntentId,
            paymentSucceeded,
            paymentDetail,
            customerNote:   b.customer_note || '',
        });

        // 5c. Loyalty — credit THIS restaurant's reward card (Phase 1:
        // cash_king cashback, scoped to (customer, company_id)). Best-effort:
        // earnForOrder swallows all errors so it can never affect the placed
        // order. The order is already committed at this point.
        {
            const Loyalty = require('../../Helpers/loyalty');
            const companyId = v.cart.company_id;
            const base = {
                customerId: customer.id,
                companyId,
                orderId:    order.id,
                subtotal:   Number(v.cart.sub_total) || 0,
            };
            // Earn rules fire in the SAME order legacy webordering does, each
            // master-gated (loyalty_rules.status) inside its helper. All
            // best-effort — the order is already committed, so a loyalty
            // hiccup can never affect it.
            await Loyalty.earnReferral(base);                 // 'referral' — first-order (FIRST, legacy)
            await Loyalty.earnStampCashback(base);            // 'cashback' — stamp card
            for (const it of items) {                         // 'product_cashback' — per line item
                await Loyalty.earnProductCashback({
                    customerId: customer.id, companyId, orderId: order.id,
                    productId: it.product_id, qty: Number(it.product_qty) || 0,
                });
            }
            await Loyalty.earnOrderStreak(base);              // 'product_streak' — order-count
            await Loyalty.earnSpecialOffer(base);             // 'special_offer' — dated offer
            await Loyalty.earnSmartCampaign({ ...base, type: 'inactive' }); // 'smart_campaign' — win-back
            // NOTE: event_cashback is NOT an order event. Its types are
            // 1=signup / 2=profile completion / 3=google review, and legacy
            // fires it from the PROFILE-SAVE path (webordering SiteController —
            // only when a customer_profile row is newly created), never here.
            // See Helpers/customerProfile.js.
            // cash_king LAST — legacy awards it ONLY when the order's payment
            // option has slug = 'cash' (Paymentoptions::find(['id'=>…,
            // 'slug'=>'cash'])->exists()), NEVER by a hardcoded id: paymentoptions
            // is per-company, so the cash/card ids differ at every restaurant.
            if (await PaymentOptions.isCashPayment(companyId, b.payment_option)) {
                await Loyalty.earnForOrder(base);
            }
            // collection_cashback — % on collection/pickup orders (serve_type 2).
            await Loyalty.earnCollectionCashback({ ...base, serveType: v.cart.serve_type });
        }

        // 5d. Order confirmation email — customer + restaurant (env-driven, see
        // Helpers/mailer). TRUE BACKGROUND: deferred via setImmediate so it only
        // STARTS after this place-order response has been flushed to the client.
        // A live SMTP send takes seconds; running it on the request path made
        // "Pay" feel slow. The order is already committed before this runs, so
        // the email can never affect the response, the timing, or the order.
        setImmediate(() => {
            try {
                const Mailer = require('../../Helpers/mailer');
                Mailer.sendOrderConfirmation({
                    order, customer, items, cart: v.cart, companyId: v.cart.company_id, branch,
                    paymentOption: b.payment_option,
                }).catch((e) => H.log.warn('order.email', e && e.message));
            } catch (e) { H.log.warn('order.email', e && e.message); }
        });

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
        // Redeem race — the customer's reward balance dropped between
        // checkout and place, so the cart total couldn't be honoured. Roll
        // back happened automatically; ask them to review the cart.
        if (err && err.code === 'place.reward_short') {
            return H.errorResponse(res,
                'Your reward balance changed. Please review your cart and try again.', 422);
        }
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
            limit:    req.query.limit,
            offset:   req.query.offset,
            status:   req.query.status,
            search:   req.query.search,
            dateFrom: req.query.date_from,
            dateTo:   req.query.date_to,
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
                'id', 'order_number', 'order_status', 'serve_type', 'created_at', 'updated_at',
                'delivery_estimated_time', 'advanced_order_waiting_time_minute', 'driver_id',
            );
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        const summary = OrderStatus.statusSummary(order);

        // #3 Driver — the assigned driver (legacy shows name/phone on the
        // tracking page). The marketplace driver row carries a name.
        summary.driver = null;
        if (Number(order.driver_id) > 0) {
            try {
                const d = await db('driver').where({ id: order.driver_id }).first('id', 'name');
                if (d) { summary.driver = { name: String(d.name || '').trim() || 'Your driver' }; }
            } catch (e) { /* best-effort */ }
        }

        // #4 Latest in-page notification for this order (order_notification_
        // details, polled — "Order Accepted" / "Driver Assigned" message).
        summary.notification = null;
        try {
            const n = await db('order_notification_details')
                .where({ order_number: order.order_number })
                .orderBy('id', 'desc').first('message', 'trigger_event', 'created_at');
            if (n && n.message) { summary.notification = { message: String(n.message), event: n.trigger_event || null }; }
        } catch (e) { /* best-effort */ }

        return H.successResponse(res, summary);
    } catch (err) {
        H.log.error('order.status', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * reorder
 *
 * What:  POST /api/v1/customer/order/reorder — clones a PAST order's
 *        items into a fresh open cart, then returns the cart (the web
 *        layer redirects to /cart). Mirrors the legacy webordering
 *        actionReorder, adapted to the marketplace:
 *          • the order must be THIS customer's marketplace order
 *          • the branch must still be active
 *          • each line is re-fetched + re-PRICED at the current price and
 *            availability-checked (status-driven); items that are now
 *            unavailable / removed / off-marketplace are SKIPPED (not
 *            blocking) and reported back so the UI can note them
 *          • free-gift lines are not re-added (legacy parity)
 *          • any existing open cart is closed first so reorder REPLACES it
 *            (no two open carts / branch conflicts)
 * Type:  WRITE.
 *
 * Body:   customer_id, order_id
 * Output: 200 { cart, skipped[], reordered } or 422 when nothing is addable.
 */
async function reorder(req, res) {
    try {
        const customerId = req.body.customer_id;
        const orderId    = req.body.order_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await db('orders')
            .where({ id: orderId, user_id: customerId, is_marketplace: 1 })
            .first('id', 'branch_id', 'company_id', 'serve_type');
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        const branch = await M.loadActiveBranch(order.branch_id);
        if (!branch) { return H.errorResponse(res, 'This restaurant is no longer available.', 422); }

        const orderItems = await db('orders_items').where({ order_id: order.id }).orderBy('id', 'asc');
        if (!orderItems.length) { return H.errorResponse(res, 'This order has no items to reorder.', 422); }

        // Fresh cart: close any existing open cart so reorder replaces it.
        await db('cart').where({ user_id: customerId, is_marketplace: 1, is_open: 1 }).update({ is_open: 0 });
        const cart = await Cart.getOrCreateCart({
            customerId, branchId: order.branch_id, companyId: order.company_id, serveType: order.serve_type,
        });

        const skipped = [];
        let added = 0;
        for (const it of orderItems) {
            if (Number(it.is_free_item) === 1) { continue; }   // don't re-add free gifts

            const product = await db('products as p')
                .where('p.id', it.product_id)
                .andWhere('p.show_marketplace', 1)
                .whereIn('p.status', A.SURFACE_STATUSES)
                .first('p.id', 'p.name', 'p.company_id', 'p.marketplace_price',
                       'p.online_platform_price', 'p.price_after_tax',
                       'p.discount_type', 'p.discount_value', ...A.selectColumns(db, 'p'));
            if (!product || !A.evaluate(product).available) {
                skipped.push(it.product_name || (product && product.name) || 'An item');
                continue;
            }

            const subs = await db('orders_items_sub').where({ orders_items_id: it.id });
            const options = subs.map((s) => ({
                id:                s.modifier_option_id,
                modifier_group_id: s.modifier_id,
                option_name:       s.modifier_option_name || s.modifier_name || '',
                price_tax_include: Number(s.amount) || 0,
            }));
            await Cart.addItem({
                cartId:    cart.id,
                product:   { id: product.id, name: product.name, company_id: product.company_id },
                qty:       Number(it.product_qty) || 1,
                unitPrice: M.applyProductDiscount(M.pickPrice(product), product),
                options,
                remark:    it.remark || null,
            });
            added += 1;
        }

        if (added === 0) {
            await Cart.closeCart(cart.id);
            return H.errorResponse(res, 'None of the items in this order are available right now.', 422);
        }

        await Cart.recomputeTotals(cart.id);
        const fresh = await Cart.loadCartById(cart.id);
        const items = await Cart.loadLineItems(cart.id);
        const view  = Cart.publicCartView(fresh, items);

        const msg = skipped.length
            ? ('Order added to your cart — ' + skipped.length + ' item' + (skipped.length === 1 ? '' : 's')
                + ' couldn\'t be re-added (unavailable).')
            : 'Order added to your cart.';
        return H.successResponse(res, { cart: view, skipped, reordered: added }, msg);
    } catch (err) {
        H.log.error('order.reorder', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * reportIssue — POST /customer/order/report-issue
 *
 * What:  Customer reports a problem with an order (legacy webordering
 *        "Report an Issue with Your Order" → actionSaveOrderNotes). Inserts
 *        an epos_complaints row (complaint_type_id 11) from the order's
 *        branch/company/customer details + the typed notes, and links it via
 *        orders.complaint_id. The restaurant answers from the POS; the
 *        customer polls issueResponse for the reply.
 * Type:  WRITE.
 */
async function reportIssue(req, res) {
    try {
        const customerId = req.body.customer_id;
        const orderId    = req.body.order_id;
        const notes      = String(req.body.notes || '').trim();
        if (!notes) { return H.errorResponse(res, 'Please describe the problem with your order before submitting.', 422); }

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await db('orders')
            .where({ id: orderId, user_id: customerId, is_marketplace: 1 })
            .first('id', 'branch_id', 'company_id', 'customer_first_name', 'customer_last_name', 'customer_number', 'delivery_address');
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        const name = [order.customer_first_name, order.customer_last_name].filter(Boolean).join(' ').trim();
        const [inserted] = await db('epos_complaints').insert({
            company_id:         order.company_id,
            branch_id:          order.branch_id,
            complaint_type_id:  11,                          // legacy: 11 = order issue
            complaint_details:  notes,
            customer_telephone: order.customer_number || null,
            customer_name:      name || null,
            customer_address:   order.delivery_address || null,
            platform:           'web',
            status:             'awaiting_response',
            created_by:         customerId,
            created_at:         db.fn.now(),
            updated_at:         db.fn.now(),
        }).returning('id');

        const complaintId = inserted && (inserted.id || inserted);
        if (complaintId) {
            await db('orders').where({ id: order.id }).update({ complaint_id: complaintId });
        }

        return H.successResponse(res, { complaintId: String(complaintId || '') },
            'Thank you for contacting us. Your order issue has been submitted — our team will review it and get back to you shortly.');
    } catch (err) {
        H.log.error('order.reportIssue', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * issueResponse — GET /customer/order/issue-response
 *
 * What:  Returns the restaurant's reply to a reported order issue (the
 *        epos_complaints.response), once it's filled — drives the
 *        client-side poll. null while still awaiting a reply.
 * Type:  READ.
 */
async function issueResponse(req, res) {
    try {
        const customerId = req.query.customer_id;
        const orderId    = req.query.order_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await db('orders')
            .where({ id: orderId, user_id: customerId, is_marketplace: 1 }).first('complaint_id');
        if (!order || !order.complaint_id) { return H.successResponse(res, { response: null, status: null }); }

        const c = await db('epos_complaints')
            .where({ id: order.complaint_id })
            .whereNotNull('response').andWhereRaw("response <> ''")
            .first('response', 'status');
        return H.successResponse(res, { response: c ? c.response : null, status: c ? c.status : null });
    } catch (err) {
        H.log.error('order.issueResponse', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { place, list, detail, status, reorder, reportIssue, issueResponse };
