'use strict';

/*
 * Controllers/Customer/LoyaltyController.js
 *
 * What:  Customer-facing loyalty reads (Phase 1):
 *          GET /customer/loyalty/wallet  — the per-restaurant reward cards
 *          GET /customer/loyalty/balance — one restaurant's usable balance
 *
 *        Loyalty is partitioned by company_id, so a single marketplace
 *        customer has a separate card/balance per restaurant. Earning happens
 *        in OrderController.place (Helpers/loyalty.earnForOrder). Redeeming
 *        lands in a later phase.
 *
 * Used:  Wired in api/Routes/index.js.
 *
 * Change log:
 *   2026-06-05 — initial (Phase 1).
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const loyalty   = require('../../Helpers/loyalty');

/**
 * wallet — GET /customer/loyalty/wallet
 *
 * The customer's reward-card wallet: one card per restaurant they've earned
 * at, with live balance + lifetime earned/used.
 * Type: READ.
 */
async function wallet(req, res) {
    try {
        const { customer_id } = req.query;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        const cards = await loyalty.cardsFor(customer_id);
        return H.successResponse(res, { cards, enabled: await loyalty.isReady() });
    } catch (err) {
        H.log.error('loyalty.wallet', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * balance — GET /customer/loyalty/balance
 *
 * One restaurant's usable reward balance for this customer (for the
 * restaurant page chip / future checkout redeem).
 * Type: READ.
 */
async function balance(req, res) {
    try {
        const { customer_id, company_id } = req.query;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        const bal    = await loyalty.balanceFor(customer_id, company_id);
        // Order-streak progress for this restaurant (null when no rule /
        // loyalty off) — drives the "1 more order → £5" chip.
        const streak = await loyalty.streakProgressFor(customer_id, company_id);
        return H.successResponse(res, { balance: bal, streak });
    } catch (err) {
        H.log.error('loyalty.balance', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * history — GET /customer/loyalty/history
 *
 * The full reward wallet for the customer: the per-restaurant cards, the
 * combined totals, and the paginated transaction history (earn / redeem /
 * expired rows). Optionally scoped to one restaurant via company_id, and
 * filtered by status (earned|redeemed|expired|reversed).
 * Type: READ.
 */
async function history(req, res) {
    try {
        const { customer_id, company_id, filter, limit, offset } = req.query;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        const cards = await loyalty.cardsFor(customer_id);
        const h = await loyalty.historyFor(customer_id, {
            companyId: company_id, filter, limit, offset,
        });
        return H.successResponse(res, {
            cards,
            totals: h.totals,
            transactions: h.transactions,
            total_count: h.total_count,
            enabled: await loyalty.isReady(),
        });
    } catch (err) {
        H.log.error('loyalty.history', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { wallet, balance, history };
