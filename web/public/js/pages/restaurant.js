/*
 * pages/restaurant.js
 *
 * What:  Per-page bindings for the single-restaurant page:
 *          • Left-menu jump-links → smooth-scroll to the category
 *            section, with a scroll-spy that highlights the section the
 *            user is currently viewing.
 *          • Delivery / Pickup / Group Order tabs (visual toggle; Group
 *            surfaces a "coming soon" toast).
 *          • +Add and "Report a problem" → toast (cart + reporting
 *            backends aren't built yet).
 *          • Image-fallback + tint painting (home.js isn't loaded here).
 * Used:  Loaded only on the restaurant view (SiteController extra_js).
 */

(function () {
    'use strict';

    function qa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
    function toast(type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } }

    function applyTints(scope) {
        qa('[data-tint]', scope || document).forEach(function (el) {
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

    function setActive(id) {
        qa('[data-rd-jump]').forEach(function (a) {
            a.classList.toggle('is-active', a.getAttribute('data-rd-jump') === id);
        });
    }

    /**
     * bindMenuJump — left-menu link → smooth-scroll to its section.
     */
    function bindMenuJump() {
        document.addEventListener('click', function (ev) {
            var a = ev.target.closest && ev.target.closest('[data-rd-jump]');
            if (!a) { return; }
            ev.preventDefault();
            var id  = a.getAttribute('data-rd-jump');
            var sec = document.getElementById('sec-' + id);
            if (sec) {
                sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setActive(id);
            }
        });
    }

    /**
     * bindScrollSpy — highlight the menu item for the section currently
     * at the top of the viewport as the user scrolls the menu.
     */
    function bindScrollSpy() {
        var sections = qa('[data-rd-section]');
        if (!sections.length || typeof window.IntersectionObserver !== 'function') { return; }
        var io = new IntersectionObserver(function (entries) {
            var visible = entries
                .filter(function (e) { return e.isIntersecting; })
                .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
            if (visible[0]) { setActive(visible[0].target.getAttribute('data-rd-section')); }
        }, { rootMargin: '-96px 0px -60% 0px', threshold: 0 });
        sections.forEach(function (s) { io.observe(s); });
    }

    /**
     * bindTabs — Delivery / Pickup / Group Order visual toggle.
     */
    function bindTabs() {
        document.addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('[data-rd-tab]');
            if (!t) { return; }
            var mode = t.getAttribute('data-rd-tab');
            qa('[data-rd-tab]').forEach(function (x) {
                var on = x === t;
                x.classList.toggle('is-active', on);
                x.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            // Swap the detail panel (delivery vs pickup).
            qa('[data-rd-panel]').forEach(function (p) {
                p.hidden = p.getAttribute('data-rd-panel') !== mode;
            });
            if (mode === 'group') { toast('info', 'Group ordering is coming soon.'); }
        });
    }

    /**
     * bindActions — "Report a problem" stub. The +Add button is wired up
     * globally in /js/ui/cart.js (data-action="rd-add") so every page
     * with a quick-add card shares the same cart flow + branch-conflict
     * dialog + count animation.
     */
    function bindActions() {
        document.addEventListener('click', function (ev) {
            var rep = ev.target.closest && ev.target.closest('[data-action="rd-report"]');
            if (rep) {
                ev.preventDefault();
                toast('info', 'Thanks — reporting is coming soon.');
            }
        });
    }

    /**
     * bindProductClick — tapping a menu product (anywhere except the
     * +Add / action buttons) opens its product detail page. Full
     * navigation so the product page loads its own assets.
     */
    function bindProductClick() {
        document.addEventListener('click', function (ev) {
            if (ev.defaultPrevented || ev.button !== 0) { return; }
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return; }
            // Action buttons (Add, etc.) keep their own behaviour.
            if (ev.target.closest && ev.target.closest('[data-action]')) { return; }
            var card = ev.target.closest && ev.target.closest('.rd-product[data-slug]');
            if (!card) { return; }
            var slug  = card.getAttribute('data-slug');
            var pid   = card.getAttribute('data-id');
            var rd    = document.querySelector('[data-restaurant]');
            var rslug = rd ? rd.getAttribute('data-rslug') : '';
            // In-app navigation opens the product modal instead of a
            // full page navigation — keeps the customer's restaurant
            // scroll position + matches the PWA pattern. Fallback to
            // the standalone page route when the modal module isn't
            // loaded (e.g. an old service-worker shell).
            var pm = window.EatNDealUi && window.EatNDealUi.productModal;
            if (pm && typeof pm.open === 'function' && (pid || (slug && rslug))) {
                ev.preventDefault();
                pm.open({ rest: rslug, item: slug, id: pid });
                return;
            }
            if (slug && rslug) { window.location.href = '/?rest=' + encodeURIComponent(rslug) + '&item=' + encodeURIComponent(slug); }
        });
    }

    /**
     * applyDeepLink — when arriving from search:
     *   ?menu=<category-slug>   → open + highlight that menu section
     *   ?highlight=<product-slug> → scroll to + flash that dish at the top
     */
    function applyDeepLink() {
        var params = new URLSearchParams(window.location.search);
        var menuSlug = (params.get('menu') || '').toLowerCase();
        var hlSlug   = (params.get('highlight') || '').toLowerCase();
        if (!menuSlug && !hlSlug) { return; }

        window.setTimeout(function () {
            if (menuSlug) {
                var sec = qa('[data-rd-section]').filter(function (s) { return (s.getAttribute('data-section-slug') || '').toLowerCase() === menuSlug; })[0];
                if (sec) { setActive(sec.getAttribute('data-rd-section')); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
            }
            if (hlSlug) {
                var card = qa('.rd-product[data-slug]').filter(function (c) { return (c.getAttribute('data-slug') || '').toLowerCase() === hlSlug; })[0];
                if (card) {
                    var sec2 = card.closest('[data-rd-section]');
                    if (sec2) { setActive(sec2.getAttribute('data-rd-section')); }
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.classList.add('is-highlight');
                    window.setTimeout(function () { card.classList.remove('is-highlight'); }, 2400);
                }
            }
        }, 220);
    }

    function onReady() {
        if (!document.querySelector('[data-restaurant]')) { return; }
        bindImageFallback();
        applyTints();
        bindMenuJump();
        bindScrollSpy();
        bindTabs();
        bindActions();
        bindProductClick();
        applyDeepLink();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
