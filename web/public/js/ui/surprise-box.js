/*
 * ui/surprise-box.js
 *
 * What:  The restaurant page's Surprise Box ("Too Good To Go") popup —
 *        open/close, the quantity stepper, and Add to Cart.
 *
 * Why:   The box used to be a read-only strip: it showed a price and a slot
 *        count with no way to actually buy it, while the legacy site has both
 *        a "View & Add to Cart" button and this detail popup.
 *
 * Global + self-guarding: loaded on every page (like the other /js/ui modules)
 * and returns immediately when the page has no #sb-modal, so it costs nothing
 * elsewhere. No inline JS (project convention).
 *
 * The server is the authority: it re-checks pickup-only, the collection window
 * and the remaining slots on every add (Controllers/Customer/CartController
 * addSurpriseBox), so the stepper's max here is UX, never the guard — the count
 * can be stale by the time the customer presses Add.
 */
(function () {
    'use strict';

    var modal = document.getElementById('sb-modal');
    if (!modal) { return; }                      // not the restaurant page

    var form = modal.querySelector('[data-sb-form]');
    if (!form) { return; }

    var D     = window.EatNDealDom || {};
    var toast = D.showToastSafe || function (t, m) {
        if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(t, m); }
    };

    var qtyEl   = form.querySelector('[data-sb-qty]');
    var totalEl = form.querySelector('[data-sb-total]');
    var addBtn  = form.querySelector('[data-sb-add]');

    var unit = Number(form.getAttribute('data-unit')) || 0;
    var max  = Math.max(1, Number(form.getAttribute('data-max')) || 1);
    var qty  = 1;

    // The £ symbol is whatever the server already rendered into the button —
    // read it back rather than hardcoding, so a currency change needs no JS edit.
    var sym = (totalEl && (totalEl.textContent || '').trim().charAt(0)) || '£';

    function money(n) { return sym + (Number(n) || 0).toFixed(2); }

    function sync() {
        if (qtyEl)   { qtyEl.textContent = String(qty); }
        if (totalEl) { totalEl.textContent = money(unit * qty); }
        var dec = form.querySelector('[data-sb-dec]');
        var inc = form.querySelector('[data-sb-inc]');
        if (dec) { dec.disabled = qty <= 1; }
        if (inc) { inc.disabled = qty >= max; }
    }

    function open()  { modal.hidden = false; document.body.style.overflow = 'hidden'; }
    function close() { modal.hidden = true;  document.body.style.overflow = ''; }

    document.addEventListener('click', function (e) {
        if (e.target.closest('[data-sb-open]'))  { e.preventDefault(); qty = 1; sync(); open(); return; }
        if (e.target.closest('[data-sb-close]')) { e.preventDefault(); close(); return; }
        if (e.target === modal) { close(); return; }      // backdrop
        if (e.target.closest('[data-sb-dec]')) { e.preventDefault(); if (qty > 1)   { qty--; sync(); } return; }
        if (e.target.closest('[data-sb-inc]')) { e.preventDefault(); if (qty < max) { qty++; sync(); } return; }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.hidden) { close(); }
    });

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (addBtn) { addBtn.disabled = true; }

        fetch('/cart/surprise-box', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', Accept: 'application/json' },
            body:        JSON.stringify({ company_id: form.getAttribute('data-company'), qty: qty }),
        })
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .then(function (env) {
                if (addBtn) { addBtn.disabled = false; }
                if (env && env.status === 200) {
                    close();
                    toast('success', env.msg || 'Surprise Box added to your cart.');
                    if (window.EatNDealCart && window.EatNDealCart.refreshCartBadge) {
                        window.EatNDealCart.refreshCartBadge();
                    }
                    // The server returns what's ACTUALLY left after this add —
                    // repaint the count so a second customer on the same page
                    // isn't offered slots that just went.
                    if (env.data && env.data.remaining != null) {
                        max = Math.max(1, Number(env.data.remaining));
                        var left = document.querySelector('.rd-surprise__left');
                        if (left) { left.textContent = env.data.remaining + ' left'; }
                        var slots = modal.querySelector('.sb-modal__slots');
                        if (slots) { slots.textContent = env.data.remaining + ' slot' + (Number(env.data.remaining) === 1 ? '' : 's') + ' left'; }
                    }
                    return;
                }
                // 401 → sign in and come back to this restaurant.
                if (env && env.status === 401) {
                    window.location.href = '/signin?next=' + encodeURIComponent(window.location.pathname + window.location.search);
                    return;
                }
                toast('error', (env && env.msg) || 'Could not add the Surprise Box.');
            })
            .catch(function () {
                if (addBtn) { addBtn.disabled = false; }
                toast('error', 'Could not reach the server.');
            });
    });

    sync();
}());
