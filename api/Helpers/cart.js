'use strict';

/*
 * Helpers/cart.js
 *
 * What:  The single source of truth for everything that touches the live
 *        `cart` / `cart_details` / `cart_sub_details` / `cart_payment`
 *        tables on behalf of the EatNDeal marketplace. Every cart
 *        endpoint (add / update / remove / set-mode / set-address /
 *        apply-coupon / place-order) calls these helpers — no controller
 *        ever writes those tables directly.
 *
 * Why:   Cart writes are the single most fragile path in the project
 *        (live schema shared with the legacy POS, 70+ columns). Keeping
 *        every write inside one helper means:
 *          • the recompute formula is implemented once
 *          • every endpoint produces the EXACT same cart state for a
 *            given set of inputs (no drift between controllers)
 *          • the legacy POS never sees a marketplace cart and vice-versa
 *            (every helper passes `is_marketplace = 1` on writes,
 *            every read filters by it).
 *
 * Match:  Ports the relevant pieces of
 *          eatndealclean/webordering/controllers/CartController.php
 *         and Commonquery cart helpers — same grandtotal formula
 *         (sub_total + delivery_fees + service_charge_amount + bag_charge
 *          + charity_amount − discount).
 *
 * Status / sentinel constants live near the top so reads + writes use the
 * same numbers (the legacy migration uses smallints 0/1/2 here).
 */

const F = require('./format');

const { db }        = require('../config/db');
const M             = require('./marketplace');
const OrderTime     = require('./orderTime');
const AutoDiscount  = require('./autoDiscount');

// ── Loyalty redeem column guard (cached) ────────────────────────────
// `cart.used_cashback` ships via a legacy migration the operator runs
// separately (php yii migrate). Until then the column is absent — so we
// detect it ONCE and treat redeem as a no-op when it's missing, rather
// than letting every cart recompute crash on an unknown column.
let _hasUsedCashbackCol = null;
async function hasUsedCashbackCol() {
    if (_hasUsedCashbackCol !== null) { return _hasUsedCashbackCol; }
    try {
        const r = await db.raw(
            "select 1 from information_schema.columns where table_name = 'cart' and column_name = 'used_cashback' limit 1",
        );
        const n = r && (r.rows ? r.rows.length : (Array.isArray(r) ? r.length : 0));
        _hasUsedCashbackCol = n > 0;
    } catch (e) { _hasUsedCashbackCol = false; }
    return _hasUsedCashbackCol;
}

// Cart row state. (Legacy uses 1/0; this matches.)
const CART_OPEN     = 1;
const CART_DELETED  = 1;
const CART_ACTIVE   = 0;       // is_deleted = 0

// is_marketplace marker. Every marketplace cart / order carries this flag
// so the legacy POS list queries (which never set it) automatically skip
// our rows, and ours automatically skip theirs.
const MARKETPLACE_FLAG = 1;

// Cart OWNER — either a signed-in customer (user_id = the customer id) or a
// GUEST (user_id = 0, identified by the session localID), mirroring legacy
// which stores guest carts with user_id=0 keyed by localID. Callers pass
// EITHER a numeric/string customerId (back-compat: the signed-in path is
// byte-identical to before) OR an object { guestId } for an anonymous cart.
function isGuestOwner(owner) {
    return !!(owner && typeof owner === 'object' && owner.guestId);
}
function ownerUserId(owner) {
    return isGuestOwner(owner) ? 0 : owner;
}

/**
 * cartScope
 *
 * What:  Knex modifier — the canonical "this cart belongs to this owner
 *        (customer OR guest) AND is the active marketplace cart" predicate.
 *        Used by every read so a controller never accidentally loads a
 *        closed / deleted / POS cart.
 * Type:  READ (query-builder modifier).
 */
function cartScope(qb, owner) {
    qb.where('is_marketplace', MARKETPLACE_FLAG)
      .andWhere('is_open', CART_OPEN)
      .andWhere('is_deleted', CART_ACTIVE);
    if (isGuestOwner(owner)) {
        qb.andWhere('user_id', 0).andWhere('localID', String(owner.guestId));
    } else {
        qb.andWhere('user_id', owner);
    }
}

/**
 * getOrCreateCart
 *
 * What:  Returns the customer's active marketplace cart for a given branch,
 *        creating a fresh row when none exists. Idempotent — repeated
 *        calls reuse the same id until the cart is placed-as-order or
 *        cleared.
 *
 *        One cart per (customer, branch) is the legacy convention. If a
 *        customer adds an item from a DIFFERENT branch we DON'T silently
 *        merge — the caller (add-to-cart endpoint) decides whether to
 *        clear the current cart or reject the second branch. This helper
 *        just returns "your cart for this branch" deterministically.
 *
 * Type:  WRITE (insert on first call, read after).
 *
 * Inputs:  { owner, branchId, companyId, serveType?, localId? }
 *          owner = a numeric customerId (signed-in) OR { guestId } (guest).
 *          For back-compat a bare `customerId` is still accepted.
 * Output:  the cart row.
 */
async function getOrCreateCart({ owner, customerId, branchId, companyId, serveType, localId }) {
    const o = (owner != null) ? owner : customerId;       // back-compat
    const existing = await db('cart')
        .modify(cartScope, o)
        .andWhere('branch_id', branchId)
        .first();
    if (existing) { return existing; }

    const uid = ownerUserId(o);
    // Guest carts are keyed by their session localID; signed-in carts get a
    // generated marketplace localID (legacy convention).
    const lid = isGuestOwner(o)
        ? String(o.guestId)
        : String(localId || ('MP_' + uid + '_' + Date.now()));
    const now = db.fn.now();
    const [created] = await db('cart')
        .insert({
            user_id:        uid,
            branch_id:      branchId,
            company_id:     companyId,
            is_marketplace: MARKETPLACE_FLAG,
            is_open:        CART_OPEN,
            is_deleted:     CART_ACTIVE,
            serve_type:     Number(serveType) || 3,    // default: delivery
            localID:        lid,
            sub_total:      0,
            tax:            0,
            discount:       0,
            grandtotal:     0,
            total_qty:      0,
            bag_charge:     0,
            delivery_fees:  0,
            charity_amount: 0,
            service_charge_amount: 0,
            free_delivery:  0,
            coupon_id:      0,
            discount_id:    0,
            voucher_id:     0,
            is_pre_order:   0,
            created_by:     uid,
            created_at:     now,
        })
        .returning('*');
    return created;
}

/**
 * loadActiveCart
 *
 * What:  Fetches the customer's active marketplace cart by id (and verifies
 *        it belongs to the customer + is open + marketplace). Returns
 *        null when the row is missing / not theirs / closed.
 * Type:  READ.
 */
async function loadActiveCart(cartId, owner) {
    if (!cartId || owner == null) { return null; }
    const row = await db('cart')
        .where('id', cartId)
        .modify(cartScope, owner)
        .first();
    return row || null;
}

/**
 * findOpenCart
 *
 * What:  Returns the customer's most recently-updated open marketplace
 *        cart (across all branches), or null when the customer has none.
 *        Used by GET /cart so the cart page works without a known
 *        branch_id — the customer's existing cart (if any) just appears.
 * Type:  READ.
 */
async function findOpenCart(owner) {
    if (owner == null) { return null; }
    const row = await db('cart')
        .modify(cartScope, owner)
        .orderBy('id', 'desc')
        .first();
    return row || null;
}

/**
 * claimGuestCart
 *
 * What:  Adopts a GUEST cart (user_id=0, keyed by localID=guestId) into a
 *        just-signed-in customer's account by stamping user_id. Called by
 *        the web layer right after login. The GUEST cart wins: any OTHER
 *        open marketplace cart the customer already had is closed first, so
 *        the customer ends up with exactly one open cart — the one they were
 *        just building. Mirrors legacy actionCheckout (set user_id on login).
 * Type:  WRITE.
 *
 * Output: { claimed: boolean, cartId? }
 */
async function claimGuestCart(guestId, customerId) {
    if (!guestId || !customerId) { return { claimed: false }; }
    const guestCart = await db('cart')
        .modify(cartScope, { guestId: String(guestId) })
        .orderBy('id', 'desc')
        .first();
    if (!guestCart) { return { claimed: false }; }

    // Close any other open cart the customer already had (guest cart wins).
    await db('cart')
        .where('is_marketplace', MARKETPLACE_FLAG)
        .andWhere('user_id', customerId)
        .andWhere('is_open', CART_OPEN)
        .andWhere('is_deleted', CART_ACTIVE)
        .andWhereNot('id', guestCart.id)
        .update({ is_open: 0 });

    // Adopt the guest cart.
    await db('cart')
        .where('id', guestCart.id)
        .update({ user_id: customerId, created_by: customerId });
    return { claimed: true, cartId: guestCart.id };
}

/**
 * loadCartById
 *
 * What:  Re-reads a cart row by id. Used as the "post-write refresh"
 *        — every controller that runs recomputeTotals needs the FRESH
 *        row (totals + qty just changed) before building the public
 *        view, otherwise the response carries the pre-recompute
 *        snapshot and the client's badge stays stale.
 * Type:  READ.
 */
async function loadCartById(cartId) {
    if (!cartId) { return null; }
    const row = await db('cart').where({ id: cartId }).first();
    return row || null;
}

/**
 * loadLineItems
 *
 * What:  Returns the cart's live items + their modifier picks. Skips
 *        soft-deleted rows. Each item carries its own `modifiers` array so
 *        callers don't have to second-join.
 * Type:  READ.
 */
async function loadLineItems(cartId) {
    const items = await db('cart_details')
        .where({ cart_id: cartId, is_deleted: 0 })
        .orderBy('id', 'asc')
        .select('*');
    if (!items.length) { return []; }

    const subs = await db('cart_sub_details')
        .whereIn('cart_details_id', items.map((i) => i.id))
        .select('*');
    const subsByItem = new Map();
    subs.forEach((s) => {
        const k = String(s.cart_details_id);
        if (!subsByItem.has(k)) { subsByItem.set(k, []); }
        subsByItem.get(k).push(s);
    });

    return items.map((it) => Object.assign({}, it, {
        modifiers: subsByItem.get(String(it.id)) || [],
    }));
}

/**
 * lineSubtotal
 *
 * What:  Per-row money math for ONE cart_details row + its modifiers.
 *        Matches legacy:
 *
 *          unit = product_net_price (already post product-level discount)
 *          mods = Σ (cart_sub_details.variant_price × variant_qty)
 *          line = (unit + mods) × product_qty
 *
 *        Returns a plain number (Math.round to 2 dp).
 * Type:  READ (pure).
 */
function lineSubtotal(item) {
    const unit = Number(item.product_net_price) || 0;
    const qty  = Number(item.product_qty) || 0;
    let mods = 0;
    (item.modifiers || []).forEach((m) => {
        const p = Number(m.variant_price) || 0;
        const q = Number(m.variant_qty)   || 1;
        mods += p * q;
    });
    const line = (unit + mods) * qty;
    return Math.round(line * 100) / 100;
}

/**
 * recomputeTotals
 *
 * What:  THE single recompute path — every cart write calls this last so
 *        the cart row's stored totals always match the live items + the
 *        applied promo / fee state.
 *
 *        Formula (matches legacy CartController::updateCartTotals_New):
 *           sub_total      = Σ lineSubtotal(item)
 *           total_qty      = Σ item.product_qty
 *           bag_charge     = ceil(total_qty / online_per_bag_qty) × online_bag_charge   (delivery only)
 *           charity_amount = kept as-is on cart — the CUSTOMER's chosen
 *                            contribution (set by /cart/set-charity); added
 *                            to the total and donated to the company
 *           fix_charity_discount = (fix_charity_percentage / 100) × sub_total
 *                            — the COMPANY's auto-donation; shown in the
 *                            "DONATED" banner but NOT added to the total
 *           service_charge = service_charge_online_order             (flat from branch)
 *           delivery_fees  = kept as-is on cart (set by /cart/set-address)
 *           discount       = kept as-is on cart (coupon OR voucher)
 *           grandtotal     = sub_total + delivery_fees + service_charge_amount
 *                          + bag_charge + charity_amount − discount
 *
 *        Returns the freshly updated cart row.
 *
 * Type:  WRITE (UPDATE on cart).
 */
async function recomputeTotals(cartId) {
    const cart = await db('cart').where({ id: cartId }).first();
    if (!cart) { throw new Error('cart.recomputeTotals: cart not found'); }

    const branch = await db('branch').where({ id: cart.branch_id }).first();
    const items  = await loadLineItems(cartId);

    let subTotal = 0;
    let totalQty = 0;
    items.forEach((it) => {
        subTotal += lineSubtotal(it);
        totalQty += Number(it.product_qty) || 0;
    });

    // Bag charge (delivery only — pickup doesn't pack the bag at the till).
    let bagCharge = 0;
    if (Number(cart.serve_type) === 3 && branch) {
        const perBag = Number(branch.online_per_bag_qty) || 0;
        const charge = Number(branch.online_bag_charge)  || 0;
        if (perBag > 0 && charge > 0 && totalQty > 0) {
            bagCharge = Math.ceil(totalQty / perBag) * charge;
        }
    }

    // Charity contribution — the CUSTOMER's chosen donation (set via
    // /cart/set-charity: No / a % tier / Custom). ADDED to the grand total; the
    // customer pays it and it's donated to the company. NOT auto-charged.
    //
    // A % TIER RESCALES WITH THE BASKET. The cart stores only the £ amount, and
    // the cart page works out which tier chip to light up by matching that
    // amount against each tier of the CURRENT sub-total. Leaving the amount
    // frozen therefore moved the selection on its own: pick 10% of £6 (£0.60),
    // add an item so the sub-total is £12, and £0.60 is now 5% — the page showed
    // 5% selected and the customer's 10% choice was silently halved.
    //
    // The percentage is recovered from the state we still have here — cart row
    // = the PREVIOUS sub-total and amount — and re-applied to the new one.
    // It's only done when the old amount really was one of the offered tiers;
    // a CUSTOM £ amount is a flat pledge and stays exactly as entered.
    // No schema change: the amount keeps being the single stored value, it is
    // just kept honest instead of going stale.
    let charityAmt = Number(cart.charity_amount) || 0;
    const prevSub = Number(cart.sub_total) || 0;
    if (charityAmt > 0 && prevSub > 0 && Math.abs(subTotal - prevSub) > 0.005) {
        // Tiers are per-branch (quick_tips), the same list the page renders —
        // read them rather than assuming 5/10/15, or a branch with its own
        // tiers would have its selection treated as a custom amount.
        const tiers = await getCharityTiers(cart.branch_id, cart.company_id);
        const pct   = (charityAmt / prevSub) * 100;
        const tier  = tiers.find((t) => Math.abs(Number(t) - pct) < 0.05);
        if (tier) { charityAmt = round2(subTotal * Number(tier) / 100); }
    }

    // Fixed charity — the COMPANY's automatic donation = branch
    // fix_charity_percentage % of sub-total. Shown to the customer as the
    // "DONATED" banner but NOT added to the total (the company donates it
    // from its own margin). Mirrors the legacy fix_charity_discount.
    const fixCharityPct = branch ? (Number(branch.fix_charity_percentage) || 0) : 0;
    const fixCharity    = Math.round((subTotal * fixCharityPct / 100) * 100) / 100;

    // Service charge — CARD-ONLY (not part of the payment-agnostic base
    // total). Cash / COD orders carry NO service charge. When the customer
    // pays by card, the surcharge is added at payment time from
    // company_stripe_settings (see Cart.cardServiceCharge), shown in the
    // review popup + on the order. So the base cart total here keeps it 0.
    const serviceCharge = 0;

    // Keep the previously-set delivery_fees; recompute discount based
    // on what's active. The caller that DOES want to change
    // delivery_fees (set-address) writes its own value, then re-calls
    // recomputeTotals.
    let deliveryFees = Number(cart.delivery_fees) || 0;

    // Free-delivery threshold, re-checked on EVERY recompute so a customer who
    // adds items to cross the zone's free_delivery_above gets free delivery
    // without re-picking the address (legacy re-runs getDeliveryFees each
    // change). Only reduces a POSITIVE fee — never resurrects a coupon's £0.
    if (Number(cart.serve_type) === 3 && deliveryFees > 0 && cart.delivery_postcode) {
        try {
            const zrows = await db('store_delivery_charge_setup')
                .where({ branch_id: cart.branch_id, status: 1 })
                .select('postcode', 'free_delivery_above');
            const z = M.matchDeliveryZone(String(cart.delivery_postcode).trim(), zrows);
            const freeAbove = z ? (Number(z.free_delivery_above) || 0) : 0;
            if (freeAbove > 0 && subTotal > freeAbove) { deliveryFees = 0; }
        } catch (e) { /* keep the fee on any lookup hiccup */ }
    }

    // ── Discount resolution ─────────────────────────────────────────
    // Manual promo (coupon / voucher) wins — the apply-coupon handler
    // wrote the amount on the cart row directly; we just clamp it to
    // sub_total so a stale large discount can't drive grandtotal below
    // the fee + charge components.
    // Otherwise, re-evaluate the auto-discount catalogue against the
    // CURRENT cart state (subtotal / mode / time). Whatever the best
    // matching row is now wins; nothing matching → clear it.
    let discount   = 0;
    let discountId = Number(cart.discount_id) || 0;

    const hasManualPromo = Number(cart.coupon_id) > 0 || Number(cart.voucher_id) > 0;
    if (hasManualPromo) {
        // RE-VALIDATE against the CURRENT basket, don't just carry the old
        // number forward. The amount was computed when the promo was applied;
        // every add / remove / quantity change since then has moved the
        // sub-total out from under it. Clamping alone (what this did before)
        // left two real faults:
        //   • apply on a small basket, then add items  → the discount stayed
        //     at the old, smaller figure — the customer paid more than the
        //     promo promised, while the code still showed as applied.
        //   • apply on a big basket, then remove items → the old, larger
        //     discount rode down with it, so the restaurant gave away more
        //     than the promo allows (and min_order_value stopped meaning
        //     anything).
        // Requiring lazily: coupons/vouchers pull in helpers that reach back
        // here, and this is the established pattern in this file.
        const promoCart = { ...cart, sub_total: subTotal };
        let promo = null;
        try {
            if (Number(cart.coupon_id) > 0 && cart.promocode) {
                promo = await require('./coupons').validate(cart.promocode, promoCart);
            } else if (Number(cart.voucher_id) > 0 && cart.promocode) {
                promo = await require('./vouchers').validate(cart.promocode, promoCart, cart.user_id);
            }
        } catch (e) {
            promo = null;                    // treat a lookup failure as "unknown"
        }

        if (promo && promo.ok) {
            discount = Math.min(round2(promo.discount) || 0, subTotal);
        } else if (promo) {
            // It no longer qualifies (below min order, wrong fulfilment mode,
            // expired, used up). Drop it rather than silently discount £0 —
            // a code shown as applied that takes nothing off is worse than no
            // code at all.
            discount = 0;
            await db('cart').where({ id: cartId }).update({
                coupon_id: 0, voucher_id: 0, promocode: null, free_delivery: 0,
            });
        } else {
            // Couldn't check (no code stored / lookup threw) — fall back to the
            // old behaviour rather than removing something on a hiccup.
            discount = Math.min(Number(cart.discount) || 0, subTotal);
        }
        discountId = 0;  // auto-discount slot is cleared when a coupon is in play
    } else if (branch) {
        const result = await AutoDiscount.findBest({ ...cart, sub_total: subTotal }, branch);
        if (result) {
            discountId = result.discount.id;
            discount   = result.amount;
        } else {
            discountId = 0;
            discount   = 0;
        }
    }

    // ── Loyalty redeem ──────────────────────────────────────────────
    // The cashback the customer chose to spend on THIS cart (set via
    // /cart/apply-loyalty, stored on cart.used_cashback). Folded into the
    // legacy formula AFTER the discount. Re-clamped on every recompute to
    // the live balance + restaurant cap (items / sub-total may have shrunk
    // since it was applied) AND to the pre-redeem payable, so the grand
    // total can never drop below zero. No-op until the column is migrated.
    const beforeRedeem = subTotal + deliveryFees + serviceCharge + bagCharge + charityAmt - discount;
    const hasRedeemCol = await hasUsedCashbackCol();
    let usedCashback = hasRedeemCol ? (Number(cart.used_cashback) || 0) : 0;
    if (hasRedeemCol && usedCashback > 0) {
        // Cap against BOTH pools the customer can spend here — this restaurant's
        // cashback AND their EatNDeal marketplace cashback (company_id = 0).
        // Capping on the restaurant pool alone would silently shrink a redeem
        // that legitimately drew on the marketplace balance too.
        const pools = await require('./loyalty').redeemPoolsFor({
            customerId: cart.user_id, companyId: cart.company_id, subTotal,
        });
        usedCashback = round2(Math.max(0, Math.min(usedCashback, pools.combined, Math.max(0, beforeRedeem))));
    }

    const grandtotal = round2(Math.max(0, beforeRedeem - usedCashback));

    const patch = {
        sub_total:             round2(subTotal),
        total_qty:             totalQty,
        bag_charge:            round2(bagCharge),
        charity_amount:        round2(charityAmt),
        fix_charity_discount:  round2(fixCharity),
        service_charge_amount: round2(serviceCharge),
        discount_id:           discountId,
        discount:              round2(discount),
        grandtotal:            grandtotal,
    };
    if (hasRedeemCol) { patch.used_cashback = usedCashback; }
    await db('cart').where({ id: cartId }).update(patch);

    return db('cart').where({ id: cartId }).first();
}

// Helper — 2 dp rounding, NaN-safe.
function round2(n) { return F.round2(n); }

/**
 * repriceCart
 *
 * What:  Re-prices any cart line whose stored unit price has DRIFTED from the
 *        current marketplace price (an admin re-priced the product after it was
 *        added). Sets the line to the SAME value the place-order drift check
 *        uses (M.pickPrice), so a plain REFRESH of the cart / checkout page
 *        clears the "Price for X changed — please refresh your cart" block
 *        automatically instead of leaving the customer stuck. Only touches
 *        lines that genuinely differ (matches the drift condition exactly), so
 *        it is a no-op when nothing changed.
 * Why:   Customer asked for "refresh → cart auto-updates to the new price"
 *        (Uber/Zomato behaviour) rather than a dead-end block.
 * Type:  WRITE (updates cart_details; the CALLER runs recomputeTotals after,
 *        which folds the new line prices into the cart totals).
 * Output: { changed: [{ id, name, from, to, msg }] } — for a UI notice.
 */
async function repriceCart(cartId) {
    if (!cartId) { return { changed: [] }; }
    const items = await loadLineItems(cartId);
    if (!items.length) { return { changed: [] }; }
    const ids = Array.from(new Set(items.map((i) => i.product_id).filter(Boolean)));
    if (!ids.length) { return { changed: [] }; }

    const prods = await db('products')
        .whereIn('id', ids)
        .select('id', 'name', 'marketplace_price', 'online_platform_price', 'price_after_tax');
    const byId = new Map(prods.map((p) => [String(p.id), p]));

    const changed = [];
    for (const it of items) {
        const p = byId.get(String(it.product_id));
        if (!p) { continue; }                              // missing product — cartValidate handles removal
        const current = round2(M.pickPrice(p));
        const stored  = round2(it.product_net_price);
        // Only when BOTH sides have a real price and they truly differ — the
        // same condition the place-order drift check uses, so re-pricing here
        // guarantees that check then passes.
        if (current > 0 && stored > 0 && Math.abs(current - stored) > 0.005) {
            await db('cart_details').where({ id: it.id }).update({
                product_price:     current,
                product_net_price: current,
            });
            const name = it.product_name || p.name || 'Item';
            changed.push({
                id:   String(it.id),
                name,
                from: stored,
                to:   current,
                msg:  'Price for "' + name + '" updated to ' + F.CURRENCY_SYMBOL + current.toFixed(2) + '.',
            });
        }
    }
    return { changed };
}

// Helper — pre_order_time (timestamptz) → "HH:MM" display string.
// Returns null when not a pre-order or the timestamp is unparseable.
function formatScheduledTime(preOrderTime, isPreOrder) {
    if (Number(isPreOrder) !== 1 || !preOrderTime) { return null; }
    const d = new Date(preOrderTime);
    if (!Number.isFinite(d.getTime())) { return null; }
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * addItem
 *
 * What:  Inserts ONE cart_details row + N cart_sub_details rows for the
 *        passed product / qty / options. The caller (CartController.add)
 *        must have already:
 *           • verified the product is marketplace-eligible + in stock
 *           • resolved the SERVER-side `unitPrice` (never trust client)
 *           • verified every `option` row is still active + linked to
 *             the product via modifier_group_products
 *        This function is the WRITE path only — re-validate via
 *        cartValidate.validate(WRITE) AFTER the insert and rollback if
 *        the gate now fails (extremely rare, defensive).
 *
 *        Each cart_sub_details row uses `variant_price` as a TEXT column
 *        (the legacy schema's choice) — we stringify the number.
 *
 * Type:  WRITE.
 */
/**
 * addSurpriseItem
 *
 * What:  Puts the branch's Surprise Box into the cart as a VIRTUAL line —
 *        product_id = 0, remark = 'TGTG', is_surprise_item = 1. Ported from
 *        legacy ToogoodtogoController::actionAddToCart (:250-274).
 * Why:   The box has no `products` row (it's configured on `branch`), so
 *        addItem — which starts from a product — can't express it. Kept apart
 *        from addItem rather than bolted on, because the two share no lookups:
 *        no category link, no modifier options, no product row.
 *
 *        is_surprise_item = 1 is what makes the slot COUNT: remaining is
 *        branch.qty minus these rows (Helpers/surpriseBox). Never insert a box
 *        line without it or the branch oversells.
 * Type:  WRITE.
 */
async function addSurpriseItem({ cartId, branch, qty, unitPrice }) {
    const n    = Math.max(1, Number(qty) || 1);
    const unit = round2(Number(unitPrice) || 0);

    // product_price / product_net_price hold the UNIT price here, NOT the line
    // total — that is THIS schema's convention (see addItem below, and
    // loadLineItems, which multiplies by product_qty to get the line).
    // Legacy stores `price * quantity` in the same column
    // (ToogoodtogoController.php:257-259) because its reader treats the column
    // as a line total. Porting that maths verbatim double-counted: a £2.99 box
    // × 2 showed £11.96 instead of £5.98 — the customer charged twice over.
    // Convention differs between the two apps; the VALUE must match the reader.

    // One box line per cart — a second Add tops up the existing row rather
    // than stacking duplicates the customer then has to remove one by one.
    const existing = await db('cart_details')
        .where({ cart_id: cartId, is_surprise_item: 1, is_deleted: 0 })
        .first('id', 'product_qty');

    if (existing) {
        const newQty = (Number(existing.product_qty) || 0) + n;
        await db('cart_details').where({ id: existing.id }).update({
            product_qty:       newQty,
            product_price:     unit,
            product_net_price: unit,
        });
        return { id: existing.id, product_qty: newQty };
    }

    const [item] = await db('cart_details').insert({
        cart_id:           cartId,
        product_id:        0,                       // virtual — no products row
        product_name:      String(branch.product_name || 'Surprise Box'),
        product_price:     unit,                    // UNIT price — see note above
        product_qty:       n,
        product_net_price: unit,
        category_id:       null,
        company_id:        branch.company_id,
        remark:            'TGTG',                  // legacy's marker for these lines
        is_surprise_item:  1,
        is_deleted:        0,
        sync:              0,
        is_send_kitchen:   0,
        created_at:        db.fn.now(),
    }).returning('*');
    return item;
}

async function addItem({ cartId, product, qty, options, unitPrice, remark }) {
    // category_id is informational (used by legacy reports). Pick the
    // first active link; null when the product isn't categorised yet.
    const ppc = await db('product_product_category')
        .where({ product_id: product.id, status: '1' })
        .orderBy('id', 'asc')
        .first('category_id');

    const [item] = await db('cart_details').insert({
        cart_id:           cartId,
        product_id:        product.id,
        product_name:      product.name || '',
        product_price:     unitPrice,
        product_qty:       qty,
        product_net_price: unitPrice,        // no product-level discount yet (Phase-2C)
        category_id:       ppc ? ppc.category_id : null,
        company_id:        product.company_id,
        remark:            remark || null,
        is_deleted:        0,
        sync:              0,
        is_send_kitchen:   0,
        created_at:        db.fn.now(),
    }).returning('*');

    // One sub-row per chosen modifier option. variant_price is stored as
    // TEXT in the live schema; stringify so we match it.
    for (const opt of (options || [])) {
        const price = Number(opt.price_tax_include) || Number(opt.price_tax_included) || Number(opt.price_tax_excluded) || 0;
        await db('cart_sub_details').insert({
            cart_details_id:         item.id,
            cart_details_product_id: product.id,
            modifier_id:             opt.modifier_group_id,
            modifier_option_id:      String(opt.id),
            variant_name:            opt.option_name || '',
            variant_price:           String(round2(price)),
            variant_qty:             '1',
            variant_type:            null,
            company_id:              product.company_id,
        });
    }

    return item;
}

/**
 * closeCart
 *
 * What:  Marks a cart row `is_open=0` so the customer's `findOpenCart`
 *        lookup skips it. Used when:
 *           • the user confirms "clear cart and switch restaurant"
 *           • the user explicitly clears their cart
 *           • the cart is placed as an order (Phase-2D)
 *        Row is NOT deleted — kept for audit.
 * Type:  WRITE.
 */
/**
 * wipeDiscounts
 *
 * What:  Removes every applied discount from a cart — coupon, voucher, the
 *        auto-discount link, and any redeemed cashback.
 * Why:   "Clear cart" has to mean a clean slate. Anything left behind reappears
 *        on the customer's next basket looking applied while contributing
 *        nothing (the discount is not recomputed against the new items).
 *        used_cashback is only touched when the column exists — the redeem
 *        feature ships behind that migration.
 * Type:  WRITE.
 */
async function wipeDiscounts(cartId) {
    if (!cartId) { return; }
    const patch = {
        coupon_id:     0,
        voucher_id:    0,
        discount_id:   0,
        promocode:     null,
        discount:      0,
        free_delivery: 0,
    };
    if (await hasUsedCashbackCol()) { patch.used_cashback = 0; }
    await db('cart').where({ id: cartId }).update(patch);
}

/**
 * wipeDiscountsIfEmpty
 *
 * What:  Runs wipeDiscounts, but ONLY once the cart has no live lines left.
 * Why:   Removing the last item — or stepping its quantity to zero — leaves the
 *        same empty basket "Clear cart" leaves, so it has to leave it in the
 *        same state. Without this the coupon stayed attached to an empty cart
 *        and came back looking applied against the next thing added, while
 *        contributing nothing (the discount is not recomputed on add).
 * Type:  WRITE. Returns true when it wiped.
 */
async function wipeDiscountsIfEmpty(cartId) {
    if (!cartId) { return false; }
    const row = await db('cart_details')
        .where({ cart_id: cartId, is_deleted: 0 })
        .count('* as n')
        .first();
    if (Number(row && row.n) > 0) { return false; }
    await wipeDiscounts(cartId);
    return true;
}

async function closeCart(cartId) {
    if (!cartId) { return 0; }
    // Only close when STILL open — guards against the
    // sync /order/place + Stripe webhook double-close race.
    // Returns the row count so callers can detect "already closed".
    return db('cart')
        .where({ id: cartId, is_open: CART_OPEN })
        .update({ is_open: 0 });
}

/**
 * loadOwnedLineItem
 *
 * What:  Returns ONE active cart_details row only when it belongs to the
 *        given cart. Returns null when missing / soft-deleted / from
 *        someone else's cart. Caller treats null as "not yours" (404).
 *        Used by update-qty + remove-item before any write.
 * Type:  READ.
 */
async function loadOwnedLineItem(cartId, lineItemId) {
    if (!cartId || !lineItemId) { return null; }
    const row = await db('cart_details')
        .where({ id: lineItemId, cart_id: cartId, is_deleted: 0 })
        .first();
    return row || null;
}

/**
 * updateLineQty
 *
 * What:  Sets cart_details.product_qty to a new value. Caller MUST have
 *        already loadOwnedLineItem'd + validated stock; this is the
 *        write-only path.
 * Type:  WRITE.
 */
async function updateLineQty(lineItemId, qty) {
    if (!lineItemId) { return; }
    await db('cart_details').where({ id: lineItemId }).update({ product_qty: qty });
}

/**
 * resolveDeliveryFee
 *
 * What:  Given the current cart row + its branch, returns the delivery
 *        fee that should be on the cart RIGHT NOW. Pure read — no write.
 *
 *        Rules:
 *          • serve_type = 2 (pickup) → 0
 *          • serve_type = 3 (delivery) AND cart.delivery_postcode set →
 *              longest-prefix match against store_delivery_charge_setup
 *              for this branch; returns matched zone's charge or null
 *              when no zone matches (i.e. "doesn't deliver here").
 *          • delivery + no postcode → null (caller treats as "unknown
 *              yet" and leaves delivery_fees at 0).
 *
 *        Returns: { fee: number|null, zone: <row|null>, deliverable: bool }
 *        deliverable=false signals "address is unservable" — the caller
 *        surfaces it as a warning on the cart.
 * Type:  READ.
 */
async function resolveDeliveryFee(cart, branch) {
    if (!cart || !branch) { return { fee: null, zone: null, deliverable: false }; }
    if (Number(cart.serve_type) === 2) { return { fee: 0, zone: null, deliverable: true }; }
    const pc = String(cart.delivery_postcode || '').trim();
    if (!pc) { return { fee: null, zone: null, deliverable: true }; }

    const rows = await db('store_delivery_charge_setup')
        .where({ branch_id: branch.id, status: 1 })
        .select('postcode', 'charge', 'minimum_order', 'free_delivery_above');
    const zone = M.matchDeliveryZone(pc, rows);
    if (!zone) { return { fee: null, zone: null, deliverable: false }; }

    // Membership-tier free delivery (loyalty) — a high-tier customer with
    // free_delivery_lifetime delivers free regardless of the zone charge.
    let freeByTier = false;
    try { freeByTier = await require('./loyalty').getFreeDelivery(branch.company_id, cart.user_id); } catch (e) { freeByTier = false; }

    // Free-delivery threshold (legacy free_delivery_above) — when the zone
    // waives delivery above a subtotal and the cart's subtotal exceeds it, the
    // fee drops to 0 ("🎉 Free delivery applied!"). Legacy: Commonquery
    // getDeliveryFees (subtotal > free_delivery_above).
    const freeAbove       = Number(zone.free_delivery_above) || 0;
    const subForFree      = Number(cart.sub_total) || 0;
    const freeByThreshold = freeAbove > 0 && subForFree > freeAbove;

    return {
        fee: (freeByTier || freeByThreshold) ? 0 : (Number(zone.charge) || 0),
        zone: zone, deliverable: true, freeByTier, freeByThreshold,
    };
}

/**
 * setAddress
 *
 * What:  Writes the cart's delivery_* fields from a customer_address row,
 *        then resolves the matching delivery zone for the chosen branch
 *        and writes the resulting fee. Pickup carts still call this to
 *        save the address-of-record (used by the order tracker even when
 *        no fee applies).
 *
 *        Returns the resolveDeliveryFee result so the controller can
 *        surface "address.no_zone" as a warning.
 * Type:  WRITE.
 */
async function setAddress(cartId, address, branch) {
    if (!cartId || !address) { return { fee: null, zone: null, deliverable: false }; }

    const postcode  = String(address.post_code || '').trim();
    const lineParts = [address.address, address.line1, address.line2, address.post_town, postcode]
        .map((s) => String(s || '').trim()).filter(Boolean);

    const patch = {
        delivery_address:    lineParts.join(', '),
        delivery_postcode:   postcode,
        delivery_latitude:   address.latitude != null ? String(address.latitude) : null,
        delivery_longitude:  address.longitude != null ? String(address.longitude) : null,
        delivery_label:      address.label || '',
        delivery_building_type: address.address_type || null,
    };

    // driver_instructions is SHARED with the drop-off feature
    // (setInstructions encodes the preset + note there). Only SEED it
    // from the saved address when the cart has none yet — otherwise an
    // explicit drop-off the customer set would be silently wiped every
    // time the address is (re-)applied, including the automatic
    // ensureDefaultDeliveryAddress call on cart load.
    const existing = await db('cart').where({ id: cartId }).first('driver_instructions');
    if (!existing || !String(existing.driver_instructions || '').trim()) {
        patch.driver_instructions = address.delivery_instructions || null;
    }

    // Apply the address patch BEFORE resolving the fee so the resolver
    // sees the new postcode on the cart row.
    await db('cart').where({ id: cartId }).update(patch);

    const cart = await db('cart').where({ id: cartId }).first();
    const r = await resolveDeliveryFee(cart, branch);
    await db('cart').where({ id: cartId }).update({
        delivery_fees: r.fee != null ? r.fee : 0,
    });
    return r;
}

/**
 * ensureDefaultDeliveryAddress
 *
 * What:  When the cart is in delivery mode (serve_type=3) and no
 *        delivery_address is set yet, auto-apply the customer's default
 *        saved address (customer_address with is_default=1 and
 *        status=1). No-op for pickup carts, or when the customer has no
 *        default address yet, or when an address is already attached.
 *
 *        This closes the gap where the cart page shows the default
 *        address visually highlighted but the cart row's column is still
 *        empty — without this, the customer thinks they have an address
 *        picked, hits Place Order, and gets blocked by `address.missing`.
 *
 * Why:   Matches the food-delivery pattern (Zomato / Swiggy / Uber Eats):
 *        once you save a default address, every new order pre-selects it.
 *
 * Type:  WRITE (only writes when an address needs to be applied).
 */
async function ensureDefaultDeliveryAddress(cartId, customerId, branch, browse) {
    if (!cartId || !branch) { return; }
    const cart = await db('cart').where({ id: cartId }).first();
    if (!cart || Number(cart.serve_type) !== 3) { return; }

    const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
    const applyBrowse = () => setAddress(cartId, {
        address:   browse.label || browse.address || '',
        post_code: String(browse.postcode || browse.post_code || '').trim(),
        latitude:  browse.latitude != null ? browse.latitude : (browse.lat != null ? browse.lat : null),
        longitude: browse.longitude != null ? browse.longitude : (browse.lng != null ? browse.lng : null),
        label:     browse.label || '',
    }, branch);

    const cur = String(cart.delivery_postcode || '').trim();

    // ── Header / browse location wins ─────────────────────────────────
    // The location the customer picked at the TOP of the site is the address
    // they're actually ordering to, so the cart's delivery address + the
    // "delivers here?" check must follow it — not a stale DEFAULT saved address.
    const bpc = browse ? String(browse.postcode || browse.post_code || '').trim() : '';
    if (bpc) {
        if (!cur) { await applyBrowse(); return; }            // empty → take the header pick
        if (norm(cur) === norm(bpc)) { return; }              // already the header pick → nothing to do

        // The cart carries a DIFFERENT postcode. KEEP it only when it's an
        // address the customer DELIBERATELY picked at checkout — i.e. one of
        // their SAVED addresses that isn't merely the auto-attached default.
        //
        // Anything else is a LEFTOVER from an earlier header location, and must
        // follow the location shown at the top of the site. Without this, a
        // customer who changes their location still gets "doesn't deliver to
        // <old postcode>" forever, because the stale value never matched their
        // default and so was never replaced.
        if (!customerId) { await applyBrowse(); return; }     // guest → no address book to protect
        const saved = await db('customer_address')
            .where({ customer_id: customerId, status: 1 })
            .select('post_code', 'is_default');
        const hit = saved.find((a) => norm(a.post_code) === norm(cur));
        // non-default saved address ⇒ an explicit checkout pick ⇒ leave it alone
        const deliberate = !!hit && Number(hit.is_default) !== 1;
        if (!deliberate) { await applyBrowse(); }
        return;
    }

    // No header location supplied → legacy fallback: auto-attach the customer's
    // DEFAULT saved address, but only when nothing is attached yet.
    if (!customerId) { return; }
    if (cur || (cart.delivery_address && String(cart.delivery_address).trim() !== '')) { return; }
    const def = await db('customer_address')
        .where({ customer_id: customerId, status: 1, is_default: 1 })
        .first();
    if (!def) { return; }

    await setAddress(cartId, def, branch);
}

/**
 * setMode
 *
 * What:  Switches the cart's serve_type (2 = pickup, 3 = delivery) and
 *        recomputes delivery_fees accordingly. Pickup wipes the fee +
 *        free_delivery flag; delivery re-matches the saved postcode zone
 *        (if any) so the fee reflects the destination.
 *        Caller (controller) runs recomputeTotals AFTER this — the
 *        helper writes the mode-dependent fields only.
 * Type:  WRITE.
 */
async function setMode(cartId, serveType, branch) {
    if (!cartId) { return; }
    const cart = await db('cart').where({ id: cartId }).first();
    if (!cart) { return; }
    const next = Number(serveType) === 2 ? 2 : 3;
    const patch = { serve_type: next };
    if (next === 2) {
        // Pickup has no delivery to charge for. `free_delivery` is a property
        // of the applied COUPON, not of the mode, so it is left alone — the
        // coupon survives the switch and must still waive the fee if the
        // customer flips back to Delivery.
        patch.delivery_fees  = 0;
    } else {
        // Re-price against the destination zone, UNLESS a coupon is waiving
        // delivery. Without this check the zone fee came back on a switch to
        // Delivery while the bill still displayed "Free" (the view reads
        // free_delivery), so the customer was quietly charged it.
        if (Number(cart.free_delivery) === 1) {
            patch.delivery_fees = 0;
        } else {
            const r = await resolveDeliveryFee({ ...cart, serve_type: next }, branch);
            patch.delivery_fees = r.fee != null ? r.fee : 0;
        }
    }
    await db('cart').where({ id: cartId }).update(patch);
}

/**
 * Drop-off options.
 *
 * What:  The marketplace has no per-order drop-off-preset column, so we
 *        encode the preset + the free-text instructions together into
 *        the existing `cart.driver_instructions` text column as a single
 *        parseable line:
 *
 *           [dropoff:<preset>] <free text>
 *
 *        preset ∈ DROP_OFF_OPTIONS keys. Free text is optional. A value
 *        that doesn't start with `[dropoff:` is treated as legacy raw
 *        free text (preset = null) — back-compat with setAddress(),
 *        which writes the saved address's delivery_instructions raw.
 * Why:   One column, no schema change, fully reversible. publicCartView
 *        decodes it so the client never sees the tag.
 */
const DROP_OFF_OPTIONS = {
    hand_to_me:    'Hand it to me',
    meet_at_door:  'Meet at my door',
    meet_outside:  'Meet outside',
    meet_reception:'Meet at reception',
    leave_at_door: 'Leave at my door',
};

function encodeDropOff(preset, text) {
    const p = DROP_OFF_OPTIONS[preset] ? preset : null;
    const t = String(text || '').trim();
    if (!p && !t) { return null; }            // nothing set → clear the column
    if (!p)       { return t; }               // free text only (legacy shape)
    return t ? ('[dropoff:' + p + '] ' + t) : ('[dropoff:' + p + ']');
}

function decodeDropOff(raw) {
    const s = String(raw || '').trim();
    if (!s) { return { dropOffOption: null, dropOffLabel: '', instructions: '' }; }
    // [\s\S] (not . ) so a multi-line free-text note isn't truncated
    // at the first newline.
    const m = s.match(/^\[dropoff:([a-z_]+)\]\s?([\s\S]*)$/);
    if (m && DROP_OFF_OPTIONS[m[1]]) {
        return { dropOffOption: m[1], dropOffLabel: DROP_OFF_OPTIONS[m[1]], instructions: (m[2] || '').trim() };
    }
    // Legacy / untagged → treat whole value as free text, no preset.
    return { dropOffOption: null, dropOffLabel: '', instructions: s };
}

/**
 * setInstructions
 *
 * What:  Persists the drop-off preset + free-text instructions onto the
 *        cart by writing the encoded string into `driver_instructions`.
 *        Mirrors setSchedule's single-UPDATE shape; the controller's
 *        respondWithCart recomputes + returns the public view after.
 * Type:  WRITE.
 */
async function setInstructions(cartId, preset, text) {
    if (!cartId) { return; }
    await db('cart').where({ id: cartId }).update({
        driver_instructions: encodeDropOff(preset, text),
    });
}

/**
 * setSchedule
 *
 * What:  Toggles "Schedule for later" on the cart.
 *
 *          isPreOrder=true  → store the picked datetime on
 *                              `cart.pre_order_time` (timestamptz) and
 *                              set `cart.is_pre_order=1`.
 *          isPreOrder=false → null the timestamp and clear the flag
 *                              (ASAP delivery / pickup).
 *
 *        The legacy POS uses two columns (`pre_order_time` full TS,
 *        `scheduled_time` time-of-day). The marketplace uses ONLY
 *        pre_order_time — Phase-2D place-order will derive the orders
 *        TIME column from it.
 *
 *        Caller MUST have validated that `scheduledAt` is a parseable
 *        Date in the future before invoking. This helper is the WRITE
 *        path only.
 * Type:  WRITE.
 */
async function setSchedule(cartId, scheduledAt, isPreOrder) {
    if (!cartId) { return; }
    if (isPreOrder && scheduledAt) {
        await db('cart').where({ id: cartId }).update({
            is_pre_order:    1,
            pre_order_time:  scheduledAt,
        });
    } else {
        await db('cart').where({ id: cartId }).update({
            is_pre_order:    0,
            pre_order_time:  null,
        });
    }
}

/**
 * setCoupon
 *
 * What:  Persists a successful coupon application on the cart. Caller
 *        (CartController.applyCoupon) has already run coupons.validate()
 *        and is handing in a verified result.
 *
 *          • coupon_id    ← coupon.id
 *          • promocode    ← coupon.code (raw, for display + audit)
 *          • discount     ← computed amount (£)
 *          • free_delivery ← 1 when the coupon waives delivery
 *          • delivery_fees ← zeroed when free_delivery, otherwise kept
 *
 *        recomputeTotals runs after, picking up cart.discount in the
 *        legacy grandtotal formula (sub_total + fees − discount).
 * Type:  WRITE.
 */
async function setCoupon(cartId, coupon, discount, freeDelivery) {
    if (!cartId || !coupon) { return; }
    const patch = {
        coupon_id:    coupon.id,
        voucher_id:   0,                              // coupon + voucher are mutually exclusive
        discount_id:  0,                              // clears any active auto-discount
        promocode:    coupon.code || null,
        discount:     round2(discount),
        free_delivery: freeDelivery ? 1 : 0,
    };
    if (freeDelivery) { patch.delivery_fees = 0; }
    // ONE discount per order — cashback is the third member of that set, so a
    // coupon drops it exactly as it drops a voucher. Legacy blocks the pairing
    // at the checkout screen (checkout.php:2580) but can't clear it, because
    // there cashback lives on the POST, not the cart; ours does, so it must be
    // released here or the customer would silently pay both ways.
    if (await hasUsedCashbackCol()) { patch.used_cashback = 0; }
    await db('cart').where({ id: cartId }).update(patch);
}

/**
 * clearCoupon
 *
 * What:  Wipes the cart's coupon-related fields AND restores the
 *        delivery fee from the saved postcode zone (because free_delivery
 *        might have zeroed it). Caller passes the branch so the zone
 *        lookup can run without a second query.
 *        Returns the resolveDeliveryFee result for the controller's
 *        success message ("delivery fee restored to £X").
 * Type:  WRITE.
 */
async function clearCoupon(cartId, branch) {
    if (!cartId) { return { fee: null, zone: null, deliverable: false }; }

    // Wipe coupon fields first so resolveDeliveryFee sees a "no free
    // delivery" cart.
    await db('cart').where({ id: cartId }).update({
        coupon_id:    0,
        promocode:    null,
        discount:     0,
        free_delivery: 0,
    });

    const cart = await db('cart').where({ id: cartId }).first();
    const r = await resolveDeliveryFee(cart, branch);
    await db('cart').where({ id: cartId }).update({
        delivery_fees: r.fee != null ? r.fee : 0,
    });
    return r;
}

/**
 * setVoucher
 *
 * What:  Applies a validated customer voucher to the cart. Writes
 *        voucher_id + promocode + discount, and clears coupon_id /
 *        discount_id (a voucher is mutually exclusive with a coupon and
 *        wins over any auto-discount). Vouchers never grant free delivery.
 *        recomputeTotals runs after, folding cart.discount into the
 *        grandtotal (clamped to sub_total).
 * Type:  WRITE.
 */
async function setVoucher(cartId, voucher, discount) {
    if (!cartId || !voucher) { return; }
    const patch = {
        voucher_id:    voucher.id,
        coupon_id:     0,                 // voucher + coupon are mutually exclusive
        discount_id:   0,                 // clears any active auto-discount
        promocode:     voucher.code || null,
        discount:      round2(discount),
        free_delivery: 0,                 // vouchers don't waive delivery
    };
    // …and so is cashback — one discount per order. See setCoupon above.
    if (await hasUsedCashbackCol()) { patch.used_cashback = 0; }
    await db('cart').where({ id: cartId }).update(patch);
}

/**
 * clearVoucher
 *
 * What:  Removes the applied voucher (voucher_id / promocode / discount).
 *        No delivery-fee restoration needed — vouchers never zero the
 *        delivery fee. recomputeTotals (run by the caller) re-evaluates
 *        any auto-discount that should now apply instead.
 * Type:  WRITE.
 */
async function clearVoucher(cartId) {
    if (!cartId) { return; }
    await db('cart').where({ id: cartId }).update({
        voucher_id: 0,
        promocode:  null,
        discount:   0,
    });
}

/**
 * setUsedCashback
 *
 * What:  Records how much loyalty cashback the customer wants to redeem
 *        against the cart (Phase 2 redeem). recomputeTotals (run by the
 *        caller) re-clamps it to the live balance + cap and folds it into
 *        grandtotal. No-op when the column hasn't been migrated yet.
 *        Redeem is INDEPENDENT of coupon/voucher — it can stack with them
 *        (mirrors legacy, where used_cashback is separate from discount).
 * Type:  WRITE.
 */
async function setUsedCashback(cartId, amount) {
    if (!cartId || !(await hasUsedCashbackCol())) { return; }
    await db('cart').where({ id: cartId }).update({
        used_cashback: round2(Math.max(0, Number(amount) || 0)),
    });
}

/**
 * clearUsedCashback
 *
 * What:  Removes any redeem applied to the cart (sets used_cashback = 0).
 *        recomputeTotals then restores the full payable. No-op pre-migration.
 * Type:  WRITE.
 */
async function clearUsedCashback(cartId) {
    if (!cartId || !(await hasUsedCashbackCol())) { return; }
    await db('cart').where({ id: cartId }).update({ used_cashback: 0 });
}

// Default charity contribution tiers (% of sub-total) shown on the
// checkout when the branch hasn't configured its own quick_tips rows.
// Matches the legacy 5 / 10 / 15 quick-tip buttons.
const CHARITY_TIERS_DEFAULT = [5, 10, 15];
// Sanity ceiling on a custom charity so a fat-fingered / tampered value
// can't blow up the grand total.
const CHARITY_MAX = 1000;

/**
 * getCharityTiers
 *
 * What:  The charity % tiers to show on the checkout for a branch. Reads
 *        the legacy per-branch quick_tips rows (value = percentage); falls
 *        back to the default 5/10/15 when none are configured so the
 *        selector always works. Returns up to 3 positive integers.
 * Type:  READ.
 */
async function getCharityTiers(branchId, companyId) {
    if (!branchId) { return CHARITY_TIERS_DEFAULT.slice(); }
    try {
        const rows = await db('quick_tips')
            .where({ branch_id: branchId, company_id: companyId })
            .orderBy('id', 'asc')
            .limit(3)
            .select('value');
        const tiers = rows
            .map((r) => Math.round(Number(r.value) || 0))
            .filter((n) => n > 0);
        return tiers.length ? tiers : CHARITY_TIERS_DEFAULT.slice();
    } catch (_) {
        // quick_tips unavailable → fall back to the defaults.
        return CHARITY_TIERS_DEFAULT.slice();
    }
}

/**
 * setCharity
 *
 * What:  Writes the customer's chosen charity contribution onto the cart
 *        (No → 0, a % tier or a custom amount). Clamped to [0, CHARITY_MAX]
 *        and rounded to 2 dp. recomputeTotals (run by the caller's
 *        respondWithCart tail) folds it into the grand total.
 * Type:  WRITE.
 */
async function setCharity(cartId, amount) {
    if (!cartId) { return; }
    const amt = Math.max(0, Math.min(round2(Number(amount) || 0), CHARITY_MAX));
    await db('cart').where({ id: cartId }).update({ charity_amount: amt });
}

/**
 * cardServiceCharge
 *
 * What:  The per-company CARD-payment surcharge (£), read from
 *        company_stripe_settings.service_charge for an ENABLED row.
 *        Applied ONLY when the customer pays by card (Stripe) — cash
 *        orders never carry it. Returns 0 when the company has no enabled
 *        Stripe settings. Mirrors the legacy CompanyStripeSettings
 *        service_charge that the old checkout adds when Stripe is picked.
 * Type:  READ.
 */
async function cardServiceCharge(companyId) {
    if (!companyId) { return 0; }
    try {
        const row = await db('company_stripe_settings')
            .where({ company_id: companyId, is_enable: 1 })
            .first('service_charge');
        return row ? round2(Number(row.service_charge) || 0) : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * removeLineItem
 *
 * What:  Soft-deletes a cart_details row (`is_deleted=1`) and removes its
 *        modifier sub-rows (hard delete on cart_sub_details — they're
 *        meaningless without the parent line and never audited solo).
 *        Caller MUST have already loadOwnedLineItem'd.
 * Type:  WRITE.
 */
async function removeLineItem(lineItemId) {
    if (!lineItemId) { return; }
    await db('cart_sub_details').where({ cart_details_id: lineItemId }).del();
    await db('cart_details').where({ id: lineItemId }).update({ is_deleted: 1 });
}

/**
 * publicCartView
 *
 * What:  Public response shape for GET /cart and every write endpoint.
 *        Hides internal columns the client doesn't need (sync, queue_*,
 *        terminal_*, qr_menu_*, etc.) and reshapes line items + modifiers
 *        into camelCase so the UI stays clean.
 * Type:  READ (pure).
 */
function publicCartView(cart, items, opts) {
    const charityAmount = Number(cart.charity_amount) || 0;
    const fixCharity    = Number(cart.fix_charity_discount) || 0;
    return {
        id:               String(cart.id),
        localId:          cart.localID || '',
        branchId:         cart.branch_id != null ? String(cart.branch_id) : null,
        companyId:        cart.company_id != null ? String(cart.company_id) : null,
        serveType:        Number(cart.serve_type) || 3,
        // Fulfilment modes THIS restaurant offers (config-level) — lets the
        // cart/checkout hide the Pickup or Delivery tab when the restaurant
        // doesn't do that mode. Default true (both) when the caller doesn't
        // pass the branch (write paths); the page-render path (cart GET) sets
        // them from StoreHours.offeredServices(branch).
        canDelivery:      (opts && opts.canDelivery !== undefined) ? !!opts.canDelivery : true,
        canPickup:        (opts && opts.canPickup   !== undefined) ? !!opts.canPickup   : true,
        // Pre-order applicable — the "When"/Schedule row shows only when the
        // restaurant is closed-now + accepts pre-orders + has slots (legacy
        // parity). Open restaurants are ASAP-only (no schedule card).
        canSchedule:      !!(opts && opts.canSchedule),
        // Where the redeemable reward comes from — this restaurant's own pool vs
        // the EatNDeal marketplace pool. rewardMax/rewardBalance above are the
        // COMBINED figures (both are spendable on one order); this is the split
        // so the UI can show "£X from <restaurant> + £Y from EatNDeal".
        rewardPools:      (opts && opts.rewardPools) || { restaurant: 0, marketplace: 0, combined: 0 },
        subTotal:         Number(cart.sub_total)      || 0,
        bagCharge:        Number(cart.bag_charge)     || 0,
        deliveryFees:     Number(cart.delivery_fees)  || 0,
        serviceCharge:    Number(cart.service_charge_amount) || 0,
        // Charity — the customer's chosen contribution (added to the total)
        // and the company's automatic donation (fixCharityDiscount, NOT
        // added). donatedTotal is what the "DONATED" banner shows. tiers
        // are the % quick-buttons for the selector.
        charityAmount:    charityAmount,
        fixCharityDiscount: fixCharity,
        donatedTotal:     round2(charityAmount + fixCharity),
        charityTiers:     (opts && Array.isArray(opts.charityTiers)) ? opts.charityTiers : CHARITY_TIERS_DEFAULT,
        // Card-payment surcharge (company_stripe_settings.service_charge),
        // added to the total ONLY when the customer pays by card. 0 for
        // cash. The UI bumps the total + shows a line when card is picked.
        cardServiceCharge: (opts && typeof opts.cardServiceCharge === 'number') ? opts.cardServiceCharge : 0,
        discount:         Number(cart.discount)       || 0,
        // Where the discount came from — UI labels it differently.
        //   'coupon'  → customer-entered code        (cart.coupon_id > 0)
        //   'voucher' → logged-in customer voucher   (cart.voucher_id > 0)
        //   'auto'    → matched discounts-table row  (cart.discount_id > 0)
        //   null      → no discount applied
        discountSource:   (Number(cart.coupon_id)  > 0) ? 'coupon'
                         : (Number(cart.voucher_id) > 0) ? 'voucher'
                         : (Number(cart.discount_id) > 0) ? 'auto' : null,
        // Loyalty redeem — usedCashback is what's applied to THIS cart and
        // already subtracted from grandtotal. rewardBalance / rewardMax are
        // computed (not cart columns) and only passed on the page-render
        // path (Cart.get) so the checkout can show "Use £X reward".
        usedCashback:     Number(cart.used_cashback)  || 0,
        rewardBalance:    (opts && typeof opts.rewardBalance === 'number') ? opts.rewardBalance : 0,
        rewardMax:        (opts && typeof opts.rewardMax === 'number') ? opts.rewardMax : 0,
        grandtotal:       Number(cart.grandtotal)     || 0,
        totalQty:         Number(cart.total_qty)      || 0,
        freeDelivery:     Number(cart.free_delivery) === 1,
        couponId:         cart.coupon_id ? String(cart.coupon_id) : null,
        voucherId:        cart.voucher_id ? String(cart.voucher_id) : null,
        discountId:       cart.discount_id ? String(cart.discount_id) : null,
        promocode:        cart.promocode || '',
        deliveryAddress:  cart.delivery_address || '',
        deliveryPostcode: cart.delivery_postcode || '',
        deliveryLat:      cart.delivery_latitude != null && cart.delivery_latitude !== '' ? Number(cart.delivery_latitude) : null,
        deliveryLng:      cart.delivery_longitude != null && cart.delivery_longitude !== '' ? Number(cart.delivery_longitude) : null,
        deliveryLabel:    cart.delivery_label || '',
        // Decode the encoded drop-off line so the client gets clean
        // fields and never sees the `[dropoff:...]` tag.
        dropOffOption:    decodeDropOff(cart.driver_instructions).dropOffOption,
        dropOffLabel:     decodeDropOff(cart.driver_instructions).dropOffLabel,
        driverInstructions: decodeDropOff(cart.driver_instructions).instructions,
        // scheduledTime is the display-only HH:MM extracted from the
        // pre_order_time timestamp (the legacy `scheduled_time` time
        // column is unused on marketplace carts — we always store the
        // full datetime in pre_order_time).
        scheduledTime:    formatScheduledTime(cart.pre_order_time, cart.is_pre_order),
        preOrderTime:     cart.pre_order_time || null,
        isPreOrder:       Number(cart.is_pre_order) === 1,
        // Valid pre-order slots (today, this mode) for the schedule popup —
        // [{value:'YYYY-MM-DDTHH:MM', label:'5:15 PM'}]. Only on page-render.
        availableSlots:   (opts && Array.isArray(opts.availableSlots)) ? opts.availableSlots : [],
        items: (items || []).map((it) => ({
            id:           String(it.id),
            productId:    String(it.product_id),
            name:         it.product_name || '',
            qty:          Number(it.product_qty) || 0,
            unitPrice:    Number(it.product_net_price) || 0,
            linePrice:    lineSubtotal(it),
            remark:       it.remark || '',
            modifiers: (it.modifiers || []).map((m) => ({
                id:                String(m.id),
                modifierGroupId:   m.modifier_id != null ? String(m.modifier_id) : null,
                modifierOptionId:  m.modifier_option_id ? String(m.modifier_option_id) : null,
                name:              m.variant_name || '',
                price:             Number(m.variant_price) || 0,
                qty:               Number(m.variant_qty)   || 1,
            })),
        })),
    };
}

module.exports = {
    MARKETPLACE_FLAG,
    CART_OPEN,
    CART_DELETED,
    CART_ACTIVE,
    cartScope,
    getOrCreateCart,
    loadActiveCart,
    findOpenCart,
    claimGuestCart,
    loadCartById,
    loadLineItems,
    lineSubtotal,
    recomputeTotals,
    repriceCart,
    addItem,
    // Surprise Box ("Too Good To Go") — a VIRTUAL line (product_id = 0,
    // is_surprise_item = 1). The flag is what decrements the branch's daily
    // allowance; see Helpers/surpriseBox.
    addSurpriseItem,
    closeCart,
    wipeDiscounts,
    wipeDiscountsIfEmpty,
    loadOwnedLineItem,
    updateLineQty,
    removeLineItem,
    resolveDeliveryFee,
    setMode,
    setAddress,
    ensureDefaultDeliveryAddress,
    setSchedule,
    setInstructions,
    setCoupon,
    clearCoupon,
    setVoucher,
    clearVoucher,
    setUsedCashback,
    clearUsedCashback,
    hasUsedCashbackCol,
    setCharity,
    getCharityTiers,
    cardServiceCharge,
    publicCartView,
    round2,
    DROP_OFF_OPTIONS,
    encodeDropOff,
    decodeDropOff,
};
