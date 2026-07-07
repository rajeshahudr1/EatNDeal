/*
 * pages/offer-banner.js  (admin layer)
 *
 * What:  Drives the OFFER BANNER pages:
 *          • form — content-type toggle (Text / Image) + banner-image preview,
 *                   RULE-type toggle (shows only the fields the chosen rule
 *                   needs: min % / coupon code / category / hand-pick), and the
 *                   restaurant PICKER for the MANUAL_PICK rule (autocomplete →
 *                   ordered, draggable chips posting as company_ids[]).
 *          • list — delete (confirm modal) + inline status toggle.
 * Note:  Reuses the collection `.col-*` / `.pr-*` styles so no new admin CSS.
 * Used:  extra_js for offer-banner/{form,list}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-ob-form]');
    if (form) { initForm(form); }

    function initForm(form) {
        // Content type — show only the matching section (1=text, 2=image).
        var typeSel = form.querySelector('[data-ob-type]');
        function syncType() {
            var t = typeSel ? String(typeSel.value) : '2';
            form.querySelectorAll('[data-ob-section]').forEach(function (s) {
                s.hidden = s.getAttribute('data-ob-section') !== t;
            });
        }
        if (typeSel) { typeSel.addEventListener('change', syncType); syncType(); }

        // Rule type — reveal only the fields that rule needs + relabel the
        // shared value field (% for rules 1/2, £ for rule 3).
        var ruleSel = form.querySelector('[data-ob-rule]');
        var valLabel = form.querySelector('[data-ob-value-label]');
        var VALUE_LABELS = { '1': 'Discount % (this much or more)', '2': 'Discount % (up to)', '3': 'Amount off (£, this much or more)', '10': 'Amount off (£, up to)' };
        function syncRule() {
            var t = ruleSel ? String(ruleSel.value) : '1';
            form.querySelectorAll('[data-ob-rulefield]').forEach(function (s) {
                // data-ob-rulefield may be a comma list of rule ids that show it.
                var ids = String(s.getAttribute('data-ob-rulefield')).split(',');
                s.hidden = ids.indexOf(t) === -1;
            });
            if (valLabel && VALUE_LABELS[t]) { valLabel.textContent = VALUE_LABELS[t]; }
        }
        if (ruleSel) { ruleSel.addEventListener('change', syncRule); syncRule(); }

        // Banner-image preview.
        form.addEventListener('change', function (e) {
            var t = e.target;
            if (!t.matches('[data-img-input]')) { return; }
            var file = t.files && t.files[0];
            var prev = form.querySelector('[data-img-prev]');
            if (!file || !prev) { return; }
            if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { toast('error', 'Choose a PNG, JPG, WEBP or GIF.'); t.value = ''; return; }
            if (file.size > 3 * 1024 * 1024) { toast('error', 'Image must be under 3 MB.'); t.value = ''; return; }
            var img = prev.querySelector('[data-img-thumb]');
            if (!img) {
                var ph = prev.querySelector('[data-img-ph]'); if (ph) { ph.parentNode.removeChild(ph); }
                img = document.createElement('img'); img.setAttribute('data-img-thumb', ''); img.alt = ''; prev.appendChild(img);
            }
            if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
        });

        // Manual-pick restaurant picker.
        var ac = form.querySelector('[data-ob-ac]');
        var pickList = form.querySelector('[data-pick-list]');
        var emptyHint = form.querySelector('[data-pick-empty]');
        if (ac && pickList) { initPicker(ac, pickList, emptyHint); }
    }

    function initPicker(ac, pickList, emptyHint) {
        var input = ac.querySelector('[data-ac-input]');
        var panel = ac.querySelector('[data-ac-panel]');

        function refreshEmpty() { if (emptyHint) { emptyHint.hidden = pickList.querySelectorAll('.col-pick').length > 0; } }
        function has(id) { return !!pickList.querySelector('.col-pick[data-id="' + id + '"]'); }
        function addChip(item) {
            if (!item || !item.id || has(item.id)) { return; }
            var row = document.createElement('div');
            row.className = 'col-pick';
            row.setAttribute('data-id', item.id);
            row.setAttribute('draggable', 'true');
            row.innerHTML = '<span class="col-pick__drag" data-drag-handle aria-hidden="true">⠿</span>'
                + '<span class="col-pick__body"><span class="col-pick__name"></span><span class="col-pick__detail"></span></span>'
                + '<button type="button" class="col-pick__x" data-action="pick-remove" aria-label="Remove">✕</button>'
                + '<input type="hidden" name="company_ids" value="' + Number(item.id) + '">';
            row.querySelector('.col-pick__name').textContent = item.name || ('Restaurant #' + item.id);
            row.querySelector('.col-pick__detail').textContent = item.detail || '';
            pickList.appendChild(row);
            refreshEmpty();
        }

        var fetchList = U.debounce(function (q) {
            A.getJson('/offer-banner/companies?limit=50&q=' + encodeURIComponent(q)).then(function (res) {
                var rows = (A.isSuccess(res) && res.data && res.data.companies) || [];
                panel.innerHTML = '';
                if (!rows.length) { panel.hidden = true; return; }
                rows.forEach(function (c) {
                    if (has(c.id)) { return; }
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'col-ac__item';
                    b.setAttribute('data-id', c.id);
                    b.innerHTML = '<span class="col-ac__name"></span><span class="col-ac__detail"></span>';
                    b.querySelector('.col-ac__name').textContent = c.name;
                    b.querySelector('.col-ac__detail').textContent = c.detail || '';
                    b.addEventListener('click', function () {
                        addChip(c); input.value = ''; panel.hidden = true; panel.innerHTML = ''; input.focus();
                    });
                    panel.appendChild(b);
                });
                panel.hidden = false;
            });
        }, 250);

        input.addEventListener('focus', function () { fetchList(input.value.trim()); });
        input.addEventListener('input', function () { fetchList(input.value.trim()); });
        input.addEventListener('blur', function () { setTimeout(function () { panel.hidden = true; }, 180); });

        pickList.addEventListener('click', function (e) {
            var rm = e.target.closest('[data-action="pick-remove"]');
            if (rm) { var row = rm.closest('.col-pick'); if (row) { row.parentNode.removeChild(row); } refreshEmpty(); }
        });

        enableDrag(pickList, '.col-pick');
        refreshEmpty();
    }

    // ─────────────────────────── LIST ───────────────────────────
    var listRoot = document.querySelector('[data-ob-root]');
    if (listRoot) { initList(listRoot); }

    function initList(root) {
        var delId = null;
        root.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="ob-delete"]');
            if (del) { delId = del.getAttribute('data-id'); U.showModal('delete'); return; }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="ob-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="ob-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/offer-banner/delete', { id: delId }).then(function (res) {
                    U.hideModals();
                    if (A.isSuccess(res)) { toast('success', res.msg || 'Deleted.'); window.location.reload(); }
                    else { toast('error', res.msg || 'Could not delete.'); }
                });
                delId = null;
            }
        });
        root.addEventListener('change', function (e) {
            var sel = e.target.closest('.col-status');
            if (!sel) { return; }
            A.post('/offer-banner/status', { id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });
    }

    // ────────────────────────── ARRANGE ─────────────────────────
    var arrange = document.querySelector('[data-ob-arrange]');
    if (arrange) { initArrange(arrange); }

    function initArrange(root) {
        var list = root.querySelector('[data-list][data-draggable]');
        var bar = document.querySelector('[data-reorderbar]');
        if (!list) { return; }
        enableDrag(list, '.pr-item', function () { if (bar) { bar.hidden = false; } });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="ob-reorder-reset"]')) { window.location.reload(); return; }
            if (e.target.closest('[data-action="ob-reorder-save"]')) {
                var ids = currentOrder(list);
                A.post('/offer-banner/reorder', { ids: ids }).then(function (res) {
                    if (A.isSuccess(res)) { toast('success', 'Order saved.'); if (bar) { bar.hidden = true; } }
                    else { toast('error', res.msg || 'Could not save the order.'); }
                });
            }
        });
    }
    function currentOrder(list) {
        return Array.prototype.map.call(list.children, function (el) { return Number(el.getAttribute('data-id')); }).filter(function (n) { return n > 0; });
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
        container.addEventListener('dragend', function () {
            if (dragged) { dragged.classList.remove('is-dragging'); }
            dragged = null;
            if (onChange) { onChange(); }
        });
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
