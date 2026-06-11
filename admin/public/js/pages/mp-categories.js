/*
 * pages/mp-categories.js
 *
 * What:  Drives the marketplace-category LIST —
 *          • select-all, inline status, bulk status, single + bulk delete
 *          • restaurant (company) filter autocomplete
 *          • single + bulk "assign restaurants" (autocomplete + chips)
 *          • click-the-count → that category's restaurant list
 *          • pointer-based drag-and-drop reordering (mouse + touch) with save
 *        Live search, sort/page-size and the loader are handled globally (app.js).
 * Used:  extra_js for marketplace-categories/list.ejs.
 */
(function () {
    'use strict';

    /* ---- small helpers ------------------------------------------------ */
    var toast = window.AdminUi.showToastSafe;
    var ok = window.AdminApi.isSuccess;
    var post = window.AdminApi.post;
    var getJson = window.AdminApi.getJson;
    var esc = window.AdminUi.escapeHtml;
    var debounce = window.AdminUi.debounce;

    var pendingDelete = null;

    /* ---- selection / action bar --------------------------------------- */
    var selectedIds = window.AdminUi.getSelectedIds;
    var refreshBar = window.AdminUi.refreshActionBar;
    var showModal = window.AdminUi.showModal;
    var hideModals = window.AdminUi.hideModals;
    function setDeleteMsg(m) { var el = document.querySelector('[data-delete-msg]'); if (el) { el.textContent = m; } }

    function applyStatus(ids, status, selects) {
        post('/marketplace-categories/status', { ids: ids, status: status }).then(function (res) {
            if (ok(res)) {
                toast('success', res.msg || 'Status updated.');
                ids.forEach(function (id) { var s = document.querySelector('.mpc-status[data-id="' + id + '"]'); if (s) { s.value = String(status); s.setAttribute('data-prev', String(status)); } });
            } else {
                toast('error', res.msg || 'Could not update status.');
                (selects || []).forEach(function (s) { var p = s.getAttribute('data-prev'); if (p != null) { s.value = p; } });
            }
        });
    }

    /* ================================================================== *
     *  Restaurant autocomplete (shared)                                  *
     *  rootEl carries [data-ac]; input [data-ac-input], panel [data-ac-  *
     *  panel]. onSelect(item) fires when an option is chosen.            *
     * ================================================================== */
    function initAutocomplete(root, onSelect, opts) {
        if (!root || root.__acInit) { return null; }
        root.__acInit = true;
        opts = opts || {};
        var input = root.querySelector('[data-ac-input]');
        var panel = root.querySelector('[data-ac-panel]');
        if (!input || !panel) { return null; }

        function close() { panel.hidden = true; panel.innerHTML = ''; }
        function excluded() { return opts.exclude ? (opts.exclude() || {}) : {}; }
        function render(items) {
            var ex = excluded();
            // Hide restaurants that are already added (chips), per request.
            var list = (items || []).filter(function (it) { return !ex[it.id]; });
            if (!list.length) {
                panel.innerHTML = '<div class="mpc-ac__empty">' + ((items && items.length) ? 'All matches are already added.' : 'No restaurants found.') + '</div>';
                panel.hidden = false; return;
            }
            panel.innerHTML = list.map(function (it) {
                return '<button type="button" class="mpc-ac__opt" data-ac-id="' + it.id + '" data-ac-name="' + esc(it.name) + '" data-ac-detail="' + esc(it.detail || '') + '">'
                    + '<span class="mpc-ac__optname">' + esc(it.name) + '</span>'
                    + (it.detail ? '<span class="mpc-ac__optsub">' + esc(it.detail) + '</span>' : '')
                    + '</button>';
            }).join('');
            panel.hidden = false;
        }
        var fetchList = debounce(function (q) {
            getJson('/marketplace-categories/companies?limit=10&q=' + encodeURIComponent(q)).then(function (res) {
                if (ok(res) && res.data) { render(res.data.companies || []); } else { render([]); }
            });
        }, 300);

        input.addEventListener('focus', function () { fetchList(input.value.trim()); });
        input.addEventListener('input', function () { fetchList(input.value.trim()); });
        panel.addEventListener('mousedown', function (e) {
            var opt = e.target.closest('[data-ac-id]');
            if (!opt) { return; }
            e.preventDefault();
            onSelect({ id: Number(opt.getAttribute('data-ac-id')), name: opt.getAttribute('data-ac-name'), detail: opt.getAttribute('data-ac-detail') });
        });
        // Close on outside click / blur.
        document.addEventListener('click', function (e) { if (!root.contains(e.target)) { close(); } });
        return { close: close, input: input };
    }

    /* ---- filter autocomplete (top toolbar) ---------------------------- */
    function initFilterAc() {
        var root = document.querySelector('[data-ac="filter"]');
        if (!root) { return; }
        var hidden = root.querySelector('[data-ac-value]');
        var form = document.getElementById('pr-filter');
        initAutocomplete(root, function (item) {
            if (hidden) { hidden.value = item.id; }
            var inp = root.querySelector('[data-ac-input]'); if (inp) { inp.value = item.name; }
            if (form) { form.submit(); }
        });
        var clearBtn = root.querySelector('[data-ac-clear]');
        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                if (hidden) { hidden.value = ''; }
                var inp = root.querySelector('[data-ac-input]'); if (inp) { inp.value = ''; }
                if (form) { form.submit(); }
            });
        }
    }

    /* ================================================================== *
     *  Assign restaurants modal (single + bulk)                          *
     * ================================================================== */
    var assignState = { categoryIds: [], chips: {}, single: false }; // chips: id -> {name, detail}

    function selBox() { return document.querySelector('[data-assign-chips]'); }
    function renderChips() {
        var box = selBox(); if (!box) { return; }
        var ids = Object.keys(assignState.chips);
        var head = document.querySelector('[data-assign-selcount]');
        if (head) { head.textContent = ids.length; }
        if (!ids.length) { box.innerHTML = '<div class="mpc-sellist__empty">No restaurants selected yet.</div>'; return; }
        box.innerHTML = ids.map(function (id) {
            var it = assignState.chips[id] || {};
            return '<div class="mpc-selrow" data-sel="' + id + '">'
                + '<span class="mpc-selrow__txt"><span class="mpc-selrow__name">' + esc(it.name) + '</span>'
                + (it.detail ? '<span class="mpc-selrow__sub">' + esc(it.detail) + '</span>' : '') + '</span>'
                + '<button type="button" class="mpc-selrow__x" data-chip-x="' + id + '" aria-label="Remove">✕</button>'
                + '</div>';
        }).join('');
    }
    function addChip(item) { assignState.chips[item.id] = { name: item.name, detail: item.detail || '' }; renderChips(); }
    function removeChip(id) { delete assignState.chips[id]; renderChips(); }
    function setAssignErr(msg) { var el = document.querySelector('[data-assign-err]'); if (el) { if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; } } }

    function openAssign(opts) {
        assignState.categoryIds = opts.categoryIds.slice();
        assignState.chips = {};
        assignState.single = !!opts.single;
        setAssignErr('');
        var title = document.querySelector('[data-assign-title]');
        var sub = document.querySelector('[data-assign-sub]');
        var modeRow = document.querySelector('[data-assign-moderow]');
        var acInput = document.querySelector('[data-ac="assign"] [data-ac-input]');
        if (acInput) { acInput.value = ''; }

        if (opts.single) {
            if (title) { title.textContent = 'Assign restaurants'; }
            if (sub) { sub.textContent = opts.name + ' — add or remove its restaurants, then save.'; }
            if (modeRow) { modeRow.hidden = true; } // single = full replace of its set
            renderChips();
            showModal('assign');
            // Preload its current restaurants into the selected list.
            getJson('/marketplace-categories/restaurants?id=' + opts.categoryIds[0]).then(function (res) {
                if (ok(res) && res.data && res.data.restaurants) {
                    res.data.restaurants.forEach(function (r) { assignState.chips[r.id] = { name: r.name, detail: r.detail || '' }; });
                    renderChips();
                }
            });
        } else {
            if (title) { title.textContent = 'Assign restaurants'; }
            if (sub) { sub.textContent = 'Apply to ' + opts.categoryIds.length + ' selected categor' + (opts.categoryIds.length === 1 ? 'y' : 'ies') + '.'; }
            if (modeRow) { modeRow.hidden = false; var add = modeRow.querySelector('input[value="add"]'); if (add) { add.checked = true; } }
            renderChips();
            showModal('assign');
        }
    }

    function saveAssign() {
        var ids = Object.keys(assignState.chips).map(Number);
        if (!assignState.single && !ids.length) { setAssignErr('Pick at least one restaurant.'); return; }
        var mode = 'set';
        if (!assignState.single) {
            var checked = document.querySelector('[data-assign-moderow] input[name="assignmode"]:checked');
            mode = (checked && checked.value === 'set') ? 'set' : 'add';
        }
        post('/marketplace-categories/assign', { category_ids: assignState.categoryIds, company_ids: ids, mode: mode }).then(function (res) {
            if (ok(res)) {
                toast('success', res.msg || 'Restaurants assigned.');
                hideModals();
                setTimeout(function () { window.location.reload(); }, 350);
            } else { setAssignErr(res.msg || 'Could not assign restaurants.'); }
        });
    }

    function initAssignAc() {
        var root = document.querySelector('[data-ac="assign"]');
        if (!root) { return; }
        var ac = initAutocomplete(root, function (item) {
            addChip(item);
            var inp = root.querySelector('[data-ac-input]'); if (inp) { inp.value = ''; }
            if (ac && ac.close) { ac.close(); } // close the dropdown after a pick
        }, { exclude: function () { return assignState.chips; } });
    }

    /* ---- restaurants-of-a-category list modal ------------------------- */
    function openRestaurants(id, name) {
        var title = document.querySelector('[data-rest-title]');
        var listEl = document.querySelector('[data-rest-list]');
        if (title) { title.textContent = name + ' — restaurants'; }
        if (listEl) { listEl.innerHTML = '<p class="mpc-restlist__loading">Loading…</p>'; }
        showModal('restaurants');
        getJson('/marketplace-categories/restaurants?id=' + id).then(function (res) {
            if (!listEl) { return; }
            if (ok(res) && res.data && res.data.restaurants) {
                var rs = res.data.restaurants;
                if (title) { title.textContent = name + ' — ' + rs.length + ' restaurant' + (rs.length === 1 ? '' : 's'); }
                if (!rs.length) { listEl.innerHTML = '<p class="mpc-restlist__empty">No restaurants assigned yet.</p>'; return; }
                listEl.innerHTML = '<ul class="mpc-restlist__ul">' + rs.map(function (r, i) {
                    return '<li class="mpc-restlist__li">'
                        + '<span class="mpc-restlist__no">' + (i + 1) + '</span>'
                        + '<span class="mpc-restlist__txt"><span class="mpc-restlist__name">' + esc(r.name) + '</span>'
                        + (r.detail ? '<span class="mpc-restlist__sub">' + esc(r.detail) + '</span>' : '') + '</span>'
                        + '</li>';
                }).join('') + '</ul>';
            } else { listEl.innerHTML = '<p class="mpc-restlist__empty">' + esc((res && res.msg) || 'Could not load.') + '</p>'; }
        });
    }

    /* ================================================================== *
     *  Pointer-based drag-and-drop reorder (mouse + touch)               *
     * ================================================================== */
    function initReorder() {
        var list = document.querySelector('[data-list][data-draggable]');
        if (!list) { return; }
        var bar = document.querySelector('[data-reorderbar]');       // optional (arrange page has none)
        var isArrange = list.hasAttribute('data-arrange');           // arrange page → live position numbers
        var originalOrder = itemIds();
        var drag = null;
        var lastY = 0, scrollDir = 0, rafId = null;

        function itemIds() { return Array.prototype.map.call(list.querySelectorAll('.pr-item'), function (it) { return Number(it.getAttribute('data-id')); }); }
        function orderChanged() { var a = itemIds(), b = originalOrder; if (a.length !== b.length) { return true; } for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return true; } } return false; }
        function showBar() { if (bar) { bar.hidden = !orderChanged(); } }
        // Live-number the #position cells (arrange page) so they reflect the order.
        function renumber() {
            if (!isArrange) { return; }
            Array.prototype.forEach.call(list.querySelectorAll('.pr-item'), function (it, i) {
                var c = it.querySelector('.mpc-sortcell'); if (c) { c.textContent = '#' + (i + 1); }
            });
        }

        function afterElement(y) {
            var items = Array.prototype.slice.call(list.querySelectorAll('.pr-item:not(.is-dragging)'));
            for (var i = 0; i < items.length; i++) {
                var box = items[i].getBoundingClientRect();
                if (y < box.top + box.height / 2) { return items[i]; }
            }
            return null;
        }
        function reposition(y) {
            if (!drag) { return; }
            var ref = afterElement(y);
            if (ref == null) { list.appendChild(drag.el); }
            else if (ref !== drag.el) { list.insertBefore(drag.el, ref); }
        }

        // Auto-scroll the window while dragging near the top / bottom edge.
        function tick() {
            if (!drag || scrollDir === 0) { rafId = null; return; }
            window.scrollBy(0, scrollDir * 14);
            reposition(lastY);
            rafId = window.requestAnimationFrame(tick);
        }
        function updateAutoScroll(y) {
            var edge = 90;
            var h = window.innerHeight || document.documentElement.clientHeight;
            scrollDir = (y < edge) ? -1 : (y > h - edge ? 1 : 0);
            if (scrollDir !== 0 && rafId == null) { rafId = window.requestAnimationFrame(tick); }
        }

        list.addEventListener('pointerdown', function (e) {
            var handle = e.target.closest('[data-drag-handle]');
            if (!handle) { return; }
            var item = handle.closest('.pr-item');
            if (!item) { return; }
            e.preventDefault();
            drag = { el: item };
            lastY = e.clientY;
            item.classList.add('is-dragging');
            list.classList.add('mpc-list--dragging');
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });

        list.addEventListener('pointermove', function (e) {
            if (!drag) { return; }
            e.preventDefault();
            lastY = e.clientY;
            reposition(lastY);
            updateAutoScroll(lastY);
        });

        function endDrag() {
            if (!drag) { return; }
            drag.el.classList.remove('is-dragging');
            list.classList.remove('mpc-list--dragging');
            drag = null; scrollDir = 0;
            if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; }
            renumber();
            showBar();
        }
        list.addEventListener('pointerup', endDrag);
        list.addEventListener('pointercancel', endDrag);

        // Move a row up / down via the arrow buttons (no drag needed).
        function moveRow(item, dir) {
            if (!item) { return; }
            if (dir < 0) { var prev = item.previousElementSibling; if (prev) { list.insertBefore(item, prev); } }
            else { var next = item.nextElementSibling; if (next) { list.insertBefore(next, item); } }
            item.classList.add('is-moved');
            window.setTimeout(function () { item.classList.remove('is-moved'); }, 320);
            renumber();
            showBar();
        }

        // Save / reset / move (delegated on document but guarded to this list).
        document.addEventListener('click', function (e) {
            if (!e.target.closest) { return; }
            var up = e.target.closest('[data-action="mpc-move-up"]');
            if (up) { moveRow(up.closest('.pr-item'), -1); return; }
            var down = e.target.closest('[data-action="mpc-move-down"]');
            if (down) { moveRow(down.closest('.pr-item'), 1); return; }
            if (e.target.closest('[data-action="mpc-reorder-save"]')) {
                var ids = itemIds();
                post('/marketplace-categories/reorder', { ids: ids }).then(function (res) {
                    if (ok(res)) {
                        toast('success', res.msg || 'Order saved.');
                        originalOrder = ids;
                        Array.prototype.forEach.call(list.querySelectorAll('.pr-item'), function (it, i) {
                            var cell = it.querySelector('.mpc-sortcell'); if (cell) { cell.textContent = '#' + (i + 1); }
                        });
                        if (bar) { bar.hidden = true; }
                    } else { toast('error', res.msg || 'Could not save the order.'); }
                });
            }
            if (e.target.closest('[data-action="mpc-reorder-reset"]')) {
                var map = {};
                Array.prototype.forEach.call(list.querySelectorAll('.pr-item'), function (it) { map[it.getAttribute('data-id')] = it; });
                originalOrder.forEach(function (id) { if (map[id]) { list.appendChild(map[id]); } });
                renumber();
                if (bar) { bar.hidden = true; }
            }
        });
    }

    /* ---- global change events ----------------------------------------- */
    document.addEventListener('change', function (e) {
        var t = e.target;
        if (!t) { return; }
        if (t.classList && t.classList.contains('pr-check')) { refreshBar(); return; }
        if (t.matches && t.matches('[data-action="pr-checkall"]')) {
            var ch = t.checked; var boxes = document.querySelectorAll('.pr-check');
            for (var i = 0; i < boxes.length; i++) { boxes[i].checked = ch; }
            refreshBar(); return;
        }
        if (t.classList && t.classList.contains('mpc-status')) { applyStatus([Number(t.getAttribute('data-id'))], Number(t.value), [t]); return; }
        if (t.matches && t.matches('[data-bulk-status]')) {
            var st = t.value; if (st === '') { return; }
            var ids = selectedIds();
            if (!ids.length) { toast('error', 'Select items first.'); t.value = ''; return; }
            applyStatus(ids, Number(st), []); t.value = ''; return;
        }
        if (t.matches && t.matches('[data-filter-submit]')) { var ff = document.getElementById('pr-filter'); if (ff) { ff.submit(); } return; }
    });

    /* ---- global click events ------------------------------------------ */
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) { return; }
        if (t.closest('[data-action="pr-clearall"]')) { var boxes = document.querySelectorAll('.pr-check'); for (var i = 0; i < boxes.length; i++) { boxes[i].checked = false; } refreshBar(); return; }

        var del = t.closest('[data-action="pr-delete"]');
        if (del) { pendingDelete = { ids: [Number(del.getAttribute('data-id'))] }; setDeleteMsg('Delete this category?'); showModal('delete'); return; }
        if (t.closest('[data-action="pr-bulk-delete"]')) {
            var dids = selectedIds();
            if (!dids.length) { toast('error', 'Select items first.'); return; }
            pendingDelete = { ids: dids }; setDeleteMsg('Delete ' + dids.length + ' categor' + (dids.length > 1 ? 'ies' : 'y') + '?'); showModal('delete'); return;
        }
        if (t.closest('[data-action="pr-delete-confirm"]')) {
            if (pendingDelete) {
                var pd = pendingDelete; pendingDelete = null; hideModals();
                post('/marketplace-categories/delete', { ids: pd.ids }).then(function (res) {
                    if (ok(res)) {
                        toast('success', res.msg || 'Deleted.');
                        pd.ids.forEach(function (id) { var el = document.querySelector('.pr-item[data-id="' + id + '"]'); if (el) { el.parentNode.removeChild(el); } });
                        refreshBar();
                    } else { toast('error', res.msg || 'Could not delete.'); }
                });
            } else { hideModals(); }
            return;
        }
        if (t.closest('[data-action="pr-modal-cancel"]')) { pendingDelete = null; hideModals(); return; }

        // Restaurants list (click the count).
        var cnt = t.closest('[data-action="mpc-restaurants"]');
        if (cnt) { openRestaurants(Number(cnt.getAttribute('data-id')), cnt.getAttribute('data-name') || 'Category'); return; }

        // Assign — single row.
        var one = t.closest('[data-action="mpc-assign-one"]');
        if (one) { openAssign({ categoryIds: [Number(one.getAttribute('data-id'))], name: one.getAttribute('data-name') || 'Category', single: true }); return; }

        // Assign — bulk.
        if (t.closest('[data-action="pr-bulk-assign"]')) {
            var bids = selectedIds();
            if (!bids.length) { toast('error', 'Select categories first.'); return; }
            openAssign({ categoryIds: bids, single: false }); return;
        }

        // Assign modal actions.
        var chipX = t.closest('[data-chip-x]');
        if (chipX) { removeChip(chipX.getAttribute('data-chip-x')); return; }
        if (t.closest('[data-action="assign-cancel"]')) { hideModals(); return; }
        if (t.closest('[data-action="assign-save"]')) { saveAssign(); return; }
    });

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { pendingDelete = null; hideModals(); } });

    document.addEventListener('DOMContentLoaded', function () {
        var sels = document.querySelectorAll('.mpc-status'); for (var i = 0; i < sels.length; i++) { sels[i].setAttribute('data-prev', sels[i].value); }
        initFilterAc();
        initAssignAc();
        initReorder();
    });
})();
