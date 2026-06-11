/*
 * ui/cart.js
 *
 * What:  Global cart UI module — loaded once by the layout, handles
 *        EVERY cart interaction on every page via delegated clicks:
 *
 *          • [data-action="pd-add"]      (product page → Add to cart)
 *          • [data-action="cart-qty-inc/dec"] (cart page → stepper)
 *          • [data-action="cart-remove"] (cart page → remove a line)
 *          • [data-action="cart-clear"]  (cart page header → clear cart)
 *          • [data-action="cart-checkout"] (cart page → placeholder)
 *
 *        Also maintains the header cart-count badge after every write.
 *
 *        No page-specific JS file exists for the cart — every screen
 *        that shows a cart-related control just renders the right
 *        data-action attribute and this module wires it up.
 *
 * Why:   Cart controls show up on many surfaces (product page, cart
 *        page, future quick-buy on home cards, mini-cart drawer in the
 *        header). One delegate keeps the surface tiny + ensures the
 *        same auth + envelope handling everywhere.
 *
 * Auth:  Every call expects the customer to be signed in (the proxy
 *        injects customer_id from the session). On 401 we bounce to
 *        /signin?next=<current>.
 */
(function () {
    'use strict';

    var qa = (window.EatNDealDom && window.EatNDealDom.queryAll) || function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    // ── Header badge ────────────────────────────────────────────────
    // Updates the cart count chip in the header. Two entry points:
    //
    //   setCartBadge(n)        — write a known count (used by refresh).
    //   bumpCartBadge(cart)    — convenience for cart payloads. If the
    //                            payload doesn't carry totalQty, falls
    //                            back to a server refresh so the badge
    //                            never goes stale on a malformed write.
    //
    // The pulse fires only when the count went UP, so removing items or
    // re-reading a stable cart doesn't trigger animation noise.
    function setCartBadge(qty) {
        var badge = document.querySelector('[data-cart-count]');
        if (!badge) { return; }
        var prev = parseInt(badge.textContent || '0', 10) || 0;
        var n = Number(qty) || 0;
        if (n > 0) {
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.hidden = false;
            badge.removeAttribute('hidden');
            if (n > prev) {
                badge.classList.remove('is-bumping');
                void badge.offsetWidth;     // restart the animation
                badge.classList.add('is-bumping');
                window.setTimeout(function () { badge.classList.remove('is-bumping'); }, 700);
            }
        } else {
            badge.textContent = '0';
            badge.hidden = true;
            badge.setAttribute('hidden', '');
        }
    }

    function bumpCartBadge(cart) {
        // cart === null is the cart-cleared signal from the API.
        if (cart === null) { setCartBadge(0); return; }
        if (cart && typeof cart.totalQty === 'number') {
            setCartBadge(cart.totalQty);
            return;
        }
        // Server is the source of truth — defensive refresh.
        refreshCartBadge();
    }

    function refreshCartBadge() {
        fetch('/cart/count', {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            if (!env || env.status !== 200 || !env.data) { return; }
            setCartBadge(Number(env.data.count) || 0);
        }).catch(function () { /* swallow — keep last-known badge */ });
    }

    // ── Fly-to-cart animation ───────────────────────────────────────
    // Visual confirmation that an item is going into the cart: clones
    // a small dot at the click point and animates it on a curved path
    // up to the header's cart icon, where the badge then pulses. The
    // clone uses position:fixed and CSS transitions; on transitionend
    // (or a hard timeout fallback) it's removed from the DOM.
    function getCartTarget() {
        var el = document.querySelector('.header-quick__cart');
        if (!el) { return null; }
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function flyToCart(originEl) {
        var target = getCartTarget();
        if (!target || !originEl) { return; }
        var src = originEl.getBoundingClientRect();
        var sx = src.left + src.width / 2;
        var sy = src.top + src.height / 2;

        // The flying dot. Pure DOM — no extra CSS file needed (a tiny
        // inline style block is injected once for the keyframes-less
        // transition + visual).
        var dot = document.createElement('span');
        dot.className = 'cart-fly';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.left = (sx - 12) + 'px';
        dot.style.top  = (sy - 12) + 'px';
        document.body.appendChild(dot);

        // Force layout then transition to target.
        void dot.offsetWidth;
        var dx = target.x - sx;
        var dy = target.y - sy;
        dot.style.transform   = 'translate(' + dx + 'px, ' + dy + 'px) scale(0.4)';
        dot.style.opacity     = '0.2';

        var cleanup = function () { if (dot.parentNode) { dot.parentNode.removeChild(dot); } };
        dot.addEventListener('transitionend', cleanup, { once: true });
        window.setTimeout(cleanup, 900);                     // safety net
    }
    // One-shot style injection. Cheaper than a separate CSS file for a
    // single-purpose visual + keeps the animation co-located with its
    // JS owner.
    (function injectFlyCss() {
        if (document.getElementById('cart-fly-css')) { return; }
        var s = document.createElement('style');
        s.id = 'cart-fly-css';
        s.textContent =
            '.cart-fly {' +
            '  position: fixed; z-index: 9999; pointer-events: none;' +
            '  width: 24px; height: 24px; border-radius: 50%;' +
            '  background: var(--color-primary, #e5252a);' +
            '  box-shadow: 0 6px 14px rgba(229,37,42,0.45);' +
            '  transition: transform 700ms cubic-bezier(0.5, -0.3, 0.7, 0.9), opacity 700ms ease-out;' +
            '}';
        document.head.appendChild(s);
    })();

    // ── Custom confirm (replaces window.confirm) ────────────────────
    // window.EatNDealUi.confirmDialog is mounted by /js/ui/dialog.js;
    // returns a Promise<boolean>. Fallback to native confirm if the
    // dialog component isn't on the page (defensive).
    function confirm(opts) {
        if (window.EatNDealUi && window.EatNDealUi.confirmDialog) {
            return window.EatNDealUi.confirmDialog(opts);
        }
        return Promise.resolve(window.confirm(opts && opts.message || ''));
    }

    // ── Network helper ──────────────────────────────────────────────
    function postCart(path, body) {
        return fetch(path, {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify(body || {}),
        }).then(function (r) { return r.json().catch(function () { return null; }); });
    }

    // ── Envelope handler (401 / 409 conflict / 422 / 200) ───────────
    function handleEnvelope(env, opts) {
        opts = opts || {};
        if (!env) { toast('error', 'Could not reach the server.'); return false; }
        if (env.status === 401) {
            var here = window.location.pathname + window.location.search;
            window.location.href = '/signin?next=' + encodeURIComponent(here);
            return false;
        }
        if (env.status === 409 && env.data && env.data.code === 'branch.conflict') {
            if (typeof opts.onConflict === 'function') { opts.onConflict(env); }
            return false;
        }
        if (env.status !== 200) {
            toast('error', env.msg || 'Action failed.');
            return false;
        }
        bumpCartBadge(env.data && env.data.cart);
        if (opts.successToast !== false && env.msg) { toast('success', env.msg); }
        if (opts.reload) { window.location.reload(); }
        return true;
    }

    // ── Product-page → Add to cart ──────────────────────────────────
    function firstInvalidGroup(productRoot) {
        var bad = null;
        qa('.pd-group', productRoot).forEach(function (g) {
            if (bad) { return; }
            var min = Number(g.getAttribute('data-min')) || 0;
            if (min < 1) { return; }
            // Skip nested groups whose parent option isn't currently picked.
            var wrap = g.closest('[data-linked-for]');
            if (wrap && wrap.hidden) { return; }
            if (qa('input:checked', g).length < min) { bad = g; }
        });
        return bad;
    }

    function collectOptions(productRoot) {
        var out = [];
        qa('.pd-group input:checked', productRoot).forEach(function (inp) {
            var fs = inp.closest('.pd-group');
            if (!fs) { return; }
            var wrap = fs.closest('[data-linked-for]');
            if (wrap && wrap.hidden) { return; }
            var rawGroup = fs.getAttribute('data-group') || '';
            var groupId  = rawGroup.replace(/^[a-z]/, '');     // strip "m"/"v"/"d"
            if (!groupId) { return; }
            out.push({ groupId: groupId, optionId: inp.value });
        });
        return out;
    }

    function readNote(productRoot) {
        var note = productRoot.querySelector('[data-note]');
        return note ? note.value.trim().slice(0, 120) : '';
    }

    function readQty(productRoot) {
        var el = productRoot.querySelector('[data-qty]');
        if (!el) { return 1; }
        var n = parseInt(el.textContent, 10);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    function doAddToCart(productRoot, btn, replace) {
        var body = {
            product_id: productRoot.getAttribute('data-product-id'),
            qty:        readQty(productRoot),
            options:    collectOptions(productRoot),
            remark:     readNote(productRoot),
        };
        if (replace) { body.replace_cart = true; }
        return postCart('/cart/add', body).then(function (env) {
            var ok = handleEnvelope(env, {
                onConflict: function (e) {
                    confirm({
                        title:    'Switch restaurant?',
                        message:  e.msg || 'Your cart has items from another restaurant. Clearing it will start a new cart at this one.',
                        okLabel:  'Clear and add',
                        cancelLabel: 'Keep current cart',
                    }).then(function (ok) {
                        if (ok) { doAddToCart(productRoot, btn, true); }
                    });
                },
            });
            // Only fly when the add actually landed — branch-conflict /
            // 401 / 422 all set ok=false so the animation skips, the
            // confirmation popup leads, and the retry's own success
            // landing fires the fly then.
            if (ok && btn) { flyToCart(btn); }
            return ok;
        });
    }

    function onAddClick(ev, btn) {
        ev.preventDefault();
        var productRoot = btn.closest('[data-product]') || document.querySelector('[data-product]');
        if (!productRoot) { return; }
        var bad = firstInvalidGroup(productRoot);
        if (bad) {
            var name = bad.querySelector('.pd-group__name');
            toast('error', 'Please choose: ' + (name ? name.textContent : 'a required option') + '.');
            bad.scrollIntoView({ behavior: 'smooth', block: 'center' });
            bad.classList.add('is-invalid');
            window.setTimeout(function () { bad.classList.remove('is-invalid'); }, 1500);
            return;
        }
        if (btn.disabled) { return; }
        btn.disabled = true;
        // Fly animation is fired by doAddToCart on a successful response
        // (branch-conflict skips the fly so it can run after the user
        // confirms switching restaurants).
        doAddToCart(productRoot, btn, false)
            .catch(function () { toast('error', 'Could not add to cart.'); })
            .then(function () { btn.disabled = false; });
    }

    // ── Restaurant-page → Quick +Add (no detail page, qty=1, no options) ──
    // The product cards on the restaurant page have a small "+ Add"
    // button. Tapping it goes straight to /cart/add with defaults — qty
    // 1, no modifiers, no remark — so the customer doesn't have to open
    // the product detail page for a one-click add. Products with required
    // option groups are still added at their base price; the customer
    // can open the detail page to customise if they want.
    function doQuickAdd(btn, replace) {
        var productId = btn.getAttribute('data-id');
        if (!productId) { return Promise.resolve(); }
        var body = { product_id: productId, qty: 1, options: [], remark: '' };
        if (replace) { body.replace_cart = true; }
        var name = btn.getAttribute('data-name') || 'Item';
        return postCart('/cart/add', body).then(function (env) {
            var ok = handleEnvelope(env, {
                // Suppress the generic server message — we use a friendlier
                // product-specific toast below.
                successToast: false,
                onConflict: function (e) {
                    confirm({
                        title:    'Switch restaurant?',
                        message:  e.msg || 'Your cart has items from another restaurant. Clearing it will start a new cart at this one.',
                        okLabel:  'Clear and add',
                        cancelLabel: 'Keep current cart',
                    }).then(function (ok) {
                        if (ok) { doQuickAdd(btn, true); }
                    });
                },
            });
            // Fly + toast only when the add actually landed. On branch
            // conflict the user sees the confirm popup first; the
            // retry's own success path fires the fly/toast.
            if (ok) {
                flyToCart(btn);
                toast('success', name + ' added to cart');
                return true;
            }
            return false;
        });
    }

    function onQuickAdd(ev, btn) {
        ev.preventDefault();
        ev.stopPropagation();   // Don't let bindProductClick navigate to the detail page.
        if (btn.disabled) { return; }
        btn.disabled = true;
        // Fly animation is fired by doQuickAdd on a successful response.
        doQuickAdd(btn, false)
            .catch(function () { toast('error', 'Could not add to cart.'); })
            .then(function () { btn.disabled = false; });
    }

    // ── Cart-page actions ───────────────────────────────────────────
    function rowFor(t) { return t.closest && t.closest('[data-cart-item]'); }
    function itemIdFor(row) { return row ? row.getAttribute('data-cart-item') : null; }
    function qtyFor(row) {
        var el = row && row.querySelector('[data-cart-qty]');
        return el ? parseInt(el.textContent, 10) || 0 : 0;
    }

    function busy(row, on) {
        if (!row) { return; }
        if (on) { row.classList.add('is-busy'); }
        else    { row.classList.remove('is-busy'); }
    }

    function onCartStep(ev, btn, step) {
        ev.preventDefault();
        var row = rowFor(btn);
        var id  = itemIdFor(row);
        if (!id) { return; }
        var newQty = qtyFor(row) + step;
        if (newQty < 1) {
            return confirm({
                title:    'Remove item?',
                message:  'This will remove the item from your cart.',
                okLabel:  'Remove',
            }).then(function (ok) {
                if (!ok) { return; }
                busy(row, true);
                return postCart('/cart/remove-item', { item_id: id }).then(function (env) {
                    handleEnvelope(env, { reload: true });
                    if (!env || env.status !== 200) { busy(row, false); }
                });
            });
        }
        busy(row, true);
        return postCart('/cart/update-qty', { item_id: id, qty: newQty }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { busy(row, false); }
        });
    }

    function onCartRemove(ev, btn) {
        ev.preventDefault();
        var row = rowFor(btn);
        var id  = itemIdFor(row);
        if (!id) { return; }
        busy(row, true);
        postCart('/cart/remove-item', { item_id: id }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { busy(row, false); }
        });
    }

    function onCartClear(ev, btn) {
        ev.preventDefault();
        confirm({
            title:   'Clear your cart?',
            message: 'This will remove every item from your cart.',
            okLabel: 'Clear cart',
        }).then(function (ok) {
            if (!ok) { return; }
            btn.disabled = true;
            return postCart('/cart/clear', {}).then(function (env) {
                handleEnvelope(env, { reload: true });
                if (!env || env.status !== 200) { btn.disabled = false; }
            });
        });
    }

    function onCartSetMode(ev, btn) {
        ev.preventDefault();
        if (btn.classList.contains('is-active') || btn.disabled) { return; }
        var mode = parseInt(btn.getAttribute('data-mode'), 10);
        if (mode !== 2 && mode !== 3) { return; }
        btn.disabled = true;
        postCart('/cart/set-mode', { serve_type: mode }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // Address picker: the Change button reveals the list; clicking a
    // tile triggers /cart/set-address. Both share the same panel so the
    // toggle / select feel like one widget.
    function onAddressToggle(ev, btn) {
        ev.preventDefault();
        var panel = btn.closest('[data-cart-addresses]');
        var list  = panel && panel.querySelector('[data-cart-address-list]');
        if (!list) { return; }
        var open = !list.hidden;
        list.hidden = open;
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        btn.textContent = open ? 'Change' : 'Cancel';
    }

    function onSetAddress(ev, btn) {
        ev.preventDefault();
        if (btn.classList.contains('is-selected') || btn.disabled) { return; }
        var addressId = btn.getAttribute('data-address-id');
        if (!addressId) { return; }
        btn.disabled = true;
        postCart('/cart/set-address', { address_id: addressId }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // Schedule (ASAP / Pre-order) — three actions:
    //   cart-sched-asap → POST is_pre_order=false
    //   cart-sched-pick → reveal the datetime panel (no API call yet)
    //   cart-sched-save → POST is_pre_order=true + scheduled_at
    function findSchedRoot(btn) {
        return btn.closest('[data-cart-sched]');
    }
    function onSchedAsap(ev, btn) {
        ev.preventDefault();
        if (btn.classList.contains('is-active') || btn.disabled) { return; }
        btn.disabled = true;
        postCart('/cart/set-schedule', { is_pre_order: false }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }
    function onSchedPick(ev, btn) {
        ev.preventDefault();
        var root = findSchedRoot(btn);
        if (!root) { return; }
        // Swap visible tab + reveal the picker — no API call until Save.
        // Select the ASAP/Schedule tabs by their data-action so this
        // works on BOTH the legacy cart (.cart-sched__tab) and the new
        // checkout popup (.ckt-popup__tab) — keying on the class broke
        // the new popup, leaving ASAP stuck "active".
        var tabs = root.querySelectorAll('[data-action="cart-sched-asap"], [data-action="cart-sched-pick"]');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('is-active', tabs[i] === btn);
            tabs[i].setAttribute('aria-selected', tabs[i] === btn ? 'true' : 'false');
        }
        var panel = root.querySelector('[data-cart-sched-panel]');
        if (panel) { panel.hidden = false; }
    }
    function onSchedSave(ev, btn) {
        ev.preventDefault();
        var root = findSchedRoot(btn);
        var input = root && root.querySelector('[data-cart-sched-input]');
        var val = input ? input.value : '';
        if (!val) { toast('error', 'Pick a date and time first.'); return; }
        btn.disabled = true;
        postCart('/cart/set-schedule', { is_pre_order: true, scheduled_at: val }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // Coupon flow: Apply reads the input + POSTs the code; Remove
    // wipes the applied coupon from the cart.
    function onApplyCoupon(ev, btn) {
        ev.preventDefault();
        var panel = btn.closest('[data-cart-coupon]');
        var input = panel && panel.querySelector('[data-cart-coupon-input]');
        var code  = input ? input.value.trim() : '';
        if (!code) { toast('error', 'Enter a coupon code.'); return; }
        btn.disabled = true;
        postCart('/cart/apply-coupon', { code: code }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }
    function onRemoveCoupon(ev, btn) {
        ev.preventDefault();
        btn.disabled = true;
        postCart('/cart/remove-coupon', {}).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // ── Voucher (customer reward codes; separate from coupons) ──────
    function onApplyVoucher(ev, btn) {
        ev.preventDefault();
        var panel = btn.closest('[data-cart-voucher]');
        var input = panel && panel.querySelector('[data-cart-voucher-input]');
        var code  = input ? input.value.trim() : '';
        if (!code) { toast('error', 'Enter a voucher code.'); return; }
        btn.disabled = true;
        postCart('/cart/apply-voucher', { code: code }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }
    function onRemoveVoucher(ev, btn) {
        ev.preventDefault();
        btn.disabled = true;
        postCart('/cart/remove-voucher', {}).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // ── Loyalty redeem (spend this restaurant's reward balance) ─────
    // Apply reads the £ amount the customer typed (defaults to the max);
    // the API re-clamps to balance / cap / sub-total. Remove clears it.
    function onApplyLoyalty(ev, btn) {
        ev.preventDefault();
        var panel = btn.closest('[data-cart-loyalty]');
        var input = panel && panel.querySelector('[data-cart-loyalty-input]');
        var max   = panel ? (parseFloat(panel.getAttribute('data-reward-max')) || 0) : 0;
        var amount = input ? parseFloat(input.value) : max;
        if (!isFinite(amount) || amount <= 0) { amount = max; }
        if (!(amount > 0)) { toast('error', 'Enter how much reward to use.'); return; }
        btn.disabled = true;
        postCart('/cart/apply-loyalty', { amount: amount }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }
    function onRemoveLoyalty(ev, btn) {
        ev.preventDefault();
        btn.disabled = true;
        postCart('/cart/remove-loyalty', {}).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // ── Charity contribution (No / % tiers / Custom) ────────────────
    function charityRoot() { return document.querySelector('[data-cart-charity]'); }

    function setCharityActive(btn) {
        var root = charityRoot();
        if (!root) { return; }
        var btns = root.querySelectorAll('.ckt-charity__btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('is-active', btns[i] === btn);
        }
    }

    // Currency symbol for in-place money patches (set on <body> by the
    // layout via data-currency-symbol). Falls back to £.
    function curSym() {
        return (document.body && document.body.getAttribute('data-currency-symbol')) || '£';
    }
    function fmtMoney(n) { return curSym() + (Number(n) || 0).toFixed(2); }

    // ── Card service charge (card-only) on the main bill ────────────
    // True when the selected payment is any card (new or saved).
    function cardSelected() {
        try { return readPayMode().kind !== 'cash'; } catch (e) { return false; }
    }
    // Re-render the MAIN bill total = base grand + (card ? card charge : 0)
    // and toggle the "Card service charge" row. Driven by the selected
    // payment AND charity changes (both keep data-base-grand current).
    // Cash / COD shows the base total with no service charge.
    function renderMainTotal() {
        var totalEl = document.querySelector('[data-cart-grandtotal]');
        if (!totalEl) { return; }
        var base   = parseFloat(totalEl.getAttribute('data-base-grand')) || 0;
        var cc     = parseFloat(totalEl.getAttribute('data-card-charge')) || 0;
        var isCard = cardSelected();
        var row = document.querySelector('[data-cart-cardcharge-row]');
        if (row) { row.hidden = !(isCard && cc > 0); }
        var total = base + ((isCard && cc > 0) ? cc : 0);
        totalEl.textContent = fmtMoney(total);
        var cta = document.querySelector('[data-cart-cta-total]');
        if (cta) { cta.textContent = 'Continue · ' + fmtMoney(total); }
    }
    // Wire the main-bill total to react to payment-method changes: the
    // payment popup / tabs flip [data-cart-pay] data-ckt-pay-mode, which we
    // observe. Runs once on the cart page.
    function initCardChargeSync() {
        if (!document.querySelector('[data-cart-grandtotal]')) { return; }
        renderMainTotal();
        var payRow = document.querySelector('[data-cart-pay]');
        if (payRow && window.MutationObserver) {
            new MutationObserver(function () { renderMainTotal(); })
                .observe(payRow, { attributes: true, attributeFilter: ['data-ckt-pay-mode'] });
        }
    }

    // Patch the bill in place from a fresh cart view — the charity row,
    // the DONATED banner (company auto-donation + the customer's choice;
    // stays visible on "No" when the company still donates), the grand
    // total and the sticky CTA. No page reload, so the active button
    // state set optimistically in onCharity survives.
    function applyCharityToBill(cart) {
        if (!cart) { return; }
        var row = document.querySelector('[data-cart-charity-row]');
        if (row) {
            var rowAmt = row.querySelector('[data-cart-charity-amt]');
            if (rowAmt) { rowAmt.textContent = fmtMoney(cart.charityAmount); }
            row.hidden = !(Number(cart.charityAmount) > 0);
        }
        var don = document.querySelector('[data-cart-donated]');
        if (don) {
            var donAmt = don.querySelector('[data-cart-donated-amt]');
            if (donAmt) { donAmt.textContent = fmtMoney(cart.donatedTotal); }
            don.hidden = !(Number(cart.donatedTotal) > 0);
        }
        // Update the BASE grand on the total element, then re-render the
        // displayed total (which adds the card service charge when a card
        // is the selected payment).
        var gt = document.querySelector('[data-cart-grandtotal]');
        if (gt) { gt.setAttribute('data-base-grand', (Number(cart.grandtotal) || 0).toFixed(2)); }
        renderMainTotal();

        // Keep the review/confirm popup's totals in sync too, so opening it
        // after a charity change never shows a stale total.
        var pRow = document.querySelector('[data-ckt-confirm-charity-row]');
        if (pRow) {
            var pAmt = pRow.querySelector('[data-ckt-confirm-charity-amt]');
            if (pAmt) { pAmt.textContent = fmtMoney(cart.charityAmount); }
            pRow.hidden = !(Number(cart.charityAmount) > 0);
        }
        var pTotal = document.querySelector('[data-ckt-confirm-total]');
        if (pTotal) {
            // Update the BASE grand the confirm popup adds the card charge
            // onto (fillConfirmPayment recomputes the shown total on open).
            pTotal.setAttribute('data-ckt-base-grand', (Number(cart.grandtotal) || 0).toFixed(2));
            pTotal.textContent = fmtMoney(cart.grandtotal);
        }
        var pCta = document.querySelector('[data-ckt-confirm-cta-total]');
        if (pCta) { pCta.textContent = ' · ' + fmtMoney(cart.grandtotal); }
    }

    function saveCharity(amount, btn) {
        if (btn) { btn.disabled = true; }
        postCart('/cart/set-charity', { charity_amount: amount }).then(function (env) {
            // Quiet success (no toast on every tap); patch the bill in place.
            if (handleEnvelope(env, { successToast: false })) {
                applyCharityToBill(env.data && env.data.cart);
            }
            if (btn) { btn.disabled = false; }
        });
    }

    function onCharity(ev, btn) {
        ev.preventDefault();
        var mode   = btn.getAttribute('data-charity-mode');
        var root   = charityRoot();
        var custom = root && root.querySelector('[data-charity-custom]');

        // Custom → just reveal the input; we write once they enter a value.
        if (mode === 'custom') {
            setCharityActive(btn);
            if (custom) { custom.hidden = false; }
            var inp = custom && custom.querySelector('[data-charity-input]');
            if (inp) { inp.focus(); }
            return;
        }
        if (custom) { custom.hidden = true; }

        var amount = 0;
        if (mode === 'pct') {
            var sub = parseFloat(root && root.getAttribute('data-sub')) || 0;
            var pct = parseFloat(btn.getAttribute('data-charity-pct')) || 0;
            amount = Math.round(sub * pct / 100 * 100) / 100;
        }
        setCharityActive(btn);
        saveCharity(amount, btn);
    }

    function onCharityCustom(ev, btn) {
        ev.preventDefault();
        var root = charityRoot();
        var inp  = root && root.querySelector('[data-charity-input]');
        var raw  = inp ? String(inp.value).replace(/[^0-9.]/g, '') : '';
        var amount = parseFloat(raw);
        if (!isFinite(amount) || amount <= 0) { toast('error', 'Enter a charity amount.'); return; }
        saveCharity(Math.round(amount * 100) / 100, btn);
    }

    // ── Payment method picker + Stripe ──────────────────────────────
    // The cart UI carries [data-cart-pay] with a [data-stripe-key]
    // attribute. We lazy-init Stripe.js Elements when the customer
    // first picks the Card tab so a Cash-only checkout never touches
    // Stripe at all.
    var stripeApi = null;          // window.Stripe instance
    var stripeElements = null;     // Stripe.elements() bag
    var stripeCard = null;         // the mounted card element
    var stripeMethod = 'cash';     // 'cash' | 'card'

    function getPayRoot() { return document.querySelector('[data-cart-pay]'); }

    function paySetActive(tab) {
        var root = getPayRoot();
        if (!root) { return; }
        var tabs = root.querySelectorAll('.cart-pay__tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('is-active', tabs[i] === tab);
            tabs[i].setAttribute('aria-selected', tabs[i] === tab ? 'true' : 'false');
        }
    }

    function setHint(text) {
        var hint = document.querySelector('[data-cart-pay-hint]');
        if (hint) { hint.textContent = text; }
    }
    // The Stripe field + its error box live inside the payment popup on
    // the new checkout ([data-stripe-mount] under .ckt-popup__field) but
    // under .cart-pay__field on the legacy cart. getPayRoot() resolves
    // the [data-cart-pay] root which on the new page is the Payment ROW,
    // not the popup — so query the field GLOBALLY (the mount lives in
    // the popup partial) and fall back to the legacy class.
    function payFieldEl() {
        var mount = document.querySelector('[data-stripe-mount]');
        return (mount && mount.closest('.ckt-popup__field, .cart-pay__field'))
            || document.querySelector('.cart-pay__field');
    }
    function setError(msg) {
        var box = document.querySelector('[data-stripe-error]');
        var field = payFieldEl();
        if (box) {
            box.textContent = msg || '';
            box.hidden = !msg;
        }
        if (field) {
            field.classList.toggle('is-error', !!msg);
        }
    }

    function ensureStripe() {
        if (stripeApi) { return stripeApi; }
        var root = getPayRoot();
        var key  = root && root.getAttribute('data-stripe-key');
        if (!key || typeof window.Stripe !== 'function') { return null; }
        stripeApi = window.Stripe(key);
        return stripeApi;
    }

    function ensureCardElement() {
        if (stripeCard) { return stripeCard; }
        var stripe = ensureStripe();
        if (!stripe) { return null; }
        var mount = document.querySelector('[data-stripe-mount]');
        if (!mount) { return null; }
        stripeElements = stripe.elements();
        stripeCard = stripeElements.create('card', {
            hidePostalCode: true,
            style: {
                base:    { fontSize: '15px', color: '#0f172a', '::placeholder': { color: '#94a3b8' } },
                invalid: { color: '#e5252a' },
            },
        });
        stripeCard.mount(mount);
        stripeCard.on('change', function (event) {
            setError(event.error ? event.error.message : '');
        });
        stripeCard.on('focus', function () {
            var f = payFieldEl();
            if (f) { f.classList.add('is-focus'); }
        });
        stripeCard.on('blur', function () {
            var f = payFieldEl();
            if (f) { f.classList.remove('is-focus'); }
        });
        return stripeCard;
    }

    // Saves the card currently typed into the Elements field by
    // confirming a SetupIntent — the card is attached to the customer's
    // Stripe Customer and becomes a reusable saved card. Resolves with
    // the new payment_method id. Used by the payment popup's "Use this
    // method" when "Add a new card" + "Save this card" are chosen.
    function saveCardViaSetup() {
        var stripe = ensureStripe();
        var card   = ensureCardElement();
        if (!stripe || !card) { return Promise.reject(new Error('Card form isn\'t ready. Please refresh.')); }
        setError('');
        return postCart('/payment-method/setup', {}).then(function (env) {
            if (!env || env.status !== 200 || !env.data || !env.data.clientSecret) {
                throw new Error((env && env.msg) || 'Could not start card setup.');
            }
            return stripe.confirmCardSetup(env.data.clientSecret, {
                payment_method: { card: card },
            });
        }).then(function (result) {
            if (result.error) {
                setError(result.error.message || 'Card declined.');
                throw result.error;
            }
            if (!result.setupIntent || result.setupIntent.status !== 'succeeded') {
                throw new Error('Card could not be saved. Please try again.');
            }
            return result.setupIntent.payment_method;   // new pm_… id
        });
    }

    function onCartSetPay(ev, btn) {
        ev.preventDefault();
        var method = btn.getAttribute('data-pay') || 'cash';
        if (method === stripeMethod) { return; }
        stripeMethod = method;
        paySetActive(btn);
        var panel = document.querySelector('[data-cart-card-panel]');
        if (panel) { panel.hidden = (method !== 'card'); }
        if (method === 'card') {
            setHint('Pay securely with your card. You\'ll see the charge instantly.');
            ensureCardElement();
        } else {
            setHint('Pay with cash on ' + (cashLabel()) + '.');
            setError('');
        }
        // Card adds the service charge; cash removes it.
        renderMainTotal();
    }

    function cashLabel() {
        // Tiny inference — find an active mode tab to know if it's pickup.
        // The new checkout uses `.ckt-mode__tab`; the legacy cart used
        // `.cart-mode__tab`. Match both so the confirm dialog reads
        // correctly on Pickup orders regardless of which page is up.
        var picked = document.querySelector('.ckt-mode__tab.is-active, .cart-mode__tab.is-active');
        return (picked && picked.getAttribute('data-mode') === '2') ? 'pickup' : 'delivery';
    }

    // Read the customer's chosen payment method from the new checkout
    // row attribute. Returns { kind: 'cash' | 'card-new' | 'card-saved',
    // paymentMethodId?: string }. Falls back to the legacy stripeMethod
    // when the new attribute isn't present (e.g. an older cart EJS).
    function readPayMode() {
        var row = document.querySelector('[data-cart-pay]');
        var raw = row && row.getAttribute('data-ckt-pay-mode');
        if (!raw) {
            return stripeMethod === 'card' ? { kind: 'card-new' } : { kind: 'cash' };
        }
        if (raw === 'cash')     { return { kind: 'cash' }; }
        if (raw === 'new-card') { return { kind: 'card-new' }; }
        if (raw.indexOf('card:') === 0) {
            return { kind: 'card-saved', paymentMethodId: raw.slice(5) };
        }
        return { kind: 'cash' };
    }

    // Global in-flight guard. The desktop CTA (.ckt-cta) and the mobile
    // sticky CTA (.ckt-sticky-cta) BOTH carry data-action="cart-checkout";
    // disabling only the clicked button leaves the other one live, so a
    // fast double-tap (or a viewport that shows both) could fire two
    // POST /order/place calls. This module-level flag blocks the second.
    var checkoutInFlight = false;

    // Place order — branches by chosen method. The review-order popup
    // ("Review your order") is the single confirmation step now, so the
    // cash path no longer raises its own confirm dialog — clicking
    // "Place order" in that popup IS the confirmation.
    function onCartCheckout(ev, btn) {
        ev.preventDefault();
        if (btn.disabled || checkoutInFlight) { return; }

        var mode = readPayMode();
        if (mode.kind === 'card-new')   { return doCardCheckout(btn, mode); }
        if (mode.kind === 'card-saved') { return doCardCheckout(btn, mode); }

        // Cash — place directly (the review popup already confirmed).
        checkoutInFlight = true;
        runPlace(btn, { payment_option: 1 });
        return;
        // (unreachable code below kept out — see history)
    }

    function doCardCheckout(btn, mode) {
        var stripe = ensureStripe();
        if (!stripe) {
            toast('error', 'Card payments aren\'t ready. Please refresh and try again.');
            return;
        }
        // The Card Element is only required for the NEW-card path; for
        // a saved card the payment_method id is enough.
        var card = mode.kind === 'card-new' ? ensureCardElement() : null;
        if (mode.kind === 'card-new' && !card) {
            toast('error', 'Card form is not ready. Please refresh and try again.');
            return;
        }
        checkoutInFlight = true;
        btn.disabled = true;
        // The new CTA button is .ckt-cta (also .ckt-sticky-cta on mobile).
        // Fall back to the legacy .cart-summary__cta-total selector for any
        // page still using the old markup.
        var origLabel = btn.querySelector('span:not(.cart-summary__cta-total)') || btn;
        var orig = origLabel.textContent;
        origLabel.textContent = 'Preparing payment...';
        setError('');

        // 1. Create PaymentIntent on the server (amount = fresh cart total).
        // save_card consent only meaningful for a brand-new card.
        var saveBox = document.querySelector('[data-cart-save-card]');
        var saveCard = mode.kind === 'card-new' && !!(saveBox && saveBox.checked);
        postCart('/payment/intent', { save_card: saveCard }).then(function (env) {
            if (!env || env.status !== 200) {
                throw new Error((env && env.msg) || 'Could not start the payment.');
            }
            var clientSecret = env.data && env.data.clientSecret;
            var intentId     = env.data && env.data.intentId;
            if (!clientSecret || !intentId) { throw new Error('Payment configuration error.'); }

            // 2. Confirm the card payment in the browser (handles 3DS).
            origLabel.textContent = 'Confirming card...';
            var confirmArg = (mode.kind === 'card-saved')
                ? { payment_method: mode.paymentMethodId }
                : { payment_method: { card: card } };
            return stripe.confirmCardPayment(clientSecret, confirmArg).then(function (result) {
                if (result.error) {
                    setError(result.error.message || 'Card declined.');
                    throw result.error;
                }
                if (!result.paymentIntent || result.paymentIntent.status !== 'succeeded') {
                    throw new Error('Payment did not complete. Please try again.');
                }
                return result.paymentIntent.id;
            });
        }).then(function (paidIntentId) {
            // 3. Place the order — server re-verifies the intent.
            origLabel.textContent = 'Placing order...';
            return postCart('/order/place', {
                payment_option:    2,
                payment_intent_id: paidIntentId,
            }).then(function (env) {
                if (!env) { throw new Error('Could not reach the server.'); }
                if (env.status === 401) {
                    window.location.href = '/signin?next=' + encodeURIComponent('/cart');
                    return;
                }
                if (env.status !== 200) {
                    throw new Error(env.msg || 'Could not place the order.');
                }
                bumpCartBadge(null);
                var oid = (env.data && env.data.order && env.data.order.id) || '';
                window.location.href = '/order/' + encodeURIComponent(oid) + '/confirm';
            });
        }).catch(function (err) {
            toast('error', (err && err.message) || 'Payment failed.');
        }).then(function () {
            // Only release the guard on FAILURE — on success we've already
            // navigated to /order/:id/confirm and don't want a flash of an
            // active CTA before the page unloads.
            origLabel.textContent = orig;
            btn.disabled = false;
            checkoutInFlight = false;
        });
    }

    function runPlace(btn, body) {
        btn.disabled = true;
        var origLabel = btn.querySelector('span:not(.cart-summary__cta-total)') || btn;
        var orig = origLabel.textContent;
        origLabel.textContent = 'Placing...';
        postCart('/order/place', body)
            .then(function (env) {
                if (!env) { toast('error', 'Could not reach the server.'); return; }
                if (env.status === 401) {
                    window.location.href = '/signin?next=' + encodeURIComponent('/cart');
                    return;
                }
                if (env.status !== 200) {
                    toast('error', env.msg || 'Could not place the order.');
                    return;
                }
                bumpCartBadge(null);
                var oid = (env.data && env.data.order && env.data.order.id) || '';
                window.location.href = '/order/' + encodeURIComponent(oid) + '/confirm';
            })
            .catch(function () { toast('error', 'Could not place the order.'); })
            .then(function () {
                origLabel.textContent = orig;
                btn.disabled = false;
                checkoutInFlight = false;
            });
    }

    // ── Badge sync on mount + tab return ────────────────────────────
    // Server-side renders the badge from req.session.cartCount, but
    // another tab might have changed the cart while this page was open.
    // One refresh on DOMContentLoaded + one on each visibility-return
    // keeps every tab agreeing without a polling loop.
    function onReady() {
        // Only refresh when a header badge actually exists — pages that
        // hide the header (signin/OTP) skip this gracefully.
        if (document.querySelector('[data-cart-count]')) { refreshCartBadge(); }
        // Cart page: sync the bill total with the selected payment (card
        // service charge) on load + whenever the payment method changes.
        initCardChargeSync();
        // Surface a just-completed "Reorder" result (incl. any skipped
        // items) once we land on /cart.
        try {
            var rmsg = sessionStorage.getItem('reorder.msg');
            if (rmsg) { sessionStorage.removeItem('reorder.msg'); toast('success', rmsg); }
        } catch (e) { /* ignore */ }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && document.querySelector('[data-cart-count]')) {
            refreshCartBadge();
        }
    });

    // ── Single document delegate ────────────────────────────────────
    document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('[data-action]');
        if (!btn) { return; }
        var action = btn.getAttribute('data-action');
        switch (action) {
            case 'pd-add':          return onAddClick(ev, btn);
            case 'rd-add':          return onQuickAdd(ev, btn);
            case 'cart-qty-inc':    return onCartStep(ev, btn, +1);
            case 'cart-qty-dec':    return onCartStep(ev, btn, -1);
            case 'cart-remove':     return onCartRemove(ev, btn);
            case 'cart-clear':      return onCartClear(ev, btn);
            case 'cart-set-mode':       return onCartSetMode(ev, btn);
            case 'cart-address-toggle': return onAddressToggle(ev, btn);
            case 'cart-set-address':    return onSetAddress(ev, btn);
            case 'cart-sched-asap':     return onSchedAsap(ev, btn);
            case 'cart-sched-pick':     return onSchedPick(ev, btn);
            case 'cart-sched-save':     return onSchedSave(ev, btn);
            case 'cart-apply-coupon':   return onApplyCoupon(ev, btn);
            case 'cart-remove-coupon':  return onRemoveCoupon(ev, btn);
            case 'cart-apply-voucher':  return onApplyVoucher(ev, btn);
            case 'cart-remove-voucher': return onRemoveVoucher(ev, btn);
            case 'cart-apply-loyalty':  return onApplyLoyalty(ev, btn);
            case 'cart-remove-loyalty': return onRemoveLoyalty(ev, btn);
            case 'cart-charity':        return onCharity(ev, btn);
            case 'cart-charity-custom': return onCharityCustom(ev, btn);
            case 'cart-set-pay':        return onCartSetPay(ev, btn);
            case 'cart-checkout':       return onCartCheckout(ev, btn);
        }
    });

    // Exposed for sibling UI modules that drive the cart from their own
    // flows (e.g. the product modal posts to /cart/add directly and
    // wants the same canonical badge bump + animation).
    window.EatNDealCart = {
        bumpCartBadge:    bumpCartBadge,
        refreshCartBadge: refreshCartBadge,
        flyToCart:        flyToCart,
        // Lets the checkout-popups module mount Stripe Elements on
        // demand when the customer picks "Add a new card" in the
        // payment sheet — we don't load Stripe.js until it's needed.
        ensureCardElement: ensureCardElement,
        // Saves the typed card via a SetupIntent; resolves with the new
        // payment_method id (used by the payment popup's "Use this method").
        saveCardViaSetup: saveCardViaSetup,
    };
})();
