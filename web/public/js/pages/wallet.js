/*
 * pages/wallet.js
 *
 * What:  Loyalty Wallet page — "Load more" for the transaction history. Filter
 *        tabs and the per-restaurant card filter are plain links (server
 *        re-render). This only appends the next page of history rows fetched
 *        from /wallet/json. The row markup mirrors txRow() in wallet/index.ejs.
 * Used:  extra_js for wallet/index.ejs.
 */
(function () {
    'use strict';

    var STATUS = { earned: ['✓', 'Earned'], redeemed: ['↗', 'Redeemed'], expired: ['⏰', 'Expired'], reversed: ['✕', 'Reversed'] };
    // Shared formatting (window.EatNDealFormat / common/format.js). Defensive
    // fallbacks keep the row builder working even if that file failed to load.
    var EF = window.EatNDealFormat || {};
    var money = EF.money || function (n) { return Number(n || 0).toFixed(2); };
    var esc = EF.esc || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var fmtDate = EF.fmtDate || function (d) { if (!d) { return ''; } var dt = new Date(d); if (isNaN(dt.getTime())) { return ''; } return dt.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()] + ' ' + dt.getFullYear(); };
    function buildRow(tx, sym) {
        var st = STATUS[tx.status] || STATUS.earned;
        var amt = '';
        if (Number(tx.earned) > 0) { amt += '<span class="wh-amt wh-amt--earn">+' + sym + money(tx.earned) + '</span>'; }
        if (Number(tx.used) > 0)   { amt += '<span class="wh-amt wh-amt--used">−' + sym + money(tx.used) + '</span>'; }
        // LOCKED stamp rows — "🔒 Reward Locked" + journey note (mirrors the
        // EJS txRow; the api sends tx.locked + tx.stamp for these rows).
        var lockHtml = '';
        if (tx.locked) {
            lockHtml += '<span class="wh-lock">🔒 Reward Locked</span>';
            if (tx.stamp && Number(tx.stamp.required) > 0) {
                lockHtml += '<span class="wh-lock__note">' + tx.stamp.completed + ' / ' + tx.stamp.required + ' stamp orders completed</span>';
                if (Number(tx.stamp.remaining) > 0) {
                    lockHtml += '<span class="wh-lock__note wh-lock__note--todo">' + tx.stamp.remaining + ' more order' + (tx.stamp.remaining === 1 ? '' : 's') + ' needed to unlock</span>';
                }
            }
        }
        return '<div class="wh-row wh-row--' + tx.status + '">'
            + '<span class="wh-row__ic wh-row__ic--' + tx.status + '" aria-hidden="true">' + st[0] + '</span>'
            + '<div class="wh-row__main"><span class="wh-row__title">' + esc(tx.restaurant) + '</span>'
            + '<span class="wh-row__meta">' + esc(tx.type_label || 'Reward') + ' · ' + fmtDate(tx.date)
            + (tx.expiry_date && tx.status === 'earned' ? ' · valid till ' + fmtDate(tx.expiry_date) : '') + '</span>'
            + lockHtml + '</div>'
            + '<div class="wh-row__amt">' + amt + '<span class="wh-badge wh-badge--' + tx.status + '">' + st[1] + '</span></div>'
            + '</div>';
    }

    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('[data-wh-more]');
        if (!btn) { return; }
        var list = document.querySelector('[data-wh-list]');
        if (!list) { return; }
        var offset = Number(list.getAttribute('data-offset')) || 0;
        var total = Number(list.getAttribute('data-total')) || 0;
        var sym = list.getAttribute('data-sym') || '£';
        var qs = new URLSearchParams({ offset: String(offset) });
        var filter = list.getAttribute('data-filter') || '';
        var company = list.getAttribute('data-company') || '';
        if (filter) { qs.set('filter', filter); }
        if (company) { qs.set('company', company); }

        btn.disabled = true; btn.textContent = 'Loading…';
        fetch('/wallet/json?' + qs.toString(), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (res) {
                var txs = (res && res.data && res.data.transactions) || [];
                var html = ''; txs.forEach(function (tx) { html += buildRow(tx, sym); });
                list.insertAdjacentHTML('beforeend', html);
                offset += txs.length;
                list.setAttribute('data-offset', String(offset));
                if (offset >= total || !txs.length) {
                    var more = btn.closest('.wh-more'); if (more && more.parentNode) { more.parentNode.removeChild(more); }
                } else { btn.disabled = false; btn.textContent = 'Load more'; }
            })
            .catch(function () { btn.disabled = false; btn.textContent = 'Load more'; });
    });
})();
