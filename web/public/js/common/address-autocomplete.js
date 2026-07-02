/*
 * common/address-autocomplete.js — reusable address autocomplete + "use my
 * current location" for ANY address form (account, cart delivery modal, …).
 *
 * Backed by the Google-powered delivery endpoints:
 *   POST /api/v1/delivery/search-address    → suggestions (worldwide)
 *   POST /api/v1/delivery/retrieve-address   → resolve a pick → full address
 *   POST /api/v1/delivery/reverse-geocode    → GPS coords → address (+ served gate)
 *
 * Usage:
 *   AddressAutocomplete.attach({
 *       input:  <text input>,          // the address field
 *       list:   <ul>,                  // suggestions dropdown (gets .addr-ac__item li's)
 *       locBtn: <button>,              // optional "use my current location"
 *       onPick: function (address) {}  // fill YOUR fields from the resolved address
 *   });
 *
 * The address object has: line_1, line_2, post_town, postcode, county, country,
 * latitude, longitude, building_number, thoroughfare, plus _label (display text).
 */
(function (w, d) {
    'use strict';

    function api()  { return w.EatNDealApi; }
    function toast(t, m)  { if (w.EatNDealUi && w.EatNDealUi.showToast) { w.EatNDealUi.showToast(t, m); } }
    function loaderOn(l)  { if (w.EatNDealUi && w.EatNDealUi.showLoader) { w.EatNDealUi.showLoader({ label: l || 'Loading…' }); } }
    function loaderOff()  { if (w.EatNDealUi && w.EatNDealUi.hideLoader) { w.EatNDealUi.hideLoader(); } }

    function attach(opts) {
        opts = opts || {};
        var input  = opts.input;
        var list   = opts.list || null;
        var locBtn = opts.locBtn || null;
        var onPick = opts.onPick;
        if (!input || typeof onPick !== 'function' || !api()) { return; }

        var debounce = null;

        function hide() { if (list) { list.hidden = true; list.innerHTML = ''; } }

        function render(suggestions) {
            if (!list) { return; }
            list.innerHTML = '';
            if (!suggestions || !suggestions.length) { hide(); return; }
            suggestions.forEach(function (s) {
                var li = d.createElement('li');
                li.className = 'addr-ac__item';
                li.setAttribute('role', 'option');
                li.textContent = s.address || '';
                // mousedown keeps the input focused (so its blur doesn't hide the
                // list before the click lands); the click does the actual select.
                li.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
                li.addEventListener('click', function (ev) { ev.preventDefault(); choose(s.id, s.address); });
                list.appendChild(li);
            });
            list.hidden = false;
        }

        function choose(id, label) {
            hide();
            api().post('/api/v1/delivery/retrieve-address', { id: id }).then(function (data) {
                var addr = data && data.address;
                if (!addr) { return; }
                addr._label = label || '';
                onPick(addr);
            }).catch(function () { toast('error', 'Could not load that address. Please try another.'); });
        }

        input.addEventListener('input', function () {
            var q = input.value.trim();
            if (debounce) { w.clearTimeout(debounce); }
            if (q.length < 3) { hide(); return; }
            debounce = w.setTimeout(function () {
                api().post('/api/v1/delivery/search-address', { query: q })
                    .then(function (data) { render((data && data.suggestions) || []); })
                    .catch(function () { hide(); });
            }, 250);
        });
        // Let a click on a suggestion register before hiding.
        input.addEventListener('blur', function () { w.setTimeout(hide, 150); });

        if (locBtn) {
            locBtn.addEventListener('click', function (ev) {
                ev.preventDefault();
                if (!navigator.geolocation) { toast('error', 'Your browser does not support location sharing. Please enter your address.'); return; }
                loaderOn('Getting your location…');
                navigator.geolocation.getCurrentPosition(
                    function (pos) {
                        var lat = pos.coords.latitude, lng = pos.coords.longitude;
                        api().post('/api/v1/delivery/reverse-geocode', { lat: lat, lng: lng })
                            .then(function (data) {
                                loaderOff();
                                // Served-country gate.
                                if (data && data.allowed === false) {
                                    var cn = (data.address && data.address.country) || 'your country';
                                    toast('error', 'Sorry, we don’t deliver in ' + cn + ' yet.');
                                    return;
                                }
                                var addr = data && data.address;
                                if (!addr) { toast('error', 'Could not detect your location. Please enter your address.'); return; }
                                if (addr.latitude  == null) { addr.latitude  = lat; }
                                if (addr.longitude == null) { addr.longitude = lng; }
                                addr._label = data.label || '';
                                onPick(addr);
                            })
                            .catch(function () { loaderOff(); toast('error', 'Could not detect your location. Please enter your address.'); });
                    },
                    function (err) { loaderOff(); toast('warn', 'Please allow location access or enter your address. ' + ((err && err.message) || '')); },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
                );
            });
        }
    }

    // Compose a tidy single-line address from the structured fields, with a
    // label fallback — handy for filling a free-text "address" input.
    function line(address) {
        if (!address) { return ''; }
        var parts = [address.line_1, address.line_2].filter(Boolean);
        if (parts.length) { return parts.join(', '); }
        return address.post_town || (address._label ? String(address._label).split(',')[0] : '') || '';
    }

    w.AddressAutocomplete = { attach: attach, line: line };
})(window, document);
