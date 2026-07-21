/*
 * ui/checkout-popups.js
 *
 * What:  Opens / closes the four checkout sheets (Address, Schedule,
 *        Promo, Payment) and manages the payment-method selection
 *        inside the Payment popup. The actual write actions (set
 *        address, save schedule, apply coupon, place order) are still
 *        handled by /js/ui/cart.js — this module is glue.
 *
 *        Public surface (via window.EatNDealUi.checkoutPopups):
 *           open(name)  — 'address' | 'schedule' | 'promo' | 'payment'
 *           close()     — closes any open popup
 *
 *        Triggers:
 *           [data-action="ckt-open-address"]   — opens Address popup
 *           [data-action="ckt-open-schedule"]  — opens Schedule popup
 *           [data-action="ckt-open-promo"]     — opens Promo popup
 *           [data-action="ckt-open-payment"]   — opens Payment popup
 *           [data-action="ckt-popup-close"]    — closes any popup
 *           [data-action="ckt-pick-pay"]       — selects a pay mode
 *                                                inside the Payment popup
 *           [data-action="ckt-apply-pay"]      — confirms the chosen
 *                                                pay mode and syncs the
 *                                                row in the main page
 *
 *        The Payment row in the cart page carries
 *           data-cart-pay
 *           data-stripe-key="<publishable>"
 *           data-ckt-pay-mode="cash" | "card:<pm_id>" | "new-card"
 *        which is read by the cart.js checkout flow at place-order
 *        time (no change to existing handlers — they just consult the
 *        attribute to decide cash vs saved-card vs new-card).
 *
 * Used:  Loaded by the layout. Only attaches handlers when at least one
 *        [data-ckt-popup] node is present (i.e. on /cart).
 */
(function () {
    'use strict';

    var openName = null;
    var lastFocused = null;

    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    var $$ = (window.EatNDealDom && window.EatNDealDom.queryAll) || function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

    function popupRoot(name) {
        return document.querySelector('[data-ckt-popup="' + name + '"]');
    }

    function open(name) {
        var el = popupRoot(name);
        if (!el) { return; }
        // Close any OTHER open checkout popup first — they must never stack.
        // A still-open payment popup (with its mounted Stripe field) sitting
        // behind the review popup is what leaked the floating "stripe" badge
        // at the bottom of the screen.
        if (openName && openName !== name) {
            var prev = popupRoot(openName);
            if (prev) { prev.hidden = true; prev.setAttribute('aria-hidden', 'true'); }
        }
        lastFocused = document.activeElement;
        el.hidden = false;
        el.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        openName = name;
        // For the payment popup, mirror the row's current mode into
        // the list so the right tile shows as selected when opened.
        if (name === 'payment') { syncPayModeFromRow(); }
        // Promo popup always opens on the list view (not a stale detail).
        if (name === 'promo') { showPromoList(); }
        // Review popup: copy the currently-chosen payment method label
        // (it can change client-side without a reload).
        if (name === 'confirm') { fillConfirmPayment(); }
    }

    // Mirror the live payment-row label into the review popup so the
    // confirmation always shows the method the customer actually picked,
    // and add the company's CARD service charge to the total when the
    // selected method is a card (cash never carries it).
    function fillConfirmPayment() {
        var row = $('[data-cart-pay]');
        var out = $('[data-ckt-confirm-pay]');
        // The chosen method is data-ckt-pay-mode, NOT the card tile's label.
        // [data-ckt-pay-title] lives on the CARD tile only (Cash has its own
        // static tile), so reading it blindly reported "Card" even when Cash
        // was selected — the review screen contradicted the cart behind it.
        var mode   = row && row.getAttribute('data-ckt-pay-mode');
        var isCard = !!mode && mode !== 'cash';            // new-card | card:<id>
        if (out) {
            if (!isCard) {
                out.textContent = 'Cash';
            } else {
                var titleEl = row.querySelector('[data-ckt-pay-title]');
                out.textContent = (titleEl && titleEl.textContent.trim()) || 'Card';
            }
        }

        var totalEl = $('[data-ckt-confirm-total]');
        if (!totalEl) { return; }
        var base   = parseFloat(totalEl.getAttribute('data-ckt-base-grand')) || 0;
        var charge = parseFloat(totalEl.getAttribute('data-ckt-card-charge')) || 0;
        var sym    = (document.body && document.body.getAttribute('data-currency-symbol')) || '£';

        var ccRow = $('[data-ckt-confirm-cardcharge-row]');
        if (ccRow) { ccRow.hidden = !(isCard && charge > 0); }

        var total = base + ((isCard && charge > 0) ? charge : 0);
        totalEl.textContent = sym + total.toFixed(2);
        var cta = $('[data-ckt-confirm-cta-total]');
        if (cta) { cta.textContent = ' · ' + sym + total.toFixed(2); }
    }

    // True when the bill comes to £0 (a discount/voucher/reward covers it
    // all). Reads the cart's base grand — the same figure the API guards on.
    function zeroTotal() {
        var el = document.querySelector('[data-cart-grandtotal]');
        if (!el) { return false; }
        return (parseFloat(el.getAttribute('data-base-grand')) || 0) <= 0;
    }

    function close() {
        if (!openName) { return; }
        var el = popupRoot(openName);
        if (el) {
            el.hidden = true;
            el.setAttribute('aria-hidden', 'true');
        }
        document.body.style.overflow = '';
        openName = null;
        if (lastFocused && typeof lastFocused.focus === 'function') {
            try { lastFocused.focus(); } catch (e) { /* ignore */ }
        }
    }

    // ── Payment mode selection inside the popup ─────────────────────
    var pendingPayMode = null;

    function syncPayModeFromRow() {
        var row = $('[data-cart-pay]');
        if (!row) { return; }
        var current = row.getAttribute('data-ckt-pay-mode') || 'cash';
        pendingPayMode = current;
        paintPayTiles(current);
        revealNewCardPanel(current === 'new-card');
        // If New card is the active mode, mount Stripe Elements now so
        // the card field is ready the moment the popup opens (not only
        // after a re-click).
        if (current === 'new-card' && window.EatNDealCart && typeof window.EatNDealCart.ensureCardElement === 'function') {
            window.EatNDealCart.ensureCardElement();
        }
    }

    function paintPayTiles(mode) {
        var tiles = $$('[data-ckt-popup="payment"] [data-action="ckt-pick-pay"]');
        tiles.forEach(function (b) {
            b.classList.toggle('is-selected', b.getAttribute('data-pay-mode') === mode);
        });
    }

    function revealNewCardPanel(show) {
        var panel = $('[data-ckt-popup="payment"] [data-cart-card-panel]');
        if (!panel) { return; }
        panel.hidden = !show;
    }

    function onPickPay(btn) {
        var mode = btn.getAttribute('data-pay-mode') || 'cash';
        // £0 bill — nothing for Stripe to charge, so refuse the card choice
        // right here rather than letting them fill a card form that can't be
        // used. Cash still places the order normally.
        if (mode !== 'cash' && zeroTotal()) {
            showPayError('Your total is £0.00 — please select Cash to place this order.');
            return;
        }
        pendingPayMode = mode;
        paintPayTiles(mode);
        revealNewCardPanel(mode === 'new-card');
        // If the user picked New Card, ask /js/ui/cart.js to mount
        // Stripe Elements lazily inside the popup's [data-stripe-mount].
        if (mode === 'new-card' && window.EatNDealCart && typeof window.EatNDealCart.ensureCardElement === 'function') {
            window.EatNDealCart.ensureCardElement();
        }
    }

    /**
     * showPayError
     *
     * Puts a message in the payment sheet's error box — the same
     * [data-stripe-error] element Stripe's own field errors use, so the
     * customer sees one error area, not two. Falls back to a toast if the box
     * isn't on the page.
     */
    function showPayError(msg) {
        var box = document.querySelector('[data-stripe-error]');
        if (box) {
            box.textContent = msg;
            box.hidden = false;
            if (box.scrollIntoView) { box.scrollIntoView({ block: 'nearest' }); }
            return;
        }
        if (window.EatNDealUi && window.EatNDealUi.showToast) {
            window.EatNDealUi.showToast('error', msg);
        }
    }

    function applyPay() {
        var row = $('[data-cart-pay]');
        if (!row) { close(); return; }
        // Nothing picked yet — the sheet used to just close, which read as
        // "saved" while the cart kept whatever it had before. Ask instead.
        if (pendingPayMode == null) {
            showPayError('Please select a payment method.');
            return;
        }

        // ── New card / other method path ───────────────────────────
        // The card or wallet is collected in the Stripe Payment Element and
        // charged at "Place order". Saving for future use is handled by the
        // intent's setup_future_usage when "Save this card" is ticked — so
        // there's no separate SetupIntent step here; just commit + close.
        if (pendingPayMode === 'new-card') {
            // The details must actually be COMPLETE first. Stripe reports this
            // on the element's change event, which /js/ui/cart.js records as
            // data-pay-complete on this row.
            // Without the check the sheet closed on a blank or half-typed card
            // and the cart proudly showed "New card · Charged at checkout" —
            // the customer only discovered it was never valid at Place order.
            // Wallets (Apple/Google Pay) mark themselves complete on selection,
            // so they still pass straight through.
            if (row.getAttribute('data-pay-complete') !== '1') {
                showPayError('Please complete your card details.');
                return;                       // stay open so they can fix it
            }
            commitPayRow(row, 'new-card');
            close();
            return;
        }

        commitPayRow(row, pendingPayMode);
        close();
    }

    // Highlight the Cash / Card tile on the cart page for the active mode.
    function paintCartPayTiles(mode) {
        var wrap = $('[data-cart-pay]');
        if (!wrap) { return; }
        var want = (mode && mode !== 'cash') ? 'card' : 'cash';
        var tiles = wrap.querySelectorAll('[data-paytile]');
        Array.prototype.forEach.call(tiles, function (t) {
            t.classList.toggle('is-active', t.getAttribute('data-paytile') === want);
        });
    }

    // Persist the chosen mode onto the row + update the CARD tile's label
    // ([data-ckt-pay-title]/[sub] live on the Card tile). Cash has its own
    // static tile, so cash just resets the Card tile to its neutral label.
    // ── Remembering the chosen payment method ───────────────────────
    // The cart page renders data-ckt-pay-mode="cash" every time, and every
    // cart write (promo, qty, address…) reloads the page — so picking Card
    // and then touching anything silently threw the customer back to Cash.
    // Keep the choice for the tab's lifetime; it is a UI preference, not
    // cart data, so sessionStorage is the right home for it (nothing is
    // charged until Place Order re-reads the row anyway).
    var PAY_MODE_KEY = 'eatndeal_pay_mode';
    function rememberPayMode(mode) {
        try { window.sessionStorage.setItem(PAY_MODE_KEY, String(mode || '')); }
        catch (e) { /* private mode / quota — the row still holds it */ }
    }
    function restorePayMode() {
        var row = $('[data-cart-pay]');
        if (!row) { return; }
        var saved;
        try { saved = window.sessionStorage.getItem(PAY_MODE_KEY); } catch (e) { saved = null; }
        if (!saved || saved === 'cash') { return; }          // cash is already the default
        // A saved CARD is only re-selectable if that tile still exists (the
        // card may have been removed since). Otherwise leave it on Cash.
        if (saved.indexOf('card:') === 0 && !document.querySelector('[data-pay-mode="' + saved + '"]')) { return; }
        commitPayRow(row, saved);
    }

    function commitPayRow(row, mode) {
        rememberPayMode(mode);
        row.setAttribute('data-ckt-pay-mode', mode);
        var titleEl = row.querySelector('[data-ckt-pay-title]');
        var subEl   = row.querySelector('[data-ckt-pay-sub]');
        if (mode === 'new-card') {
            if (titleEl) { titleEl.textContent = 'New card'; }
            if (subEl)   { subEl.textContent   = 'Charged at checkout'; }
        } else if (mode.indexOf('card:') === 0) {
            var btn = document.querySelector('[data-pay-mode="' + mode + '"]');
            if (btn) {
                var t = btn.querySelector('.ckt-list__title');
                var s = btn.querySelector('.ckt-list__sub');
                if (titleEl && t) { titleEl.textContent = t.textContent; }
                if (subEl   && s) { subEl.textContent   = s.textContent; }
            }
        } else if (mode === 'cash') {
            if (titleEl) { titleEl.textContent = 'Card'; }
            if (subEl)   { subEl.textContent   = 'Choose a card'; }
        }
        paintCartPayTiles(mode);
    }

    // ── Promo list / detail sub-views ──────────────────────────────
    function promoListEl()   { return document.querySelector('[data-ckt-promo-list]'); }
    function promoDetailEl() { return document.querySelector('[data-ckt-promo-detail]'); }

    function showPromoList() {
        var list = promoListEl(); var detail = promoDetailEl();
        if (list)   { list.hidden = false; }
        if (detail) { detail.hidden = true; }
    }

    function openPromoDetail(card) {
        if (!card) { return; }
        var data;
        try { data = JSON.parse(decodeURIComponent(card.getAttribute('data-promo') || '')); }
        catch (e) { return; }
        if (!data) { return; }

        var headline = document.querySelector('[data-ckt-detail-headline]');
        var expiry   = document.querySelector('[data-ckt-detail-expiry]');
        var bodyEl   = document.querySelector('[data-ckt-detail-body]');
        var selBtn   = document.querySelector('[data-action="ckt-promo-detail-select"]');

        if (headline) {
            headline.textContent = data.discountLabel + (data.freeDelivery ? ' · Free delivery' : '');
        }
        if (expiry) { expiry.textContent = data.expiryLabel || 'While supplies last'; }
        if (bodyEl) {
            // Compose a terms list from the structured fields.
            var lines = [];
            if (data.minOrderLabel) { lines.push(data.minOrderLabel + ' (excluding promotions)'); }
            if (data.description)   { lines.push(data.description); }
            lines.push('Other local fees / taxes may still apply.');
            bodyEl.textContent = lines.join('  •  ');
        }
        if (selBtn) {
            selBtn.setAttribute('data-code', data.code || '');
            selBtn.disabled = !data.eligible;
        }

        var list = promoListEl(); var detail = promoDetailEl();
        if (list)   { list.hidden = true; }
        if (detail) { detail.hidden = false; }
    }

    // Apply a code by routing it through the EXISTING cart.js coupon
    // handler: set the input value, then trigger its Apply button so
    // the validate + persist + reload flow runs unchanged.
    function applyPromoCode(code) {
        if (!code) { return; }
        var input  = document.querySelector('[data-cart-coupon-input]');
        var apply  = document.querySelector('[data-action="cart-apply-coupon"]');
        if (input) { input.value = code; }
        if (apply) { apply.click(); }
        else {
            // No code box rendered (e.g. a coupon is already applied) —
            // fall back to a direct POST mirroring onApplyCoupon.
            fetch('/cart/apply-coupon', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ code: code }),
            }).then(function (r) { return r.json().catch(function () { return null; }); })
              .then(function (env) {
                  if (env && env.status === 200) { window.location.reload(); }
                  else if (window.EatNDealUi && window.EatNDealUi.showToast) {
                      window.EatNDealUi.showToast('error', (env && env.msg) || 'Could not apply that code.');
                  }
              });
        }
    }

    // ── Drop-off options ───────────────────────────────────────────
    // Single-select preset tiles + a free-text note, saved together via
    // the new /cart/set-instructions endpoint (encoded server-side).
    function onInstrPick(btn) {
        var tiles = $$('[data-ckt-popup="instructions"] [data-action="ckt-instr-pick"]');
        tiles.forEach(function (b) { b.classList.toggle('is-selected', b === btn); });
    }

    function saveInstructions() {
        var sel = $('[data-ckt-popup="instructions"] [data-action="ckt-instr-pick"].is-selected');
        var textEl = $('[data-ckt-instr-text]');
        var dropoff = sel ? sel.getAttribute('data-dropoff') : '';
        var instructions = textEl ? textEl.value.trim().slice(0, 200) : '';

        var sheet = popupRoot('instructions') && popupRoot('instructions').querySelector('.ckt-popup__sheet');
        if (sheet) { sheet.classList.add('is-busy'); }

        fetch('/cart/set-instructions', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ drop_off_option: dropoff, instructions: instructions }),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (env && env.status === 200) { window.location.reload(); return; }
              if (sheet) { sheet.classList.remove('is-busy'); }
              if (window.EatNDealUi && window.EatNDealUi.showToast) {
                  window.EatNDealUi.showToast('error', (env && env.msg) || 'Could not save instructions.');
              }
          })
          .catch(function () {
              if (sheet) { sheet.classList.remove('is-busy'); }
              if (window.EatNDealUi && window.EatNDealUi.showToast) {
                  window.EatNDealUi.showToast('error', 'Could not reach the server.');
              }
          });
    }

    // ── Document delegate ──────────────────────────────────────────
    // A settle action (set-address / coupon / schedule) marks the popup sheet
    // busy until cart.js fires 'ckt:settle-done' (request resolved — reload,
    // error, or conflict). clearBusy() drops the spinner so it never hangs.
    var busySheet = null, busyTimer = null;
    function clearBusy() {
        if (busyTimer) { window.clearTimeout(busyTimer); busyTimer = null; }
        if (busySheet) { busySheet.classList.remove('is-busy'); busySheet = null; }
    }
    document.addEventListener('ckt:settle-done', clearBusy);

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        var trig = t.closest('[data-action="ckt-open-address"], [data-action="ckt-open-schedule"], [data-action="ckt-open-promo"], [data-action="ckt-open-payment"], [data-action="ckt-open-instructions"], [data-action="ckt-open-confirm"]');
        if (trig) {
            ev.preventDefault();
            var action = trig.getAttribute('data-action');
            var name = action.replace('ckt-open-', '');
            // Card tile on a £0 bill — don't even open the payment sheet;
            // there is nothing to charge, so say so and keep them on Cash.
            if (name === 'payment' && zeroTotal()) {
                if (window.EatNDealUi && window.EatNDealUi.showToast) {
                    window.EatNDealUi.showToast('error', 'Your total is £0.00 — please select Cash to place this order.');
                }
                return;
            }
            open(name);
            return;
        }

        // ── Drop-off options ───────────────────────────────────────
        var instrPick = t.closest('[data-action="ckt-instr-pick"]');
        if (instrPick) { ev.preventDefault(); onInstrPick(instrPick); return; }
        if (t.closest('[data-action="ckt-instr-save"]')) { ev.preventDefault(); saveInstructions(); return; }
        if (t.closest('[data-action="ckt-popup-close"]')) {
            ev.preventDefault();
            close();
            return;
        }
        // "+ Add an address" opens the global location modal — hide this cart
        // popup first so the two don't stack. Don't reset body scroll-lock
        // (the location modal manages its own) and don't preventDefault, so
        // location-modal.js's handler still opens the modal on the same click.
        if (t.closest('[data-action="open-location-modal"]')) {
            var addrEl = popupRoot(openName);
            if (addrEl) { addrEl.hidden = true; addrEl.setAttribute('aria-hidden', 'true'); }
            openName = null;
            return;
        }
        // Cash tile on the cart page — commit cash, no popup.
        var pickCash = t.closest('[data-action="ckt-pick-cash"]');
        if (pickCash) {
            ev.preventDefault();
            var cashRow = $('[data-cart-pay]');
            if (cashRow) { commitPayRow(cashRow, 'cash'); }
            return;
        }
        var pick = t.closest('[data-action="ckt-pick-pay"]');
        if (pick) { ev.preventDefault(); onPickPay(pick); return; }
        if (t.closest('[data-action="ckt-apply-pay"]')) {
            ev.preventDefault();
            applyPay();
            return;
        }

        // ── Promo list / detail ────────────────────────────────────
        var promoSel = t.closest('[data-action="ckt-promo-select"]');
        if (promoSel) { ev.preventDefault(); applyPromoCode(promoSel.getAttribute('data-code')); return; }
        var promoDet = t.closest('[data-action="ckt-promo-details"]');
        if (promoDet) { ev.preventDefault(); openPromoDetail(promoDet.closest('[data-ckt-promo-id]')); return; }
        if (t.closest('[data-action="ckt-promo-detail-back"]')) { ev.preventDefault(); showPromoList(); return; }
        var detSel = t.closest('[data-action="ckt-promo-detail-select"]');
        if (detSel) { ev.preventDefault(); applyPromoCode(detSel.getAttribute('data-code')); return; }

        // The existing cart.js handles cart-set-address / cart-apply-
        // coupon / cart-remove-coupon / cart-sched-* and reloads the
        // whole page on success — which dismisses the popup naturally.
        // We DON'T close the popup early (that would flash the stale
        // page while the request is still in flight). Instead we mark
        // the sheet busy so the customer sees progress; on failure the
        // cart.js toast fires and the (still-open) popup lets them retry.
        var settle = t.closest('[data-action="cart-set-address"], [data-action="cart-apply-coupon"], [data-action="cart-remove-coupon"], [data-action="cart-sched-save"], [data-action="cart-sched-asap"]');
        if (settle && openName) {
            // Re-tapping the already-active address makes no API call (cart.js
            // no-ops it → no reload), so close the popup here; otherwise it
            // sticks on the "busy" state with nothing to dismiss it.
            if (settle.getAttribute('data-action') === 'cart-set-address' && settle.classList.contains('is-selected')) {
                close();
                return;
            }
            var sheet = popupRoot(openName) && popupRoot(openName).querySelector('.ckt-popup__sheet');
            if (sheet) { sheet.classList.add('is-busy'); }
            // 'ckt:settle-done' (from cart.js) clears this the moment the request
            // resolves — success reloads, errors/conflicts just drop the spinner
            // so the popup never hangs. The timeout is only a safety net.
            busySheet = sheet || null;
            if (busyTimer) { window.clearTimeout(busyTimer); }
            busyTimer = window.setTimeout(clearBusy, 8000);
            return;
        }
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && openName) { close(); }
    });

    // A newly-entered card is saved at PAYMENT time (the intent's
    // setup_future_usage) and surfaces in the saved-cards list on the next
    // visit — there's no SetupIntent pre-save / reload step to reconcile here.

    // Re-apply the payment method the customer picked before the last cart
    // write reloaded the page. Runs after the DOM is ready so the saved-card
    // tiles exist to validate against.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restorePayMode);
    } else {
        restorePayMode();
    }

    // Expose for any other module that needs to drive it programmatically.
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.checkoutPopups = { open: open, close: close };
})();
