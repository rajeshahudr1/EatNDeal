/*
 * public/js/common/format.js
 *
 * What:  The web layer's shared BROWSER-SIDE formatting helpers on the global
 *        window.EatNDealFormat — money / currency, HTML escaping and date
 *        display. Page scripts (pages/*.js, ui/*.js) that re-render markup on
 *        the client call these instead of redefining money()/esc()/fmtDate()
 *        locally. Change a rule here → every client re-render follows.
 *
 *        Browser TWIN of Helpers/viewHelpers.js (the Node/EJS half) — kept
 *        behaviourally identical so a row built server-side and the same row
 *        rebuilt client-side (pagination/filtering) match byte-for-byte.
 *
 * Load:  via <script defer src="/js/common/format.js"> in _layout.ejs, placed
 *        BEFORE the ui/* and pages/* scripts so the global exists first.
 */
(function () {
    'use strict';

    var CURRENCY_SYMBOL = '£';
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // 2-decimal money. With `symbol` it is prefixed; without, a bare amount.
    function money(n, symbol) {
        var s = (symbol == null) ? '' : symbol;
        return s + Number(n || 0).toFixed(2);
    }

    // Escape the 5 HTML entities — the single, reviewed client escaper.
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // Friendly 'D MMM YYYY' date; '' on empty / unparseable input.
    function fmtDate(d) {
        if (!d) { return ''; }
        var dt = new Date(d);
        if (isNaN(dt.getTime())) { return ''; }
        return dt.getDate() + ' ' + MONTHS[dt.getMonth()] + ' ' + dt.getFullYear();
    }

    // First character of a name, uppercased; `fallback` (default '?') when empty.
    function getInitial(name, fallback) {
        var fb = (fallback == null) ? '?' : fallback;
        var s = String(name == null ? '' : name).trim();
        return s ? s.charAt(0).toUpperCase() : fb;
    }

    // Currency symbol the browser knows about (boot payload), else the default.
    function getCurrencySymbol() {
        try { if (window.boot && window.boot.currencySymbol) { return window.boot.currencySymbol; } } catch (e) { /* ignore */ }
        return CURRENCY_SYMBOL;
    }

    window.EatNDealFormat = {
        CURRENCY_SYMBOL: CURRENCY_SYMBOL,
        money: money,
        esc: esc,
        fmtDate: fmtDate,
        getInitial: getInitial,
        getCurrencySymbol: getCurrencySymbol,
    };
})();
