/*
 * ui/order-track.js
 *
 * What:  Live order-tracking module — loaded by the layout, no-op on
 *        every page except the order detail (`[data-order-root]`).
 *
 *        Two clocks:
 *
 *          • Poll  every 30 s — GET /order/<id>/status. On change,
 *            patches the timeline dots / labels / status pill / ETA
 *            in place (no full page reload until terminal).
 *          • Tick  every 60 s — decrements the visible ETA minute
 *            count locally so the customer sees the countdown move
 *            between polls. Server polls reset it to the truth.
 *
 *        Stops both clocks when the server reports `isTerminal`
 *        (delivered / picked-up / cancelled) — and triggers ONE
 *        page reload so the "Delivered. Enjoy!" pill + cancelled
 *        banner state render cleanly.
 *
 *        Tab-visibility: when the tab is hidden, the polling clock
 *        pauses so we don't burn battery / API calls in the background.
 *        Resumes (and fires an immediate poll) when the tab comes back.
 */
(function () {
    'use strict';

    var POLL_MS      = 30 * 1000;       // 30 seconds
    var COUNTDOWN_MS = 60 * 1000;       // 1 minute

    var root         = null;
    var orderId      = null;
    var pollTimer    = null;
    var countdownTimer = null;
    var currentEtaMin = null;

    // ── Helpers ─────────────────────────────────────────────────────
    function q(sel) { return document.querySelector(sel); }
    function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    function readInitialEta() {
        var el = q('[data-order-eta]');
        if (!el) { return null; }
        // Read the raw minutes from the data attribute — parsing the
        // formatted text ("~1h 40m") would mis-read the digits (→140).
        var n = parseInt(el.getAttribute('data-eta-min'), 10);
        return Number.isFinite(n) ? n : null;
    }

    // Format minutes → "X min" / "1h" / "1h 40m" once they cross 60.
    // MUST stay in sync with the server copy (orderStatus.formatEtaLabel).
    function formatEta(min) {
        var n = Math.max(0, Number(min) || 0);
        if (n < 60) { return n + ' min'; }
        var h = Math.floor(n / 60);
        var m = n % 60;
        return m === 0 ? (h + 'h') : (h + 'h ' + m + 'm');
    }

    function renderEta(min) {
        var el = q('[data-order-eta]');
        if (!el) { return; }
        var n = Math.max(0, min);
        el.setAttribute('data-eta-min', String(n));   // keep read-back source accurate
        el.textContent = '~' + formatEta(n);
    }

    // ── Timeline DOM patching ───────────────────────────────────────
    function applyStatus(data) {
        if (!data) { return; }

        // 1. Header status pill (also used by other surfaces — class set
        //    via classList so existing layout classes survive).
        var pill = q('[data-order-status-pill]');
        if (pill && data.statusLabel) {
            pill.textContent = data.statusLabel;
            // Replace just the `--<class>` modifier suffix.
            pill.className = pill.className.replace(/\border-detail__status--[a-z]+\b/g, '').trim();
            pill.classList.add('order-detail__status');
            pill.classList.add('order-detail__status--' + (data.statusClass || 'active'));
        }

        // 2. Current step label above the steps row.
        if (data.progress && data.progress.currentLabel) {
            var curr = q('[data-order-current]');
            if (curr) { curr.textContent = data.progress.currentLabel; }
        }

        // 3. Step dots — state class + dot content (tick vs number).
        if (data.progress && Array.isArray(data.progress.steps)) {
            data.progress.steps.forEach(function (s, i) {
                var li = q('[data-step="' + s.key + '"]');
                if (!li) { return; }
                li.className = 'order-track__step order-track__step--' + s.state;
                var dot = li.querySelector('.order-track__dot');
                if (dot) {
                    if (s.state === 'done') {
                        dot.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                    } else {
                        dot.textContent = String(i + 1);
                    }
                }
            });
        }

        // 4. ETA — server is the source of truth; reset the local
        //    countdown to whatever it reports.
        if (data.etaMinutes != null) {
            currentEtaMin = Number(data.etaMinutes);
            renderEta(currentEtaMin);
        }

        // 5. Terminal → stop clocks + soft reload so the
        //    "Delivered. Enjoy!" / cancelled UI renders properly.
        if (data.progress && data.progress.isTerminal) {
            stop();
            window.setTimeout(function () { window.location.reload(); }, 600);
        }
    }

    // ── Polling ─────────────────────────────────────────────────────
    function poll() {
        return fetch('/order/' + encodeURIComponent(orderId) + '/status', {
            credentials: 'same-origin',
            headers:     { 'Accept': 'application/json' },
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            if (env && env.status === 200 && env.data) { applyStatus(env.data); }
        }).catch(function () { /* swallow — try next interval */ });
    }

    // ── Local countdown (between polls) ─────────────────────────────
    function tick() {
        if (currentEtaMin == null) { return; }
        currentEtaMin = Math.max(0, currentEtaMin - 1);
        renderEta(currentEtaMin);
    }

    // ── Lifecycle ───────────────────────────────────────────────────
    function start() {
        if (pollTimer == null)      { pollTimer      = window.setInterval(poll, POLL_MS); }
        if (countdownTimer == null) { countdownTimer = window.setInterval(tick, COUNTDOWN_MS); }
    }
    function stop() {
        if (pollTimer)      { window.clearInterval(pollTimer);      pollTimer = null; }
        if (countdownTimer) { window.clearInterval(countdownTimer); countdownTimer = null; }
    }

    function onVisibility() {
        if (document.hidden) {
            stop();
        } else {
            start();
            // Catch up immediately when the tab regains focus.
            poll();
        }
    }

    function init() {
        root = q('[data-order-root]');
        if (!root) { return; }                       // not the order page
        orderId = root.getAttribute('data-order-id');
        if (!orderId) { return; }
        var isTerminal = root.getAttribute('data-order-terminal') === '1';
        if (isTerminal) { return; }                   // nothing to refresh

        currentEtaMin = readInitialEta();
        start();
        document.addEventListener('visibilitychange', onVisibility);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
