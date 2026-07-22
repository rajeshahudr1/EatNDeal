/*
 * ui/cart-render.js
 *
 * What:  Swaps the cart page's two server-rendered regions after an AJAX
 *        action, and guards the two races that only show up on slow mobile
 *        connections.
 * Why:   Every cart action used to end in location.reload() — a full round
 *        trip plus a scroll jump. The regions come back rendered from the same
 *        EJS partials the page was built from, so swapping them is equivalent
 *        to the reload without the cost.
 * Load:  before ui/cart.js (which calls into it).
 */
(function () {
    'use strict';

    // Monotonic request counter. Every request takes a ticket; a response
    // holding an old ticket is discarded, so a slow earlier action can never
    // overwrite the result of a newer one.
    var seq = 0;

    /**
     * begin — take a ticket for a request about to be sent. Type: WRITE.
     */
    function begin() { seq += 1; return seq; }

    /**
     * isStale — has a newer request been issued since this ticket?
     * Type: READ (pure).
     */
    function isStale(ticket) { return ticket !== seq; }

    /**
     * captureState — the bits of UI state a re-render would otherwise lose:
     *   • which disclosure panels are open (basket summary)
     *   • which element had focus, and the caret position in a text field
     * Type: READ.
     */
    function captureState() {
        var open = [];
        var panels = document.querySelectorAll('[data-cart-region] details[open]');
        for (var i = 0; i < panels.length; i++) {
            open.push(panels[i].getAttribute('data-panel') || String(i));
        }
        var el = document.activeElement;
        var focus = null;
        if (el && el.closest && el.closest('[data-cart-region]')) {
            focus = {
                action: el.getAttribute('data-action') || '',
                name:   el.getAttribute('name') || '',
                start:  typeof el.selectionStart === 'number' ? el.selectionStart : null,
            };
        }
        return { open: open, focus: focus };
    }

    /**
     * restoreState — put back what captureState took. Type: WRITE (DOM).
     * Entire restore is best-effort — no path must throw into swap().
     */
    function restoreState(state) {
        if (!state) { return; }
        var panels = document.querySelectorAll('[data-cart-region] details');
        for (var i = 0; i < panels.length; i++) {
            var key = panels[i].getAttribute('data-panel') || String(i);
            if (state.open.indexOf(key) !== -1) { panels[i].open = true; }
        }
        var f = state.focus;
        if (!f) { return; }
        var sel = f.action ? '[data-action="' + f.action + '"]'
                : f.name   ? '[name="' + f.name + '"]' : '';
        if (!sel) { return; }
        try {
            var next = document.querySelector('[data-cart-region] ' + sel);
            if (!next) { return; }
            next.focus();
            if (f.start != null && typeof next.setSelectionRange === 'function') {
                next.setSelectionRange(f.start, f.start);
            }
        } catch (e) { /* entire restore is best-effort — selector may be malformed or element missing */ }
    }

    /**
     * swap — replace the regions with freshly rendered HTML.
     * Type: WRITE (DOM). Returns true when at least one region was replaced.
     */
    function swap(html) {
        if (!html) { return false; }
        var state = captureState();
        var did = false;
        ['main', 'side'].forEach(function (key) {
            if (typeof html[key] !== 'string' || !html[key]) { return; }
            var host = document.querySelector('[data-cart-region="' + key + '"]');
            if (!host) { return; }
            host.innerHTML = html[key];
            did = true;
        });

        // Keep the grid's layout in step with what was just swapped in. The
        // empty state renders full-width (single column); a filled cart is the
        // two-column grid. That modifier lives on '.cart-page__grid', a parent
        // OUTSIDE the swapped regions, so without this an emptied cart kept the
        // two-column layout and the empty card rendered in the narrow right
        // column — small before a reload, full-width after.
        if (did) {
            var grid = document.querySelector('.cart-page__grid');
            if (grid) {
                var nowEmpty = !!document.querySelector('[data-cart-region="side"] .cart-empty');
                grid.classList.toggle('cart-page__grid--empty', nowEmpty);
            }
        }

        // Popups are swapped only when NONE is open. Replacing the DOM under
        // an open popup would destroy mounted Stripe Elements and whatever the
        // customer was typing. A closed popup is safe and needs the refresh —
        // it holds the promo list, address list and saved cards.
        //
        // A CLOSED popup can still hold a MOUNTED (but hidden) Stripe Payment
        // Element from an earlier open/close — [data-stripe-mount] lives in
        // this region. Replacing the region's innerHTML then detaches that
        // node from the document while ui/cart.js still holds the mounted
        // element + its memoised init promise, so the next time the payment
        // popup opens, cart.js hands back the same (now-orphaned) promise
        // instead of re-mounting — the customer sees an empty card box and
        // can't pay. Tear it down first so the next open remounts fresh.
        // Guarded: cart-render.js loads before cart.js, and on a page with
        // no payment popup at all EatNDealCart never defines the hook.
        if (window.EatNDealCart && typeof window.EatNDealCart.teardownPaymentElementForSwap === 'function') {
            window.EatNDealCart.teardownPaymentElementForSwap();
        }
        if (typeof html.popups === 'string' && html.popups) {
            var host = document.querySelector('[data-cart-region="popups"]');
            var anyOpen = !!document.querySelector('.ckt-popup:not([hidden]), [data-ckt-popup]:not([hidden])');
            if (host && !anyOpen) { host.innerHTML = html.popups; }
        }
        if (did) {
            restoreState(state);
            // Anything listening for cart changes (badge, sticky CTA) re-reads
            // the DOM here rather than each caller remembering to poke it.
            document.dispatchEvent(new CustomEvent('eatndeal:cart-updated'));
        }
        return did;
    }

    /**
     * updateHeaderLocation
     *
     * What:  Rewrites the header's location chip to match the cart's delivery
     *        address. The chip lives OUTSIDE the swapped cart regions, so
     *        picking an address in the cart updated the session + cart + order
     *        but left the visible header showing the OLD location — which read
     *        as "which address is this order actually going to?".
     *        Mirrors the title/sub split in views/partials/header.ejs so the
     *        live update matches what a reload would render.
     * Type:  WRITE (DOM).
     */
    function updateHeaderLocation(cart) {
        if (!cart || Number(cart.serveType) !== 3) { return; }   // delivery only
        var label    = cart.deliveryLabel || cart.deliveryAddress || '';
        var postcode = cart.deliveryPostcode || '';
        if (!label && !postcode) { return; }
        var parts = label.split(',').map(function (s) { return s.replace(/^\s+|\s+$/g, ''); })
                         .filter(function (s) { return !!s; });
        var title = parts[0] || label || postcode;
        var sub   = parts.slice(1).join(', ');
        if (!sub && postcode) { sub = postcode; }
        var nameEl = document.querySelector('.site-header__location-name');
        var subEl  = document.querySelector('.site-header__location-sub');
        if (nameEl && title) { nameEl.textContent = title; }
        if (subEl) { subEl.textContent = sub; }
    }

    window.CartRender = { swap: swap, begin: begin, isStale: isStale, updateHeaderLocation: updateHeaderLocation };
})();
