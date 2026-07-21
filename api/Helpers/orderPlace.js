'use strict';

/*
 * Helpers/orderPlace.js
 *
 * What:  THE one transaction every marketplace order flows through. Given
 *        a customer + their open cart + the resolved branch + the chosen
 *        payment option, this function writes:
 *
 *           1.  orders                       (with is_marketplace = 1)
 *           2.  orders_items                 (one per cart_details line)
 *           3.  orders_items_sub             (one per cart_sub_details)
 *           4.  orders_payments              (the chosen method)
 *           5.  order_delivery_details       (only when delivery)
 *           6.  cart                         (mark is_open = 0)
 *
 *        ALL inside a single Knex transaction. Any step throws ⇒
 *        rollback ⇒ caller relays a friendly 422 to the customer; nothing
 *        partial lands in the DB.
 *
 *        There is NO stock/inventory step — product availability is
 *        driven by the legacy status enum (see Helpers/availability.js),
 *        not a counted quantity, so nothing is reserved or decremented.
 *
 *        Timing is filled from Helpers/orderTime:
 *           orders.delivery_estimated_time            ← branch's HH:MM:SS string
 *           orders.advanced_order_waiting_time_minute ← integer minutes from
 *                                                       advance_order_waiting_time
 *                                                       (value + volume bucket sums)
 *
 *        Caller MUST have already run cartValidate.validate(PLACE) and
 *        confirmed `ok=true`. This function is the WRITE path only.
 *
 * Type:  WRITE (transactional).
 * Used:  api/Controllers/Customer/OrderController.place
 */

const { db }       = require('../config/db');
const Cart         = require('./cart');
const OrderTime    = require('./orderTime');
const PaymentOptions = require('./paymentOptions');   // enum → the restaurant's own paymentoptions row

/**
 * loadItemsForPlace
 *
 * What:  The cart's line items for the place-order write. Thin pass-through
 *        to Cart.loadLineItems — kept as a named export because both
 *        callers (sync /order/place + the async Stripe webhook recovery)
 *        use it, and so the shape stays in one place.
 *
 *        NOTE: this used to also join products.track_stock_level so the
 *        transaction could decrement inventory. Stock is gone — product
 *        availability is status-driven (see Helpers/availability.js) — so
 *        there is no inventory step and no extra join.
 * Type:  READ.
 */
async function loadItemsForPlace(cartId) {
    return Cart.loadLineItems(cartId);
}

const STATUS_PENDING        = '4';  // legacy convention — staff has to accept
const STATUS_ACCEPTED_PICKUP    = '5';  // pickup / in-store accept (serve_type ≠ 3)
const STATUS_CONFIRMED_DELIVERY = '10'; // delivery accept (serve_type = 3)
const CART_CLOSED          = 0;
const CREATED_FROM_WEB     = '2';  // legacy enum (1=app-iOS, 2=web, 3=app-Android)
// What legacy webordering actually writes on the orders row:
//   created_from = 1   (OrderController.php:540)
//   created_by / updated_by = 1  — a "web ordering system" sentinel, NOT a user
//   id (OrderController.php:537-538, sourced from CartController.php:773).
const CREATED_FROM_LEGACY_WEB = '1';
const SYSTEM_ACTOR            = 1;
const PAYMENT_STATUS_PENDING = 0;  // 0 = unpaid; cash collected on delivery

/*
 * created_via — the ORDER CHANNEL. Legacy's values (they drive the POS
 * loyalty-commission report, backend/modules/loyalty_commission_report):
 *     1 = website   2 = ePOS   3, 4 = phone
 * 5 is OURS: the EatNDeal marketplace. Until now marketplace orders took the
 * column default (1) and were indistinguishable from legacy website orders.
 *
 * The same 5 is written onto the rewards an order earns (Helpers/loyalty), so
 * an order and its cashback always report as the same channel.
 *
 * NB the legacy report buckets only 1 / 2 / 3,4 — a 5 row lands in its
 * grand total but in none of the per-channel columns until a Marketplace
 * bucket is added there.
 */
const CREATED_VIA_MARKETPLACE = 5;

/**
 * generateOrderNumber
 *
 * What:  Generates a marketplace order number in the SAME short shape the
 *        legacy EatNDeal POS uses:
 *           <PREFIX>_YYYYMMDD_<unix-seconds>
 *        e.g. legacy WO_20260624_1782284212 → marketplace MP_20260708_1783600000
 *        The `MP_` prefix keeps marketplace orders visually distinct from the
 *        legacy WO_ (web order) / CC_ (counter) ones while matching their
 *        compact "prefix_date_timestamp" style — the long _HHMMSS_<12-hex>
 *        suffix was replaced with the legacy look per user request.
 * Uniqueness: the tail is the order's OWN id, taken from the orders sequence
 *        before the insert. It used to be unix seconds, which meant two orders
 *        placed in the SAME SECOND were handed the identical number — two
 *        customers seeing one order id. Legacy has the same class of bug (its
 *        `count(*) + 1` races the same way, Commonquery.php:2783-2790), so the
 *        sequence is a deliberate improvement: it cannot collide, needs no
 *        retry loop, and stays readable.
 * Type:  READ (pure).
 */
function generateOrderNumber(now, seq) {
    const d = now || new Date();
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    const ymd = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    return 'MP_' + ymd + '_' + pad(seq, 6);
}

/**
 * resolveOrderStatus
 *
 * What:  Picks the initial `orders.order_status` value. Legacy branch
 *        config has `auto_acc_off_orders` flag — when set, online
 *        orders skip the "Placed/awaiting-accept" stage and land
 *        directly in the accepted state. We honour that flag when present.
 *
 *        Accept code matches the live POS exactly: DELIVERY (serve_type
 *        = 3) → 10 (confirmed, awaiting dispatch); everything else
 *        (pickup / in-store) → 5. (This was previously inverted.)
 * Type:  READ (pure).
 */
function resolveOrderStatus(branch, serveType) {
    const autoAccept = Number(branch && branch.auto_acc_off_orders) === 1;
    if (!autoAccept) { return STATUS_PENDING; }
    return Number(serveType) === 3 ? STATUS_CONFIRMED_DELIVERY : STATUS_ACCEPTED_PICKUP;
}

/**
 * deliveryEstimatedTime
 *
 * What:  Returns the HH:MM:SS string the legacy POS stores on
 *        orders.delivery_estimated_time. For our marketplace it's the
 *        branch's `delivery_waiting_time` (or `pickup_waiting_time` for
 *        pickup), copied verbatim — exactly what legacy saveOrder does.
 *        Returns null when the merchant hasn't set one.
 * Type:  READ (pure).
 */
function deliveryEstimatedTime(branch, serveType) {
    if (!branch) { return null; }
    return Number(serveType) === 2 ? (branch.pickup_waiting_time || null)
                                   : (branch.delivery_waiting_time || null);
}

/*
 * ── Trading day ──────────────────────────────────────────────────────
 * A restaurant's "day" does not end at midnight — it ends at SHOP_CLOSE_TIME
 * (legacy params.php: 06:00:00), so a 2am order still belongs to the evening
 * that produced it. Legacy's shopOpenCloseTime() builds that window; this is
 * the same rule, evaluated in UK local time rather than the server's, since
 * the boundary is a UK trading boundary.
 */
// From config/params.js — the port of legacy params.php, which is where
// legacy reads SHOP_CLOSE_TIME from (Yii::$app->params). Not env, not
// per-branch: one app-wide constant, same as legacy.
const { SHOP_CLOSE_TIME, TRADING_TZ } = require('../config/params');

function tradingWindow(now) {
    const d = now || new Date();
    // "now" as seen in the UK — both the date and the clock time.
    const ymd  = d.toLocaleDateString('en-CA', { timeZone: TRADING_TZ });          // YYYY-MM-DD
    const hms  = d.toLocaleTimeString('en-GB', { timeZone: TRADING_TZ, hour12: false });
    const shift = (isoDate, days) => {
        const t = new Date(isoDate + 'T00:00:00Z');
        t.setUTCDate(t.getUTCDate() + days);
        return t.toISOString().slice(0, 10);
    };
    // Before today's close time ⇒ we are still inside YESTERDAY's trading day.
    const beforeClose = hms < SHOP_CLOSE_TIME;
    const openDate  = beforeClose ? shift(ymd, -1) : ymd;
    const closeDate = beforeClose ? ymd            : shift(ymd, 1);
    return {
        open:  openDate  + ' ' + SHOP_CLOSE_TIME,
        close: closeDate + ' ' + SHOP_CLOSE_TIME,
    };
}

/**
 * nextInternalOrderId
 *
 * What:  The branch's next kitchen-facing order number for the CURRENT trading
 *        day — legacy Commonquery::getOrderInternalId. MAX(+1) inside the
 *        window, or 1 when the branch has no orders yet today.
 *        `created_at` is timestamptz, so it is compared in UK local time to
 *        match the window we just built.
 * Type:  READ (inside the place-order transaction).
 */
async function nextInternalOrderId(trx, branchId, companyId) {
    const w = tradingWindow(new Date());
    const row = await trx('orders')
        .where({ branch_id: branchId, company_id: companyId })
        .andWhereRaw("(created_at AT TIME ZONE ?) >= ?::timestamp", [TRADING_TZ, w.open])
        .andWhereRaw("(created_at AT TIME ZONE ?) <  ?::timestamp", [TRADING_TZ, w.close])
        .max('internal_order_id as max')
        .first();
    return (Number(row && row.max) || 0) + 1;
}

/**
 * dropOffText
 *
 * What:  The cart's encoded drop-off value as a plain, human sentence for the
 *        order note / kitchen ticket:
 *          "[dropoff:meet_outside] ring the bell" → "Meet outside — ring the bell"
 *          "[dropoff:meet_outside]"               → "Meet outside"
 *          "just leave it"        (untagged)      → "just leave it"
 *        Empty in, empty out.
 * Type:  READ (pure).
 */
function dropOffText(raw) {
    const d = Cart.decodeDropOff(raw);
    if (d.dropOffLabel && d.instructions) { return d.dropOffLabel + ' — ' + d.instructions; }
    return d.dropOffLabel || d.instructions || '';
}

/**
 * placeOrder
 *
 * What:  See file header. Returns the inserted orders row on success.
 *        Throws (with a `code` set) on validation-style failures — the
 *        controller maps that to a 422 envelope.
 *
 * Inputs:
 *   { customer, cart, branch, items, paymentOption, customerNote }
 *
 * Output: the orders row (already in DB).
 *
 * Type:  WRITE (transactional).
 */
async function placeOrder({ customer, cart, branch, items, paymentOption, customerNote, paymentIntentId, paymentSucceeded, paymentDetail }) {
    if (!customer || !cart || !branch) {
        throw Object.assign(new Error('place.bad_input'), { code: 'place.bad_input' });
    }
    if (!Array.isArray(items) || items.length === 0) {
        throw Object.assign(new Error('place.empty_cart'), { code: 'place.empty_cart' });
    }

    const now = new Date();
    const advancedExtra = await OrderTime.advancedTime(
        branch.id, cart.company_id, Number(cart.sub_total) || 0,
        Number(cart.serve_type) === 2 ? 'pickup' : 'delivery',
    );

    // Card-payment surcharge — only for card (payment_option 2), read from
    // the same source as createIntent so the recorded total matches what
    // Stripe actually charged. Cash orders carry 0.
    const isCard       = Number(paymentOption) === 2;
    const cardCharge   = isCard ? await Cart.cardServiceCharge(cart.company_id) : 0;
    const grandTotal   = Math.round(((Number(cart.grandtotal) || 0) + cardCharge) * 100) / 100;

    // Loyalty redeem is ALREADY subtracted from cart.grandtotal by
    // recomputeTotals, so grandTotal above is the true payable. We record
    // the redeemed figure on the order and consume the matching reward rows
    // inside the transaction below. 0 / no-op when nothing was redeemed (or
    // the cart column hasn't been migrated yet).
    const usedCashback = Math.round((Number(cart.used_cashback) || 0) * 100) / 100;

    return db.transaction(async (trx) => {
        // ── 1. Sequential internal_order_id — per branch, per TRADING DAY.
        // Legacy Commonquery::getOrderInternalId scopes the MAX() to the
        // shop's trading window (shopOpenCloseTime), so the counter restarts
        // at 1 each day and the kitchen sees "order 7", not "order 507".
        // Ours was an all-time MAX per branch, which never reset.
        const internalOrderId = await nextInternalOrderId(trx, branch.id, cart.company_id);

        // Claim this order's id from the sequence UP FRONT so the number can be
        // built from it. nextval is atomic — two concurrent placements get two
        // different values, which is exactly what the old timestamp tail could
        // not guarantee. The same value is used as the row's explicit id, so
        // the sequence never hands it out twice.
        const seqRow  = await trx.raw("SELECT nextval('orders_id_seq') AS id");
        const orderId = Number((seqRow.rows || seqRow)[0].id);
        const orderNumber = generateOrderNumber(now, orderId);
        const orderStatus = resolveOrderStatus(branch, cart.serve_type);

        // Pre-order schedule → legacy splits it across TWO columns:
        // `scheduled_date` (DATE) + `scheduled_time` (TIME). Both exist on
        // `orders` already. Writing only the time (as we used to) threw the
        // day away, so a 05:45 next-day order was indistinguishable from
        // 05:45 today for the customer, the merchant and EPOS.
        let scheduledTime = null;
        let scheduledDate = null;
        if (Number(cart.is_pre_order) === 1 && cart.pre_order_time) {
            const d = new Date(cart.pre_order_time);
            if (Number.isFinite(d.getTime())) {
                const pad = (n) => String(n).padStart(2, '0');
                scheduledTime = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
                scheduledDate = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
            }
        }

        // ── 2. orders row ───────────────────────────────────────────
        const [order] = await trx('orders').insert({
            // Explicit — this id was already taken from the sequence above to
            // build order_number, so the two can never disagree.
            id:                orderId,
            is_marketplace:    1,
            user_id:           customer.id,
            company_id:        cart.company_id,
            branch_id:         cart.branch_id,
            invoice_id:        Math.floor(now.getTime() / 1000),
            internal_order_id: internalOrderId,
            order_number:      orderNumber,
            order_status:      orderStatus,
            serve_type:        cart.serve_type,
            sub_total:         Number(cart.sub_total)     || 0,
            tax:               Number(cart.tax)           || 0,
            discount:          Number(cart.discount)      || 0,
            discount_id:       Number(cart.discount_id)   || 0,
            coupon_id:         Number(cart.coupon_id)     || 0,
            voucher_id:        Number(cart.voucher_id)    || 0,
            free_delivery:     Number(cart.free_delivery) || 0,
            grand_total:       grandTotal,
            paid_amount:       0,
            delivery_fees:     Number(cart.delivery_fees) || 0,
            delivery_address:  cart.delivery_address || null,
            bag_charge:        Number(cart.bag_charge)    || 0,
            service_charge_amount: Number(cart.service_charge_amount) || 0,
            service_charge_rate:   Number(cart.service_charge_rate)   || 0,
            // Card surcharge (0 for cash) — what Stripe added on top.
            stripe_service_charge: cardCharge,
            charity_amount:    Number(cart.charity_amount) || 0,
            fix_charity_discount: Number(cart.fix_charity_discount) || 0,
            used_cashback:     usedCashback,
            customer_first_name: customer.firstname || '',
            customer_last_name:  customer.lastname  || '',
            customer_email:      customer.email     || '',
            customer_number:     customer.contact_no || '',
            total_qty:         Number(cart.total_qty)    || 0,
            // Fold the customer note + the encoded drop-off line
            // (`[dropoff:...] <text>`, kept verbatim) into the single
            // orders.remark column so the drop-off survives onto the
            // order — there's no dedicated instructions column. Joined
            // with a unique separator loadDetail can split back out.
            // Drop-off is stored ENCODED on the cart ("[dropoff:meet_outside] …")
            // — that tag is an internal storage detail, not something a driver
            // or the kitchen should read. Decode it to the human label before
            // it lands on the order, or the printed note says
            // "[dropoff:meet_outside] ring the bell".
            remark:            [customerNote, dropOffText(cart.driver_instructions), cart.remark]
                                   .map((s) => String(s || '').trim()).filter(Boolean)
                                   .join('  |  ') || null,
            is_pre_order:      Number(cart.is_pre_order) || 0,
            scheduled_date:    scheduledDate,
            scheduled_time:    scheduledTime,
            delivery_estimated_time:           deliveryEstimatedTime(branch, cart.serve_type),
            advanced_order_waiting_time_minute: Number(advancedExtra) || 0,
            created_from:      CREATED_FROM_LEGACY_WEB,
            order_from:        CREATED_FROM_WEB,
            created_via:       CREATED_VIA_MARKETPLACE,   // 5 — see the constant
            status:            '1',
            // Legacy writes the literal 1 here (OrderController.php:537-538 via
            // cart_details.created_by, which CartController.php:773 sets to 1).
            // It is a "placed by the web ordering system" sentinel, NOT a user
            // id — POS reports join created_by to the STAFF table, so a customer
            // id resolves to the wrong person there.
            created_by:        SYSTEM_ACTOR,
            updated_by:        SYSTEM_ACTOR,
            // created_at / updated_at default to NOW.
        }).returning('*');

        // ── 2b. Loyalty redeem — spend the customer's reward balance ────
        // FIFO inside this txn (rows locked FOR UPDATE) + writes the
        // customer_used_rewards ledger. Must FULLY cover the amount the cart
        // total was reduced by; if a concurrent checkout raced us and the
        // live balance fell short, we roll the whole order back rather than
        // under-charge the customer.
        if (usedCashback > 0) {
            // Spend across BOTH pools — the restaurant's own cashback first,
            // then the EatNDeal marketplace balance for the remainder. Each pool
            // gets its own FIFO walk + its own customer_used_rewards ledger row,
            // so reverseForOrder un-spends each correctly on cancel.
            const { consumed } = await require('./loyalty').consumeAcrossPools(trx, {
                customerId: customer.id,
                companyId:  cart.company_id,
                orderId:    order.id,
                amount:     usedCashback,
            });
            if (Math.round(consumed * 100) / 100 < usedCashback) {
                throw Object.assign(new Error('place.reward_short'), { code: 'place.reward_short' });
            }
        }

        // ── 2c. Stamp cards are USE-IT-OR-LOSE-IT ───────────────────────
        // Legacy burns unused stamp rewards on EVERY order (expired_from = 4
        // "Not Used") — whether the customer redeemed them or not; the checkout
        // literally tells them "any unused balance will expire automatically".
        // Runs AFTER the redeem above so whatever was just spent is already
        // accounted for, and inside this txn so a rolled-back order doesn't
        // burn anything. Best-effort inside — never fails the order.
        await require('./loyalty').burnUnusedStamps(trx, {
            customerId: customer.id,
            companyId:  cart.company_id,
        });

        // ── 3. orders_items + orders_items_sub ──────────────────────
        // NB: legacy orders_items doesn't carry category_id — we keep
        // that on cart_details only.
        for (const it of items) {
            const lineTotal = Cart.lineSubtotal(it);
            const [oi] = await trx('orders_items').insert({
                order_id:          order.id,
                // `app_id` on the order-family tables is legacy's POS sync key
                // and holds the PARENT ORDER id — not a customer identity
                // (webordering OrderController.php:605). The EPOS reads line
                // items with `WHERE app_id = <order id>` (:1509), so leaving it
                // null made marketplace orders look like they had no items.
                app_id:            order.id,
                branch_id:         cart.branch_id,
                company_id:        cart.company_id,
                product_id:        it.product_id,
                invoice_id:        Math.floor(now.getTime() / 1000),
                product_name:      it.product_name || '',
                product_qty:       Number(it.product_qty) || 0,
                product_price:     Number(it.product_price)     || 0,
                product_net_price: Number(it.product_net_price) || 0,
                sub_total:         lineTotal,
                remark:            it.remark || null,
                discount:          Number(it.discount_value) || 0,
                // discount_type is NOT NULL on orders_items (default ''
                // but explicit NULL still violates the constraint).
                // Legacy rows store '0' when no line-level discount;
                // mirror that so we never trip the constraint.
                discount_type:     it.discount_type != null ? String(it.discount_type) : '0',
                status:            '1',
                is_free_item:      Number(it.is_free_item) || 0,
                // Carry the Surprise Box flag through to the order. This is
                // load-bearing, not decoration: remaining slots are counted as
                // branch.qty MINUS orders_items where is_surprise_item = 1
                // (Helpers/surpriseBox, legacy Branch::getSurpriseRemainingQty).
                // Drop it and every box sold through the marketplace stays
                // invisible to that count — the branch oversells its allowance
                // for good, because nothing ever decrements.
                is_surprise_item:  Number(it.is_surprise_item) || 0,
                created_by:        SYSTEM_ACTOR,   // legacy sentinel — see SYSTEM_ACTOR
            }).returning('id');

            const itemId = oi.id || oi;
            for (const m of (it.modifiers || [])) {
                await trx('orders_items_sub').insert({
                    app_id:               order.id,   // legacy POS sync key = parent order id
                    orders_items_id:      itemId,
                    company_id:           cart.company_id,
                    product_id:           it.product_id,
                    modifier_id:          m.modifier_id || null,
                    modifier_option_id:   m.modifier_option_id || null,
                    modifier_name:        m.variant_name || '',
                    modifier_option_name: m.variant_name || '',
                    variant_qty:          m.variant_qty || '1',
                    amount:               Number(m.variant_price) || 0,
                    status:               '1',
                });
            }
        }

        // ── 4. orders_payments ──────────────────────────────────────
        // FK is `orders_id` (NOT order_id) per the legacy schema.
        // payment_status is varchar — '0' pending, '1' paid.
        // payment_transaction_id stores the Stripe PaymentIntent id
        // when paymentOption = 2 (card).
        const paidNow = !!paymentSucceeded;
        // Full Stripe payment detail (the Payment Element can charge card /
        // Apple Pay / Google Pay / Link / …) — captured at place-time and
        // stored on the EXISTING columns: sub_payment_method = the actual
        // method, company_stripe_detail = the normalised detail JSON. No
        // schema change; legacy POS just ignores these.
        const subMethod = (paymentDetail && paymentDetail.subMethod) ? String(paymentDetail.subMethod).slice(0, 50) : null;
        // payment_id / payment_type_id are paymentoptions IDs, and paymentoptions
        // is PER-COMPANY (company 1's cash is id 1, company 15's cash is id 11…).
        // Writing our raw 1/2 enum here only happened to be right for company 1 —
        // for every other restaurant it pointed at ANOTHER company's option, and
        // the legacy POS reads this to show how the customer paid. Resolve the
        // restaurant's OWN option (by slug) instead; fall back to the enum when a
        // restaurant has no paymentoptions configured, so nothing regresses.
        const payOpt   = await PaymentOptions.resolveForCompany(cart.company_id, paymentOption);
        const payOptId = payOpt ? payOpt.id : (Number(paymentOption) || 1);
        await trx('orders_payments').insert({
            app_id:                 order.id,   // legacy POS sync key = parent order id
            orders_id:              order.id,
            company_id:             cart.company_id,
            invoice_id:             Math.floor(now.getTime() / 1000),
            payment_id:             payOptId,
            payment_amount:         grandTotal,
            payment_status:         paidNow ? '1' : '0',
            payment_transaction_id: paymentIntentId || null,
            payment_type:           Number(paymentOption) === 2 ? 'Card' : 'Cash',
            payment_type_id:        payOptId,
            sub_payment_method:     subMethod,
            company_stripe_detail:  paymentDetail ? JSON.stringify(paymentDetail) : null,
            status:                 '1',
            created_by:             SYSTEM_ACTOR,   // legacy sentinel — see SYSTEM_ACTOR
        });

        // If card payment succeeded, also stamp the order row's paid_amount
        // with the surcharge-inclusive total Stripe actually captured.
        if (paidNow) {
            await trx('orders').where({ id: order.id }).update({
                paid_amount: grandTotal,
            });
        }

        // ── 5. order_delivery_details (delivery only) ───────────────
        // Legacy schema links via `invoice_id` (matching orders.invoice_id)
        // — no order_id column. Stores delivery routing info; the
        // customer's delivery address is already on orders.delivery_address.
        if (Number(cart.serve_type) === 3) {
            await trx('order_delivery_details').insert({
                app_id:        order.id,   // legacy POS sync key = parent order id
                invoice_id:    Math.floor(now.getTime() / 1000),
                company_id:    cart.company_id,
                branch_id:     cart.branch_id,
                delivery_fees: Number(cart.delivery_fees) || 0,
                status:        '1',
                created_by:    SYSTEM_ACTOR,   // legacy sentinel — see SYSTEM_ACTOR
            });
        }

        // ── 6. Close the cart ───────────────────────────────────────
        await trx('cart').where({ id: cart.id }).update({ is_open: CART_CLOSED });

        // ── 7. Burn a single-use voucher ────────────────────────────
        // If the cart carried a customer voucher, flip it to used so it
        // can't be redeemed again (no-op for multi-use vouchers). Inside
        // the txn so a rolled-back order never consumes the voucher.
        if (Number(cart.voucher_id) > 0) {
            await trx('customer_voucher')
                .where({ id: cart.voucher_id, used_once: 1 })
                .update({ is_used: 1 });
        }

        return order;
    });
}

module.exports = {
    placeOrder,
    loadItemsForPlace,
    generateOrderNumber,
    deliveryEstimatedTime,
    resolveOrderStatus,
};
