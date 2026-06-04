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
    function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

    function popupRoot(name) {
        return document.querySelector('[data-ckt-popup="' + name + '"]');
    }

    function open(name) {
        var el = popupRoot(name);
        if (!el) { return; }
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
        var titleEl = row && row.querySelector('[data-ckt-pay-title]');
        if (out) { out.textContent = titleEl ? titleEl.textContent : 'Cash'; }

        var totalEl = $('[data-ckt-confirm-total]');
        if (!totalEl) { return; }
        var mode   = row && row.getAttribute('data-ckt-pay-mode');
        var isCard = !!mode && mode !== 'cash';            // new-card | card:<id>
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
        pendingPayMode = mode;
        paintPayTiles(mode);
        revealNewCardPanel(mode === 'new-card');
        // If the user picked New Card, ask /js/ui/cart.js to mount
        // Stripe Elements lazily inside the popup's [data-stripe-mount].
        if (mode === 'new-card' && window.EatNDealCart && typeof window.EatNDealCart.ensureCardElement === 'function') {
            window.EatNDealCart.ensureCardElement();
        }
    }

    function applyPay() {
        var row = $('[data-cart-pay]');
        if (!row || pendingPayMode == null) { close(); return; }

        // ── New card path ──────────────────────────────────────────
        // When "Save this card" is ticked we SAVE it right now (SetupIntent
        // confirm) so it joins the saved-cards list + is selectable next
        // time — that's what the customer expects after "Use this method".
        // When NOT ticked, it stays a one-shot card charged at checkout.
        if (pendingPayMode === 'new-card') {
            var saveBox = document.querySelector('[data-cart-save-card]');
            var wantSave = !!(saveBox && saveBox.checked);
            if (wantSave && window.EatNDealCart && typeof window.EatNDealCart.saveCardViaSetup === 'function') {
                return saveNewCard(row);
            }
            // One-shot — commit the mode + close (charged at checkout).
            commitPayRow(row, 'new-card');
            close();
            return;
        }

        commitPayRow(row, pendingPayMode);
        close();
    }

    // Persist the chosen mode onto the row + update its visible label.
    function commitPayRow(row, mode) {
        row.setAttribute('data-ckt-pay-mode', mode);
        var titleEl = row.querySelector('[data-ckt-pay-title]');
        var subEl   = row.querySelector('[data-ckt-pay-sub]');
        if (mode === 'cash') {
            var modeBtn = document.querySelector('[data-action="cart-set-mode"].is-active');
            var isPickup = modeBtn && modeBtn.getAttribute('data-mode') === '2';
            if (titleEl) { titleEl.textContent = 'Cash on ' + (isPickup ? 'pickup' : 'delivery'); }
            if (subEl)   { subEl.textContent   = 'Pay at the door'; }
        } else if (mode === 'new-card') {
            if (titleEl) { titleEl.textContent = 'New card'; }
            if (subEl)   { subEl.textContent   = 'You\'ll be charged at checkout'; }
        } else if (mode.indexOf('card:') === 0) {
            var btn = document.querySelector('[data-pay-mode="' + mode + '"]');
            if (btn) {
                var t = btn.querySelector('.ckt-list__title');
                var s = btn.querySelector('.ckt-list__sub');
                if (titleEl && t) { titleEl.textContent = t.textContent; }
                if (subEl   && s) { subEl.textContent   = s.textContent; }
            }
        }
    }

    // Save the typed card now (SetupIntent), then reload so it appears
    // in the list + is pre-selected (the new pm id is stashed in
    // sessionStorage and picked up on the next render).
    function saveNewCard(row) {
        var applyBtn = $('[data-action="ckt-apply-pay"]');
        var sheet = popupRoot('payment') && popupRoot('payment').querySelector('.ckt-popup__sheet');
        if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Saving card…'; }
        if (sheet) { sheet.classList.add('is-busy'); }

        window.EatNDealCart.saveCardViaSetup().then(function (pmId) {
            try {
                sessionStorage.setItem('ckt.newCard', JSON.stringify({ pmId: pmId, ts: Date.now() }));
            } catch (e) { /* ignore */ }
            window.location.reload();
        }).catch(function (err) {
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Use this method'; }
            if (sheet) { sheet.classList.remove('is-busy'); }
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('error', (err && err.message) || 'Could not save the card.');
            }
        });
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
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }

        var trig = t.closest('[data-action="ckt-open-address"], [data-action="ckt-open-schedule"], [data-action="ckt-open-promo"], [data-action="ckt-open-payment"], [data-action="ckt-open-instructions"], [data-action="ckt-open-confirm"]');
        if (trig) {
            ev.preventDefault();
            var action = trig.getAttribute('data-action');
            var name = action.replace('ckt-open-', '');
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
            var sheet = popupRoot(openName) && popupRoot(openName).querySelector('.ckt-popup__sheet');
            if (sheet) { sheet.classList.add('is-busy'); }
            // No early close — the page reload (or a failure toast) takes
            // it from here. Re-enable the sheet after a safety timeout in
            // case the request 4xx'd without a reload.
            window.setTimeout(function () {
                if (sheet) { sheet.classList.remove('is-busy'); }
            }, 4000);
            return;
        }
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && openName) { close(); }
    });

    // ── Post-save: select the just-saved card + confirm ─────────────
    // After saveNewCard reloads, the new card is now in the server-
    // rendered list. Select it on the payment row + toast a success.
    function consumeSavedCard() {
        var raw = null;
        try { raw = sessionStorage.getItem('ckt.newCard'); } catch (e) { return; }
        if (!raw) { return; }
        try { sessionStorage.removeItem('ckt.newCard'); } catch (e) { /* ignore */ }
        var data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        if (!data || !data.pmId) { return; }
        if (Date.now() - (Number(data.ts) || 0) > 15000) { return; }   // stale guard

        var mode = 'card:' + data.pmId;
        var row = $('[data-cart-pay]');
        // The card WAS saved (the SetupIntent succeeded). But only mark
        // it as the chosen method when its tile actually rendered — if
        // Stripe's list hasn't surfaced it yet, we must NOT imply it's
        // selected, or the customer could check out on the wrong method.
        var tile = document.querySelector('[data-pay-mode="' + mode + '"]');
        var toast = window.EatNDealUi && window.EatNDealUi.showToast;
        if (row && tile) {
            pendingPayMode = mode;
            commitPayRow(row, mode);
            if (toast) { toast('success', 'Card saved and selected for this order.'); }
        } else if (toast) {
            // Saved, but not yet selectable — be honest, don't claim it's
            // the active method.
            toast('info', 'Card saved. Open Payment to select it.');
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', consumeSavedCard);
    } else {
        consumeSavedCard();
    }

    // Expose for any other module that needs to drive it programmatically.
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.checkoutPopups = { open: open, close: close };
})();
