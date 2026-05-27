/*
 * pages/account.js
 *
 * What:  Drives the /account profile screen:
 *          • Country picker chip — same overlay as the sign-in page.
 *            Lazy-fetches /api/v1/countries on first open, filters by
 *            name / dial code, updates the chip + hidden inputs.
 *          • Mobile-number input — digits-only enforcement (block
 *            letters/symbols at keydown, strip pasted formatting).
 *          • Submit guard — refuse if only ONE of country / mobile is
 *            filled (matches the api's "travel together" rule).
 * Why:   Same UX as the sign-in flow, scoped to the account edit form.
 * Used:  Loaded by views/_layout.ejs via extra_js when AuthController
 *        renders the account page.
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    // ── Module-scope DOM refs ──────────────────────────────────────
    var picker, pickerList, pickerSearch, pickerEmpty;
    var chipFlag, chipCode, hiddenIso, hiddenDial, phoneInput;
    var form;

    var COUNTRIES = null;
    var loading   = false;

    function cacheRefs() {
        picker        = document.getElementById('country-picker');
        pickerList    = document.getElementById('country-picker-list');
        pickerSearch  = document.getElementById('country-picker-search');
        pickerEmpty   = document.getElementById('country-picker-empty');

        chipFlag      = document.getElementById('country-chip-flag');
        chipCode      = document.getElementById('country-chip-code');
        hiddenIso     = document.getElementById('account-country-iso');
        hiddenDial    = document.getElementById('account-country-dial');
        phoneInput    = document.getElementById('account-mobile');

        form          = document.getElementById('account-form');
    }

    // ── Country picker — open / fetch / render / pick ──────────────

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
        if (active && picker.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }
        picker.setAttribute('aria-hidden', 'true');
        picker.hidden = true;
        document.body.style.overflow = '';
    }

    async function loadCountries() {
        loading = true;
        renderLoading();
        try {
            var data = await window.EatNDealApi.get('/api/v1/countries');
            COUNTRIES = (data && data.countries) || [];
        } catch (err) {
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('error', err.message || 'Could not load country list.');
            }
            COUNTRIES = [];
        }
        loading = false;
    }

    function renderLoading() {
        if (!pickerList) { return; }
        while (pickerList.firstChild) { pickerList.removeChild(pickerList.firstChild); }
        if (pickerEmpty) {
            pickerEmpty.hidden = false;
            pickerEmpty.textContent = 'Loading…';
        }
    }

    function render(query) {
        if (!pickerList) { return; }
        var q       = String(query || '').trim().toLowerCase();
        var qDigits = q.replace(/^\+/, '');

        while (pickerList.firstChild) { pickerList.removeChild(pickerList.firstChild); }

        if (!COUNTRIES) {
            if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'Loading…'; }
            return;
        }

        var currentIso = (hiddenIso && hiddenIso.value) || 'GB';
        var matched = COUNTRIES.filter(function (c) {
            if (!q) return true;
            if (c.name.toLowerCase().indexOf(q) !== -1) return true;
            if (c.iso.toLowerCase().indexOf(q) !== -1)  return true;
            if (qDigits && c.dial.replace('+', '').indexOf(qDigits) === 0) return true;
            return false;
        });

        if (matched.length === 0) {
            if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'No matches.'; }
            return;
        }
        if (pickerEmpty) { pickerEmpty.hidden = true; }

        matched.forEach(function (c) {
            var li = document.createElement('li');
            li.className = 'country-picker__item' + (c.iso === currentIso ? ' is-selected' : '');
            li.setAttribute('role', 'option');
            li.setAttribute('tabindex', '0');

            var flag = document.createElement('span');
            flag.className   = 'country-picker__flag';
            flag.textContent = c.flag;

            var name = document.createElement('span');
            name.className   = 'country-picker__name';
            name.textContent = c.name;

            var dial = document.createElement('span');
            dial.className   = 'country-picker__dial';
            dial.textContent = c.dial;

            li.appendChild(flag);
            li.appendChild(name);
            li.appendChild(dial);

            li.addEventListener('click', function () { selectCountry(c); });
            li.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectCountry(c);
                }
            });
            pickerList.appendChild(li);
        });
    }

    function selectCountry(c) {
        if (chipFlag)   { chipFlag.textContent  = c.flag; }
        if (chipCode)   { chipCode.textContent  = c.dial; }
        if (hiddenIso)  { hiddenIso.value       = c.iso; }
        if (hiddenDial) { hiddenDial.value      = c.dial; }
        closePicker();
        if (phoneInput) { phoneInput.focus(); }
    }

    // ── Phone input — digits-only ──────────────────────────────────

    /**
     * stripNonDigits — same caret-preserving scrub as the sign-in page.
     */
    function stripNonDigits() {
        if (!phoneInput) { return; }
        var raw     = phoneInput.value || '';
        var cleaned = raw.replace(/\D/g, '');
        if (cleaned === raw) { return; }
        var caret   = phoneInput.selectionStart || cleaned.length;
        var before  = raw.slice(0, caret).replace(/\D/g, '').length;
        phoneInput.value = cleaned;
        try { phoneInput.setSelectionRange(before, before); }
        catch (e) { /* ignore */ }
    }

    /**
     * blockNonDigitKey — keydown swallow for letters / punctuation.
     */
    function blockNonDigitKey(ev) {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length > 1) { return; }
        if (!/^[0-9]$/.test(ev.key)) { ev.preventDefault(); }
    }

    // ── Submit guard ───────────────────────────────────────────────
    // Only stop the submit when the user has STARTED to fill the phone
    // but left it half-finished. An empty phone is allowed (no-op for
    // OTP users who don't want to change anything).
    function onSubmit(ev) {
        if (!form) { return; }
        var name  = document.getElementById('account-name');
        if (name && !name.value.trim()) {
            ev.preventDefault();
            name.focus();
            return;
        }
        if (phoneInput) {
            var v = (phoneInput.value || '').trim();
            if (v && v.length < 6) {
                ev.preventDefault();
                if (window.EatNDealUi && window.EatNDealUi.showToast) {
                    window.EatNDealUi.showToast('error', 'Please enter a valid mobile number (6–15 digits).');
                }
                phoneInput.focus();
                return;
            }
        }
        // Let the browser submit to /account.
    }

    // ── Wire up ────────────────────────────────────────────────────

    function onReady() {
        cacheRefs();
        if (!form) { return; }

        if (phoneInput) {
            phoneInput.addEventListener('keydown', blockNonDigitKey);
            phoneInput.addEventListener('input', stripNonDigits);
            phoneInput.addEventListener('paste', function () {
                window.setTimeout(stripNonDigits, 0);
            });
        }

        form.addEventListener('submit', onSubmit);

        // Open / close the country picker via delegated data-action.
        document.addEventListener('click', function (ev) {
            var openBtn  = ev.target.closest && ev.target.closest('[data-action="open-country-picker"]');
            var closeBtn = ev.target.closest && ev.target.closest('[data-action="close-country-picker"]');
            if (openBtn)  { ev.preventDefault(); openPicker(); }
            if (closeBtn) { ev.preventDefault(); closePicker(); }
        });

        if (pickerSearch) {
            var t = null;
            pickerSearch.addEventListener('input', function () {
                if (t) { window.clearTimeout(t); }
                t = window.setTimeout(function () { render(pickerSearch.value); }, 80);
            });
        }

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && picker && picker.getAttribute('aria-hidden') === 'false') {
                closePicker();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
