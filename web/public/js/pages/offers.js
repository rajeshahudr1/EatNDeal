/*
 * pages/offers.js
 *
 * What:  Drives the "Offers & Deals" page (views/site/offers.ejs):
 *          • Filter tabs (All / Restaurant / Product / Common) → show only
 *            the matching category group(s).
 *          • Search → live-filter cards by restaurant / dish / code.
 *          • Copy-code buttons → copy the promo code to the clipboard.
 *          • Tint painting + image fallback (home.js isn't loaded here).
 * Used:  Loaded via extra_js when SiteController.offersPage renders /offers.
 */

(function () {
    'use strict';

    var qa = (window.EatNDealDom && window.EatNDealDom.queryAll) || function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    var activeTab = 'all';

    function paintTints() {
        qa('[data-tint]').forEach(function (el) {
            var t = el.getAttribute('data-tint');
            if (t) { el.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.45), transparent 60%), ' + t; }
        });
    }
    function bindImageFallback() {
        document.addEventListener('error', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'IMG' && t.hasAttribute('data-img-fallback')) { t.style.display = 'none'; }
        }, true);
    }

    // Apply both the active tab + the current search term.
    function applyFilters() {
        var q = (document.querySelector('[data-offers-search]') || { value: '' }).value.trim().toLowerCase();
        var anyVisible = false;

        qa('[data-offers-group]').forEach(function (group) {
            var groupKind = group.getAttribute('data-offers-group');
            var tabOk = (activeTab === 'all' || activeTab === groupKind);
            var groupHasCard = false;

            qa('[data-offer-card]', group).forEach(function (card) {
                var hay = (card.getAttribute('data-search') || '').toLowerCase();
                var match = tabOk && (!q || hay.indexOf(q) !== -1);
                card.hidden = !match;
                if (match) { groupHasCard = true; anyVisible = true; }
            });
            // Hide a whole group when it has no visible cards (wrong tab or
            // nothing matches the search).
            group.hidden = !groupHasCard;
        });

        var empty = document.querySelector('[data-offers-empty]');
        if (empty) { empty.hidden = anyVisible; }
    }

    function bindTabs() {
        qa('[data-offers-tab]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                activeTab = btn.getAttribute('data-offers-tab') || 'all';
                qa('[data-offers-tab]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
                applyFilters();
            });
        });
    }

    function bindSearch() {
        var input = document.querySelector('[data-offers-search]');
        if (!input) { return; }
        var tm = null;
        input.addEventListener('input', function () {
            if (tm) { window.clearTimeout(tm); }
            tm = window.setTimeout(applyFilters, 120);
        });
    }

    function bindCopy() {
        document.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('[data-copy-code]');
            if (!btn) { return; }
            ev.preventDefault();
            var code = btn.getAttribute('data-copy-code') || '';
            var done = function () {
                btn.classList.add('is-copied');
                toast('success', 'Code "' + code + '" copied.');
                window.setTimeout(function () { btn.classList.remove('is-copied'); }, 1400);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(done).catch(function () { done(); });
            } else {
                done();
            }
        });
    }

    // Make the horizontal rails scrollable on desktop (mouse): vertical
    // wheel scrolls them sideways, and click-drag pans them. Touch already
    // swipe-scrolls. A thin scrollbar (CSS) is the visible affordance.
    function bindRailScroll() {
        qa('.offp2-rail').forEach(function (rail) {
            rail.addEventListener('wheel', function (ev) {
                if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) { return; }   // already horizontal
                if (rail.scrollWidth <= rail.clientWidth) { return; }          // nothing to scroll
                var atStart = rail.scrollLeft <= 0;
                var atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1;
                // Let the page scroll vertically when the rail can't go further.
                if ((ev.deltaY < 0 && atStart) || (ev.deltaY > 0 && atEnd)) { return; }
                rail.scrollLeft += ev.deltaY;
                ev.preventDefault();
            }, { passive: false });

            var down = false, startX = 0, startLeft = 0, moved = false;
            rail.addEventListener('pointerdown', function (ev) {
                if (ev.button !== 0) { return; }
                down = true; moved = false; startX = ev.clientX; startLeft = rail.scrollLeft;
            });
            rail.addEventListener('pointermove', function (ev) {
                if (!down) { return; }
                var dx = ev.clientX - startX;
                if (!moved && Math.abs(dx) > 5) { moved = true; rail.classList.add('is-grabbing'); }
                if (moved) { rail.scrollLeft = startLeft - dx; }
            });
            function end() { down = false; rail.classList.remove('is-grabbing'); }
            rail.addEventListener('pointerup', end);
            rail.addEventListener('pointerleave', end);
            // A drag shouldn't also fire a card's link click.
            rail.addEventListener('click', function (ev) {
                if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; }
            }, true);
        });
    }

    function onReady() {
        if (!document.querySelector('[data-offers-page]')) { return; }
        bindImageFallback();
        paintTints();
        bindTabs();
        bindSearch();
        bindCopy();
        bindRailScroll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
