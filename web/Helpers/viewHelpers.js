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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // Date.getDay()

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

// Friendly 'D MMM YYYY' date in UK local time; '' on empty / unparseable input.
// Read in UK time so a late-evening UTC timestamp doesn't show yesterday's (or
// tomorrow's) date to a customer — see UK_TZ below.
function fmtDate(d) {
    if (!d) { return ''; }
    const dt = new Date(d);
    if (isNaN(dt.getTime())) { return ''; }
    return dt.toLocaleDateString('en-GB', {
        timeZone: UK_TZ, day: 'numeric', month: 'short', year: 'numeric',
    });
}

// The business runs in the UK, so every customer-facing time is shown in UK
// local time — NOT the server's timezone and NOT the viewer's. `toLocaleString()`
// with no zone follows whatever the Node process is set to, which silently
// mis-stated every order time by the offset between that and London (and by an
// hour again through BST). Europe/London handles GMT/BST automatically.
// Fixed, not configurable — the business trades in the UK, the same way
// legacy hardcodes its trading constants in params.php. The api twin is
// config/params.js TRADING_TZ; keep the two in step.
const UK_TZ = 'Europe/London';

/**
 * fmtDateTime / fmtTime — a UTC timestamp rendered in UK local time.
 * '' on empty / unparseable input, so views can guard with a plain falsy check.
 */
function fmtDateTime(d) {
    if (!d) { return ''; }
    const dt = new Date(d);
    if (isNaN(dt.getTime())) { return ''; }
    return dt.toLocaleString('en-GB', {
        timeZone: UK_TZ,
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}
function fmtTime(d) {
    if (!d) { return ''; }
    const dt = new Date(d);
    if (isNaN(dt.getTime())) { return ''; }
    return dt.toLocaleTimeString('en-GB', {
        timeZone: UK_TZ, hour: '2-digit', minute: '2-digit',
    });
}

/**
 * fmtSchedule — a pre-order's day + time as one readable string:
 * 'Today, 17:30' / 'Tomorrow, 05:45' / 'Fri 24 Jul, 05:45'.
 * `date` is 'YYYY-MM-DD' (orders.scheduled_date), `time` is 'HH:MM(:SS)'.
 * Falls back to the bare time for older orders that carry no date.
 */
function fmtSchedule(date, time) {
    // 12-hour "10:54 AM" to match the legacy EatNDeal order display.
    const hhmm = String(time || '').slice(0, 5);
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    const t = m
        ? (((Number(m[1]) % 12) || 12) + ':' + m[2] + ' ' + (Number(m[1]) < 12 ? 'AM' : 'PM'))
        : hhmm;
    if (!date) { return t; }
    const dt = new Date(String(date).slice(0, 10) + 'T00:00:00');
    if (isNaN(dt.getTime())) { return t; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((dt - today) / 86400000);
    if (days <= 0)  { return 'Today, ' + t; }
    if (days === 1) { return 'Tomorrow, ' + t; }
    return WEEKDAYS[dt.getDay()] + ' ' + dt.getDate() + ' ' + MONTHS[dt.getMonth()] + ', ' + t;
}

// First character of a name, uppercased; `fallback` (default '?') when empty.
function getInitial(name, fallback) {
    const fb = (fallback == null) ? '?' : fallback;
    const s = String(name == null ? '' : name).trim();
    return s ? s.charAt(0).toUpperCase() : fb;
}

module.exports = { CURRENCY_SYMBOL, currencySymbol, money, esc, fmtDate, fmtDateTime, fmtTime, fmtSchedule, getInitial };
