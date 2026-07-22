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
        // ALL badges — the header cart (desktop) AND the bottom-nav cart
        // (mobile) both carry [data-cart-count]; querySelectorAll keeps them
        // both in sync (a single querySelector only updated the header one,
        // leaving the mobile bottom-nav badge stale).
        var badges = document.querySelectorAll('[data-cart-count]');
        if (!badges.length) { return; }
        var n = Number(qty) || 0;
        Array.prototype.forEach.call(badges, function (badge) {
            var prev = parseInt(badge.textContent || '0', 10) || 0;
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
        });
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
        // Fly to whichever cart entry point is actually ON-SCREEN: the
        // bottom-nav Cart tab on mobile (fly DOWN — the cart moved there from
        // the header) or the header cart on desktop (fly UP). A display:none
        // element returns a zero-size rect, so the size check skips the hidden
        // one automatically (this is why it used to fly to 0,0 / "up" on mobile
        // once the header cart was hidden).
        var candidates = [
            document.querySelector('.bottom-nav__item--cart .bottom-nav__icon'),
            document.querySelector('.bottom-nav__item--cart'),
            document.querySelector('.header-quick__cart'),
        ];
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (!el) { continue; }
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
        }
        return null;
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
    // One in-flight request per (url, body) pair at a time. Keyed on the
    // serialized body too — NOT the URL alone — because several distinct
    // actions post to the same endpoint with different bodies (e.g. the
    // charity tiers all POST /cart/set-charity with a different amount;
    // the schedule tabs both POST /cart/set-schedule). A URL-only lock
    // would silently drop a legitimate second tap on a different tier
    // while the first tier's request was still in flight. A duplicate
    // tap on the SAME action (identical body) is still coalesced, which
    // is the case we actually want to guard against (double-tap "Apply").
    var inFlight = {};

    // DISCARDED — private sentinel for the two "say nothing, this was a
    // deliberate no-op" outcomes below (duplicate call already in flight,
    // or response superseded by a newer request). It is deliberately NOT
    // the same value as a genuine failure: `null` is reserved for that.
    // Do not collapse the two back into one value — handleEnvelope relies
    // on telling them apart to decide whether to toast an error.
    var DISCARDED = {};

    /**
     * postCart — POST a cart action. Resolves the DISCARDED sentinel (no
     * request sent, and no error) for a repeat call for the same (url,
     * body) while one is already running, and for a response that a newer
     * request has already superseded (per window.CartRender's stale-ticket
     * check), so two taps can never land their responses out of order.
     * Resolves null — a genuine failure — when the network request itself
     * fails (fetch rejects) or the response body can't be parsed as JSON
     * (e.g. a 500 HTML error page, a truncated body).
     *
     * `noTicket` — explicit opt-out from the CartRender ticket. Only calls
     * whose response actually swaps the cart regions (i.e. every call that
     * goes through handleEnvelope with opts.reload) need a ticket at all —
     * it exists purely to let a newer region-swapping request discard a
     * stale one. /payment/intent, /cart/pay-saved-card and /order/place
     * never swap regions, so taking a ticket for them was meaningless and,
     * worse, could mark a LATER genuine cart write's response stale (e.g. a
     * cart edit fired while checkout was mid-flight), silently discarding
     * it. Pass true here for any call site that does not feed its envelope
     * into handleEnvelope's reload path.
     * Type: WRITE (network).
     */
    function postCart(path, body, noTicket) {
        var key = path + '|' + JSON.stringify(body || {});
        if (inFlight[key]) { return Promise.resolve(DISCARDED); }
        inFlight[key] = true;
        var ticket = (!noTicket && window.CartRender) ? window.CartRender.begin() : 0;

        return fetch(path, {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify(body || {}),
        }).then(function (r) {
            // JSON parse failure is a genuine failure, not a discard.
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            inFlight[key] = false;
            if (!noTicket && window.CartRender && window.CartRender.isStale(ticket)) { return DISCARDED; }
            return env;
        }).catch(function () {
            inFlight[key] = false;
            return null;
        });
    }

    // ── Envelope handler (401 / 409 conflict / 422 / 200) ───────────
    function handleEnvelope(env, opts) {
        opts = opts || {};
        // The request has settled (it will reload, error, or conflict) — tell any
        // open checkout popup to drop its "busy" state so it never hangs.
        document.dispatchEvent(new CustomEvent('ckt:settle-done'));
        // DISCARDED = the request was skipped (already in flight for the
        // same action) or its response was superseded by a newer one.
        // Neither is an error — say nothing and just leave the screen as-is.
        if (env === DISCARDED) { return false; }
        // null (and any other falsy value) = a genuine failure: fetch()
        // rejected, or the response body wasn't valid JSON. Keep toasting
        // this exactly as before — do not fold it into the DISCARDED case.
        if (!env) { toast('error', 'Could not reach the server.'); return false; }
        if (env.status === 401) {
            // opts.authMessage — for small, optional tweaks (charity tier)
            // yanking a guest to /signin loses the page they were building.
            // Tell them what to do instead and leave the cart alone.
            if (opts.authMessage) { toast('error', opts.authMessage); return false; }
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
        // Swap the freshly rendered regions in. `opts.reload` is kept as the
        // flag name at the call sites: it still means "this action changed the
        // cart, refresh the view" — it just no longer costs a page load.
        if (opts.reload) {
            // Capture the customer's CURRENT payment-method choice before the
            // main region is swapped out — partials/cart/main.ejs hardcodes
            // data-ckt-pay-mode="cash" on the fresh markup, so without this the
            // server's default silently overwrote a customer's Card choice on
            // every swap (pick Card, bump a quantity, bill reverts to cash
            // pricing). The 'eatndeal:cart-updated' listener below re-applies
            // it to the new node once the swap has happened.
            var payRootBefore = document.querySelector('[data-cart-pay]');
            payModeBeforeSwap = payRootBefore ? payRootBefore.getAttribute('data-ckt-pay-mode') : null;
            var swapped = env.data && env.data.html && window.CartRender
                ? window.CartRender.swap(env.data.html)
                : false;
            // No fragments came back (older response shape, or the render
            // failed server-side) — fall back to the reload so the customer
            // still sees a correct cart rather than a stale one.
            if (!swapped) {
                window.location.reload();
            } else {
                // The main/side swap deliberately skipped the popups region
                // because a popup may be open (protecting Stripe / typed
                // input). Tell the popup layer the write SUCCEEDED so it can
                // close a pick-and-done popup (address / promo / schedule) and
                // re-render the popup markup to the new state — otherwise the
                // popup stays open on a reload-era assumption, and re-opening
                // shows the OLD selection. Carries the fresh popups html.
                document.dispatchEvent(new CustomEvent('ckt:settle-ok', {
                    detail: { popups: (env.data && env.data.html && env.data.html.popups) || '' },
                }));
            }
        }
        return true;
    }

    // ── Closed-restaurant gate ──────────────────────────────────────
    // On the restaurant detail page the root carries the live open state
    // (data-rd-open) + whether it takes pre-orders (data-rd-preorder). A
    // CLOSED restaurant that doesn't take pre-orders should tell the customer
    // it's closed up front — instead of firing /cart/add and surfacing a
    // confusing server error. Returns a message to block with, or null to
    // proceed. On pages without the root (product page / cart) it returns null
    // and the api's own store-hours guard still enforces the rule.
    function restaurantClosedMessage() {
        var root = document.querySelector('[data-restaurant][data-rd-open]');
        if (!root) { return null; }
        var isOpen   = root.getAttribute('data-rd-open') === '1';
        var preOrder = root.getAttribute('data-rd-preorder') === '1';
        if (isOpen || preOrder) { return null; }
        return 'This restaurant is currently closed.';
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

    // Read the customer's ACTIVE order mode as a serve_type (2=pickup,
    // 3=delivery) from whichever control is on the page — so a fresh cart is
    // created in the chosen mode and the "doesn't deliver here" gate is skipped
    // for a Collection/Pickup order. Priority: restaurant fulfilment tab →
    // cart-page mode tab → header Delivery/Pickup toggle → default delivery.
    function readOrderMode() {
        var rd = document.querySelector('.rd-tab.is-active[data-rd-tab]');
        if (rd) { return rd.getAttribute('data-rd-tab') === 'pickup' ? 2 : 3; }
        var ck = document.querySelector('.ckt-mode__tab.is-active[data-mode]');
        if (ck) { return ck.getAttribute('data-mode') === '2' ? 2 : 3; }
        var hd = document.querySelector('input[name="order-mode"]:checked');
        if (hd) { return hd.value === 'pickup' ? 2 : 3; }
        return 3;
    }

    function doAddToCart(productRoot, btn, replace) {
        var body = {
            product_id: productRoot.getAttribute('data-product-id'),
            qty:        readQty(productRoot),
            options:    collectOptions(productRoot),
            remark:     readNote(productRoot),
            serve_type: readOrderMode(),
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
        var closed = restaurantClosedMessage();
        if (closed) { toast('error', closed); return; }
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
        var body = { product_id: productId, qty: 1, options: [], remark: '', serve_type: readOrderMode() };
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

    /**
     * hasRequiredOptions — true when this product can't be added blind.
     *
     * The menu card carries no option data, so we ask the same endpoint the
     * item sheet uses. It needs the restaurant slug as well as the id (an id
     * on its own 404s), which is why the Add button renders data-rest.
     * Any failure resolves false — a network hiccup must never block ordering.
     */
    function hasRequiredOptions(params) {
        var qs = new URLSearchParams();
        if (params.id)   { qs.set('id',   params.id); }
        if (params.rest) { qs.set('rest', params.rest); }
        if (params.item) { qs.set('item', params.item); }
        return fetch('/product/json?' + qs.toString(), {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              if (!env || env.status !== 200 || !env.data) { return false; }
              var any = function (list) {
                  return (list || []).some(function (g) {
                      return (g && g.required) || any(g && g.groups);
                  });
              };
              return any(env.data.groups);
          })
          .catch(function () { return false; });
    }

    function onQuickAdd(ev, btn) {
        ev.preventDefault();
        ev.stopPropagation();   // Don't let bindProductClick navigate to the detail page.
        var closed = restaurantClosedMessage();
        if (closed) { toast('error', closed); return; }
        if (btn.disabled) { return; }
        btn.disabled = true;

        var params = {
            id:   btn.getAttribute('data-id')   || '',
            rest: btn.getAttribute('data-rest') || '',
            item: btn.getAttribute('data-item') || '',
        };
        // A product with required choices (sauce, size, …) can't go in on one
        // tap — it would be added at the base price with nothing chosen. Open
        // the item sheet so the customer picks, exactly as tapping the card
        // does. Everything else still adds in a single tap.
        hasRequiredOptions(params).then(function (mustChoose) {
            btn.disabled = false;
            if (mustChoose && window.EatNDealUi && window.EatNDealUi.productModal) {
                window.EatNDealUi.productModal.open(params);
                return;
            }
            btn.disabled = true;
            // Fly animation is fired by doQuickAdd on a successful response.
            return doQuickAdd(btn, false)
                .catch(function () { toast('error', 'Could not add to cart.'); })
                .then(function () { btn.disabled = false; });
        });
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
        // Same early-return trap as the coupon field: this button dims the
        // popup, so bailing out has to un-dim it. See cancelSettle.
        if (!val) { cancelSettle(); toast('error', 'Pick a date and time first.'); return; }
        btn.disabled = true;
        postCart('/cart/set-schedule', { is_pre_order: true, scheduled_at: val }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }

    // Coupon flow: Apply reads the input + POSTs the code; Remove
    // wipes the applied coupon from the cart.
    /**
     * cancelSettle
     *
     * What:  Tells an open checkout popup that the click it just dimmed itself
     *        for is over — used when we bail out BEFORE any request.
     * Why:   checkout-popups.js greys the sheet the moment an apply-style button
     *        is pressed, and only un-greys on 'ckt:settle-done' (normally fired
     *        by handleEnvelope) or after an 8-second timeout. An early return —
     *        "Enter a coupon code." — fired neither, so the popup sat disabled
     *        for eight seconds with no request in flight.
     */
    function cancelSettle() {
        // Deferred by a tick ON PURPOSE. Both modules listen for the same click
        // on `document`, and this one runs FIRST — firing the event straight
        // away told checkout-popups.js "done" before it had even applied the
        // dim, so the dim then went on and stayed for the full 8s timeout.
        // A 0ms timeout puts us after every handler for this click.
        window.setTimeout(function () {
            document.dispatchEvent(new CustomEvent('ckt:settle-done'));
        }, 0);
    }

    /** Show a validation message inside the popup, next to the field. */
    function setCouponError(msg) {
        var box = document.querySelector('[data-coupon-error]');
        if (box) {
            box.textContent = msg || '';
            box.hidden = !msg;
            return;
        }
        if (msg) { toast('error', msg); }     // popup not on the page
    }

    function onApplyCoupon(ev, btn) {
        ev.preventDefault();
        var panel = btn.closest('[data-cart-coupon]');
        var input = panel && panel.querySelector('[data-cart-coupon-input]');
        var code  = input ? input.value.trim() : '';
        if (!code) {
            cancelSettle();                    // drop the dim straight away
            setCouponError('Enter a coupon code.');
            if (input) { input.focus(); }
            return;
        }
        setCouponError('');                    // clear a previous message
        btn.disabled = true;
        postCart('/cart/apply-coupon', { code: code }).then(function (env) {
            handleEnvelope(env, { reload: true });
            if (!env || env.status !== 200) { btn.disabled = false; }
        });
    }
    // Removing a promo is destructive (the saving disappears), so ask
    // for confirmation first — same pattern as clearing the cart.
    function onRemoveCoupon(ev, btn) {
        ev.preventDefault();
        confirm({
            title:   'Remove this promo?',
            message: 'The discount will be taken off your order. You can apply another promo afterwards.',
            okLabel: 'Remove promo',
        }).then(function (ok) {
            if (!ok) { return; }
            btn.disabled = true;
            return postCart('/cart/remove-coupon', {}).then(function (env) {
                handleEnvelope(env, { reload: true });
                if (!env || env.status !== 200) { btn.disabled = false; }
            });
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
    // True when the bill comes to nothing (discount/voucher/reward covers it
    // all). Such orders are still placeable — but Cash only, since there is
    // no amount for Stripe to take. Reads the base grand so the card service
    // charge doesn't mask a £0 bill.
    function zeroTotal() {
        var el = document.querySelector('[data-cart-grandtotal]');
        if (!el) { return false; }
        return (parseFloat(el.getAttribute('data-base-grand')) || 0) <= 0;
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

    /**
     * onSaveCooking
     *
     * What:  Persists the kitchen note (cart.remark) via
     *        /cart/set-cooking-instructions. Separate endpoint from the
     *        driver drop-off note — this one applies to Pickup too, so it
     *        must NOT ride on the delivery-instructions save.
     * Type:  WRITE.
     */
    function onSaveCooking(ev, btn) {
        ev.preventDefault();
        var box = document.querySelector('[data-ckt-cooking-note]');
        if (!box) { return; }
        btn.disabled = true;
        postCart('/cart/set-cooking-instructions', { instructions: box.value.trim().slice(0, 250) })
            .then(function (env) {
                btn.disabled = false;
                handleEnvelope(env);
            });
    }

    // Live character counter — the textarea is capped at 250 (legacy's
    // maxlength), and a silent cap reads as the field eating input.
    document.addEventListener('input', function (ev) {
        var box = ev.target && ev.target.closest && ev.target.closest('[data-ckt-cooking-note]');
        if (!box) { return; }
        var out = document.querySelector('[data-ckt-cooking-count]');
        if (out) { out.textContent = String(box.value.length); }
    });

    function saveCharity(amount, btn) {
        if (btn) { btn.disabled = true; }
        postCart('/cart/set-charity', { charity_amount: amount }).then(function (env) {
            // Quiet success (no toast on every tap); patch the bill in place.
            if (handleEnvelope(env, { successToast: false, authMessage: 'Please sign in to change your charity contribution.' })) {
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
    var stripeAccountUsed = null;  // connected account the instance is bound to (direct charge)
    var payElements = null;        // Stripe.elements() bag (Payment Element)
    var payElement = null;         // the mounted Payment Element
    var payElementPromise = null;  // in-flight init (create intent + mount)
    var payIntentId = null;        // the pre-created PaymentIntent id (new card / wallet)
    var checkoutEle = null;        // Stripe Checkout Elements SDK (legacy initCheckoutElementsSdk)
    var checkoutActions = null;    // its actions: updateEmail, confirm
    var paySessionId = null;       // the Checkout Session id — order is placed with this
    var stripeMethod = 'cash';     // 'cash' | 'card'
    // The customer's data-ckt-pay-mode value as it stood immediately before a
    // region swap, so it can be re-applied to the fresh [data-cart-pay] node
    // once 'eatndeal:cart-updated' fires (see handleEnvelope + the listener
    // near initCardChargeSync below). null when there's nothing to restore.
    var payModeBeforeSwap = null;

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

    // Show a spinner in place of the (still-empty) card box while the secure
    // payment form is being created, then swap back once it's mounted/failed.
    function setPayLoading(on) {
        var mount   = document.querySelector('[data-stripe-mount]');
        var loading = document.querySelector('[data-stripe-loading]');
        if (loading) { loading.hidden = !on; }
        if (mount)   { mount.hidden   = !!on; }
    }

    function ensureStripe(account) {
        var acct = account || null;
        // Stripe Connect DIRECT charge — Stripe.js MUST be bound to the
        // restaurant's connected account so the Payment Element confirms on it.
        if (acct && stripeAccountUsed !== acct) {
            var rootA = getPayRoot();
            var keyA  = rootA && rootA.getAttribute('data-stripe-key');
            if (!keyA || typeof window.Stripe !== 'function') { return null; }
            stripeApi = window.Stripe(keyA, { stripeAccount: acct });
            stripeAccountUsed = acct;
            return stripeApi;
        }
        if (stripeApi) { return stripeApi; }   // confirm step reuses the bound instance
        var root = getPayRoot();
        var key  = root && root.getAttribute('data-stripe-key');
        if (!key || typeof window.Stripe !== 'function') { return null; }
        stripeApi = window.Stripe(key);
        return stripeApi;
    }

    // Lazily build the Stripe PAYMENT ELEMENT — the FULL Stripe screen
    // (card + Apple Pay / Google Pay / Link + every method enabled on the
    // account), not a bare card field. Intent-FIRST: we create the
    // PaymentIntent up front so Elements mounts with its client secret;
    // at place-time we just confirm it (no elements.submit(), so the
    // mounted-but-hidden element confirms cleanly). Resolves with the
    // element, or null when Stripe / the mount isn't ready. Idempotent —
    // pass forceRecreate to rebuild after the "Save this card" choice
    // changes (a fresh intent is needed for setup_future_usage).
    function ensurePaymentElement(forceRecreate) {
        if (payElementPromise && !forceRecreate) { return payElementPromise; }
        if (forceRecreate) { teardownPaymentElement(); }
        var mount  = document.querySelector('[data-stripe-mount]');
        if (!mount || typeof window.Stripe !== 'function') { return Promise.resolve(null); }

        setError('');
        setPayLoading(true);   // spinner until the card form is mounted (or fails)

        // EXACT legacy flow (delivery.js): the backend created a Checkout Session
        // ON the restaurant's connected account; mount it with the Checkout
        // Elements SDK (initCheckoutElementsSdk) and confirm later via
        // checkoutActions.confirm(). No saved cards on a direct charge (the
        // platform Stripe Customer can't be used on a connected account).
        payElementPromise = postCart('/payment/intent', {}, true).then(function (env) {
            // This path doesn't go through handleEnvelope, so it never had a
            // silent branch — DISCARDED must keep failing the same way `null`
            // always did here, otherwise it would fall through and read
            // properties off the {} sentinel as if it were a real envelope.
            if (env === DISCARDED) { env = null; }
            if (!env || env.status !== 200 || !env.data || !env.data.clientSecret) {
                throw new Error((env && env.msg) || 'Could not start the payment.');
            }
            var stripe = ensureStripe(env.data.stripeAccount);   // bind to the connected account (direct charge)
            if (!stripe || typeof stripe.initCheckoutElementsSdk !== 'function') {
                throw new Error('Could not start the payment.');
            }
            paySessionId = env.data.sessionId;
            checkoutEle  = stripe.initCheckoutElementsSdk({ clientSecret: env.data.clientSecret });
            return checkoutEle.loadActions().then(function (loaded) {
                if (!loaded || loaded.type !== 'success' || !loaded.actions) {
                    throw new Error('Could not start the payment.');
                }
                checkoutActions = loaded.actions;
                var emailEl = document.querySelector('[data-customer-email]');
                var email   = (emailEl && (emailEl.value || emailEl.getAttribute('data-customer-email'))) || '';
                if (email && checkoutActions.updateEmail) { checkoutActions.updateEmail(email); }
                setPayLoading(false);   // reveal the card box, then mount into it
                // A FRESH element starts empty — clear any completeness left
                // over from an earlier card, or "Use this method" would accept
                // a blank form on the strength of the last one.
                var payRootEl = getPayRoot();
                if (payRootEl) { payRootEl.setAttribute('data-pay-complete', '0'); }
                payElement = checkoutEle.createPaymentElement({ wallets: { applePay: 'auto', googlePay: 'auto' } });
                if (payElement.on) {
                    payElement.on('change', function (event) {
                        setError(event && event.error ? event.error.message : '');
                        // Record whether Stripe considers the details COMPLETE.
                        // checkout-popups.js reads this before it lets "Use this
                        // method" close the sheet — without it a half-typed (or
                        // empty) card was accepted and the cart showed "New card"
                        // as if a real method had been chosen.
                        // Passed via the DOM because the two modules are separate
                        // IIFEs with no shared object; every other cross-module
                        // signal here works the same way.
                        var root = getPayRoot();
                        if (root) {
                            root.setAttribute('data-pay-complete', (event && event.complete) ? '1' : '0');
                        }
                    });
                }
                // Resolve ONLY after the element has mounted AND emitted 'ready'.
                // Stripe throws "Please ensure that the Payment Element is mounted
                // and the ready event has been emitted before calling confirm()"
                // when confirm() runs first (Place Order tapped before the form
                // finished loading). The timeout is a safety net if 'ready' never
                // fires (older SDK) so the promise can't hang forever.
                return new Promise(function (resolve) {
                    var settled = false;
                    var finish  = function () { if (!settled) { settled = true; resolve(payElement); } };
                    if (payElement.on) { payElement.on('ready', finish); }
                    payElement.mount(mount);
                    window.setTimeout(finish, 6000);
                });
            });
        }).catch(function (err) {
            setPayLoading(false);   // drop the spinner; show the error in its place
            setError((err && err.message) || 'Could not start the payment.');
            payElementPromise = null;   // let the next pick retry
            return null;
        });
        return payElementPromise;
    }

    // Tear down a mounted Payment Element so it can be rebuilt with a fresh
    // intent (e.g. the "Save this card" choice changed, or a retry after a
    // declined payment).
    function teardownPaymentElement() {
        try { if (payElement) { payElement.unmount(); } } catch (e) { /* ignore */ }
        payElement = null; payElements = null; payElementPromise = null; payIntentId = null;
        checkoutEle = null; checkoutActions = null; paySessionId = null;
    }

    /**
     * teardownPaymentElementForSwap
     *
     * What:  Hook called by ui/cart-render.js immediately before it replaces
     *        the popups region's innerHTML. Tears down a mounted Payment
     *        Element (if any) so the memoised payElementPromise is cleared.
     * Why:   [data-stripe-mount] lives inside the popups region. Closing the
     *        payment popup leaves the element mounted-but-hidden; any later
     *        cart action swaps the popups region and detaches that node from
     *        the document while payElementPromise still points at it. On the
     *        next open, ensurePaymentElement() would hand back that stale
     *        promise instead of re-mounting — an empty, un-payable card box.
     *        Tearing down here means the next open always starts clean.
     * Type:  WRITE (module state).
     */
    function teardownPaymentElementForSwap() {
        if (payElement || payElementPromise) { teardownPaymentElement(); }
    }

    // Back-compat shim: checkout-popups.js calls ensureCardElement() to
    // mount the field when "Add a new card" is picked. It now builds the
    // full Payment Element. Fire-and-forget (mounts when the intent is ready).
    function ensureCardElement() { return ensurePaymentElement(false); }

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

        // Guest cart → login is required at CHECKOUT (not at add-to-cart).
        // Send them to sign in; on return to /cart their guest cart is
        // adopted into their account and they can place the order.
        var root = document.querySelector('[data-cart-root]');
        if (root && root.getAttribute('data-cart-guest') === '1') {
            window.location.href = '/signin?next=' + encodeURIComponent('/cart');
            return;
        }

        var mode = readPayMode();
        // £0 total (fully discounted) — Stripe has nothing to charge, so the
        // order can only go through as Cash. Mirrors the API guard.
        if (mode.kind !== 'cash' && zeroTotal()) {
            toast('error', 'Your total is £0.00 — please select Cash to place this order.');
            return;
        }
        if (mode.kind === 'card-new')   { return doCardCheckout(btn, mode); }
        if (mode.kind === 'card-saved') { return doCardCheckout(btn, mode); }

        // Cash — place directly (the review popup already confirmed).
        checkoutInFlight = true;
        runPlace(btn, { payment_option: 1 });
        return;
        // (unreachable code below kept out — see history)
    }

    // Read + validate the receipt email in the card panel. Stripe's Checkout
    // Session confirm() REQUIRES an email; phone-OTP customers often have none
    // on file, so the field lets them add one. Returns the trimmed address, or
    // '' (with an inline error shown + the field focused) when it's missing or
    // malformed — the caller aborts BEFORE touching the mounted card form, so a
    // bad email never wipes the card the user already typed.
    function readCheckoutEmail() {
        var el  = document.querySelector('[data-customer-email]');
        var err = document.querySelector('[data-email-error]');
        var val = (el && el.value ? el.value : '').trim();
        var ok  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
        if (err) { err.hidden = ok; err.textContent = ok ? '' : (val ? 'Enter a valid email address.' : 'Enter an email so we can send your receipt.'); }
        if (!ok && el) { try { el.focus(); } catch (e) { /* ignore */ } }
        return ok ? val : '';
    }

    function doCardCheckout(btn, mode) {
        var stripe = ensureStripe();
        if (!stripe) {
            toast('error', 'Card payments aren\'t ready. Please refresh and try again.');
            return;
        }
        // Validate the receipt email BEFORE any Stripe work — abort cleanly
        // (no inflight guard, no teardown) so the typed card survives.
        var checkoutEmail = readCheckoutEmail();
        if (!checkoutEmail) { return; }
        checkoutInFlight = true;
        btn.disabled = true;
        // The new CTA button is .ckt-cta (also .ckt-sticky-cta on mobile).
        // Fall back to the legacy .cart-summary__cta-total selector for any
        // page still using the old markup.
        var origLabel = btn.querySelector('span:not(.cart-summary__cta-total)') || btn;
        var orig = origLabel.textContent;
        origLabel.textContent = 'Preparing payment...';
        setError('');

        // Resolve a SUCCEEDED PaymentIntent id, two ways:
        //   • saved card  → create a fresh intent for the current total and
        //                   confirm it with the stored payment_method id.
        //   • new / wallet → the Payment Element already created its intent
        //                   up front; confirm it (card + Apple/Google Pay /
        //                   Link / …). redirect:'if_required' keeps the
        //                   common methods inline (no page navigation).
        // EXACT legacy: confirm the Checkout Session via the Checkout Elements
        // SDK (checkoutActions.confirm()), then place the order with the SESSION
        // id — the server verifies payment_status='paid' on the connected
        // account. No saved-card path: a Connect direct charge has no platform
        // customer, so both card modes use the same session flow.
        // SAVED CARD — no Payment Element involved. The server clones the card
        // onto the restaurant's connected account and confirms the charge
        // ON-SESSION, so a 3-D Secure challenge can be answered right here
        // instead of failing the payment. Resolves with a payment_intent_id
        // for /order/place (which re-verifies it server-side).
        if (mode.kind === 'card-saved') {
            origLabel.textContent = 'Confirming payment...';
            var savedPromise = postCart('/cart/pay-saved-card', {
                payment_method_id: mode.paymentMethodId,
            }, true).then(function (env) {
                // Same reasoning as /payment/intent above: no handleEnvelope
                // here, so fold DISCARDED back to the pre-existing null path.
                if (env === DISCARDED) { env = null; }
                if (!env) { throw new Error('Could not reach the server.'); }
                if (env.status !== 200) { throw new Error(env.msg || 'That card was declined.'); }
                var d = env.data || {};
                if (d.status === 'succeeded') { return d.paymentIntentId; }
                if (d.status !== 'requires_action') { throw new Error('That payment didn\'t go through.'); }
                // 3-D Secure — finish it on the CONNECTED account, which is
                // where the intent lives.
                var s = ensureStripe(d.stripeAccount);
                if (!s) { throw new Error('Card payments aren\'t ready. Please refresh and try again.'); }
                origLabel.textContent = 'Verifying with your bank...';
                return s.handleNextAction({ clientSecret: d.clientSecret }).then(function (r) {
                    if (r && r.error) { throw new Error(r.error.message || 'Card verification failed.'); }
                    if (!r || !r.paymentIntent || r.paymentIntent.status !== 'succeeded') {
                        throw new Error('Card verification didn\'t complete. Please try again.');
                    }
                    return r.paymentIntent.id;
                });
            });
            return finishCardOrder(savedPromise, origLabel, orig, btn, { savedCard: true });
        }

        var paidIntentPromise = ensurePaymentElement(false).then(function (el) {
            if (!el || !checkoutActions) { throw new Error('Payment form is not ready. Please refresh and try again.'); }
            origLabel.textContent = 'Confirming payment...';
            // Confirm the Checkout Session INLINE. Two critical options:
            //   • email — REQUIRED by Stripe to confirm (overrides updateEmail);
            //             phone-OTP customers set it in the receipt field above.
            //   • redirect:'if_required' — WITHOUT this the SDK ALWAYS redirects
            //             to the session return_url on success, so the place-order
            //             step below never runs and the customer lands on a blank
            //             /cart URL (the "page not found" after paying). This keeps
            //             card payments inline; only redirect-based methods leave.
            return checkoutActions.confirm({ email: checkoutEmail, redirect: 'if_required' }).then(function (result) {
                if (result && result.type === 'error') {
                    var m = (result.error && result.error.message) || 'Payment failed.';
                    setError(m); throw new Error(m);
                }
                return paySessionId;
            });
        });

        return finishCardOrder(paidIntentPromise, origLabel, orig, btn, { savedCard: false });
    }

    /**
     * finishCardOrder — shared tail of BOTH card routes.
     *
     * `paidPromise` resolves with the proof of payment: a Checkout Session id
     * for a newly-entered card, or a PaymentIntent id for a saved card. The
     * server re-verifies whichever it's given before writing the order, so the
     * only difference here is which field we send.
     */
    function finishCardOrder(paidPromise, origLabel, orig, btn, opts) {
        var savedCard = !!(opts && opts.savedCard);
        return paidPromise.then(function (paidId) {
            origLabel.textContent = 'Placing order...';
            var body = { payment_option: 2 };
            if (savedCard) { body.payment_intent_id = paidId; } else { body.session_id = paidId; }
            return postCart('/order/place', body, true).then(function (env) {
                // Same reasoning as /payment/intent above: no handleEnvelope
                // here, so fold DISCARDED back to the pre-existing null path.
                if (env === DISCARDED) { env = null; }
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
            // The payment may have succeeded but order-place failed — the
            // Stripe webhook recovers that. Rebuild the element so a retry
            // starts from a clean, fresh intent. (Saved cards mount no
            // element, so there is nothing to tear down there.)
            if (!savedCard) { teardownPaymentElement(); }
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
        // Prominent full-screen loader while the order is placed — kept up
        // through the redirect to the confirmation page on success.
        if (window.EatNDealUi && window.EatNDealUi.showLoader) { window.EatNDealUi.showLoader(); }
        var navigating = false;
        postCart('/order/place', body, true)
            .then(function (env) {
                // Same reasoning as /payment/intent above: no handleEnvelope
                // here, so fold DISCARDED back to the pre-existing null path.
                if (env === DISCARDED) { env = null; }
                if (!env) { toast('error', 'Could not reach the server.'); return; }
                if (env.status === 401) {
                    navigating = true;
                    window.location.href = '/signin?next=' + encodeURIComponent('/cart');
                    return;
                }
                if (env.status !== 200) {
                    toast('error', env.msg || 'Could not place the order.');
                    return;
                }
                bumpCartBadge(null);
                var oid = (env.data && env.data.order && env.data.order.id) || '';
                navigating = true;
                window.location.href = '/order/' + encodeURIComponent(oid) + '/confirm';
            })
            .catch(function () { toast('error', 'Could not place the order.'); })
            .then(function () {
                if (navigating) { return; }   // success → keep the loader through the page change
                if (window.EatNDealUi && window.EatNDealUi.hideLoader) { window.EatNDealUi.hideLoader(); }
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
        initBasketState();
    }

    /**
     * initBasketState
     *
     * What:  Keeps the "Basket summary" disclosure open across the page reload
     *        that a quantity change / remove triggers.
     * Why:   The stepper posts and then reloads (handleEnvelope reload:true), and
     *        <details> renders collapsed by default — so adjusting a quantity
     *        slammed the panel shut on every tap, exactly while the customer was
     *        working inside it.
     *        The state is remembered per TAB (sessionStorage), so it follows the
     *        reload but a fresh visit still starts collapsed as designed.
     */
    function initBasketState() {
        var box = document.querySelector('.ckt-basket');
        if (!box) { return; }
        var KEY = 'cart.basketOpen';
        try {
            if (sessionStorage.getItem(KEY) === '1') { box.open = true; }
        } catch (e) { /* sessionStorage unavailable — just leave it collapsed */ }
        box.addEventListener('toggle', function () {
            try { sessionStorage.setItem(KEY, box.open ? '1' : '0'); } catch (e) { /* ignore */ }
        });
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

    /**
     * eatndeal:cart-updated — fired by ui/cart-render.js right after a region
     * swap. Re-runs the two initialisers whose targets live INSIDE the
     * swapped main region, since a MutationObserver / event listener attached
     * to the OLD node (onReady only ran this once, at initial page load)
     * silently goes dead the moment that node is replaced:
     *
     *   • initCardChargeSync — its MutationObserver watches [data-cart-pay]
     *     for the card-service-charge fold-in; after the first swap it was
     *     observing an orphaned node, so the charge silently stopped
     *     tracking the payment method.
     *   • initBasketState    — its 'toggle' listener persists the "Basket
     *     summary" disclosure to sessionStorage; after the first swap the
     *     new <details> node had no listener and the stored value went stale.
     *
     * Also re-applies the pay-mode captured in handleEnvelope just before the
     * swap (partials/cart/main.ejs always renders a fresh node hardcoded to
     * data-ckt-pay-mode="cash", which would otherwise silently revert the
     * customer's Card choice back to Cash pricing on every swap).
     */
    document.addEventListener('eatndeal:cart-updated', function () {
        var payRootAfter = document.querySelector('[data-cart-pay]');
        if (payRootAfter && payModeBeforeSwap) {
            payRootAfter.setAttribute('data-ckt-pay-mode', payModeBeforeSwap);
        }
        payModeBeforeSwap = null;
        initCardChargeSync();
        initBasketState();
    });

    /*
     * Client-side pre-checks.
     *
     * What:  Per-action rules that catch a bad input before the request goes
     *        out. The api still enforces all of these — this only saves a
     *        round trip and shows the problem instantly on a slow phone.
     * Type:  READ (pure per entry) → message string, or null to proceed.
     */
    var VALIDATORS = {
        // 'cart-apply-coupon' is deliberately NOT pre-checked here — onApplyCoupon
        // already shows a richer inline error under the field (setCouponError) and
        // focuses the input on empty code. A generic toast pre-check here would
        // fire first and hide that better feedback. Do not re-add an entry.
        'cart-apply-voucher': function () {
            var el = document.querySelector('[data-cart-voucher-input]');
            return (el && el.value.trim()) ? null : 'Enter a voucher code.';
        },
        'cart-apply-loyalty': function () {
            // A blank / zero / non-positive amount means "use the full available
            // max" (see onApplyLoyalty) — that must fall through, NOT be blocked.
            // Only an amount ABOVE the available max is genuinely invalid here.
            var el = document.querySelector('[data-cart-loyalty-input]');
            var amt = parseFloat(el && el.value);
            if (!isFinite(amt) || amt <= 0) { return null; }
            var panel = document.querySelector('[data-cart-loyalty]');
            var max = parseFloat(panel && panel.getAttribute('data-reward-max'));
            if (isFinite(max) && amt > max) {
                return 'You can use up to ' + curSym() + max.toFixed(2) + ' on this order.';
            }
            return null;
        },
        'cart-charity-custom': function () {
            var el = document.querySelector('[data-charity-input]');
            var amt = parseFloat(el && el.value);
            return (isFinite(amt) && amt > 0) ? null : 'Enter a charity amount.';
        },
        'cart-set-address': function (btn) {
            return btn.getAttribute('data-address-id') ? null : 'Pick an address.';
        }
    };

    /**
     * validateAction — run the rule for one action, if it has one.
     * Type: READ. Returns a message to block with, or null.
     */
    function validateAction(action, btn) {
        var fn = VALIDATORS[action];
        if (!fn) { return null; }
        try { return fn(btn); } catch (e) { return null; }
    }

    // ── Single document delegate ────────────────────────────────────
    document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('[data-action]');
        if (!btn) { return; }
        var action = btn.getAttribute('data-action');
        var blocked = validateAction(action, btn);
        if (blocked) { ev.preventDefault(); toast('error', blocked); return; }
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
            case 'ckt-save-cooking':    return onSaveCooking(ev, btn);
            case 'cart-set-pay':        return onCartSetPay(ev, btn);
            case 'cart-checkout':       return onCartCheckout(ev, btn);
        }
    });

    // (Removed) the "Save this card" toggle used to REBUILD the Payment Element
    // on every change — a jarring "refresh" — and saved cards don't work on the
    // Connect direct-charge flow anyway, so the checkbox is gone (see
    // checkout-popups.ejs). No rebuild handler needed.

    // Exposed for sibling UI modules that drive the cart from their own
    // flows (e.g. the product modal posts to /cart/add directly and
    // wants the same canonical badge bump + animation).
    window.EatNDealCart = {
        bumpCartBadge:    bumpCartBadge,
        refreshCartBadge: refreshCartBadge,
        flyToCart:        flyToCart,
        // Lets the checkout-popups module mount the Stripe Payment Element
        // on demand when the customer picks "Pay another way" in the payment
        // sheet — we don't load Stripe.js until it's needed.
        ensureCardElement: ensureCardElement,
        // Hook for ui/cart-render.js — see teardownPaymentElementForSwap's
        // own comment for why this must run before the popups region swaps.
        teardownPaymentElementForSwap: teardownPaymentElementForSwap,
    };
})();
