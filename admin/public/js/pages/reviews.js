/*
 * pages/reviews.js — the super-admin marketplace Reviews page.
 *
 * Three jobs:
 *   1. Add Review modal open/close + client-side checks.
 *   2. Save a public reply (fetch -> /reviews/reply).
 *   3. The Publish Online toggle, which saves immediately.
 *
 * Client checks mirror the legacy POS page's toasts (custom.js:8942-8975) —
 * same messages, same order, same focus-the-field behaviour. They're a
 * convenience only: the api validates all three server-side and clamps the
 * rating to 1..5, which legacy never did.
 */
(function () {
    'use strict';

    // Shared admin helpers — AdminApi.post never rejects (returns a {status:0}
    // envelope), AdminUi.showToastSafe is the toast every admin page uses.
    var A = window.AdminApi, U = window.AdminUi;
    var toast = U.showToastSafe;
    var modal = document.getElementById('rv-modal');

    // ── Add Review modal ────────────────────────────────────────────
    function openModal() {
        if (!modal) { return; }
        modal.hidden = false;
        var first = document.getElementById('rv-customer-name');
        if (first) { first.focus(); }
    }
    function closeModal() {
        if (!modal) { return; }
        modal.hidden = true;
        var f = document.getElementById('rv-add-form');
        if (f) { f.reset(); }
    }

    document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-action]');
        if (t) {
            var a = t.getAttribute('data-action');
            if (a === 'rv-add-open')  { e.preventDefault(); openModal(); return; }
            if (a === 'rv-add-close') { e.preventDefault(); closeModal(); return; }
        }
        // Click the backdrop (not the box) to dismiss.
        if (modal && !modal.hidden && e.target === modal) { closeModal(); }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal && !modal.hidden) { closeModal(); }
    });

    // Legacy's exact toasts + focus, in legacy's order (name, then review).
    var addForm = document.getElementById('rv-add-form');
    if (addForm) {
        addForm.addEventListener('submit', function (e) {
            var name   = document.getElementById('rv-customer-name');
            var review = document.getElementById('rv-review');
            if (name && !name.value.trim()) {
                e.preventDefault(); toast('error', 'Please enter customer name'); name.focus(); return;
            }
            if (review && !review.value.trim()) {
                e.preventDefault(); toast('error', 'Please enter review'); review.focus(); return;
            }
            var btn = document.getElementById('rv-submit');
            if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
        });
    }

    // ── Reply + Publish toggle ──────────────────────────────────────
    function postReply(payload, okMsg) {
        return A.post('/reviews/reply', payload).then(function (b) {
            if (A.isSuccess(b)) { toast('success', okMsg || b.msg || 'Review updated successfully'); return true; }
            toast('error', (b && b.msg) || 'Something went wrong');
            return false;
        });
    }

    document.addEventListener('submit', function (e) {
        var form = e.target.closest('[data-rv-reply]');
        if (!form) { return; }
        e.preventDefault();
        var id  = form.getAttribute('data-id');
        var box = form.querySelector('[name="review_reply"]');
        var btn = form.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        postReply({ id: Number(id), review_reply: box ? box.value : '' }).then(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Reply'; }
        });
    });

    // The toggle saves on change (legacy does the same — its checkbox triggers
    // the reply button's click). Reverted in the UI if the save fails, so the
    // switch never shows a state the server didn't accept.
    document.addEventListener('change', function (e) {
        // Filter dropdowns re-run the search by submitting their GET form, so
        // the URL keeps the state. The search box is handled globally by
        // app.js's [data-live-search]; only the selects need wiring here.
        var sel = e.target;
        if (sel && sel.matches && sel.matches('[data-filter-submit]')) {
            var ff = document.getElementById('pr-filter');
            if (ff) { ff.submit(); }
            return;
        }

        var cb = e.target.closest('[data-rv-publish]');
        if (!cb) { return; }
        var id = Number(cb.getAttribute('data-id'));
        var on = !!cb.checked;
        var card = cb.closest('.rv-card');
        if (card) { card.classList.toggle('is-hidden', !on); }
        postReply({ id: id, publish_online: on ? 1 : 0 },
            on ? 'Review is now public' : 'Review hidden from the website').then(function (ok) {
            if (!ok) {
                cb.checked = !on;
                if (card) { card.classList.toggle('is-hidden', on); }
            }
        });
    });
}());
