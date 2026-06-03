'use strict';

/*
 * Helpers/orderAdvance.js
 *
 * What:  Status-transition rules for the merchant dashboard.
 *
 *        Two flows the merchant controls:
 *
 *          DELIVERY:
 *            Pending (4)  → Accepted (5)
 *            Accepted     → Preparing (6)
 *            Preparing    → Out for delivery (7)
 *            Out          → Delivered (8)
 *            (any)        → Cancelled (9)
 *
 *          PICKUP:
 *            Pending (4)  → Accepted (10)
 *            Accepted     → Preparing (6)
 *            Preparing    → Ready for pickup (11)
 *            Ready        → Picked up (8)
 *            (any)        → Cancelled (9)
 *
 *        `nextActions(order)` returns the UI-ready list of buttons the
 *        merchant should see right now (label + target status). The
 *        controller calls advance(order, nextStatus) which writes the
 *        update atomically — UPDATE ... WHERE order_status = current,
 *        so two concurrent merchant clicks can't double-advance.
 *
 *        Cancelled is treated separately so merchant + customer agree:
 *        once cancelled, no further transitions allowed.
 *
 * Type:  READ + WRITE.
 * Used:  api/Controllers/Merchant/OrdersController.js · advance / cancel
 */

const { db } = require('../config/db');

const STATUS_PENDING        = '4';
const STATUS_ACCEPTED_DEL   = '5';
const STATUS_PREPARING      = '6';
const STATUS_OUT            = '7';
const STATUS_DELIVERED      = '8';
const STATUS_CANCELLED      = '9';
const STATUS_ACCEPTED_PICK  = '10';
const STATUS_READY          = '11';

// Per-mode transition graph. Each key is the current status; value is
// an array of valid next steps {status, label}.
const DELIVERY_NEXT = Object.freeze({
    [STATUS_PENDING]:      [{ status: STATUS_ACCEPTED_DEL, label: 'Accept' }],
    [STATUS_ACCEPTED_DEL]: [{ status: STATUS_PREPARING,    label: 'Start preparing' }],
    [STATUS_PREPARING]:    [{ status: STATUS_OUT,          label: 'Mark out for delivery' }],
    [STATUS_OUT]:          [{ status: STATUS_DELIVERED,    label: 'Mark delivered' }],
});

const PICKUP_NEXT = Object.freeze({
    [STATUS_PENDING]:       [{ status: STATUS_ACCEPTED_PICK, label: 'Accept' }],
    [STATUS_ACCEPTED_PICK]: [{ status: STATUS_PREPARING,     label: 'Start preparing' }],
    [STATUS_PREPARING]:     [{ status: STATUS_READY,         label: 'Mark ready' }],
    [STATUS_READY]:         [{ status: STATUS_DELIVERED,     label: 'Mark picked up' }],
});

// Cancelled is reachable from anywhere EXCEPT after delivered/cancelled.
const CANCELLABLE = new Set([
    STATUS_PENDING, STATUS_ACCEPTED_DEL, STATUS_ACCEPTED_PICK,
    STATUS_PREPARING, STATUS_OUT, STATUS_READY,
]);

/**
 * nextActions
 *
 * What:  Returns the array of button choices the merchant should see
 *        for one order, given its current status + service mode.
 *        Includes the forward step (if any) AND a "Cancel" entry when
 *        applicable. Empty array for terminal orders.
 * Type:  READ (pure).
 */
function nextActions(order) {
    if (!order) { return []; }
    const code = String(order.order_status || '');
    if (code === STATUS_DELIVERED || code === STATUS_CANCELLED) { return []; }

    const graph = Number(order.serve_type) === 2 ? PICKUP_NEXT : DELIVERY_NEXT;
    const forward = graph[code] || [];
    const out = forward.slice();
    if (CANCELLABLE.has(code)) {
        out.push({ status: STATUS_CANCELLED, label: 'Cancel order', danger: true });
    }
    return out;
}

/**
 * isValidNext
 *
 * What:  True when `nextStatus` appears in the order's nextActions list.
 *        Caller (controller) uses this as the SECOND check before write
 *        — the FIRST is the atomic UPDATE WHERE order_status = current
 *        which is race-safe regardless of what the UI showed.
 * Type:  READ (pure).
 */
function isValidNext(order, nextStatus) {
    const allowed = nextActions(order).map((a) => a.status);
    return allowed.indexOf(String(nextStatus)) !== -1;
}

/**
 * advance
 *
 * What:  Atomic status transition. Only writes when the row still has
 *        the expected current status — so two concurrent merchant
 *        clicks can't double-advance (the second sees rowsUpdated=0
 *        and the controller returns 409).
 *
 *        Returns the rowsUpdated count (0 or 1).
 * Type:  WRITE.
 */
async function advance(orderId, currentStatus, nextStatus, staffCustomerId) {
    if (!orderId) { return 0; }
    return db('orders')
        .where('id', orderId)
        .andWhere('order_status', String(currentStatus))
        .update({
            order_status: String(nextStatus),
            updated_by:   staffCustomerId || null,
            updated_at:   db.fn.now(),
        });
}

module.exports = {
    STATUS_PENDING,
    STATUS_ACCEPTED_DEL,
    STATUS_PREPARING,
    STATUS_OUT,
    STATUS_DELIVERED,
    STATUS_CANCELLED,
    STATUS_ACCEPTED_PICK,
    STATUS_READY,
    nextActions,
    isValidNext,
    advance,
};
