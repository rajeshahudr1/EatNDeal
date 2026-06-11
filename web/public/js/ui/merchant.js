/*
 * ui/merchant.js
 *
 * What:  Merchant dashboard bindings — loaded by the layout, no-op on
 *        every page except [data-merchant-root].
 *
 *        Three jobs:
 *
 *          • Advance buttons → POST /merchant/order/advance with the
 *            order id, expected current status (server's idempotency
 *            key) and the target status. On 200, patches the row's
 *            status pill + actions; on 409 ("already moved on"), soft-
 *            reloads so the merchant sees the current truth.
 *
 *          • Poll every 15 s → GET /merchant/orders/data?state=<...>
 *            so new pending orders surface within a quarter minute
 *            without a manual refresh. Pulse-highlights newly-seen
 *            order ids briefly.
 *
 *          • Tab-visibility: pause polling when the tab is hidden;
 *            resume + immediate poll when it comes back.
 *
 *        DOM-patching is deliberately limited: we only swap the status
 *        pill text + class + actions HTML. New rows trigger a full
 *        soft reload so we don't reimplement the EJS card markup in JS.
 */
(function () {
    'use strict';

    var POLL_MS = 15 * 1000;

    var root      = null;
    var list      = null;
    var state     = 'live';
    var pollTimer = null;
    var lastIds   = new Set();

    function q(sel, ctx) { return (ctx || document).querySelector(sel); }
    var qa = (window.EatNDealDom && window.EatNDealDom.queryAll) || function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    // Custom confirm — replaces native window.confirm.
    function confirmDialog(opts) {
        if (window.EatNDealUi && window.EatNDealUi.confirmDialog) {
            return window.EatNDealUi.confirmDialog(opts);
        }
        return Promise.resolve(window.confirm(opts && opts.message || ''));
    }

    // ── Advance button ──────────────────────────────────────────────
    function onAdvance(ev, btn) {
        ev.preventDefault();
        var row = btn.closest('[data-order-id]');
        if (!row) { return; }
        var orderId        = btn.getAttribute('data-order-id');
        var expectedStatus = btn.getAttribute('data-expected-status');
        var nextStatus     = btn.getAttribute('data-next-status');
        // nextStatus is '' for the final "Mark delivered / picked up" step
        // (COMPLETED is the empty-string sentinel), so guard on null
        // (attribute absent), NOT falsiness — '' is a valid target.
        if (!orderId || !expectedStatus || nextStatus == null) { return; }

        // "Cancel order" needs a confirm — it's a destructive action.
        if (btn.classList.contains('merchant-btn--danger')) {
            return confirmDialog({
                title:   'Cancel this order?',
                message: 'The customer will be notified that their order was cancelled. This can\'t be undone.',
                okLabel: 'Cancel order',
                cancelLabel: 'Keep order',
            }).then(function (ok) {
                if (ok) { doAdvance(row, orderId, expectedStatus, nextStatus); }
            });
        }
        doAdvance(row, orderId, expectedStatus, nextStatus);
    }

    function doAdvance(row, orderId, expectedStatus, nextStatus) {
        row.classList.add('is-busy');
        fetch('/merchant/order/advance', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify({
                order_id:        orderId,
                expected_status: expectedStatus,
                next_status:     nextStatus,
            }),
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            if (!env) { toast('error', 'Could not reach the server.'); row.classList.remove('is-busy'); return; }
            if (env.status === 401) {
                window.location.href = '/signin?next=' + encodeURIComponent('/merchant');
                return;
            }
            if (env.status === 409) {
                // Another tab / staff member advanced first; reload to
                // see the current truth.
                toast('info', env.msg || 'Order has changed — refreshing.');
                window.setTimeout(function () { window.location.reload(); }, 400);
                return;
            }
            if (env.status !== 200 || !env.data || !env.data.order) {
                toast('error', env.msg || 'Could not update the order.');
                row.classList.remove('is-busy');
                return;
            }
            // Soft reload so the row's pill, action buttons + position
            // in the list (Live → Completed) all refresh from the server
            // without reimplementing the EJS card in JS.
            toast('success', env.msg || 'Updated.');
            window.setTimeout(function () { window.location.reload(); }, 400);
        }).catch(function () {
            toast('error', 'Could not update the order.');
            row.classList.remove('is-busy');
        });
    }

    // ── Polling for new orders ──────────────────────────────────────
    function indexCurrentIds() {
        lastIds = new Set(qa('[data-merchant-list] [data-order-id]', root).map(function (li) {
            return li.getAttribute('data-order-id');
        }));
    }

    function poll() {
        if (!list) { return; }
        var qs = 'state=' + encodeURIComponent(state);
        fetch('/merchant/orders/data?' + qs, {
            credentials: 'same-origin',
            headers:     { 'Accept': 'application/json' },
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            if (!env || env.status !== 200 || !env.data || !env.data.orders) { return; }
            var newIds = env.data.orders.map(function (o) { return String(o.id); });

            // Did we see anything genuinely new since the last poll?
            // (existence-diff only — we let a reload fetch the full
            //  card markup rather than building it in JS.)
            var fresh = newIds.filter(function (id) { return !lastIds.has(id); });
            if (fresh.length) {
                toast('info', fresh.length + ' new order' + (fresh.length === 1 ? '' : 's') + ' — refreshing.');
                window.setTimeout(function () { window.location.reload(); }, 400);
                return;
            }

            // Order id-set unchanged but the count display may want to
            // reflect a status change away from the current state.
            var sub = q('[data-merchant-count]');
            if (sub) {
                sub.textContent = env.data.orders.length + ' in this view · auto-refreshes every 15 s';
            }

            // Did any visible card's status change? Reload if so so the
            // pill + action buttons rebuild server-side.
            var changed = env.data.orders.some(function (o) {
                var li = q('[data-merchant-list] [data-order-id="' + o.id + '"]', root);
                if (!li) { return false; }
                return li.getAttribute('data-order-status') !== String(o.status);
            });
            if (changed) {
                window.setTimeout(function () { window.location.reload(); }, 300);
            }
        }).catch(function () { /* swallow — try next interval */ });
    }

    function startPolling() {
        if (pollTimer != null) { return; }
        pollTimer = window.setInterval(poll, POLL_MS);
    }
    function stopPolling() {
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
    }
    function onVisibility() {
        if (document.hidden) { stopPolling(); }
        else                 { startPolling(); poll(); }
    }

    // ── Single document delegate ────────────────────────────────────
    function onClick(ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('[data-action]');
        if (!btn) { return; }
        if (btn.getAttribute('data-action') === 'merchant-advance') {
            onAdvance(ev, btn);
        }
    }

    function init() {
        root = q('[data-merchant-root]');
        if (!root) { return; }
        list = q('[data-merchant-list]', root);
        if (list) {
            state = list.getAttribute('data-state') || 'live';
            indexCurrentIds();
            startPolling();
            document.addEventListener('visibilitychange', onVisibility);
        }
        document.addEventListener('click', onClick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
