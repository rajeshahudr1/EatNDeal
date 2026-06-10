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
 *        Two timelines (Preparing removed — that stage doesn't exist in
 *        the live system):
 *           DELIVERY: placed → confirmed → out-for-delivery → delivered
 *           PICKUP:   placed → accepted  → ready-to-collect → completed
 *
 *        Status codes are the CANONICAL legacy `orders.order_status` enum
 *        (VARCHAR; '' = completed). Confirmed against the live POS source:
 *           4  = placed              (awaiting accept)
 *           5  = accepted            (PICKUP / in-store — serve_type ≠ 3)
 *           10 = confirmed           (DELIVERY accept — serve_type = 3)
 *           6  = ready-to-collect    (pickup)  /  out-for-delivery (delivery)
 *           '' = completed           (terminal sentinel — empty string)
 *           1  = refund · 2 = cancelled · 9 = void   (terminal badges)
 *
 *        NOTE: code 6 is DUAL-MEANING — its label depends on serve_type
 *        (delivery → "Out for delivery", pickup → "Ready to collect"),
 *        so getStatusMeta() takes serve_type. Accept is 10 for delivery
 *        and 5 for pickup (delivery needs the extra "awaiting dispatch"
 *        state). This file is the SINGLE source of truth for the
 *        code → {label,class,terminal} mapping; orders.js delegates here.
 *
 *        ETA = order.created_at + base_minutes(branch.delivery_waiting_time
 *        copied to orders.delivery_estimated_time) + advanced_order_waiting_time_minute.
 *        Returns minutes-from-now, clamped at 0.
 *
 * Type:  READ (pure).
 */

const M = require('./marketplace');

// serve_type: 3 = delivery; everything else (1 in-store, 2 pickup) takes
// the non-delivery / pickup path. This is the ONLY thing serve_type
// changes about status (the accept code + code-6's meaning + which
// timeline renders).
function isDelivery(serveType) {
    return Number(serveType) === 3;
}

// Canonical status codes (orders.order_status is VARCHAR; '' = completed).
const STATUS = Object.freeze({
    PLACED:    '4',   // awaiting accept
    ACCEPTED:  '5',   // pickup / in-store accept (serve_type ≠ 3)
    CONFIRMED: '10',  // delivery accept (serve_type = 3) — awaiting dispatch
    READY:     '6',   // pickup: ready to collect | delivery: out for delivery
    COMPLETED: '',    // terminal sentinel
    REFUND:    '1',   // terminal
    CANCELLED: '2',   // terminal
    VOID:      '9',   // terminal
});

// Codes that render with the "cancelled" pill colour (the bad terminals).
// COMPLETED ('') is terminal too but is the GOOD end state, so it is not
// in here — it keeps the "completed" colour and stays on the timeline.
const CANCELLED_CODES = ['0', '1', '2', '9'];

/**
 * getStatusMeta
 *
 * What:  THE single code → {label, class, terminal} map. `class` is one of
 *        pending | active | completed | cancelled (drives the pill colour
 *        in the list, detail header + merchant board). Code 6 is
 *        dual-meaning so the label branches on serve_type.
 *
 *        Forward codes we WRITE: 4, 5, 10, 6, '' (+ terminals 1/2/9).
 *        The phantom 3/7/8/11/0 are NOT written any more but are mapped
 *        defensively so any pre-existing row still shows a real label.
 * Type:  READ (pure).
 */
function getStatusMeta(code, serveType) {
    const s = String(code == null ? '' : code);
    switch (s) {
        case '4':  return { label: 'Order placed',  class: 'pending',   terminal: false };
        case '5':  return { label: 'Accepted',      class: 'active',    terminal: false };
        case '10': return { label: 'Confirmed',     class: 'active',    terminal: false };
        case '6':  return isDelivery(serveType)
            ? { label: 'Out for delivery', class: 'active', terminal: false }
            : { label: 'Ready to collect', class: 'active', terminal: false };
        case '':   return { label: 'Completed',     class: 'completed', terminal: true  };
        case '1':  return { label: 'Refunded',      class: 'cancelled', terminal: true  };
        case '2':  return { label: 'Cancelled',     class: 'cancelled', terminal: true  };
        case '9':  return { label: 'Void',          class: 'cancelled', terminal: true  };
        // ── Defensive aliases for codes we no longer write ───────────
        case '3':  return { label: 'Order placed',  class: 'pending',   terminal: false };
        case '7':  return { label: 'Out for delivery', class: 'active', terminal: false };
        case '8':  return { label: 'Completed',     class: 'completed', terminal: true  };
        case '11': return { label: 'Ready to collect', class: 'active', terminal: false };
        case '0':  return { label: 'Cancelled',     class: 'cancelled', terminal: true  };
        default:   return { label: 'Processing',    class: 'active',    terminal: false };
    }
}

// Canonical timelines per service mode (Preparing removed). Each step:
//   key   — stable id the UI uses to colour the step
//   codes — order_status values that light this step (first match wins).
//           Both accept codes (5 & 10) are listed on the accept step in
//           BOTH modes so a row written with either still lights it.
//   label — customer-facing wording for that mode.
const TIMELINES = Object.freeze({
    delivery: [
        { key: 'placed',     codes: ['4', '3'],  label: 'Order placed' },
        { key: 'confirmed',  codes: ['10', '5'], label: 'Confirmed' },
        { key: 'on_the_way', codes: ['6', '7'],  label: 'Out for delivery' },
        { key: 'delivered',  codes: ['', '8'],   label: 'Delivered' },
    ],
    pickup: [
        { key: 'placed',    codes: ['4', '3'],   label: 'Order placed' },
        { key: 'accepted',  codes: ['5', '10'],  label: 'Accepted' },
        { key: 'ready',     codes: ['6', '11'],  label: 'Ready to collect' },
        { key: 'collected', codes: ['', '8'],    label: 'Collected' },
    ],
});

/**
 * timelineFor
 *
 * What:  Returns the canonical step list for the order's service mode.
 *        Delivery iff serve_type === 3; otherwise the pickup timeline.
 * Type:  READ (pure).
 */
function timelineFor(serveType) {
    return isDelivery(serveType) ? TIMELINES.delivery : TIMELINES.pickup;
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
    const serveType = order && order.serve_type;
    const mode = isDelivery(serveType) ? 'delivery' : 'pickup';
    const timeline = timelineFor(serveType);
    const code = String((order && order.order_status) || '');
    const meta = getStatusMeta(code, serveType);
    // 1/2/9 (refund/cancel/void) are off-timeline bad terminals shown as a
    // cancelled bar. COMPLETED ('') is terminal but stays ON the timeline
    // (its last step is "current"), so it is NOT in CANCELLED_CODES.
    const cancelled = CANCELLED_CODES.indexOf(code) !== -1;

    // Find which timeline step the current code belongs to. Placed (4)
    // hits index 0; cancelled / unrecognised codes fall through to 0 so
    // the customer always sees SOME step lit up under the cancelled bar.
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
        // For a bad terminal show the real word (Cancelled/Refunded/Void);
        // otherwise the current stage's friendly label.
        currentLabel: cancelled ? meta.label : timeline[idx].label,
        isCancelled:  cancelled,
        // Poller stops on ANY terminal — the bad ones AND completed ('').
        isTerminal:   cancelled || meta.terminal,
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
    // Use the canonical mapper directly (no round-trip through orders.js)
    // so the label/class honour serve_type (code 6 is dual-meaning).
    const meta = getStatusMeta(order.order_status, order.serve_type);
    const progress = progressForOrder(order);
    return {
        status:        String(order.order_status || ''),
        statusLabel:   meta.label,
        statusClass:   meta.class,
        progress,
        etaMinutes:    etaMinutesFromNow(order),
        etaLabel:      formatEtaLabel(etaMinutesFromNow(order)),
        deliveredAt:   deliveredAt(order),
        updatedAt:     order.updated_at || order.created_at || null,
    };
}

module.exports = {
    STATUS,
    TIMELINES,
    CANCELLED_CODES,
    isDelivery,
    getStatusMeta,
    timelineFor,
    progressForOrder,
    deliveredAt,
    etaMinutesFromNow,
    formatEtaLabel,
    statusSummary,
};
