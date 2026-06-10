'use strict';

/*
 * Helpers/orderAdvance.js
 *
 * What:  Status-transition rules for the merchant dashboard.
 *
 *        Two flows the merchant controls (codes match the live POS;
 *        Preparing removed, completion is '' not 8):
 *
 *          DELIVERY (serve_type = 3):
 *            Placed (4)   → Confirmed (10)
 *            Confirmed    → Out for delivery (6)
 *            Out          → Delivered / Completed ('')
 *            (active)     → Cancelled (2)
 *
 *          PICKUP / in-store (serve_type ≠ 3):
 *            Placed (4)   → Accepted (5)
 *            Accepted     → Ready to collect (6)
 *            Ready        → Picked up / Completed ('')
 *            (active)     → Cancelled (2)
 *
 *        Note code 6 is the same value in both modes — its meaning
 *        (out-for-delivery vs ready-to-collect) is decided by serve_type,
 *        exactly like the legacy system. Completion writes the empty
 *        string '' (the legacy COMPLETED sentinel), NOT 8.
 *
 *        `nextActions(order)` returns the UI-ready list of buttons the
 *        merchant should see right now (label + target status). The
 *        controller calls advance(order, nextStatus) which writes the
 *        update atomically — UPDATE ... WHERE order_status = current,
 *        so two concurrent merchant clicks can't double-advance.
 *
 *        Cancel writes 2 (CANCELLED) — matching the legacy
 *        actionCancelorder; once any terminal ('' / 1 / 2 / 9) is
 *        reached, no further transitions are offered.
 *
 * Type:  READ + WRITE.
 * Used:  api/Controllers/Merchant/OrdersController.js · advance / cancel
 */

const { db } = require('../config/db');

const STATUS_PLACED    = '4';   // awaiting accept
const STATUS_ACCEPTED  = '5';   // pickup / in-store accept (serve_type ≠ 3)
const STATUS_CONFIRMED = '10';  // delivery accept (serve_type = 3)
const STATUS_READY     = '6';   // pickup: ready to collect | delivery: out for delivery
const STATUS_COMPLETED = '';    // delivered / picked up (terminal sentinel)
const STATUS_CANCELLED = '2';   // cancelled (terminal)

// Every terminal code — no forward/cancel actions once here.
// ('' completed · 1 refund · 2 cancelled · 9 void)
const TERMINAL = new Set([STATUS_COMPLETED, '1', STATUS_CANCELLED, '9']);

// Per-mode transition graph. Each key is the current status; value is
// an array of valid next steps {status, label}.
const DELIVERY_NEXT = Object.freeze({
    [STATUS_PLACED]:    [{ status: STATUS_CONFIRMED, label: 'Accept' }],
    [STATUS_CONFIRMED]: [{ status: STATUS_READY,     label: 'Mark out for delivery' }],
    [STATUS_READY]:     [{ status: STATUS_COMPLETED, label: 'Mark delivered' }],
});

const PICKUP_NEXT = Object.freeze({
    [STATUS_PLACED]:   [{ status: STATUS_ACCEPTED, label: 'Accept' }],
    [STATUS_ACCEPTED]: [{ status: STATUS_READY,    label: 'Mark ready' }],
    [STATUS_READY]:    [{ status: STATUS_COMPLETED, label: 'Mark picked up' }],
});

// Cancellable from any active (non-terminal) state.
const CANCELLABLE = new Set([
    STATUS_PLACED, STATUS_ACCEPTED, STATUS_CONFIRMED, STATUS_READY,
]);

/**
 * nextActions
 *
 * What:  Returns the array of button choices the merchant should see
 *        for one order, given its current status + service mode.
 *        Includes the forward step (if any) AND a "Cancel" entry when
 *        applicable. Empty array for terminal orders.
 *        Delivery iff serve_type === 3; otherwise the pickup graph.
 * Type:  READ (pure).
 */
function nextActions(order) {
    if (!order) { return []; }
    const code = String(order.order_status || '');
    if (TERMINAL.has(code)) { return []; }

    const graph = Number(order.serve_type) === 3 ? DELIVERY_NEXT : PICKUP_NEXT;
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
    STATUS_PLACED,
    STATUS_ACCEPTED,
    STATUS_CONFIRMED,
    STATUS_READY,
    STATUS_COMPLETED,
    STATUS_CANCELLED,
    TERMINAL,
    nextActions,
    isValidNext,
    advance,
};
