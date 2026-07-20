'use strict';

/*
 * Helpers/surpriseBox.js
 *
 * What:  How many Surprise Box ("Too Good To Go") slots a branch has LEFT right
 *        now — the single source of truth for that number.
 *
 * Why:   `branch.qty` is the box's DAILY ALLOWANCE, not what's still available.
 *        The marketplace restaurant page was printing branch.qty raw, so a
 *        branch with 50/day that had already sold 16 advertised "50 left" while
 *        legacy correctly showed "34 slots left" — i.e. we were overselling a
 *        box that can't be made. Ported from legacy
 *        Branch::getSurpriseRemainingQty (common/models/branch/Branch.php:1135-1167).
 *
 * The maths (legacy-identical):
 *        used      = ordered_since_reset + held_in_live_carts
 *        remaining = max(0, branch.qty - used)
 *        "since reset" = created_at >= branch.surprise_qty_updated_date, the
 *        column the branch bumps to restart the day's allowance.
 *
 * ⚠ The cart-hold window is DEAD IN LEGACY — do not copy it verbatim.
 *        Legacy gates cart holds on
 *            cd.created_at > NOW() - INTERVAL '{SURPRISE_ITEM_EXPIRED} minutes'
 *        but `SURPRISE_ITEM_EXPIRED` is never defined in ANY legacy config —
 *        it is only ever read (Branch.php:1137). PHP casts the missing param to
 *        (int)null = 0, so the SQL becomes `cd.created_at > NOW()`, which is
 *        never true: legacy silently counts NO cart holds at all. Two customers
 *        can hold the last box at once there.
 *        We keep the window as a real, configurable reservation
 *        (SURPRISE_HOLD_MINUTES, default 30) because that is plainly the intent
 *        — but it is a DELIBERATE divergence, so the number here can be a touch
 *        lower than the POS page's while a cart is live. That's the safe
 *        direction: better to under-promise than to sell a box that's gone.
 *        Set SURPRISE_HOLD_MINUTES=0 to match legacy's behaviour exactly.
 *
 * Type:  READ.
 * Used:  Controllers/Marketplace/RestaurantsController (detail page).
 *
 * Change log:
 *   2026-07-15 — initial (marketplace was showing the raw daily allowance).
 */

const { db } = require('../config/db');

// How long an un-ordered cart line holds a slot. Legacy intends this but its
// param is undefined, so its window collapses to zero — see the header.
const HOLD_MINUTES = process.env.SURPRISE_HOLD_MINUTES != null
    ? Number(process.env.SURPRISE_HOLD_MINUTES)
    : 30;

/**
 * remainingFor
 *
 * Inputs: branch — { id, company_id, qty, surprise_qty_updated_date }
 * Output: { total, used, ordered, held, remaining }
 *         remaining is never negative (legacy clamps with max(0, …) too).
 */
async function remainingFor(branch) {
    const total = Number(branch && branch.qty) || 0;
    if (!branch || !branch.id || total <= 0) {
        return { total, used: 0, ordered: 0, held: 0, remaining: Math.max(0, total) };
    }

    // The day's allowance restarts whenever the branch bumps this date. A NULL
    // means "never reset" — count everything, rather than silently counting
    // nothing (which a NULL comparison in SQL would do).
    const since = branch.surprise_qty_updated_date || '1970-01-01';

    const [ord, cart] = await Promise.all([
        db('orders_items')
            .where({ company_id: branch.company_id, branch_id: branch.id, is_surprise_item: 1 })
            .andWhere('created_at', '>=', since)
            .sum({ s: 'product_qty' }).first(),
        HOLD_MINUTES > 0
            ? db('cart_details as cd')
                .join('cart as c', 'c.id', 'cd.cart_id')
                .where({ 'c.company_id': branch.company_id, 'c.branch_id': branch.id, 'cd.is_surprise_item': 1 })
                // Only LIVE lines in LIVE carts hold a slot. Legacy filters
                // neither (Branch.php:1147-1159) — a removed box, or one in a
                // cart abandoned when the customer switched restaurant, went on
                // holding its slot. That flaw is invisible in legacy because its
                // hold window is dead (the undefined SURPRISE_ITEM_EXPIRED
                // collapses to 0 minutes, see the header) — reviving the window
                // makes it real, so it has to be filtered here. Proven: removing
                // 3 boxes left "31 left" instead of 34.
                .andWhere('cd.is_deleted', 0)
                .andWhere('c.is_open', 1)
                .andWhere('c.is_deleted', 0)
                .andWhere('cd.created_at', '>=', since)
                .andWhereRaw(`cd.created_at > NOW() - INTERVAL '${Number(HOLD_MINUTES)} minutes'`)
                .sum({ s: 'cd.product_qty' }).first()
            : Promise.resolve({ s: 0 }),
    ]);

    const ordered = Number(ord && ord.s) || 0;
    const held    = Number(cart && cart.s) || 0;
    const used    = ordered + held;

    return { total, used, ordered, held, remaining: Math.max(0, total - used) };
}

/**
 * isInWindow
 *
 * What:  Is NOW inside the branch's collection window? Ported from legacy
 *        ToogoodtogoController::isInTimeWindow — the box can only be added
 *        while the counter is actually handing bags out.
 * Why:   Returns the formatted bounds too, because the legacy error names them:
 *        "This product is only available between 7:00 AM and 10:00 PM".
 * Type:  READ (pure).
 * Output: { open, from, to }
 */
function isInWindow(startTime, endTime) {
    const fmt = (t) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
        if (!m) { return ''; }
        let h = Number(m[1]);
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12; if (h === 0) { h = 12; }
        return h + ':' + m[2] + ' ' + ampm;
    };
    const mins = (t) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
        return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
    };
    const from = mins(startTime);
    const to   = mins(endTime);
    const out  = { open: true, from: fmt(startTime), to: fmt(endTime) };
    // No window configured → don't block the sale on missing data.
    if (from == null || to == null) { return out; }

    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    // A window that ends before it starts spans midnight (e.g. 22:00 → 02:00),
    // where `from <= cur <= to` is never true — check the two halves instead.
    out.open = (to >= from) ? (cur >= from && cur <= to) : (cur >= from || cur <= to);
    return out;
}

module.exports = { remainingFor, isInWindow, HOLD_MINUTES };
