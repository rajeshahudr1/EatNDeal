/*
 * pages/mp-category-form.js
 *
 * What:  Add/Edit marketplace-category form helpers — emoji icon picker,
 *        live image preview, and auto-slug from the name (until the user edits
 *        the slug by hand). Form posts normally (multipart).
 * Used:  extra_js for marketplace-categories/form.ejs.
 */
(function () {
    'use strict';

    function toast(type, msg) { if (window.AdminUi && window.AdminUi.showToast) { window.AdminUi.showToast(type, msg); } }
    function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

    var slugTouched = false;

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) { return; }

        var pick = t.closest('[data-icon]');
        if (pick) {
            var val = pick.getAttribute('data-icon');
            var hidden = document.querySelector('[data-icon-input]');
            if (hidden) { hidden.value = val; }
            var cur = document.querySelector('[data-icon-current]'); if (cur) { cur.textContent = val; }
            var btns = document.querySelectorAll('.mpc-iconbtn');
            for (var i = 0; i < btns.length; i++) { btns[i].classList.toggle('is-on', btns[i] === pick); }
            // Picking an emoji clears a previously-uploaded image preference is
            // left to the server (image overrides), so we just set the emoji.
            return;
        }
        if (t.closest('[data-action="icon-clear"]')) {
            var h2 = document.querySelector('[data-icon-input]'); if (h2) { h2.value = ''; }
            var c2 = document.querySelector('[data-icon-current]'); if (c2) { c2.textContent = '—'; }
            var b2 = document.querySelectorAll('.mpc-iconbtn.is-on'); for (var j = 0; j < b2.length; j++) { b2[j].classList.remove('is-on'); }
            return;
        }
    });

    document.addEventListener('input', function (e) {
        var t = e.target;
        if (!t || !t.matches) { return; }
        if (t.matches('[data-mc-slug]')) { slugTouched = true; return; }
        if (t.matches('[data-mc-name]')) {
            if (!slugTouched) {
                var slug = document.querySelector('[data-mc-slug]');
                if (slug) { slug.value = slugify(t.value); }
            }
        }
    });

    document.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.matches || !t.matches('[data-img-input]')) { return; }
        var file = t.files && t.files[0];
        var prev = document.querySelector('[data-img-prev]');
        if (!file || !prev) { return; }
        if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.type)) { toast('error', 'Choose a PNG, JPG, WEBP, GIF or SVG.'); t.value = ''; return; }
        if (file.size > 3 * 1024 * 1024) { toast('error', 'Image must be under 3 MB.'); t.value = ''; return; }
        var img = prev.querySelector('[data-img-thumb]');
        if (!img) {
            var ph = prev.querySelector('[data-img-ph]'); if (ph) { ph.parentNode.removeChild(ph); }
            img = document.createElement('img'); img.setAttribute('data-img-thumb', ''); img.alt = ''; prev.appendChild(img);
        }
        if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
    });

    // Client-side validation — mirrors the server (name required + length,
    // sort >= 0). Server re-checks everything regardless.
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.matches || !form.matches('.mpc-form')) { return; }
        var name = form.querySelector('[data-mc-name]');
        var sort = form.querySelector('[data-mc-sort]');
        var nv = name ? name.value.trim() : '';
        if (!nv) { e.preventDefault(); toast('error', 'Category name is required.'); if (name) { name.focus(); } return; }
        if (nv.length > 120) { e.preventDefault(); toast('error', 'Name must be 120 characters or fewer.'); if (name) { name.focus(); } return; }
        if (sort && sort.value !== '' && (isNaN(Number(sort.value)) || Number(sort.value) < 0)) { e.preventDefault(); toast('error', 'Sort order must be 0 or more.'); sort.focus(); return; }
    });

    // If editing with an existing slug, mark it touched so we don't overwrite it.
    document.addEventListener('DOMContentLoaded', function () {
        var slug = document.querySelector('[data-mc-slug]');
        if (slug && slug.value.trim() !== '') { slugTouched = true; }
    });
})();
