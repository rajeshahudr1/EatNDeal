/*
 * pages/account.js
 *
 * What:  Drives the "Your Profile" screen (views/account/index.ejs):
 *          • Clear (×) buttons on Name / Date of birth.
 *          • CHANGE toggles for Mobile / Email — swap the read-only
 *            display for the editable control.
 *          • Country picker chip for the mobile editor (lazy-loads
 *            /api/v1/countries) + digits-only phone input.
 *          • Dirty tracking — the "Update profile" button stays
 *            disabled until something actually changes.
 *          • Avatar pencil → "coming soon" toast (no upload yet — the
 *            customer table has no image column).
 *          • Custom gender dropdown (button + listbox) replacing the
 *            native <select> for a consistent look.
 *          • Submit guard (name required, valid phone length).
 * Used:  Loaded via extra_js when AuthController renders /account.
 */

(function () {
    'use strict';

    var picker, pickerList, pickerSearch, pickerEmpty;
    var chipFlag, chipCode, hiddenIso, hiddenDial, phoneInput;
    var form, submitBtn;

    var COUNTRIES = null;
    var loading   = false;

    function cacheRefs() {
        picker       = document.getElementById('country-picker');
        pickerList   = document.getElementById('country-picker-list');
        pickerSearch = document.getElementById('country-picker-search');
        pickerEmpty  = document.getElementById('country-picker-empty');

        chipFlag   = document.getElementById('country-chip-flag');
        chipCode   = document.getElementById('country-chip-code');
        hiddenIso  = document.getElementById('account-country-iso');
        hiddenDial = document.getElementById('account-country-dial');
        phoneInput = document.getElementById('pf-mobile');

        form       = document.getElementById('account-form');
        submitBtn  = document.querySelector('[data-submit]');
    }

    // Enable "Update profile" once the user changes anything.
    function markDirty() { if (submitBtn) { submitBtn.disabled = false; } }

    // ── Country picker ─────────────────────────────────────────────
    async function openPicker() {
        if (!picker) { return; }
        picker.hidden = false;
        picker.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (!COUNTRIES && !loading) { await loadCountries(); }
        render(pickerSearch ? pickerSearch.value : '');
        window.setTimeout(function () { if (pickerSearch) { pickerSearch.focus(); } }, 220);
    }
    function closePicker() {
        if (!picker) { return; }
        var active = document.activeElement;
        if (active && picker.contains(active) && typeof active.blur === 'function') { active.blur(); }
        picker.setAttribute('aria-hidden', 'true');
        picker.hidden = true;
        document.body.style.overflow = '';
    }
    async function loadCountries() {
        loading = true;
        if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'Loading…'; }
        try {
            var data = await window.EatNDealApi.get('/api/v1/countries');
            COUNTRIES = (data && data.countries) || [];
        } catch (err) {
            if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast('error', err.message || 'Could not load country list.'); }
            COUNTRIES = [];
        }
        loading = false;
    }
    function render(query) {
        if (!pickerList) { return; }
        var q = String(query || '').trim().toLowerCase();
        var qDigits = q.replace(/^\+/, '');
        while (pickerList.firstChild) { pickerList.removeChild(pickerList.firstChild); }
        if (!COUNTRIES) { if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'Loading…'; } return; }
        var currentIso = (hiddenIso && hiddenIso.value) || 'GB';
        var matched = COUNTRIES.filter(function (c) {
            if (!q) { return true; }
            if (c.name.toLowerCase().indexOf(q) !== -1) { return true; }
            if (c.iso.toLowerCase().indexOf(q) !== -1) { return true; }
            if (qDigits && c.dial.replace('+', '').indexOf(qDigits) === 0) { return true; }
            return false;
        });
        if (!matched.length) { if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'No matches.'; } return; }
        if (pickerEmpty) { pickerEmpty.hidden = true; }
        matched.forEach(function (c) {
            var li = document.createElement('li');
            li.className = 'country-picker__item' + (c.iso === currentIso ? ' is-selected' : '');
            li.setAttribute('role', 'option'); li.setAttribute('tabindex', '0');
            var flag = document.createElement('span'); flag.className = 'country-picker__flag'; flag.textContent = c.flag;
            var name = document.createElement('span'); name.className = 'country-picker__name'; name.textContent = c.name;
            var dial = document.createElement('span'); dial.className = 'country-picker__dial'; dial.textContent = c.dial;
            li.appendChild(flag); li.appendChild(name); li.appendChild(dial);
            li.addEventListener('click', function () { selectCountry(c); });
            li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectCountry(c); } });
            pickerList.appendChild(li);
        });
    }
    function selectCountry(c) {
        if (chipFlag)   { chipFlag.textContent = c.flag; }
        if (chipCode)   { chipCode.textContent = c.dial; }
        if (hiddenIso)  { hiddenIso.value = c.iso; }
        if (hiddenDial) { hiddenDial.value = c.dial; }
        markDirty();
        closePicker();
        if (phoneInput) { phoneInput.focus(); }
    }

    // ── Phone digits-only ──────────────────────────────────────────
    function stripNonDigits() {
        if (!phoneInput) { return; }
        var raw = phoneInput.value || '';
        var cleaned = raw.replace(/\D/g, '');
        if (cleaned === raw) { return; }
        var caret = phoneInput.selectionStart || cleaned.length;
        var before = raw.slice(0, caret).replace(/\D/g, '').length;
        phoneInput.value = cleaned;
        try { phoneInput.setSelectionRange(before, before); } catch (e) { /* ignore */ }
    }
    function blockNonDigitKey(ev) {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length > 1) { return; }
        if (!/^[0-9]$/.test(ev.key)) { ev.preventDefault(); }
    }

    // ── Field interactions: clear / CHANGE toggle / avatar ─────────
    function bindFieldActions() {
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            // Clear (×) — empty the target input.
            var clearBtn = t.closest('[data-clear]');
            if (clearBtn) {
                ev.preventDefault();
                var inp = document.getElementById(clearBtn.getAttribute('data-clear'));
                if (inp) { inp.value = ''; inp.focus(); markDirty(); }
                return;
            }

            // CHANGE — reveal the editable control for mobile / email.
            var changeBtn = t.closest('[data-action="change-mobile"], [data-action="change-email"]');
            if (changeBtn) {
                ev.preventDefault();
                var lock = changeBtn.closest('.pf-field--lock');
                if (lock) {
                    lock.classList.add('is-editing');
                    var edit = lock.querySelector('[data-edit]');
                    if (edit) { edit.hidden = false; }
                    var firstInput = edit && edit.querySelector('input');
                    if (firstInput) { firstInput.focus(); }
                    markDirty();
                }
                return;
            }

            // Avatar pencil — open the file picker (upload wired below).
            if (t.closest('[data-action="avatar-edit"]')) {
                ev.preventDefault();
                var fileInput = document.querySelector('[data-avatar-input]');
                if (fileInput) { fileInput.click(); }
                return;
            }

            // Sidebar tabs / cards without a destination yet → friendly
            // "coming soon" toast. The wired tabs (My Profile, Addresses,
            // Help & Support) use real links / data-action instead.
            var soon = t.closest('[data-acct-soon]');
            if (soon) {
                ev.preventDefault();
                var what = soon.getAttribute('data-acct-soon') || 'This';
                if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast('info', what + ' is coming soon.'); }
                return;
            }
        });
    }

    // ── Custom dropdown (gender) ───────────────────────────────────
    // A button + listbox that mirrors a native <select> but is styled
    // consistently. The hidden input inside the wrapper carries the
    // value to the form. Markup: views/account/index.ejs.
    var openSelect = null;
    function closeSelects() {
        var open = document.querySelectorAll('[data-pf-select].is-open');
        for (var i = 0; i < open.length; i++) {
            open[i].classList.remove('is-open');
            var b = open[i].querySelector('[data-pf-select-btn]');
            var m = open[i].querySelector('[data-pf-select-menu]');
            if (b) { b.setAttribute('aria-expanded', 'false'); }
            if (m) { m.hidden = true; }
        }
        openSelect = null;
    }
    function openSelectEl(wrap) {
        closeSelects();
        wrap.classList.add('is-open');
        var b = wrap.querySelector('[data-pf-select-btn]');
        var m = wrap.querySelector('[data-pf-select-menu]');
        if (b) { b.setAttribute('aria-expanded', 'true'); }
        if (m) { m.hidden = false; }
        openSelect = wrap;
    }
    function bindCustomSelects() {
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            var btn = t.closest('[data-pf-select-btn]');
            if (btn) {
                ev.preventDefault();
                var wrap = btn.closest('[data-pf-select]');
                if (wrap && wrap.classList.contains('is-open')) { closeSelects(); }
                else if (wrap) { openSelectEl(wrap); }
                return;
            }

            var opt = t.closest('.pf-select__opt');
            if (opt) {
                var w = opt.closest('[data-pf-select]');
                if (!w) { return; }
                var value   = opt.getAttribute('data-value') || '';
                var label   = (opt.textContent || '').trim();
                var hidden  = w.querySelector('input[type="hidden"]');
                var valueEl = w.querySelector('[data-pf-select-value]');
                if (hidden)  { hidden.value = value; }
                if (valueEl) { valueEl.textContent = label; valueEl.classList.toggle('is-placeholder', !value); }
                var opts = w.querySelectorAll('.pf-select__opt');
                for (var j = 0; j < opts.length; j++) {
                    var on = (opts[j] === opt);
                    opts[j].classList.toggle('is-selected', on);
                    opts[j].setAttribute('aria-selected', on ? 'true' : 'false');
                }
                markDirty();
                closeSelects();
                return;
            }

            // A click anywhere outside an open dropdown dismisses it.
            if (openSelect && !t.closest('[data-pf-select]')) { closeSelects(); }
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && openSelect) { closeSelects(); }
        });
    }

    // ── Avatar upload ──────────────────────────────────────────────
    // The hidden file input (next to the avatar) fires this on pick. We
    // POST the file to /account/avatar (multipart); on success the server
    // returns the stored URL, which we drop straight into the avatar.
    async function uploadAvatar(file) {
        if (!file) { return; }
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { toastA('error', 'Please choose a PNG or JPG image.'); return; }
        if (file.size > 3 * 1024 * 1024) { toastA('error', 'Image must be under 3 MB.'); return; }

        var fd = new FormData();
        fd.append('avatar', file);
        try {
            var resp = await fetch('/account/avatar', { method: 'POST', credentials: 'same-origin', body: fd });
            var body = await resp.json();
            if (body && body.status === 200 && body.data && body.data.image) {
                setAvatarImage(body.data.image);
                toastA('success', body.msg || 'Profile photo updated.');
            } else {
                toastA('error', (body && body.msg) || 'Could not upload your photo.');
            }
        } catch (e) {
            toastA('warn', 'Could not upload right now — please check your connection.');
        }
    }
    function toastA(type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } }
    // Swap the initial for the uploaded image in the profile circle + the
    // header avatars (so it updates without a reload). Cache-bust the URL.
    function setAvatarImage(url) {
        var src = url + (url.indexOf('?') === -1 ? '?t=' + Date.now() : '');
        var circle = document.querySelector('[data-avatar-circle]');
        if (circle) { circle.textContent = ''; var img = document.createElement('img'); img.src = src; img.alt = 'Profile photo'; circle.appendChild(img); }
        document.querySelectorAll('.account-menu__avatar, .site-header__avatar').forEach(function (el) {
            el.textContent = ''; el.style.backgroundImage = 'url("' + src + '")'; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center';
        });
    }

    // ── Submit guard ───────────────────────────────────────────────
    function onSubmit(ev) {
        var name = document.getElementById('pf-name');
        if (name && !name.value.trim()) { ev.preventDefault(); name.focus(); return; }
        if (phoneInput) {
            var v = (phoneInput.value || '').trim();
            if (v && v.length < 6) {
                ev.preventDefault();
                if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast('error', 'Please enter a valid mobile number (6–15 digits).'); }
                phoneInput.focus();
                return;
            }
        }
    }

    function onReady() {
        cacheRefs();
        if (!form) { return; }

        if (phoneInput) {
            phoneInput.addEventListener('keydown', blockNonDigitKey);
            phoneInput.addEventListener('input', stripNonDigits);
            phoneInput.addEventListener('paste', function () { window.setTimeout(stripNonDigits, 0); });
        }

        // Any edit in the form enables the Update button.
        form.addEventListener('input', markDirty);
        form.addEventListener('change', markDirty);
        form.addEventListener('submit', onSubmit);

        bindFieldActions();
        bindCustomSelects();

        // Avatar file picker → upload on selection.
        var avatarInput = document.querySelector('[data-avatar-input]');
        if (avatarInput) {
            avatarInput.addEventListener('change', function () {
                if (avatarInput.files && avatarInput.files[0]) { uploadAvatar(avatarInput.files[0]); }
                avatarInput.value = '';
            });
        }

        // Country picker open/close + search.
        document.addEventListener('click', function (ev) {
            var openBtn  = ev.target.closest && ev.target.closest('[data-action="open-country-picker"]');
            var closeBtn = ev.target.closest && ev.target.closest('[data-action="close-country-picker"]');
            if (openBtn)  { ev.preventDefault(); openPicker(); }
            if (closeBtn) { ev.preventDefault(); closePicker(); }
        });
        if (pickerSearch) {
            var tm = null;
            pickerSearch.addEventListener('input', function () {
                if (tm) { window.clearTimeout(tm); }
                tm = window.setTimeout(function () { render(pickerSearch.value); }, 80);
            });
        }
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && picker && picker.getAttribute('aria-hidden') === 'false') { closePicker(); }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
