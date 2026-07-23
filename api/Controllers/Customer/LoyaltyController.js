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
const M         = require('../../Helpers/marketplace');   // companyIdBySlug

/**
 * loyaltyEnabled
 *
 * What:  The customer-facing loyalty master flag — tables present AND at
 *        least one live restaurant with loyalty ON (legacy header gate,
 *        multi-restaurant form). Drives the web's Loyalty Wallet / Earn
 *        Cashback menu visibility.
 * Type:  READ.
 */
async function loyaltyEnabled() {
    return (await loyalty.isReady()) && (await loyalty.anyLoyaltyOn());
}

/**
 * enabled — GET /customer/loyalty/enabled
 *
 * Tiny public flag endpoint the web layer polls (cached) to decide whether
 * the loyalty surfaces render at all. No customer context needed.
 * Type: READ.
 */
async function enabled(req, res) {
    try {
        return H.successResponse(res, { enabled: await loyaltyEnabled() });
    } catch (err) {
        H.log.error('loyalty.enabled', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * attachStampJourneys
 *
 * What:  Adds the legacy "Stamp Reward Journey" block (completed / required /
 *        remaining orders + the locked pot it unlocks) to each RESTAURANT card
 *        — `card.stamp`, null when that restaurant runs no stamp programme.
 *        The wallet page shows it when the customer opens a card.
 * Type:  READ (mutates the passed cards in place).
 */
async function attachStampJourneys(customerId, cards) {
    for (const card of cards || []) {
        if (card.isMarketplace) { card.stamp = null; continue; }
        try { card.stamp = await loyalty.stampJourneyFor(customerId, card.companyId); }
        catch (e) { card.stamp = null; }
    }
}

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
        await attachStampJourneys(customer_id, cards);
        return H.successResponse(res, { cards, enabled: await loyaltyEnabled() });
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
        await attachStampJourneys(customer_id, cards);
        const h = await loyalty.historyFor(customer_id, {
            companyId: company_id, filter, limit, offset,
        });
        // Locked stamp rows carry their restaurant's journey figures so the
        // history line can say "1/5 stamp orders completed · 4 more to unlock"
        // exactly like the legacy wallet.
        const stampByCo = new Map(cards.map((c) => [String(c.companyId), c.stamp]));
        for (const tx of h.transactions) {
            if (tx.locked) { tx.stamp = stampByCo.get(String(tx.companyId)) || null; }
        }
        return H.successResponse(res, {
            cards,
            totals: h.totals,
            transactions: h.transactions,
            total_count: h.total_count,
            enabled: await loyaltyEnabled(),
        });
    } catch (err) {
        H.log.error('loyalty.history', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * reviewTypes — GET /customer/loyalty/review-types
 *
 * Drives the customer "earn cashback by reviewing" page. With ?company_id, the
 * review / share types that restaurant offers (CMS instructions + example
 * screenshot + reward + the customer's claim status). Without it, the list of
 * restaurants currently offering review cashback (the picker).
 * Type: READ.
 */
async function reviewTypes(req, res) {
    try {
        const { customer_id, company_id, slug } = req.query;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        // Prefer the explicit id; else resolve the public slug (the customer URL
        // carries /earn?restaurant=<slug>, never the raw company id).
        //
        // `!= null`, NOT `||` / truthiness: the MARKETPLACE's id is 0, which is
        // falsy — `company_id || null` turned an explicit 0 into null, and
        // `if (cid)` then bounced it back to the picker.
        let cid = (company_id != null && company_id !== '') ? Number(company_id) : null;
        if (cid == null && slug) {
            // The marketplace FIRST: company_id 0 has no `company` row, so
            // companyIdBySlug() can never resolve its slug (it returns null and
            // the card looked broken).
            cid = loyalty.scopeFromSlug(slug);
            if (cid == null) { cid = await M.companyIdBySlug(slug); }
        }

        if (cid != null) {
            const data = await loyalty.reviewTypesFor(cid, customer_id);
            return H.successResponse(res, data);
        }
        const restaurants = await loyalty.reviewRestaurants();
        return H.successResponse(res, { restaurants });
    } catch (err) {
        H.log.error('loyalty.reviewTypes', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { wallet, balance, history, reviewTypes, enabled };
