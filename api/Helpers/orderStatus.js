'use strict';

/*
 * Helpers/orderStatus.js
 *
 * What:  Order timeline + ETA logic for the live tracking page.
 *
 *        Two surfaces depend on this:
 *           • GET /api/v1/customer/order/status — slim polling endpoint
 *             (just the bits that change as the kitchen advances the order).
 *           • Helpers/orders.loadDetail — full detail page payload
 *             (we merge progress + eta in there too so the first paint
 *             is data-complete).
 *
 *        Two timelines:
 *           DELIVERY: placed → accepted → preparing → out-for-delivery → delivered
 *           PICKUP:   placed → accepted → preparing → ready → picked-up
 *
 *        Status codes follow the legacy `orders.order_status` enum:
 *           3/4 = pending     5 = accepted (delivery)
 *           6   = preparing   7 = out for delivery     8 = delivered/picked-up
 *           10  = accepted (pickup)                    11 = ready for pickup
 *           0/2/9 = cancelled (terminal at any step)
 *
 *        ETA = order.created_at + base_minutes(branch.delivery_waiting_time
 *        copied to orders.delivery_estimated_time) + advanced_order_waiting_time_minute.
 *        Returns minutes-from-now, clamped at 0.
 *
 * Type:  READ (pure).
 */

const M = require('./marketplace');

// Canonical timelines per service mode. Each step carries:
//   key     — stable id the UI uses to colour the step
//   codes   — legacy order_status values that map to this step
//   label   — customer-facing wording
const TIMELINES = Object.freeze({
    delivery: [
        { key: 'placed',      codes: ['3', '4'], label: 'Order placed' },
        { key: 'accepted',    codes: ['5'],      label: 'Accepted' },
        { key: 'preparing',   codes: ['6'],      label: 'Preparing' },
        { key: 'out_for_del', codes: ['7'],      label: 'Out for delivery' },
        { key: 'delivered',   codes: ['8'],      label: 'Delivered' },
    ],
    pickup: [
        { key: 'placed',      codes: ['3', '4'], label: 'Order placed' },
        { key: 'accepted',    codes: ['10'],     label: 'Accepted' },
        { key: 'preparing',   codes: ['6'],      label: 'Preparing' },
        { key: 'ready',       codes: ['11'],     label: 'Ready for pickup' },
        { key: 'picked_up',   codes: ['8'],      label: 'Picked up' },
    ],
});

const CANCELLED_CODES = ['0', '2', '9'];

/**
 * timelineFor
 *
 * What:  Returns the canonical step list for the order's service mode.
 * Type:  READ (pure).
 */
function timelineFor(serveType) {
    return Number(serveType) === 2 ? TIMELINES.pickup : TIMELINES.delivery;
}

/**
 * progressForOrder
 *
 * What:  Maps an orders row to a UI-ready progress descriptor:
 *
 *           {
 *             mode:         'delivery' | 'pickup',
 *             currentKey:   one of the timeline's step.key values,
 *             currentLabel: human-friendly current step,
 *             isCancelled:  true when status is 0/2/9,
 *             isTerminal:   true when delivered/cancelled (polling can stop),
 *             steps: [{ key, label, state }, ...]
 *                       state: 'done' | 'current' | 'pending' | 'cancelled'
 *           }
 *
 * Type:  READ (pure).
 */
function progressForOrder(order) {
    const mode = Number(order && order.serve_type) === 2 ? 'pickup' : 'delivery';
    const timeline = timelineFor(order && order.serve_type);
    const code = String((order && order.order_status) || '');
    const cancelled = CANCELLED_CODES.indexOf(code) !== -1;

    // Find which timeline step the current code belongs to. Pending /
    // placed (3 or 4) hits index 0; unrecognised codes fall through to 0
    // so the customer always sees SOME step lit up.
    let idx = -1;
    for (let i = 0; i < timeline.length; i++) {
        if (timeline[i].codes.indexOf(code) !== -1) { idx = i; break; }
    }
    if (idx === -1) { idx = 0; }

    const steps = timeline.map((s, i) => ({
        key:   s.key,
        label: s.label,
        state: cancelled
            ? 'cancelled'
            : (i <  idx ? 'done'
            : (i === idx ? 'current'
            :              'pending')),
    }));

    return {
        mode,
        currentKey:   timeline[idx].key,
        currentLabel: cancelled ? 'Cancelled' : timeline[idx].label,
        isCancelled:  cancelled,
        isTerminal:   cancelled || code === '8',
        steps,
    };
}

/**
 * deliveredAt
 *
 * What:  When SHOULD this order arrive (or be ready)? Computed as
 *           placedAt + baseMinutes + advancedOrderWaitingTimeMinute
 *        Returns a Date or null when timing data is missing.
 *
 *        baseMinutes is parsed from orders.delivery_estimated_time
 *        (the time-of-day-encoded value the legacy POS stores; see
 *        marketplace.deliveryMinutesFromWaiting for the formula).
 * Type:  READ (pure).
 */
function deliveredAt(order) {
    if (!order || !order.created_at) { return null; }
    const placed = new Date(order.created_at);
    if (!Number.isFinite(placed.getTime())) { return null; }
    const base = M.deliveryMinutesFromWaiting(order.delivery_estimated_time) || 0;
    const adv  = Number(order.advanced_order_waiting_time_minute) || 0;
    const totalMin = base + adv;
    if (totalMin <= 0) { return null; }
    return new Date(placed.getTime() + totalMin * 60 * 1000);
}

/**
 * etaMinutesFromNow
 *
 * What:  Whole minutes between now and deliveredAt(order). Clamped at 0
 *        so a stale order doesn't show negative time. Returns null when
 *        no timing info is available.
 *        After the order is delivered / cancelled, etaMinutes is 0 and
 *        the polling caller should stop refreshing.
 * Type:  READ (clock).
 */
function etaMinutesFromNow(order, nowMs) {
    const due = deliveredAt(order);
    if (!due) { return null; }
    const now = nowMs != null ? Number(nowMs) : Date.now();
    const ms  = due.getTime() - now;
    return Math.max(0, Math.round(ms / 60000));
}

/**
 * formatEtaLabel
 *
 * What:  Turns whole minutes into a customer-facing label that rolls
 *        into hours once it reaches 60 — so an ETA never reads an
 *        awkward "~100 min". Mirrors the cadence the marketplace's
 *        delivery-time chips use.
 *          18  → "18 min"
 *          60  → "1h"
 *          100 → "1h 40m"
 *          135 → "2h 15m"
 *          null → null   (no due time yet)
 * Type:  READ (pure). Must stay in sync with the client copy in
 *        /js/ui/order-track.js (formatEta).
 */
function formatEtaLabel(min) {
    if (min == null) { return null; }
    const n = Math.max(0, Number(min) || 0);
    if (n < 60) { return n + ' min'; }
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m === 0 ? (h + 'h') : (h + 'h ' + m + 'm');
}

/**
 * statusSummary
 *
 * What:  THE shape the polling endpoint returns. All UI-relevant timing
 *        in one object so the client can refresh the badge + countdown
 *        + timeline atomically from one response.
 * Type:  READ.
 */
function statusSummary(order) {
    const orders = require('./orders');
    const progress = progressForOrder(order);
    return {
        status:        String(order.order_status || ''),
        statusLabel:   orders.statusLabel(order.order_status),
        statusClass:   orders.statusClass(order.order_status),
        progress,
        etaMinutes:    etaMinutesFromNow(order),
        etaLabel:      formatEtaLabel(etaMinutesFromNow(order)),
        deliveredAt:   deliveredAt(order),
        updatedAt:     order.updated_at || order.created_at || null,
    };
}

module.exports = {
    TIMELINES,
    CANCELLED_CODES,
    timelineFor,
    progressForOrder,
    deliveredAt,
    etaMinutesFromNow,
    formatEtaLabel,
    statusSummary,
};
