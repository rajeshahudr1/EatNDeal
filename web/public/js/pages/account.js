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

    // ── Invite & Earn: share the referral code ─────────────────────
    // Builds ONE friendly message from the code + the site link, then
    // hands it to the chosen platform's share endpoint (new tab). Email
    // and SMS use mailto:/sms: so the device opens its own app; "native"
    // uses the Web Share sheet (Instagram / Messenger on mobile) and
    // falls back to copying the message when the API is missing. Nothing
    // is sent anywhere until the customer picks an app themselves.
    function shareReferral(platform, code) {
        code = (code || '').trim();
        if (!code) { return; }

        var origin  = window.location.origin || 'https://eatndeal.com';
        var link    = origin + '/?ref=' + encodeURIComponent(code);
        var msg     = '🍔 I order on EatNDeal and love it! Use my code ' + code +
                      ' when you sign up — we BOTH earn cashback on your first order. Order here: ' + link;
        var subject = 'Get cashback on EatNDeal — my invite code ' + code;

        var url = '';
        switch (platform) {
            case 'whatsapp':
                url = 'https://wa.me/?text=' + encodeURIComponent(msg);
                break;
            case 'facebook':
                url = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(link) +
                      '&quote=' + encodeURIComponent(msg);
                break;
            case 'twitter':
                url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(msg);
                break;
            case 'telegram':
                url = 'https://t.me/share/url?url=' + encodeURIComponent(link) +
                      '&text=' + encodeURIComponent(msg);
                break;
            case 'email':
                url = 'mailto:?subject=' + encodeURIComponent(subject) +
                      '&body=' + encodeURIComponent(msg);
                break;
            case 'sms':
                // Leading '?&body=' keeps both iOS and Android SMS apps happy.
                url = 'sms:?&body=' + encodeURIComponent(msg);
                break;
            case 'native':
                if (navigator.share) {
                    navigator.share({ title: 'EatNDeal invite', text: msg, url: link })
                        .catch(function () {});
                    return;
                }
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(msg).then(function () {
                        if (window.EatNDealUi && window.EatNDealUi.showToast) {
                            window.EatNDealUi.showToast('success', 'Invite message copied!');
                        }
                    });
                }
                return;
            default:
                return;
        }

        if (platform === 'email' || platform === 'sms') {
            // Same-tab so the OS hands off to the mail / SMS app cleanly.
            window.location.href = url;
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    // ── Orders filter bottom-sheet ─────────────────────────────────
    // Opens/closes the status + date-range popup on the Orders tab. The
    // sheet lives inside the GET filter form, so the Apply button submits
    // every field together (search box + status + dates).
    function toggleOrdersSheet(open) {
        var sheet = document.querySelector('[data-orders-sheet]');
        if (!sheet) { return; }
        sheet.hidden = !open;
        document.body.classList.toggle('ordf-open', !!open);
    }

    // ── Field interactions: clear / CHANGE toggle / avatar ─────────
    function bindFieldActions() {
        // Esc closes the orders filter sheet if it's open.
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && document.body.classList.contains('ordf-open')) {
                toggleOrdersSheet(false);
            }
        });

        // The native "More" button only makes sense where the Web Share
        // API exists (mostly mobile) — reveal it there, leave hidden else.
        if (navigator.share) {
            var moreBtn = document.querySelector('[data-action="share-referral"][data-platform="native"]');
            if (moreBtn) { moreBtn.hidden = false; }
        }

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

            // Change mobile → send an OTP to the NEW number.
            if (t.closest('[data-action="phone-send-otp"]')) {
                ev.preventDefault();
                changePhoneSendOtp(t.closest('.pf-field--lock'));
                return;
            }
            // Change mobile → verify the OTP + save the new number.
            if (t.closest('[data-action="phone-verify-otp"]')) {
                ev.preventDefault();
                changePhoneVerify(t.closest('.pf-field--lock'));
                return;
            }
            // Delete account — button is hidden for now, but the flow is wired.
            if (t.closest('[data-action="delete-account"]')) {
                ev.preventDefault();
                deleteAccountFlow();
                return;
            }

            // Avatar pencil — open the file picker (upload wired below).
            if (t.closest('[data-action="avatar-edit"]')) {
                ev.preventDefault();
                var fileInput = document.querySelector('[data-avatar-input]');
                if (fileInput) { fileInput.click(); }
                return;
            }

            // Addresses tab — everything stays on the page. Add opens a
            // blank inline form; Edit prefills it with the card's row;
            // Cancel hides; Delete confirms then posts. Save submits
            // the form to /address/save and reloads.
            if (t.closest('[data-action="acct-add-address"]')) {
                ev.preventDefault();
                openInlineAddressForm(null);
                return;
            }
            var editBtn = t.closest('[data-action="acct-edit-address"]');
            if (editBtn) {
                ev.preventDefault();
                var card = editBtn.closest('[data-address-id]');
                openInlineAddressForm(readAddressFromCard(card));
                return;
            }
            if (t.closest('[data-action="acct-cancel-address"]')) {
                ev.preventDefault();
                closeInlineAddressForm();
                return;
            }
            var delBtn = t.closest('[data-action="acct-delete-address"]');
            if (delBtn) {
                ev.preventDefault();
                var dcard = delBtn.closest('[data-address-id]');
                deleteAddress(dcard ? dcard.getAttribute('data-address-id') : null);
                return;
            }
            if (t.closest('[data-action="acct-delete-from-form"]')) {
                ev.preventDefault();
                var idForm = document.querySelector('[data-af-id]');
                deleteAddress(idForm ? idForm.value : null);
                return;
            }

            // Payment Methods tab actions.
            if (t.closest('[data-action="acct-add-pm"]'))    { ev.preventDefault(); openPaymentForm();    return; }
            if (t.closest('[data-action="acct-cancel-pm"]')) { ev.preventDefault(); closePaymentForm();   return; }
            if (t.closest('[data-action="acct-save-pm"]'))   { ev.preventDefault(); savePaymentMethod(); return; }
            var pmDel = t.closest('[data-action="acct-delete-pm"]');
            if (pmDel) {
                ev.preventDefault();
                var pmCard = pmDel.closest('[data-pm-id]');
                deletePaymentMethod(pmCard ? pmCard.getAttribute('data-pm-id') : null);
                return;
            }

            // Invite & Earn — copy the referral code to the clipboard.
            var copyRef = t.closest('[data-action="copy-referral"]');
            if (copyRef) {
                ev.preventDefault();
                var refCode = copyRef.getAttribute('data-code') || '';
                if (refCode && navigator.clipboard) {
                    navigator.clipboard.writeText(refCode).then(function () {
                        if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast('success', 'Referral code copied!'); }
                        var orig = copyRef.textContent;
                        copyRef.textContent = 'Copied!';
                        setTimeout(function () { copyRef.textContent = orig; }, 1500);
                    });
                }
                return;
            }

            // Invite & Earn — share the referral code to a platform.
            var shareBtn = t.closest('[data-action="share-referral"]');
            if (shareBtn) {
                ev.preventDefault();
                shareReferral(shareBtn.getAttribute('data-platform'), shareBtn.getAttribute('data-code') || '');
                return;
            }

            // Orders filter — open / close the bottom-sheet popup.
            if (t.closest('[data-action="open-orders-filter"]')) {
                ev.preventDefault();
                toggleOrdersSheet(true);
                return;
            }
            if (t.closest('[data-action="close-orders-filter"]')) {
                ev.preventDefault();
                toggleOrdersSheet(false);
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

    // ── Inline-addresses helpers ───────────────────────────────────
    // The whole flow lives on the page — no modal. Add toggles a blank
    // form, Edit prefills it, Save POSTs to /address/save, Delete posts
    // to /address/delete. Reloads on success so the server-rendered
    // card list and the header-chip stay in sync without DOM patching.

    function $$(sel, ctx) { return (ctx || document).querySelector(sel); }
    function getFormRoot() { return $$('[data-acct-addr-form]'); }
    function getForm()     { return $$('[data-acct-form]'); }

    function readAddressFromCard(card) {
        if (!card) { return null; }
        try {
            var raw = card.getAttribute('data-address') || '';
            if (!raw) { return null; }
            return JSON.parse(decodeURIComponent(raw));
        } catch (e) { return null; }
    }

    function setFieldValue(form, name, value) {
        var el = form.querySelector('[name="' + name + '"]');
        if (el) { el.value = value == null ? '' : String(value); }
    }

    // Split a stored "+44 1234567890" contact into { dial, number }.
    // Matches the popup's storage shape so existing rows render
    // back correctly on edit.
    function splitContact(raw) {
        var s = String(raw || '').trim();
        if (!s) { return { dial: '44', number: '' }; }
        var m = s.match(/^\+?(\d{1,4})[\s\-]+(.+)$/);
        if (m) { return { dial: m[1], number: m[2].replace(/\D/g, '') }; }
        return { dial: '44', number: s.replace(/\D/g, '') };
    }

    function openInlineAddressForm(addr) {
        var wrap = getFormRoot();
        var form = getForm();
        if (!wrap || !form) { return; }
        form.reset();
        setFormError('');

        var titleEl  = $$('[data-acct-form-title]');
        var deleteBtn = $$('[data-action="acct-delete-from-form"]');
        var defaultCheckbox = form.querySelector('[data-af-default]');
        var dialSel  = form.querySelector('[data-af-dial]');
        var contact  = form.querySelector('[data-af-contact]');

        if (addr && addr.id) {
            if (titleEl) { titleEl.textContent = 'Edit address'; }
            setFieldValue(form, 'id',                    addr.id);
            setFieldValue(form, 'latitude',              addr.latitude);
            setFieldValue(form, 'longitude',             addr.longitude);
            setFieldValue(form, 'address',               addr.address || '');
            setFieldValue(form, 'post_code',             addr.postCode || '');
            setFieldValue(form, 'address_type',          addr.addressType || '');
            setFieldValue(form, 'additional_details',    addr.additionalDetails || '');
            setFieldValue(form, 'delivery_instructions', addr.deliveryInstructions || '');
            setFieldValue(form, 'label',                 addr.label || '');
            var c = splitContact(addr.contactNo);
            if (dialSel) {
                // Default to +44 if the stored dial isn't in the list.
                var hasOpt = false;
                for (var i = 0; i < dialSel.options.length; i++) {
                    if (dialSel.options[i].value === c.dial) { hasOpt = true; break; }
                }
                dialSel.value = hasOpt ? c.dial : '44';
            }
            if (contact) { contact.value = c.number; }
            if (defaultCheckbox) { defaultCheckbox.checked = !!addr.isDefault; }
            if (deleteBtn) { deleteBtn.hidden = false; }
        } else {
            if (titleEl) { titleEl.textContent = 'Add new address'; }
            if (dialSel) { dialSel.value = '44'; }
            if (contact) { contact.value = ''; }
            if (deleteBtn) { deleteBtn.hidden = true; }
        }

        wrap.hidden = false;
        wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var firstField = form.querySelector('[name="address"]');
        if (firstField) { window.setTimeout(function () { firstField.focus(); }, 200); }
    }

    function closeInlineAddressForm() {
        var wrap = getFormRoot();
        if (!wrap) { return; }
        wrap.hidden = true;
        setFormError('');
    }

    function setFormError(msg) {
        var box = $$('[data-acct-form-error]');
        if (!box) { return; }
        if (msg) { box.textContent = msg; box.hidden = false; }
        else     { box.textContent = '';  box.hidden = true; }
    }

    // Google-backed autocomplete + "use my current location" on the address
    // field — picking a suggestion (or GPS) auto-fills address + postcode + coords.
    function bindAddressAutocomplete() {
        // Scope to the account form — #af-address also exists in the global
        // location modal, so a document-wide lookup would grab the wrong one.
        var form  = getForm();
        var input = form && form.querySelector('[name="address"]');
        if (!input || input.dataset.acBound === '1' || !window.AddressAutocomplete) { return; }
        input.dataset.acBound = '1';
        window.AddressAutocomplete.attach({
            input:  input,
            list:   form.querySelector('[data-addr-suggestions]'),
            locBtn: form.querySelector('[data-action="acct-use-location"]'),
            onPick: function (addr) {
                var form = getForm();
                if (!form) { return; }
                var a   = form.querySelector('[name="address"]');
                var pc  = form.querySelector('[name="post_code"]');
                var lat = form.querySelector('[data-af-lat]');
                var lng = form.querySelector('[data-af-lng]');
                if (a)   { a.value   = window.AddressAutocomplete.line(addr) || a.value; }
                if (pc)  { pc.value  = addr.postcode || ''; }
                if (lat) { lat.value = (addr.latitude  != null) ? addr.latitude  : ''; }
                if (lng) { lng.value = (addr.longitude != null) ? addr.longitude : ''; }
            }
        });
    }

    function bindAddressFormSubmit() {
        var form = getForm();
        if (!form || form.dataset.bound === '1') { return; }
        form.dataset.bound = '1';
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            saveInlineAddress();
        });
    }

    // Stash a toast in sessionStorage to be shown after the next page
    // reload — the address-form flow does soft reloads on success
    // because the card list is server-rendered, so toasts shown right
    // before reload get clobbered. This survives the round trip.
    function flashAfterReload(type, message) {
        try {
            sessionStorage.setItem('acct.flash', JSON.stringify({ type: type, msg: message, ts: Date.now() }));
        } catch (e) { /* sessionStorage disabled — fall through */ }
    }
    function consumePendingFlash() {
        var raw = null;
        try { raw = sessionStorage.getItem('acct.flash'); } catch (e) { return; }
        if (!raw) { return; }
        try { sessionStorage.removeItem('acct.flash'); } catch (e) { /* ignore */ }
        var pending;
        try { pending = JSON.parse(raw); } catch (e) { return; }
        if (!pending || !pending.msg) { return; }
        // Drop anything older than 10 s — guards against a stale entry
        // surviving a tab being parked.
        if (Date.now() - (Number(pending.ts) || 0) > 10000) { return; }
        if (window.EatNDealUi && window.EatNDealUi.showToast) {
            window.EatNDealUi.showToast(pending.type || 'success', pending.msg);
        }
    }

    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    function saveInlineAddress() {
        var form = getForm();
        if (!form) { return; }
        var saveBtn = form.querySelector('[data-acct-form-save]');
        var address = (form.querySelector('[name="address"]') || {}).value || '';
        if (!address.trim()) {
            setFormError('Please enter an address.');
            toast('error', 'Please enter an address.');
            var first = form.querySelector('[name="address"]');
            if (first) { first.focus(); }
            return;
        }
        // Contact number — optional, but if entered must be 11-15 digits.
        // Stored as "+<dial> <number>" so the country code travels with
        // the row (mirrors the popup's storage format).
        var contactEl = form.querySelector('[data-af-contact]');
        var dialEl    = form.querySelector('[data-af-dial]');
        var rawNum    = contactEl ? contactEl.value.replace(/\D/g, '') : '';
        // Legacy's rule, /^[0-9]{11,15}$/ (webordering custom.js:696) — the same
        // one the api enforces in Validators/common.mobileRule.
        if (rawNum && !/^[0-9]{11,15}$/.test(rawNum)) {
            setFormError('Please enter a valid phone number (11-15 digits).');
            toast('error', 'Please enter a valid phone number (11-15 digits).');
            if (contactEl) { contactEl.focus(); }
            return;
        }
        var dial = (dialEl && dialEl.value) ? dialEl.value : '44';
        var contactCombined = rawNum ? ('+' + dial + ' ' + rawNum) : '';

        setFormError('');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

        // Build the payload from the form. Empty optional fields are
        // dropped so the API's Joi schema doesn't reject `id=''` (it's
        // an upsert: no id → INSERT, id present → UPDATE).
        var body = {};
        var fd = new FormData(form);
        fd.forEach(function (value, key) {
            if (value === '' || value == null) { return; }
            body[key] = value;
        });
        // The contact input + dial select live OUTSIDE the named-field
        // pipeline (they don't carry a name=); attach the combined
        // value here so it goes over the wire as contact_no.
        if (contactCombined) { body.contact_no = contactCombined; }
        body.is_default = form.querySelector('[data-af-default]') && form.querySelector('[data-af-default]').checked ? 1 : 0;

        var isEdit = !!body.id;

        fetch('/address/save', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (!env) {
                  setFormError('Could not reach the server.');
                  toast('error', 'Could not reach the server.');
                  return;
              }
              if (env.status === 401) {
                  window.location.href = '/signin?next=' + encodeURIComponent('/account?tab=addresses');
                  return;
              }
              if (env.status !== 200) {
                  var msg = (env.data && env.data.errors && env.data.errors[0] && env.data.errors[0].msg) || env.msg || 'Could not save the address.';
                  setFormError(msg);
                  toast('error', msg);
                  return;
              }
              flashAfterReload('success', isEdit ? 'Address updated.' : 'Address added.');
              window.location.reload();
          })
          .catch(function () {
              setFormError('Could not reach the server.');
              toast('error', 'Could not reach the server.');
          })
          .then(function () {
              if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save address'; }
          });
    }

    function deleteAddress(id) {
        if (!id) { return; }
        var confirmer = (window.EatNDealUi && window.EatNDealUi.confirmDialog)
            ? window.EatNDealUi.confirmDialog
            : function (o) { return Promise.resolve(window.confirm(o && o.message || 'Delete this address?')); };
        confirmer({
            title:       'Delete this address?',
            message:     'You can always add it again later.',
            okLabel:     'Delete',
            cancelLabel: 'Keep it',
        }).then(function (ok) {
            if (!ok) { return; }
            var card = document.querySelector('[data-address-id="' + id + '"]');
            if (card) { card.classList.add('is-busy'); }
            fetch('/address/delete', {
                method:      'POST',
                credentials: 'same-origin',
                headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body:        JSON.stringify({ id: id }),
            }).then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (env) {
                  if (!env || env.status !== 200) {
                      if (card) { card.classList.remove('is-busy'); }
                      toast('error', (env && env.msg) || 'Could not delete the address.');
                      return;
                  }
                  flashAfterReload('success', 'Address deleted.');
                  window.location.reload();
              })
              .catch(function () {
                  if (card) { card.classList.remove('is-busy'); }
                  toast('error', 'Could not reach the server.');
              });
        });
    }

    // ── Change mobile (OTP-verified) ───────────────────────────────
    // The number can only change once the NEW number is OTP-verified, so a
    // customer's loyalty (which follows their mobile) can never be pointed at
    // someone else's number. Read the current picker + input each time.
    // A 401 here means the session no longer resolves to a customer, so there
    // is nothing to retry — send them to sign in rather than toast an error
    // they can do nothing about.
    function bounceToSignin() {
        window.location.href = '/signin?next=' + encodeURIComponent('/account');
    }
    function readNewPhone() {
        var dialEl = hiddenDial || document.getElementById('account-country-dial');
        var mobEl  = phoneInput || document.getElementById('pf-mobile');
        return {
            country_dial: (dialEl && dialEl.value) || '',
            mobile:       String((mobEl && mobEl.value) || '').trim(),
        };
    }
    // The Send-code button has an icon + a <span> label, so only touch the span.
    function setBtnLabel(btn, text) { if (!btn) { return; } var s = btn.querySelector('span'); if (s) { s.textContent = text; } else { btn.textContent = text; } }
    function changePhoneSendOtp(lock) {
        if (!lock) { return; }
        var f = readNewPhone();
        if (!f.mobile) { toast('error', 'Enter your new mobile number.'); return; }
        var btn = lock.querySelector('[data-action="phone-send-otp"]');
        if (btn) { btn.disabled = true; setBtnLabel(btn, 'Sending…'); }
        fetch('/account/phone/send-otp', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ country_dial: f.country_dial, mobile: f.mobile }),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (btn) { btn.disabled = false; setBtnLabel(btn, 'Resend code'); }
              if (env && env.status === 401) { bounceToSignin(); return; }
              if (!env || env.status !== 200) { toast('error', (env && env.msg) || 'Could not send the code.'); return; }
              var row = lock.querySelector('[data-phone-otp-row]');
              if (row) { row.hidden = false; var inp = row.querySelector('[data-phone-otp-input]'); if (inp) { inp.value = ''; inp.focus(); } }
              var dev = env.data && env.data.dev_otp;
              var hint = lock.querySelector('[data-phone-otp-hint]');
              if (hint) { hint.hidden = false; hint.textContent = dev ? ('Demo mode — your code is ' + dev) : 'We sent a 6-digit code to your new number.'; }
              toast('success', dev ? ('Demo code: ' + dev) : 'Code sent to your new number.');
          })
          .catch(function () { if (btn) { btn.disabled = false; setBtnLabel(btn, 'Send verification code'); } toast('error', 'Could not reach the server. Please refresh and try again.'); });
    }
    function changePhoneVerify(lock) {
        if (!lock) { return; }
        var f   = readNewPhone();
        var row = lock.querySelector('[data-phone-otp-row]');
        var inp = row && row.querySelector('[data-phone-otp-input]');
        var otp = inp ? String(inp.value || '').replace(/\D/g, '') : '';
        if (otp.length !== 6) { toast('error', 'Enter the 6-digit code.'); return; }
        var btn = lock.querySelector('[data-action="phone-verify-otp"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
        fetch('/account/phone/verify', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ country_dial: f.country_dial, mobile: f.mobile, otp: otp }),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (env && env.status === 401) { bounceToSignin(); return; }
              if (!env || env.status !== 200) {
                  if (btn) { btn.disabled = false; btn.textContent = 'Verify & save'; }
                  toast('error', (env && env.msg) || 'The code is incorrect or has expired.');
                  return;
              }
              // Reload so the new number shows + the loyalty wallet re-syncs.
              flashAfterReload('success', 'Mobile number updated.');
              window.location.reload();
          })
          .catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Verify & save'; } toast('error', 'Could not reach the server.'); });
    }

    // ── Delete account (flow wired; the button is hidden for now) ───
    function deleteAccountFlow() {
        var confirmer = (window.EatNDealUi && window.EatNDealUi.confirmDialog)
            ? window.EatNDealUi.confirmDialog
            : function (o) { return Promise.resolve(window.confirm((o && o.message) || 'Delete your account?')); };
        confirmer({
            title:       'Delete your account?',
            message:     'This permanently removes your access to your account. This cannot be undone.',
            okLabel:     'Delete account',
            cancelLabel: 'Keep my account',
        }).then(function (ok) {
            if (!ok) { return; }
            fetch('/account/delete', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: '{}',
            }).then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (env) {
                  if (!env || env.status !== 200) { toast('error', (env && env.msg) || 'Could not delete your account.'); return; }
                  window.location.href = (env.data && env.data.redirect) || '/';
              })
              .catch(function () { toast('error', 'Could not reach the server.'); });
        });
    }

    // ── Payment Methods tab ────────────────────────────────────────
    // Saved-card flow: click "Add new card" → fetch a SetupIntent →
    // mount Stripe Elements once → user enters PAN/exp/CVC → confirm →
    // reload so the server-rendered list shows the new row.
    // Stripe.js v3 is loaded once on demand (no preload on every page).

    var __stripe = null;
    var __elements = null;
    var __cardElement = null;
    var __stripeClientSecret = null;

    function getPmRoot()      { return document.querySelector('[data-acct-pm]'); }
    function getPmFormWrap()  { return document.querySelector('[data-acct-pm-form]'); }
    function setPmError(msg) {
        var box = document.querySelector('[data-acct-pm-error]');
        if (!box) { return; }
        if (msg) { box.textContent = msg; box.hidden = false; }
        else     { box.textContent = '';  box.hidden = true; }
    }

    // Load Stripe.js once and cache the handle. Pinned "dahlia" release to
    // match the cart + legacy eatndeal (one Stripe.js version across the app;
    // dahlia is backward-compatible with the classic card Element used here).
    // Resolves with the window.Stripe constructor; rejects if the script can't
    // be loaded (offline, CSP blocked, etc.).
    function loadStripeJs() {
        if (window.Stripe) { return Promise.resolve(window.Stripe); }
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://js.stripe.com/dahlia/stripe.js';
            s.async = true;
            s.onload  = function () { resolve(window.Stripe); };
            s.onerror = function () { reject(new Error('Could not load Stripe.js')); };
            document.head.appendChild(s);
        });
    }

    function ensureStripe(publishableKey) {
        if (__stripe) { return Promise.resolve(__stripe); }
        var key = publishableKey
            || (getPmRoot() && getPmRoot().getAttribute('data-stripe-key'))
            || '';
        if (!key) { return Promise.reject(new Error('Stripe is not configured.')); }
        return loadStripeJs().then(function (Stripe) {
            __stripe = Stripe(key);
            return __stripe;
        });
    }

    function ensureCardElement() {
        if (__cardElement) { return __cardElement; }
        if (!__stripe) { return null; }
        var mount = document.querySelector('[data-pm-mount]');
        if (!mount) { return null; }
        __elements = __stripe.elements();
        __cardElement = __elements.create('card', {
            hidePostalCode: true,
            style: {
                base:    { fontSize: '15px', color: '#0f172a', '::placeholder': { color: '#94a3b8' } },
                invalid: { color: '#e5252a' },
            },
        });
        __cardElement.mount(mount);
        __cardElement.on('change', function (event) {
            setPmError(event.error ? event.error.message : '');
        });
        return __cardElement;
    }

    function openPaymentForm() {
        var wrap = getPmFormWrap();
        if (!wrap) { return; }
        setPmError('');
        wrap.hidden = false;
        wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Start Stripe + a fresh SetupIntent in parallel so the user can
        // start typing as soon as Elements paints.
        Promise.all([
            ensureStripe().then(function () { ensureCardElement(); }),
            fetch('/payment-method/setup', {
                method:      'POST',
                credentials: 'same-origin',
                headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body:        JSON.stringify({}),
            }).then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (env) {
                  if (!env || env.status !== 200 || !env.data) {
                      throw new Error((env && env.msg) || 'Could not start the card setup.');
                  }
                  __stripeClientSecret = env.data.clientSecret;
              }),
        ]).catch(function (err) {
            setPmError((err && err.message) || 'Could not open the card form.');
        });
    }

    function closePaymentForm() {
        var wrap = getPmFormWrap();
        if (!wrap) { return; }
        wrap.hidden = true;
        setPmError('');
        // Stripe.js doesn't expose a clean teardown for a single Element;
        // we keep it mounted so reopening is instant. Card field stays
        // pristine because Stripe's iframe clears on its own when hidden.
    }

    function savePaymentMethod() {
        if (!__stripe || !__cardElement) {
            setPmError('Card form is not ready yet — please try again.');
            return;
        }
        if (!__stripeClientSecret) {
            setPmError('Card setup expired — close and try again.');
            return;
        }
        var saveBtn = document.querySelector('[data-action="acct-save-pm"]');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        setPmError('');

        __stripe.confirmCardSetup(__stripeClientSecret, {
            payment_method: { card: __cardElement },
        }).then(function (result) {
            if (result.error) {
                setPmError(result.error.message || 'Card declined.');
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save card'; }
                return;
            }
            // Success — Stripe has attached the new payment_method to the
            // customer. Reload so the server-rendered list refreshes.
            flashAfterReload('success', 'Card saved.');
            window.location.reload();
        }).catch(function () {
            setPmError('Could not save the card. Please try again.');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save card'; }
        });
    }

    function deletePaymentMethod(pmId) {
        if (!pmId) { return; }
        var confirmer = (window.EatNDealUi && window.EatNDealUi.confirmDialog)
            ? window.EatNDealUi.confirmDialog
            : function (o) { return Promise.resolve(window.confirm(o && o.message || 'Remove this card?')); };
        confirmer({
            title:       'Remove this card?',
            message:     'You can always add it again later.',
            okLabel:     'Remove',
            cancelLabel: 'Keep it',
        }).then(function (ok) {
            if (!ok) { return; }
            var card = document.querySelector('[data-pm-id="' + pmId + '"]');
            if (card) { card.classList.add('is-busy'); }
            fetch('/payment-method/delete', {
                method:      'POST',
                credentials: 'same-origin',
                headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body:        JSON.stringify({ payment_method_id: pmId }),
            }).then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (env) {
                  if (!env || env.status !== 200) {
                      if (card) { card.classList.remove('is-busy'); }
                      toast('error', (env && env.msg) || 'Could not remove the card.');
                      return;
                  }
                  flashAfterReload('success', 'Card removed.');
                  window.location.reload();
              })
              .catch(function () {
                  if (card) { card.classList.remove('is-busy'); }
                  toast('error', 'Could not reach the server.');
              });
        });
    }

    // Contact input — digits only as the user types (popup-parity).
    function bindContactDigitsOnly() {
        var el = document.querySelector('[data-af-contact]');
        if (!el || el.dataset.bound === '1') { return; }
        el.dataset.bound = '1';
        var strip = function () {
            var raw = el.value || '';
            var clean = raw.replace(/\D/g, '');
            if (clean !== raw) {
                var caret = el.selectionStart || clean.length;
                var before = raw.slice(0, caret).replace(/\D/g, '').length;
                el.value = clean;
                try { el.setSelectionRange(before, before); } catch (e) { /* ignore */ }
            }
        };
        el.addEventListener('input', strip);
        el.addEventListener('paste', function () { window.setTimeout(strip, 0); });
        el.addEventListener('keydown', function (ev) {
            if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length > 1) { return; }
            if (!/^[0-9]$/.test(ev.key)) { ev.preventDefault(); }
        });
    }

    // Late-bound: the form mounts only on the addresses tab, but the
    // page JS runs on every account tab — guard the lookup.
    function bootAddressesTab() {
        bindAddressFormSubmit();
        bindAddressAutocomplete();
        bindContactDigitsOnly();
        consumePendingFlash();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootAddressesTab);
    } else {
        bootAddressesTab();
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
        var ui = window.EatNDealUi;
        if (ui && ui.showLoader) { ui.showLoader({ label: 'Uploading photo…' }); }
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
        } finally {
            if (ui && ui.hideLoader) { ui.hideLoader(); }
        }
    }
    var toastA = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };
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
                if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast('error', 'Please enter a valid mobile number (11–15 digits).'); }
                phoneInput.focus();
                return;
            }
        }
    }

    function onReady() {
        cacheRefs();

        // Delegated click handlers — must run on EVERY account tab so
        // the Addresses tab's Add / Edit / Delete buttons work even
        // when the profile form isn't present. The handler internally
        // narrows by [data-action] so it's harmless on other tabs.
        bindFieldActions();

        // Everything below is profile-tab-only; bail when the form
        // isn't on the page.
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

        bindCustomSelects();

        // ── "Complete your profile" (About You) ────────────────────────
        // The section sits OUTSIDE #account-form (its controls use
        // form="account-form"), so their change events don't bubble to the
        // form — bind them here to keep the Update button + pill look in
        // sync: fill the chosen pills, clear radio siblings, and reveal the
        // "Other food" text box only when "Other" is ticked.
        var aboutCard = document.querySelector('[data-about]');
        if (aboutCard) {
            aboutCard.addEventListener('change', function (ev) {
                var input = ev.target;
                if (input && (input.type === 'checkbox' || input.type === 'radio')) {
                    if (input.type === 'radio') {
                        var group = input.closest('.pf-pills');
                        if (group) {
                            var labels = group.querySelectorAll('.pf-pill');
                            for (var i = 0; i < labels.length; i++) { labels[i].classList.remove('is-on'); }
                        }
                    }
                    var label = input.closest('.pf-pill');
                    if (label) { label.classList.toggle('is-on', input.checked); }

                    if (input.name === 'favorite_food_category' && input.value === 'other') {
                        var other = document.querySelector('[data-other-food]');
                        if (other) { other.hidden = !input.checked; }
                    }
                }
                markDirty();
            });
            aboutCard.addEventListener('input', markDirty);
        }

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
