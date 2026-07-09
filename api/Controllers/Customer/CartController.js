'use strict';

/*
 * Controllers/Customer/CartController.js
 *
 * What:  HTTP entry-point for every marketplace cart endpoint. ALL writes
 *        live in Helpers/cart.js; ALL pre-write checks live in
 *        Helpers/cartValidate.js. This file is a thin orchestrator:
 *
 *          1. Validate the request (Joi via middleware — already done).
 *          2. Authenticate the customer (loadMarketplaceCustomer guard).
 *          3. Run the cart-helper write (if any).
 *          4. Re-run the recompute path.
 *          5. Return the public cart view.
 *
 *        Phase 2A.3 ships ONLY the read endpoint:
 *
 *          GET /api/v1/customer/cart?customer_id=…
 *
 *        Subsequent phases add: POST /add, /update-qty, /remove,
 *        /clear, /set-mode, /set-address, /apply-coupon, /place.
 *
 * Auth:  Login required. customer_id is injected by the web proxy from
 *        req.session.user.id; the API rejects requests without it (the
 *        Joi schema marks it required).
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const Cart      = require('../../Helpers/cart');
const CartCheck = require('../../Helpers/cartValidate');
const Coupons   = require('../../Helpers/coupons');
const Vouchers  = require('../../Helpers/vouchers');
const M         = require('../../Helpers/marketplace');
const A         = require('../../Helpers/availability');
const StoreHours = require('../../Helpers/storeHours');
const { db }    = require('../../config/db');

/**
 * resolveOwner
 *
 * What:  Resolves the cart OWNER from a request (body or query). A cart
 *        belongs to EITHER a signed-in customer (customer_id) or a GUEST
 *        (guest_id — a session token the web layer mints for visitors who
 *        haven't signed in yet). Guests can BUILD a cart (add / qty / remove
 *        / clear / set-mode / read); login is only required at CHECKOUT.
 *
 *        Returns { isGuest, customerId?, guestId?, scope } where `scope` is
 *        what Helpers/cart.js expects: the numeric customerId for a customer,
 *        or { guestId } for a guest. null when neither id is present (the
 *        caller then returns 401).
 * Type:  READ (pure).
 */
function resolveOwner(src) {
    const cid = src && src.customer_id;
    if (cid != null && String(cid).trim() !== '' && String(cid) !== '0') {
        return { isGuest: false, customerId: cid, scope: cid };
    }
    const gid = src && src.guest_id;
    if (gid && String(gid).trim() !== '') {
        return { isGuest: true, guestId: String(gid), scope: { guestId: String(gid) } };
    }
    return null;
}

/**
 * get
 *
 * What:  Returns the customer's open marketplace cart (any branch),
 *        recomputed and re-validated at READ level. When the customer
 *        has no open cart yet, returns `{ cart: null, items: [] }` so
 *        the UI can show the empty state without a 404.
 * Type:  READ.
 *
 * Query:  customer_id (required)
 * Output: 200 envelope, data = {
 *           cart: <publicCartView> | null,
 *           items: [...],
 *           warnings: [{code, msg, field}],   // soft notices to surface
 *         }
 */
async function get(req, res) {
    try {
        const owner = resolveOwner(req.query);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }

        // Identity + state guard (deleted / disabled / banned → 4xx) — for
        // signed-in customers only; a guest has no customer row to guard.
        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        // No active cart yet → empty envelope (not an error).
        const open = await Cart.findOpenCart(owner.scope);
        if (!open) {
            return H.successResponse(res, { cart: null, items: [], warnings: [] });
        }

        // Auto-apply the customer's default address when delivery mode
        // is active and nothing is attached yet — keeps the picker UI
        // honest (the tile already shows "Default", so the cart row must
        // actually carry that address before Place Order). Customers only —
        // a guest has no saved address book.
        const branch = await M.loadActiveBranch(open.branch_id);
        if (branch && !owner.isGuest) {
            await Cart.ensureDefaultDeliveryAddress(open.id, owner.customerId, branch, {
                postcode: req.query.loc_postcode, label: req.query.loc_label,
                latitude: req.query.loc_lat,       longitude: req.query.loc_lng,
            });
        }

        // Auto-reprice any line whose price drifted (admin re-priced the
        // product mid-session) — so a plain REFRESH of the cart / checkout page
        // clears the place-order "price changed — refresh your cart" block.
        // recomputeTotals below folds the new line prices into the totals.
        const repriced = await Cart.repriceCart(open.id);

        // Defensive recompute — if a price / fee config changed since the
        // last write, the stored grandtotal would be stale. One UPDATE.
        await Cart.recomputeTotals(open.id);

        // Validate at READ level. Cheap-path: skips per-item availability checks
        // (those fire on every WRITE).
        const v = await CartCheck.validate(open.id, owner.scope, { level: CartCheck.LEVEL.READ });
        if (!v.ok) {
            // Cart got into an unrecoverable state (e.g. branch deleted).
            return H.errorResponse(res, v.errors[0].msg, 409, { errors: v.errors });
        }

        const items = await Cart.loadLineItems(open.id);
        // Charity % tiers for the selector — branch-configured (quick_tips)
        // or the default 5/10/15. Only needed on the page-render path.
        const charityTiers = await Cart.getCharityTiers(open.branch_id, open.company_id);
        // Card-payment surcharge for this company (added only when paying
        // by card) — the page shows it + bumps the total when card picked.
        const cardServiceCharge = await Cart.cardServiceCharge(open.company_id);

        // Loyalty redeem — this restaurant's usable reward balance for this
        // customer + the most they may spend on this cart (balance / cap /
        // sub-total). Feeds the checkout "Use £X reward" row. Best-effort:
        // any loyalty hiccup just hides the redeem option.
        let rewardBalance = 0;
        let rewardMax = 0;
        if (!owner.isGuest) {
            try {
                const Loyalty = require('../../Helpers/loyalty');
                rewardBalance = await Loyalty.balanceFor(owner.customerId, open.company_id);
                rewardMax     = await Loyalty.maxRedeemable({
                    customerId: owner.customerId, companyId: open.company_id, subTotal: Number(v.cart.sub_total) || 0,
                });
            } catch (e) { rewardBalance = 0; rewardMax = 0; }
        }

        // Pre-order slots — valid 15-min times today for this restaurant +
        // the cart's mode (store_business_hours), to populate the schedule
        // popup with real openings instead of a free datetime field.
        let availableSlots = [];
        try {
            if (branch) { availableSlots = await StoreHours.slotsForBranch(branch, v.cart.serve_type); }
        } catch (e) { availableSlots = []; }

        // Which fulfilment modes this restaurant offers (config-level) — so the
        // cart/checkout can hide the Pickup or Delivery tab for a single-mode
        // restaurant. Defaults to both when the branch didn't load.
        const offered = StoreHours.offeredServices(branch);

        // Pre-order applicability (legacy parity) — the "When"/Schedule row only
        // makes sense when the restaurant is CLOSED right now for this mode AND
        // it accepts pre-orders (branch.pre_order=1) AND real slots exist. When
        // it's open, the order is ASAP-only and no schedule card shows (matches
        // legacy webordering, which surfaces pre-order ONLY while closed).
        let canSchedule = false;
        try {
            if (branch && Number(branch.pre_order) === 1) {
                const sched = await StoreHours.availabilityForBranch(branch);
                const svc = sched ? (Number(v.cart.serve_type) === 2 ? sched.services.takeaway : sched.services.delivery) : null;
                const modeOpen = svc ? svc.status === 'open' : (sched ? sched.isOpen : true);
                canSchedule = !modeOpen && availableSlots.length > 0;
            }
        } catch (e) { canSchedule = false; }

        const view  = Cart.publicCartView(v.cart, items, {
            charityTiers, cardServiceCharge, rewardBalance, rewardMax, availableSlots,
            canDelivery: offered.delivery, canPickup: offered.pickup, canSchedule,
        });

        // Surface any auto-reprice as a non-blocking notice so the customer
        // sees the total moved to the latest price (no dead-end block).
        const warnings = (v.warnings || []).slice();
        (repriced.changed || []).forEach((c) => {
            warnings.push({ code: 'price_updated', msg: c.msg, field: 'items.' + c.id });
        });

        return H.successResponse(res, {
            cart:     view,
            warnings,
        });
    } catch (err) {
        H.log.error('cart.get', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * add
 *
 * What:  Adds one product (with optional modifier picks + a remark) to the
 *        customer's open marketplace cart. branch_id + company_id are
 *        derived from the product server-side. Full validation chain:
 *
 *           1. Customer authed + active.
 *           2. Product still marketplace-eligible + available (status-driven:
 *              not sold out / unavailable / unavailable today / until).
 *           3. Each selected modifier option still active AND linked to
 *              THIS product via modifier_group_products (status='1').
 *           4. Branch-conflict: if the customer already has an open cart
 *              for a DIFFERENT branch, return 409 with code
 *              `branch.conflict` so the UI can prompt the user. The
 *              client retries with replace_cart=true to confirm.
 *           5. getOrCreateCart for the resolved branch.
 *           6. addItem (insert cart_details + cart_sub_details).
 *           7. validate(WRITE) — defensive re-check; if anything went
 *              south between resolve and insert (race), we surface it.
 *           8. recomputeTotals; return the public cart view.
 *
 *        Unit price is computed server-side via pickPrice() — the
 *        client never gets to set the price.
 * Type:  WRITE.
 *
 * Body:   customer_id, product_id, qty?, options[], remark?, replace_cart?
 * Output: 200 envelope, data = { cart: <publicCartView>, warnings: [] }
 *         OR 409 envelope with data.code = 'branch.conflict' + branch info.
 */
async function add(req, res) {
    try {
        const b = req.body;
        const owner = resolveOwner(b);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }

        // 1. Customer identity guard — signed-in only. A guest builds a cart
        // (user_id=0, keyed by their session token) and only signs in at
        // checkout, where the guest cart is adopted (Cart.claimGuestCart).
        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        // 2. Product snapshot — eligibility + availability in one round
        // trip. Joined to company so we can apply the marketplace scope
        // filter on the same query. Surface statuses only (Available +
        // the temporary states); Unavailable('0')/Deleted('2') → no row.
        const product = await db('products as p')
            .innerJoin('company as c', 'c.id', 'p.company_id')
            .where('p.id', b.product_id)
            .andWhere('p.show_marketplace', 1)
            .whereIn('p.status', A.SURFACE_STATUSES)
            .modify(M.eligibleCompanyScope, 'c')
            .select(
                'p.id', 'p.name', 'p.company_id',
                'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax',
                'p.discount_type', 'p.discount_value',
                'c.business_name',
                ...A.selectColumns(db, 'p'),
            )
            .first();
        if (!product) {
            return H.errorResponse(res, 'This item is no longer available.', 404);
        }
        // Availability — status-driven (no stock). Reject sold-out /
        // unavailable items server-side even though the UI disables Add.
        const avail = A.evaluate(product);
        if (!avail.available) {
            return H.errorResponse(res,
                '"' + product.name + '" is ' + (avail.soldOut ? 'sold out' : 'currently unavailable') + '.', 422);
        }
        const qty = Number(b.qty) || 1;

        // 3. Resolve the canonical branch for this company (lowest live id —
        // same rule the marketplace listing uses). Select the FULL row so the
        // store-hours gate below has the close-flag / per-service columns it
        // needs (Helpers/storeHours reads branch.closed, show_*_option, etc.).
        const branch = await db('branch as b')
            .innerJoin('company as c', 'c.id', 'b.company_id')
            .where('b.company_id', product.company_id)
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            .orderBy('b.id', 'asc')
            .first('b.*');
        if (!branch) {
            return H.errorResponse(res, 'This restaurant is no longer available.', 404);
        }

        // 3b. Store-hours gate — a CLOSED restaurant must give a clear
        // "currently closed" message, NOT let the add fall through to a
        // confusing downstream error. We check the REAL per-service hours
        // (store_business_hours + close-flag precedence, Helpers/storeHours)
        // for the mode the customer is adding in (2 = pickup, 3 = delivery).
        //
        // pre_order restaurants are the exception: they intentionally let a
        // customer BUILD a cart while closed and schedule it on the cart page,
        // so we only hard-block when the branch does NOT take pre-orders. This
        // mirrors the PLACE-level rule in Helpers/cartValidate.
        const serveType    = Number(b.serve_type) === 2 ? 2 : 3;
        const availability = await StoreHours.availabilityForBranch(branch);
        if (availability) {
            const svc        = serveType === 2 ? availability.services.takeaway : availability.services.delivery;
            const modeOpen   = svc ? svc.status === 'open' : availability.isOpen;
            const preOrderOk = Number(branch.pre_order) === 1;
            if (!modeOpen && !preOrderOk) {
                // Prefer the branch's own closed wording (blanket closures set
                // it); fall back to a plain, correctly-worded message for an
                // out-of-hours close (storeHours leaves message null there).
                const closedMsg = availability.message
                    || ((branch.name ? branch.name : 'This restaurant') + ' is currently closed. Please order during its opening hours.');
                return H.errorResponse(res, closedMsg, 422, { code: 'branch.closed' });
            }
        }

        // 4. Validate modifier options — every option must still be
        // active AND linked to THIS product. One round trip; the IN
        // clause keeps it cheap.
        const optionIds = (b.options || []).map((o) => o.optionId).filter(Boolean);
        let optionRows = [];
        if (optionIds.length) {
            optionRows = await db('modifier_group_options as mgo')
                .innerJoin('modifier_group as mg',          'mg.id',  'mgo.modifier_group_id')
                .innerJoin('modifier_group_products as mgp','mgp.modifier_group_id', 'mgo.modifier_group_id')
                .whereIn('mgo.id', optionIds)
                .andWhere('mgo.status', '1')
                .andWhere('mg.status',  '1')
                .andWhere('mgp.status', '1')
                .andWhere('mgp.product_id', product.id)
                .select(
                    'mgo.id', 'mgo.option_name', 'mgo.modifier_group_id',
                    'mgo.price_tax_include', 'mgo.price_tax_excluded',
                );
            const valid = new Set(optionRows.map((o) => String(o.id)));
            for (const id of optionIds) {
                if (!valid.has(String(id))) {
                    return H.errorResponse(res,
                        'A selected option is no longer available. Please refresh and try again.', 422);
                }
            }
            // Phase-2X dedup — a client can (legitimately or not) send
            // the same modifier option_id twice (e.g. "Extra cheese" via
            // both a default-checked checkbox AND an explicit re-pick).
            // We only insert each option once so the customer isn't
            // charged twice and the kitchen ticket reads cleanly.
            const seen = new Set();
            optionRows = optionRows.filter((o) => {
                const k = String(o.id);
                if (seen.has(k)) { return false; }
                seen.add(k);
                return true;
            });
        }

        // 5. Branch-conflict. The customer can have at most ONE open
        // marketplace cart at a time. Two different restaurants ⇒ ask.
        const existing = await Cart.findOpenCart(owner.scope);
        if (existing && Number(existing.branch_id) !== Number(branch.id)) {
            if (!b.replace_cart) {
                // Standardised envelope: H.errorResponse nests under
                // `data` so the client reads `env.data.code` like every
                // other validator response.
                return H.errorResponse(res,
                    'You have items from another restaurant in your cart. Clear it to add from "' + product.business_name + '"?',
                    409, {
                        code:             'branch.conflict',
                        currentBranchId:  String(existing.branch_id),
                        currentCompanyId: String(existing.company_id || ''),
                        newBranchId:      String(branch.id),
                        newCompanyId:     String(product.company_id),
                        newCompanyName:   product.business_name || '',
                    });
            }
            await Cart.closeCart(existing.id);
        }

        // 6. Get-or-create cart for THIS branch (customer OR guest owner).
        // serveType comes from the customer's active mode toggle (2=pickup,
        // 3=delivery, default 3) so a FRESH cart is created in the mode they
        // actually chose — a Collection order must NOT be created as delivery,
        // or the deliverability gate below fires wrongly. Ignored for an
        // existing cart (mode changes then go through /cart/set-mode).
        const cart = await Cart.getOrCreateCart({
            owner:     owner.scope,
            branchId:  branch.id,
            companyId: product.company_id,
            serveType: Number(b.serve_type) === 2 ? 2 : 3,
        });

        // 6b. First add into a fresh cart sets serve_type=3 (delivery)
        // — auto-attach the customer's default address now so the cart
        // page shows the address card filled in instead of "Pick a
        // delivery address" the moment the customer hits the cart. Customers
        // only — a guest has no saved address book (set at checkout login).
        if (!owner.isGuest) {
            await Cart.ensureDefaultDeliveryAddress(cart.id, owner.customerId, branch, {
                postcode: b.loc_postcode, label: b.loc_label,
                latitude: b.loc_lat,       longitude: b.loc_lng,
            });
        }

        // 6c. Deliverability gate — REFUSE the add up-front when the cart is in
        // delivery mode and the resolved drop-off postcode isn't in ANY of the
        // branch's delivery zones. Checked BEFORE the insert so a non-deliverable
        // restaurant never leaves a phantom line in the cart: the old flow
        // inserted first, then failed WRITE-validation with the same message,
        // but the row was already saved (the "message shows yet item still adds"
        // bug). The customer switches to Pickup or picks a deliverable address.
        if (!owner.isGuest) {
            const dCart = await Cart.loadCartById(cart.id);
            if (dCart && Number(dCart.serve_type) === 3 && dCart.delivery_postcode) {
                const zoneRows = await db('store_delivery_charge_setup')
                    .where({ branch_id: cart.branch_id, status: 1 })
                    .select('postcode');
                if (!M.matchDeliveryZone(dCart.delivery_postcode, zoneRows)) {
                    return H.errorResponse(res,
                        'This restaurant doesn\'t deliver to ' + dCart.delivery_postcode +
                        '. Switch to Pickup or choose a deliverable address.',
                        422, { code: 'address.no_zone', field: 'delivery_postcode' });
                }
            }
        }

        // 7. Insert line + modifier sub-rows. Unit price is server-side,
        // with the product's own discount applied (legacy webordering
        // actionAdd: discount_type 1 = flat £, 2 = %).
        const discountedUnit = M.applyProductDiscount(M.pickPrice(product), product);
        // BOGOF — the customer pays for the payable quantity only (legacy
        // gePaybleQuantity). Expressed as an EFFECTIVE per-unit price so the
        // existing line math (unit × qty) nets the right total — NO schema
        // change (legacy stores a reduced line price too, not a flag).
        const Loyalty = require('../../Helpers/loyalty');
        const bogo    = await Loyalty.bogoForProduct(product.id, product.company_id);
        const payable = Loyalty.payableQtyFor(bogo, qty);
        const unitPrice = (bogo && qty > 0 && payable < qty)
            ? Math.round((discountedUnit * payable / qty) * 100) / 100
            : discountedUnit;
        await Cart.addItem({
            cartId:    cart.id,
            product,
            qty,
            options:   optionRows,
            unitPrice,
            remark:    b.remark || '',
        });

        // 8. Full WRITE-level revalidate (defensive — catches anything
        // that drifted between the snapshot reads above and the insert).
        const v = await CartCheck.validate(cart.id, owner.scope, { level: CartCheck.LEVEL.WRITE });
        if (!v.ok) {
            return H.errorResponse(res, v.errors[0].msg, 422, { errors: v.errors });
        }

        // 9. Recompute + return.
        await Cart.recomputeTotals(cart.id);
        // Re-fetch the cart AFTER recompute so totalQty / sub_total /
        // grandtotal reflect the just-added line. v.cart is pre-recompute.
        const fresh = await Cart.loadCartById(cart.id);
        const items = await Cart.loadLineItems(cart.id);
        const view  = Cart.publicCartView(fresh || v.cart, items);

        return H.successResponse(res, {
            cart:     view,
            warnings: v.warnings,
        }, 'Added to cart.');
    } catch (err) {
        H.log.error('cart.add', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * respondWithCart
 *
 * What:  Tail-end of every WRITE controller — runs `cartValidate.WRITE`
 *        + `recomputeTotals` + builds the publicCartView envelope. The
 *        three writes (update-qty / remove-item / clear) share this same
 *        wrap-up so the response shape is identical.
 * Type:  WRITE (recomputeTotals only).
 */
async function respondWithCart(res, cartId, owner, successMsg) {
    const v = await CartCheck.validate(cartId, owner, { level: CartCheck.LEVEL.WRITE });
    if (!v.ok) {
        return H.errorResponse(res, v.errors[0].msg, 422, { errors: v.errors });
    }
    await Cart.recomputeTotals(cartId);
    // Re-fetch the cart AFTER recompute — v.cart is a pre-recompute
    // snapshot, so total_qty / sub_total / grandtotal on it are stale.
    // Without this re-read the header badge stays at 0 on the very
    // first add.
    const fresh = await Cart.loadCartById(cartId);
    const items = await Cart.loadLineItems(cartId);
    const view  = Cart.publicCartView(fresh || v.cart, items);
    return H.successResponse(res, { cart: view, warnings: v.warnings }, successMsg);
}

/**
 * updateQty
 *
 * What:  Sets one line item's quantity to a new value. Validates:
 *           • customer authed
 *           • cart open + owned
 *           • line item belongs to this cart
 *           • product still marketplace-eligible + available (status-driven)
 *
 *        Availability is re-read live so an admin marking the item
 *        Unavailable / Sold Out mid-session is honoured on the next qty
 *        change without the client knowing.
 * Type:  WRITE.
 *
 * Body:   customer_id, item_id, qty
 * Output: 200 envelope with the refreshed cart, or 422 with errors.
 */
async function updateQty(req, res) {
    try {
        const b = req.body;
        const owner = resolveOwner(b);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }
        const newQty = Number(b.qty);

        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        const open = await Cart.findOpenCart(owner.scope);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const line = await Cart.loadOwnedLineItem(open.id, b.item_id);
        if (!line) { return H.errorResponse(res, 'That item is not in your cart.', 404); }

        // Availability re-check — re-read live (not the snapshot on the
        // row). Status-driven (no stock count): block raising the qty of a
        // now-unavailable / sold-out item.
        const availRow = await db('products as p')
            .where('p.id', line.product_id)
            .first('p.name', ...A.selectColumns(db, 'p'));
        if (!availRow) {
            return H.errorResponse(res, 'That item is no longer available.', 422);
        }
        const avail = A.evaluate(availRow);
        if (!avail.available) {
            return H.errorResponse(res,
                '"' + availRow.name + '" is ' + (avail.soldOut ? 'sold out' : 'currently unavailable') + '.', 422);
        }

        await Cart.updateLineQty(line.id, newQty);
        return respondWithCart(res, open.id, owner.scope, 'Quantity updated.');
    } catch (err) {
        H.log.error('cart.updateQty', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * removeItem
 *
 * What:  Soft-deletes one cart_details row (`is_deleted=1`) and hard-
 *        deletes its cart_sub_details modifiers. Returns the refreshed
 *        cart (or empty if that was the last line).
 * Type:  WRITE.
 *
 * Body:   customer_id, item_id
 */
async function removeItem(req, res) {
    try {
        const b = req.body;
        const owner = resolveOwner(b);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }

        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        const open = await Cart.findOpenCart(owner.scope);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const line = await Cart.loadOwnedLineItem(open.id, b.item_id);
        if (!line) { return H.errorResponse(res, 'That item is not in your cart.', 404); }

        await Cart.removeLineItem(line.id);
        return respondWithCart(res, open.id, owner.scope, 'Item removed.');
    } catch (err) {
        H.log.error('cart.removeItem', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * clear
 *
 * What:  Closes the customer's open marketplace cart (`is_open=0`). The
 *        next add will create a fresh row — same idempotent flow as
 *        getOrCreateCart. Returns an empty-cart envelope so the client
 *        can update its UI without a second round trip.
 * Type:  WRITE.
 *
 * Body:   customer_id
 */
async function clear(req, res) {
    try {
        const owner = resolveOwner(req.body);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }

        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        const open = await Cart.findOpenCart(owner.scope);
        if (open) { await Cart.closeCart(open.id); }

        return H.successResponse(res, { cart: null, warnings: [] }, 'Cart cleared.');
    } catch (err) {
        H.log.error('cart.clear', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setMode
 *
 * What:  Switches the customer's open cart between Delivery (3) and
 *        Pickup (2). The branch must still allow the chosen mode (we
 *        don't have per-branch enable flags in scope yet, so for Phase
 *        2B we accept both modes for every live marketplace branch).
 *        Recomputes delivery_fees via the shared helper so the totals
 *        reflect the new mode in one round trip.
 * Type:  WRITE.
 *
 * Body:   customer_id, serve_type (2=pickup, 3=delivery)
 */
async function setMode(req, res) {
    try {
        const b = req.body;
        const owner = resolveOwner(b);
        if (!owner) { return H.errorResponse(res, 'Please sign in to use the cart.', 401); }

        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        const open = await Cart.findOpenCart(owner.scope);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        // Branch must still be live so we can resolve a delivery zone /
        // be confident the chosen mode is still offered.
        const branch = await M.loadActiveBranch(open.branch_id);
        if (!branch) { return H.errorResponse(res, 'This restaurant is no longer available.', 404); }

        // Reject a mode this restaurant doesn't offer (a delivery-only
        // restaurant can't be switched to Pickup, and vice-versa).
        if (!StoreHours.offersMode(branch, b.serve_type)) {
            return H.errorResponse(res,
                'This restaurant doesn\'t offer ' + (Number(b.serve_type) === 2 ? 'pickup' : 'delivery') + '.',
                422, { code: 'mode.unavailable' });
        }

        await Cart.setMode(open.id, b.serve_type, branch);

        // Switching to Delivery — re-attach the default saved address if
        // none is set yet (customers only — a guest has no address book).
        if (Number(b.serve_type) === 3 && !owner.isGuest) {
            await Cart.ensureDefaultDeliveryAddress(open.id, owner.customerId, branch);
        }
        return respondWithCart(res, open.id, owner.scope,
            b.serve_type === 2 ? 'Switched to Pickup.' : 'Switched to Delivery.');
    } catch (err) {
        H.log.error('cart.setMode', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setAddress
 *
 * What:  Attaches one of the customer's saved addresses to the cart and
 *        re-resolves the delivery fee from the branch's postcode zones.
 *        Validates:
 *          • customer authed
 *          • cart open + owned
 *          • branch still eligible
 *          • address_id belongs to THIS customer AND is active (status=1)
 *
 *        If the address postcode doesn't match any zone, the address is
 *        STILL saved (so the user sees their pick reflected) and a warning
 *        is surfaced — the cart's delivery_fees stays 0 and PLACE-level
 *        validation will block checkout until the customer either changes
 *        the address or switches to pickup.
 * Type:  WRITE.
 *
 * Body:   customer_id, address_id
 */
async function setAddress(req, res) {
    try {
        const b = req.body;
        const customerId = b.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const branch = await M.loadActiveBranch(open.branch_id);
        if (!branch) { return H.errorResponse(res, 'This restaurant is no longer available.', 404); }

        // Address must belong to this customer AND be active (status=1).
        const address = await db('customer_address')
            .where({ id: b.address_id, customer_id: customerId, status: 1 })
            .first();
        if (!address) {
            return H.errorResponse(res, 'That address is no longer available.', 404);
        }

        const result = await Cart.setAddress(open.id, address, branch);

        const successMsg = result.deliverable
            ? 'Delivery address updated.'
            : 'Address saved — this restaurant doesn\'t deliver here. Switch to pickup or pick a different address.';
        return respondWithCart(res, open.id, customerId, successMsg);
    } catch (err) {
        H.log.error('cart.setAddress', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setSchedule
 *
 * What:  Toggles "schedule for later" on the cart.
 *
 *          is_pre_order = true:
 *            • `scheduled_at` must be a parseable date >= now + 15 min.
 *            • Writes `cart.pre_order_time` + `cart.is_pre_order = 1`.
 *
 *          is_pre_order = false:
 *            • `scheduled_at` ignored.
 *            • Clears both columns.
 *
 *        The 15-minute floor matches a sensible minimum lead time —
 *        the kitchen needs at least that to start prepping. Branch-
 *        specific lead-time can be honoured later (branch config field
 *        not yet wired into the marketplace).
 * Type:  WRITE.
 */
async function setSchedule(req, res) {
    try {
        const b = req.body;
        const customerId   = b.customer_id;
        const isPreOrder   = !!b.is_pre_order;
        const rawScheduled = (b.scheduled_at || '').trim();

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        let scheduledDate = null;
        if (isPreOrder) {
            if (!rawScheduled) {
                return H.errorResponse(res, 'Pick a date and time for your pre-order.', 422);
            }
            scheduledDate = new Date(rawScheduled);
            if (!Number.isFinite(scheduledDate.getTime())) {
                return H.errorResponse(res, 'That date and time is not valid.', 422);
            }
            // 15-minute lead-time floor — gives the kitchen a sensible
            // minimum window. Anything sooner is treated as "ASAP".
            const minLead = Date.now() + 15 * 60 * 1000;
            if (scheduledDate.getTime() < minLead) {
                return H.errorResponse(res, 'Please choose a time at least 15 minutes from now.', 422);
            }
            // Must be a REAL opening slot for this restaurant + mode — blocks
            // free-typed times that fall outside the store's business hours.
            const schedBranch = await M.loadActiveBranch(open.branch_id);
            if (schedBranch && !(await StoreHours.isSchedulable(schedBranch, open.serve_type, rawScheduled))) {
                return H.errorResponse(res, 'The restaurant isn\'t open at that time. Please pick an available slot.', 422);
            }
        }

        await Cart.setSchedule(open.id, scheduledDate, isPreOrder);
        return respondWithCart(res, open.id, customerId,
            isPreOrder ? 'Order scheduled.' : 'Switched to ASAP.');
    } catch (err) {
        H.log.error('cart.setSchedule', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setInstructions
 *
 * What:  Saves the customer's drop-off preset + free-text delivery
 *        instructions onto the open cart (encoded into the
 *        driver_instructions column by Cart.setInstructions). Mirrors
 *        setSchedule's shape — no branch dependency.
 * Type:  WRITE.
 *
 * Body:   customer_id, drop_off_option?, instructions?
 */
async function setInstructions(req, res) {
    try {
        const b = req.body;
        const customerId = b.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        await Cart.setInstructions(open.id, b.drop_off_option || null, b.instructions || '');
        return respondWithCart(res, open.id, customerId, 'Delivery instructions saved.');
    } catch (err) {
        H.log.error('cart.setInstructions', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * applyCoupon
 *
 * What:  Validates a promo code against Helpers/coupons.validate() then,
 *        on pass, writes the coupon onto the cart (coupon_id + promocode
 *        + discount + free_delivery). The next recompute folds the
 *        discount into grandtotal via the legacy formula
 *        (sub_total + fees − discount).
 * Type:  WRITE.
 *
 * Body:   customer_id, code
 */
async function applyCoupon(req, res) {
    try {
        const customerId = req.body.customer_id;
        const code       = req.body.code;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        // Eligibility + discount math.
        const v = await Coupons.validate(code, open);
        if (!v.ok) { return H.errorResponse(res, v.error, 422, { code: v.code }); }

        await Cart.setCoupon(open.id, v.coupon, v.discount, v.freeDelivery);
        const msg = v.freeDelivery
            ? 'Coupon applied — free delivery + £' + v.discount.toFixed(2) + ' off!'
            : 'Coupon applied — £' + v.discount.toFixed(2) + ' off.';
        return respondWithCart(res, open.id, customerId, msg);
    } catch (err) {
        H.log.error('cart.applyCoupon', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * removeCoupon
 *
 * What:  Clears the cart's coupon_id / promocode / discount + restores
 *        the delivery_fees from the saved postcode zone (in case the
 *        coupon had granted free delivery).
 * Type:  WRITE.
 */
async function removeCoupon(req, res) {
    try {
        const customerId = req.body.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const branch = await M.loadActiveBranch(open.branch_id);
        if (!branch) { return H.errorResponse(res, 'This restaurant is no longer available.', 404); }

        await Cart.clearCoupon(open.id, branch);
        return respondWithCart(res, open.id, customerId, 'Coupon removed.');
    } catch (err) {
        H.log.error('cart.removeCoupon', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * applyVoucher
 *
 * What:  Validates a customer voucher code (Helpers/vouchers.validate —
 *        must be issued to THIS signed-in customer at this branch/company,
 *        not expired, not used) then writes it onto the cart (voucher_id +
 *        promocode + discount, clearing any coupon). A voucher and a
 *        coupon are mutually exclusive.
 * Type:  WRITE.
 *
 * Body:   customer_id, code
 */
async function applyVoucher(req, res) {
    try {
        const customerId = req.body.customer_id;
        const code       = req.body.code;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const v = await Vouchers.validate(code, open, customerId);
        if (!v.ok) { return H.errorResponse(res, v.error, 422, { code: v.code }); }

        await Cart.setVoucher(open.id, v.voucher, v.discount);
        return respondWithCart(res, open.id, customerId,
            'Voucher applied — £' + v.discount.toFixed(2) + ' off.');
    } catch (err) {
        H.log.error('cart.applyVoucher', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * removeVoucher
 *
 * What:  Clears the cart's applied voucher (voucher_id / promocode /
 *        discount). recomputeTotals then re-evaluates any auto-discount.
 * Type:  WRITE.
 */
async function removeVoucher(req, res) {
    try {
        const customerId = req.body.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        await Cart.clearVoucher(open.id);
        return respondWithCart(res, open.id, customerId, 'Voucher removed.');
    } catch (err) {
        H.log.error('cart.removeVoucher', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * applyLoyalty
 *
 * What:  Redeems loyalty cashback against the open cart (Phase 2 redeem).
 *        The requested amount is clamped server-side to maxRedeemable
 *        (usable balance / restaurant cap / sub-total); recomputeTotals
 *        re-clamps + folds it into grandtotal. Redeem is INDEPENDENT of any
 *        coupon/voucher — it stacks (mirrors legacy used_cashback). The
 *        rewards are not actually burned until the order is placed (the
 *        place transaction consumes them FIFO); this only records intent.
 * Type:  WRITE.
 *
 * Body:   customer_id, amount
 */
async function applyLoyalty(req, res) {
    try {
        const customerId = req.body.customer_id;
        const amount     = Number(req.body.amount) || 0;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        // Redeem column not migrated yet → feature is off.
        if (!(await Cart.hasUsedCashbackCol())) {
            return H.errorResponse(res, 'Rewards aren\'t available right now.', 422);
        }

        const Loyalty = require('../../Helpers/loyalty');
        const max = await Loyalty.maxRedeemable({
            customerId, companyId: open.company_id, subTotal: Number(open.sub_total) || 0,
        });
        if (max <= 0) {
            return H.errorResponse(res, 'You have no reward to use at this restaurant yet.', 422);
        }

        const apply = Math.min(Math.max(0, amount), max);
        if (apply <= 0) {
            return H.errorResponse(res, 'Enter how much reward to use.', 422);
        }

        await Cart.setUsedCashback(open.id, apply);
        return respondWithCart(res, open.id, customerId,
            'Reward applied — £' + apply.toFixed(2) + ' off.');
    } catch (err) {
        H.log.error('cart.applyLoyalty', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * removeLoyalty
 *
 * What:  Clears any redeem applied to the open cart (used_cashback = 0);
 *        recomputeTotals restores the full payable.
 * Type:  WRITE.
 */
async function removeLoyalty(req, res) {
    try {
        const customerId = req.body.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        await Cart.clearUsedCashback(open.id);
        return respondWithCart(res, open.id, customerId, 'Reward removed.');
    } catch (err) {
        H.log.error('cart.removeLoyalty', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * setCharity
 *
 * What:  Saves the customer's chosen charity contribution onto the open
 *        cart. The client sends the resolved amount (No → 0, a % tier of
 *        sub-total, or a Custom £ value); the helper clamps + rounds it.
 *        recomputeTotals folds it into the grand total and the donated
 *        banner reflects it (+ the company's automatic fix-charity).
 * Type:  WRITE.
 *
 * Body:   customer_id, charity_amount
 */
async function setCharity(req, res) {
    try {
        const customerId = req.body.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        await Cart.setCharity(open.id, req.body.charity_amount);
        const amt = Number(req.body.charity_amount) || 0;
        const msg = amt > 0 ? 'Thank you for your contribution!' : 'Charity contribution removed.';
        return respondWithCart(res, open.id, customerId, msg);
    } catch (err) {
        H.log.error('cart.setCharity', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * count
 *
 * What:  Lightweight cart-count probe — returns `{ count }` only. Used
 *        by the web layer's res.locals injector to populate the header
 *        badge on EVERY page render without paying for the full cart
 *        recompute / validate pass.
 *
 *        Returns 0 (not 404) when the customer has no open cart yet, so
 *        the header can render without branching on an error case.
 * Type:  READ.
 *
 * Query:  customer_id (required)
 * Output: 200 envelope, data = { count: <number> }
 */
async function count(req, res) {
    try {
        const owner = resolveOwner(req.query);
        // No owner at all → empty badge (not an error) so the header still
        // renders for a brand-new visitor with no session token yet.
        if (!owner) { return H.successResponse(res, { count: 0 }); }
        if (!owner.isGuest) {
            const { error } = await customers.loadMarketplaceCustomer(owner.customerId);
            if (error) { return H.errorResponse(res, error.msg, error.status); }
        }

        const open = await Cart.findOpenCart(owner.scope);
        const n = open ? (Number(open.total_qty) || 0) : 0;
        return H.successResponse(res, { count: n });
    } catch (err) {
        H.log.error('cart.count', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * claim
 *
 * What:  Adopts a GUEST cart into a just-signed-in customer's account
 *        (set user_id). Called by the web layer immediately after login so
 *        the cart the visitor built as a guest becomes theirs. Idempotent
 *        + best-effort — "no guest cart" is a success (nothing to adopt).
 * Type:  WRITE.
 *
 * Body:   customer_id (required), guest_id (required)
 * Output: 200 envelope, data = { claimed: boolean, cartId? }
 */
async function claim(req, res) {
    try {
        const customerId = req.body.customer_id;
        const guestId    = req.body.guest_id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const result = await Cart.claimGuestCart(String(guestId), customerId);
        return H.successResponse(res, result, result.claimed ? 'Cart claimed.' : 'No guest cart.');
    } catch (err) {
        H.log.error('cart.claim', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * promotions
 *
 * What:  Lists the redeemable coupons for the customer's open cart's
 *        restaurant + serve type — backs the "Your available promos"
 *        list on the checkout Promotions popup. Same eligibility rules
 *        as applyCoupon (see coupons.listActiveForBranch).
 *
 *        Returns an empty list (not an error) when there's no open cart
 *        so the UI can render "No promotions available" cleanly.
 * Type:  READ.
 *
 * Query:  customer_id (required)
 * Output: 200 envelope, data = { promotions: [...], appliedCode: <str|null> }
 */
async function promotions(req, res) {
    try {
        const customerId = req.query.customer_id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.successResponse(res, { promotions: [], appliedCode: null }); }

        const promotions = await Coupons.listActiveForBranch({
            companyId: open.company_id,
            branchId:  open.branch_id,
            serveType: open.serve_type,
            subTotal:  open.sub_total,
        });
        return H.successResponse(res, {
            promotions,
            appliedCode: open.promocode || null,
        });
    } catch (err) {
        H.log.error('cart.promotions', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { get, count, claim, promotions, add, updateQty, removeItem, clear, setMode, setAddress, setSchedule, setInstructions, applyCoupon, removeCoupon, applyVoucher, removeVoucher, applyLoyalty, removeLoyalty, setCharity };
