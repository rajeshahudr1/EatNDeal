/*
 * ui/review.js
 *
 * What:  Drives the post-order "Rate & Review" modal (views/order/detail.ejs):
 *          • Open / close (data-action open-review / close-review).
 *          • Star selector — tap a star, fills 1..n + writes the hidden
 *            `rating` field.
 *          • Optional food photo — local preview before upload. The order-detail
 *            form no longer renders that field (stars + text only), so these
 *            lookups come back null and the block below simply doesn't bind.
 *            Kept because the handler is still correct for any surface that
 *            does offer a photo, and the api still accepts one.
 *          • Submit — multipart POST to /order/:id/review (rating + text +
 *            photo). On success: toast + reload so the order page shows the
 *            new "Your review" summary + flips the button to "Edit".
 * Why:   No inline JS (CSP rule #6) — a global, self-guarding module like
 *        the other /js/ui/* files. No-ops when the review form isn't on the
 *        page (every other page).
 * Used:  Loaded globally from views/_layout.ejs.
 */
(function () {
    'use strict';

    var modal, form, starsWrap, ratingInput, photoInput, preview, submitBtn;

    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    function cache() {
        modal       = document.querySelector('[data-review-modal]');
        form        = document.querySelector('[data-review-form]');
        starsWrap   = form && form.querySelector('[data-review-stars]');
        ratingInput = form && form.querySelector('[data-review-rating]');
        photoInput  = form && form.querySelector('[data-review-photo]');
        preview     = form && form.querySelector('[data-review-preview]');
        submitBtn   = form && form.querySelector('[data-review-submit]');
    }

    function openModal()  { if (modal) { modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; } }
    function closeModal() { if (modal) { modal.hidden = true;  modal.setAttribute('aria-hidden', 'true');  document.body.style.overflow = ''; } }

    function paintStars(val) {
        if (!starsWrap) { return; }
        var stars = starsWrap.querySelectorAll('.review-star');
        for (var i = 0; i < stars.length; i++) {
            stars[i].classList.toggle('is-on', Number(stars[i].getAttribute('data-star')) <= val);
        }
    }

    function onReady() {
        cache();
        if (!form) { return; }   // not the order-detail page

        // Open / close — delegated so the CTA button + backdrop + × all work.
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }
            if (t.closest('[data-action="open-review"]'))  { ev.preventDefault(); openModal();  return; }
            if (t.closest('[data-action="close-review"]')) { ev.preventDefault(); closeModal(); return; }
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && modal && !modal.hidden) { closeModal(); }
        });

        // Star selector.
        if (starsWrap) {
            starsWrap.addEventListener('click', function (ev) {
                var btn = ev.target.closest && ev.target.closest('.review-star');
                if (!btn) { return; }
                var val = Number(btn.getAttribute('data-star')) || 0;
                if (ratingInput) { ratingInput.value = String(val); }
                paintStars(val);
            });
        }

        // Photo preview (client-side validate first).
        if (photoInput) {
            photoInput.addEventListener('change', function () {
                var f = photoInput.files && photoInput.files[0];
                if (!f) { return; }
                if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) { toast('error', 'Please choose a PNG or JPG image.'); photoInput.value = ''; return; }
                if (f.size > 4 * 1024 * 1024) { toast('error', 'Photo must be under 4 MB.'); photoInput.value = ''; return; }
                if (preview) { preview.src = URL.createObjectURL(f); preview.hidden = false; }
            });
        }

        // Submit — multipart (FormData carries rating + review + photo file).
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var rating = Number(ratingInput && ratingInput.value) || 0;
            if (rating < 1) { toast('error', 'Please tap a star to rate your order.'); return; }

            var url = form.getAttribute('data-review-url');
            var fd  = new FormData(form);
            if (submitBtn) { submitBtn.dataset.label = submitBtn.textContent; submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

            fetch(url, { method: 'POST', credentials: 'same-origin', body: fd })
                .then(function (resp) { return resp.json(); })
                .then(function (body) {
                    if (body && body.status === 200) {
                        toast('success', 'Thanks for your review!');
                        closeModal();
                        window.setTimeout(function () { window.location.reload(); }, 700);
                    } else {
                        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.label || 'Submit review'; }
                        toast('error', (body && body.msg) || 'Could not save your review. Please try again.');
                    }
                })
                .catch(function () {
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.label || 'Submit review'; }
                    toast('warn', 'Could not save right now — please check your connection.');
                });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
