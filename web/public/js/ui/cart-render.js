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

        // Popups are swapped only when NONE is open. Replacing the DOM under
        // an open popup would destroy mounted Stripe Elements and whatever the
        // customer was typing. A closed popup is safe and needs the refresh —
        // it holds the promo list, address list and saved cards.
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

    window.CartRender = { swap: swap, begin: begin, isStale: isStale };
})();
