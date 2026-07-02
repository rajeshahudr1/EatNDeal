/*
 * pages/location-page.js
 *
 * What:  Drives the dedicated location landing page
 *        (views/site/location.ejs) — the no-location gate. Inline
 *        postcode/address search, "use my current location", popular-
 *        city shortcuts, and Delivery/Pickup tab toggle. On a pick it
 *        saves the location to the session and reloads into the feed.
 * Why:   Same flow as the change-location modal, but rendered inline
 *        as a full page (the user asked for this gate screen). Reuses
 *        the same api endpoints so behaviour is identical:
 *          POST /api/v1/delivery/search-address   → suggestions
 *          POST /api/v1/delivery/retrieve-address → resolve → coords
 *          POST /location/save                    → session → reload.
 * Used:  Loaded via extra_js when SiteController renders site/location.
 */

(function () {
    'use strict';

    var input, list, status, debounce;
    // Delivery / Pickup choice — sent with the saved location so the
    // feed header shows the same selection. Defaults to delivery.
    var selectedMode = 'delivery';

    function setStatus(text) {
        if (!status) { return; }
        status.hidden = !text;
        status.textContent = text || '';
    }

    // Full-screen spinner helpers (defensive — no-op if the loader UI is absent).
    function loaderOn(label) { if (window.EatNDealUi && window.EatNDealUi.showLoader) { window.EatNDealUi.showLoader({ label: label || 'Loading…' }); } }
    function loaderOff()     { if (window.EatNDealUi && window.EatNDealUi.hideLoader) { window.EatNDealUi.hideLoader(); } }

    /** Persist the picked location to the session, then reload home.
     *  The current Delivery/Pickup choice is stamped on every save. */
    async function save(location) {
        location.mode = selectedMode;
        setStatus('Saving…');
        try {
            var resp = await fetch('/location/save', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                credentials: 'same-origin',
                body:    JSON.stringify(location),
            });
            if (resp && resp.ok) { window.location.href = '/'; return; }
            loaderOff();
            setStatus('Could not save your location. Please try again.');
        } catch (e) {
            loaderOff();
            setStatus('Network error — please check your connection and try again.');
        }
    }

    /** Debounced address search (≥ 3 chars). */
    async function runSearch(q) {
        if (!list) { return; }
        if (!q || q.length < 3) { list.hidden = true; setStatus(''); return; }
        setStatus('Searching…');
        try {
            var data = await window.EatNDealApi.post('/api/v1/delivery/search-address', { query: q });
            var suggestions = (data && data.suggestions) || [];
            renderSuggestions(suggestions);
            setStatus(suggestions.length ? '' : 'We couldn’t find that. Try a city, area, street, or postcode.');
        } catch (err) {
            setStatus((err && err.message) || 'Could not search right now. Please try again.');
        }
    }

    function renderSuggestions(suggestions) {
        if (!list) { return; }
        while (list.firstChild) { list.removeChild(list.firstChild); }
        suggestions.forEach(function (s) {
            var li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('data-id', s.id);
            li.setAttribute('tabindex', '0');
            li.textContent = s.address || '';
            li.addEventListener('click', function () { retrieveAndSave(s.id, s.address); });
            li.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); retrieveAndSave(s.id, s.address); }
            });
            list.appendChild(li);
        });
        list.hidden = suggestions.length === 0;
        if (input) { input.setAttribute('aria-expanded', suggestions.length ? 'true' : 'false'); }
    }

    /** Resolve a suggestion id → full address (with coords) → save. */
    async function retrieveAndSave(id, fallbackLabel) {
        setStatus('Loading address…');
        try {
            var data    = await window.EatNDealApi.post('/api/v1/delivery/retrieve-address', { id: id });
            var address = data && data.address;
            if (!address) { throw new Error('Address details were not returned.'); }
            // Short label: town, postcode (keeps the header chip tidy).
            var label = fallbackLabel || address.postcode || 'Selected location';
            var parts = String(label).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            label = parts.slice(0, 2).join(', ');
            save({
                label:    label,
                postcode: address.postcode  || null,
                lat:      address.latitude   || null,
                lng:      address.longitude  || null,
                raw:      address,
                source:   'postcode',
            });
        } catch (err) {
            setStatus((err && err.message) || 'Could not load that address. Please try another.');
        }
    }

    function useCurrentLocation() {
        if (!navigator.geolocation) {
            setStatus('Your browser does not support location sharing. Please enter a postcode.');
            return;
        }
        setStatus('Getting your location…');
        loaderOn('Getting your location…');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                var lat = pos.coords.latitude, lng = pos.coords.longitude;
                // Reverse-geocode → real area name; also gate on served country.
                window.EatNDealApi.post('/api/v1/delivery/reverse-geocode', { lat: lat, lng: lng })
                    .then(function (data) {
                        if (data && data.allowed === false) {
                            loaderOff();
                            var cn = (data.address && data.address.country) || 'your country';
                            setStatus('Sorry, we don’t deliver in ' + cn + ' yet.');
                            return;   // stop — do NOT save or continue
                        }
                        var label    = (data && data.label)
                            || (data && data.address && (data.address.line_1 || data.address.post_town))
                            || 'My current location';
                        var postcode = (data && data.address && data.address.postcode) || null;
                        save({ label: label, postcode: postcode, lat: lat, lng: lng, source: 'geolocation' });
                    })
                    .catch(function () {
                        save({ label: 'My current location', postcode: null, lat: lat, lng: lng, source: 'geolocation' });
                    });
            },
            function (err) {
                loaderOff();
                setStatus('Could not get your location. ' + ((err && err.message) || 'Please allow access or enter a postcode.'));
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    }

    function bind() {
        input  = document.getElementById('location-search-input');
        list   = document.getElementById('location-search-suggestions');
        status = document.getElementById('location-search-status');
        if (!input) { return; }   // not the location page

        input.addEventListener('input', function () {
            var q = input.value.trim();
            if (debounce) { window.clearTimeout(debounce); }
            debounce = window.setTimeout(function () { runSearch(q); }, 250);
        });

        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            if (t.closest('[data-action="use-current-location"]')) { ev.preventDefault(); useCurrentLocation(); return; }

            var city = t.closest('[data-city]');
            if (city) {
                ev.preventDefault();
                var name = city.getAttribute('data-city') || '';
                input.value = name;
                input.focus();
                runSearch(name);
                return;
            }

            var tab = t.closest('[data-loc-tab]');
            if (tab) {
                document.querySelectorAll('[data-loc-tab]').forEach(function (x) {
                    var on = (x === tab);
                    x.classList.toggle('is-active', on);
                    x.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                // Remember the choice → sent with the next save.
                selectedMode = (tab.textContent || '').trim().toLowerCase().indexOf('pickup') !== -1 ? 'pickup' : 'delivery';
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
