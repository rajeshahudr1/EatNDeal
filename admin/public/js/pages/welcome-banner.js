/*
 * pages/welcome-banner.js — the super-admin Welcome Banner form.
 * Shows the Text OR Image section based on the content-type select, and
 * previews a chosen banner image. Save is a normal multipart form POST.
 */
(function () {
    'use strict';

    var form = document.querySelector('[data-wb-form]');
    if (!form) { return; }
    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe)
        || function (t, m) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(t, m); } };

    // Show only the section matching the selected content type.
    var typeSel = form.querySelector('[data-wb-type]');
    function syncType() {
        var t = typeSel ? typeSel.value : 'text';
        form.querySelectorAll('[data-wb-section]').forEach(function (s) {
            s.hidden = s.getAttribute('data-wb-section') !== t;
        });
    }
    if (typeSel) { typeSel.addEventListener('change', syncType); syncType(); }

    // Confirm before soft-deleting the banner.
    var delForm = document.querySelector('[data-wb-delete-form]');
    if (delForm) {
        delForm.addEventListener('submit', function (e) {
            if (!window.confirm('Delete the welcome banner? It will stop showing on the home page (kept, recoverable).')) { e.preventDefault(); }
        });
    }

    // Banner image preview.
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
})();
