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
 *          time-NN checkbox (cap)    → ?max_min=
 *          price-low/mid/high check  → ?price=
 *          trust-pure-veg check      → ?veg=1
 *          offer-* check             → ?offer=1
 *          avail-open-now toggle     → ?open_now=1
 *          dist-5 toggle             → ?max_km=5
 *        Cuisine + jain/vegan/gf + combo are visual-only for now
 *        (no api column yet) — they tick but don't change the query.
 * Used:  Loaded by views/_layout.ejs. Sidebar renders on default home.
 */

(function () {
    'use strict';

    var root;

    function resolve() {
        if (root) { return true; }
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
            sort: 'relevance', rating: null, time: null, distance: null,
            price: null, trust: [], offers: [], availability: [], collections: [],
        };
        if (!root) { return state; }

        // Sort radio.
        var sortR = root.querySelector('input[name="sort-web"]:checked');
        if (sortR) { state.sort = sortR.value; }

        // Rating radio (data-filter="rating-4.5" etc).
        var ratingR = root.querySelector('input[name="rating-web"]:checked');
        if (ratingR) { state.rating = ratingR.getAttribute('data-filter'); }

        // Checkboxes + toggles — read every checked data-filter.
        root.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
            var id = cb.getAttribute('data-filter') || '';
            if (id.indexOf('time-') === 0) {
                // Take the LARGEST checked bucket as the max-minutes cap.
                var mins = parseInt(id.replace('time-', ''), 10);
                if (!state.time || mins > parseInt(String(state.time).replace('time-', ''), 10)) {
                    state.time = id;
                }
            } else if (id.indexOf('price-') === 0) {
                if (!state.price) { state.price = id; }       // first wins
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

    function broadcast() {
        try {
            document.dispatchEvent(new CustomEvent('eatndeal:filters-changed', {
                detail: collectState(),
            }));
        } catch (e) { /* old browser */ }
    }

    function clearAll() {
        if (!root) { return; }
        root.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
        root.querySelectorAll('input[type="radio"]').forEach(function (r) {
            r.checked = (r.name === 'sort-web' && r.value === 'relevance');
        });
        syncActiveClasses();
        broadcast();
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
        if (q.get('max_min')) { check('input[data-filter="time-' + q.get('max_min') + '"]'); }
        if (q.get('price')) { check('input[data-filter="price-' + q.get('price') + '"]'); }
        if (q.get('veg') === '1') { check('input[data-filter="trust-pure-veg"]'); }
        if (q.get('offer') === '1') { check('input[data-filter="offer-discount"]'); }
        if (q.get('open_now') === '1') { check('input[data-filter="avail-open-now"]'); }
        if (q.get('max_km')) { check('input[data-filter="dist-' + q.get('max_km') + '"]'); }
        syncActiveClasses();
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
        if (!resolve()) { return; }

        root.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }
            if (t.closest('[data-action="filters-clear-all"]')) { ev.preventDefault(); clearAll(); return; }
            if (t.closest('[data-action="filters-apply"]'))     { ev.preventDefault(); broadcast(); return; }
        });

        // Any input change re-syncs the active classes (visual only;
        // the actual navigation happens on Apply).
        root.addEventListener('change', function (ev) {
            if (ev.target && ev.target.tagName === 'INPUT') { syncActiveClasses(); }
        });

        // Cuisine search live-filter.
        var search = root.querySelector('[data-fsb-cuisine-search]');
        if (search) {
            search.addEventListener('input', function (e) { filterCuisineList(e.target.value); });
        }
    }

    function init() {
        if (!resolve()) { return; }
        bind();
        restoreFromUrl();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
