/*
 * ui/location-modal.js
 *
 * What:  Drives the full-screen location-picker modal.
 *         • Open / close (backdrop click, close button, Esc).
 *         • Debounced postcode/address search → POST /api/v1/delivery/search-address
 *         • Suggestion click → POST /api/v1/delivery/retrieve-address → save.
 *         • "Use my current location" → navigator.geolocation → reverse lookup.
 *         • Popular-city chip click → save city as the label.
 *        Saves the chosen location via POST /api/v1/customer/location
 *        (server-side session) AND in window.localStorage for instant
 *        re-render across reloads.
 * Why:   First UX moment for new visitors (Coding-Conventions rule #4 +
 *        #8). Mirrors the existing Yii2 DeliveryController/searchAddress /
 *        retrieveAddress flow — same endpoints will be ported to the
 *        Node API in the next phase.
 * Used:  Loaded from views/_layout.ejs. Exposes
 *        window.EatNDealUi.locationModal.{open, close, save}.
 */

(function () {
    'use strict';

    var LS_KEY = 'eatndeal.location';
    var SEARCH_DEBOUNCE_MS = 300;
    var MIN_QUERY = 3;
    var MAX_LABEL_LEN = 48;     // header chip + hero copy are short — keep label tight

    var modal, input, list, status;
    var searchTimer = null;
    var openCount  = 0;

    /**
     * buildShortLabel
     *
     * What:  Turns the full address object returned by /retrieve-address
     *        into a SHORT, human-friendly label suitable for the header
     *        chip and hero copy. Nominatim's display_name is verbose
     *        ("Lonemore, Gairloch, Highland, Alba / Scotland, IV21 2DB,
     *        United Kingdom") — we trim that to roughly "Lonemore,
     *        IV21 2DB".
     * Why:   The header chip has limited width and the hero text loses
     *        impact when it spans two lines. Better UX to show the most
     *        useful identifiers (town + postcode) and stash the full
     *        address in `raw` for later screens that have room.
     * Type:  READ (pure function).
     * Inputs: address  — canonical address shape from the api
     *                    (line_1, post_town, postcode, country …)
     *         fallback — original display_name string from the
     *                    suggestion row; used when the address parts are
     *                    too sparse to build a meaningful label.
     * Output: string (1..MAX_LABEL_LEN chars).
     * Used:   retrieveAndSave (postcode / Nominatim flows).
     */
    function buildShortLabel(address, fallback) {
        address = address || {};
        var line1     = (address.line_1   || '').trim();
        var postTown  = (address.post_town || '').trim();
        var postcode  = (address.postcode  || '').trim();

        var label = '';

        if (line1 && postTown && line1.toLowerCase() !== postTown.toLowerCase()) {
            // Real street address — "10 Downing Street, London"
            label = line1 + ', ' + postTown;
        } else if (postTown && postcode) {
            // Town centroid — "Lonemore, IV21 2DB"
            label = postTown + ', ' + postcode;
        } else if (postTown) {
            // Town only
            label = postTown;
        } else if (line1 && postcode) {
            label = line1 + ', ' + postcode;
        } else if (postcode) {
            label = postcode;
        } else if (line1) {
            label = line1;
        } else if (typeof fallback === 'string' && fallback.trim()) {
            // Last resort: keep only the first two comma-separated parts
            // of Nominatim's display_name.
            var parts = fallback.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            label = parts.slice(0, 2).join(', ');
        } else {
            label = 'Selected location';
        }

        if (label.length > MAX_LABEL_LEN) {
            label = label.slice(0, MAX_LABEL_LEN - 1).trimEnd() + '…';
        }
        return label;
    }

    /**
     * cacheNodes
     *
     * What:  Picks up the modal DOM refs once and binds the action buttons.
     * Why:   Cheap to query — but doing it once on first open is tidier.
     */
    function cacheNodes() {
        if (modal) { return; }
        modal  = document.getElementById('location-modal');
        if (!modal) { return; }
        input  = modal.querySelector('#location-search-input');
        list   = modal.querySelector('#location-search-suggestions');
        status = modal.querySelector('#location-search-status');

        // Close triggers — any element with data-action="close-location-modal"
        modal.querySelectorAll('[data-action="close-location-modal"]').forEach(function (el) {
            el.addEventListener('click', close);
        });

        // Search input — debounced
        input.addEventListener('input', onInput);

        // "Use my current location" button
        var geoBtn = modal.querySelector('[data-action="use-current-location"]');
        if (geoBtn) { geoBtn.addEventListener('click', useCurrentLocation); }

        // Popular city chips
        modal.querySelectorAll('[data-city]').forEach(function (chip) {
            chip.addEventListener('click', function () {
                save({
                    label: chip.getAttribute('data-city'),
                    postcode: null,
                    lat: null,
                    lng: null,
                    source: 'popular',
                });
            });
        });

        // Esc to close
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && openCount > 0) { close(); }
        });
    }

    /**
     * open
     *
     * What:  Shows the modal, focuses the input, locks body scroll.
     * Why:   First UX moment + on-demand from the header chip + hero CTA.
     */
    function open() {
        cacheNodes();
        if (!modal) { return; }
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        openCount += 1;
        // Defer auto-focus until AFTER the CSS entrance animation
        // (~240 ms — see location-modal.css). Focusing instantly causes
        // the heavy focus ring to flash before the panel finishes its
        // rise, which read as "loading badly". Waiting until the panel
        // is settled lets the focus ring appear cleanly at the end.
        window.setTimeout(function () { if (input) { input.focus(); } }, 280);
    }

    /**
     * close
     *
     * What:  Hides the modal, restores body scroll, clears the search list.
     * Why:   Before flipping aria-hidden to "true", we move focus OUT of
     *        the modal — leaving focus inside an aria-hidden ancestor is
     *        an a11y violation and Chrome logs a console warning. We
     *        forward focus to <body> so the modal can be safely hidden
     *        from the accessibility tree.
     */
    function close() {
        if (!modal) { return; }
        moveFocusOut();
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        openCount = 0;
        clearSuggestions();
    }

    /**
     * moveFocusOut (private)
     *
     * What:  If something inside the modal currently has focus, move it
     *        to <body> so the modal can be safely aria-hidden.
     * Why:   Browsers warn when aria-hidden is set on an ancestor of the
     *        focused element. The a11y tree treats those nodes as gone,
     *        which strands keyboard / screen-reader users on an
     *        invisible element.
     * Type:  WRITE (DOM focus).
     */
    function moveFocusOut() {
        var active = document.activeElement;
        if (active && modal && modal.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }
    }

    /**
     * clearSuggestions
     *
     * What:  Empties the suggestion list + hides it + clears the status line.
     */
    function clearSuggestions() {
        if (list) {
            while (list.firstChild) { list.removeChild(list.firstChild); }
            list.hidden = true;
        }
        if (status) {
            status.textContent = '';
            status.hidden = true;
        }
        if (input) { input.setAttribute('aria-expanded', 'false'); }
    }

    /**
     * setStatus
     *
     * What:  Shows a single-line status under the suggestion list (e.g.
     *        "Searching...", "No matches", "Could not reach search").
     * Why:   Calmer than a toast for transient inline feedback.
     */
    function setStatus(text) {
        if (!status) { return; }
        status.textContent = text || '';
        status.hidden = !text;
    }

    /**
     * onInput
     *
     * What:  Input handler — debounces calls to runSearch so we don't
     *        hammer the API on every keystroke.
     */
    function onInput() {
        if (searchTimer) { window.clearTimeout(searchTimer); }
        var q = (input.value || '').trim();

        if (q.length < MIN_QUERY) {
            clearSuggestions();
            return;
        }

        searchTimer = window.setTimeout(function () { runSearch(q); }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * runSearch
     *
     * What:  Calls POST /api/v1/delivery/search-address with the query and
     *        renders the resulting suggestion list.
     * Why:   Postcode autocomplete — backed by the Ideal Postcodes API on
     *        the server. The api endpoint is the Node port of
     *        webordering/controllers/DeliveryController::actionSearchAddress.
     * Type:  READ.
     */
    async function runSearch(q) {
        setStatus('Searching…');
        try {
            var data = await window.EatNDealApi.post('/api/v1/delivery/search-address', { query: q });
            var suggestions = (data && data.suggestions) || [];
            renderSuggestions(suggestions);
            if (!suggestions.length) {
                // Hint at what works — Nominatim (the default provider)
                // accepts city / area / street / postcode; mention all so
                // users with the postcodes_io provider also know to try
                // a postcode prefix.
                setStatus('We couldn’t find that. Try a city, area, street, or postcode.');
            } else {
                setStatus('');
            }
        } catch (err) {
            setStatus(err.message || 'Could not search right now. Please try again.');
            clearListOnly();
        }
    }

    /**
     * clearListOnly
     *
     * What:  Empties only the list (keeps the status line). Used when a
     *        search fails so the user sees the error without the previous
     *        suggestions still hanging around.
     */
    function clearListOnly() {
        if (!list) { return; }
        while (list.firstChild) { list.removeChild(list.firstChild); }
        list.hidden = true;
    }

    /**
     * renderSuggestions
     *
     * What:  Builds <li> children for each suggestion and wires click →
     *        retrieveAndSave.
     * Why:   Avoids innerHTML so user-supplied address text can't be
     *        interpreted as HTML. The "highlight" returned by the api is
     *        already escaped server-side AND wrapped in <strong>, so we
     *        use it as-is via insertAdjacentHTML on a safe substring.
     *        Defence: also strip every tag except <strong>.
     */
    function renderSuggestions(suggestions) {
        if (!list) { return; }
        while (list.firstChild) { list.removeChild(list.firstChild); }

        suggestions.forEach(function (s) {
            var li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('data-id', s.id);
            li.setAttribute('tabindex', '0');

            // Use textContent for safety — the highlight is cosmetic.
            li.textContent = s.address || '';

            li.addEventListener('click',  function () { retrieveAndSave(s.id, s.address); });
            li.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    retrieveAndSave(s.id, s.address);
                }
            });
            list.appendChild(li);
        });

        list.hidden = suggestions.length === 0;
        if (input) { input.setAttribute('aria-expanded', suggestions.length ? 'true' : 'false'); }
    }

    /**
     * retrieveAndSave
     *
     * What:  Calls POST /api/v1/delivery/retrieve-address with the picked
     *        suggestion id, then persists the resolved address.
     * Why:   Two-step pattern of the underlying Ideal Postcodes API —
     *        suggestion ids are lookup keys, not real addresses.
     */
    async function retrieveAndSave(id, fallbackLabel) {
        setStatus('Loading address…');
        try {
            var data    = await window.EatNDealApi.post('/api/v1/delivery/retrieve-address', { id: id });
            var address = data && data.address;
            if (!address) { throw new Error('Address details were not returned.'); }

            save({
                label:    buildShortLabel(address, fallbackLabel),
                postcode: address.postcode || null,
                lat:      address.latitude  || null,
                lng:      address.longitude || null,
                raw:      address,
                source:   'postcode',
            });
        } catch (err) {
            setStatus(err.message || 'Could not load that address. Please try another.');
        }
    }

    /**
     * useCurrentLocation
     *
     * What:  Uses navigator.geolocation to grab a lat/lng, then asks the
     *        api to map it to a postcode + delivery zone.
     * Why:   One-tap UX for mobile users.
     */
    function useCurrentLocation() {
        if (!navigator.geolocation) {
            window.EatNDealUi.showToast('error', 'Your browser does not support location sharing. Please enter a postcode.');
            return;
        }
        setStatus('Getting your location…');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                save({
                    label:    'My current location',
                    postcode: null,
                    lat:      pos.coords.latitude,
                    lng:      pos.coords.longitude,
                    source:   'geolocation',
                });
            },
            function (err) {
                setStatus('Could not get your location. ' + (err.message || ''));
                window.EatNDealUi.showToast('warn', 'Please allow location access or enter a postcode.');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    }

    /**
     * save
     *
     * What:  Persists the chosen location:
     *         1. POST /location/save → req.session.userLocation
     *            (strictly-necessary session cookie; works whether or
     *            not the user has accepted cookies).
     *         2. If consent is 'accepted' → also writes a 30-day
     *            client-readable cookie `eatndeal_location` so the
     *            pick survives session expiry and server restarts.
     *        Then closes the modal and reloads so SSR picks up the change.
     * Why:   Login is not required to set a location. The web session
     *        cookie holds the value for 7 days; the optional consent-
     *        gated long-lived cookie holds it for 30 and bridges across
     *        memory-store session resets.
     * Type:  WRITE (server session + optional cookie).
     * Inputs: location — { source, label, postcode, lat, lng, raw }
     *         shape produced by the postcode / geolocation / popular-city
     *         flows above. Server-side validator clamps and sanitises.
     * Output: void — page reload picks up the new state.
     * Used:   retrieveAndSave (postcode flow), useCurrentLocation
     *         (geolocation flow), popular-city chip click handlers.
     */
    async function save(location) {
        // 1. Server session via POST /location/save (web endpoint — NOT
        //    the api). The web handler validates + writes to
        //    req.session.userLocation; SSR pages read it on the next request.
        //
        //    fetch() goes directly to the web origin (relative URL) so the
        //    session cookie is included automatically. No JWT needed —
        //    location is for guests and members alike.
        var ok = false;
        try {
            var resp = await fetch('/location/save', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                credentials: 'same-origin',
                body:    JSON.stringify(location),
            });
            var body = await resp.json();
            ok = (body && body.status === 200);
            if (!ok && body && body.msg && window.EatNDealUi) {
                window.EatNDealUi.showToast('error', body.msg);
                return;     // don't reload; let the user pick again
            }
        } catch (e) {
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('warn', 'Could not save right now — please check your connection.');
            }
            return;
        }

        // 2. Long-lived client-readable cookie — only when the user has
        //    explicitly accepted cookies. Without consent we don't
        //    persist anything beyond the strictly-necessary session
        //    cookie above.
        if (readConsent() === 'accepted') {
            writeLocationCookie(location);
        }

        close();
        // Reload so the server-rendered chip + hero copy + restaurant lists
        // reflect the chosen area. Cheap on this lightweight page; can be
        // upgraded to a client-side state update later if reloads feel slow.
        window.location.reload();
    }

    // ── Cookie helpers (consent-gated) ─────────────────────────────

    /**
     * readConsent
     *
     * What:  Reads the `eatndeal_consent` cookie set by the consent
     *        banner. Returns '' / 'accepted' / 'rejected'.
     * Why:   Gate the optional location cookie on explicit consent.
     * Type:  READ.
     */
    function readConsent() {
        var pairs = document.cookie.split(';');
        for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i].trim();
            if (pair.indexOf('eatndeal_consent=') === 0) {
                return decodeURIComponent(pair.substring('eatndeal_consent='.length));
            }
        }
        return '';
    }

    /**
     * writeLocationCookie
     *
     * What:  Writes a slim version of the location object into the
     *        `eatndeal_location` cookie with a 30-day lifetime.
     * Why:   30-day persistence so the chosen area survives session
     *        expiry + server restarts. Slim payload (drops `raw` blob)
     *        to stay well under the 4 KB per-cookie limit.
     * Type:  WRITE (sets document.cookie).
     */
    function writeLocationCookie(loc) {
        var slim = {
            label:    loc.label    || '',
            postcode: loc.postcode || null,
            lat:      loc.lat      || null,
            lng:      loc.lng      || null,
            source:   loc.source   || 'manual',
            savedAt:  loc.savedAt  || new Date().toISOString(),
        };
        var parts = [
            'eatndeal_location=' + encodeURIComponent(JSON.stringify(slim)),
            'Max-Age=' + (60 * 60 * 24 * 30),     // 30 days
            'Path=/',
            'SameSite=Lax',
        ];
        // Browsers drop `Secure` cookies on plain-http origins, so gate
        // it on the page protocol. Production (https) gets Secure; local
        // dev (http://localhost) does not.
        if (window.location.protocol === 'https:') { parts.push('Secure'); }
        document.cookie = parts.join('; ');
    }

    /**
     * clearLocationCookie
     *
     * What:  Removes the eatndeal_location cookie by setting Max-Age=0.
     * Used:  When the user revokes consent via the consent banner.
     */
    function clearLocationCookie() {
        document.cookie = 'eatndeal_location=; Max-Age=0; Path=/; SameSite=Lax';
    }

    // ── Consent-event bridge ───────────────────────────────────────
    //
    // The consent banner (/js/ui/cookie-consent.js) emits two custom
    // events on document when the user makes a choice. We hook into both
    // to migrate the existing session location into the cookie (or wipe
    // the cookie on revoke). This means a user who set a location
    // BEFORE accepting cookies still gets the 30-day persistence as
    // soon as they accept.

    /**
     * onConsentAccepted
     *
     * What:  Asks the server for the current session location and, if
     *        present, writes it into the long-lived cookie. Runs once
     *        per accept event.
     */
    function onConsentAccepted() {
        fetch('/location', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (resp) { return resp.json(); })
            .then(function (body) {
                if (body && body.status === 200 && body.data) {
                    writeLocationCookie(body.data);
                }
            })
            .catch(function () { /* ignore — nothing to migrate */ });
    }

    document.addEventListener('eatndeal:cookies:accepted', onConsentAccepted);
    document.addEventListener('eatndeal:cookies:rejected', clearLocationCookie);

    /**
     * delegateOpenTriggers
     *
     * What:  Listens (event-delegated) for clicks on anything with
     *        data-action="open-location-modal" and opens the modal.
     * Why:   Lets the header chip, the hero CTA, and any future trigger
     *        share one listener instead of binding one each.
     */
    function delegateOpenTriggers() {
        document.addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('[data-action="open-location-modal"]');
            if (t) {
                ev.preventDefault();
                open();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', delegateOpenTriggers);
    } else {
        delegateOpenTriggers();
    }

    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.locationModal = { open: open, close: close, save: save };
})();
