'use strict';

/*
 * Helpers/viewHelpers.js
 *
 * What:  The web layer's shared SERVER-SIDE render helpers for EJS — money /
 *        currency, HTML escaping, date display and avatar initial. Injected
 *        once onto app.locals in web/index.js so every `<% %>` scriptlet can
 *        call fmt.money() / fmt.esc() instead of re-declaring the same helper
 *        at the top of each view. Change a display rule HERE → every page.
 *
 *        This is the Node-runtime HALF of the dual formatting concern; the
 *        browser twin is public/js/common/format.js (window.EatNDealFormat),
 *        kept behaviourally identical so server-rendered rows and client
 *        re-rendered rows (pagination/filtering) match byte-for-byte.
 *
 * Used:  app.locals.fmt in web/index.js → every EJS view (wallet, earn, …).
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

const CURRENCY_SYMBOL = '£';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The trading currency symbol for this render, honouring a per-brand override.
function currencySymbol(brand) {
    return (brand && brand.currencySymbol) ? brand.currencySymbol : CURRENCY_SYMBOL;
}

// 2-decimal money. With `symbol` it is prefixed (e.g. money(5,'£') → "£5.00");
// without, a bare amount ("5.00") so callers can place the symbol themselves.
function money(n, symbol) {
    const s = (symbol == null) ? '' : symbol;
    return s + Number(n || 0).toFixed(2);
}

// Escape the 5 HTML entities. The single, reviewed escaper for the views.
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

// Friendly 'D MMM YYYY' date; '' on empty / unparseable input.
function fmtDate(d) {
    if (!d) { return ''; }
    const dt = new Date(d);
    if (isNaN(dt.getTime())) { return ''; }
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()] + ' ' + dt.getFullYear();
}

/**
 * fmtSchedule — a pre-order's day + time as one readable string:
 * 'Today, 17:30' / 'Tomorrow, 05:45' / 'Fri 24 Jul, 05:45'.
 * `date` is 'YYYY-MM-DD' (orders.scheduled_date), `time` is 'HH:MM(:SS)'.
 * Falls back to the bare time for older orders that carry no date.
 */
function fmtSchedule(date, time) {
    const t = String(time || '').slice(0, 5);
    if (!date) { return t; }
    const dt = new Date(String(date).slice(0, 10) + 'T00:00:00');
    if (isNaN(dt.getTime())) { return t; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((dt - today) / 86400000);
    if (days <= 0)  { return 'Today, ' + t; }
    if (days === 1) { return 'Tomorrow, ' + t; }
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()] + ', ' + t;
}

// First character of a name, uppercased; `fallback` (default '?') when empty.
function getInitial(name, fallback) {
    const fb = (fallback == null) ? '?' : fallback;
    const s = String(name == null ? '' : name).trim();
    return s ? s.charAt(0).toUpperCase() : fb;
}

module.exports = { CURRENCY_SYMBOL, currencySymbol, money, esc, fmtDate, fmtSchedule, getInitial };
