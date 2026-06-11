/*
 * pages/store-settings.js
 *
 * What:  Drives the Store Settings form:
 *          • on/off switches → sync a hidden input + reveal/hide dependent
 *            blocks (data-reveal="X" shows when ON, data-reveal-off="X" shows
 *            when OFF — used for the per-service "closed until" panels).
 *          • segmented button groups → set the group's hidden value + active
 *            style; a group with data-tab-for reveals its date block when 2.
 *          • Store-status modal (open/close + radio-driven sub-blocks).
 * Used:  extra_js for store-settings/index.ejs.
 */
(function () {
    'use strict';

    function setReveal(name, isOn) {
        var on = document.querySelectorAll('[data-reveal="' + name + '"]');
        for (var i = 0; i < on.length; i++) { on[i].hidden = !isOn; }
        var off = document.querySelectorAll('[data-reveal-off="' + name + '"]');
        for (var j = 0; j < off.length; j++) { off[j].hidden = isOn; }
    }

    function setTabDate(tabFor, value) {
        var blocks = document.querySelectorAll('[data-tab-date="' + tabFor + '"]');
        for (var i = 0; i < blocks.length; i++) { blocks[i].hidden = String(value) !== '2'; }
    }

    var toast = window.AdminUi.showToastSafe;

    // Custom file picker: validate (type + size), show the chosen filename and
    // a live preview. Mirrors the server-side multer rules so the user gets an
    // instant, friendly message instead of a failed upload.
    function handleImagePick(input) {
        var label = input.closest('.ss-img');
        if (!label) { return; }
        var nameEl = label.querySelector('[data-img-name]');
        var preview = label.querySelector('[data-img-preview]');
        var file = input.files && input.files[0];

        function resetName() { if (nameEl) { nameEl.textContent = 'No file chosen'; nameEl.classList.remove('is-set'); } }

        if (!file) { resetName(); return; }

        var okType = /^image\/(png|jpe?g|webp)$/.test(file.type);
        var okSize = file.size <= 4 * 1024 * 1024;
        if (!okType || !okSize) {
            input.value = '';
            resetName();
            toast('error', !okType ? 'Please choose a PNG, JPG or WEBP image.' : 'Image must be under 4 MB.');
            return;
        }

        if (nameEl) { nameEl.textContent = file.name; nameEl.classList.add('is-set'); }

        if (preview && window.URL && window.URL.createObjectURL) {
            var img = preview.querySelector('[data-img-thumb]');
            if (!img) {
                var ph = preview.querySelector('[data-img-ph]');
                if (ph) { ph.parentNode.removeChild(ph); }
                img = document.createElement('img');
                img.setAttribute('data-img-thumb', '');
                img.alt = '';
                preview.insertBefore(img, preview.querySelector('.ss-img__overlay') || null);
            }
            img.src = window.URL.createObjectURL(file);
        }
    }

    function statusModal() { return document.querySelector('[data-ss-modal]'); }
    function closeStatus() { var m = statusModal(); if (m) { m.hidden = true; } }
    function openStatus()  { var m = statusModal(); if (m) { m.hidden = false; } }
    function syncStatusBlocks() {
        var radios = document.querySelectorAll('[data-status-radios] input[name="status_mode"]');
        var picked = 'open';
        for (var i = 0; i < radios.length; i++) { if (radios[i].checked) { picked = radios[i].value; } }
        var blocks = document.querySelectorAll('[data-status-block]');
        for (var j = 0; j < blocks.length; j++) { blocks[j].hidden = blocks[j].getAttribute('data-status-block') !== picked; }
    }

    // ── Change: switches + status radios ────────────────────────────
    document.addEventListener('change', function (ev) {
        var el = ev.target;
        if (!el || !el.matches) { return; }
        if (el.matches('.ss-switch__cb[data-sync]')) {
            var name = el.getAttribute('data-sync');
            var hidden = el.parentNode.querySelector('input[type="hidden"][name="' + name + '"]');
            if (hidden) { hidden.value = el.checked ? '1' : '0'; }
            // data-sync drives data-reveal; data-reveal-off uses a separate key.
            setReveal(name, el.checked);
            var offKey = el.getAttribute('data-reveal-off');
            if (offKey) { setReveal(offKey, el.checked); }
            return;
        }
        if (el.matches('[data-status-radios] input[name="status_mode"]')) {
            syncStatusBlocks();
            return;
        }
        if (el.matches('[data-img-input]')) {
            handleImagePick(el);
        }
    });

    // ── Click: button groups + status modal open/close ──────────────
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        if (t.closest('[data-action="ss-status-open"]'))  { ev.preventDefault(); openStatus(); return; }
        if (t.closest('[data-action="ss-status-close"]')) { ev.preventDefault(); closeStatus(); return; }

        // Quick charity tips modal
        if (t.closest('[data-action="ss-tips-open"]'))  { ev.preventDefault(); var tm = document.querySelector('[data-ss-tips-modal]'); if (tm) { tm.hidden = false; } return; }
        if (t.closest('[data-action="ss-tips-close"]')) { ev.preventDefault(); var tm2 = document.querySelector('[data-ss-tips-modal]'); if (tm2) { tm2.hidden = true; } return; }
        if (t.closest('[data-action="ss-tip-add"]')) {
            ev.preventDefault();
            var tmpl = document.querySelector('[data-tip-template]');
            var list = document.querySelector('[data-tips-list]');
            if (tmpl && list) { list.appendChild(tmpl.content.cloneNode(true)); var inp = list.lastElementChild && list.lastElementChild.querySelector('input'); if (inp) { inp.focus(); } }
            return;
        }
        var tipDel = t.closest('[data-action="ss-tip-remove"]');
        if (tipDel) { ev.preventDefault(); var row = tipDel.closest('.ss-tip-row'); if (row) { row.parentNode.removeChild(row); } return; }

        var btn = t.closest('.ss-btn');
        if (btn) {
            var group = btn.closest('[data-btngroup]');
            if (group) {
                ev.preventDefault();
                var hidden = group.querySelector('input[type="hidden"]');
                if (hidden) { hidden.value = btn.getAttribute('data-value'); }
                var btns = group.querySelectorAll('.ss-btn');
                for (var i = 0; i < btns.length; i++) { btns[i].classList.toggle('is-active', btns[i] === btn); }
                var tabFor = group.getAttribute('data-tab-for');
                if (tabFor) { setTabDate(tabFor, btn.getAttribute('data-value')); }
            }
        }
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') { return; }
        closeStatus();
        var tm = document.querySelector('[data-ss-tips-modal]');
        if (tm) { tm.hidden = true; }
    });
    // ── Client-side validation (mirrors the api Joi rules) ──────────
    function val(el) { return String((el && el.value != null) ? el.value : '').trim(); }

    var SS_LABELS = {
        service_charge_offline_order: 'Service charge', offline_bag_charge: 'Offline bag charge',
        online_bag_charge: 'Online bag charge', price: 'Surprise box price',
        discount_price: 'Surprise box discount price', fix_charity_percentage: 'Charity percentage',
        third_party_percentage: 'Third-party percentage', third_online_website_percentage: 'Online website percentage',
        qty: 'Surprise box quantity', offline_per_bag_qty: 'Items per bag (offline)',
        online_per_bag_qty: 'Items per bag (online)',
    };
    var SS_MONEY = ['service_charge_offline_order', 'offline_bag_charge', 'online_bag_charge', 'price', 'discount_price'];
    var SS_PCT   = ['fix_charity_percentage', 'third_party_percentage', 'third_online_website_percentage'];
    var SS_WHOLE = ['qty', 'offline_per_bag_qty', 'online_per_bag_qty'];

    function validateSettings(form) {
        function field(name) { return form.querySelector('[name="' + name + '"]'); }
        function fail(el, msg) { if (el) { el.classList.add('is-invalid'); el.focus(); } toast('error', msg); return false; }

        var prev = form.querySelectorAll('.is-invalid');
        for (var p = 0; p < prev.length; p++) { prev[p].classList.remove('is-invalid'); }

        var el, v, i;

        el = field('email'); v = val(el);
        if (el && v !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { return fail(el, 'Enter a valid store email address.'); }

        el = field('contact_number'); v = val(el);
        if (el && v !== '' && !/^[0-9+\-() ]{0,15}$/.test(v)) { return fail(el, 'Enter a valid contact number (digits only, max 15).'); }

        for (i = 0; i < SS_MONEY.length; i++) {
            el = field(SS_MONEY[i]); if (!el) { continue; } v = val(el);
            if (v !== '' && (isNaN(Number(v)) || Number(v) < 0)) { return fail(el, SS_LABELS[SS_MONEY[i]] + ' must be a number of 0 or more.'); }
        }
        for (i = 0; i < SS_PCT.length; i++) {
            el = field(SS_PCT[i]); if (!el) { continue; } v = val(el);
            if (v !== '' && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100)) { return fail(el, SS_LABELS[SS_PCT[i]] + ' must be between 0 and 100.'); }
        }
        for (i = 0; i < SS_WHOLE.length; i++) {
            el = field(SS_WHOLE[i]); if (!el) { continue; } v = val(el);
            if (v !== '' && !/^\d+$/.test(v)) { return fail(el, SS_LABELS[SS_WHOLE[i]] + ' must be a whole number.'); }
        }

        // Cross-field: surprise-box discount can't exceed the price.
        var sb = form.querySelector('[name="is_toogoodtogo_product"]');
        var priceEl = field('price'), discEl = field('discount_price');
        if (sb && String(sb.value) === '1' && priceEl && discEl && val(priceEl) !== '' && val(discEl) !== ''
            && Number(val(discEl)) > Number(val(priceEl))) {
            return fail(discEl, 'Surprise box discount price cannot be higher than the price.');
        }
        return true;
    }

    // Clear the invalid highlight as soon as the user edits the field.
    document.addEventListener('input', function (ev) {
        var el = ev.target;
        if (el && el.classList && el.classList.contains('is-invalid')) { el.classList.remove('is-invalid'); }
    });

    document.addEventListener('DOMContentLoaded', function () {
        syncStatusBlocks();
        var form = document.querySelector('.ss-form');
        if (form) {
            form.addEventListener('submit', function (ev) { if (!validateSettings(form)) { ev.preventDefault(); } });
        }
    });
})();
