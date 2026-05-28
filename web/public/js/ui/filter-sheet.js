/*
 * ui/filter-sheet.js
 *
 * What:  Drives the mobile-only Filters bottom sheet at
 *        views/partials/filter-sheet.ejs. Responsibilities:
 *          • open / close the sheet (with backdrop click + Esc + the
 *            footer Close button).
 *          • switch the active tab in the left rail and reveal the
 *            matching pane on the right.
 *          • toggle .is-active on chips / radio rows so the user
 *            sees their selection. (Visual stub — the api wiring
 *            comes in the next iteration; the JS only collects the
 *            current state in an internal object for now.)
 *          • light up the "Show results" button when ≥ 1 filter is
 *            active so the user can tell the apply will actually
 *            do something.
 *
 *        Exposes window.EatNDealUi.filterSheet.{open, close} so other
 *        code paths (eg a future "Sort" chip in the desktop header)
 *        can reuse the same surface.
 *
 * Why:   The user supplied Swiggy screenshots and asked for exactly
 *        the same UX on mobile. The sheet has its own dialog
 *        semantics (aria-modal=true, focus trap, scroll lock) so it
 *        reads as a focused task.
 *
 * Used:  Loaded by views/_layout.ejs. The trigger button lives in
 *        views/partials/mobile-search.ejs (data-action="open-filters").
 */

(function () {
    'use strict';

    var sheet, panel, foot, body;
    var tabs = [];
    var panes = [];
    // Snapshot of current selections — fed back to /js/pages/home.js
    // when the user taps Show results. Visual stub only for now.
    var state = {
        sort:        'relevance',
        time:        null,
        rating:      null,
        offers:      [],
        price:       null,
        trust:       [],
        collections: [],
    };

    function resolve() {
        if (sheet) { return true; }
        sheet = document.getElementById('filter-sheet');
        if (!sheet) { return false; }
        panel  = sheet.querySelector('.filter-sheet__panel');
        foot   = sheet.querySelector('.filter-sheet__foot');
        tabs   = Array.prototype.slice.call(sheet.querySelectorAll('.filter-sheet__tab'));
        panes  = Array.prototype.slice.call(sheet.querySelectorAll('.filter-sheet__section'));
        body   = document.body;
        return true;
    }

    function open() {
        if (!resolve()) { return; }
        sheet.hidden = false;
        // Wait one frame so the transition kicks in (otherwise the
        // browser collapses display:none → display:flex + translate
        // into a single layout pass and the slide-up is lost).
        window.requestAnimationFrame(function () {
            sheet.setAttribute('aria-hidden', 'false');
            if (body) { body.classList.add('is-filter-sheet-open'); }
        });
    }

    function close() {
        if (!sheet) { return; }
        sheet.setAttribute('aria-hidden', 'true');
        if (body) { body.classList.remove('is-filter-sheet-open'); }
        // Wait for the transition to finish before re-hiding so the
        // slide-down animation plays cleanly.
        window.setTimeout(function () {
            if (sheet.getAttribute('aria-hidden') === 'true') {
                sheet.hidden = true;
            }
        }, 240);
    }

    /**
     * switchTab
     *
     * What:  Moves the .is-active class from the previously-active
     *        tab to the clicked one, then shows the matching pane in
     *        the right column and hides all others.
     */
    function switchTab(tabKey) {
        tabs.forEach(function (t) {
            t.classList.toggle('is-active', t.getAttribute('data-tab') === tabKey);
        });
        panes.forEach(function (p) {
            var match = p.getAttribute('data-pane') === tabKey;
            p.hidden = !match;
            p.classList.toggle('is-active', match);
        });
    }

    /**
     * countFilters
     *
     * What:  Returns the number of "active" picks across all categories.
     *        Used by refreshFootState to flip Show-results to brand red
     *        when ≥ 1 filter is active.
     */
    function countFilters() {
        var n = 0;
        if (state.sort && state.sort !== 'relevance') { n += 1; }
        if (state.time)   { n += 1; }
        if (state.rating) { n += 1; }
        if (state.price)  { n += 1; }
        n += state.offers.length;
        n += state.trust.length;
        n += state.collections.length;
        return n;
    }

    function refreshFootState() {
        if (!foot) { return; }
        foot.classList.toggle('has-filters', countFilters() > 0);
    }

    /**
     * Multi-select toggle: add/remove the filter id from the matching
     * state list and reflect on the chip.
     */
    function toggleMulti(listKey, chip) {
        var id = chip.getAttribute('data-filter');
        if (!id) { return; }
        var list = state[listKey];
        var idx  = list.indexOf(id);
        if (idx === -1) {
            list.push(id);
            chip.classList.add('is-active');
        } else {
            list.splice(idx, 1);
            chip.classList.remove('is-active');
        }
    }

    /**
     * Single-select toggle: only one chip in the group can be active.
     * Tapping the already-active chip clears the selection.
     */
    function toggleSingle(key, chip) {
        var id = chip.getAttribute('data-filter');
        if (!id) { return; }
        var group = chip.parentElement
            ? chip.parentElement.querySelectorAll('.filter-sheet__chip')
            : [];
        var already = state[key] === id;
        group.forEach(function (c) { c.classList.remove('is-active'); });
        if (already) {
            state[key] = null;
        } else {
            chip.classList.add('is-active');
            state[key] = id;
        }
    }

    function clearAll() {
        state.sort        = 'relevance';
        state.time        = null;
        state.rating      = null;
        state.offers      = [];
        state.price       = null;
        state.trust       = [];
        state.collections = [];
        // Reset DOM — chips off, sort radio back to Relevance.
        sheet.querySelectorAll('.filter-sheet__chip.is-active').forEach(function (c) {
            c.classList.remove('is-active');
        });
        sheet.querySelectorAll('.filter-sheet__radio-item').forEach(function (r) {
            r.classList.remove('is-active');
            var input = r.querySelector('input[type="radio"]');
            if (input && input.value === 'relevance') {
                input.checked = true;
                r.classList.add('is-active');
            } else if (input) {
                input.checked = false;
            }
        });
        refreshFootState();
    }

    /**
     * apply
     *
     * What:  Stub for the "Show results" button. Today it just closes
     *        the sheet. The next iteration will broadcast `state` as
     *        a CustomEvent that /js/pages/home.js listens for so it
     *        can rebuild the api query.
     */
    function apply() {
        // Fire an event so future listeners can pick the state up.
        try {
            document.dispatchEvent(new CustomEvent('eatndeal:filters-changed', {
                detail: JSON.parse(JSON.stringify(state)),
            }));
        } catch (e) { /* no-op */ }
        close();
    }

    /**
     * applyStateFromUrl
     *
     * What:  On page load, pre-fill the sheet from any filter
     *        params present on the URL (?sort, ?rating, etc).
     *        Mirrors filter-sidebar.js so the two surfaces stay in
     *        lockstep — pick a filter on web, refresh on mobile,
     *        same chips light up.
     */
    function applyStateFromUrl() {
        if (!sheet) { return; }
        var q = new URLSearchParams(window.location.search);

        var sort = q.get('sort');
        if (sort) {
            state.sort = sort;
            var radio = sheet.querySelector('input[name="sort"][value="' + sort + '"]');
            if (radio) {
                radio.checked = true;
                sheet.querySelectorAll('.filter-sheet__radio-item').forEach(function (r) { r.classList.remove('is-active'); });
                var row = radio.closest('.filter-sheet__radio-item');
                if (row) { row.classList.add('is-active'); }
            }
        }
        function activateSingle(key, prefix, value) {
            var id = prefix + value;
            var chip = sheet.querySelector('.filter-sheet__chip[data-filter="' + id + '"]');
            if (!chip) { return; }
            chip.classList.add('is-active');
            state[key] = id;
        }
        if (q.get('rating'))  { activateSingle('rating', 'rating-', q.get('rating')); }
        if (q.get('max_min')) { activateSingle('time',   'time-',   q.get('max_min')); }
        if (q.get('price'))   { activateSingle('price',  'price-',  q.get('price')); }
        function activateMulti(listKey, id) {
            var chip = sheet.querySelector('.filter-sheet__chip[data-filter="' + id + '"]');
            if (!chip) { return; }
            chip.classList.add('is-active');
            if (state[listKey].indexOf(id) === -1) { state[listKey].push(id); }
        }
        if (q.get('veg') === '1')         { activateMulti('trust',       'trust-pure-veg'); }
        if (q.get('offer') === '1')       { activateMulti('offers',      'offer-discount'); }
        if (q.get('open_now') === '1')    { activateMulti('collections', 'col-previously'); /* placeholder, sheet lacks Availability tab */ }
        if (q.get('recommended') === '1') { activateMulti('collections', 'col-previously'); }
        if (q.get('featured') === '1')    { activateMulti('collections', 'col-gourmet'); }
        refreshFootState();
    }

    function bind() {
        if (!resolve()) { return; }

        // Open trigger — any element carrying data-action="open-filters".
        // Delegated on document so triggers added by SPA swaps still work.
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }
            var trigger = t.closest('[data-action="open-filters"]');
            if (!trigger) { return; }
            ev.preventDefault();
            open();
        });

        // Inside-sheet interactions — single delegated listener.
        sheet.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            if (t.closest('[data-action="close-filters"]')) { ev.preventDefault(); close(); return; }
            if (t.closest('[data-action="filters-clear-all"]')) { ev.preventDefault(); clearAll(); return; }
            if (t.closest('[data-action="filters-apply"]'))     { ev.preventDefault(); apply();    return; }

            var tab = t.closest('.filter-sheet__tab');
            if (tab) {
                ev.preventDefault();
                switchTab(tab.getAttribute('data-tab'));
                return;
            }

            var chip = t.closest('.filter-sheet__chip');
            if (chip) {
                ev.preventDefault();
                // Which category does this chip belong to? The parent
                // <section data-pane="..."> tells us.
                var section = chip.closest('.filter-sheet__section');
                var pane    = section ? section.getAttribute('data-pane') : '';
                if (pane === 'time')        { toggleSingle('time',   chip); }
                else if (pane === 'rating') { toggleSingle('rating', chip); }
                else if (pane === 'price')  { toggleSingle('price',  chip); }
                else if (pane === 'offers') { toggleMulti('offers',  chip); }
                else if (pane === 'trust')  { toggleMulti('trust',   chip); }
                else if (pane === 'collections') { toggleMulti('collections', chip); }
                refreshFootState();
                return;
            }
        });

        // Sort By is a radio group rather than chips — listen on
        // change instead of click so keyboard navigation works too.
        sheet.addEventListener('change', function (ev) {
            var radio = ev.target;
            if (!radio || radio.name !== 'sort') { return; }
            state.sort = radio.value;
            // Visual sync — the row wrapper takes the .is-active class.
            sheet.querySelectorAll('.filter-sheet__radio-item').forEach(function (r) {
                r.classList.remove('is-active');
            });
            var row = radio.closest('.filter-sheet__radio-item');
            if (row) { row.classList.add('is-active'); }
            refreshFootState();
        });

        // Esc closes — only when the sheet is open.
        document.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Escape') { return; }
            if (sheet.getAttribute('aria-hidden') !== 'false') { return; }
            close();
        });
    }

    // Public surface.
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.filterSheet = { open: open, close: close };

    function init() {
        bind();
        applyStateFromUrl();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
