'use strict';

/*
 * Helpers/viewFormat.js  (admin layer)
 *
 * What:  Server-side render-time formatting helpers for the admin EJS views —
 *        the sym / money / num / value-by-type boilerplate that was re-declared
 *        at the top of nearly every currency-showing view. Injected once onto
 *        app.locals.fmt in admin/index.js so views call fmt.* instead.
 *
 *        Runs in Node at render time, so it is NOT the same file as the browser
 *        money formatter (public/js/common/format.js) — that is the client
 *        twin; keep the two behaviourally in sync.
 *
 * Used:  app.locals.fmt in admin/index.js → every admin EJS view.
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

const CURRENCY_SYMBOL = '£';

// The currency symbol for this render, honouring a per-brand override.
function currencySymbol(brand) {
    return (brand && brand.currencySymbol) ? brand.currencySymbol : CURRENCY_SYMBOL;
}

// Money with the symbol + en-GB grouping + 2 decimals (e.g. "£1,234.00").
function money(amount, brand) {
    return currencySymbol(brand) + Number(amount || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A grouped integer (e.g. "1,234"), no symbol/decimals.
function num(n) {
    return Number(n || 0).toLocaleString('en-GB');
}

// A '£12.34' (flat) or '5%' (percent) cashback value, by its value_type.
function valueByType(valueType, value, brand) {
    return valueType === '£' ? (currencySymbol(brand) + Number(value).toFixed(2)) : (Number(value) + '%');
}

// Whole-number percentage of value within max (for bar widths), 0..100.
function percentageOf(value, max) {
    return Math.round((Number(value) / Number(max)) * 100);
}

module.exports = { CURRENCY_SYMBOL, currencySymbol, money, num, valueByType, percentageOf };
