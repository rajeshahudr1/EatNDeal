/*
 * pages/collections.js  (admin layer)
 *
 * What:  Drives the three collection pages:
 *          • form    — auto-slug, cover-image preview, and the restaurant
 *                      PICKER (autocomplete → ordered, draggable chips that
 *                      post as company_ids[]).
 *          • list    — delete (confirm modal) + inline status toggle.
 *          • arrange — drag-reorder the rows, then save the new order.
 * Used:  extra_js for collections/{form,list,arrange}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-col-form]');
    if (form) { initForm(form); }

    function initForm(form) {
        var slugTouched = false;
        var slugEl = form.querySelector('[data-col-slug]');
        if (slugEl && slugEl.value.trim() !== '') { slugTouched = true; }

        form.addEventListener('input', function (e) {
            var t = e.target;
            if (t.matches('[data-col-slug]')) { slugTouched = true; return; }
            if (t.matches('[data-col-name]') && !slugTouched && slugEl) { slugEl.value = U.slugify(t.value); }
        });

        // Cover-image preview.
        form.addEventListener('change', function (e) {
            var t = e.target;
            if (!t.matches('[data-img-input]')) { return; }
            var file = t.files && t.files[0];
            var prev = form.querySelector('[data-img-prev]');
            if (!file || !prev) { return; }
            if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.type)) { toast('error', 'Choose a PNG, JPG, WEBP, GIF or SVG.'); t.value = ''; return; }
            if (file.size > 3 * 1024 * 1024) { toast('error', 'Image must be under 3 MB.'); t.value = ''; return; }
            var img = prev.querySelector('[data-img-thumb]');
            if (!img) {
                var ph = prev.querySelector('[data-img-ph]'); if (ph) { ph.parentNode.removeChild(ph); }
                img = document.createElement('img'); img.setAttribute('data-img-thumb', ''); img.alt = ''; prev.appendChild(img);
            }
            if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
        });

        // Restaurant picker autocomplete.
        var ac = form.querySelector('[data-col-ac]');
        var pickList = form.querySelector('[data-pick-list]');
        var emptyHint = form.querySelector('[data-pick-empty]');
        if (ac && pickList) { initPicker(ac, pickList, emptyHint); }

        // Validate before submit (server re-checks).
        form.addEventListener('submit', function (e) {
            var name = form.querySelector('[data-col-name]');
            if (name && name.value.trim() === '') { e.preventDefault(); toast('error', 'Collection title is required.'); name.focus(); }
        });
    }

    function initPicker(ac, pickList, emptyHint) {
        var input = ac.querySelector('[data-ac-input]');
        var panel = ac.querySelector('[data-ac-panel]');

        function refreshEmpty() {
            if (emptyHint) { emptyHint.hidden = pickList.querySelectorAll('.col-pick').length > 0; }
        }
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
            A.getJson('/collections/companies?limit=50&q=' + encodeURIComponent(q)).then(function (res) {
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

        // Default list on focus (empty query → api returns up to 50), then
        // search as you type. Already-picked restaurants are skipped (dedup in
        // fetchList via has(); addChip() also guards) so no duplicates.
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
    var listRoot = document.querySelector('[data-col-root]');
    if (listRoot) { initList(listRoot); }

    function initList(root) {
        var delId = null;
        root.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="col-delete"]');
            if (del) { delId = del.getAttribute('data-id'); U.showModal('delete'); return; }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="col-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="col-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/collections/delete', { id: delId }).then(function (res) {
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
            A.post('/collections/status', { id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });
    }

    // ────────────────────────── ARRANGE ─────────────────────────
    var arrange = document.querySelector('[data-col-arrange]');
    if (arrange) { initArrange(arrange); }

    function initArrange(root) {
        var list = root.querySelector('[data-list][data-draggable]');
        var bar = document.querySelector('[data-reorderbar]');
        if (!list) { return; }
        var original = currentOrder(list);
        enableDrag(list, '.pr-item', function () { if (bar) { bar.hidden = false; } });

        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="col-reorder-reset"]')) { window.location.reload(); return; }
            if (e.target.closest('[data-action="col-reorder-save"]')) {
                var ids = currentOrder(list);
                A.post('/collections/reorder', { ids: ids }).then(function (res) {
                    if (A.isSuccess(res)) { toast('success', 'Order saved.'); if (bar) { bar.hidden = true; } original = ids; }
                    else { toast('error', res.msg || 'Could not save the order.'); }
                });
            }
        });
    }

    function currentOrder(list) {
        return Array.prototype.map.call(list.children, function (el) { return Number(el.getAttribute('data-id')); }).filter(function (n) { return n > 0; });
    }

    // ─────────────────────── shared drag util ───────────────────
    // HTML5 drag-and-drop reorder within `container` over `itemSel` rows.
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
