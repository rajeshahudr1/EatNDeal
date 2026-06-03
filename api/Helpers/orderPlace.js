'use strict';

/*
 * Helpers/orderPlace.js
 *
 * What:  THE one transaction every marketplace order flows through. Given
 *        a customer + their open cart + the resolved branch + the chosen
 *        payment option, this function writes:
 *
 *           1.  orders                       (with is_marketplace = 1)
 *           2.  orders_items                 (one per cart_details line)
 *           3.  orders_items_sub             (one per cart_sub_details)
 *           4.  orders_payments              (the chosen method)
 *           5.  order_delivery_details       (only when delivery)
 *           6.  product_store_inventory      (decrement per tracked line)
 *           7.  cart                         (mark is_open = 0)
 *
 *        ALL inside a single Knex transaction. Any step throws ⇒
 *        rollback ⇒ caller relays a friendly 422 to the customer; nothing
 *        partial lands in the DB.
 *
 *        Stock decrement uses SELECT … FOR UPDATE to serialise concurrent
 *        place-order calls so two customers can't claim the same last
 *        unit. Non-tracked products (track_stock_level ≠ 1) skip the
 *        inventory step.
 *
 *        Timing is filled from Helpers/orderTime:
 *           orders.delivery_estimated_time            ← branch's HH:MM:SS string
 *           orders.advanced_order_waiting_time_minute ← integer minutes from
 *                                                       advance_order_waiting_time
 *                                                       (value + volume bucket sums)
 *
 *        Caller MUST have already run cartValidate.validate(PLACE) and
 *        confirmed `ok=true`. This function is the WRITE path only.
 *
 * Type:  WRITE (transactional).
 * Used:  api/Controllers/Customer/OrderController.place
 */

const { db }       = require('../config/db');
const Cart         = require('./cart');
const OrderTime    = require('./orderTime');

/**
 * loadItemsForPlace
 *
 * What:  Same line items Cart.loadLineItems returns, but each row also
 *        carries `track_stock_level` so the placeOrder transaction
 *        knows which products to decrement inventory for.
 *        Both controllers (sync /order/place + async Stripe webhook
 *        recovery) call this — keeps the join logic DRY.
 * Type:  READ.
 */
async function loadItemsForPlace(cartId) {
    const items = await Cart.loadLineItems(cartId);
    if (!items.length) { return []; }
    const ids = Array.from(new Set(items.map((it) => it.product_id)));
    const tracks = await db('products')
        .whereIn('id', ids)
        .select('id', 'track_stock_level');
    const byId = new Map(tracks.map((r) => [String(r.id), Number(r.track_stock_level) || 0]));
    return items.map((it) => Object.assign({}, it, {
        track_stock_level: byId.get(String(it.product_id)) || 0,
    }));
}

const STATUS_PENDING       = '4';  // legacy convention — staff has to accept
const STATUS_AUTO_ACCEPTED = '5';  // delivery auto-accept (branch flag)
const STATUS_AUTO_PICKUP   = '10'; // pickup auto-accept
const CART_CLOSED          = 0;
const CREATED_FROM_WEB     = '2';  // legacy enum (1=app-iOS, 2=web, 3=app-Android)
const PAYMENT_STATUS_PENDING = 0;  // 0 = unpaid; cash collected on delivery

/**
 * generateOrderNumber
 *
 * What:  Generates a marketplace order number in the format
 *           MP_YYYYMMDD_HHMMSS_<12-hex>
 *        12 hex chars = 48 bits of randomness, making a same-second
 *        collision astronomically unlikely even under peak concurrent
 *        checkout. Earlier 3-digit version could collide (1-in-1000).
 *        crypto.randomBytes is CSPRNG-quality.
 * Type:  READ (pure).
 */
const crypto = require('crypto');
function generateOrderNumber(now) {
    const d = now || new Date();
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    const r = crypto.randomBytes(6).toString('hex');     // 12 hex chars
    return 'MP_'
        + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_'
        + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '_'
        + r;
}

/**
 * resolveOrderStatus
 *
 * What:  Picks the initial `orders.order_status` value. Legacy branch
 *        config has `auto_acc_off_orders` flag — when set, online
 *        orders skip the "Pending" stage and land directly in
 *        Accepted. We honour that flag when present.
 * Type:  READ (pure).
 */
function resolveOrderStatus(branch, serveType) {
    const autoAccept = Number(branch && branch.auto_acc_off_orders) === 1;
    if (!autoAccept) { return STATUS_PENDING; }
    return Number(serveType) === 2 ? STATUS_AUTO_PICKUP : STATUS_AUTO_ACCEPTED;
}

/**
 * decrementInventory
 *
 * What:  Subtracts `qty` from the first product_store_inventory row
 *        with enough on hand. Throws when nothing matches so the
 *        outer transaction rolls back. FOR UPDATE locks the row so
 *        concurrent place-order calls serialise — two customers can't
 *        both grab the last unit.
 *
 *        Made-to-order products (track_stock_level ≠ 1) skip this
 *        function entirely (caller filters).
 * Type:  WRITE (inside a transaction).
 */
async function decrementInventory(trx, productId, qty) {
    const row = await trx('product_store_inventory')
        .where('product_id', productId)
        .andWhere('quantity', '>=', qty)
        .orderBy('id', 'asc')
        .forUpdate()
        .first();
    if (!row) {
        const err = new Error('stock_unavailable');
        err.code = 'stock_unavailable';
        err.productId = productId;
        throw err;
    }
    await trx('product_store_inventory')
        .where('id', row.id)
        .update({ quantity: trx.raw('quantity - ?', [qty]) });
}

/**
 * deliveryEstimatedTime
 *
 * What:  Returns the HH:MM:SS string the legacy POS stores on
 *        orders.delivery_estimated_time. For our marketplace it's the
 *        branch's `delivery_waiting_time` (or `pickup_waiting_time` for
 *        pickup), copied verbatim — exactly what legacy saveOrder does.
 *        Returns null when the merchant hasn't set one.
 * Type:  READ (pure).
 */
function deliveryEstimatedTime(branch, serveType) {
    if (!branch) { return null; }
    return Number(serveType) === 2 ? (branch.pickup_waiting_time || null)
                                   : (branch.delivery_waiting_time || null);
}

/**
 * placeOrder
 *
 * What:  See file header. Returns the inserted orders row on success.
 *        Throws (with a `code` set) on validation-style failures — the
 *        controller maps that to a 422 envelope.
 *
 * Inputs:
 *   { customer, cart, branch, items, paymentOption, customerNote }
 *
 * Output: the orders row (already in DB).
 *
 * Type:  WRITE (transactional).
 */
async function placeOrder({ customer, cart, branch, items, paymentOption, customerNote, paymentIntentId, paymentSucceeded }) {
    if (!customer || !cart || !branch) {
        throw Object.assign(new Error('place.bad_input'), { code: 'place.bad_input' });
    }
    if (!Array.isArray(items) || items.length === 0) {
        throw Object.assign(new Error('place.empty_cart'), { code: 'place.empty_cart' });
    }

    const now = new Date();
    const advancedExtra = await OrderTime.advancedTime(
        branch.id, cart.company_id, Number(cart.sub_total) || 0,
        Number(cart.serve_type) === 2 ? 'pickup' : 'delivery',
    );

    return db.transaction(async (trx) => {
        // ── 1. Inventory: decrement per tracked line FIRST so a stock
        // race is caught before any other write happens. ───────────────
        for (const it of items) {
            if (Number(it.track_stock_level) === 1) {
                await decrementInventory(trx, it.product_id, Number(it.product_qty) || 0);
            }
        }

        // ── 2. Sequential internal_order_id per branch. ─────────────
        const lastRow = await trx('orders')
            .where('branch_id', branch.id)
            .max('internal_order_id as max')
            .first();
        const internalOrderId = (Number(lastRow && lastRow.max) || 0) + 1;

        const orderNumber = generateOrderNumber(now);
        const orderStatus = resolveOrderStatus(branch, cart.serve_type);

        // Pre-order time → legacy stores time-of-day on scheduled_time.
        // We extract HH:MM:SS from cart.pre_order_time when present.
        let scheduledTime = null;
        if (Number(cart.is_pre_order) === 1 && cart.pre_order_time) {
            const d = new Date(cart.pre_order_time);
            if (Number.isFinite(d.getTime())) {
                const pad = (n) => String(n).padStart(2, '0');
                scheduledTime = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            }
        }

        // ── 3. orders row ───────────────────────────────────────────
        const [order] = await trx('orders').insert({
            is_marketplace:    1,
            user_id:           customer.id,
            company_id:        cart.company_id,
            branch_id:         cart.branch_id,
            invoice_id:        Math.floor(now.getTime() / 1000),
            internal_order_id: internalOrderId,
            order_number:      orderNumber,
            order_status:      orderStatus,
            serve_type:        cart.serve_type,
            sub_total:         Number(cart.sub_total)     || 0,
            tax:               Number(cart.tax)           || 0,
            discount:          Number(cart.discount)      || 0,
            discount_id:       Number(cart.discount_id)   || 0,
            coupon_id:         Number(cart.coupon_id)     || 0,
            voucher_id:        Number(cart.voucher_id)    || 0,
            free_delivery:     Number(cart.free_delivery) || 0,
            grand_total:       Number(cart.grandtotal)    || 0,
            paid_amount:       0,
            delivery_fees:     Number(cart.delivery_fees) || 0,
            delivery_address:  cart.delivery_address || null,
            bag_charge:        Number(cart.bag_charge)    || 0,
            service_charge_amount: Number(cart.service_charge_amount) || 0,
            service_charge_rate:   Number(cart.service_charge_rate)   || 0,
            charity_amount:    Number(cart.charity_amount) || 0,
            customer_first_name: customer.firstname || '',
            customer_last_name:  customer.lastname  || '',
            customer_email:      customer.email     || '',
            customer_number:     customer.contact_no || '',
            total_qty:         Number(cart.total_qty)    || 0,
            // Fold the customer note + the encoded drop-off line
            // (`[dropoff:...] <text>`, kept verbatim) into the single
            // orders.remark column so the drop-off survives onto the
            // order — there's no dedicated instructions column. Joined
            // with a unique separator loadDetail can split back out.
            remark:            [customerNote, cart.driver_instructions, cart.remark]
                                   .map((s) => String(s || '').trim()).filter(Boolean)
                                   .join('  |  ') || null,
            is_pre_order:      Number(cart.is_pre_order) || 0,
            scheduled_time:    scheduledTime,
            delivery_estimated_time:           deliveryEstimatedTime(branch, cart.serve_type),
            advanced_order_waiting_time_minute: Number(advancedExtra) || 0,
            created_from:      CREATED_FROM_WEB,
            order_from:        CREATED_FROM_WEB,
            status:            '1',
            created_by:        customer.id,
            updated_by:        customer.id,
            // created_at / updated_at default to NOW.
        }).returning('*');

        // ── 4. orders_items + orders_items_sub ──────────────────────
        // NB: legacy orders_items doesn't carry category_id — we keep
        // that on cart_details only.
        for (const it of items) {
            const lineTotal = Cart.lineSubtotal(it);
            const [oi] = await trx('orders_items').insert({
                order_id:          order.id,
                branch_id:         cart.branch_id,
                company_id:        cart.company_id,
                product_id:        it.product_id,
                invoice_id:        Math.floor(now.getTime() / 1000),
                product_name:      it.product_name || '',
                product_qty:       Number(it.product_qty) || 0,
                product_price:     Number(it.product_price)     || 0,
                product_net_price: Number(it.product_net_price) || 0,
                sub_total:         lineTotal,
                remark:            it.remark || null,
                discount:          Number(it.discount_value) || 0,
                // discount_type is NOT NULL on orders_items (default ''
                // but explicit NULL still violates the constraint).
                // Legacy rows store '0' when no line-level discount;
                // mirror that so we never trip the constraint.
                discount_type:     it.discount_type != null ? String(it.discount_type) : '0',
                status:            '1',
                is_free_item:      Number(it.is_free_item) || 0,
                created_by:        customer.id,
            }).returning('id');

            const itemId = oi.id || oi;
            for (const m of (it.modifiers || [])) {
                await trx('orders_items_sub').insert({
                    orders_items_id:      itemId,
                    company_id:           cart.company_id,
                    product_id:           it.product_id,
                    modifier_id:          m.modifier_id || null,
                    modifier_option_id:   m.modifier_option_id || null,
                    modifier_name:        m.variant_name || '',
                    modifier_option_name: m.variant_name || '',
                    variant_qty:          m.variant_qty || '1',
                    amount:               Number(m.variant_price) || 0,
                    status:               '1',
                });
            }
        }

        // ── 5. orders_payments ──────────────────────────────────────
        // FK is `orders_id` (NOT order_id) per the legacy schema.
        // payment_status is varchar — '0' pending, '1' paid.
        // payment_transaction_id stores the Stripe PaymentIntent id
        // when paymentOption = 2 (card).
        const paidNow = !!paymentSucceeded;
        await trx('orders_payments').insert({
            orders_id:              order.id,
            company_id:             cart.company_id,
            invoice_id:             Math.floor(now.getTime() / 1000),
            payment_id:             Number(paymentOption) || 1,
            payment_amount:         Number(cart.grandtotal) || 0,
            payment_status:         paidNow ? '1' : '0',
            payment_transaction_id: paymentIntentId || null,
            payment_type:           Number(paymentOption) === 2 ? 'Card' : 'Cash',
            payment_type_id:        Number(paymentOption) || 1,
            status:                 '1',
            created_by:             customer.id,
        });

        // If card payment succeeded, also stamp the order row's paid_amount.
        if (paidNow) {
            await trx('orders').where({ id: order.id }).update({
                paid_amount: Number(cart.grandtotal) || 0,
            });
        }

        // ── 6. order_delivery_details (delivery only) ───────────────
        // Legacy schema links via `invoice_id` (matching orders.invoice_id)
        // — no order_id column. Stores delivery routing info; the
        // customer's delivery address is already on orders.delivery_address.
        if (Number(cart.serve_type) === 3) {
            await trx('order_delivery_details').insert({
                invoice_id:    Math.floor(now.getTime() / 1000),
                company_id:    cart.company_id,
                branch_id:     cart.branch_id,
                delivery_fees: Number(cart.delivery_fees) || 0,
                status:        '1',
                created_by:    customer.id,
            });
        }

        // ── 7. Close the cart ───────────────────────────────────────
        await trx('cart').where({ id: cart.id }).update({ is_open: CART_CLOSED });

        return order;
    });
}

module.exports = {
    placeOrder,
    loadItemsForPlace,
    generateOrderNumber,
    deliveryEstimatedTime,
    resolveOrderStatus,
};
