/*
 * ui/filter-sidebar.js
 *
 * What:  Controller for the web left filter rail (.fsb). Reads the
 *        radios / checkboxes / toggles, derives the same filter URL
 *        params the api accepts, and on Apply navigates the page via
 *        the shared `eatndeal:filters-changed` event (home.js listens).
 *        Restores the control state from the URL on load so a
 *        filtered/shared URL shows the right boxes ticked.
 * Why:   The mockup uses a checkbox/toggle rail rather than chips;
 *        this reads inputs directly. Functional filters map to:
 *          sort-web radio            → ?sort=
 *          rating-web radio (4.5..)  → ?rating=
 *          time-NN checkboxes        → ?delivery= (union of bands)
 *          price-low/mid/high check  → ?price=
 *          trust-pure-veg check      → ?veg=1
 *          offer-* check             → ?offer=1
 *          avail-open-now toggle     → ?open_now=1
 *          dist-5 toggle             → ?max_km=5
 *          cuisine-X checkbox        → ?cuisine=X (first ticked wins)
 *        jain / gluten-free remain visual-only (no api column yet) —
 *        they tick but don't change the query.
 * Used:  Loaded by views/_layout.ejs. Sidebar renders on default home.
 */

(function () {
    'use strict';

    var root;

    function resolve() {
        // Re-query when the cached node was replaced by an SPA swap —
        // a stale (disconnected) root made Clear all / Apply dead after
        // any full #app-main swap (open restaurant → back to home).
        if (root && root.isConnected) { return true; }
        root = document.querySelector('.fsb');
        return !!root;
    }

    /**
     * collectState
     *
     * What:  Walks the rail's inputs and builds the filter state
     *        object home.js#filtersToQuery understands.
     */
    function collectState() {
        var state = {
            sort: 'relevance', rating: null, deliveryBuckets: [], distance: null,
            price: null, cuisine: null, trust: [], offers: [], availability: [], collections: [], browse: null,
        };
        if (!root) { return state; }

        // Sort radio.
        var sortR = root.querySelector('input[name="sort-web"]:checked');
        if (sortR) { state.sort = sortR.value; }

        // Rating radio (data-filter="rating-4.5" etc).
        var ratingR = root.querySelector('input[name="rating-web"]:checked');
        if (ratingR) { state.rating = ratingR.getAttribute('data-filter'); }

        // Browse radio (Collections & offers — data-filter="browse-<key>").
        var browseR = root.querySelector('input[name="browse-web"]:checked');
        if (browseR) { state.browse = browseR.getAttribute('data-filter'); }

        // Checkboxes + toggles — read every checked data-filter.
        root.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
            var id = cb.getAttribute('data-filter') || '';
            if (id.indexOf('time-') === 0) {
                // Collect EVERY checked delivery band — they form a
                // union of ranges (e.g. "15-30" + "30-45"), not a cap.
                var key = id.replace('time-', '');
                if (state.deliveryBuckets.indexOf(key) === -1) { state.deliveryBuckets.push(key); }
            } else if (id.indexOf('price-') === 0) {
                if (!state.price) { state.price = id; }       // first wins
            } else if (id.indexOf('cuisine-') === 0) {
                // First ticked cuisine wins — the api filters by a
                // single category, so we forward one ?cuisine=.
                if (!state.cuisine) { state.cuisine = id.replace('cuisine-', ''); }
            } else if (id.indexOf('dist-') === 0) {
                state.distance = id;
            } else if (id === 'trust-pure-veg') {
                if (state.trust.indexOf(id) === -1) { state.trust.push(id); }
            } else if (id.indexOf('offer-') === 0) {
                if (state.offers.indexOf('offer-discount') === -1) { state.offers.push('offer-discount'); }
            } else if (id === 'avail-open-now') {
                if (state.availability.indexOf(id) === -1) { state.availability.push(id); }
            } else if (id.indexOf('rating-') === 0) {
                // "Top Rated" toggle uses rating-4.0.
                if (!state.rating) { state.rating = id; }
            }
        });
        return state;
    }

    function syncActiveClasses() {
        if (!root) { return; }
        root.querySelectorAll('.fsb__radio, .fsb__check').forEach(function (row) {
            var input = row.querySelector('input');
            row.classList.toggle('is-active', !!(input && input.checked));
        });
    }

    function broadcast(extra) {
        try {
            var detail = collectState();
            if (extra) { Object.keys(extra).forEach(function (k) { detail[k] = extra[k]; }); }
            document.dispatchEvent(new CustomEvent('eatndeal:filters-changed', {
                detail: detail,
            }));
        } catch (e) { /* old browser */ }
    }

    function clearAll() {
        if (!root) { return; }
        root.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
        // Radios too — nothing stays ticked. Recommended is the api's
        // implicit default order, so an unticked rail = default feed.
        root.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = false; });
        syncActiveClasses();
        // cleared:true → home.js drops the rail's ?cuisine too. "Clear
        // all" means EVERYTHING, including the cuisine picked on the
        // top rail (which normal Apply intentionally preserves).
        broadcast({ cleared: true });
    }

    /**
     * restoreFromUrl
     *
     * What:  Tick the controls that correspond to the filter params
     *        already on the URL so a reloaded/shared filtered page
     *        shows the right state.
     */
    function restoreFromUrl() {
        if (!root) { return; }
        var q = new URLSearchParams(window.location.search);
        function check(selector) { var el = root.querySelector(selector); if (el) { el.checked = true; } }

        if (q.get('sort')) { check('input[name="sort-web"][value="' + q.get('sort') + '"]'); }
        if (q.get('rating')) { check('input[name="rating-web"][data-filter="rating-' + q.get('rating') + '"]'); }
        if (q.get('delivery')) {
            q.get('delivery').split(',').forEach(function (k) {
                check('input[data-filter="time-' + k.trim() + '"]');
            });
        }
        if (q.get('price')) { check('input[data-filter="price-' + q.get('price') + '"]'); }
        if (q.get('cuisine')) { check('input[data-filter="cuisine-' + q.get('cuisine') + '"]'); }
        if (q.get('veg') === '1') { check('input[data-filter="trust-pure-veg"]'); }
        if (q.get('offer') === '1') { check('input[data-filter="offer-discount"]'); }
        if (q.get('open_now') === '1') { check('input[data-filter="avail-open-now"]'); }
        if (q.get('max_km')) { check('input[data-filter="dist-' + q.get('max_km') + '"]'); }
        if (q.get('browse')) { check('input[name="browse-web"][data-filter="browse-' + q.get('browse') + '"]'); }
        syncActiveClasses();
    }

    /**
     * refreshTriggerBadge
     *
     * What:  Counts the filter params on the current URL and reflects
     *        them on every filter trigger: fills the [data-filter-badge]
     *        count and toggles .has-filters on the trigger button so
     *        CSS colours it red (applied) vs black (none).
     * Why:   Lives HERE (not filter-sheet.js) because the old mobile
     *        bottom sheet was removed from the layout — its script no
     *        longer loads, so this file owns the badge for all pages.
     */
    function refreshTriggerBadge() {
        var badges = document.querySelectorAll('[data-filter-badge]');
        if (!badges.length) { return; }
        var q = new URLSearchParams(window.location.search);
        var n = 0;
        // One point per applied facet. ?sort only appears on the URL
        // when it is NOT relevance, so its presence alone counts.
        // ?cuisine is deliberately NOT counted — the category rail owns
        // it (active pill shows the state); it isn't a "Filters" pick.
        ['sort', 'rating', 'price', 'max_min', 'max_km', 'browse'].forEach(function (k) {
            if (q.get(k)) { n += 1; }
        });
        ['veg', 'offer', 'open_now', 'recommended', 'featured'].forEach(function (k) {
            if (q.get(k) === '1') { n += 1; }
        });
        // Delivery-time bands are a comma list — each band counts.
        if (q.get('delivery')) {
            n += q.get('delivery').split(',').filter(function (s) { return s.trim(); }).length;
        }
        badges.forEach(function (badge) {
            badge.textContent = n > 9 ? '9+' : String(n);
            badge.hidden = n === 0;
            var trigger = badge.closest ? badge.closest('button, a') : null;
            if (trigger) { trigger.classList.toggle('has-filters', n > 0); }
        });
    }

    /**
     * filterCuisineList
     *
     * What:  Live-filters the cuisine checkbox list as the user types
     *        in the cuisine search box — pure DOM show/hide, no fetch.
     */
    function filterCuisineList(term) {
        var q = String(term || '').trim().toLowerCase();
        root.querySelectorAll('.fsb__cuisine-list .fsb__check').forEach(function (row) {
            var name = row.getAttribute('data-cuisine-name') || '';
            row.hidden = q && name.indexOf(q) === -1;
        });
    }

    function bind() {
        // Delegated on document (scoped to .fsb) so the handlers keep
        // working after an SPA swap replaces the sidebar DOM. The
        // mobile filter sheet has its own controller, so anything
        // outside .fsb is ignored here.
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest || !t.closest('.fsb') || !resolve()) { return; }
            if (t.closest('[data-action="filters-clear-all"]')) { ev.preventDefault(); clearAll(); return; }
            if (t.closest('[data-action="filters-apply"]'))     { ev.preventDefault(); broadcast(); return; }
        });

        // Any input change re-syncs the active classes (visual only;
        // the actual navigation happens on Apply).
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'INPUT' && t.closest && t.closest('.fsb') && resolve()) { syncActiveClasses(); }
        });

        // Cuisine search live-filter.
        document.addEventListener('input', function (ev) {
            var t = ev.target;
            if (t && t.hasAttribute && t.hasAttribute('data-fsb-cuisine-search') && resolve()) {
                filterCuisineList(t.value);
            }
        });

        // Trigger badge/colour — recount after every apply/clear (the
        // timeout defers past home.js's pushState in its own listener,
        // whatever the listener order) and on back/forward.
        document.addEventListener('eatndeal:filters-changed', function () {
            window.setTimeout(refreshTriggerBadge, 0);
        });
        window.addEventListener('popstate', function () {
            window.setTimeout(refreshTriggerBadge, 0);
        });
    }

    function init() {
        bind();
        if (resolve()) { restoreFromUrl(); }
        refreshTriggerBadge();
    }

    // Re-sync a freshly swapped-in sidebar (home.js calls this after a
    // full #app-main swap — the new markup renders unchecked, so the
    // controls must be re-ticked from the current URL).
    window.EatNDealFilterSidebar = {
        restore: function () { if (resolve()) { restoreFromUrl(); } refreshTriggerBadge(); },
        refreshBadge: refreshTriggerBadge,
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
