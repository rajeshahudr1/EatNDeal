'use strict';

/*
 * Helpers/cartValidate.js
 *
 * What:  The single full-revalidate gate every cart write API hits BEFORE
 *        it writes anything. Legacy POS / webordering only validated some
 *        things at add-to-cart and trusted the rest at place-order — that
 *        means a cart could carry a stale price / sold-out item / expired
 *        coupon all the way to the till and still place. For the
 *        marketplace we re-check EVERYTHING on every write so the customer
 *        sees the truth as soon as something drifts.
 *
 *        Return shape:
 *          {
 *            ok:        bool,            // pass-through gate for the controller
 *            errors:    [{code, msg, field?}],   // blocks the write
 *            warnings:  [{code, msg, field?}],   // surfaces to the user but allowed
 *            cart:      <cart row, refreshed>,
 *            items:     [<line item, refreshed>],
 *          }
 *
 *        Controllers do:
 *          const v = await cartValidate.validate(cartId, customerId, ctx);
 *          if (!v.ok) return H.errorResponse(res, v.errors[0].msg, 422, v.errors);
 *
 * Why:   One source of truth means a future rule (e.g. "block cart when
 *        customer is banned mid-session") drops into ONE function and the
 *        whole API enforces it automatically.
 *
 * Match: Ports the legacy webordering validation rules across
 *          CartController::actionValidateCoupon / actionCheckout
 *          OrderController::actionPlaceOrder
 *        — plus the missing stock + price-drift checks legacy never did.
 *
 * Type:  READ-only (never writes; controllers write after the gate passes).
 */

const { db }    = require('../config/db');
const M         = require('./marketplace');
const Cart      = require('./cart');
const A         = require('./availability');

// Validation levels the caller can ask for. Heavier checks (stock, prices)
// are skipped on cheap reads so a noisy "open the cart page" doesn't fan
// out into 30 queries.
const LEVEL = Object.freeze({
    READ:   'read',      // GET /cart — cart-state checks only
    WRITE:  'write',     // add / update / remove / set-* — full re-validate
    PLACE:  'place',     // place-order — strictest: stock decrement guard,
                         //              coupon re-validate, prices locked
});

/**
 * pushErr / pushWarn — tiny helpers to keep validate() readable. The error
 * code is a stable string (UI / Flutter app can translate); msg is the
 * canonical English wording.
 */
function pushErr(out, code, msg, field) {
    out.errors.push({ code, msg, field: field || null });
    out.ok = false;
}
function pushWarn(out, code, msg, field) {
    out.warnings.push({ code, msg, field: field || null });
}

/**
 * validate
 *
 * What:  Runs every rule appropriate for the requested level and returns
 *        the result envelope above. NEVER throws on a validation failure
 *        — only on actual DB / programmer errors. Controllers should
 *        always rely on `out.ok` rather than try/catch.
 * Inputs:
 *   cartId      — cart.id
 *   customerId  — req.session.user.id (injected by web proxy)
 *   ctx         — { level: LEVEL.*, postcode?, ... } — extra context for
 *                  level-specific rules (e.g. postcode lets the delivery-
 *                  zone re-check fire at WRITE level).
 *
 * Output: see top-of-file shape.
 */
async function validate(cartId, customerId, ctx) {
    ctx = ctx || {};
    const level = ctx.level || LEVEL.WRITE;
    const out = { ok: true, errors: [], warnings: [], cart: null, items: [] };

    // ── 1. Cart row itself ────────────────────────────────────────────
    const cart = await Cart.loadActiveCart(cartId, customerId);
    if (!cart) {
        pushErr(out, 'cart.not_found', 'Your cart is no longer available. Please refresh and try again.');
        return out;
    }
    out.cart = cart;

    // ── 2. Branch still live (active + not soft-deleted + same company) ──
    const branch = await db('branch as b')
        .innerJoin('company as c', 'c.id', 'b.company_id')
        .where('b.id', cart.branch_id)
        .modify(M.eligibleCompanyScope, 'c')
        .modify(M.eligibleBranchScope,  'b')
        .first('b.*');
    if (!branch) {
        pushErr(out, 'branch.unavailable', 'This restaurant is no longer available. Please pick another one.');
        return out;
    }

    // Open / pre-order gate — at WRITE we just warn (customer may want to
    // pre-order anyway); at PLACE we block if neither open nor a valid
    // future pre-order time is set. Marketplace carts store the full
    // datetime in `pre_order_time` (timestamptz); the legacy
    // `scheduled_time` TIME column is unused here.
    const isOpen = M.isOpenNow(branch);
    if (!isOpen && level === LEVEL.PLACE) {
        if (!(Number(cart.is_pre_order) === 1 && cart.pre_order_time)) {
            pushErr(out, 'branch.closed', 'The restaurant is currently closed. Schedule a pre-order or come back later.');
        }
    } else if (!isOpen) {
        pushWarn(out, 'branch.closed', 'The restaurant is closed right now — you can still pre-order.');
    }

    // ── 3. Line items — exist, still marketplace-on, stock, price ────
    const items = await Cart.loadLineItems(cart.id);
    out.items = items;

    if (items.length === 0 && level === LEVEL.PLACE) {
        pushErr(out, 'cart.empty', 'Your cart is empty. Add at least one item to place an order.');
        return out;
    }

    // Block "zero-total" carts at PLACE — a 100%-off coupon (or rounding
    // error) can leave grandtotal at 0 / below. Stripe rejects amount<=0
    // with a cryptic error; cash flow would create a £0 order. Both
    // unwanted; we fail early with a friendly message.
    if (level === LEVEL.PLACE && (Number(cart.grandtotal) || 0) <= 0) {
        pushErr(out, 'cart.zero_total',
            'Your order total is zero. Please add items or remove discounts before placing the order.');
        return out;
    }

    if (level === LEVEL.READ) {
        // Cheap path: trust stored prices, skip per-item DB lookups.
        return out;
    }

    if (items.length) {
        const productIds = Array.from(new Set(items.map((it) => it.product_id)));

        // Per-product live snapshot (show_marketplace / current best price
        // / availability) — one round trip. Availability columns (status,
        // is_sold_out, unavailable_until) come from the shared helper.
        const prods = await db('products as p')
            .whereIn('p.id', productIds)
            .select(
                'p.id', 'p.name', 'p.show_marketplace',
                'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax',
                ...A.selectColumns(db, 'p'),
            );
        const prodById = new Map(prods.map((p) => [String(p.id), p]));

        // Snapshot every modifier option referenced by the cart's subs.
        const subOptionIds = [];
        items.forEach((it) => {
            (it.modifiers || []).forEach((m) => {
                if (m.modifier_option_id) { subOptionIds.push(String(m.modifier_option_id)); }
            });
        });
        const optsById = new Map();
        if (subOptionIds.length) {
            const opts = await db('modifier_group_options')
                .whereIn('id', Array.from(new Set(subOptionIds)))
                .select('id', 'option_name', 'price_tax_include', 'price_tax_excluded', 'status');
            opts.forEach((o) => optsById.set(String(o.id), o));
        }

        for (const it of items) {
            const p = prodById.get(String(it.product_id));
            const ctxField = 'items.' + it.id;

            // Product missing or marketplace-off.
            if (!p) {
                pushErr(out, 'item.removed', '"' + (it.product_name || 'An item') + '" is no longer available. Please remove it.', ctxField);
                continue;
            }
            if (Number(p.show_marketplace) !== 1) {
                pushErr(out, 'item.unavailable', '"' + p.name + '" is unavailable. Please remove it from your cart.', ctxField);
                continue;
            }

            // Availability — status-driven (Sold out / Unavailable today /
            // Unavailable until / Unavailable). No stock counting.
            const avail = A.evaluate(p);
            if (!avail.available) {
                pushErr(out, avail.soldOut ? 'item.sold_out' : 'item.unavailable',
                    '"' + p.name + '" is ' + (avail.soldOut ? 'sold out' : 'currently unavailable') + '. Please remove it from your cart.', ctxField);
                continue;
            }

            // Price drift — the stored unit price must still match the
            // current marketplace pickPrice. Diverging usually means an
            // admin re-priced mid-session; we warn at WRITE, block at PLACE.
            // £0 items are allowed end-to-end per product spec — drift is
            // only meaningful when both sides have a real price.
            const current = M.pickPrice(p);
            const stored  = Number(it.product_net_price) || 0;
            if (current > 0 && stored > 0) {
                const drift = Math.abs(current - stored) > 0.005;
                if (drift) {
                    const msg = 'Price for "' + p.name + '" changed from ' + stored.toFixed(2) + ' to ' + current.toFixed(2) + '.';
                    if (level === LEVEL.PLACE) {
                        pushErr(out, 'item.price_drift', msg + ' Please refresh your cart.', ctxField);
                    } else {
                        pushWarn(out, 'item.price_drift', msg, ctxField);
                    }
                }
            }

            // Modifier options still active.
            for (const m of (it.modifiers || [])) {
                if (!m.modifier_option_id) { continue; }
                const o = optsById.get(String(m.modifier_option_id));
                if (!o || String(o.status) !== '1') {
                    pushErr(out, 'modifier.removed',
                        '"' + (m.variant_name || 'A choice') + '" on "' + p.name + '" is no longer available.', ctxField);
                }
            }
        }
    }

    // ── 4. Delivery-mode specific checks ─────────────────────────────
    if (Number(cart.serve_type) === 3) {
        // Address must be present at PLACE. At WRITE we only warn so the
        // user can still build the cart before picking an address.
        if (!cart.delivery_address && level === LEVEL.PLACE) {
            pushErr(out, 'address.missing', 'Pick a delivery address before placing the order.', 'delivery_address');
        }

        if (cart.delivery_postcode && level !== LEVEL.READ) {
            const zoneRows = await db('store_delivery_charge_setup')
                .where({ branch_id: cart.branch_id, status: 1 })
                .select('postcode', 'charge', 'minimum_order', 'free_delivery_above');
            const zone = M.matchDeliveryZone(cart.delivery_postcode, zoneRows);
            if (!zone) {
                pushErr(out, 'address.no_zone',
                    'This restaurant doesn\'t deliver to ' + cart.delivery_postcode + '.', 'delivery_postcode');
            } else if (level === LEVEL.PLACE) {
                const minOrder = Number(zone.minimum_order) || 0;
                const subTotal = Number(cart.sub_total) || 0;
                if (minOrder > 0 && subTotal < minOrder) {
                    pushErr(out, 'address.below_min',
                        'Minimum order for delivery is ' + minOrder.toFixed(2) + '. Add more items to continue.',
                        'sub_total');
                }
            }
        }
    }

    // ── 5. Coupon still valid (only when one is applied) ──────────────
    // Phase-2C ships the full coupon validator; for now we only sanity-
    // check the row exists + active so a deleted coupon can't ride to
    // place-order.
    if (Number(cart.coupon_id) > 0) {
        const coupon = await db('coupons').where({ id: cart.coupon_id }).first();
        if (!coupon || Number(coupon.is_active) !== 1) {
            pushErr(out, 'coupon.invalid', 'The applied coupon is no longer valid. Please remove it and try again.', 'coupon_id');
        } else if (coupon.expiry_date) {
            const exp = new Date(coupon.expiry_date);
            if (Number.isFinite(exp.getTime()) && exp.getTime() < Date.now()) {
                pushErr(out, 'coupon.expired', 'The applied coupon has expired.', 'coupon_id');
            }
        }
    }

    // ── 6. Auto-discount still in window (same idea) ──────────────────
    if (Number(cart.discount_id) > 0) {
        const disc = await db('discounts').where({ id: cart.discount_id, status: 1 }).first();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const okStart = !disc || !disc.start_date || new Date(disc.start_date) <= today;
        const okEnd   = !disc || !disc.end_date   || new Date(disc.end_date)   >= today;
        if (!disc || !okStart || !okEnd) {
            // Discount expired silently — clear it on the cart side.
            pushWarn(out, 'discount.expired', 'A previously-applied auto-discount has expired and will be removed.');
        }
    }

    // ── 7. Pre-order time sanity ──────────────────────────────────────
    // The marketplace writes the picked datetime into `pre_order_time`
    // (timestamptz). `scheduled_time` is a legacy TIME column the
    // marketplace doesn't touch, so check the right field.
    if (Number(cart.is_pre_order) === 1 && level === LEVEL.PLACE) {
        if (!cart.pre_order_time) {
            pushErr(out, 'preorder.no_time', 'Pick a pickup / delivery time for your pre-order.', 'pre_order_time');
        }
    }

    return out;
}

module.exports = {
    LEVEL,
    validate,
};
