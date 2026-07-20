'use strict';

/**
 * Services/jobs/loyaltyExpiry.js
 *
 * What:   The loyalty EXPIRY sweep — port of the legacy console command
 *         `console/controllers/CronController::actionNotifyRewardExpiry`.
 *
 *           A) EXPIRE — every live reward whose expiry_date has passed becomes
 *                       is_expired = 1, expired_from = 1 ("Expired"),
 *                       tier_type = null.  ← exactly legacy's updateAll()
 *           B) NOTIFY — the rewards whose DATE(notify_date) is TODAY (the
 *                       "about to expire" set legacy SMSes). Reported here;
 *                       sending is intentionally not wired yet — see below.
 *
 * Why:    The Node marketplace WRITES expiry_date + notify_date but nothing ever
 *         read them — there was no job in api/ at all. The read queries hide
 *         lapsed rewards (`expiry_date >= NOW()`), so spendable balances looked
 *         correct, but the rows were never MARKED: the wallet's "expired" total
 *         and the `expired` history filter both key off is_expired/expired_from,
 *         so they silently under-reported. This is the missing writer.
 *
 * Safety: IDEMPOTENT — only ever touches rows that are still is_expired = 0 with
 *         a past expiry_date, so re-running is harmless. It also never reduces a
 *         customer's spendable balance: those rewards were already excluded from
 *         every balance read by the expiry_date filter. This only makes the
 *         REPORTING truthful.
 *
 * Type:   WRITE.
 * Used:   api/index.js (scheduler.register) + scripts/loyalty-expiry.js (manual).
 */

const { db } = require('../../config/db');
const H      = require('../../Helpers/helper');
const { MARKETPLACE_COMPANY_ID } = require('../../Helpers/loyalty');

// ── SCOPE: the MARKETPLACE's own programme only (company_id = 0) ──────
// A restaurant's rewards (company_id > 0) belong to the legacy Eat N Deal POS,
// which runs this exact sweep itself (CronController::actionNotifyRewardExpiry).
// This job must NOT reach into that data — two systems writing the same rows is
// how you get surprises, and those rows aren't ours to mutate. If restaurant
// rewards are going stale, that's the LEGACY cron not running — an ops issue to
// raise there, not something for this job to silently take over.

/**
 * run
 *
 * Inputs:  { dryRun }  — true → report only, change nothing.
 * Output:  { due, expired, notify: [{company_id, customer_id, amount, expiry_date}] }
 */
async function run({ dryRun = false } = {}) {
    // ── A. EXPIRE anything past its expiry_date ────────────────────────
    // Legacy: updateAll(['is_expired'=>1,'expired_from'=>1,'tier_type'=>null],
    //   ['and', ['is_expired'=>0], ['not',['expiry_date'=>null]], ['<','expiry_date',$now]])
    const dueQ = () => db('customer_rewards')
        .where('company_id', MARKETPLACE_COMPANY_ID)   // ← ours only; never legacy restaurant rows
        .where('is_expired', 0)
        .whereNotNull('expiry_date')
        .where('expiry_date', '<', db.fn.now());

    const dueRow = await dueQ().count('* as c').first();
    const due    = Number(dueRow && dueRow.c) || 0;

    let expired = 0;
    if (due > 0 && !dryRun) {
        expired = await dueQ().update({
            is_expired:   1,
            expired_from: 1,      // 1 = Expired (legacy code)
            tier_type:    null,   // legacy clears the stamp tier on expiry
        });
    }

    // ── B. The "expires soon" set legacy notifies ──────────────────────
    // Legacy picks: is_expired=0, tier_type IS NULL, customer_id NOT NULL,
    // DATE(notify_date) = today.
    let notify = [];
    try {
        notify = await db('customer_rewards')
            .where('company_id', MARKETPLACE_COMPANY_ID)   // ← ours only
            .where('is_expired', 0)
            .whereNull('tier_type')
            .whereNotNull('customer_id')
            .whereRaw('DATE(notify_date) = CURRENT_DATE')
            .select('company_id', 'customer_id', 'expiry_date', 'amount');
    } catch (e) {
        notify = [];
    }
    // NOTE: legacy SMSes these through the BRANCH's own SMS configuration
    // (Commonquery::getSmsConfiguration → Connexa / generic provider) and looks
    // the customer up by (company_id, app_id). Sending is deliberately NOT done
    // here: it needs the per-branch SMS config + a provider/cost decision. The
    // EXPIRE sweep above is the correctness fix; wire the send when the
    // notification engine lands.

    H.log.info('job.loyaltyExpiry', `due=${due} expired=${dryRun ? 0 : expired} notify=${notify.length}${dryRun ? ' (dry run)' : ''}`);
    return { due, expired: dryRun ? 0 : expired, notify };
}

module.exports = { run };
