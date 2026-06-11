/*
 * pages/product-form.js
 *
 * What:  Add/Edit product form helpers — reveal the "unavailable until" field
 *        only for status 5, and live-preview the chosen image. The form posts
 *        normally (multipart); this is the progressive layer.
 * Used:  extra_js for products/form.ejs.
 */
(function () {
    'use strict';

    var toast = window.AdminUi.showToastSafe;

    document.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.matches) { return; }

        if (t.matches('[data-status]')) {
            var f = document.querySelector('[data-until-field]');
            if (f) { f.hidden = String(t.value) !== '5'; }
            return;
        }

        if (t.matches('[data-schedule]')) {
            var sf = document.querySelector('[data-schedule-fields]');
            if (sf) { sf.hidden = !(t.value === 'Daily' || t.value === 'Weekly'); }
            return;
        }

        if (t.matches('[data-img-input]')) {
            var file = t.files && t.files[0];
            var prev = document.querySelector('[data-img-prev]');
            if (!file || !prev) { return; }
            if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { toast('error', 'Please choose a PNG, JPG, WEBP or GIF image.'); t.value = ''; return; }
            if (file.size > 5 * 1024 * 1024) { toast('error', 'Image must be under 5 MB.'); t.value = ''; return; }
            var img = prev.querySelector('[data-img-thumb]');
            if (!img) {
                var ph = prev.querySelector('[data-img-ph]');
                if (ph) { ph.parentNode.removeChild(ph); }
                img = document.createElement('img');
                img.setAttribute('data-img-thumb', '');
                img.alt = '';
                prev.appendChild(img);
            }
            if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
        }
    });
})();
