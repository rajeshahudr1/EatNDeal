/*
 * pages/loyalty.js
 *
 * What:  Generic client behaviour for every loyalty management screen:
 *          • master on/off switches  (data-action="ly-master-toggle")
 *          • inline add / edit forms  (data-action="ly-add" / "ly-edit",
 *            targeted by data-form="<formId>"; edit fills the form from the
 *            row's data-rule JSON; the title swaps via data-add/edit-title)
 *          • two-click inline delete confirm (no native confirm())
 *        Works for any number of row-forms on one page (cashback, streak…).
 * Why:   Forms still POST without JS; this is the interactive layer, shared so
 *        new screens need no new script.
 * Used:  extra_js for the loyalty/* views.
 */
(function () {
    'use strict';

    var byId = window.AdminUi.byId;
    function showForm(f) { if (f) { f.hidden = false; f.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }

    // BOGO apply-on switch: show the product OR the category multi-select to
    // match the [data-apply-on] select's value (1=Product blocks, 2=Category).
    function syncApplyOn(f) {
        if (!f) { return; }
        var sel = f.querySelector('[data-apply-on]');
        if (!sel) { return; }
        var val = String(sel.value);
        var blocks = f.querySelectorAll('[data-apply-block]');
        for (var i = 0; i < blocks.length; i++) {
            blocks[i].hidden = blocks[i].getAttribute('data-apply-block') !== val;
        }
    }

    function fillForm(f, data) {
        Object.keys(data || {}).forEach(function (k) {
            var els = f.querySelectorAll('[name="' + k + '"], [name="' + k + '[]"]');
            if (!els.length) { return; }
            var val = data[k];
            // Array value → a multi-checkbox group (e.g. product_ids[]). Tick
            // the boxes whose value is in the array, leave the rest off.
            if (Array.isArray(val) && els[0].type === 'checkbox') {
                var set = {};
                val.forEach(function (v) { set[String(v)] = true; });
                for (var i = 0; i < els.length; i++) { els[i].checked = !!set[els[i].value]; }
                return;
            }
            var el = els[0];
            if (el.type === 'checkbox') {
                el.checked = (val === 1 || val === true || val === '1');
            } else {
                el.value = (val == null ? '' : val);
            }
        });
    }

    function setTitle(f, which) {
        var ti = f.querySelector('[data-form-title]');
        if (!ti) { return; }
        var t = ti.getAttribute('data-' + which + '-title');
        if (t) { ti.textContent = t; }
    }

    // Multi-select filter — type to filter a checkbox list (products /
    // categories). Filters [data-multi-option] rows inside the [data-multi] box.
    document.addEventListener('input', function (ev) {
        var t = ev.target;
        if (!t || !t.matches || !t.matches('[data-multi-filter]')) { return; }
        var box = t.closest('[data-multi]');
        if (!box) { return; }
        var q = t.value.trim().toLowerCase();
        var opts = box.querySelectorAll('[data-multi-option]');
        for (var i = 0; i < opts.length; i++) {
            var name = (opts[i].getAttribute('data-name') || opts[i].textContent || '').toLowerCase();
            opts[i].hidden = !!q && name.indexOf(q) === -1;
        }
    });

    // ── Master on/off switches — submit the toggle form with the new status ──
    document.addEventListener('change', function (ev) {
        var t = ev.target;
        if (t && t.matches && t.matches('[data-action="ly-master-toggle"]')) {
            var fm = t.closest('[data-toggle-form]');
            if (!fm) { return; }
            var hidden = fm.querySelector('input[name="status"]');
            if (hidden) { hidden.value = t.checked ? '1' : '2'; }
            fm.submit();
            return;
        }
        if (t && t.matches && t.matches('[data-apply-on]')) {
            syncApplyOn(t.closest('form'));
        }
    });

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        var add = t.closest('[data-action="ly-add"]');
        if (add) {
            ev.preventDefault();
            var fa = byId(add.getAttribute('data-form'));
            if (fa) {
                fa.reset();
                var idf = fa.querySelector('[name="id"]');
                if (idf) { idf.value = ''; }
                setTitle(fa, 'add');
                showForm(fa);
                syncApplyOn(fa);
            }
            return;
        }

        var cancel = t.closest('[data-action="ly-cancel"]');
        if (cancel) {
            ev.preventDefault();
            var fc = cancel.getAttribute('data-form') ? byId(cancel.getAttribute('data-form')) : cancel.closest('form');
            if (fc) { fc.hidden = true; }
            return;
        }

        var ed = t.closest('[data-action="ly-edit"]');
        if (ed) {
            ev.preventDefault();
            var fe = byId(ed.getAttribute('data-form'));
            var row = ed.closest('[data-rule]');
            if (fe && row) {
                var data;
                try { data = JSON.parse(decodeURIComponent(row.getAttribute('data-rule'))); }
                catch (e) { return; }
                fe.reset();
                fillForm(fe, data);
                setTitle(fe, 'edit');
                showForm(fe);
                syncApplyOn(fe);
            }
            return;
        }

        var del = t.closest('[data-action="ly-delete"]');
        if (del) { ev.preventDefault(); confirmDelete(del); return; }

        // Save-All page: add a new repeatable row from its <template>.
        var rowAdd = t.closest('[data-action="ly-row-add"]');
        if (rowAdd) {
            ev.preventDefault();
            var section = rowAdd.getAttribute('data-rows');
            var box = document.querySelector('[data-rows-body="' + section + '"]');
            var tpl = document.querySelector('[data-row-template="' + section + '"]');
            if (box && tpl) {
                var idx = parseInt(box.getAttribute('data-next') || '0', 10);
                box.setAttribute('data-next', String(idx + 1));
                var html = tpl.innerHTML.replace(/__IDX__/g, 'n' + idx);
                var wrap = document.createElement('div');
                wrap.innerHTML = html.trim();
                var node = wrap.firstChild;
                box.appendChild(node);
                var empty = box.parentNode.querySelector('[data-rows-empty]');
                if (empty) { empty.hidden = true; }
                if (node.querySelector) { var f = node.querySelector('input,select'); if (f) { f.focus(); } }
            }
            return;
        }
        // Save-All page: remove a repeatable row (drops it from the POST).
        var rowDel = t.closest('[data-action="ly-row-del"]');
        if (rowDel) {
            ev.preventDefault();
            var row = rowDel.closest('[data-erow]');
            if (row) { row.parentNode.removeChild(row); }
            return;
        }

        // Review claims — reveal / hide the inline reject-reason form.
        var rjOpen = t.closest('[data-action="rc-reject-open"]');
        if (rjOpen) {
            ev.preventDefault();
            var rf = byId('rc-reject-' + rjOpen.getAttribute('data-claim'));
            if (rf) { rf.hidden = false; var inp = rf.querySelector('input,textarea'); if (inp) { inp.focus(); } }
            return;
        }
        var rjCancel = t.closest('[data-action="rc-reject-cancel"]');
        if (rjCancel) {
            ev.preventDefault();
            var rf2 = byId('rc-reject-' + rjCancel.getAttribute('data-claim'));
            if (rf2) { rf2.hidden = true; }
            return;
        }

        // Review claims — status tab: set the hidden status + submit the form.
        var rcTab = t.closest('[data-rc-tab]');
        if (rcTab) {
            ev.preventDefault();
            var rcForm = byId('rc-filter');
            if (rcForm) {
                var sh = rcForm.querySelector('input[name="status"]');
                if (sh) { sh.value = rcTab.getAttribute('data-rc-tab'); }
                rcForm.submit();
            }
            return;
        }
        // Review claims — toggle the date filter popup.
        var rcFilter = t.closest('[data-action="rc-filter-open"]');
        if (rcFilter) {
            ev.preventDefault();
            var pop = document.querySelector('[data-rc-filterpop]');
            if (pop) { pop.hidden = !pop.hidden; }
            return;
        }
    });

    // Segment bars — set width from data-w (kept out of the markup so there's
    // no inline style attribute).
    document.addEventListener('DOMContentLoaded', function () {
        var bars = document.querySelectorAll('.seg-bar__fill[data-w]');
        for (var i = 0; i < bars.length; i++) {
            bars[i].style.width = (parseInt(bars[i].getAttribute('data-w'), 10) || 0) + '%';
        }
    });

    // Two-click delete: first arms ("Sure?"), second submits; auto-disarms.
    function confirmDelete(btn) {
        if (btn.getAttribute('data-armed') === '1') {
            var fm = btn.closest('form');
            if (fm) { fm.submit(); }
            return;
        }
        btn.setAttribute('data-armed', '1');
        var original = btn.innerHTML;
        btn.classList.add('is-armed');
        btn.innerHTML = 'Sure?';
        window.setTimeout(function () {
            btn.setAttribute('data-armed', '0');
            btn.classList.remove('is-armed');
            btn.innerHTML = original;
        }, 3000);
    }
})();
