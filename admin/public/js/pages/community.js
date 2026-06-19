/*
 * pages/community.js  (admin layer)
 *
 * What:  Drives the two community-group pages:
 *          • form — cover-image preview + a required-name guard.
 *          • list — delete (confirm modal) + inline status toggle.
 * Used:  extra_js for community/{form,list}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-cm-form]');
    if (form) {
        // Cover-image preview.
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

        form.addEventListener('submit', function (e) {
            var name = form.querySelector('[data-cm-name]');
            if (name && name.value.trim() === '') { e.preventDefault(); toast('error', 'Group name is required.'); name.focus(); }
        });
    }

    // ─────────────────────────── LIST ───────────────────────────
    var listRoot = document.querySelector('[data-cm-root]');
    if (listRoot) {
        var delId = null;
        listRoot.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="cm-delete"]');
            if (del) {
                delId = del.getAttribute('data-id');
                var msg = document.querySelector('[data-delete-msg]');
                if (msg) { msg.textContent = 'Delete "' + (del.getAttribute('data-name') || 'this group') + '"? This also removes its posts, comments and likes. This cannot be undone.'; }
                U.showModal('delete');
                return;
            }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="cm-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="cm-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/community/delete', { id: delId }).then(function (res) {
                    U.hideModals();
                    if (A.isSuccess(res)) { toast('success', res.msg || 'Deleted.'); window.location.reload(); }
                    else { toast('error', res.msg || 'Could not delete.'); }
                });
                delId = null;
            }
        });
        listRoot.addEventListener('change', function (e) {
            var sel = e.target.closest('.cm-status');
            if (!sel) { return; }
            A.post('/community/status', { id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });
    }
})();
