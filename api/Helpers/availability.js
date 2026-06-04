'use strict';

/*
 * Helpers/availability.js
 *
 * What:  THE single source of truth for "is this product orderable, and
 *        what badge does the customer see". Replaces ALL marketplace
 *        stock / inventory checks (product_store_inventory, track_stock_level
 *        and counted quantities are gone). Availability is driven purely by
 *        the legacy POS "Item Availability" enum on products.status, plus:
 *          • product_sold_out.is_sold  → the per-product "Sold out" flag
 *          • product_availability      → the "Unavailable until" date/time
 *
 *        Legacy products.status enum (TEXT column — compare as strings),
 *        confirmed against the POS form (backend/.../category/_form.php) and
 *        ProductsController (status == 5 writes product_availability):
 *          '1' = Available
 *          '0' = Unavailable            (merchant turned it off)
 *          '2' = Deleted
 *          '3' = Sold Out
 *          '4' = Unavailable Today      (auto-clears at local midnight)
 *          '5' = Unavailable Until      (date+time in product_availability)
 *
 *        Schedule (Daily/Weekly) is NOT wired into availability — the legacy
 *        customer site doesn't gate on it either, so we match that.
 *
 * Type:  READ (pure). One call per product row.
 * Used:  api product mappers (ProductsController, RestaurantsController),
 *        cart guards (CartController add/updateQty, cartValidate).
 */

// Legacy POS products.status enum (TEXT → compare as strings).
const STATUS = Object.freeze({
    AVAILABLE:          '1',
    UNAVAILABLE:        '0',
    DELETED:            '2',
    SOLD_OUT:           '3',
    UNAVAILABLE_TODAY:  '4',
    UNAVAILABLE_UNTIL:  '5',
});

// Customer-facing surfaces show these states (greyed + badge); plain
// Unavailable ('0') and Deleted ('2') stay HIDDEN (filtered out of the
// query) — a merchant who turns an item off doesn't want it listed.
const SURFACE_STATUSES = Object.freeze([
    STATUS.AVAILABLE, STATUS.SOLD_OUT, STATUS.UNAVAILABLE_TODAY, STATUS.UNAVAILABLE_UNTIL,
]);

/**
 * selectColumns
 *
 * What:  The product-row columns evaluate() needs, ready to spread into a
 *        knex .select(). Keeps every customer-facing product query in sync
 *        — call it instead of hand-writing the status + EXISTS + subselect.
 *          • <alias>.status
 *          • is_sold_out       (EXISTS product_sold_out, is_sold = '1')
 *          • unavailable_until  ("YYYY-MM-DD HH:MM:SS" from product_availability,
 *                                latest row; null when none)
 * Type:  READ (pure). Returns an array of column refs / db.raw fragments.
 */
function selectColumns(db, alias) {
    const a = alias || 'p';
    return [
        `${a}.status`,
        db.raw(`EXISTS (SELECT 1 FROM product_sold_out so WHERE so.product_id = ${a}.id AND so.is_sold::text = '1') AS is_sold_out`),
        db.raw(`(SELECT (pa.availability_date::text || ' ' || pa.availability_time::text)
                 FROM product_availability pa WHERE pa.product_id = ${a}.id
                 ORDER BY pa.id DESC LIMIT 1) AS unavailable_until`),
    ];
}

/**
 * parseUntil
 *
 * What:  Parses the "YYYY-MM-DD HH:MM:SS" string from product_availability
 *        into a Date (local time). Returns null when missing / unparseable.
 * Type:  READ (pure).
 */
function parseUntil(raw) {
    if (!raw) { return null; }
    const d = new Date(String(raw).trim().replace(' ', 'T'));
    return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * fmtFrom
 *
 * What:  Friendly "Available from 5 Jun, 18:30"-style label for the
 *        Unavailable-Until date. Drops the time when it's midnight.
 * Type:  READ (pure).
 */
function fmtFrom(d) {
    if (!d) { return null; }
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const opts = midnight
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleString('en-GB', opts);
}

/**
 * evaluate
 *
 * What:  Maps a product row to a UI-ready availability verdict, mirroring
 *        the legacy Item-Availability semantics.
 *
 *        row: { status, is_sold_out, unavailable_until }  (see selectColumns)
 *        now: Date (defaults to new Date()).
 *
 *        Returns:
 *          {
 *            available: boolean,   // can the customer add it to cart?
 *            soldOut:   boolean,   // show the "Sold out" treatment?
 *            state:     'available' | 'sold_out' | 'unavailable'
 *                       | 'unavailable_today' | 'unavailable_until',
 *            label:     short customer-facing badge text,
 *            reason:    machine reason (null when available),
 *          }
 * Type:  READ (pure).
 */
function evaluate(row, now) {
    now = now || new Date();
    const status   = String(row && row.status != null ? row.status : STATUS.AVAILABLE);
    const soldFlag = !!(row && row.is_sold_out);

    // Sold out — the dropdown "Sold Out" status OR the per-product
    // product_sold_out flag (legacy showed the badge from the latter).
    if (status === STATUS.SOLD_OUT || soldFlag) {
        return { available: false, soldOut: true, state: 'sold_out', label: 'Sold out', reason: 'sold_out' };
    }

    // Hard off / deleted — these are filtered out of surface queries, but
    // guard the cart path defensively in case a line drifts mid-session.
    if (status === STATUS.UNAVAILABLE || status === STATUS.DELETED) {
        return { available: false, soldOut: false, state: 'unavailable', label: 'Unavailable', reason: 'unavailable' };
    }

    // Unavailable today — blocked for the whole of the merchant's local
    // day; the POS auto-clears it back to Available the next day.
    if (status === STATUS.UNAVAILABLE_TODAY) {
        return { available: false, soldOut: false, state: 'unavailable_today', label: 'Unavailable today', reason: 'unavailable_today' };
    }

    // Unavailable until <date+time> — blocked while now is before the
    // stored datetime; once it passes, the item is available again.
    if (status === STATUS.UNAVAILABLE_UNTIL) {
        const until = parseUntil(row && row.unavailable_until);
        if (until && now.getTime() < until.getTime()) {
            const lbl = fmtFrom(until);
            return {
                available: false, soldOut: false, state: 'unavailable_until',
                label: lbl ? ('Available from ' + lbl) : 'Currently unavailable',
                reason: 'unavailable_until',
            };
        }
        return { available: true, soldOut: false, state: 'available', label: 'Available', reason: null };
    }

    // Available ('1') or anything not matched above.
    return { available: true, soldOut: false, state: 'available', label: 'Available', reason: null };
}

module.exports = { STATUS, SURFACE_STATUSES, selectColumns, evaluate };
