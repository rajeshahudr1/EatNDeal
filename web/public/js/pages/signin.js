/*
 * pages/signin.js
 *
 * What:  Drives the sign-in page:
 *          • Fetches GET /api/v1/countries on first picker-open and
 *            renders the country list.
 *          • Handles search (matches name or dial code).
 *          • Picks a country → updates the chip + hidden form fields.
 *          • Validates the phone-number input on submit; shows a toast
 *            (real OTP send wires up once api/customer/send-otp lands).
 *          • Social buttons → "coming soon" toast.
 * Why:   Page-specific behaviour for views/auth/signin.ejs. Kept off
 *        app.js so it only loads when the sign-in page actually renders.
 * Used:  Loaded by views/_layout.ejs via extra_js when SiteController
 *        renders the sign-in page (controller passes
 *        extra_js: '/js/pages/signin.js').
 *
 * Change log:
 *   2026-05-25 — initial.
 */

(function () {
    'use strict';

    // ── Module-scope DOM refs (resolved on DOMContentLoaded) ────────
    var picker, pickerList, pickerSearch, pickerEmpty;
    var chipFlag, chipCode, hiddenIso, hiddenDial, phoneInput;
    var form, errorEl;

    // Fetched once on first picker open + cached. Each entry is
    // { iso, name, dial, flag } as returned by /api/v1/countries.
    var COUNTRIES = null;
    var loading   = false;

    // Default selected country. Matches the UK-based brand. Swap to MY
    // / IN / ... later via api/brand.config.js if you rebrand by region.
    var DEFAULT_ISO = 'GB';

    /**
     * cacheRefs
     *
     * What:  Looks up + caches every DOM ref the page interacts with.
     * Why:   One querySelector pass instead of per-handler.
     */
    function cacheRefs() {
        picker        = document.getElementById('country-picker');
        pickerList    = document.getElementById('country-picker-list');
        pickerSearch  = document.getElementById('country-picker-search');
        pickerEmpty   = document.getElementById('country-picker-empty');

        chipFlag      = document.getElementById('country-chip-flag');
        chipCode      = document.getElementById('country-chip-code');
        hiddenIso     = document.getElementById('signin-country-iso');
        hiddenDial    = document.getElementById('signin-country-dial');
        phoneInput    = document.getElementById('signin-mobile');

        form          = document.getElementById('signin-form');
        errorEl       = document.getElementById('signin-error');
    }

    // ── Country picker: open / close / fetch / render ──────────────

    /**
     * openPicker
     *
     * What:  Shows the country picker overlay. Triggers a one-time
     *        fetch of /api/v1/countries on first open + focuses the
     *        search input after the entrance animation finishes.
     * Why:   Lazy-loading the country list keeps the initial page
     *        payload small (the list is ~12 KB JSON).
     */
    async function openPicker() {
        if (!picker) { return; }
        picker.hidden = false;
        picker.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (!COUNTRIES && !loading) { await loadCountries(); }
        render(pickerSearch ? pickerSearch.value : '');
        // Focus AFTER the rise animation settles so the focus ring
        // doesn't flash mid-transition.
        window.setTimeout(function () { if (pickerSearch) { pickerSearch.focus(); } }, 220);
    }

    /**
     * closePicker
     *
     * What:  Hides the picker + restores body scroll. Moves focus
     *        OUT of the picker before flipping aria-hidden=true so
     *        Chrome doesn't warn about aria-hidden on the focused
     *        ancestor.
     */
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

    /**
     * loadCountries
     *
     * What:  Fetches GET /api/v1/countries and caches the result on
     *        module scope so subsequent opens are instant.
     * Why:   Single network round-trip per page load.
     */
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

    /**
     * renderLoading
     *
     * What:  Shows a brief "Loading…" message in the list area while the
     *        countries fetch is in flight.
     */
    function renderLoading() {
        if (!pickerList) { return; }
        while (pickerList.firstChild) { pickerList.removeChild(pickerList.firstChild); }
        if (pickerEmpty) {
            pickerEmpty.hidden = false;
            pickerEmpty.textContent = 'Loading…';
        }
    }

    /**
     * render
     *
     * What:  Renders the filtered country list. Match strategy:
     *          • Case-insensitive substring in the country NAME, OR
     *          • Substring of the dial code (e.g. typing "44" matches
     *            United Kingdom and Isle of Man)
     * Why:   Both lookups are common; users may know the name OR the
     *        country code.
     */
    function render(query) {
        if (!pickerList) { return; }
        var q = String(query || '').trim().toLowerCase();
        // Remove leading "+" if the user typed it
        var qDigits = q.replace(/^\+/, '');

        while (pickerList.firstChild) { pickerList.removeChild(pickerList.firstChild); }

        if (!COUNTRIES) {
            if (pickerEmpty) { pickerEmpty.hidden = false; pickerEmpty.textContent = 'Loading…'; }
            return;
        }

        var currentIso = (hiddenIso && hiddenIso.value) || DEFAULT_ISO;
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
            li.setAttribute('data-iso',  c.iso);
            li.setAttribute('data-dial', c.dial);
            li.setAttribute('data-flag', c.flag);
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

    /**
     * selectCountry
     *
     * What:  Updates the chip + hidden form fields with the picked
     *        country, then closes the picker.
     */
    function selectCountry(c) {
        if (chipFlag)   { chipFlag.textContent  = c.flag; }
        if (chipCode)   { chipCode.textContent  = c.dial; }
        if (hiddenIso)  { hiddenIso.value       = c.iso; }
        if (hiddenDial) { hiddenDial.value      = c.dial; }
        closePicker();
        if (phoneInput) { phoneInput.focus(); }
    }

    // ── Phone input: digits-only enforcement ───────────────────────

    /**
     * stripNonDigits
     *
     * What:  Removes anything that isn't 0-9 from the current input
     *        value AND preserves the caret position so the user can
     *        keep typing in the middle of a number without the cursor
     *        jumping to the end.
     * Why:   `type="tel"` does NOT actually restrict characters — it
     *        only hints the on-screen keyboard. Without this hook,
     *        users could paste letters, spaces, or the leading "+"
     *        from a copied dial code and we'd have to clean it up
     *        again at submit time. Stripping live is a clearer UX —
     *        whatever the box shows is exactly what we'll send.
     */
    function stripNonDigits() {
        if (!phoneInput) { return; }
        var raw       = phoneInput.value || '';
        var cleaned   = raw.replace(/\D/g, '');
        if (cleaned === raw) { return; }   // nothing to do
        var caret     = phoneInput.selectionStart || cleaned.length;
        // How many non-digit chars sat BEFORE the caret? Shift caret
        // left by that many so the cursor lands where the user expects.
        var before    = raw.slice(0, caret).replace(/\D/g, '').length;
        phoneInput.value = cleaned;
        try {
            phoneInput.setSelectionRange(before, before);
        } catch (e) { /* setSelectionRange not supported on this input — ignore */ }
    }

    /**
     * blockNonDigitKey
     *
     * What:  keydown handler that swallows any key that would insert a
     *        non-digit character. Whitelisted keys (Backspace, Delete,
     *        Tab, arrows, Home, End, Cmd/Ctrl combos for copy/paste/
     *        select-all) pass through untouched.
     * Why:   Prevents the character from ever appearing in the box,
     *        so the user gets immediate "this key did nothing" feedback
     *        rather than seeing a letter appear and then vanish on the
     *        next input event.
     */
    function blockNonDigitKey(ev) {
        // Don't fight modifier combos (Ctrl+A, Cmd+V, etc.) or function
        // keys (F1, F2…). Length > 1 catches every named key.
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length > 1) {
            return;
        }
        if (!/^[0-9]$/.test(ev.key)) {
            ev.preventDefault();
        }
    }

    // ── Form: validate + submit ────────────────────────────────────

    /**
     * validatePhone
     *
     * What:  Returns true if the phone input contains 6-15 digits
     *        (after stripping spaces). Same rule on the api when the
     *        OTP endpoint lands — keeps client + server in sync.
     */
    function validatePhone() {
        if (!phoneInput) { return false; }
        var raw = (phoneInput.value || '').replace(/\D/g, '');
        return raw.length >= 6 && raw.length <= 15;
    }

    /**
     * showError
     *
     * What:  Surfaces a validation message under the phone row + adds
     *        a red border. Cleared on next input event.
     */
    function showError(msg) {
        if (!errorEl) { return; }
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
    }

    /**
     * onSubmit
     *
     * What:  Form submit handler. Validates the phone shape on the
     *        client; if it passes, lets the browser submit the form
     *        normally to POST /signin/start — the server picks it up,
     *        calls /api/v1/auth/send-otp, stashes the phone in session,
     *        and redirects to /signin?step=otp.
     * Why:   No fetch from the browser: the api session lives on the
     *        server, and a plain form POST works without JS (PWA-friendly
     *        + back-button safe).
     */
    function onSubmit(ev) {
        showError('');
        if (!validatePhone()) {
            ev.preventDefault();
            showError('Please enter a valid mobile number (6–15 digits).');
            phoneInput.focus();
            return;
        }
        // Don't preventDefault — let the browser submit to /signin/start.
    }

    // ── Wire up ────────────────────────────────────────────────────

    /**
     * onReady
     *
     * What:  DOM-ready entry. Caches refs + wires every listener.
     */
    /**
     * bindAuthTabs
     *
     * What:  Visual Login / Sign up tab toggle. Both tabs lead to the
     *        same mobile-number OTP flow (the api decides new vs
     *        existing), so this only moves the active underline +
     *        aria-selected — no form swap. Honours the user's "sign-in
     *        and sign-up are one flow" requirement.
     */
    function bindAuthTabs() {
        var tabs = Array.prototype.slice.call(document.querySelectorAll('.auth-tab'));
        if (!tabs.length) { return; }
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                tabs.forEach(function (t) {
                    var on = (t === tab);
                    t.classList.toggle('is-active', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                });
            });
        });
    }

    function onReady() {
        cacheRefs();
        bindAuthTabs();
        if (!form) { return; }   // not on the sign-in page

        // Phone input — digits-only enforcement on every entry path:
        //   • keydown   — block letters/symbols BEFORE they appear
        //   • input     — final-pass scrub (catches paste, autofill,
        //                  IME composition, drag-drop, browser
        //                  password-manager fills) + clear any visible
        //                  validation message
        //   • paste     — explicit handler so we keep the caret tidy
        //                  even when the clipboard has formatting like
        //                  "+44 (0)7712 345 678"
        if (phoneInput) {
            phoneInput.addEventListener('keydown', blockNonDigitKey);
            phoneInput.addEventListener('input', function () {
                stripNonDigits();
                showError('');
            });
            phoneInput.addEventListener('paste', function (ev) {
                // Let the default paste happen, then scrub on the next
                // tick — that way we operate on the merged value (old
                // text + pasted text) instead of having to reconstruct
                // it from the clipboard alone.
                window.setTimeout(stripNonDigits, 0);
            });
        }
        form.addEventListener('submit', onSubmit);

        // Open / close the country picker via delegated data-action.
        // The social buttons are real <a> tags now (Google / Facebook
        // redirect-flow lives on the server side), so no click handler
        // for them — the browser follows the href.
        document.addEventListener('click', function (ev) {
            var openBtn  = ev.target.closest && ev.target.closest('[data-action="open-country-picker"]');
            var closeBtn = ev.target.closest && ev.target.closest('[data-action="close-country-picker"]');
            if (openBtn)  { ev.preventDefault(); openPicker(); }
            if (closeBtn) { ev.preventDefault(); closePicker(); }
        });

        // Search filter — debounced so we don't re-render on every keystroke.
        if (pickerSearch) {
            var t = null;
            pickerSearch.addEventListener('input', function () {
                if (t) { window.clearTimeout(t); }
                t = window.setTimeout(function () { render(pickerSearch.value); }, 80);
            });
        }

        // Esc closes the picker.
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
