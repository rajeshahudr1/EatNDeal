/*
 * ui/search-overlay.js
 *
 * What:  Drives the Zomato-style search overlay (full-screen on
 *        mobile, centred card on desktop). Flow:
 *           1. User focuses ANY home-page search input
 *              ([data-search-scope="home"]).
 *           2. Overlay opens; the overlay's own input takes focus.
 *           3. Empty state shows: recent searches + a full category
 *              grid (fetched from /api/v1/marketplace/categories on
 *              first open, cached).
 *           4. As the user types (≥ 2 chars, debounced 220 ms) we
 *              call /api/v1/marketplace/search and render a vertical
 *              list of matching categories + dishes + restaurants.
 *           5. Tapping a category navigates to /?cuisine=<name>
 *              which triggers the home-page filter.
 *           6. Tapping a dish / restaurant navigates to its detail
 *              page. (Detail pages are placeholders today.)
 *           7. Recent searches are persisted in localStorage and
 *              shown on subsequent opens.
 *
 * Why:   The user explicitly asked for this UX based on the Zomato
 *        screenshots they shared — search as a dedicated surface
 *        rather than a tiny field at the top of the page.
 *
 * Used:  Loaded from views/_layout.ejs alongside the other ui/*.js.
 *        Markup mount: views/partials/search-overlay.ejs.
 */

(function () {
    'use strict';

    var RECENTS_KEY = 'eatndeal_recent_searches';
    var RECENTS_MAX = 6;
    var DEBOUNCE_MS = 220;

    // Cached refs (resolved on first open).
    var overlay, panel, overlayInput, clearBtn;
    var emptyEl, recentSection, recentList, gridEl, resultsEl, noMatchEl;
    // The page-side inputs we trigger from + mirror back to.
    var triggerInputs = [];
    var categoriesCache = null;
    var debounceTimer   = null;
    var requestSeq      = 0;

    /**
     * resolve
     *
     * What:  Look up all DOM refs once. Bails (returns false) when
     *        the overlay partial isn't on the page — typically means
     *        we're on a bare-layout auth page where chrome was
     *        intentionally skipped.
     */
    function resolve() {
        if (overlay) { return true; }
        overlay        = document.getElementById('search-overlay');
        if (!overlay) { return false; }
        panel          = overlay.querySelector('.search-overlay__panel');
        overlayInput   = document.getElementById('search-overlay-input');
        clearBtn       = overlay.querySelector('[data-action="clear-search"]');
        emptyEl        = document.getElementById('search-overlay-empty');
        recentSection  = document.getElementById('search-overlay-recent');
        recentList     = document.getElementById('search-overlay-recent-list');
        gridEl         = document.getElementById('search-overlay-grid');
        resultsEl      = document.getElementById('search-overlay-results');
        noMatchEl      = document.getElementById('search-overlay-nomatch');
        return true;
    }

    // ── Recent searches (localStorage) ─────────────────────────────

    function loadRecents() {
        try {
            var raw = window.localStorage.getItem(RECENTS_KEY);
            if (!raw) { return []; }
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.slice(0, RECENTS_MAX) : [];
        } catch (e) { return []; }
    }
    function saveRecents(list) {
        try {
            window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
        } catch (e) { /* quota / private-mode — ignore */ }
    }
    function rememberSearch(term) {
        var t = String(term || '').trim();
        if (t.length < 2) { return; }
        var list = loadRecents().filter(function (r) { return r.toLowerCase() !== t.toLowerCase(); });
        list.unshift(t);
        saveRecents(list);
    }

    // ── Render: recent chips ───────────────────────────────────────
    function renderRecents() {
        if (!recentList || !recentSection) { return; }
        var list = loadRecents();
        if (!list.length) {
            recentSection.hidden = true;
            return;
        }
        recentSection.hidden = false;
        // Clear + rebuild — list is at most 6 items so the cost is
        // negligible and the code stays simple.
        while (recentList.firstChild) { recentList.removeChild(recentList.firstChild); }
        list.forEach(function (term) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'search-overlay__recent-chip';
            chip.setAttribute('data-action', 'pick-recent');
            chip.setAttribute('data-term', term);
            chip.innerHTML =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<circle cx="12" cy="12" r="9"/>' +
                  '<polyline points="12 7 12 12 15 14"/>' +
                '</svg>';
            var label = document.createElement('span');
            label.textContent = term;
            chip.appendChild(label);
            recentList.appendChild(chip);
        });
    }

    // ── Render: categories grid ───────────────────────────────────

    async function ensureCategories() {
        if (categoriesCache) { return categoriesCache; }
        try {
            var data = await window.EatNDealApi.get('/api/v1/marketplace/categories?limit=50');
            categoriesCache = (data && data.categories) || [];
        } catch (e) {
            categoriesCache = [];
        }
        return categoriesCache;
    }

    function renderGrid(items) {
        if (!gridEl) { return; }
        while (gridEl.firstChild) { gridEl.removeChild(gridEl.firstChild); }
        items.forEach(function (c) {
            var tile = document.createElement('a');
            tile.className = 'search-overlay__tile';
            tile.href = '/?cuisine=' + encodeURIComponent(c.searchName || (c.name || '').toLowerCase());
            tile.setAttribute('data-action', 'pick-category');
            tile.setAttribute('data-name', c.name || '');
            tile.setAttribute('data-search-name', c.searchName || (c.name || '').toLowerCase());

            var imgWrap = document.createElement('span');
            imgWrap.className = 'search-overlay__tile-image';
            if (c.icon) {
                var img = document.createElement('img');
                img.src = c.icon;
                img.alt = '';
                img.loading = 'lazy';
                img.setAttribute('data-img-fallback', '');
                imgWrap.appendChild(img);
            }
            var initial = document.createElement('span');
            initial.className = 'search-overlay__tile-initial';
            initial.textContent = c.initial || '?';
            imgWrap.appendChild(initial);

            var name = document.createElement('span');
            name.className = 'search-overlay__tile-name';
            name.textContent = c.name || '';

            tile.appendChild(imgWrap);
            tile.appendChild(name);
            gridEl.appendChild(tile);
        });
    }

    // ── Render: search results list ───────────────────────────────

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch];
        });
    }
    function highlight(text, query) {
        var t = String(text || '');
        if (!query) { return escapeHtml(t); }
        var lower = t.toLowerCase();
        var i = lower.indexOf(query.toLowerCase());
        if (i === -1) { return escapeHtml(t); }
        return escapeHtml(t.slice(0, i)) +
               '<strong>' + escapeHtml(t.slice(i, i + query.length)) + '</strong>' +
               escapeHtml(t.slice(i + query.length));
    }
    function rowFor(opts) {
        var li = document.createElement('li');
        var a  = document.createElement('a');
        a.className = 'search-overlay__row';
        a.href = opts.href;
        a.setAttribute('data-action', opts.action);
        if (opts.dataName) { a.setAttribute('data-name', opts.dataName); }
        if (opts.dataSearchName) { a.setAttribute('data-search-name', opts.dataSearchName); }

        var imgWrap = document.createElement('span');
        imgWrap.className = 'search-overlay__row-image';
        if (opts.image) {
            var img = document.createElement('img');
            img.src = opts.image;
            img.alt = '';
            img.loading = 'lazy';
            img.setAttribute('data-img-fallback', '');
            imgWrap.appendChild(img);
        }
        var initial = document.createElement('span');
        initial.className = 'search-overlay__row-initial';
        initial.textContent = opts.initial || '?';
        imgWrap.appendChild(initial);

        var body = document.createElement('div');
        body.className = 'search-overlay__row-body';
        var name = document.createElement('p');
        name.className = 'search-overlay__row-name';
        name.innerHTML = highlight(opts.name, opts.query);
        body.appendChild(name);
        if (opts.sub) {
            var sub = document.createElement('p');
            sub.className = 'search-overlay__row-sub';
            sub.textContent = opts.sub;
            body.appendChild(sub);
        }

        a.appendChild(imgWrap);
        a.appendChild(body);
        if (opts.cta) {
            var cta = document.createElement('span');
            cta.className = 'search-overlay__row-cta';
            cta.textContent = opts.cta;
            cta.innerHTML += ' ›';
            a.appendChild(cta);
        }
        li.appendChild(a);
        return li;
    }

    function renderResults(payload, query) {
        if (!resultsEl) { return; }
        while (resultsEl.firstChild) { resultsEl.removeChild(resultsEl.firstChild); }
        var cats  = (payload && payload.categoryResults)   || [];
        var prods = (payload && payload.productResults)    || [];
        var rests = (payload && payload.restaurantResults) || [];

        cats.forEach(function (c) {
            resultsEl.appendChild(rowFor({
                action: 'pick-category',
                href:   '/?cuisine=' + encodeURIComponent(c.searchName || (c.name || '').toLowerCase()),
                dataName: c.name,
                dataSearchName: c.searchName,
                image:  c.icon,
                initial: c.initial,
                name:   c.name,
                sub:    null,
                cta:    'See all restaurants',
                query:  query,
            }));
        });
        prods.forEach(function (p) {
            // A dish goes to its own PRODUCT page (size / toppings / qty),
            // via the clean rest+item slug URL (no id).
            var pHref = (p.slug && p.restaurantSlug)
                ? ('/?rest=' + encodeURIComponent(p.restaurantSlug) + '&item=' + encodeURIComponent(p.slug))
                : ('/?product=' + encodeURIComponent(p.id));
            resultsEl.appendChild(rowFor({
                action: 'pick-result',
                href:   pHref,
                dataName: p.name,
                image:  p.image,
                initial: p.initial,
                name:   p.name,
                sub:    p.restaurant ? ('Dish · ' + p.restaurant) : 'Dish',
                query:  query,
            }));
        });
        rests.forEach(function (r) {
            // A restaurant goes to its detail page.
            resultsEl.appendChild(rowFor({
                action: 'pick-result',
                href:   '/?restaurant=' + encodeURIComponent(r.slug || ''),
                dataName: r.name,
                image:  r.image,
                initial: r.initial,
                name:   r.name,
                sub:    'Restaurant',
                query:  query,
            }));
        });

        var total = cats.length + prods.length + rests.length;
        resultsEl.hidden = total === 0;
        if (noMatchEl) { noMatchEl.hidden = total !== 0; }
        if (emptyEl)   { emptyEl.hidden   = true; }
    }

    // ── Search call ───────────────────────────────────────────────

    async function runSearch(q) {
        var token = ++requestSeq;
        if (!q || q.length < 2) {
            // Reset to empty state.
            if (resultsEl) { resultsEl.hidden = true; }
            if (noMatchEl) { noMatchEl.hidden = true; }
            if (emptyEl)   { emptyEl.hidden   = false; }
            return;
        }
        try {
            var url = '/api/v1/marketplace/search?q=' + encodeURIComponent(q);
            var data = await window.EatNDealApi.get(url);
            if (token !== requestSeq) { return; }
            renderResults(data || {}, q);
        } catch (err) {
            if (token !== requestSeq) { return; }
            if (resultsEl) { resultsEl.hidden = true; }
            if (noMatchEl) { noMatchEl.hidden = false; }
        }
    }

    // ── Open / close ──────────────────────────────────────────────

    async function open() {
        if (!resolve()) { return; }
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('is-search-open');
        // Desktop: pin the panel under the input. Mobile uses the
        // full-screen CSS layout instead.
        anchorDesktopPanel();
        renderRecents();
        // Render empty state immediately, fetch categories lazily.
        if (emptyEl)   { emptyEl.hidden   = false; }
        if (resultsEl) { resultsEl.hidden = true; }
        if (noMatchEl) { noMatchEl.hidden = true; }
        if (gridEl && !gridEl.children.length) {
            var cats = await ensureCategories();
            renderGrid(cats);
        }
        // Sync the overlay input with whatever the user typed in the
        // page input first, then focus it.
        var pageVal = '';
        for (var i = 0; i < triggerInputs.length; i++) {
            if (triggerInputs[i].value) { pageVal = triggerInputs[i].value; break; }
        }
        if (overlayInput) {
            overlayInput.value = pageVal;
            if (clearBtn) { clearBtn.hidden = !pageVal; }
            window.setTimeout(function () { overlayInput.focus(); }, 30);
            // Fire an "input" so the results refresh for the carried-
            // over query (e.g. user re-opens overlay mid-search).
            if (pageVal) { runSearch(pageVal.trim().toLowerCase()); }
        }
    }

    function close() {
        if (!overlay) { return; }
        // Mirror the overlay input back to all the page inputs so the
        // user sees what they searched for once the overlay shuts.
        // We dispatch a synthetic `input` event after each programmatic
        // assignment so listeners (e.g. home.js bindClearSearch, which
        // resets the home filter when the box is blanked) actually
        // see the change — JS-driven `.value =` doesn't fire `input`
        // natively.
        var v = overlayInput ? overlayInput.value : '';
        triggerInputs.forEach(function (inp) {
            if (inp.value !== v) {
                inp.value = v;
                try { inp.dispatchEvent(new Event('input', { bubbles: true })); }
                catch (e) { /* IE fallback — not supported */ }
            }
        });
        // Move focus out of the overlay before flipping aria-hidden
        // so Chrome doesn't complain.
        var active = document.activeElement;
        if (active && overlay.contains(active) && typeof active.blur === 'function') { active.blur(); }
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('is-search-open');
        window.setTimeout(function () {
            if (overlay.getAttribute('aria-hidden') === 'true') { overlay.hidden = true; }
        }, 160);
    }

    // ── Navigation handlers ───────────────────────────────────────

    /**
     * pickCategory
     *
     * What:  User clicked a category tile / row in the overlay. We:
     *          1. Remember the term in recent searches.
     *          2. Navigate to /?cuisine=<searchName>. Real navigation
     *             (not pushState) so a refresh / share / back-button
     *             all work without bespoke state restore.
     */
    function pickCategory(name, searchName) {
        var term = String(name || searchName || '').trim();
        if (term) { rememberSearch(term); }
        var slug = String(searchName || term || '').toLowerCase();
        // Navigate exactly like a direct pill tap: the full cuisine rail
        // stays, this category is marked active in place, and the feed
        // below filters to it. (No more narrowing the rail to one pill.)
        var nextUrl = '/?cuisine=' + encodeURIComponent(slug);
        window.location.assign(nextUrl);
    }

    function pickRecent(term) {
        if (overlayInput) {
            overlayInput.value = term;
            if (clearBtn) { clearBtn.hidden = !term; }
        }
        runSearch(term.trim().toLowerCase());
    }

    // ── Wire ──────────────────────────────────────────────────────

    function isDesktop() {
        return window.matchMedia('(min-width: 768px)').matches;
    }

    /**
     * anchorDesktopPanel
     *
     * What:  Pins the dropdown panel directly under the desktop
     *        header search input — same left edge, same width,
     *        starting 6 px below the input's bottom. Reads the
     *        input's bounding rect at runtime so it stays correct
     *        even if the header layout shifts (resize, theme
     *        change, logo swap, etc.).
     *
     *        On mobile this is a no-op — the overlay covers the
     *        whole screen and the CSS takes care of positioning.
     * Why:   The user wanted an autocomplete-style dropdown that
     *        sits flush under the input, not a centred floating card.
     *        CSS alone can't anchor to a sibling that lives in a
     *        different DOM subtree (the panel is rendered at body
     *        level, the input lives inside the header) — measuring +
     *        applying inline styles is the cleanest way.
     * Type:  WRITE (DOM style).
     */
    function anchorDesktopPanel() {
        if (!panel || !isDesktop()) { return; }
        var input = document.querySelector('.site-header__search') || triggerInputs[0];
        if (!input) { return; }
        var rect = input.getBoundingClientRect();
        // 6 px gap so the dropdown doesn't visually fuse with the
        // input's bottom border.
        panel.style.left  = rect.left + 'px';
        panel.style.top   = (rect.bottom + 6) + 'px';
        panel.style.width = rect.width + 'px';
        panel.style.maxWidth = 'none';
    }

    /**
     * onAnyInput
     *
     * What:  Single input handler used by BOTH the page-side trigger
     *        inputs (desktop header / mobile sticky bar) AND the
     *        overlay's own input on mobile. Mirrors the value across
     *        every input, then debounces a search.
     * Why:   On desktop the overlay head is hidden and the user types
     *        in the page header input directly; on mobile they type
     *        in the overlay input. Same code path means consistent
     *        debounce + mirroring no matter where the keystroke
     *        originated.
     */
    function onAnyInput(ev) {
        var v = ev.target.value || '';
        [overlayInput].concat(triggerInputs).forEach(function (inp) {
            if (inp && inp !== ev.target && inp.value !== v) { inp.value = v; }
        });
        if (clearBtn) { clearBtn.hidden = !v; }

        // Desktop dropdown is true autocomplete — show only when the
        // user has typed something meaningful. Closing on empty (or
        // < 2 chars) avoids an empty dropdown panel sitting open.
        var q = v.trim();
        var isOpen = overlay && overlay.getAttribute('aria-hidden') === 'false';
        if (isDesktop()) {
            if (q.length >= 2 && !isOpen)      { open(); }
            else if (q.length < 2 && isOpen)   { close(); }
        }

        if (debounceTimer) { window.clearTimeout(debounceTimer); }
        debounceTimer = window.setTimeout(function () {
            runSearch(q.toLowerCase());
        }, DEBOUNCE_MS);
    }

    function bind() {
        if (!resolve()) { return; }

        triggerInputs = Array.prototype.slice.call(
            document.querySelectorAll('[data-search-scope="home"]')
        );

        // Focus on a page-side search input opens the overlay ONLY on
        // mobile — there the overlay covers the whole screen with its
        // own input. On desktop the dropdown is true autocomplete:
        // we wait for the user to actually type something (≥ 2 chars)
        // before showing the panel — see onAnyInput.
        triggerInputs.forEach(function (inp) {
            inp.addEventListener('focus', function (ev) {
                if (isDesktop()) { return; }     // desktop: do nothing on focus
                if (overlay && overlay.getAttribute('aria-hidden') === 'false') { return; }
                ev.target.blur();                // release on-screen keyboard
                open();
            });
            inp.addEventListener('click', function () {
                if (isDesktop()) { return; }
                if (overlay && overlay.getAttribute('aria-hidden') === 'false') { return; }
                open();
            });
            // Typing drives the search on BOTH platforms. Desktop:
            // dropdown opens/closes based on query length here too.
            inp.addEventListener('input', onAnyInput);
        });

        // The "All" pill at the end of the cuisines row → open the
        // overlay with the categories grid view. Mobile-only (the
        // pill is hidden on desktop via CSS) but defensive about
        // isOpen so a stray click doesn't re-open.
        document.addEventListener('click', function (ev) {
            var trigger = ev.target.closest && ev.target.closest('[data-action="open-categories"]');
            if (!trigger) { return; }
            ev.preventDefault();
            if (overlay && overlay.getAttribute('aria-hidden') === 'false') { return; }
            open();
        });

        // Overlay input → debounced search (mobile path).
        if (overlayInput) {
            overlayInput.addEventListener('input', onAnyInput);
            // Enter — treat as a category-style pick on the typed term.
            overlayInput.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    var v = (overlayInput.value || '').trim();
                    if (v) { pickCategory(v, v); }
                }
                if (ev.key === 'Escape') { close(); }
            });
        }

        // Outside-click close (desktop dropdown). Mobile has its own
        // backdrop click handler inside the overlay. We listen on
        // document and check if the click landed inside the overlay
        // panel or on a trigger input — if neither, close.
        document.addEventListener('click', function (ev) {
            if (!overlay || overlay.getAttribute('aria-hidden') !== 'false') { return; }
            if (!isDesktop()) { return; }
            var t = ev.target;
            if (panel && panel.contains(t)) { return; }
            for (var i = 0; i < triggerInputs.length; i++) {
                if (triggerInputs[i].contains(t)) { return; }
            }
            close();
        });

        // Esc anywhere closes the dropdown / overlay.
        document.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Escape') { return; }
            if (!overlay || overlay.getAttribute('aria-hidden') !== 'false') { return; }
            close();
        });

        // Keep the desktop dropdown anchored to the input across
        // resize + page scroll. Passive listeners — never blocking
        // scroll behaviour.
        function reanchor() {
            if (overlay && overlay.getAttribute('aria-hidden') === 'false') { anchorDesktopPanel(); }
        }
        window.addEventListener('resize', reanchor);
        window.addEventListener('scroll', reanchor, { passive: true });

        // Delegated clicks inside the overlay.
        overlay.addEventListener('click', function (ev) {
            var t = ev.target;
            var closeBtn = t.closest && t.closest('[data-action="close-search"]');
            if (closeBtn) { ev.preventDefault(); close(); return; }
            var clearBtnEl = t.closest && t.closest('[data-action="clear-search"]');
            if (clearBtnEl) {
                ev.preventDefault();
                if (overlayInput) {
                    overlayInput.value = '';
                    if (clearBtn) { clearBtn.hidden = true; }
                    overlayInput.focus();
                    runSearch('');
                }
                return;
            }
            var clearRecents = t.closest && t.closest('[data-action="clear-recents"]');
            if (clearRecents) { ev.preventDefault(); saveRecents([]); renderRecents(); return; }
            var recentChip = t.closest && t.closest('[data-action="pick-recent"]');
            if (recentChip) { ev.preventDefault(); pickRecent(recentChip.getAttribute('data-term') || ''); return; }
            var catEl = t.closest && t.closest('[data-action="pick-category"]');
            if (catEl) {
                ev.preventDefault();
                pickCategory(catEl.getAttribute('data-name'), catEl.getAttribute('data-search-name'));
                return;
            }
            // pick-result rows (restaurant / product) → remember the
            // term, then let the browser follow the anchor href as a
            // normal navigation to the detail page.
            var resultEl = t.closest && t.closest('[data-action="pick-result"]');
            if (resultEl) { rememberSearch(resultEl.getAttribute('data-name') || ''); return; }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
