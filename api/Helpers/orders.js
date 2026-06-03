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

// Legacy `orders.order_status` enum. Unknown codes ⇒ 'Processing'.
const STATUS_LABELS = Object.freeze({
    '0':  'Cancelled',
    '1':  'Placed',
    '2':  'Cancelled',
    '3':  'New',
    '4':  'Pending',
    '5':  'Accepted',
    '6':  'Preparing',
    '7':  'Out for delivery',
    '8':  'Completed',
    '9':  'Cancelled',
    '10': 'Accepted',
    '11': 'Ready for pickup',
});

// CSS-class hook so the orders list can colour status pills consistently.
const STATUS_CLASSES = Object.freeze({
    completed: ['8'],
    cancelled: ['0', '2', '9'],
    pending:   ['3', '4'],
});

function statusLabel(code) {
    return STATUS_LABELS[String(code)] || 'Processing';
}

function statusClass(code) {
    const s = String(code);
    if (STATUS_CLASSES.completed.indexOf(s) !== -1) { return 'completed'; }
    if (STATUS_CLASSES.cancelled.indexOf(s) !== -1) { return 'cancelled'; }
    if (STATUS_CLASSES.pending.indexOf(s)   !== -1) { return 'pending'; }
    return 'active';
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

    const rows = await db('orders as o')
        .leftJoin('company as c', 'c.id', 'o.company_id')
        .where('o.user_id', customerId)
        .andWhere('o.is_marketplace', 1)
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
            statusLabel:  statusLabel(r.order_status),
            statusClass:  statusClass(r.order_status),
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

    return {
        id:               String(order.id),
        number:           order.order_number || '',
        status:           String(order.order_status || ''),
        statusLabel:      statusLabel(order.order_status),
        statusClass:      statusClass(order.order_status),
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
        bagCharge:        Number(order.bag_charge)            || 0,
        charityAmount:    Number(order.charity_amount)        || 0,
        discount:         Number(order.discount)              || 0,
        freeDelivery:     Number(order.free_delivery) === 1,
        grandTotal:       Number(order.grand_total) || 0,
        totalQty:         Number(order.total_qty)   || 0,
        deliveryAddress:  order.delivery_address || '',
        scheduledTime:    order.scheduled_time || null,
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
