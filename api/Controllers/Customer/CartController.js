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
const M         = require('../../Helpers/marketplace');
const { db }    = require('../../config/db');

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
        const customerId = req.query.customer_id;

        // Identity + state guard (deleted / disabled / banned → 4xx).
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // No active cart yet → empty envelope (not an error).
        const open = await Cart.findOpenCart(customerId);
        if (!open) {
            return H.successResponse(res, { cart: null, items: [], warnings: [] });
        }

        // Auto-apply the customer's default address when delivery mode
        // is active and nothing is attached yet — keeps the picker UI
        // honest (the tile already shows "Default", so the cart row must
        // actually carry that address before Place Order).
        const branch = await M.loadActiveBranch(open.branch_id);
        if (branch) {
            await Cart.ensureDefaultDeliveryAddress(open.id, customerId, branch);
        }

        // Defensive recompute — if a price / fee config changed since the
        // last write, the stored grandtotal would be stale. One UPDATE.
        await Cart.recomputeTotals(open.id);

        // Validate at READ level. Cheap-path: skips per-item stock checks
        // (those fire on every WRITE).
        const v = await CartCheck.validate(open.id, customerId, { level: CartCheck.LEVEL.READ });
        if (!v.ok) {
            // Cart got into an unrecoverable state (e.g. branch deleted).
            return H.errorResponse(res, v.errors[0].msg, 409, { errors: v.errors });
        }

        const items = await Cart.loadLineItems(open.id);
        const view  = Cart.publicCartView(v.cart, items);

        return H.successResponse(res, {
            cart:     view,
            warnings: v.warnings,
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
 *           2. Product still marketplace-eligible + in stock + not sold out.
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
        const customerId = b.customer_id;

        // 1. Customer identity guard.
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // 2. Product snapshot — eligibility + stock + sold-out in one
        // round trip. Joined to company so we can apply the marketplace
        // scope filter on the same query.
        const product = await db('products as p')
            .innerJoin('company as c', 'c.id', 'p.company_id')
            .where('p.id', b.product_id)
            .andWhere('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .modify(M.eligibleCompanyScope, 'c')
            .select(
                'p.id', 'p.name', 'p.company_id', 'p.track_stock_level',
                'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax',
                'c.business_name',
                db.raw("EXISTS (SELECT 1 FROM product_sold_out so WHERE so.product_id = p.id AND so.is_sold::text = '1') AS is_sold_out"),
                db.raw('(SELECT COALESCE(SUM(si.quantity::numeric), 0) FROM product_store_inventory si WHERE si.product_id = p.id) AS stock_qty'),
            )
            .first();
        if (!product) {
            return H.errorResponse(res, 'This item is no longer available.', 404);
        }
        if (product.is_sold_out) {
            return H.errorResponse(res, '"' + product.name + '" is sold out.', 422);
        }
        const qty = Number(b.qty) || 1;
        const tracks = Number(product.track_stock_level) === 1;
        const stockQty = Number(product.stock_qty) || 0;
        if (tracks && qty > stockQty) {
            return H.errorResponse(res,
                'Only ' + stockQty + ' "' + product.name + '" left.', 422);
        }

        // 3. Resolve the canonical branch for this company (lowest live id —
        // same rule the marketplace listing uses).
        const branch = await db('branch as b')
            .innerJoin('company as c', 'c.id', 'b.company_id')
            .where('b.company_id', product.company_id)
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            .orderBy('b.id', 'asc')
            .first('b.id', 'b.company_id');
        if (!branch) {
            return H.errorResponse(res, 'This restaurant is no longer available.', 404);
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
        const existing = await Cart.findOpenCart(customerId);
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

        // 6. Get-or-create cart for THIS branch.
        const cart = await Cart.getOrCreateCart({
            customerId,
            branchId:  branch.id,
            companyId: product.company_id,
        });

        // 6b. First add into a fresh cart sets serve_type=3 (delivery)
        // — auto-attach the customer's default address now so the cart
        // page shows the address card filled in instead of "Pick a
        // delivery address" the moment the customer hits the cart.
        await Cart.ensureDefaultDeliveryAddress(cart.id, customerId, branch);

        // 7. Insert line + modifier sub-rows. Unit price is server-side.
        const unitPrice = M.pickPrice(product);
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
        const v = await CartCheck.validate(cart.id, customerId, { level: CartCheck.LEVEL.WRITE });
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
async function respondWithCart(res, cartId, customerId, successMsg) {
    const v = await CartCheck.validate(cartId, customerId, { level: CartCheck.LEVEL.WRITE });
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
 *           • new qty available in stock (when product tracks stock)
 *           • product still marketplace-eligible (catches "removed mid-session")
 *
 *        Stock cap: re-queries `product_store_inventory` SUM so an admin's
 *        mid-session stock drop is honoured without the client knowing.
 * Type:  WRITE.
 *
 * Body:   customer_id, item_id, qty
 * Output: 200 envelope with the refreshed cart, or 422 with errors.
 */
async function updateQty(req, res) {
    try {
        const b = req.body;
        const customerId = b.customer_id;
        const newQty     = Number(b.qty);

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const line = await Cart.loadOwnedLineItem(open.id, b.item_id);
        if (!line) { return H.errorResponse(res, 'That item is not in your cart.', 404); }

        // Stock cap — re-read live (not the snapshot stored on the row).
        const stockRow = await db('products as p')
            .where('p.id', line.product_id)
            .first(
                'p.name', 'p.track_stock_level',
                db.raw("EXISTS (SELECT 1 FROM product_sold_out so WHERE so.product_id = p.id AND so.is_sold::text = '1') AS is_sold_out"),
                db.raw('(SELECT COALESCE(SUM(si.quantity::numeric), 0) FROM product_store_inventory si WHERE si.product_id = p.id) AS stock_qty'),
            );
        if (!stockRow) {
            return H.errorResponse(res, 'That item is no longer available.', 422);
        }
        if (stockRow.is_sold_out) {
            return H.errorResponse(res, '"' + stockRow.name + '" is sold out.', 422);
        }
        const tracks = Number(stockRow.track_stock_level) === 1;
        const stock  = Number(stockRow.stock_qty) || 0;
        if (tracks && newQty > stock) {
            return H.errorResponse(res, 'Only ' + stock + ' "' + stockRow.name + '" left.', 422);
        }

        await Cart.updateLineQty(line.id, newQty);
        return respondWithCart(res, open.id, customerId, 'Quantity updated.');
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
        const customerId = b.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        const line = await Cart.loadOwnedLineItem(open.id, b.item_id);
        if (!line) { return H.errorResponse(res, 'That item is not in your cart.', 404); }

        await Cart.removeLineItem(line.id);
        return respondWithCart(res, open.id, customerId, 'Item removed.');
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
        const customerId = req.body.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
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
        const customerId = b.customer_id;

        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        if (!open) { return H.errorResponse(res, 'Your cart is no longer available.', 404); }

        // Branch must still be live so we can resolve a delivery zone /
        // be confident the chosen mode is still offered.
        const branch = await M.loadActiveBranch(open.branch_id);
        if (!branch) { return H.errorResponse(res, 'This restaurant is no longer available.', 404); }

        await Cart.setMode(open.id, b.serve_type, branch);

        // Switching to Delivery — re-attach the default saved address if
        // none is set yet, so the cart row carries what the picker shows.
        if (Number(b.serve_type) === 3) {
            await Cart.ensureDefaultDeliveryAddress(open.id, customerId, branch);
        }
        return respondWithCart(res, open.id, customerId,
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
        const customerId = req.query.customer_id;
        const { error } = await customers.loadMarketplaceCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const open = await Cart.findOpenCart(customerId);
        const n = open ? (Number(open.total_qty) || 0) : 0;
        return H.successResponse(res, { count: n });
    } catch (err) {
        H.log.error('cart.count', err && err.message);
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

module.exports = { get, count, promotions, add, updateQty, removeItem, clear, setMode, setAddress, setSchedule, setInstructions, applyCoupon, removeCoupon };
