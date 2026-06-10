/*
 * pages/store-advance.js
 *
 * What:  Drives the Advance Order Waiting Time sub-page:
 *          • Value-Time / Volume-Time tabs.
 *          • Edit — fills the group's inline add form (turns Add → Update).
 *          • Cancel — resets the form back to "add".
 *          • Delete — two-click inline confirm (no native confirm()).
 *        Forms POST + redirect; this is the interactive layer.
 * Used:  extra_js for store-settings/advance-order.ejs.
 */
(function () {
    'use strict';

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        // Tabs
        var tab = t.closest('[data-adv-tab]');
        if (tab) {
            ev.preventDefault();
            var which = tab.getAttribute('data-adv-tab');
            var tabs = document.querySelectorAll('[data-adv-tab]');
            for (var i = 0; i < tabs.length; i++) { tabs[i].classList.toggle('is-active', tabs[i] === tab); }
            var panes = document.querySelectorAll('[data-adv-pane]');
            for (var j = 0; j < panes.length; j++) { panes[j].hidden = panes[j].getAttribute('data-adv-pane') !== which; }
            return;
        }

        // Edit → fill the group's add form
        var ed = t.closest('[data-action="adv-edit"]');
        if (ed) {
            ev.preventDefault();
            var data;
            try { data = JSON.parse(decodeURIComponent(ed.getAttribute('data-row'))); } catch (e) { return; }
            var section = ed.closest('.ss-card');
            var form = section && section.querySelector('[data-adv-form]');
            if (!form) { return; }
            form.querySelector('[name="id"]').value = data.id;
            form.querySelector('[name="min"]').value = data.min;
            form.querySelector('[name="max"]').value = data.max;
            form.querySelector('[name="time"]').value = data.time;
            var sub = form.querySelector('[data-adv-submit]'); if (sub) { sub.textContent = 'Update'; }
            var cancel = form.querySelector('[data-action="adv-cancel"]'); if (cancel) { cancel.hidden = false; }
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        // Cancel edit → reset to add
        var cancelBtn = t.closest('[data-action="adv-cancel"]');
        if (cancelBtn) {
            ev.preventDefault();
            var f2 = cancelBtn.closest('[data-adv-form]');
            if (f2) {
                f2.reset();
                f2.querySelector('[name="id"]').value = '';
                var s = f2.querySelector('[data-adv-submit]'); if (s) { s.textContent = 'Add'; }
                cancelBtn.hidden = true;
            }
            return;
        }

        // Delete — two-click confirm
        var del = t.closest('[data-action="adv-delete"]');
        if (del) {
            ev.preventDefault();
            if (del.getAttribute('data-armed') === '1') { var fm = del.closest('form'); if (fm) { fm.submit(); } return; }
            del.setAttribute('data-armed', '1');
            var orig = del.innerHTML;
            del.classList.add('is-armed');
            del.innerHTML = 'Sure?';
            window.setTimeout(function () { del.setAttribute('data-armed', '0'); del.classList.remove('is-armed'); del.innerHTML = orig; }, 3000);
            return;
        }
    });
})();
