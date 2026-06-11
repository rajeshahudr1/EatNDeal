/*
 * pages/products.js
 *
 * What:  Drives the product LIST page — inline normal/online price edit,
 *        status change (with the "Unavailable until" date/time modal),
 *        select-all + bulk status + bulk delete, single delete (confirm modal),
 *        and the "Third Party Change" bulk online-price tool. All actions POST
 *        JSON to the admin proxy routes and relay the api envelope.
 * Used:  extra_js for products/list.ejs.
 */
(function () {
    'use strict';

    var toast = window.AdminUi.showToastSafe;
    var ok = window.AdminApi.isSuccess;
    var post = window.AdminApi.post;
    var money = window.AdminUi.money;

    // Searchable category dropdown — filter the option list by the query.
    function filterCatdd(dd, q) {
        q = (q || '').trim().toLowerCase();
        var opts = dd.querySelectorAll('[data-catdd-opt]');
        var shown = 0;
        for (var i = 0; i < opts.length; i++) {
            var li = opts[i].parentNode;
            var match = opts[i].textContent.toLowerCase().indexOf(q) !== -1;
            li.style.display = match ? '' : 'none';
            if (match) { shown++; }
        }
        var empty = dd.querySelector('[data-catdd-empty]'); if (empty) { empty.hidden = shown > 0; }
    }

    var pendingStatus = null;   // { ids:[], selects:[] }  awaiting the until-modal
    var pendingDelete = null;   // { ids:[] }              awaiting the delete-modal

    var selectedIds = window.AdminUi.getSelectedIds;
    var refreshBar = window.AdminUi.refreshActionBar;

    var showModal = window.AdminUi.showModal;
    var hideModals = window.AdminUi.hideModals;

    function revertSelects(selects) { (selects || []).forEach(function (s) { var p = s.getAttribute('data-prev'); if (p != null) { s.value = p; } }); }

    // Apply a status to ids; refresh the row selects + "until" labels on success.
    function applyStatus(ids, status, until, selects) {
        post('/products/status', { ids: ids, status: status, unavailable_until: until || null }).then(function (res) {
            if (ok(res)) {
                toast('success', res.msg || 'Status updated.');
                ids.forEach(function (id) {
                    var sel = document.querySelector('.pr-status[data-id="' + id + '"]');
                    if (sel) { sel.value = String(status); sel.setAttribute('data-prev', String(status)); }
                    var lbl = document.querySelector('[data-until="' + id + '"]');
                    if (lbl) { lbl.hidden = status !== 5; }
                });
            } else {
                toast('error', res.msg || 'Could not update status.');
                revertSelects(selects);
            }
        });
    }
    function handleStatus(ids, status, selects) {
        if (status === 5) { pendingStatus = { ids: ids, selects: selects }; showModal('until'); return; }
        applyStatus(ids, status, null, selects);
    }

    // ── change: checkboxes + status selects ──
    document.addEventListener('change', function (e) {
        var t = e.target;
        if (!t) { return; }
        if (t.classList && t.classList.contains('pr-check')) { refreshBar(); return; }
        if (t.matches && t.matches('[data-action="pr-checkall"]')) {
            var ch = t.checked; var boxes = document.querySelectorAll('.pr-check');
            for (var i = 0; i < boxes.length; i++) { boxes[i].checked = ch; }
            refreshBar(); return;
        }
        if (t.classList && t.classList.contains('pr-status')) {
            handleStatus([Number(t.getAttribute('data-id'))], Number(t.value), [t]); return;
        }
        if (t.matches && t.matches('[data-bulk-status]')) {
            var st = t.value; if (st === '') { return; }
            var ids = selectedIds();
            if (!ids.length) { toast('error', 'Select items first.'); t.value = ''; return; }
            handleStatus(ids, Number(st), []);
            t.value = '';
            return;
        }
        // Sort / page-size change → reload (server-side pagination), back to p1.
        if (t.matches && t.matches('[data-filter-submit]')) {
            var ff = document.getElementById('pr-filter');
            if (ff) { ff.submit(); }
            return;
        }
        // Per-row marketplace on/off toggle.
        if (t.classList && t.classList.contains('pr-mp-toggle')) {
            var mid = Number(t.getAttribute('data-id'));
            var show = t.checked ? 1 : 0;
            post('/products/marketplace', { id: mid, show: show }).then(function (res) {
                if (ok(res)) { toast('success', res.msg || 'Updated.'); }
                else { t.checked = !t.checked; toast('error', res.msg || 'Could not update.'); }
            });
            return;
        }
        // Bulk marketplace on/off for the selected products.
        if (t.matches && t.matches('[data-bulk-marketplace]')) {
            var mv = t.value; if (mv === '') { return; }
            var mids = selectedIds();
            if (!mids.length) { toast('error', 'Select items first.'); t.value = ''; return; }
            var mshow = Number(mv) === 1 ? 1 : 0;
            t.value = '';
            post('/products/marketplace', { ids: mids, show: mshow }).then(function (res) {
                if (ok(res)) {
                    toast('success', res.msg || 'Updated.');
                    mids.forEach(function (id) { var tg = document.querySelector('.pr-mp-toggle[data-id="' + id + '"]'); if (tg) { tg.checked = mshow === 1; } });
                } else { toast('error', res.msg || 'Could not update.'); }
            });
            return;
        }
    });

    // ── inline price edit (blur commits, Enter commits, Esc reverts) ──
    document.addEventListener('keydown', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('pr-priceinput')) { return; }
        if (e.key === 'Escape') { t.value = t.getAttribute('data-original'); t.blur(); }
        else if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    });
    document.addEventListener('input', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('pr-priceinput')) {
            t.value = t.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/g, '$1');
        }
        if (t && t.matches && t.matches('[data-bulk-price-val]')) {
            t.value = t.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\..*/g, '$1');
        }
        if (t && t.matches && t.matches('[data-catdd-search]')) {
            var dd = t.closest('[data-catdd]'); if (dd) { filterCatdd(dd, t.value); }
        }
    });
    document.addEventListener('blur', function (e) {
        var inp = e.target;
        if (!inp || !inp.classList || !inp.classList.contains('pr-priceinput')) { return; }
        var np = inp.value.trim();
        var op = inp.getAttribute('data-original');
        if (np === op) { return; }
        if (np === '') { toast('error', 'Price can not be blank.'); inp.value = op; return; }
        post('/products/price', { id: Number(inp.getAttribute('data-id')), price: np, type: inp.getAttribute('data-type') }).then(function (res) {
            if (ok(res)) { inp.value = money(np); inp.setAttribute('data-original', money(np)); toast('success', 'Price updated.'); }
            else { inp.value = op; toast('error', res.msg || 'Could not update price.'); }
        });
    }, true);

    // ── clicks: clear-all, delete, modals, third-party ──
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) { return; }

        if (t.closest('[data-action="pr-clearall"]')) {
            var boxes = document.querySelectorAll('.pr-check'); for (var i = 0; i < boxes.length; i++) { boxes[i].checked = false; }
            refreshBar(); return;
        }

        // Searchable category dropdown: open / pick / outside-close.
        if (t.closest('[data-catdd-open]')) {
            var dd = t.closest('[data-catdd]');
            var panel = dd && dd.querySelector('[data-catdd-panel]');
            if (panel) {
                var willOpen = panel.hidden; panel.hidden = !willOpen;
                if (willOpen) { var s = dd.querySelector('[data-catdd-search]'); if (s) { s.value = ''; filterCatdd(dd, ''); window.setTimeout(function () { s.focus(); }, 0); } }
            }
            return;
        }
        var catOpt = t.closest('[data-catdd-opt]');
        if (catOpt) {
            var dd2 = catOpt.closest('[data-catdd]');
            var hidden = dd2 && dd2.querySelector('[data-catdd-input]');
            if (hidden) { hidden.value = catOpt.getAttribute('data-cid') || ''; }
            var ff2 = document.getElementById('pr-filter'); if (ff2) { ff2.submit(); }
            return;
        }
        var openPanel = document.querySelector('[data-catdd-panel]:not([hidden])');
        if (openPanel && !t.closest('[data-catdd]')) { openPanel.hidden = true; }

        var del = t.closest('[data-action="pr-delete"]');
        if (del) { pendingDelete = { ids: [Number(del.getAttribute('data-id'))] }; setDeleteMsg('Delete this product?'); showModal('delete'); return; }
        if (t.closest('[data-action="pr-bulk-delete"]')) {
            var ids = selectedIds();
            if (!ids.length) { toast('error', 'Select items first.'); return; }
            pendingDelete = { ids: ids }; setDeleteMsg('Delete ' + ids.length + ' product' + (ids.length > 1 ? 's' : '') + '?'); showModal('delete'); return;
        }

        // Bulk price: open the "set price" modal for the selected items.
        if (t.closest('[data-action="pr-bulk-price-open"]')) {
            var openIds = selectedIds();
            if (!openIds.length) { toast('error', 'Select items first.'); return; }
            var cEl = document.querySelector('[data-bp-count]'); if (cEl) { cEl.textContent = openIds.length; }
            var bpv = document.querySelector('[data-bulk-price-val]'); if (bpv) { bpv.value = ''; }
            showModal('bulkprice');
            if (bpv) { setTimeout(function () { bpv.focus(); }, 50); }
            return;
        }
        // Bulk price: apply (from the modal).
        if (t.closest('[data-action="pr-bulk-price"]')) {
            var bids = selectedIds();
            if (!bids.length) { toast('error', 'Select items first.'); hideModals(); return; }
            var typeSel = document.querySelector('[data-bulk-price-type]');
            var valIn = document.querySelector('[data-bulk-price-val]');
            var bType = typeSel ? typeSel.value : 'normal';
            var bPrice = valIn ? valIn.value.trim() : '';
            if (bPrice === '') { toast('error', 'Enter a price.'); if (valIn) { valIn.focus(); } return; }
            hideModals();
            post('/products/bulk-price', { ids: bids, type: bType, price: bPrice }).then(function (res) {
                if (ok(res)) {
                    toast('success', res.msg || 'Prices updated.');
                    bids.forEach(function (id) {
                        var inp = document.querySelector('.pr-priceinput[data-type="' + bType + '"][data-id="' + id + '"]');
                        if (inp) { inp.value = money(bPrice); inp.setAttribute('data-original', money(bPrice)); }
                    });
                } else { toast('error', res.msg || 'Could not update prices.'); }
            });
            return;
        }
        if (t.closest('[data-action="pr-delete-confirm"]')) {
            if (pendingDelete) {
                var pd = pendingDelete; pendingDelete = null; hideModals();
                post('/products/delete', { ids: pd.ids }).then(function (res) {
                    if (ok(res)) {
                        toast('success', res.msg || 'Deleted.');
                        pd.ids.forEach(function (id) { var el = document.querySelector('.pr-item[data-id="' + id + '"]'); if (el) { el.parentNode.removeChild(el); } });
                        refreshBar();
                    } else { toast('error', res.msg || 'Could not delete.'); }
                });
            } else { hideModals(); }
            return;
        }

        if (t.closest('[data-action="pr-until-confirm"]')) {
            var inp = document.querySelector('[data-until-input]');
            var v = inp && inp.value;
            if (!v) { toast('error', 'Pick a date & time.'); return; }
            if (pendingStatus) { var ps = pendingStatus; pendingStatus = null; applyStatus(ps.ids, 5, v, ps.selects); }
            hideModals();
            return;
        }

        if (t.closest('[data-action="pr-modal-cancel"]')) {
            if (pendingStatus) { revertSelects(pendingStatus.selects); pendingStatus = null; }
            pendingDelete = null; hideModals(); return;
        }
    });

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (pendingStatus) { revertSelects(pendingStatus.selects); pendingStatus = null; } pendingDelete = null; hideModals(); } });

    function setDeleteMsg(msg) { var el = document.querySelector('[data-delete-msg]'); if (el) { el.textContent = msg; } }

    document.addEventListener('DOMContentLoaded', function () {
        var sels = document.querySelectorAll('.pr-status'); for (var i = 0; i < sels.length; i++) { sels[i].setAttribute('data-prev', sels[i].value); }
        // Live search is handled globally in app.js (input[data-live-search]).
    });
})();
