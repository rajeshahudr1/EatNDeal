/*
 * ui/location-modal.js
 *
 * What:  Drives the Zomato-style "Select a location" sheet + the
 *        "Address info" add/edit form (views/partials/location-modal.ejs).
 *          • Picker view:
 *              - debounced search → /api/v1/delivery/search-address,
 *                pick → /retrieve-address → save (active location).
 *              - "Use current location" → navigator.geolocation → save.
 *              - "Add Address" → opens the form view (signed-in only).
 *              - Saved addresses (GET /addresses), tap to select, edit, delete.
 *              - Searched address (current active pick).
 *              - Recently used (cookie-backed "nearby").
 *          • Form view: local stylized map (drag to pan — CSP-safe, no
 *            external tiles), building-type custom dropdown, details /
 *            instructions / contact / label, Save (POST /address/save) +
 *            Delete (POST /address/delete).
 * Why:   The user supplied both mockups + the section order
 *          current-location → saved → searched → recent.
 * Used:  Loaded from views/_layout.ejs. Exposes
 *        window.EatNDealUi.locationModal.{open, close, save}.
 */

(function () {
    'use strict';

    var SEARCH_DEBOUNCE_MS = 300;
    var MIN_QUERY = 3;
    var MAX_LABEL_LEN = 48;
    var RECENTS_KEY = 'eatndeal_recents';
    var RECENTS_MAX = 6;

    // ── Static icon markup (no user data → safe to set as innerHTML) ──
    var ICON = {
        home:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>',
        briefcase: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
        pin:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>',
        clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
        edit:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
        trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    };
    function iconForLabel(label) {
        var l = String(label || '').toLowerCase();
        if (/home|house|flat|apartment/.test(l)) { return ICON.home; }
        if (/work|office|shop|business/.test(l)) { return ICON.briefcase; }
        return ICON.heart;
    }
    // Building type → display tag (house → "House"). Used when no custom label.
    function titleCaseType(t) {
        var s = String(t || '').trim();
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }

    var modal, panel, pickerView, formView;
    var input, list, status, clearBtn, currentAddrEl;
    var savedSection, savedList, nearbySection, nearbyList, guestHint;
    var form, afId, afLat, afLng, afAddress, afPostcode, afType, afDial, afContact;
    var deleteBtn, saveBtn, mapEl, mapGrid;

    var loggedIn = false;
    var activeLoc = null;
    var searchTimer = null;
    var openCount = 0;
    var bound = false;

    // ───────────────────────── helpers ─────────────────────────────

    function buildShortLabel(address, fallback) {
        address = address || {};
        var line1    = (address.line_1   || '').trim();
        var postTown = (address.post_town || '').trim();
        var postcode = (address.postcode  || '').trim();
        var label = '';
        if (line1 && postTown && line1.toLowerCase() !== postTown.toLowerCase()) { label = line1 + ', ' + postTown; }
        else if (postTown && postcode) { label = postTown + ', ' + postcode; }
        else if (postTown) { label = postTown; }
        else if (line1 && postcode) { label = line1 + ', ' + postcode; }
        else if (postcode) { label = postcode; }
        else if (line1) { label = line1; }
        else if (typeof fallback === 'string' && fallback.trim()) {
            label = fallback.split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 2).join(', ');
        } else { label = 'Selected location'; }
        if (label.length > MAX_LABEL_LEN) { label = label.slice(0, MAX_LABEL_LEN - 1).trimEnd() + '…'; }
        return label;
    }

    function readCookie(name) {
        var pairs = document.cookie.split(';');
        for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i].trim();
            if (pair.indexOf(name + '=') === 0) { return decodeURIComponent(pair.substring(name.length + 1)); }
        }
        return '';
    }
    function readConsent() { return readCookie('eatndeal_consent'); }

    function writeLocationCookie(loc) {
        var slim = {
            label: loc.label || '', postcode: loc.postcode || null,
            lat: loc.lat || null, lng: loc.lng || null,
            source: loc.source || 'manual', savedAt: new Date().toISOString(),
        };
        var parts = ['eatndeal_location=' + encodeURIComponent(JSON.stringify(slim)), 'Max-Age=' + (60 * 60 * 24 * 30), 'Path=/', 'SameSite=Lax'];
        if (window.location.protocol === 'https:') { parts.push('Secure'); }
        document.cookie = parts.join('; ');
    }
    function clearLocationCookie() { document.cookie = 'eatndeal_location=; Max-Age=0; Path=/; SameSite=Lax'; }

    function readRecents() {
        try {
            var raw = readCookie(RECENTS_KEY);
            if (!raw) { return []; }
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function writeRecents(arr) {
        if (readConsent() !== 'accepted') { return; }   // functional cookie — consent-gated
        var parts = [RECENTS_KEY + '=' + encodeURIComponent(JSON.stringify(arr.slice(0, RECENTS_MAX))), 'Max-Age=' + (60 * 60 * 24 * 30), 'Path=/', 'SameSite=Lax'];
        if (window.location.protocol === 'https:') { parts.push('Secure'); }
        document.cookie = parts.join('; ');
    }
    function pushRecent(loc) {
        if (!loc || !loc.label) { return; }
        var key = (loc.label + '|' + (loc.postcode || '')).toLowerCase();
        var arr = readRecents().filter(function (r) {
            return ((r.label + '|' + (r.postcode || '')).toLowerCase()) !== key;
        });
        arr.unshift({ label: loc.label, postcode: loc.postcode || null, lat: loc.lat || null, lng: loc.lng || null, source: loc.source || 'manual' });
        writeRecents(arr);
    }

    // ───────────────────────── DOM wiring ──────────────────────────

    function cacheNodes() {
        if (modal) { return; }
        modal = document.getElementById('location-modal');
        if (!modal) { return; }
        panel        = modal.querySelector('.location-modal__panel');
        pickerView   = modal.querySelector('[data-loc-view="picker"]');
        formView     = modal.querySelector('[data-loc-view="form"]');
        input        = modal.querySelector('#location-search-input');
        list         = modal.querySelector('#location-search-suggestions');
        status       = modal.querySelector('#location-search-status');
        clearBtn     = modal.querySelector('[data-action="clear-loc-search"]');
        currentAddrEl = modal.querySelector('[data-current-address]');
        savedSection  = modal.querySelector('[data-saved-section]');
        savedList     = modal.querySelector('[data-saved-list]');
        nearbySection = modal.querySelector('[data-nearby-section]');
        nearbyList    = modal.querySelector('[data-nearby-list]');
        guestHint     = modal.querySelector('[data-guest-hint]');
        form          = modal.querySelector('[data-address-form]');
        afId          = modal.querySelector('[data-af-id]');
        afLat         = modal.querySelector('[data-af-lat]');
        afLng         = modal.querySelector('[data-af-lng]');
        afAddress     = modal.querySelector('[data-af-address]');
        afPostcode    = modal.querySelector('[data-af-postcode]');
        afType        = modal.querySelector('[data-af-type]');
        afDial        = modal.querySelector('[data-af-dial]');
        afContact     = modal.querySelector('[data-af-contact]');
        deleteBtn     = modal.querySelector('[data-action="loc-form-delete"]');
        saveBtn       = modal.querySelector('[data-action="loc-form-save"]');
        mapEl         = modal.querySelector('[data-loc-map]');
        mapGrid       = modal.querySelector('[data-loc-map-grid]');

        loggedIn = modal.getAttribute('data-logged-in') === '1';
        var rawActive = modal.getAttribute('data-active-location');
        if (rawActive) { try { activeLoc = JSON.parse(decodeURIComponent(rawActive)); } catch (e) { activeLoc = null; } }

        if (input)    { input.addEventListener('input', onInput); }
        if (clearBtn) { clearBtn.addEventListener('click', function () { input.value = ''; clearBtn.hidden = true; clearSuggestions(); input.focus(); }); }
        // Contact number — digits only.
        if (afContact) {
            afContact.addEventListener('input', function () { afContact.value = afContact.value.replace(/\D/g, ''); });
        }
        // Address autocomplete on the form's Address field: type → pick → fills
        // the address + coords, then refreshes the map.
        if (afAddress && window.AddressAutocomplete) {
            window.AddressAutocomplete.attach({
                input:  afAddress,
                list:   modal.querySelector('[data-af-suggestions]'),
                locBtn: modal.querySelector('[data-af-useloc]'),
                onPick: function (addr) {
                    afAddress.value = window.AddressAutocomplete.line(addr) || afAddress.value;
                    if (afPostcode) { afPostcode.value = addr.postcode || ''; }
                    if (afLat) { afLat.value = (addr.latitude  != null) ? addr.latitude  : ''; }
                    if (afLng) { afLng.value = (addr.longitude != null) ? addr.longitude : ''; }
                    renderLocationMap(afLat && afLat.value, afLng && afLng.value);
                }
            });
        }
        bindMapDrag();
        bindDelegatedClicks();

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && openCount > 0) {
                if (formView && !formView.hidden) { showView('picker'); }
                else { close(); }
            }
        });
    }

    // One delegated click handler for every data-action inside the modal.
    function bindDelegatedClicks() {
        if (bound) { return; }
        bound = true;
        modal.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            if (t.closest('[data-action="close-location-modal"]')) { ev.preventDefault(); close(); return; }
            if (t.closest('[data-action="use-current-location"]'))  { ev.preventDefault(); useCurrentLocation(); return; }
            if (t.closest('[data-action="add-address"]'))           { ev.preventDefault(); onAddAddress(); return; }
            if (t.closest('[data-action="loc-form-back"]'))         { ev.preventDefault(); showView('picker'); return; }
            if (t.closest('[data-action="loc-form-save"]'))         { ev.preventDefault(); saveAddressForm(); return; }
            if (t.closest('[data-action="loc-form-delete"]'))       { ev.preventDefault(); deleteAddress(); return; }
            if (t.closest('[data-action="search-by-landmark"]'))    { ev.preventDefault(); if (input) { input.focus(); input.placeholder = 'e.g. Near Buckland School'; } return; }
            if (t.closest('[data-action="goto-signin"]'))           { /* native link */ return; }

            // Custom dropdowns (building type + dial code) — generic.
            var selBtn = t.closest('[data-loc-select-btn]');
            if (selBtn) { ev.preventDefault(); toggleSelect(selBtn.closest('[data-loc-select]')); return; }
            var opt = t.closest('.loc-select__opt');
            if (opt) { ev.preventDefault(); pickSelect(opt); return; }
            if (!t.closest('[data-loc-select]')) { closeAllSelects(); }
        });
    }

    // ───────────────────────── views ───────────────────────────────

    function showView(name) {
        if (!pickerView || !formView) { return; }
        var picker = name !== 'form';
        pickerView.hidden = !picker;
        formView.hidden = picker;
        if (panel) { panel.scrollTop = 0; }
        pickerView.scrollTop = 0;
        formView.scrollTop = 0;
    }

    function open() {
        cacheNodes();
        if (!modal) { return; }
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        openCount += 1;
        showView('picker');
        renderCurrentSub();
        renderRecent();
        loadSaved();
        window.setTimeout(function () { if (input) { input.focus(); } }, 280);
    }

    function close() {
        if (!modal) { return; }
        if (document.body.getAttribute('data-has-location') === 'false' && (!formView || formView.hidden)) { return; }
        var active = document.activeElement;
        if (active && modal.contains(active) && active.blur) { active.blur(); }
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        openCount = 0;
        clearSuggestions();
    }

    // ───────────────────────── search ──────────────────────────────

    function onInput() {
        if (searchTimer) { window.clearTimeout(searchTimer); }
        var q = (input.value || '').trim();
        if (clearBtn) { clearBtn.hidden = q.length === 0; }
        if (q.length < MIN_QUERY) { clearSuggestions(); return; }
        searchTimer = window.setTimeout(function () { runSearch(q); }, SEARCH_DEBOUNCE_MS);
    }

    function clearSuggestions() {
        if (list) { while (list.firstChild) { list.removeChild(list.firstChild); } list.hidden = true; }
        if (status) { status.textContent = ''; status.hidden = true; }
        if (input) { input.setAttribute('aria-expanded', 'false'); }
    }
    function setStatus(text) { if (status) { status.textContent = text || ''; status.hidden = !text; } }

    async function runSearch(q) {
        setStatus('Searching…');
        try {
            var data = await window.EatNDealApi.post('/api/v1/delivery/search-address', { query: q });
            var suggestions = (data && data.suggestions) || [];
            renderSuggestions(suggestions);
            setStatus(suggestions.length ? '' : 'We couldn’t find that. Try a city, area, street, or postcode.');
        } catch (err) {
            setStatus(err.message || 'Could not search right now. Please try again.');
            if (list) { while (list.firstChild) { list.removeChild(list.firstChild); } list.hidden = true; }
        }
    }

    function renderSuggestions(suggestions) {
        if (!list) { return; }
        while (list.firstChild) { list.removeChild(list.firstChild); }
        suggestions.forEach(function (s) {
            var li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('tabindex', '0');
            li.textContent = s.address || '';
            li.addEventListener('click', function () { retrieveAndSave(s.id, s.address); });
            li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); retrieveAndSave(s.id, s.address); } });
            list.appendChild(li);
        });
        list.hidden = suggestions.length === 0;
        if (input) { input.setAttribute('aria-expanded', suggestions.length ? 'true' : 'false'); }
    }

    async function retrieveAndSave(id, fallbackLabel) {
        setStatus('Loading address…');
        try {
            var data = await window.EatNDealApi.post('/api/v1/delivery/retrieve-address', { id: id });
            var address = data && data.address;
            if (!address) { throw new Error('Address details were not returned.'); }
            save({
                label: buildShortLabel(address, fallbackLabel),
                postcode: address.postcode || null,
                lat: address.latitude || null,
                lng: address.longitude || null,
                raw: address,
                source: 'postcode',
            });
        } catch (err) {
            setStatus(err.message || 'Could not load that address. Please try another.');
        }
    }

    // Full-screen spinner helpers (defensive — no-op if the loader UI is absent).
    function loaderOn(label) { if (window.EatNDealUi && window.EatNDealUi.showLoader) { window.EatNDealUi.showLoader({ label: label || 'Loading…' }); } }
    function loaderOff()     { if (window.EatNDealUi && window.EatNDealUi.hideLoader) { window.EatNDealUi.hideLoader(); } }

    function useCurrentLocation() {
        if (!navigator.geolocation) {
            if (window.EatNDealUi) { window.EatNDealUi.showToast('error', 'Your browser does not support location sharing. Please enter a postcode.'); }
            return;
        }
        if (currentAddrEl) { currentAddrEl.textContent = 'Getting your location…'; }
        loaderOn('Getting your location…');   // visible feedback while GPS + lookup run
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                var lat = pos.coords.latitude, lng = pos.coords.longitude;
                // Reverse-geocode the coords so the chip shows the REAL area name.
                window.EatNDealApi.post('/api/v1/delivery/reverse-geocode', { lat: lat, lng: lng })
                    .then(function (data) {
                        // Served-country gate — block locations outside our delivery area.
                        if (data && data.allowed === false) {
                            loaderOff();
                            if (currentAddrEl) { currentAddrEl.textContent = 'Detect my location'; }
                            var cn = (data.address && data.address.country) || 'your country';
                            if (window.EatNDealUi) { window.EatNDealUi.showToast('error', 'Sorry, we don’t deliver in ' + cn + ' yet.'); }
                            return;   // stop — do NOT save or continue
                        }
                        var label    = (data && data.label)
                            || (data && data.address && (data.address.line_1 || data.address.post_town))
                            || 'My current location';
                        var postcode = (data && data.address && data.address.postcode) || null;
                        save({ label: label, postcode: postcode, lat: lat, lng: lng, source: 'geolocation' });  // reloads (loader stays until then)
                    })
                    .catch(function () {
                        // Lookup failed (network) → still usable: coords + generic label.
                        save({ label: 'My current location', postcode: null, lat: lat, lng: lng, source: 'geolocation' });
                    });
            },
            function (err) {
                loaderOff();
                if (currentAddrEl) { currentAddrEl.textContent = 'Detect my location'; }
                if (window.EatNDealUi) { window.EatNDealUi.showToast('warn', 'Please allow location access or enter a postcode. ' + (err.message || '')); }
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    }

    // ── Persist + select an active delivery location (reloads page) ──
    async function save(location) {
        try {
            var resp = await fetch('/location/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(location),
            });
            var body = await resp.json();
            if (!(body && body.status === 200)) {
                loaderOff();
                if (body && body.msg && window.EatNDealUi) { window.EatNDealUi.showToast('error', body.msg); }
                return;
            }
        } catch (e) {
            loaderOff();
            if (window.EatNDealUi) { window.EatNDealUi.showToast('warn', 'Could not save right now — please check your connection.'); }
            return;
        }
        if (readConsent() === 'accepted') { writeLocationCookie(location); }
        pushRecent(location);
        close();
        // Tell any OTHER open tab (e.g. a cart tab) to pick up the new location
        // before we reload THIS tab. The reload refreshes the current page.
        if (window.CartSync) { window.CartSync.broadcast(); }
        window.location.reload();
    }

    // ───────────────── saved / recent lists ────────────────────────

    function renderCurrentSub() {
        if (!currentAddrEl) { return; }
        currentAddrEl.textContent = (activeLoc && activeLoc.label) ? activeLoc.label : 'Detect my location';
    }

    // Recent searches → tappable chips (cookie-backed).
    function renderRecent() {
        if (!nearbySection || !nearbyList) { return; }
        while (nearbyList.firstChild) { nearbyList.removeChild(nearbyList.firstChild); }
        var recents = readRecents();
        if (!recents.length) { nearbySection.hidden = true; return; }
        recents.forEach(function (r) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'loc-chip';
            var ic = document.createElement('span');
            ic.className = 'loc-chip__ico';
            ic.innerHTML = ICON.clock;
            var txt = document.createElement('span');
            txt.className = 'loc-chip__text';
            txt.textContent = r.label;
            chip.appendChild(ic);
            chip.appendChild(txt);
            chip.addEventListener('click', function () { save({ label: r.label, postcode: r.postcode, lat: r.lat, lng: r.lng, source: 'recent' }); });
            nearbyList.appendChild(chip);
        });
        nearbySection.hidden = false;
    }

    async function loadSaved() {
        if (!savedSection || !savedList) { return; }
        if (!loggedIn) { savedSection.hidden = true; if (guestHint) { guestHint.hidden = false; } return; }
        if (guestHint) { guestHint.hidden = true; }
        try {
            var resp = await fetch('/addresses', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            var body = await resp.json();
            var addresses = (body && body.status === 200 && body.data && body.data.addresses) || [];
            renderSaved(addresses);
        } catch (e) {
            savedSection.hidden = true;
        }
    }

    // Saved-address cards: icon-by-label + Default badge + edit/delete.
    function renderSaved(addresses) {
        while (savedList.firstChild) { savedList.removeChild(savedList.firstChild); }
        if (!addresses.length) { savedSection.hidden = true; return; }
        addresses.forEach(function (a) {
            var card = document.createElement('div');
            card.className = 'loc-saved__card';

            var icon = document.createElement('span');
            icon.className = 'loc-saved__icon';
            icon.innerHTML = iconForLabel(a.label || a.addressType);
            card.appendChild(icon);

            var main = document.createElement('button');
            main.type = 'button';
            main.className = 'loc-saved__main';
            var top = document.createElement('span');
            top.className = 'loc-saved__top';
            var name = document.createElement('span');
            name.className = 'loc-saved__name';
            // Type tag: the Home/Work label, else the building type (House…).
            name.textContent = a.label || titleCaseType(a.addressType) || 'Saved address';
            top.appendChild(name);
            if (a.isDefault) {
                var badge = document.createElement('span');
                badge.className = 'loc-saved__badge';
                badge.textContent = 'Default';
                top.appendChild(badge);
            }
            main.appendChild(top);
            var addr = document.createElement('span');
            addr.className = 'loc-saved__addr';
            addr.textContent = a.address || '';
            main.appendChild(addr);
            main.addEventListener('click', function () { save({ label: a.address || a.label, postcode: a.postCode, lat: a.latitude, lng: a.longitude, source: 'saved' }); });
            card.appendChild(main);

            var actions = document.createElement('span');
            actions.className = 'loc-saved__actions';
            var eb = document.createElement('button');
            eb.type = 'button';
            eb.className = 'loc-saved__act';
            eb.setAttribute('aria-label', 'Edit address');
            eb.innerHTML = ICON.edit;
            eb.addEventListener('click', function (ev) { ev.stopPropagation(); openForm(a); });
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'loc-saved__act';
            del.setAttribute('aria-label', 'Delete address');
            del.innerHTML = ICON.trash;
            del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteAddress(a.id); });
            actions.appendChild(eb);
            actions.appendChild(del);
            card.appendChild(actions);

            savedList.appendChild(card);
        });
        savedSection.hidden = false;
    }

    // ───────────────────────── address form ────────────────────────

    function onAddAddress() {
        if (!loggedIn) {
            if (window.EatNDealUi) { window.EatNDealUi.showToast('info', 'Please sign in to save addresses.'); }
            return;
        }
        openForm(null);
    }

    function openForm(a) {
        cacheNodes();
        if (!form) { return; }
        form.reset();
        closeAllSelects();
        a = a || {};
        afId.value      = a.id || '';
        afLat.value     = (a.latitude != null) ? a.latitude : ((activeLoc && activeLoc.lat != null) ? activeLoc.lat : '');
        afLng.value     = (a.longitude != null) ? a.longitude : ((activeLoc && activeLoc.lng != null) ? activeLoc.lng : '');
        renderLocationMap(afLat.value, afLng.value);   // real Google Map for the chosen point
        afAddress.value = a.address || (a.id ? '' : (input && input.value ? '' : (activeLoc ? activeLoc.label : '')));
        if (afPostcode) { afPostcode.value = a.postCode || a.post_code || a.postcode || ''; }
        setSelectValue(modal.querySelector('[data-loc-select="type"]'), a.addressType || '');
        setField('additional_details', a.additionalDetails || '');
        setField('delivery_instructions', a.deliveryInstructions || '');
        setField('label', a.label || '');

        // Split a stored "+44 9632..." contact back into dial + number.
        var dial = '44', num = '';
        var rawC = String(a.contactNo || '').trim();
        if (rawC) {
            var mm = rawC.match(/^\+?(\d{1,4})[\s\-]+(.+)$/);
            if (mm) { dial = mm[1]; num = mm[2].replace(/\D/g, ''); }
            else { num = rawC.replace(/\D/g, ''); }
        }
        setSelectValue(modal.querySelector('[data-loc-select="dial"]'), dial);
        if (afContact) { afContact.value = num; }

        if (deleteBtn) { deleteBtn.hidden = !a.id; }
        showView('form');
        window.setTimeout(function () { if (afAddress) { afAddress.focus(); } }, 120);
    }

    function setField(name, value) {
        var el = form.querySelector('[name="' + name + '"]');
        if (el) { el.value = value || ''; }
    }

    async function saveAddressForm() {
        if (!afAddress.value.trim()) { afAddress.focus(); if (window.EatNDealUi) { window.EatNDealUi.showToast('error', 'Please enter an address.'); } return; }

        // Contact number — optional, but if entered it must be 6–15 digits.
        // Stored as "+<dial> <number>" so the country code travels with it.
        var num = (afContact ? afContact.value : '').replace(/\D/g, '');
        if (num && (num.length < 6 || num.length > 15)) {
            if (afContact) { afContact.focus(); }
            if (window.EatNDealUi) { window.EatNDealUi.showToast('error', 'Please enter a valid contact number (6–15 digits).'); }
            return;
        }
        var dial = (afDial && afDial.value) ? afDial.value : '44';
        var contact = num ? ('+' + dial + ' ' + num) : '';

        var payload = {
            id:                    afId.value || undefined,
            address:               afAddress.value.trim(),
            post_code:             afPostcode ? afPostcode.value.trim() : '',
            label:                 valOf('label'),
            address_type:          afType.value || '',
            additional_details:    valOf('additional_details'),
            delivery_instructions: valOf('delivery_instructions'),
            contact_no:            contact,
            latitude:              afLat.value || '',
            longitude:             afLng.value || '',
        };
        if (saveBtn) { saveBtn.disabled = true; }
        try {
            var resp = await fetch('/address/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
            });
            var body = await resp.json();
            if (body && body.status === 200) {
                if (window.EatNDealUi) { window.EatNDealUi.showToast('success', body.msg || 'Address saved.'); }
                showView('picker');
                loadSaved();
                // A saved address may be the cart's delivery address (or the
                // default that feeds it), so keep an open cart in step — this
                // tab directly, other tabs via the broadcast.
                if (window.CartSync) { window.CartSync.broadcast(); window.CartSync.refresh(); }
            } else if (body && body.status === 401) {
                if (window.EatNDealUi) { window.EatNDealUi.showToast('info', body.msg || 'Please sign in.'); }
            } else {
                if (window.EatNDealUi) { window.EatNDealUi.showToast('error', (body && body.msg) || 'Could not save the address.'); }
            }
        } catch (e) {
            if (window.EatNDealUi) { window.EatNDealUi.showToast('warn', 'Could not save right now — please check your connection.'); }
        } finally {
            if (saveBtn) { saveBtn.disabled = false; }
        }
    }

    function valOf(name) {
        var el = form.querySelector('[name="' + name + '"]');
        return el ? el.value.trim() : '';
    }

    async function deleteAddress(id) {
        var addressId = id || (afId && afId.value);
        if (!addressId) { return; }
        var go = function () { return performDelete(addressId); };
        if (window.EatNDealUi && window.EatNDealUi.confirmDialog) {
            window.EatNDealUi.confirmDialog({ title: 'Delete address?', message: 'This saved address will be removed.', okLabel: 'Delete', cancelLabel: 'Keep' })
                .then(function (ok) { if (ok) { go(); } });
        } else {
            go();
        }
    }

    async function performDelete(addressId) {
        try {
            var resp = await fetch('/address/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ id: addressId }),
            });
            var body = await resp.json();
            if (body && body.status === 200) {
                if (window.EatNDealUi) { window.EatNDealUi.showToast('success', body.msg || 'Address removed.'); }
                showView('picker');
                loadSaved();
                // Deleting an address can change what the cart falls back to,
                // so refresh an open cart here and in any other tab.
                if (window.CartSync) { window.CartSync.broadcast(); window.CartSync.refresh(); }
            } else {
                if (window.EatNDealUi) { window.EatNDealUi.showToast('error', (body && body.msg) || 'Could not delete the address.'); }
            }
        } catch (e) {
            if (window.EatNDealUi) { window.EatNDealUi.showToast('warn', 'Could not delete right now — please check your connection.'); }
        }
    }

    // ── Custom dropdowns (building type + dial code) — generic, one set
    //    of handlers drives every [data-loc-select] wrapper on the form. ─
    function openSelect(wrap) {
        if (!wrap) { return; }
        closeAllSelects();
        wrap.classList.add('is-open');
        var btn = wrap.querySelector('[data-loc-select-btn]');
        var menu = wrap.querySelector('[data-loc-select-menu]');
        if (btn) { btn.setAttribute('aria-expanded', 'true'); }
        if (menu) { menu.hidden = false; }
    }
    function closeSelect(wrap) {
        if (!wrap) { return; }
        wrap.classList.remove('is-open');
        var btn = wrap.querySelector('[data-loc-select-btn]');
        var menu = wrap.querySelector('[data-loc-select-menu]');
        if (btn) { btn.setAttribute('aria-expanded', 'false'); }
        if (menu) { menu.hidden = true; }
    }
    function closeAllSelects() {
        if (!modal) { return; }
        var open = modal.querySelectorAll('[data-loc-select].is-open');
        for (var i = 0; i < open.length; i++) { closeSelect(open[i]); }
    }
    function toggleSelect(wrap) {
        if (!wrap) { return; }
        if (wrap.classList.contains('is-open')) { closeSelect(wrap); } else { openSelect(wrap); }
    }
    function pickSelect(opt) {
        var wrap = opt.closest('[data-loc-select]');
        if (!wrap) { return; }
        setSelectValue(wrap, opt.getAttribute('data-value') || '', opt.getAttribute('data-display') || (opt.textContent || '').trim());
        closeSelect(wrap);
    }
    function setSelectValue(wrap, value, labelText) {
        if (!wrap) { return; }
        var hidden  = wrap.querySelector('input[type="hidden"]');
        var valueEl = wrap.querySelector('[data-loc-select-value]');
        var menu    = wrap.querySelector('[data-loc-select-menu]');
        if (hidden) { hidden.value = value || ''; }
        if (valueEl) {
            var label = labelText;
            if (!label && menu) {
                var match = menu.querySelector('.loc-select__opt[data-value="' + value + '"]');
                label = match ? (match.getAttribute('data-display') || (match.textContent || '').trim()) : '';
            }
            valueEl.textContent = label || (wrap.getAttribute('data-placeholder') || 'Select');
            valueEl.classList.toggle('is-placeholder', !value);
        }
        if (menu) {
            menu.querySelectorAll('.loc-select__opt').forEach(function (o) {
                o.classList.toggle('is-selected', o.getAttribute('data-value') === value && !!value);
            });
        }
    }

    // ── Real Google Map for the chosen point (Embed API) ───────────
    // Replaces the cosmetic grid with an actual map when a browser key +
    // coords are present; otherwise the stylized grid stays as the fallback.
    function renderLocationMap(lat, lng) {
        if (!mapEl || !mapGrid) { cacheNodes(); }
        if (!mapEl || !mapGrid || !window.GMap) { return; }
        var ok = window.GMap.embed(mapGrid, lat, lng, { title: 'Selected location', zoom: 16 });
        mapEl.classList.toggle('loc-map--real', !!ok);   // CSS hides the cosmetic pin/hint
    }

    // ── Local stylized map: drag to pan the grid (cosmetic pin) ─────
    function bindMapDrag() {
        if (!mapEl || !mapGrid) { return; }
        if (mapEl.classList.contains('loc-map--real')) { return; }   // real map handles its own pan/zoom
        var dragging = false, startX = 0, startY = 0, offX = 0, offY = 0, baseX = 0, baseY = 0;
        mapEl.addEventListener('pointerdown', function (ev) {
            dragging = true; startX = ev.clientX; startY = ev.clientY; baseX = offX; baseY = offY;
            mapEl.setPointerCapture(ev.pointerId);
        });
        mapEl.addEventListener('pointermove', function (ev) {
            if (!dragging) { return; }
            offX = baseX + (ev.clientX - startX);
            offY = baseY + (ev.clientY - startY);
            mapGrid.style.backgroundPosition = offX + 'px ' + offY + 'px';
        });
        function end(ev) { dragging = false; try { mapEl.releasePointerCapture(ev.pointerId); } catch (e) {} }
        mapEl.addEventListener('pointerup', end);
        mapEl.addEventListener('pointercancel', end);
    }

    // ── Consent bridge ──────────────────────────────────────────────
    function onConsentAccepted() {
        fetch('/location', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (resp) { return resp.json(); })
            .then(function (body) { if (body && body.status === 200 && body.data) { writeLocationCookie(body.data); } })
            .catch(function () {});
    }
    document.addEventListener('eatndeal:cookies:accepted', onConsentAccepted);
    document.addEventListener('eatndeal:cookies:rejected', function () { clearLocationCookie(); document.cookie = RECENTS_KEY + '=; Max-Age=0; Path=/; SameSite=Lax'; });

    function delegateOpenTriggers() {
        document.addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('[data-action="open-location-modal"]');
            if (t) { ev.preventDefault(); open(); }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', delegateOpenTriggers);
    } else {
        delegateOpenTriggers();
    }

    // openFormFor — open the modal directly on its form view, optionally
    // pre-filled with an existing address row. Used by the inline
    // addresses tab on /account?tab=addresses so the "Add new" / "Edit"
    // buttons there reuse this modal's map + form + save plumbing.
    function openFormFor(addr) {
        cacheNodes();
        if (!modal) { return; }
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        openCount += 1;
        openForm(addr || null);
    }

    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.locationModal = { open: open, close: close, save: save, openForm: openFormFor };
    // Convenience alias used by /js/pages/account.js — same surface,
    // shorter name so the calling code reads cleanly.
    window.EatNDealLocationModal = { open: open, openForm: openFormFor };
})();
