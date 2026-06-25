/*
 * pages/featured-products.js  (admin layer)
 *
 * What:  Drives the featured-products pages:
 *          • form — pick a restaurant (new), then search + add ITS products
 *                   as ordered, draggable chips (posts company_id + product_ids[]).
 *          • list — delete (confirm modal) + inline status toggle (per restaurant).
 * Used:  extra_js for featured-products/{form,list}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-fp-form]');
    if (form) { initForm(form); }

    function initForm(form) {
        var companyHidden = form.querySelector('[data-fp-company]');
        var productsSection = form.querySelector('[data-fp-products-section]');
        var pickList = form.querySelector('[data-pick-list]');
        var emptyHint = form.querySelector('[data-pick-empty]');

        // Restaurant picker (new only).
        var restAc = form.querySelector('[data-fp-restaurant-ac]');
        if (restAc) {
            var rInput = restAc.querySelector('[data-ac-input]');
            var rPanel = restAc.querySelector('[data-ac-panel]');
            var picked = form.querySelector('[data-fp-resto-picked]');
            var fetchRest = U.debounce(function (q) {
                A.getJson('/featured-products/companies?limit=50&q=' + encodeURIComponent(q)).then(function (res) {
                    renderPanel(rPanel, (A.isSuccess(res) && res.data && res.data.companies) || [], function (c) {
                        companyHidden.value = Number(c.id) || '';
                        if (picked) { picked.hidden = false; picked.textContent = '🏪 ' + c.name; }
                        rInput.value = c.name; rPanel.hidden = true; rPanel.innerHTML = '';
                        if (productsSection) { productsSection.hidden = false; }
                        clearChips();   // products are restaurant-scoped → reset on restaurant change
                    });
                });
            }, 250);
            // Default list on focus (empty query → up to 50); search as you type.
            rInput.addEventListener('focus', function () { fetchRest(rInput.value.trim()); });
            rInput.addEventListener('input', function () { fetchRest(rInput.value.trim()); });
            rInput.addEventListener('blur', function () { setTimeout(function () { rPanel.hidden = true; }, 180); });
        }

        // Product picker (scoped to the chosen restaurant).
        var prodAc = form.querySelector('[data-fp-product-ac]');
        if (prodAc && pickList) {
            var pInput = prodAc.querySelector('[data-ac-input]');
            var pPanel = prodAc.querySelector('[data-ac-panel]');
            var fetchProd = U.debounce(function (q) {
                var cid = companyHidden.value;
                if (!cid) { pPanel.hidden = true; return; }
                A.getJson('/featured-products/products?company_id=' + encodeURIComponent(cid) + '&limit=50&q=' + encodeURIComponent(q)).then(function (res) {
                    var list = (A.isSuccess(res) && res.data && res.data.products) || [];
                    // Hide products already added (by id OR by identical name).
                    list = list.filter(function (p) { return !hasChip(p.id) && !hasName(p.name); });
                    renderPanel(pPanel, list, function (p) {
                        addChip(p); pInput.value = ''; pPanel.hidden = true; pPanel.innerHTML = ''; pInput.focus();
                    });
                });
            }, 250);
            // Default product list on focus once a restaurant is chosen (empty
            // query → up to 50, deduped); search as you type.
            pInput.addEventListener('focus', function () { if (companyHidden.value) { fetchProd(pInput.value.trim()); } });
            pInput.addEventListener('input', function () {
                if (!companyHidden.value) { toast('info', 'Pick a restaurant first.'); pPanel.hidden = true; return; }
                fetchProd(pInput.value.trim());
            });
            pInput.addEventListener('blur', function () { setTimeout(function () { pPanel.hidden = true; }, 180); });
        }

        function hasChip(id) { return !!pickList.querySelector('.col-pick[data-id="' + id + '"]'); }
        // The same dish can exist multiple times in a messy catalog (different
        // ids, same name) — block by NAME too so a product is featured ONCE.
        function nameKey(s) { return String(s || '').trim().toLowerCase(); }
        function hasName(name) {
            var key = nameKey(name);
            if (!key) { return false; }
            var names = pickList.querySelectorAll('.col-pick__name');
            for (var i = 0; i < names.length; i++) { if (nameKey(names[i].textContent) === key) { return true; } }
            return false;
        }
        function refreshEmpty() { if (emptyHint) { emptyHint.hidden = pickList.querySelectorAll('.col-pick').length > 0; } }
        function clearChips() { pickList.innerHTML = ''; refreshEmpty(); }
        function addChip(p) {
            if (!p || !p.id || hasChip(p.id) || hasName(p.name)) { return; }
            var row = document.createElement('div');
            row.className = 'col-pick';
            row.setAttribute('data-id', p.id);
            row.setAttribute('draggable', 'true');
            row.innerHTML = '<span class="col-pick__drag" data-drag-handle aria-hidden="true">⠿</span>'
                + '<span class="col-pick__body"><span class="col-pick__name"></span><span class="col-pick__detail"></span></span>'
                + '<button type="button" class="col-pick__x" data-action="pick-remove" aria-label="Remove">✕</button>'
                + '<input type="hidden" name="product_ids" value="' + Number(p.id) + '">';
            row.querySelector('.col-pick__name').textContent = p.name || ('Product #' + p.id);
            row.querySelector('.col-pick__detail').textContent = p.detail || (p.price != null ? ('£' + Number(p.price).toFixed(2)) : '');
            pickList.appendChild(row);
            refreshEmpty();
        }
        pickList.addEventListener('click', function (e) {
            var rm = e.target.closest('[data-action="pick-remove"]');
            if (rm) { var row = rm.closest('.col-pick'); if (row) { row.parentNode.removeChild(row); } refreshEmpty(); }
        });
        enableDrag(pickList, '.col-pick');
        refreshEmpty();

        form.addEventListener('submit', function (e) {
            if (!companyHidden.value) { e.preventDefault(); toast('error', 'Pick a restaurant first.'); return; }
            if (!pickList.querySelector('.col-pick')) { e.preventDefault(); toast('error', 'Add at least one product.'); }
        });
    }

    // Render an autocomplete panel of items; onPick(item) on click.
    function renderPanel(panel, items, onPick) {
        panel.innerHTML = '';
        if (!items.length) { panel.hidden = true; return; }
        items.forEach(function (it) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'col-ac__item';
            b.innerHTML = '<span class="col-ac__name"></span><span class="col-ac__detail"></span>';
            b.querySelector('.col-ac__name').textContent = it.name;
            b.querySelector('.col-ac__detail').textContent = it.detail || '';
            b.addEventListener('click', function () { onPick(it); });
            panel.appendChild(b);
        });
        panel.hidden = false;
    }

    // ─────────────────────────── LIST ───────────────────────────
    var listRoot = document.querySelector('[data-fp-root]');
    if (listRoot) { initList(listRoot); }

    function initList(root) {
        var delId = null;
        root.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="fp-delete"]');
            if (del) { delId = del.getAttribute('data-id'); U.showModal('delete'); }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="fp-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="fp-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/featured-products/delete', { company_id: delId }).then(function (res) {
                    U.hideModals();
                    if (A.isSuccess(res)) { toast('success', res.msg || 'Removed.'); window.location.reload(); }
                    else { toast('error', res.msg || 'Could not remove.'); }
                });
                delId = null;
            }
        });
        root.addEventListener('change', function (e) {
            var sel = e.target.closest('.fp-status');
            if (!sel) { return; }
            A.post('/featured-products/status', { company_id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });

        // Drag-reorder → save entry order (which restaurant's row shows first).
        var list = root.querySelector('[data-list][data-draggable]');
        var bar = document.querySelector('[data-reorderbar]');
        if (list) { enableDrag(list, '.pr-item', function () { if (bar) { bar.hidden = false; } }); }
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="fp-reorder-reset"]')) { window.location.reload(); return; }
            if (e.target.closest('[data-action="fp-reorder-save"]')) {
                if (!list) { return; }
                var ids = Array.prototype.map.call(list.children, function (el) { return Number(el.getAttribute('data-id')); }).filter(function (n) { return n > 0; });
                A.post('/featured-products/reorder', { company_ids: ids }).then(function (res) {
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
