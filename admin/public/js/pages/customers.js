/*
 * pages/customers.js — the super-admin marketplace Customers screens.
 *
 * Jobs:
 *   1. Filter selects re-submit the GET form (search box is handled
 *      globally by app.js's [data-live-search]).
 *   2. Delete modal → POST /customers/delete (soft delete).
 *   3. Ban modal (legacy reason dropdown, "Other" reveals a text box)
 *      → POST /customers/ban; Unban → POST /customers/unban.
 *   4. About-the-customer profile modal (GET /customers/profile).
 *   5. Edit-form client checks mirroring the api's validation.
 */
(function () {
    'use strict';

    var A = window.AdminApi, U = window.AdminUi;
    var toast = U.showToastSafe;

    function modal(name) { return document.querySelector('[data-modal="' + name + '"]'); }
    function openModal(name)  { var m = modal(name); if (m) { m.hidden = false; } return m; }
    function closeModals() {
        document.querySelectorAll('.pr-modal').forEach(function (m) { m.hidden = true; });
    }

    // Reload after a successful action so counts, badges and row action
    // buttons (Ban ↔ Unban) all re-render from the server truth.
    function postThenReload(path, payload) {
        return A.post(path, payload).then(function (b) {
            if (A.isSuccess(b)) {
                toast('success', b.msg || 'Done.');
                window.setTimeout(function () { window.location.reload(); }, 600);
                return true;
            }
            toast('error', (b && b.msg) || 'Something went wrong.');
            return false;
        });
    }

    var pendingId = 0;

    document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-action]');
        if (t) {
            var a = t.getAttribute('data-action');
            var id = Number(t.getAttribute('data-id')) || 0;
            var name = t.getAttribute('data-name') || 'this customer';

            if (a === 'pr-modal-cancel') { e.preventDefault(); closeModals(); return; }

            if (a === 'cu-delete') {
                e.preventDefault();
                pendingId = id;
                var m = openModal('cu-delete');
                var msg = m && m.querySelector('[data-delete-msg]');
                if (msg) { msg.textContent = 'Delete ' + name + '? This hides the customer everywhere.'; }
                return;
            }
            if (a === 'cu-delete-confirm') {
                e.preventDefault();
                closeModals();
                postThenReload('/customers/delete', { id: pendingId });
                return;
            }

            if (a === 'cu-ban') {
                e.preventDefault();
                pendingId = id;
                var bm = openModal('cu-ban');
                if (bm) {
                    var bmsg = bm.querySelector('[data-ban-msg]');
                    if (bmsg) { bmsg.textContent = 'Ban ' + name + '? They will no longer be able to sign in or order.'; }
                    var sel = bm.querySelector('[data-ban-reason]');
                    var oth = bm.querySelector('[data-ban-other]');
                    if (sel) { sel.value = ''; }
                    if (oth) { oth.value = ''; oth.hidden = true; }
                }
                return;
            }
            if (a === 'cu-ban-confirm') {
                e.preventDefault();
                var bm2 = modal('cu-ban');
                var reason = bm2 ? (bm2.querySelector('[data-ban-reason]') || {}).value : '';
                var other  = bm2 ? (bm2.querySelector('[data-ban-other]')  || {}).value : '';
                if (!reason) { toast('error', 'Pick a ban reason.'); return; }
                if (reason === 'Other' && !String(other).trim()) { toast('error', 'Enter the other reason.'); return; }
                closeModals();
                postThenReload('/customers/ban', { id: pendingId, banned_reason: reason, other_banned_reason: other });
                return;
            }

            if (a === 'cu-unban') {
                e.preventDefault();
                postThenReload('/customers/unban', { id: id });
                return;
            }
        }
        // Click the backdrop (not the panel) to dismiss.
        var open = e.target.closest('.pr-modal');
        if (open && e.target === open) { closeModals(); }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { closeModals(); }
    });

    // Filter dropdowns re-run the search by submitting their GET form.
    document.addEventListener('change', function (e) {
        var sel = e.target;
        if (sel && sel.matches && sel.matches('[data-filter-submit]')) {
            var ff = document.getElementById('pr-filter');
            if (ff) { ff.submit(); }
            return;
        }
        // Ban modal: "Other" reveals the free-text reason (legacy _form JS).
        if (sel && sel.matches && sel.matches('[data-ban-reason]')) {
            var oth = document.querySelector('[data-ban-other]');
            if (oth) { oth.hidden = sel.value !== 'Other'; if (!oth.hidden) { oth.focus(); } }
        }
    });

    // ── Edit-form client checks (dual-side; the api re-validates) ──
    var form = document.getElementById('cu-form');
    if (form) {
        form.addEventListener('submit', function (e) {
            var first = document.getElementById('cu-first');
            var phone = document.getElementById('cu-phone');
            if (first && !first.value.trim()) { e.preventDefault(); toast('error', 'First name is required.'); first.focus(); return; }
            if (phone && !phone.value.trim()) { e.preventDefault(); toast('error', 'Contact number is required.'); phone.focus(); return; }
            if (phone && !/^\+?[0-9 ]{7,15}$/.test(phone.value.trim())) { e.preventDefault(); toast('error', 'Enter a valid contact number.'); phone.focus(); return; }
        });
    }
}());
