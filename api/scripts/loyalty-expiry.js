'use strict';

/*
 * scripts/loyalty-expiry.js
 *
 * Manual one-shot runner for the loyalty EXPIRY sweep. The logic itself lives in
 * Services/jobs/loyaltyExpiry.js — the SAME module the scheduler registers, so a
 * manual run and a cron tick can never drift apart.
 *
 * Run (from the api/ folder):
 *     node scripts/loyalty-expiry.js             # apply
 *     node scripts/loyalty-expiry.js --dry-run   # report only, change nothing
 *
 * Normally you don't need this: api/index.js registers the job on the scheduler
 * (daily 02:00). It only fires when SCHEDULER_ENABLED=true. Use this script for
 * a one-off catch-up, or if you'd rather drive it from OS cron / Task Scheduler
 * with SCHEDULER_ENABLED left off.
 */

require('dotenv').config();
const { db } = require('../config/db');
const job    = require('../Services/jobs/loyaltyExpiry');

const DRY = process.argv.includes('--dry-run');

(async () => {
    const started = Date.now();
    console.log('loyalty-expiry ' + (DRY ? '(DRY RUN) ' : '') + 'started: ' + new Date().toISOString());
    let code = 0;
    try {
        const { due, expired, notify } = await job.run({ dryRun: DRY });

        console.log('  A. past expiry_date + still live : ' + due);
        console.log('     → expired                     : ' + (DRY ? '(dry run — none)' : expired));
        console.log('  B. due to notify today           : ' + notify.length);
        notify.slice(0, 10).forEach((r) => {
            const exp = r.expiry_date ? new Date(r.expiry_date).toISOString().slice(0, 10) : '-';
            console.log('     • customer=' + r.customer_id + ' company=' + r.company_id + ' £' + r.amount + ' expires ' + exp);
        });
        if (notify.length > 10) { console.log('     … +' + (notify.length - 10) + ' more'); }

        console.log('loyalty-expiry finished in ' + (Date.now() - started) + 'ms');
    } catch (e) {
        console.error('loyalty-expiry ERROR:', e && e.message);
        code = 1;
    } finally {
        await db.destroy();
        process.exit(code);
    }
})();
