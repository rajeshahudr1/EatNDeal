/*
 * pages/earn.js
 *
 * What:  Earn Cashback page — the submit modal + example-screenshot lightbox.
 *        Clicking a type's "Submit"/"Resubmit" opens a single reused modal,
 *        sets the review_type + title + reward, and shows either the file
 *        field (screenshot) or the URL field (Live Video). On submit we make
 *        sure the customer actually attached proof before letting the native
 *        form POST to /review-cashback. No inline JS (CSP) — all wired here.
 * Used:  extra_js for earn/index.ejs.
 */
(function () {
    'use strict';

    var modal = document.querySelector('[data-earn-modal]');

    // ── Submit modal ──────────────────────────────────────────────────
    function el(sel) { return modal ? modal.querySelector(sel) : null; }

    function openModal(card) {
        if (!modal || !card) { return; }
        var isVideo = card.getAttribute('data-video') === '1';
        var name = card.getAttribute('data-name') || 'this';
        var reward = card.getAttribute('data-reward') || '';

        var typeInput = el('[data-earn-typeinput]');
        if (typeInput) { typeInput.value = card.getAttribute('data-type') || ''; }
        var title = el('[data-earn-title]');
        if (title) { title.textContent = isVideo ? ('Submit your ' + name) : ('Submit your ' + name); }
        var rewardEl = el('[data-earn-reward]');
        if (rewardEl) { rewardEl.textContent = reward ? ('Earn ' + reward + ' once the restaurant verifies it.') : ''; }

        // Toggle photo vs. video field, and which one is required.
        var photoField = el('[data-earn-photofield]');
        var videoField = el('[data-earn-videofield]');
        var fileInput = el('[data-earn-file]');
        var videoInput = el('[data-earn-video]');
        if (photoField) { photoField.hidden = isVideo; }
        if (videoField) { videoField.hidden = !isVideo; }
        if (fileInput) { fileInput.value = ''; fileInput.disabled = isVideo; }
        if (videoInput) { videoInput.value = ''; videoInput.disabled = !isVideo; }
        var fileName = el('[data-earn-filename]');
        if (fileName) { fileName.textContent = 'Choose an image (PNG / JPG, max 4 MB)'; }
        var notes = modal.querySelector('textarea[name="notes"]');
        if (notes) { notes.value = ''; }

        modal.hidden = false;
        document.body.classList.add('earn-modal-open');
        var first = isVideo ? videoInput : fileInput;
        if (first) { try { first.focus(); } catch (err) { /* ignore */ } }
    }

    function closeModal() {
        if (!modal) { return; }
        modal.hidden = true;
        document.body.classList.remove('earn-modal-open');
    }

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        // Open from a card's Submit button.
        var start = t.closest('[data-earn-start]');
        if (start) { openModal(start.closest('.ecard')); return; }

        // Close (backdrop, ✕, Cancel).
        if (t.closest('[data-earn-close]')) { closeModal(); return; }

        // Example-screenshot lightbox.
        var zoom = t.closest('[data-earn-zoom]');
        if (zoom) { openZoom(zoom.getAttribute('src'), zoom.getAttribute('alt')); return; }
        if (t.closest('[data-earn-zoomclose]') || (t.hasAttribute && t.hasAttribute('data-earn-zoombox'))) { closeZoom(); return; }
    });

    // Show the chosen file's name.
    document.addEventListener('change', function (ev) {
        var t = ev.target;
        if (!t || !t.matches || !t.matches('[data-earn-file]')) { return; }
        var face = el('[data-earn-filename]');
        if (face) { face.textContent = (t.files && t.files[0]) ? t.files[0].name : 'Choose an image (PNG / JPG, max 4 MB)'; }
    });

    // Guard the submit: proof must be attached. The native form POSTs after.
    var form = document.querySelector('[data-earn-form]');
    if (form) {
        form.addEventListener('submit', function (ev) {
            var videoField = el('[data-earn-videofield]');
            var isVideo = videoField && !videoField.hidden;
            var ok;
            if (isVideo) {
                var v = el('[data-earn-video]');
                ok = v && String(v.value || '').trim() && /^https?:\/\//i.test(String(v.value).trim());
                if (!ok) { ev.preventDefault(); flashHint(videoField, 'Please paste a valid video link (https://…).'); }
            } else {
                var f = el('[data-earn-file]');
                ok = f && f.files && f.files.length > 0;
                if (!ok) { ev.preventDefault(); flashHint(el('[data-earn-photofield]'), 'Please choose a screenshot to upload.'); return; }
                if (f.files[0] && f.files[0].size > 4 * 1024 * 1024) { ev.preventDefault(); flashHint(el('[data-earn-photofield]'), 'That image is over 4 MB — please pick a smaller one.'); return; }
            }
            if (ok) {
                var btn = el('[data-earn-submit]');
                if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
            }
        });
    }

    // Small inline validation hint under a field (no native alert()).
    function flashHint(field, msg) {
        if (!field) { return; }
        var hint = field.querySelector('.earn-field__err');
        if (!hint) { hint = document.createElement('p'); hint.className = 'earn-field__err'; field.appendChild(hint); }
        hint.textContent = msg;
        field.classList.add('has-err');
    }

    // Esc closes whichever overlay is open.
    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') { return; }
        if (zoomBox && !zoomBox.hidden) { closeZoom(); return; }
        if (modal && !modal.hidden) { closeModal(); }
    });

    // ── Example-screenshot lightbox ───────────────────────────────────
    var zoomBox = document.querySelector('[data-earn-zoombox]');
    function openZoom(src, alt) {
        if (!zoomBox || !src) { return; }
        var img = zoomBox.querySelector('[data-earn-zoomimg]');
        if (img) { img.setAttribute('src', src); img.setAttribute('alt', alt || ''); }
        zoomBox.hidden = false;
        document.body.classList.add('earn-modal-open');
    }
    function closeZoom() {
        if (!zoomBox) { return; }
        zoomBox.hidden = true;
        var img = zoomBox.querySelector('[data-earn-zoomimg]');
        if (img) { img.setAttribute('src', ''); }
        if (!modal || modal.hidden) { document.body.classList.remove('earn-modal-open'); }
    }
})();
