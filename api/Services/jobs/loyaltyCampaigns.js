'use strict';

/**
 * Services/jobs/loyaltyCampaigns.js
 *
 * What:   The two SCHEDULED smart-campaign rewards — ports of the legacy console
 *         commands `CronController::actionTopSpendersCashback` (:324) and
 *         `::actionMostReferralsCashback` (:521):
 *
 *           top_spenders   — rank customers by SUM(order sub_total) over LAST
 *                            MONTH, reward the top `target_value`.
 *           most_referrals — rank customers by how many people they referred
 *                            (customer.referred_by) over LAST MONTH, reward the
 *                            top `target_value`.
 *
 *         (The third campaign type, `inactive` / win-back, is NOT here — it's
 *         evaluated at order-place by Helpers/loyalty.earnSmartCampaign.)
 *
 * Why:    We had no scheduler layer at all, so these two campaign types were
 *         configured in the admin but could never pay out.
 *
 * SCOPE:  The MARKETPLACE's own programme only (company_id = 0). A restaurant's
 *         campaigns belong to the legacy Eat N Deal POS, which runs these exact
 *         crons itself — this job must never reach into that data.
 *         Consequence: the leaderboards are MARKETPLACE-WIDE (one board across
 *         every restaurant, from orders.is_marketplace = 1), not per-restaurant
 *         like legacy's PARTITION BY company_id. That's the point of a
 *         marketplace programme: EatNDeal rewards its own best customers.
 *
 * Money:  Rewards go through Helpers/loyalty.award(), which already does the
 *         commission skim (company_loyalty.loyalty_commission), the expiry /
 *         notify dates, and the admin_reward_commissions audit row — so the
 *         ledger is identical to every other earn path. Legacy hand-rolled the
 *         same maths in raw SQL.
 *
 * Idempotency: legacy guards with
 *         NOT EXISTS (… entity_id = rule.id AND DATE(created_at) = CURRENT_DATE)
 *         i.e. at most one award per rule per customer PER DAY. Same here, so a
 *         double run (or a manual re-run) can't pay twice.
 *
 * Type:   WRITE.
 * Used:   api/index.js (scheduler.register) + scripts/loyalty-campaigns.js.
 */

const { db } = require('../../config/db');
const H      = require('../../Helpers/helper');
const Loyalty = require('../../Helpers/loyalty');

const MP = Loyalty.MARKETPLACE_COMPANY_ID;   // 0

// First/last instant of LAST calendar month (legacy's window).
function lastMonthRange() {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth() - 1, 1, 0, 0, 0);
    const end   = new Date(n.getFullYear(), n.getMonth(), 0, 23, 59, 59);
    return { start, end };
}

// Legacy's per-day idempotency guard.
async function alreadyAwardedToday(customerId, ruleId) {
    const row = await db('customer_rewards')
        .where({ company_id: MP, customer_id: customerId, entity_id: ruleId, entity_type: 'smart_campaign' })
        .whereRaw('DATE(created_at) = CURRENT_DATE')
        .first('id');
    return !!row;
}

async function loadRule(type) {
    return db('loyalty_smart_campaign')
        .where({ company_id: MP, type })
        .whereNull('deleted_at')
        .first();
}

/**
 * runTopSpenders — top N marketplace spenders of last month.
 */
async function runTopSpenders({ dryRun = false } = {}) {
    const rule = await loadRule('top_spenders');
    if (!rule) { return { rule: null, winners: [], awarded: 0 }; }
    const target = parseInt(rule.target_value, 10) || 0;
    if (target <= 0) { return { rule, winners: [], awarded: 0 }; }
    if (!(await Loyalty.ruleEnabled(MP, 'smart_campaign'))) { return { rule, winners: [], awarded: 0, gated: true }; }
    const cfg = await Loyalty.loadConfig(MP);
    if (!cfg) { return { rule, winners: [], awarded: 0, gated: true }; }

    const { start, end } = lastMonthRange();
    // Marketplace-wide leaderboard: only orders placed THROUGH the marketplace.
    const winners = await db('orders')
        .where('is_marketplace', 1)
        .andWhere({ status: '1', order_status: '' })
        .whereNotNull('user_id')
        .andWhereBetween('created_at', [start, end])
        .groupBy('user_id')
        .select('user_id')
        .sum({ total_spent: 'sub_total' })
        .count({ total_orders: '*' })
        .orderBy('total_spent', 'desc')
        .limit(target);

    let awarded = 0;
    for (const w of winners) {
        if (await alreadyAwardedToday(w.user_id, rule.id)) { continue; }
        if (dryRun) { continue; }
        const ok = await Loyalty.award({
            companyId:  MP,
            customerId: w.user_id,
            entityType: 'smart_campaign',
            entityId:   rule.id,
            amount:     Number(rule.cashback) || 0,
            jsonData:   { type: 'top_spenders', total_spent: w.total_spent, total_orders: w.total_orders, from: start, to: end },
            cfg,
        });
        if (ok) { awarded++; }
    }
    return { rule, winners, awarded };
}

/**
 * runMostReferrals — top N marketplace referrers of last month.
 */
async function runMostReferrals({ dryRun = false } = {}) {
    const rule = await loadRule('most_referrals');
    if (!rule) { return { rule: null, winners: [], awarded: 0 }; }
    const target = parseInt(rule.target_value, 10) || 0;
    if (target <= 0) { return { rule, winners: [], awarded: 0 }; }
    if (!(await Loyalty.ruleEnabled(MP, 'smart_campaign'))) { return { rule, winners: [], awarded: 0, gated: true }; }
    const cfg = await Loyalty.loadConfig(MP);
    if (!cfg) { return { rule, winners: [], awarded: 0, gated: true }; }

    const { start, end } = lastMonthRange();
    // Who referred the most MARKETPLACE customers last month. Marketplace
    // customers are the global ones (company_id IS NULL) — legacy groups by
    // company_id because each restaurant has its own customer set.
    const winners = await db('customer')
        .whereNotNull('referred_by')
        .whereNull('company_id')
        .andWhereBetween('created_at', [start, end])
        .groupBy('referred_by')
        .select('referred_by as user_id')
        .count({ total_referrals: '*' })
        .orderBy('total_referrals', 'desc')
        .limit(target);

    let awarded = 0;
    for (const w of winners) {
        if (!w.user_id) { continue; }
        if (await alreadyAwardedToday(w.user_id, rule.id)) { continue; }
        if (dryRun) { continue; }
        const ok = await Loyalty.award({
            companyId:  MP,
            customerId: w.user_id,
            entityType: 'smart_campaign',
            entityId:   rule.id,
            amount:     Number(rule.cashback) || 0,
            jsonData:   { type: 'most_referrals', total_referrals: w.total_referrals, from: start, to: end },
            cfg,
        });
        if (ok) { awarded++; }
    }
    return { rule, winners, awarded };
}

/**
 * run — both campaigns. Never throws; a failure in one must not kill the other
 * (or the scheduler tick).
 */
async function run({ dryRun = false } = {}) {
    const out = { topSpenders: null, mostReferrals: null };
    try { out.topSpenders   = await runTopSpenders({ dryRun }); }
    catch (e) { H.log.error('job.loyaltyCampaigns.topSpenders', e && e.message); }
    try { out.mostReferrals = await runMostReferrals({ dryRun }); }
    catch (e) { H.log.error('job.loyaltyCampaigns.mostReferrals', e && e.message); }

    const ts = out.topSpenders   || { winners: [], awarded: 0 };
    const mr = out.mostReferrals || { winners: [], awarded: 0 };
    H.log.info('job.loyaltyCampaigns',
        `top_spenders: ${ts.winners.length} winner(s)/${ts.awarded} awarded · ` +
        `most_referrals: ${mr.winners.length} winner(s)/${mr.awarded} awarded${dryRun ? ' (dry run)' : ''}`);
    return out;
}

module.exports = { run, runTopSpenders, runMostReferrals, lastMonthRange };
