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
            if (mode === 'group') { toast('info', 'Group ordering is coming soon.'); }
        });
    }

    /**
     * bindActions — +Add (cart stub) + Report a problem.
     */
    function bindActions() {
        document.addEventListener('click', function (ev) {
            var add = ev.target.closest && ev.target.closest('[data-action="rd-add"]');
            if (add) {
                ev.preventDefault();
                toast('success', (add.getAttribute('data-name') || 'Item') + ' — cart coming soon.');
                return;
            }
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
            var slug = card.getAttribute('data-slug');
            var rd   = document.querySelector('[data-restaurant]');
            var rslug = rd ? rd.getAttribute('data-rslug') : '';
            // Clean URL: /?rest=<restaurant>&item=<product> (no id).
            if (slug && rslug) { window.location.href = '/?rest=' + encodeURIComponent(rslug) + '&item=' + encodeURIComponent(slug); }
        });
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
