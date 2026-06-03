'use strict';

/*
 * Controllers/Merchant/OrdersController.js
 *
 * What:  Merchant-side surface for marketplace orders. Three endpoints:
 *
 *          GET  /api/v1/merchant/orders        — list filtered by state
 *          GET  /api/v1/merchant/order         — full single-order shape
 *          POST /api/v1/merchant/order/advance — atomic status transition
 *
 *        Auth chain:
 *           1. loadMarketplaceCustomer guard (same as customer side).
 *           2. Helpers/merchant.companyForStaff(customer_id) — env-driven
 *              allowlist that maps customer → company. Returns null when
 *              the customer isn't on the staff list ⇒ controller returns 403.
 *           3. Every query filters on the resolved company_id so a staff
 *              member can NEVER see another company's orders.
 *
 *        All endpoints scope to `is_marketplace = 1` so legacy POS
 *        orders never leak into the merchant marketplace view.
 *
 * Type:  READ + WRITE.
 */

const H            = require('../../Helpers/helper');
const MSG          = require('../../Helpers/messages');
const customers    = require('../../Helpers/customerLookup');
const Merchant     = require('../../Helpers/merchant');
const Orders       = require('../../Helpers/orders');
const OrderStatus  = require('../../Helpers/orderStatus');
const OrderAdvance = require('../../Helpers/orderAdvance');
const { db }       = require('../../config/db');

// State → array of order_status codes filter.
const STATE_BUCKETS = Object.freeze({
    live:      ['3', '4', '5', '6', '7', '10', '11'],
    completed: ['8'],
    cancelled: ['0', '2', '9'],
    all:       null,   // no filter
});

/**
 * guardStaff
 *
 * What:  Combined identity + staff-allowlist check. Returns
 *        { companyId, customerId } on pass or { error } the caller
 *        relays to the browser.
 * Type:  READ.
 */
async function guardStaff(customerId) {
    const { row: customer, error } = await customers.loadMarketplaceCustomer(customerId);
    if (error) { return { error }; }
    const companyId = Merchant.companyForStaff(customer.id);
    if (!companyId) {
        return { error: { msg: 'You don\'t have merchant access. Contact support to add your account.', status: 403 } };
    }
    return { companyId, customerId: customer.id };
}

/**
 * list
 *
 * What:  Returns marketplace orders for the staff member's company,
 *        filtered by `state` (live | completed | cancelled | all),
 *        with the same summary shape Orders.listForCustomer uses but
 *        scoped to the merchant's company rather than a single customer.
 *
 *        Adds `nextActions` per row so the dashboard can render the
 *        button(s) without a second round trip.
 * Type:  READ.
 */
async function list(req, res) {
    try {
        const { error, companyId } = await guardStaff(req.query.customer_id);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const state  = req.query.state  || 'live';
        const limit  = Math.min(100, Math.max(1, Number(req.query.limit)  || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const codes  = STATE_BUCKETS[state] || null;

        const qb = db('orders')
            .where('company_id', companyId)
            .andWhere('is_marketplace', 1)
            .orderBy('id', 'desc')
            .limit(limit)
            .offset(offset)
            .select(
                'id', 'order_number', 'order_status', 'serve_type', 'grand_total',
                'total_qty', 'created_at', 'updated_at', 'customer_first_name',
                'customer_last_name', 'customer_number', 'remark',
                'delivery_address', 'delivery_estimated_time',
                'advanced_order_waiting_time_minute', 'is_pre_order', 'scheduled_time',
            );
        if (codes) { qb.whereIn('order_status', codes); }

        const rows = await qb;

        const orders = rows.map((r) => ({
            id:           String(r.id),
            number:       r.order_number || '',
            status:       String(r.order_status || ''),
            statusLabel:  Orders.statusLabel(r.order_status),
            statusClass:  Orders.statusClass(r.order_status),
            serveType:    Number(r.serve_type) || 0,
            grandTotal:   Number(r.grand_total) || 0,
            totalQty:     Number(r.total_qty)   || 0,
            createdAt:    r.created_at || null,
            customerName: ((r.customer_first_name || '') + ' ' + (r.customer_last_name || '')).trim(),
            customerPhone: r.customer_number || '',
            deliveryAddress: r.delivery_address || '',
            remark:       r.remark || '',
            isPreOrder:   Number(r.is_pre_order) === 1,
            scheduledTime: r.scheduled_time || null,
            etaMinutes:   OrderStatus.etaMinutesFromNow(r),
            nextActions:  OrderAdvance.nextActions(r),
        }));

        return H.successResponse(res, { orders, state, count: orders.length });
    } catch (err) {
        H.log.error('merchant.orders.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * detail
 *
 * What:  Full single-order payload — reuses the customer-side
 *        Orders.loadDetail join + items + modifiers + payment + delivery,
 *        but with the staff company-scope check instead of customer-id
 *        ownership. Adds nextActions for the buttons.
 * Type:  READ.
 */
async function detail(req, res) {
    try {
        const { error, companyId } = await guardStaff(req.query.customer_id);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const orderId = req.query.id;
        const row = await db('orders')
            .where('id', orderId)
            .andWhere('company_id', companyId)
            .andWhere('is_marketplace', 1)
            .first();
        if (!row) { return H.errorResponse(res, 'Order not found.', 404); }

        // Re-use the customer detail loader by passing the order's
        // user_id; the helper does the rest of the joins.
        const detail = await Orders.loadDetail(row.id, row.user_id);
        if (!detail) { return H.errorResponse(res, 'Order not found.', 404); }

        detail.nextActions = OrderAdvance.nextActions(row);
        return H.successResponse(res, { order: detail });
    } catch (err) {
        H.log.error('merchant.order.detail', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * advance
 *
 * What:  Atomic status transition driven by the dashboard buttons.
 *
 *        Server-side validation (each rejects with 422):
 *          • The order belongs to this staff's company.
 *          • `next_status` is one of OrderAdvance.nextActions(order).
 *          • `expected_status` matches the order's CURRENT status — so
 *            two concurrent merchant tabs can't both click "Accept" and
 *            land us at "Preparing" without going through "Accepted".
 *
 *        The actual write uses UPDATE … WHERE order_status = expected,
 *        so even without the JS guard a race results in 0 rows
 *        affected and a friendly 409.
 *
 * Type:  WRITE.
 */
async function advance(req, res) {
    try {
        const b = req.body;
        const { error, companyId, customerId } = await guardStaff(b.customer_id);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const order = await db('orders')
            .where('id', b.order_id)
            .andWhere('company_id', companyId)
            .andWhere('is_marketplace', 1)
            .first();
        if (!order) { return H.errorResponse(res, 'Order not found.', 404); }

        if (!OrderAdvance.isValidNext(order, b.next_status)) {
            return H.errorResponse(res,
                'That status change isn\'t allowed for this order right now.', 422,
                { currentStatus: String(order.order_status) });
        }

        const updated = await OrderAdvance.advance(
            order.id, b.expected_status, b.next_status, customerId,
        );
        if (updated === 0) {
            return H.errorResponse(res,
                'The order has already moved on — refresh and try again.', 409,
                { currentStatus: String(order.order_status) });
        }

        // Re-load for the response so the dashboard can patch the row.
        const refreshed = await db('orders')
            .where('id', order.id)
            .first(
                'id', 'order_status', 'serve_type', 'updated_at',
                'delivery_estimated_time', 'advanced_order_waiting_time_minute',
                'created_at',
            );

        return H.successResponse(res, {
            order: {
                id:          String(refreshed.id),
                status:      String(refreshed.order_status),
                statusLabel: Orders.statusLabel(refreshed.order_status),
                statusClass: Orders.statusClass(refreshed.order_status),
                progress:    OrderStatus.progressForOrder(refreshed),
                etaMinutes:  OrderStatus.etaMinutesFromNow(refreshed),
                nextActions: OrderAdvance.nextActions(refreshed),
                updatedAt:   refreshed.updated_at || null,
            },
        }, 'Order updated.');
    } catch (err) {
        H.log.error('merchant.order.advance', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, detail, advance };
