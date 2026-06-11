'use strict';

/*
 * Helpers/format.js
 *
 * What:  The api layer's single home for pure value-formatting utilities —
 *        money / rounding, HTML escaping, date display, deterministic card
 *        tint + initial, slug generation and phone normalisation — plus the
 *        currency-symbol constant. All stateless, DB-free, framework-free pure
 *        functions that were duplicated across helpers, controllers and
 *        validators. Change a formatting rule HERE and it changes everywhere.
 *
 *        Consumes the tint palette from Helpers/constants.js so the colour
 *        data lives in one place and the algorithm lives in one place.
 *
 * Used:  Required as `F` across helpers/controllers. Existing modules
 *        (marketplace.js, loyalty.js, helper.js) delegate to these so there is
 *        exactly one implementation of each.
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

const C = require('./constants');

// The trading currency symbol. One constant replaces 79+ hardcoded '£'
// literals across the layer — switch the whole app's currency from here.
const CURRENCY_SYMBOL = '£';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * round2 — NaN/Infinity-safe rounding to 2 decimal places (returns a Number).
 * The canonical rounding used for every money calculation.
 */
function round2(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * formatMoney — a bare 2-decimal money STRING (no symbol), e.g. "5.00".
 * Use for DECIMAL column writes and amount fields.
 */
function formatMoney(n) {
    return round2(n).toFixed(2);
}

/**
 * formatCurrency — a display money string WITH the currency symbol, e.g.
 * "£5.00". opts.decimals (default 2) controls the decimal places, so the
 * "£" + Math.round(x) style passes { decimals: 0 }.
 */
function formatCurrency(n, opts) {
    const dec = (opts && opts.decimals != null) ? opts.decimals : 2;
    return CURRENCY_SYMBOL + round2(n).toFixed(dec);
}

/**
 * escapeHtml — escape the 5 XML/HTML entities (& < > " ') so a value is safe
 * to drop into HTML/JS string contexts. The single, reviewed escaper.
 */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * formatValidTill — a friendly 'D MMM YYYY' date for offer/expiry display.
 * Nudges +12h and reads UTC parts so local-midnight timestamps (stored as the
 * previous day 18:30Z) show their intended calendar date. Returns null on bad
 * input.
 */
function formatValidTill(val) {
    if (!val) { return null; }
    let d = (val instanceof Date) ? val : new Date(val);
    if (isNaN(d.getTime())) { return null; }
    d = new Date(d.getTime() + 12 * 60 * 60 * 1000);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

/**
 * formatDateIso — a local 'YYYY-MM-DD' string (mirrors the legacy PHP date()
 * comparisons exactly). Strings are sliced to their first 10 chars. Returns
 * null on empty input.
 */
function formatDateIso(d) {
    if (!d) { return null; }
    if (typeof d === 'string') { return d.slice(0, 10); }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

/**
 * tintFor — a deterministic pastel from the shared palette for a seed (string
 * or number). String-hash so any seed type hashes stably. Cosmetic only.
 */
function tintFor(seed) {
    const s = String(seed == null ? '' : seed);
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return C.TINT_PALETTE[h % C.TINT_PALETTE.length];
}

/**
 * initialFor — first alphanumeric character of a name, uppercased, '?'
 * fallback. For avatar/placeholder badges.
 */
function initialFor(name) {
    const s = String(name || '').trim();
    if (!s) { return '?'; }
    const ch = s.replace(/[^A-Za-z0-9]/g, '').charAt(0);
    return (ch || '?').toUpperCase();
}

/**
 * slugify — general URL/file-safe slug. Optional `fallback` (default 'n-a') is
 * returned for empty/blank input. Keeps the historical behaviour of
 * helper.slugify (does NOT collapse repeated hyphens) so existing call sites
 * are byte-identical. For restaurant URL slugs use restaurantSlug instead.
 */
function slugify(str, fallback) {
    const fb = (fallback === undefined || fallback === null) ? 'n-a' : String(fallback);
    if (str === null || str === undefined) { return fb; }
    const out = String(str)
        .normalize('NFKD')                          // split combining marks
        .replace(/[̀-ͯ]/g, '')            // strip diacritics
        .replace(/[^a-z0-9\- ]/gi, '')              // drop punctuation
        .replace(/\s+/g, '-')                       // spaces → hyphen
        .replace(/^-+|-+$/g, '')                    // trim hyphens
        .toLowerCase();
    return out || fb;
}

/**
 * restaurantSlug — the restaurant URL slug (COLLAPSES repeated hyphens; falls
 * back to "restaurant-<id>"). Byte-identical to the previous marketplace
 * slugify, used when company.domain_name is missing — must stay stable
 * because it appears in live URLs.
 */
function restaurantSlug(str, fallbackId) {
    const s = String(str || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    if (s) { return s; }
    return fallbackId != null ? 'restaurant-' + fallbackId : 'restaurant';
}

/**
 * normalisePhone — strip spaces / hyphens / parens / leading "+" so a phone
 * matches the shape stored in contact_no.
 */
function normalisePhone(raw) {
    return String(raw || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
}

module.exports = {
    CURRENCY_SYMBOL,
    round2,
    formatMoney,
    formatCurrency,
    escapeHtml,
    formatValidTill,
    formatDateIso,
    tintFor,
    initialFor,
    slugify,
    restaurantSlug,
    normalisePhone,
};
