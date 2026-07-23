'use strict';

/*
 * Controllers/WalletController.js
 *
 * What:  The customer "Loyalty Wallet" page (/wallet) — a MULTI-restaurant
 *        version of the legacy single-wallet page. Shows wallet totals, a card
 *        per restaurant the customer has earned at, and a filterable +
 *        paginated transaction history (the customer_rewards ledger). Optional
 *        ?company= scopes everything to one restaurant; ?filter= filters the
 *        history by status; ?DiningMode= is passed through (legacy context).
 *        /wallet/json is the same data as JSON, used for "Load more".
 * Type:  READ (proxies the JWT-gated /customer/loyalty/history endpoint).
 * Used:  web/index.js — GET /wallet, GET /wallet/json.
 */

const { callApi } = require('../Helpers/apiClient');

const PAGE = 15; // history rows per page

// Build the history API query from the request.
function historyQS(user, q, offset) {
    const params = new URLSearchParams({ customer_id: String(user.id), limit: String(PAGE), offset: String(offset) });
    if (q.company) { params.set('company_id', String(q.company)); }
    if (q.filter && ['earned', 'redeemed', 'expired', 'reversed'].includes(String(q.filter))) { params.set('filter', String(q.filter)); }
    return params.toString();
}

async function fetchHistory(req, user, q, offset) {
    try {
        const r = await callApi(req, 'GET', '/api/v1/customer/loyalty/history?' + historyQS(user, q, offset));
        if (r && r.body && r.body.status === 200 && r.body.data) { return r.body.data; }
    } catch (e) { /* fall through */ }
    return { cards: [], totals: { available: 0, earned: 0, used: 0, expired: 0 }, transactions: [], total_count: 0, enabled: false };
}

// GET /wallet — the full page (first page of history).
async function walletPage(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) { return res.redirect('/signin?next=' + encodeURIComponent('/wallet')); }
    // Loyalty master OFF (super-admin) → the surface doesn't exist; the nav
    // entry is hidden too (partials/account-nav.ejs, res.locals.loyalty_enabled).
    if (res.locals.loyalty_enabled === false) { return res.redirect('/account'); }

    const q = {
        company: req.query.company ? String(req.query.company) : '',
        filter:  req.query.filter ? String(req.query.filter) : '',
        dining:  req.query.DiningMode ? String(req.query.DiningMode) : '',
    };
    const data = await fetchHistory(req, user, q, 0);

    return res.render('wallet/index', {
        page_title:       'Loyalty Wallet',
        _layoutFile:      '../_layout',
        active_nav:       'profile',
        extra_js:         '/js/pages/wallet.js',
        show_promo_strip: false,
        bare:             false,
        wallet:           data,
        wallet_filter:    q.filter,
        wallet_company:   q.company,
        wallet_dining:    q.dining,
        wallet_page_size: PAGE,
    });
}

// GET /wallet/json — the next page of history rows (for "Load more").
async function walletJson(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) { return res.status(401).json({ status: 401, msg: 'Sign in required.' }); }

    const q = {
        company: req.query.company ? String(req.query.company) : '',
        filter:  req.query.filter ? String(req.query.filter) : '',
    };
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const data = await fetchHistory(req, user, q, offset);
    return res.json({ status: 200, data: { transactions: data.transactions, total_count: data.total_count } });
}

module.exports = { walletPage, walletJson };
