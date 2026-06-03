'use strict';

/*
 * scripts/backfill-branch-waiting-times.js
 *
 * What:  One-shot data backfill. Most marketplace branches landed in the
 *        DB without `delivery_waiting_time` / `pickup_waiting_time` set,
 *        so the marketplace's time chip computes to null and the
 *        restaurant cards (home grid, favourites, pickup map popup) all
 *        hide the "20 min" label. This script writes a sensible default
 *        wherever those columns are NULL / empty / '00:00:00' so every
 *        card carries a time.
 *
 *        Format: legacy "D:H:M" string the existing parser
 *        (marketplace.deliveryMinutesFromWaiting) reads. Examples:
 *          "0:0:25" → 25 minutes
 *          "0:0:15" → 15 minutes
 *
 *        Defaults applied (per-branch deterministic — same branch id
 *        always lands on the same value so repeat runs are stable):
 *          delivery: 20–35 minutes
 *          pickup:   10–20 minutes
 *
 *        Scope: only branches whose parent company is is_marketplace=1 +
 *        is_active=1 + not soft-deleted. Branches with an EXISTING usable
 *        value (not null, not '', not 0/0/0) are skipped.
 *
 * Run:   node scripts/backfill-branch-waiting-times.js
 *        Add `--dry-run` to print the would-be UPDATE without writing.
 */

require('dotenv').config();
const { db } = require('../config/db');

const argv   = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

// Deterministic pick — same branch id always gets the same value across
// re-runs, so the UI doesn't appear to shuffle times every backfill.
function pick(arr, seed) {
    const n = Number(seed) || 0;
    return arr[n % arr.length];
}
// 20, 25, 30, 35
const DELIVERY_MINUTES = [20, 25, 30, 35];
// 10, 15, 20
const PICKUP_MINUTES   = [10, 15, 20];

function asWaitingString(mins) {
    return '0:0:' + mins;
}

function isEmpty(val) {
    if (val == null) { return true; }
    const s = String(val).trim();
    if (!s) { return true; }
    // legacy "0:0:0" / "00:00:00" both mean unset.
    return /^0+(:0+)*$/.test(s.replace(/\s/g, ''));
}

async function main() {
    console.log('── Branch waiting-time backfill ─────────────────────────────');
    console.log('Mode :', dryRun ? 'DRY RUN (no writes)' : 'WRITE');
    console.log();

    const rows = await db('branch as b')
        .innerJoin('company as c', 'c.id', 'b.company_id')
        .where('c.is_marketplace', 1)
        .andWhere('c.is_active', 1)
        .whereNull('c.deleted_at')
        .select('b.id', 'b.delivery_waiting_time', 'b.pickup_waiting_time');

    let updateDelivery = 0;
    let updatePickup   = 0;
    const updates = [];

    for (const r of rows) {
        const needDelivery = isEmpty(r.delivery_waiting_time);
        const needPickup   = isEmpty(r.pickup_waiting_time);
        if (!needDelivery && !needPickup) { continue; }

        const patch = {};
        if (needDelivery) {
            patch.delivery_waiting_time = asWaitingString(pick(DELIVERY_MINUTES, r.id));
            updateDelivery++;
        }
        if (needPickup) {
            patch.pickup_waiting_time = asWaitingString(pick(PICKUP_MINUTES, r.id));
            updatePickup++;
        }
        updates.push({ id: r.id, patch });
    }

    console.log('Branches scanned                :', rows.length);
    console.log('Needing delivery_waiting_time   :', updateDelivery);
    console.log('Needing pickup_waiting_time     :', updatePickup);
    console.log();

    if (updates.length === 0) {
        console.log('Nothing to do — every branch already has waiting times set.');
        await db.destroy();
        return;
    }

    // Sample preview.
    console.log('First 5 updates:');
    console.table(updates.slice(0, 5).map((u) => ({ id: u.id, ...u.patch })));
    console.log();

    if (dryRun) {
        console.log('Dry run — no rows written. Re-run without --dry-run to apply.');
        await db.destroy();
        return;
    }

    // Per-row update inside a single transaction.
    await db.transaction(async (trx) => {
        for (const u of updates) {
            await trx('branch').where({ id: u.id }).update(u.patch);
        }
    });
    console.log('Done — updated', updates.length, 'branches.');
    await db.destroy();
}

main().catch((err) => {
    console.error('Backfill failed:', err && err.message);
    process.exit(1);
});
