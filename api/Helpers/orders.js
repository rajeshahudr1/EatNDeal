'use strict';

/*
 * Helpers/orders.js
 *
 * What:  Read-side helpers for the marketplace order surfaces:
 *
 *          listForCustomer(customerId, opts)  → array of order summaries
 *          loadDetail(orderId, customerId)    → full order shape
 *          statusLabel(code) / statusClass(code) → friendly display
 *
 *        BOTH lookups filter on `is_marketplace = 1` so a customer's
 *        legacy POS receipts (created at the till) never leak into
 *        their marketplace orders history. Same filter the Phase-2D
 *        place-order helper writes with.
 *
 *        Status codes map per legacy convention. Anything we don't
 *        explicitly name falls through to "Processing" so the UI never
 *        shows a bare number.
 *
 * Type:  READ.
 * Used:  api/Controllers/Customer/OrderController.list + .detail
 */

const { db } = require('../config/db');
const M      = require('./marketplace');
const OrderStatus = require('./orderStatus');
const reviews     = require('./reviews');
// customer.id -> customer.app_id, the identity the legacy-shared tables use.
const customers   = require('./customerLookup');

// Status label/class come from the SINGLE source of truth in
// orderStatus.js (getStatusMeta). They are thin delegates so the
// orders list, detail header and merchant board all read one map.
// serve_type is forwarded because code 6 is dual-meaning (delivery →
// "Out for delivery", pickup → "Ready to collect").
function statusLabel(code, serveType) {
    return OrderStatus.getStatusMeta(code, serveType).label;
}

function statusClass(code, serveType) {
    return OrderStatus.getStatusMeta(code, serveType).class;
}

/**
 * listForCustomer
 *
 * What:  Returns the customer's marketplace orders, newest first, with
 *        a few summary fields per card (no items joined — that's
 *        loadDetail). One main query + one count query for the line
 *        counts.
 * Type:  READ.
 */
async function listForCustomer(customerId, opts) {
    opts = opts || {};
    const limit  = Math.min(50, Math.max(1, Number(opts.limit)  || 20));
    const offset = Math.max(0, Number(opts.offset) || 0);
    if (!customerId) { return []; }

    // Filters (legacy webordering customer order list): status bucket,
    // created_at date range, order-number search.
    const status   = opts.status   ? String(opts.status).toLowerCase().trim() : null;
    const search   = opts.search   ? String(opts.search).trim() : null;
    const dateFrom = opts.dateFrom ? String(opts.dateFrom).trim() : null;
    const dateTo   = opts.dateTo   ? String(opts.dateTo).trim() : null;

    let q = db('orders as o')
        .leftJoin('company as c', 'c.id', 'o.company_id')
        .where('o.user_id', customerId)
        .andWhere('o.is_marketplace', 1);

    // order_status codes: 4/5/10/6 active, '' completed, 0/1/2/9 cancelled.
    if (status === 'active')         { q = q.whereIn('o.order_status', ['4', '5', '10', '6']); }
    else if (status === 'completed') { q = q.where('o.order_status', ''); }
    else if (status === 'cancelled') { q = q.whereIn('o.order_status', ['0', '1', '2', '9']); }

    if (search)   { q = q.andWhere('o.order_number', 'ilike', '%' + search + '%'); }
    if (dateFrom) { q = q.whereRaw('DATE(o.created_at) >= ?', [dateFrom]); }
    if (dateTo)   { q = q.whereRaw('DATE(o.created_at) <= ?', [dateTo]); }

    const rows = await q
        .orderBy('o.id', 'desc')
        .limit(limit)
        .offset(offset)
        .select(
            'o.id', 'o.order_number', 'o.order_status', 'o.serve_type',
            'o.grand_total', 'o.total_qty', 'o.created_at',
            'o.company_id', 'c.business_name', 'c.domain_name',
        );
    if (!rows.length) { return []; }

    // One round trip for the line counts (skip soft-deleted lines).
    const countRows = await db('orders_items')
        .whereIn('order_id', rows.map((r) => r.id))
        .select('order_id')
        .count('* as cnt')
        .groupBy('order_id');
    const countByOrder = new Map(countRows.map((c) => [String(c.order_id), Number(c.cnt)]));

    // Payment summary per order — newest payment row wins on the rare
    // case there's more than one (refund + capture). Cheap single query.
    const orderIds = rows.map((r) => r.id);
    const payRows = orderIds.length
        ? await db('orders_payments').whereIn('orders_id', orderIds)
            .orderBy('id', 'desc')
            .select('orders_id', 'payment_id', 'payment_amount', 'payment_status')
        : [];
    const payByOrder = new Map();
    payRows.forEach((p) => {
        const k = String(p.orders_id);
        if (!payByOrder.has(k)) { payByOrder.set(k, p); }
    });

    return rows.map((r) => {
        const name = String(r.business_name || '').trim();
        const pay = payByOrder.get(String(r.id));
        return {
            id:           String(r.id),
            number:       r.order_number || '',
            status:       String(r.order_status || ''),
            statusLabel:  statusLabel(r.order_status, r.serve_type),
            statusClass:  statusClass(r.order_status, r.serve_type),
            serveType:    Number(r.serve_type)  || 0,
            grandTotal:   Number(r.grand_total) || 0,
            totalQty:     Number(r.total_qty)   || 0,
            createdAt:    r.created_at || null,
            itemCount:    countByOrder.get(String(r.id)) || 0,
            payment: pay ? {
                method: Number(pay.payment_id) === 1 ? 'Cash' : 'Card',
                amount: Number(pay.payment_amount) || 0,
                status: Number(pay.payment_status) === 0 ? 'Pending' : 'Paid',
            } : null,
            restaurant: {
                id:   String(r.company_id),
                name,
                slug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
            },
        };
    });
}

/**
 * loadDetail
 *
 * What:  Full single-order payload for the order-detail page. The query
 *        joins company + branch so we can show the restaurant header
 *        without a separate round trip. Items + sub-modifiers + payment +
 *        delivery details are loaded as separate cheap queries.
 *        Returns null when missing / not the customer's / not marketplace.
 * Type:  READ.
 */
async function loadDetail(orderId, customerId) {
    if (!orderId || !customerId) { return null; }

    const order = await db('orders as o')
        .leftJoin('company as c', 'c.id', 'o.company_id')
        .leftJoin('branch as b',  'b.id', 'o.branch_id')
        .where('o.id', orderId)
        .andWhere('o.user_id', customerId)
        .andWhere('o.is_marketplace', 1)
        .first(
            'o.*',
            'c.business_name', 'c.domain_name',
            'b.direction_address as branch_address',
            'b.contact_number  as branch_phone',
            'b.business_image  as branch_logo',
            'b.banner_image    as branch_banner',
        );
    if (!order) { return null; }

    const items = await db('orders_items')
        .where('order_id', orderId)
        .orderBy('id', 'asc');

    const subs = items.length
        ? await db('orders_items_sub').whereIn('orders_items_id', items.map((i) => i.id))
        : [];
    const subsByItem = new Map();
    subs.forEach((s) => {
        const k = String(s.orders_items_id);
        if (!subsByItem.has(k)) { subsByItem.set(k, []); }
        subsByItem.get(k).push(s);
    });

    // orders_payments FK is `orders_id` per the legacy schema (NOT
    // order_id — easy mistake; the column DOES exist on orders_items
    // but not here).
    const payment  = await db('orders_payments').where('orders_id', orderId).first();
    // order_delivery_details has NO order_id column; it links via
    // invoice_id (matching orders.invoice_id stamped at place time).
    const delivery = (Number(order.serve_type) === 3 && order.invoice_id)
        ? await db('order_delivery_details').where('invoice_id', order.invoice_id).first()
        : null;

    const restName = String(order.business_name || '').trim();

    // The customer's own review for this order — read from customer_review
    // (the moderation record), NOT review_rating: an order review is only
    // published once the restaurant approves it, so review_rating is empty
    // while it's pending and the customer would think it had vanished.
    // Null once REJECTED, which is what brings the button back — legacy parity
    // (Orders::getCustomerOrdersReviews, admin_status IN (0,1)).
    // claimForOrder wants the APP_ID — customer_review is keyed the legacy way.
    const reviewRow  = await reviews.claimForOrder(orderId, await customers.appIdOf(customerId));
    // `reviewable` gates the "Rate & Review" CTA — any non-cancelled order.
    // The CTA is hidden outright once a review exists (see `review` below):
    // one per order, and legacy offers no edit.
    const reviewable = ['0', '1', '2', '9'].indexOf(String(order.order_status || '')) === -1;

    return {
        id:               String(order.id),
        review:           reviews.claimView(reviewRow),
        reviewable:       reviewable,
        number:           order.order_number || '',
        status:           String(order.order_status || ''),
        statusLabel:      statusLabel(order.order_status, order.serve_type),
        statusClass:      statusClass(order.order_status, order.serve_type),
        // Progress timeline + ETA — first paint of /order/:id has it
        // ready; the polling endpoint refreshes the same fields.
        progress:         OrderStatus.progressForOrder(order),
        etaMinutes:       OrderStatus.etaMinutesFromNow(order),
        etaLabel:         OrderStatus.formatEtaLabel(OrderStatus.etaMinutesFromNow(order)),
        deliveredAt:      OrderStatus.deliveredAt(order),
        serveType:        Number(order.serve_type) || 0,
        subTotal:         Number(order.sub_total)             || 0,
        deliveryFees:     Number(order.delivery_fees)         || 0,
        serviceCharge:    Number(order.service_charge_amount) || 0,
        cardServiceCharge: Number(order.stripe_service_charge) || 0,
        bagCharge:        Number(order.bag_charge)            || 0,
        charityAmount:    Number(order.charity_amount)        || 0,
        discount:         Number(order.discount)              || 0,
        // Loyalty/reward spent on this order. The column was always written at
        // place-time but never surfaced, so the receipt showed a total the
        // customer couldn't reconcile — the reward simply vanished from the
        // breakdown.
        usedCashback:     Number(order.used_cashback)         || 0,
        freeDelivery:     Number(order.free_delivery) === 1,
        grandTotal:       Number(order.grand_total) || 0,
        totalQty:         Number(order.total_qty)   || 0,
        deliveryAddress:  order.delivery_address || '',
        scheduledTime:    order.scheduled_time || null,
        // The DAY the pre-order is for — without it "05:45" is ambiguous
        // between today and tomorrow. Normalised to YYYY-MM-DD.
        scheduledDate:    order.scheduled_date ? String(order.scheduled_date).slice(0, 10) : null,
        isPreOrder:       Number(order.is_pre_order) === 1,
        deliveryEstimatedTime:         order.delivery_estimated_time || null,
        advancedOrderWaitingTimeMin:   Number(order.advanced_order_waiting_time_minute) || 0,
        createdAt:        order.created_at || null,
        // Split the composite remark (`note  |  [dropoff:...] text  |
        // legacy`) back into a clean customer note + a decoded drop-off
        // preset + free text for display. The raw tag never leaks.
        ...(function () {
            const Cart = require('./cart');
            const parts = String(order.remark || '').split('  |  ').map((s) => s.trim()).filter(Boolean);
            let dropOffLabel = '';
            let driverInstructions = '';
            const noteParts = [];
            parts.forEach((p) => {
                if (/^\[dropoff:/.test(p)) {
                    const dec = Cart.decodeDropOff(p);
                    dropOffLabel = dec.dropOffLabel;
                    driverInstructions = dec.instructions;
                } else {
                    noteParts.push(p);
                }
            });
            return {
                remark: noteParts.join(' · '),
                dropOffLabel,
                driverInstructions,
            };
        })(),
        customerName:     ((order.customer_first_name || '') + ' ' + (order.customer_last_name || '')).trim(),
        customerEmail:    order.customer_email || '',
        customerNumber:   order.customer_number || '',
        restaurant: {
            id:      String(order.company_id),
            name:    restName,
            slug:    order.domain_name ? M.slugify(order.domain_name) : M.slugify(restName, order.company_id),
            address: order.branch_address || '',
            phone:   order.branch_phone || '',
            image:   M.yiiImageUrl('banner', order.company_id, order.branch_banner)
                     || M.yiiImageUrl('logo', order.company_id, order.branch_logo)
                     || null,
            initial: M.initialFor(restName),
            tint:    M.tintFor(order.company_id),
        },
        items: items.map((it) => ({
            id:         String(it.id),
            productId:  String(it.product_id),
            name:       it.product_name || '',
            qty:        Number(it.product_qty)        || 0,
            unitPrice:  Number(it.product_net_price)  || 0,
            linePrice:  Number(it.sub_total)          || 0,
            remark:     it.remark || '',
            modifiers: (subsByItem.get(String(it.id)) || []).map((m) => ({
                id:    String(m.id),
                name:  m.modifier_option_name || m.variant_name || '',
                price: Number(m.amount) || 0,
                qty:   m.variant_qty || '1',
            })),
        })),
        payment: payment ? {
            method: Number(payment.payment_id) === 1 ? 'Cash' : 'Card',
            amount: Number(payment.payment_amount) || 0,
            status: Number(payment.payment_status) === 0 ? 'Pending' : 'Paid',
        } : null,
        // delivery is the routing-side row (rider assignment / 3rd-party
        // dispatch). The customer address lives on `order.delivery_address`
        // above; the routing row has no customer_address column.
        delivery: delivery ? {
            fees:   Number(delivery.delivery_fees) || 0,
            status: delivery.status || '',
        } : null,
    };
}

module.exports = {
    statusLabel,
    statusClass,
    listForCustomer,
    loadDetail,
};
