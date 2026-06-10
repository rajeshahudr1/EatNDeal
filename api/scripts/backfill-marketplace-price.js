'use strict';

/*
 * scripts/backfill-marketplace-price.js
 *
 * What:  One-shot data backfill. For every marketplace product where
 *        `marketplace_price` is NULL or 0, sets it to (base_price + 1)
 *        — using the first non-zero value in the same chain that
 *        Helpers/marketplace.pickPrice falls back through:
 *
 *          online_platform_price  →  price_after_tax  →  0
 *
 *        Rows where every candidate is also 0/NULL are left untouched
 *        (no synthetic price) and logged so the merchant can set one
 *        manually.
 *
 *        Scope is restricted to live marketplace products:
 *          • show_marketplace = 1
 *          • status = '1'
 *          • company is_marketplace=1 + is_active=1 + not soft-deleted
 *
 *        Runs inside a single transaction so partial failures don't
 *        leave half-priced rows behind. Reports how many rows were
 *        updated, how many had no candidate, and the before/after for
 *        a sample of 5 rows.
 *
 * Why:   Bridges the gap where 28% of marketplace products had no
 *        marketplace_price set, falling through to the in-store price.
 *        With the +£1 markup the marketplace always shows a price the
 *        merchant has notionally agreed to without the analytics
 *        confusion of "is this the marketplace price or the regular
 *        price?"
 *
 * Run:   node scripts/backfill-marketplace-price.js
 *        Add `--dry-run` to print the would-be UPDATE without writing.
 *        Add `--bump=2` to use base+2 instead of base+1.
 *
 * Reversible: this is a data update, NOT a schema change. To revert,
 *             you'd need a backup of the affected rows (no automated
 *             rollback below — capture a snapshot first if you care).
 */

require('dotenv').config();
const { db } = require('../config/db');

const argv      = process.argv.slice(2);
const dryRun    = argv.includes('--dry-run');
const bumpArg   = argv.find((a) => a.startsWith('--bump='));
const BUMP      = bumpArg ? Number(bumpArg.split('=')[1]) : 1;

if (!Number.isFinite(BUMP) || BUMP < 0) {
    console.error('Invalid --bump=<n>. Use a non-negative number.');
    process.exit(2);
}

async function main() {
    console.log('── Marketplace price backfill ───────────────────────────────');
    console.log('Mode :', dryRun ? 'DRY RUN (no writes)' : 'WRITE');
    console.log('Bump :', '+£' + BUMP.toFixed(2));
    console.log();

    // 1. Count the candidate rows (marketplace_price unset, with a
    //    fallback price available + without one).
    const eligibleQ = db('products as p')
        .innerJoin('company as c', 'c.id', 'p.company_id')
        .where('p.show_marketplace', 1)
        .andWhere('p.status', '1')
        .andWhere('c.is_marketplace', 1)
        .andWhere('c.is_active', 1)
        .whereNull('c.deleted_at')
        .andWhere(function () { this.whereNull('p.marketplace_price').orWhere('p.marketplace_price', 0); });

    const total   = await eligibleQ.clone().count('* as c').first();
    const haveBase = await eligibleQ.clone()
        .andWhere(function () {
            this.where('p.online_platform_price', '>', 0).orWhere('p.price_after_tax', '>', 0);
        })
        .count('* as c').first();
    const noBase = Number(total.c) - Number(haveBase.c);

    console.log('Candidates (marketplace_price NULL or 0):', total.c);
    console.log('  → with a base price (will be updated)  :', haveBase.c);
    console.log('  → with no base either (skipped)        :', noBase);
    console.log();

    // 2. Sample before/after for sanity.
    const sample = await eligibleQ.clone()
        .andWhere(function () {
            this.where('p.online_platform_price', '>', 0).orWhere('p.price_after_tax', '>', 0);
        })
        .select(
            'p.id', 'p.name',
            'p.marketplace_price as mp_before',
            'p.online_platform_price', 'p.price_after_tax',
        )
        .limit(5);
    if (sample.length) {
        const preview = sample.map((r) => {
            const base = Number(r.online_platform_price) > 0
                ? Number(r.online_platform_price)
                : Number(r.price_after_tax);
            return {
                id: r.id,
                name: r.name,
                online_platform_price: r.online_platform_price,
                price_after_tax: r.price_after_tax,
                mp_before: r.mp_before,
                mp_after: (Math.round((base + BUMP) * 100) / 100).toFixed(2),
            };
        });
        console.log('Sample rows (first 5 to be updated):');
        console.table(preview);
        console.log();
    }

    if (dryRun) {
        console.log('Dry run — no rows written. Re-run without --dry-run to apply.');
        await db.destroy();
        return;
    }

    if (Number(haveBase.c) === 0) {
        console.log('Nothing to do — every candidate has no base price to derive from.');
        await db.destroy();
        return;
    }

    // 3. Single atomic UPDATE — uses GREATEST(...) to pick the higher
    //    of the two base candidates (so a row with only price_after_tax
    //    still gets bumped). Filters out the no-base rows so they stay
    //    NULL/0 instead of being set to BUMP alone.
    const updated = await db.transaction(async (trx) => {
        const baseExpr = `GREATEST(COALESCE(p.online_platform_price, 0), COALESCE(p.price_after_tax, 0))`;
        const result = await trx.raw(
            `
            UPDATE products p
               SET marketplace_price = ROUND((${baseExpr} + ?)::numeric, 2)
              FROM company c
             WHERE c.id = p.company_id
               AND p.show_marketplace = 1
               AND p.status = '1'
               AND c.is_marketplace = 1
               AND c.is_active = 1
               AND c.deleted_at IS NULL
               AND (p.marketplace_price IS NULL OR p.marketplace_price = 0)
               AND ${baseExpr} > 0
            `,
            [BUMP],
        );
        return result.rowCount || 0;
    });

    console.log('Rows updated:', updated);
    if (Number(noBase)) {
        console.log('Skipped (no base price)   :', noBase,
            '— set these manually in admin if you want them shown on marketplace.');
    }
    await db.destroy();
}

main().catch((err) => {
    console.error('Backfill failed:', err && err.message);
    process.exit(1);
});
