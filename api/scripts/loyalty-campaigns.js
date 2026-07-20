'use strict';

/*
 * scripts/loyalty-campaigns.js
 *
 * Manual one-shot runner for the scheduled smart campaigns (top_spenders +
 * most_referrals). The logic lives in Services/jobs/loyaltyCampaigns.js — the
 * SAME module the scheduler registers, so manual and cron can't drift.
 *
 * Run (from the api/ folder):
 *     node scripts/loyalty-campaigns.js             # apply
 *     node scripts/loyalty-campaigns.js --dry-run   # report winners, award nothing
 *
 * Normally the scheduler runs it on the 1st of each month at 03:00 (only when
 * SCHEDULER_ENABLED=true). Scope: the marketplace's own programme (company_id=0).
 */

require('dotenv').config();
const { db } = require('../config/db');
const job    = require('../Services/jobs/loyaltyCampaigns');

const DRY = process.argv.includes('--dry-run');

function report(label, r) {
    if (!r || !r.rule) { console.log('  ' + label + ': no marketplace rule configured — skipped'); return; }
    if (r.gated)       { console.log('  ' + label + ': rule exists but loyalty/master is OFF — skipped'); return; }
    console.log('  ' + label + ': target=' + r.rule.target_value + ' reward=' + r.rule.cashback +
                ' → ' + r.winners.length + ' winner(s), ' + (DRY ? '(dry run — none awarded)' : r.awarded + ' awarded'));
    r.winners.forEach((w, i) => {
        const extra = w.total_spent != null ? ('spent=' + w.total_spent + ' orders=' + w.total_orders)
                                            : ('referrals=' + w.total_referrals);
        console.log('     #' + (i + 1) + ' customer=' + w.user_id + '  ' + extra);
    });
}

(async () => {
    const started = Date.now();
    const { start, end } = job.lastMonthRange();
    console.log('loyalty-campaigns ' + (DRY ? '(DRY RUN) ' : '') + 'started');
    console.log('  window (last month): ' + start.toISOString().slice(0, 10) + ' → ' + end.toISOString().slice(0, 10));
    let code = 0;
    try {
        const out = await job.run({ dryRun: DRY });
        report('top_spenders  ', out.topSpenders);
        report('most_referrals', out.mostReferrals);
        console.log('loyalty-campaigns finished in ' + (Date.now() - started) + 'ms');
    } catch (e) {
        console.error('loyalty-campaigns ERROR:', e && e.message);
        code = 1;
    } finally {
        await db.destroy();
        process.exit(code);
    }
})();
