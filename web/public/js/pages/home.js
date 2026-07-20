/*
 * pages/home.js
 *
 * What:  Per-page bindings for the landing page. Currently:
 *          • Apply each restaurant-card's data-tint attribute as the
 *            background colour of its placeholder image — done in JS
 *            (not inline style) to keep the strict CSP rule of no
 *            inline-style attributes from the server template.
 *          • SPA-style cuisine pill clicks (no full reload).
 *          • Pagination: desktop "See more" button + mobile auto-load
 *            on scroll. Fetches the next batch from the api and
 *            appends cards to the existing grid.
 *          • Clear-search auto-clear: when the user blanks out the
 *            header search input while on a filtered URL
 *            (/?cuisine=…), navigate back to the unfiltered home.
 * Why:   Each card carries a unique tint to give the static
 *        placeholder feed visual variety. Keeping the styles external
 *        complies with Coding-Conventions rule #6.
 * Used:  Loaded by views/_layout.ejs only on the landing page (via
 *        SiteController passing extra_js: '/js/pages/home.js').
 *
 * Change log:
 *   2026-05-25 — initial. Adds the tint-applier.
 *   2026-05-27 — adds pagination (See more + auto-load) and the
 *                clear-search auto-navigate behaviour.
 */

(function () {
    'use strict';

    /**
     * applyCardTints
     *
     * What:  Walks every element carrying data-tint and copies the
     *        colour onto element.style.background as a soft gradient.
     *        Used by BOTH the restaurant placeholder cards
     *        (.restaurant-card__image--placeholder) AND the "For you"
     *        dish cards (.dish-card__image) — both render a square
     *        coloured block when no real photo is available.
     * Why:   We can't write inline style="background:#…" on the EJS
     *        template (CSP blocks inline styles). Setting the property
     *        in JS at runtime is allowed and gives us per-card colour
     *        variation without N specific CSS rules.
     * Type:  WRITE (DOM style).
     * Inputs: root — optional element to scope the walk to. Used when
     *         we've just appended freshly-rendered cards so we only
     *         touch the new nodes (cheaper + idempotent).
     * Output: void.
     * Used:   Called on DOMContentLoaded and after every load-more
     *         append.
     */
    function applyCardTints(root) {
        var scope = root || document;
        var nodes = scope.querySelectorAll(
            '.restaurant-card__image--placeholder[data-tint], ' +
            '.dish-card__image[data-tint], ' +
            '.cuisine-pill__icon--placeholder[data-tint]'
        );
        nodes.forEach(function (el) {
            var tint = el.getAttribute('data-tint');
            if (!tint) { return; }
            // Layer a soft diagonal highlight on top of the brand tint
            // so each card has a subtle gradient without losing the
            // per-card colour cue.
            el.style.background =
                'linear-gradient(135deg, rgba(255, 255, 255, 0.45), transparent 60%), ' + tint;
        });
    }

    /**
     * bindImageFallback
     *
     * What:  Document-level listener (capture phase) that hides any
     *        <img data-img-fallback> that fails to load. The placeholder
     *        sitting behind it (tinted bg + initial letter on
     *        restaurant / dish / cuisine surfaces) then shows through
     *        with zero layout shift.
     * Why:   The Yii admin stores image URLs as bare filenames (no
     *        public-path prefix yet). Without this fallback every
     *        product / restaurant / category image would render as a
     *        broken-image icon while we wait for the media-serving
     *        story to land. Capture phase is REQUIRED — the `error`
     *        event on <img> doesn't bubble.
     * Type:  WRITE (DOM style).
     */
    function bindImageFallback() {
        document.addEventListener('error', function (ev) {
            var t = ev.target;
            if (!t || t.tagName !== 'IMG') { return; }
            if (!t.hasAttribute('data-img-fallback')) { return; }
            // Defensive — only kill the broken one; don't touch the
            // placeholder DOM around it. visibility:hidden would still
            // leave the alt text visible if the browser decided to
            // show it, so display:none is the right call.
            t.style.display = 'none';
        }, true);
    }

    /**
     * markActiveCuisineFromUrl
     *
     * What:  Reads `?cuisine=<name>` from the current URL and (a)
     *        adds the `.is-active-filter` class to the matching
     *        cuisine pill so the underline indicator renders, and
     *        (b) scrolls the cuisine row so the active pill is fully
     *        in view.
     *
     *        The server already reorders the cuisine row to put the
     *        selected pill at position 0 + fetches the filtered
     *        products + restaurants for that cuisine, so the page is
     *        rendered correctly without any client filter logic
     *        running. This function is pure presentation polish.
     *
     * Why:   Zomato-style: when the user clicks a cuisine, the page
     *        re-renders with that cuisine featured. The active state
     *        is visual — the cards themselves are already filtered.
     * Type:  WRITE (DOM class + scrollIntoView).
     */
    /**
     * syncSidebarCuisine
     *
     * What:  Reflects the active cuisine onto the sidebar's Cuisines
     *        checklist — ticks the box whose key matches, unticks every
     *        other (and clears all when cuisine is empty). Keeps the
     *        sidebar state authoritative + in step with the rail so
     *        Apply behaves predictably (re-applies a checked cuisine,
     *        drops an unchecked one).
     * Type:  WRITE (DOM checked state + .is-active row class).
     */
    function syncSidebarCuisine(cuisine) {
        var target = String(cuisine || '').trim().toLowerCase();
        document.querySelectorAll('.fsb input[data-filter^="cuisine-"]').forEach(function (box) {
            var key = (box.getAttribute('data-filter') || '').replace(/^cuisine-/, '').toLowerCase();
            box.checked = !!target && key === target;
            var row = box.closest('.fsb__check, .fsb__radio');
            if (row) { row.classList.toggle('is-active', box.checked); }
        });
    }

    function markActiveCuisineFromUrl() {
        var params  = new URLSearchParams(window.location.search);
        var cuisine = (params.get('cuisine') || '').trim();

        // The search box stays EMPTY on a cuisine filter — picking a pill
        // is not a search, and pre-filling the box made it look like the
        // user had typed. The active pill + sidebar checkbox already show
        // what's filtered. We still blank the box so a stale term from a
        // previous search doesn't linger.
        document.querySelectorAll('[data-search-scope="home"]').forEach(function (inp) {
            inp.value = '';
        });

        // Keep the sidebar's Cuisines checklist in sync with the active
        // cuisine — tick the matching box, untick the rest (and clear
        // all when the filter is removed). Without this the sidebar
        // checkbox drifts out of step with a rail-selected cuisine, so
        // applying another filter would wrongly drop the cuisine.
        syncSidebarCuisine(cuisine);

        if (!cuisine) {
            // Filter cleared — drop any lingering active ring so no pill
            // stays highlighted once the feed returns to unfiltered.
            // (Matters for the feed-only partial swap, where the rail
            // DOM is NOT replaced and would otherwise keep the old mark.)
            document.querySelectorAll(
                '.cuisine-rail__item.is-active-filter, .cuisine-row__item.is-active-filter, .cuisine-grid__item.is-active-filter'
            ).forEach(function (li) { li.classList.remove('is-active-filter'); });
            return;
        }

        var target = cuisine.toLowerCase();
        var active = null;
        document.querySelectorAll('.cuisine-rail__item, .cuisine-row__item, .cuisine-grid__item').forEach(function (li) {
            var name = (li.getAttribute('data-search-name') || '').toLowerCase();
            // Match by exact key OR substring — same fuzziness the
            // server's reorderCuisinesByPick uses, so the pill we
            // mark always lines up with the one the server pushed to
            // position 0.
            var match = name && (name === target || name.indexOf(target) !== -1);
            li.classList.toggle('is-active-filter', match);
            // Only highlight the EXACT match (the one the server
            // moved to index 0). Variants further down stay
            // un-underlined — they're "you can also try" pills.
            if (name !== target) { li.classList.remove('is-active-filter'); }
            else if (!active)    { active = li; }
        });

        // Deliberately DO NOT move the rail. The selected pill must
        // stay in its own position — a middle category gets the active
        // ring right where it sits, and only the restaurant list below
        // reloads. (An earlier version scrolled the active pill to the
        // rail's left edge, which yanked middle categories to the front
        // and parked them under the prev-arrow — both wrong.)
        void active;
    }

    /**
     * spaNavigate
     *
     * What:   Generic in-page swap to ANY URL on this origin. Fetches
     *         the target, parses its HTML, replaces #app-main with the
     *         new body, and pushState's the URL. Powers every same-page
     *         flow the home page exposes: cuisine pills, View all,
     *         restaurant card picks, Back-to-home, and the popstate
     *         handler for browser back/forward.
     *
     * Why:    "ek hi page pe sare akama hoga" — every filter / view
     *         switch happens without a full page reload. Header,
     *         footer, drawer, search overlay all stay intact.
     *
     * Type:   READ (network) + WRITE (DOM).
     *
     * Inputs:
     *   url — string. Path + query, e.g. '/?view=restaurants'.
     *         Empty / '/' lands on the default home.
     *   opts.fromPopstate — true when called by the popstate handler;
     *                       skips the pushState so we don't loop.
     *   opts.label        — loader label to show during the fetch.
     */
    async function spaNavigate(url, opts) {
        opts = opts || {};
        var target = String(url || '/').trim() || '/';

        // Remember where the user is so an in-place filter (cuisine
        // tap) can restore it after the swap — they should stay put
        // while only the restaurant list below them reloads.
        var prevScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;

        if (!opts.fromPopstate) {
            try { window.history.pushState({}, '', target); }
            catch (e) { /* very old browsers — degrade gracefully */ window.location.href = target; return; }
        }

        // The full-screen loader is for full-page swaps. A feed-only
        // filter must NOT dim the whole screen — that dim/undim IS the
        // flicker. Instead it shows a loader SCOPED to the feed region:
        // the rail + filters above stay still, and the restaurant list
        // dims with a spinner while the next batch loads.
        var showGlobalLoader = !opts.feedOnly;
        var feedLoadingEl    = null;
        if (opts.feedOnly) {
            feedLoadingEl = document.querySelector('[data-home-feed]');
            if (feedLoadingEl) { feedLoadingEl.classList.add('is-loading'); }
        }
        if (showGlobalLoader && window.EatNDealUi && window.EatNDealUi.showLoader) {
            window.EatNDealUi.showLoader({ label: opts.label || 'Loading…' });
        }
        try {
            var res  = await fetch(target, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } });
            var html = await res.text();
            var doc  = new DOMParser().parseFromString(html, 'text/html');

            // Swap the entire <main> content — every section in the
            // body lives inside #app-main. Header / footer / drawer /
            // overlays sit outside, so they stay untouched.
            var oldMain = document.getElementById('app-main');
            var newMain = doc.getElementById('app-main');

            // ── Feed-only swap (in-place cuisine filter) ───────────
            // Replace ONLY the restaurant feed region. The header,
            // cuisine rail and filter sidebar above it are never
            // touched — nothing above the feed flickers, the rail keeps
            // its horizontal position, and the active pill is re-marked
            // in place. This is the no-flicker path the user asked for
            // ("uper wala section vesa hi rehna chahiye, niche ka hi
            // load ho").
            var didPartial = false;
            if (opts.feedOnly && oldMain && newMain) {
                var oldFeed = oldMain.querySelector('[data-home-feed]');
                var newFeed = newMain.querySelector('[data-home-feed]');
                if (oldFeed && newFeed) {
                    oldFeed.innerHTML = newFeed.innerHTML;
                    // Rail + filters keep their existing (delegated /
                    // direct) listeners since their DOM survived. We
                    // only re-mark the active pill on the untouched
                    // rail, tint the new cards, and rebind the new
                    // feed's load-more trigger.
                    markActiveCuisineFromUrl();
                    applyCardTints(oldFeed);
                    bindPagination();
                    didPartial = true;
                }
            }

            if (!didPartial) {
                // ── Full swap (view-all / restaurant / back-home, or a
                //    fallback when the feed region wasn't found) ──────
                // Preserve the cuisine rail's horizontal scroll across
                // the swap — the fresh rail markup starts at scrollLeft
                // 0, which would otherwise snap a 2nd-page selection
                // back to the first pill.
                var oldRail  = oldMain ? oldMain.querySelector('[data-rail]') : null;
                var railLeft = oldRail ? oldRail.scrollLeft : 0;

                if (oldMain && newMain) {
                    oldMain.innerHTML = newMain.innerHTML;
                }

                if (railLeft) {
                    var newRail = document.querySelector('[data-rail]');
                    if (newRail) {
                        // behavior:'auto' overrides the rail's CSS
                        // scroll-behavior:smooth so it lands instantly.
                        if (newRail.scrollTo) { newRail.scrollTo({ left: railLeft, behavior: 'auto' }); }
                        else { newRail.scrollLeft = railLeft; }
                    }
                }

                // Re-run per-page bindings on the freshly-painted DOM.
                applyCardTints();
                markActiveCuisineFromUrl();
                bindPagination();
                bindFilterToggle();
                bindRailArrows();
            }

            // Scroll handling:
            //   • keepScroll (cuisine filter) → restore the exact
            //     position so the rail stays put and only the
            //     restaurant list below visibly reloads. The browser
            //     clamps automatically when the filtered (shorter)
            //     feed can't reach the old offset.
            //   • otherwise (view-all / restaurant / back-home) →
            //     jump to the top so the new surface reads from start.
            if (opts.keepScroll) {
                window.scrollTo({ top: prevScrollY });
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        } catch (err) {
            // Fall back to a real navigation so the user is never
            // stranded with stale content.
            window.location.href = target;
        } finally {
            // Drop the feed spinner. The class sits on the feed element
            // itself (not its innerHTML), so it survived the swap and we
            // clear it here once the new cards are in place.
            if (feedLoadingEl) { feedLoadingEl.classList.remove('is-loading'); }
            if (showGlobalLoader && window.EatNDealUi && window.EatNDealUi.hideLoader) {
                window.EatNDealUi.hideLoader();
            }
        }
    }

    /**
     * navigateToCuisine
     *
     * What:   Thin wrapper around spaNavigate for cuisine-pill picks.
     *         Empty / null cuisine returns to the unfiltered home.
     * Why:    Keeps the cuisine call sites concise — they pass the
     *         cuisine name, not the full URL.
     */
    function navigateToCuisine(cuisine, opts) {
        var target = String(cuisine || '').trim();
        var url    = target ? ('/?cuisine=' + encodeURIComponent(target.toLowerCase())) : '/';
        // keepScroll: don't yank the user to the top.
        // feedOnly: swap ONLY the restaurant list, leaving the rail +
        // filters + header untouched — no flicker, no rail reset.
        return spaNavigate(url, Object.assign({ label: target ? 'Filtering…' : 'Loading…', keepScroll: true, feedOnly: true }, opts || {}));
    }

    /**
     * bindCuisinePicks
     *
     * What:   Document-level delegated click handler that intercepts
     *         any cuisine pill click and routes through
     *         navigateToCuisine. Excludes:
     *           • The "All" pill (opens the search overlay instead).
     *           • Modifier-click / middle-click / ctrl-click so power
     *             users can still open in a new tab.
     */
    function bindCuisinePicks() {
        document.addEventListener('click', function (ev) {
            // Skip when the user is asking for a new tab / window.
            if (ev.defaultPrevented || ev.button !== 0) { return; }
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return; }

            var a = ev.target.closest && ev.target.closest('a[data-action="pick-cuisine"]');
            if (!a) { return; }
            ev.preventDefault();

            // Resolve the picked cuisine. Prefer the ?cuisine= already
            // baked into the link's href — EVERY pick-cuisine link
            // carries it: the top rail pills (.cuisine-rail__item), the
            // full-grid pills (.cuisine-grid__item) AND the dark
            // popular-cuisine cards (no <li> wrapper at all). Reading
            // the href is the one path that covers all three; the
            // dataset fallback only kicks in for a malformed href.
            var cuisine = '';
            try {
                var hrefUrl = new URL(a.getAttribute('href') || '', window.location.origin);
                cuisine = (hrefUrl.searchParams.get('cuisine') || '').trim();
            } catch (e) { /* malformed href — fall through to dataset */ }
            if (!cuisine) {
                var li = a.closest('.cuisine-rail__item, .cuisine-row__item, .cuisine-grid__item');
                cuisine = li ? (li.getAttribute('data-search-name') || '') : '';
            }
            // Tapping the already-active pill clears the filter.
            var current = new URLSearchParams(window.location.search).get('cuisine') || '';
            if (cuisine && cuisine.toLowerCase() === current.trim().toLowerCase()) {
                navigateToCuisine('');
            } else {
                navigateToCuisine(cuisine);
            }
        });

        // Back / forward button → re-fetch the previous state's URL.
        // We hand the full URL to spaNavigate (rather than reading
        // cuisine only) so view-mode pages also rebuild on back/forward.
        window.addEventListener('popstate', function (ev) {
            spaNavigate(window.location.pathname + window.location.search, { fromPopstate: true });
        });
    }

    /**
     * bindViewNavigation
     *
     * What:  Document-level delegated click handler for the
     *        non-cuisine SPA links:
     *          • [data-action="view-all"]        — section-head links
     *                                              (/?view=restaurants
     *                                               or /?view=cuisines)
     *          • [data-action="pick-restaurant"] — restaurant cards
     *                                              (/?restaurant=<slug>)
     *          • [data-action="view-home"]       — back-to-home links
     *                                              inside the view-mode
     *                                              bar (/)
     *        All three need exactly the same swap behaviour as the
     *        cuisine pills; this handler just routes the href to
     *        spaNavigate.
     */
    function bindViewNavigation() {
        document.addEventListener('click', function (ev) {
            if (ev.defaultPrevented || ev.button !== 0) { return; }
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return; }

            var a = ev.target.closest && ev.target.closest(
                'a[data-action="view-all"], a[data-action="pick-restaurant"], a[data-action="view-home"]'
            );
            if (!a) { return; }
            var href = a.getAttribute('href') || '/';
            // Skip pure-fragment or off-origin links — let the
            // browser handle those normally.
            if (href.charAt(0) === '#' || /^[a-z]+:/i.test(href)) { return; }
            // Restaurant pages are a DIFFERENT layout with their own
            // script + styles (restaurant.js / restaurant-detail.css).
            // An SPA swap would inject the markup without loading those,
            // so the page would render unstyled + inert. Let the browser
            // do a full navigation (don't preventDefault) so its assets
            // load.
            if (a.getAttribute('data-action') === 'pick-restaurant') { return; }
            ev.preventDefault();
            spaNavigate(href);
        });
    }

    // ── Pagination ────────────────────────────────────────────────
    //
    // Each paginated section in views/site/index.ejs carries:
    //   • <section data-paginate-section="featured|for-you">
    //   • <ul    data-load-target>                              (grid)
    //   • <div   data-load-more="…" data-offset="N">            (trigger)
    //
    // Desktop: user clicks the "See more" button → fetchPage().
    // Mobile:  IntersectionObserver fires when the trigger scrolls
    //          into view → fetchPage() with the same arguments.

    /**
     * escHtml
     *
     * What:  Escapes the four critical HTML chars (& < > "). Used by
     *        the card template strings below so a malicious restaurant
     *        / product name can't inject markup into the page.
     */
    var escHtml = (window.EatNDealFormat && window.EatNDealFormat.esc) || function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch];
        });
    };

    /**
     * vegMarkerHtml
     *
     * What:  Shared veg / non-veg dot used on both restaurant + dish
     *        cards. Shape mirrors the EJS template so the appended
     *        cards look identical to the server-rendered ones.
     */
    function vegMarkerHtml(vegType) {
        if (vegType === 'pure-veg' || vegType === true) {
            return '<span class="veg-marker veg-marker--veg" aria-label="Vegetarian" title="Vegetarian"></span>';
        }
        if (vegType === 'non-veg' || vegType === false) {
            return '<span class="veg-marker veg-marker--non-veg" aria-label="Non-vegetarian" title="Non-vegetarian"></span>';
        }
        return '';
    }

    /**
     * restaurantCardHtml
     *
     * What:  Builds the <li> markup for one restaurant card. Mirrors
     *        the EJS in views/site/index.ejs — keep both in sync if
     *        the card shape changes. Distance is shown when present;
     *        offer + closed-overlay are conditional.
     */
    function restaurantCardHtml(r) {
        var photo = r.image
            ? '<img class="restaurant-card__photo" src="' + escHtml(r.image) + '" alt="" loading="lazy" data-img-fallback>'
            : '';
        var veg = '';
        if (r.vegType === 'pure-veg') {
            veg = '<span class="veg-marker veg-marker--veg restaurant-card__veg" aria-label="Pure vegetarian" title="Pure vegetarian"></span>';
        } else if (r.vegType === 'non-veg') {
            veg = '<span class="veg-marker veg-marker--non-veg restaurant-card__veg" aria-label="Non-vegetarian" title="Non-vegetarian"></span>';
        }
        var offer   = r.offer  ? '<span class="restaurant-card__badge">' + escHtml(r.offer) + '</span>' : '';
        var closed  = r.isOpen ? '' : '<span class="restaurant-card__closed-overlay">Closed</span>';
        var time    = r.deliveryMinutes ? '<span class="restaurant-card__time">' + escHtml(r.deliveryMinutes) + '</span>' : '';
        var dist    = (typeof r.distanceKm === 'number' && r.distanceKm >= 0)
            ? ('<span class="restaurant-card__distance" aria-label="' + r.distanceKm + ' kilometres away">' +
                 '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
                   '<path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z"/>' +
                   '<circle cx="12" cy="9" r="2.5"/>' +
                 '</svg> ' + r.distanceKm.toFixed(1) + ' km' +
               '</span>')
            : '';
        var cuisines = (r.cuisines || []).map(escHtml).join(' · ');

        return '' +
            '<li data-search-id="' + escHtml(r.id) + '">' +
              '<a class="restaurant-card' + (r.isOpen ? '' : ' is-closed') + '" href="/?restaurant=' + encodeURIComponent(r.slug || r.id) + '" data-action="pick-restaurant">' +
                '<div class="restaurant-card__image restaurant-card__image--placeholder" data-tint="' + escHtml(r.tint) + '">' +
                  '<span class="restaurant-card__initial" aria-hidden="true">' + escHtml(r.initial) + '</span>' +
                  photo + veg + offer + closed +
                '</div>' +
                '<div class="restaurant-card__body">' +
                  '<h3 class="restaurant-card__name">' + escHtml(r.name) + '</h3>' +
                  '<p  class="restaurant-card__cuisines">' + cuisines + '</p>' +
                  '<div class="restaurant-card__meta">' +
                    (r.rating ? ('<span class="restaurant-card__rating" aria-label="Rating ' + escHtml(r.rating) + ' out of 5">' +
                      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> ' +
                      escHtml(r.rating) +
                    '</span>') : '') + time + dist +
                  '</div>' +
                '</div>' +
              '</a>' +
            '</li>';
    }

    /**
     * dishCardHtml
     *
     * What:  Builds the <li> markup for one "For you" dish card. Same
     *        shape as the EJS template; uses the global brand currency
     *        symbol from window.boot.
     */
    function dishCardHtml(d) {
        var symbol = (window.boot && window.boot.currencySymbol) || '£';
        var photo  = d.image
            ? '<img class="dish-card__photo" src="' + escHtml(d.image) + '" alt="" loading="lazy" data-img-fallback>'
            : '';
        var time   = d.deliveryMinutes ? '<span class="dish-card__time">' + escHtml(d.deliveryMinutes) + '</span>' : '';
        var price  = (typeof d.priceFrom === 'number' ? d.priceFrom : 0).toFixed(2);

        return '' +
            '<li data-search-id="' + escHtml(d.id) + '">' +
              '<a class="dish-card" href="/?restaurant=' + encodeURIComponent(d.restaurantSlug) + '" data-action="pick-restaurant">' +
                '<div class="dish-card__image" data-tint="' + escHtml(d.tint) + '">' +
                  '<span class="dish-card__initial" aria-hidden="true">' + escHtml(d.initial) + '</span>' +
                  photo + vegMarkerHtml(d.veg) +
                '</div>' +
                '<div class="dish-card__body">' +
                  '<h3 class="dish-card__name">' + escHtml(d.name) + '</h3>' +
                  '<p  class="dish-card__from">From ' + escHtml(d.restaurant) + '</p>' +
                  '<div class="dish-card__meta">' +
                    (d.rating ? ('<span class="dish-card__rating" aria-label="Rating ' + escHtml(d.rating) + ' out of 5">' +
                      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> ' +
                      escHtml(d.rating) +
                    '</span>') : '') + time +
                  '</div>' +
                  '<p  class="dish-card__price">' + escHtml(symbol) + price + '</p>' +
                '</div>' +
              '</a>' +
            '</li>';
    }

    /**
     * fetchPage
     *
     * What:  Calls the relevant api endpoint with the current offset +
     *        cuisine filter, appends the returned rows to the section's
     *        grid, advances the offset attribute, and removes the
     *        trigger once the api signals there are no more rows.
     *
     * Type:  READ (network) + WRITE (DOM).
     *
     * Inputs:
     *   trigger — the <div data-load-more="…" data-offset="N"> element.
     *
     * Output: Promise<void>. Resolved when DOM updates are done.
     */
    async function fetchPage(trigger) {
        if (!trigger || trigger.dataset.loading === '1') { return; }
        var section = trigger.getAttribute('data-load-more');         // "featured" | "for-you"
        var offset  = Number(trigger.getAttribute('data-offset')) || 0;
        var target  = trigger.parentElement
                        ? trigger.parentElement.querySelector('[data-load-target]')
                        : null;
        if (!section || !target) { return; }
        trigger.dataset.loading = '1';
        trigger.classList.add('is-loading');

        // Default page sizes match the server defaults (24 for
        // restaurants, 12 for products).
        var pageSize = section === 'featured' ? 24 : 12;
        var endpoint = section === 'featured'
            ? '/api/v1/marketplace/restaurants'
            : '/api/v1/marketplace/products';

        // Pull current filter state from the URL — keeps the second
        // page consistent with whatever the user is filtered to.
        var params  = new URLSearchParams(window.location.search);
        var cuisine = (params.get('cuisine') || '').trim().toLowerCase();

        var qs = new URLSearchParams();
        qs.set('limit',  String(pageSize));
        qs.set('offset', String(offset));
        if (cuisine) { qs.set('cuisine', cuisine); }
        if (window.boot && Number.isFinite(window.boot.lat)) { qs.set('lat', String(window.boot.lat)); }
        if (window.boot && Number.isFinite(window.boot.lng)) { qs.set('lng', String(window.boot.lng)); }

        try {
            var data = await window.EatNDealApi.get(endpoint + '?' + qs.toString());
            var rows = section === 'featured'
                ? (data && data.restaurants) || []
                : (data && data.products)    || [];
            var more = !!(data && data.has_more);

            // Append the new cards via a fragment so we only touch the
            // DOM once.
            if (rows.length) {
                var html = rows.map(section === 'featured' ? restaurantCardHtml : dishCardHtml).join('');
                var tmp  = document.createElement('div');
                tmp.innerHTML = html;
                var frag = document.createDocumentFragment();
                while (tmp.firstChild) { frag.appendChild(tmp.firstChild); }
                target.appendChild(frag);
                applyCardTints(target);
            }

            if (more) {
                trigger.setAttribute('data-offset', String(offset + rows.length));
            } else {
                // No more rows → remove the trigger. The "View all"
                // link in the section head also becomes meaningless,
                // hide it for parity.
                var head = trigger.parentElement && trigger.parentElement.querySelector('.section__link');
                if (head) { head.hidden = true; }
                trigger.remove();
            }
        } catch (err) {
            // Soft-fail: leave the trigger in place so the user can
            // retry. Toast surfaces the error if the helper is on.
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('error', 'Could not load more — try again.');
            }
        } finally {
            trigger.classList.remove('is-loading');
            trigger.dataset.loading = '';
        }
    }

    // Single shared IntersectionObserver for the mobile auto-load.
    // We re-create it on every bindPagination() (DOMContentLoaded +
    // post-SPA-swap) and disconnect the previous one so we never end
    // up with two observers firing on the same trigger.
    var paginationObserver = null;

    /**
     * bindPagination
     *
     * What:  Wires the desktop click + mobile auto-load for each
     *        `[data-load-more]` trigger currently in the DOM. Safe to
     *        call repeatedly; we disconnect the previous observer and
     *        attach delegated listeners only once (idempotent via a
     *        flag on document).
     */
    function bindPagination() {
        // Desktop click — delegated once. The flag guards against
        // double-binding after navigateToCuisine re-runs us.
        if (!document.__paginationClickBound) {
            document.addEventListener('click', function (ev) {
                var t = ev.target;
                if (!t || !t.closest) { return; }
                var btn = t.closest('.section__loadmore-btn');
                if (!btn) { return; }
                var trigger = btn.closest('[data-load-more]');
                if (!trigger) { return; }
                ev.preventDefault();
                fetchPage(trigger);
            });
            document.__paginationClickBound = true;
        }

        // Mobile auto-load via IntersectionObserver. Disconnect any
        // previous one first so triggers from a stale swap aren't
        // observed any more.
        if (paginationObserver) {
            try { paginationObserver.disconnect(); } catch (e) { /* noop */ }
            paginationObserver = null;
        }
        // No IntersectionObserver (very old browser) → the hidden
        // .section__loadmore-btn stays accessible as a fallback so
        // power users can still tab to it and press Enter. Modern
        // browsers (>= 99 % global) hit the IO path below.
        if (typeof window.IntersectionObserver !== 'function') { return; }

        paginationObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                fetchPage(entry.target);
            });
        }, {
            // Trigger ~200 px before the wrapper actually enters the
            // viewport so the next batch is already on the page by
            // the time the user reaches the last card. Better than
            // waiting until it's fully visible.
            rootMargin: '0px 0px 200px 0px',
            threshold:  0,
        });

        document.querySelectorAll('[data-load-more]').forEach(function (el) {
            paginationObserver.observe(el);
        });
    }

    /**
     * bindClearSearch
     *
     * What:   When the user blanks out a home-scope search input
     *         (`[data-search-scope="home"]`) AND the current URL has
     *         an active `?cuisine=` filter, jump back to "/" so the
     *         feed re-opens to the full unfiltered home. Mirrors how
     *         the cuisine row + page were filtered IN — clearing the
     *         field is the natural inverse.
     *
     * Why:    The user typed: "agr me select kre, select ke bad upper
     *         search box me value clear kr rhai to auto change hoge
     *         value" — clearing the search input on the home filtered
     *         page should auto-reset the page to the unfiltered view.
     *
     * Type:   READ (URL) + WRITE (location / DOM via navigateToCuisine).
     */
    function bindClearSearch() {
        document.addEventListener('input', function (ev) {
            var t = ev.target;
            if (!t || !t.getAttribute) { return; }
            if (t.getAttribute('data-search-scope') !== 'home') { return; }
            var value = (t.value || '').trim();
            if (value !== '') { return; }
            // Only act when there's actually a filter to clear —
            // calling navigateToCuisine('') on an already-blank URL
            // would just trigger an extra fetch.
            var current = new URLSearchParams(window.location.search).get('cuisine') || '';
            if (!current.trim()) { return; }
            navigateToCuisine('');
        });
    }

    /**
     * filtersToQuery
     *
     * What:  Translates a filter state object (the shape the sidebar
     *        and bottom-sheet build) into the URL query parameters
     *        SiteController + the api expect.
     *
     *        State shape (subset, only the entries we forward):
     *          { sort, rating, time, distance, price,
     *            trust:[], offers:[], availability:[], collections:[] }
     *
     *        Mapping:
     *          sort                            → ?sort=
     *          rating ('rating-3.5')           → ?rating=3.5
     *          time   ('time-30')              → ?max_min=30
     *          distance ('dist-5')             → ?max_km=5
     *          price ('price-low')             → ?price=low
     *          trust ['trust-pure-veg']        → ?veg=1
     *          offers contains 'offer-discount'→ ?offer=1
     *          availability contains 'avail-open-now' → ?open_now=1
     *          collections contains 'col-recommended' → ?recommended=1
     *          collections contains 'col-featured'    → ?featured=1
     * Why:   Single source of truth for the state→URL mapping so the
     *        sidebar (web) and sheet (mobile) stay in lockstep.
     */
    function filtersToQuery(state) {
        state = state || {};
        var qs = new URLSearchParams();
        // Cuisine picked from the sidebar's Cuisines checklist (the
        // first ticked one wins — the api filters by a single category).
        if (state.cuisine) { qs.set('cuisine', String(state.cuisine).toLowerCase()); }
        if (state.sort && state.sort !== 'relevance') { qs.set('sort', state.sort); }
        if (state.rating) {
            var num = parseFloat(String(state.rating).replace(/^rating-/, ''));
            if (isFinite(num) && num > 0) { qs.set('rating', String(num)); }
        }
        // Delivery-time bands — union of selected buckets → ?delivery=
        // (e.g. "15,30"). The api keeps a restaurant if its estimate
        // falls in ANY of them.
        if (state.deliveryBuckets && state.deliveryBuckets.length) {
            var keys = state.deliveryBuckets.filter(function (k) { return /^(15|30|45|60)$/.test(k); });
            if (keys.length) { qs.set('delivery', keys.join(',')); }
        } else if (state.time) {
            // Back-compat: a single time-NN value (older callers).
            var mins = parseInt(String(state.time).replace(/^time-/, ''), 10);
            if (isFinite(mins) && mins > 0) { qs.set('max_min', String(mins)); }
        }
        if (state.distance) {
            var km = parseInt(String(state.distance).replace(/^dist-/, ''), 10);
            if (isFinite(km) && km > 0) { qs.set('max_km', String(km)); }
        }
        if (state.price) {
            var bucket = String(state.price).replace(/^price-/, '');
            if (bucket === 'low' || bucket === 'mid' || bucket === 'high') {
                qs.set('price', bucket);
            }
        }
        var trust = state.trust || [];
        if (trust.indexOf('trust-pure-veg') !== -1) { qs.set('veg', '1'); }
        var offers = state.offers || [];
        if (offers.indexOf('offer-discount') !== -1 || offers.indexOf('offer-bogo') !== -1) {
            qs.set('offer', '1');
        }
        var avail = state.availability || [];
        if (avail.indexOf('avail-open-now') !== -1) { qs.set('open_now', '1'); }
        var cols = state.collections || [];
        if (cols.indexOf('col-recommended') !== -1) { qs.set('recommended', '1'); }
        if (cols.indexOf('col-featured')    !== -1) { qs.set('featured',    '1'); }
        // Browse (Collections & offers) — narrows the home to one curated set.
        if (state.browse) {
            var bkey = String(state.browse).replace(/^browse-/, '');
            if (bkey) { qs.set('browse', bkey); }
        }
        return qs;
    }

    /**
     * bindFilterEvents
     *
     * What:  Listens for the `eatndeal:filters-changed` CustomEvent
     *        the filter sidebar + bottom sheet dispatch when the user
     *        taps Show results. Builds the URL from the state +
     *        preserves the existing cuisine/restaurant/view params,
     *        then SPA-navigates to it. SiteController re-reads the
     *        URL on the next render and forwards the filters into
     *        the api call.
     */
    function bindFilterEvents() {
        document.addEventListener('eatndeal:filters-changed', function (ev) {
            var detail = ev.detail || {};
            // Preserve the existing non-filter params from the URL
            // (cuisine / view / restaurant / from) so applying a
            // filter on /?cuisine=burger doesn't strip the cuisine.
            var current = new URLSearchParams(window.location.search);
            // view / restaurant / from are non-filter context — always
            // preserve them. Cuisine is handled specially below because
            // the sidebar OWNS it: unchecking the cuisine must remove it.
            var keep    = ['view', 'restaurant', 'from'];
            var next    = filtersToQuery(detail);
            keep.forEach(function (k) {
                if (next.has(k)) { return; }
                var v = current.get(k);
                if (v) { next.set(k, v); }
            });
            // ── Cuisine ────────────────────────────────────────────
            // The sidebar's Cuisines checklist is authoritative: if a
            // box is ticked, filtersToQuery already put it in `next`. If
            // NOT, only fall back to the URL's cuisine when it ISN'T
            // representable as a sidebar checkbox (a rail-only cuisine
            // beyond the sidebar's short list). When it IS representable,
            // an empty state means the user UNCHECKED it → drop it. This
            // is what lets "uncheck + Apply" actually clear the cuisine.
            if (!next.has('cuisine')) {
                var urlCuisine = current.get('cuisine');
                if (urlCuisine) {
                    var representable = false;
                    document.querySelectorAll('.fsb input[data-filter^="cuisine-"]').forEach(function (box) {
                        var key = (box.getAttribute('data-filter') || '').replace(/^cuisine-/, '').toLowerCase();
                        if (key === String(urlCuisine).toLowerCase()) { representable = true; }
                    });
                    if (!representable) { next.set('cuisine', urlCuisine); }
                }
            }
            var url = '/' + (next.toString() ? '?' + next.toString() : '');
            // feedOnly + keepScroll: reload ONLY the restaurant list,
            // leaving the sidebar (and its checked state + listeners)
            // intact. A full swap would replace the sidebar DOM and the
            // filters would die after the first Apply.
            spaNavigate(url, { label: 'Applying filters…', keepScroll: true, feedOnly: true });
        });
    }

    // localStorage key for the collapsed preference — shared by the
    // initial paint + the delegated click handler.
    var FILTERS_KEY = 'eatndeal_filters_collapsed';

    /**
     * applyFilterCollapsed
     *
     * What:   Reflects the saved collapsed preference onto the current
     *         .home-shell (called on load + after every SPA swap so the
     *         freshly-painted shell starts in the right state).
     */
    function applyFilterCollapsed() {
        var shell = document.querySelector('.home-shell');
        if (!shell) { return; }
        var collapsed = false;
        try { collapsed = window.localStorage.getItem(FILTERS_KEY) === '1'; } catch (e) { /* ignore */ }
        shell.classList.toggle('is-filters-collapsed', collapsed);
    }

    /**
     * bindFilterToggle
     *
     * What:   Document-delegated handler for BOTH toggle controls —
     *         the chevron inside the sidebar header (hide) and the
     *         compact "Filters" pill in the content (show). Either
     *         flips .is-filters-collapsed on .home-shell and persists
     *         the choice. Bound once (guarded) since it's delegated.
     */
    function isDesktopFilters() {
        return window.matchMedia && window.matchMedia('(min-width: 1024px)').matches;
    }

    function bindFilterToggle() {
        applyFilterCollapsed();
        if (document.__filterToggleBound) { return; }
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            // Mobile: the search-row Filters button opens the sidebar
            // as a full-screen overlay.
            if (t.closest('[data-action="open-filters"]')) {
                ev.preventDefault();
                document.body.classList.add('is-mobile-filters-open');
                return;
            }

            // The hide chevron (sidebar header) / "Filters" pill.
            if (t.closest('[data-action="toggle-filters"]')) {
                ev.preventDefault();
                if (!isDesktopFilters()) {
                    // Mobile → just close the overlay.
                    document.body.classList.remove('is-mobile-filters-open');
                    return;
                }
                var shell = document.querySelector('.home-shell');
                if (!shell) { return; }
                var collapsed = !shell.classList.contains('is-filters-collapsed');
                shell.classList.toggle('is-filters-collapsed', collapsed);
                try { window.localStorage.setItem(FILTERS_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
                window.dispatchEvent(new Event('resize'));
                return;
            }

            // Mobile: Apply Filters closes the overlay too (after the
            // filter-sidebar.js broadcast navigates the page).
            if (!isDesktopFilters() && t.closest('[data-action="filters-apply"]')) {
                document.body.classList.remove('is-mobile-filters-open');
            }
        });
        document.__filterToggleBound = true;
    }

    /**
     * bindRailArrows
     *
     * What:   Wires the prev/next arrows on every [data-rail-wrap] so
     *         clicking them scrolls the inner [data-rail] horizontally
     *         by ~80% of its visible width. Hides an arrow when the
     *         rail is at that end. Re-checks on scroll + resize.
     */
    function bindRailArrows() {
        document.querySelectorAll('[data-rail-wrap]').forEach(function (wrap) {
            var rail = wrap.querySelector('[data-rail]');
            var prev = wrap.querySelector('[data-rail-prev]');
            var next = wrap.querySelector('[data-rail-next]');
            if (!rail) { return; }

            // Header arrows (in .hv2-head__nav) stay VISIBLE on desktop and just
            // DISABLE at the ends (Uber-Eats style); floating arrows (the cuisine
            // rail, direct children of .rail-wrap) HIDE when there's nothing to do.
            function setEnd(btn, off) {
                if (!btn) { return; }
                if (btn.closest('.hv2-head__nav')) { btn.disabled = off; }
                else { btn.hidden = off; }
            }
            function refresh() {
                var hasOverflow = rail.scrollWidth - rail.clientWidth > 4;
                var maxScroll   = rail.scrollWidth - rail.clientWidth - 2;
                setEnd(prev, !hasOverflow || rail.scrollLeft <= 2);
                setEnd(next, !hasOverflow || rail.scrollLeft >= maxScroll);
            }
            function nudge(dir) {
                var amount = Math.max(200, Math.round(rail.clientWidth * 0.8)) * dir;
                rail.scrollBy({ left: amount, behavior: 'smooth' });
            }
            if (prev) { prev.addEventListener('click', function () { nudge(-1); }); }
            if (next) { next.addEventListener('click', function () { nudge(1); }); }
            rail.addEventListener('scroll', refresh, { passive: true });
            window.addEventListener('resize', refresh);
            // Run now + after layout settles (images/fonts can change
            // the rail's scrollWidth a beat later).
            refresh();
            window.setTimeout(refresh, 250);
        });
    }

    // Scan-to-download QR popup — open from the QR badge, close on X / backdrop / Esc.
    function bindAppQr() {
        var modal = document.querySelector('[data-app-qr]');
        if (!modal) { return; }
        function open()  { modal.hidden = false; document.body.classList.add('appqr-open'); }
        function close() { modal.hidden = true;  document.body.classList.remove('appqr-open'); }
        document.addEventListener('click', function (e) {
            if (!e.target.closest) { return; }
            if (e.target.closest('[data-action="open-app-qr"]'))  { open();  return; }
            if (e.target.closest('[data-action="close-app-qr"]')) { close(); }
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) { close(); } });
    }

    /**
     * bindOfferAutoScroll
     *
     * What:   Auto-advances ONLY the "Offers for you" banner carousel
     *         (.offer-banner-row) every ~2.5s, looping back to the start at
     *         the end. Runs only when the rail actually OVERFLOWS (i.e. there
     *         are more offers than fit on screen — otherwise there's nothing
     *         to cycle, e.g. 0-1 cards or a wide desktop showing them all).
     * Why:    User request — cycle multiple promos automatically so the 2nd/3rd
     *         offer is seen without manual swiping.
     * UX:     Pauses while the pointer is over the rail / the user is touching
     *         it (autoplay must never fight a manual scroll), skips when the tab
     *         is hidden, and honours prefers-reduced-motion.
     */
    function bindOfferAutoScroll() {
        var section = document.querySelector('.offer-banner-row');
        var rail    = section && section.querySelector('[data-rail]');
        if (!rail) { return; }
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }

        var paused = false;
        section.addEventListener('mouseenter', function () { paused = true;  });
        section.addEventListener('mouseleave', function () { paused = false; });
        section.addEventListener('touchstart', function () { paused = true;  }, { passive: true });
        // Resume a few seconds after the finger lifts so a manual swipe settles.
        section.addEventListener('touchend', function () {
            window.setTimeout(function () { paused = false; }, 4000);
        }, { passive: true });

        window.setInterval(function () {
            if (paused || document.hidden) { return; }
            var maxScroll = rail.scrollWidth - rail.clientWidth;
            if (maxScroll <= 4) { return; }   // nothing hidden → nothing to cycle
            if (rail.scrollLeft >= maxScroll - 4) {
                rail.scrollTo({ left: 0, behavior: 'smooth' });          // loop to first
            } else {
                var step = Math.max(200, Math.round(rail.clientWidth * 0.8));
                rail.scrollBy({ left: step, behavior: 'smooth' });       // next page
            }
        }, 2500);
    }

    function onReady() {
        applyCardTints();
        bindImageFallback();
        markActiveCuisineFromUrl();
        bindCuisinePicks();
        bindViewNavigation();
        bindPagination();
        bindClearSearch();
        bindFilterEvents();
        bindFilterToggle();
        bindRailArrows();
        bindAppQr();
        bindOfferAutoScroll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
