/*
 * pages/featured.js  (admin layer)
 *
 * What:  Drives the two featured-placement pages:
 *          • form — pick a single restaurant via autocomplete (sets the hidden
 *                   company_id) + a clear button.
 *          • list — delete (confirm modal) + inline status toggle.
 * Used:  extra_js for featured/{form,list}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-feat-form]');
    if (form) { initForm(form); }

    function initForm(form) {
        var ac = form.querySelector('[data-feat-ac]');
        var input = ac && ac.querySelector('[data-ac-input]');
        var panel = ac && ac.querySelector('[data-ac-panel]');
        var hidden = form.querySelector('[data-feat-company]');

        function pick(item) {
            if (hidden) { hidden.value = Number(item.id) || ''; }
            if (input) { input.value = item.name || ''; }
            if (panel) { panel.hidden = true; panel.innerHTML = ''; }
        }
        function clear() {
            if (hidden) { hidden.value = ''; }
            if (input) { input.value = ''; input.focus(); }
        }

        if (input && panel) {
            var fetchList = U.debounce(function (q) {
                A.getJson('/featured/companies?limit=10&q=' + encodeURIComponent(q)).then(function (res) {
                    var rows = (A.isSuccess(res) && res.data && res.data.companies) || [];
                    panel.innerHTML = '';
                    if (!rows.length) { panel.hidden = true; return; }
                    rows.forEach(function (c) {
                        var b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'col-ac__item';
                        b.innerHTML = '<span class="col-ac__name"></span><span class="col-ac__detail"></span>';
                        b.querySelector('.col-ac__name').textContent = c.name;
                        b.querySelector('.col-ac__detail').textContent = c.detail || '';
                        b.addEventListener('click', function () { pick(c); });
                        panel.appendChild(b);
                    });
                    panel.hidden = false;
                });
            }, 250);

            input.addEventListener('input', function () {
                // Typing a new search invalidates a previous pick.
                if (hidden) { hidden.value = ''; }
                var q = input.value.trim();
                if (q.length < 1) { panel.hidden = true; panel.innerHTML = ''; return; }
                fetchList(q);
            });
            input.addEventListener('blur', function () { setTimeout(function () { panel.hidden = true; }, 180); });
        }

        form.addEventListener('click', function (e) {
            if (e.target.closest('[data-feat-clear]')) { e.preventDefault(); clear(); }
        });

        form.addEventListener('submit', function (e) {
            if (hidden && !hidden.value) { e.preventDefault(); toast('error', 'Pick a restaurant first.'); if (input) { input.focus(); } return; }
            var start = form.querySelector('[name="starts_at"]');
            var end = form.querySelector('[name="ends_at"]');
            if (start && end && start.value && end.value && end.value < start.value) {
                e.preventDefault(); toast('error', 'End date must be after the start date.'); end.focus();
            }
        });
    }

    // ─────────────────────────── LIST ───────────────────────────
    var listRoot = document.querySelector('[data-feat-root]');
    if (listRoot) { initList(listRoot); }

    function initList(root) {
        var delId = null;
        root.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="feat-delete"]');
            if (del) { delId = del.getAttribute('data-id'); U.showModal('delete'); }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="feat-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="feat-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/featured/delete', { id: delId }).then(function (res) {
                    U.hideModals();
                    if (A.isSuccess(res)) { toast('success', res.msg || 'Removed.'); window.location.reload(); }
                    else { toast('error', res.msg || 'Could not remove.'); }
                });
                delId = null;
            }
        });
        root.addEventListener('change', function (e) {
            var sel = e.target.closest('.feat-status');
            if (!sel) { return; }
            A.post('/featured/status', { id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });

        // Drag-reorder → save priority (top = highest priority).
        var list = root.querySelector('[data-list][data-draggable]');
        var bar = document.querySelector('[data-reorderbar]');
        if (list) { enableDrag(list, '.pr-item', function () { if (bar) { bar.hidden = false; } }); }
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="feat-reorder-reset"]')) { window.location.reload(); return; }
            if (e.target.closest('[data-action="feat-reorder-save"]')) {
                if (!list) { return; }
                var ids = Array.prototype.map.call(list.children, function (el) { return Number(el.getAttribute('data-id')); }).filter(function (n) { return n > 0; });
                A.post('/featured/reorder', { ids: ids }).then(function (res) {
                    if (A.isSuccess(res)) { toast('success', 'Order saved.'); if (bar) { bar.hidden = true; } }
                    else { toast('error', res.msg || 'Could not save the order.'); }
                });
            }
        });
    }

    // ─────────────────────── shared drag util ───────────────────
    function enableDrag(container, itemSel, onChange) {
        var dragged = null;
        container.addEventListener('dragstart', function (e) {
            var row = e.target.closest(itemSel);
            if (!row) { return; }
            dragged = row; row.classList.add('is-dragging');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); } catch (x) { /* ignore */ }
        });
        container.addEventListener('dragend', function () { if (dragged) { dragged.classList.remove('is-dragging'); } dragged = null; if (onChange) { onChange(); } });
        container.addEventListener('dragover', function (e) {
            if (!dragged) { return; }
            e.preventDefault();
            var after = afterElement(container, itemSel, e.clientY);
            if (after == null) { container.appendChild(dragged); }
            else if (after !== dragged) { container.insertBefore(dragged, after); }
        });
    }
    function afterElement(container, itemSel, y) {
        var els = Array.prototype.slice.call(container.querySelectorAll(itemSel + ':not(.is-dragging)'));
        var closest = null, closestOffset = -Infinity;
        els.forEach(function (el) {
            var box = el.getBoundingClientRect();
            var offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
        });
        return closest;
    }
})();
