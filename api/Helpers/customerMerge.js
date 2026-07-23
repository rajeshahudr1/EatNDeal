'use strict';

/*
 * Helpers/customerMerge.js
 *
 * What:  The logic for a mobile-number change that has side effects — because
 *        marketplace loyalty follows the NUMBER (Helpers/loyalty.linkedCustomerIds
 *        matches customer.contact_no across every customer row).
 *
 *        Two jobs live here:
 *          1. mergeDuplicateCustomer — fold one customer's whole history into
 *             another (used when the new number already exists at a restaurant
 *             as a different customer row).
 *          2. logPhoneChange — write one audit row describing what happened.
 *
 *        The propagation itself (moving a person's POS rows to the new number)
 *        and the decision of WHEN to merge live in the caller
 *        (AuthController.changePhone) — this file provides the reusable pieces.
 *
 * Why a single IDENTITY_MAP: the schema has TWO customer identities and each
 *        table keys on ONE of them (see below). Listing every table in one
 *        place — with WHICH identity it uses and WHY it's included/excluded —
 *        means the merge is auditable and a new table is a one-line add, not a
 *        hunt through the codebase.
 *
 * Safety: every write here is meant to run inside the caller's transaction, so
 *        a failure rolls the whole number-change back (no half-merged customer).
 */

const { db } = require('../config/db');

/*
 * IDENTITY_MAP — every table whose rows belong to a customer, and the column +
 * identity that ties them to that customer.
 *
 *   idType 'appId'      → the column stores customer.app_id (legacy identity:
 *                         loyalty ledgers + the whole orders family key on this;
 *                         e.g. customer_rewards.customer_id and orders.user_id
 *                         both actually hold app_id).
 *   idType 'customerId' → the column stores customer.id (our marketplace id).
 *
 * Each verdict was confirmed from code, not guessed. Tables deliberately NOT
 * here (do not add): mp_* (marketplace-only — a POS duplicate never has them),
 * OAuth (access_tokens, authorization_codes), staff/admin (user_branch,
 * user_permission, user_token, user_history, user_checkinout), POS terminal
 * (drawer, shift, shift_invoice, product_sold_out), and customer_address /
 * customer_profile (product decision — a POS duplicate has neither).
 */
const IDENTITY_MAP = [
    // ---- Bucket 1: keyed by customer.app_id (move duplicate.app_id -> survivor.app_id) ----
    { table: 'orders',                          column: 'user_id',         idType: 'appId' }, // orders.user_id = app_id
    { table: 'orders_items',                    column: 'app_id',          idType: 'appId' },
    { table: 'orders_items_sub',                column: 'app_id',          idType: 'appId' },
    { table: 'orders_items_topping_detail',     column: 'app_id',          idType: 'appId' },
    { table: 'orders_payments',                 column: 'app_id',          idType: 'appId' },
    { table: 'order_cancel',                    column: 'app_id',          idType: 'appId' },
    { table: 'order_delivery_details',          column: 'app_id',          idType: 'appId' },
    { table: 'order_set_item_detail',           column: 'app_id',          idType: 'appId' },
    { table: 'customer_rewards',                column: 'customer_id',     idType: 'appId' }, // loyalty ledger, keyed on app_id
    { table: 'customer_used_rewards',           column: 'customer_id',     idType: 'appId' },
    { table: 'admin_reward_commissions',        column: 'customer_id',     idType: 'appId' },
    { table: 'customer_loyalty',                column: 'customer_id',     idType: 'appId' },
    { table: 'loyalty_order_cashback_progress', column: 'customer_id',     idType: 'appId' },
    { table: 'customer_review',                 column: 'customer_id',     idType: 'appId' }, // moderation record, app_id (reviews.js:125)
    { table: 'customer_tag',                    column: 'app_id',          idType: 'appId' },
    { table: 'customer_tag',                    column: 'customer_app_id', idType: 'appId' },

    // ---- Bucket 2: keyed by customer.id (move duplicate.id -> survivor.id) ----
    { table: 'review_rating',                   column: 'customer_id',     idType: 'customerId' }, // reviews.js:186 joins customer.id
    { table: 'customer_voucher',                column: 'customer_id',     idType: 'customerId' }, // vouchers.js queries via linkedCustomerIds (customer.id)
];

/*
 * mergeDuplicateCustomer
 *
 * What:  Folds the DUPLICATE customer's entire history into the SURVIVOR, then
 *        soft-deletes the duplicate. Used when a number change lands on a
 *        restaurant where the new number already belongs to a different
 *        customer row: the two are the same person, so their records must live
 *        under one account.
 *
 * How:   For every mapped table, re-point the duplicate's rows onto the
 *        survivor using the correct identity space (app_id vs customer.id).
 *        Then blank the duplicate's number and mark it status='2' (legacy
 *        soft-delete) so it never re-enters a future match/merge.
 *
 * Args:  trx       — the caller's transaction (REQUIRED — this must be atomic
 *                    with the number change; pass a knex trx).
 *        survivor  — full customer row kept  { id, app_id, ... }
 *        duplicate — full customer row removed { id, app_id, ... }
 *
 * Returns { affected: { 'table.column': movedCount, ... }, total, softDeleted }
 *        — softDeleted is the duplicate id, or null when nothing was done.
 * Type:  WRITE (inside the caller's transaction).
 */
async function mergeDuplicateCustomer(trx, { survivor, duplicate } = {}) {
    // Guard: need two real, DIFFERENT customers. Merging a row into itself (or a
    // missing row) is a no-op, never an error.
    if (!survivor || !duplicate || Number(survivor.id) === Number(duplicate.id)) {
        return { affected: {}, total: 0, softDeleted: null };
    }

    const conn = trx || db;   // fall back to db only if a caller forgets a trx
    const affected = {};
    let total = 0;

    for (const m of IDENTITY_MAP) {
        // Pick the id-pair for THIS table's identity space.
        const fromVal = m.idType === 'appId' ? duplicate.app_id : duplicate.id;
        const toVal   = m.idType === 'appId' ? survivor.app_id  : survivor.id;

        // Skip when either side has no id in this space (e.g. a customer with no
        // app_id). Matching a NULL/0 would sweep unrelated rows, so we never do.
        if (!fromVal || !toVal) { continue; }
        if (String(fromVal) === String(toVal)) { continue; } // already same identity

        // Re-point every duplicate row in this table onto the survivor.
        const movedCount = await conn(m.table)
            .where(m.column, fromVal)
            .update({ [m.column]: toVal });

        if (movedCount > 0) {
            affected[`${m.table}.${m.column}`] = movedCount;
            total += movedCount;
        }
    }

    // The duplicate is now empty of history — retire it. status='2' is the
    // legacy soft-delete (never a hard delete), and blanking contact_no keeps it
    // out of every future contact_no match/merge.
    await conn('customer').where({ id: duplicate.id }).update({
        status:            '2',
        contact_no:        '',
        updated_at:        db.fn.now(),
        server_updated_at: db.fn.now(),
    });

    return { affected, total, softDeleted: Number(duplicate.id) };
}

/*
 * logPhoneChange
 *
 * What:  Writes ONE audit row to mp_customer_phone_change_log. The table has
 *        just 4 columns — id, customer_id, details, created_at — so the ENTIRE
 *        story of the change goes into the `details` JSON: from/to number +
 *        country codes, the action, total records touched, which sibling rows
 *        moved, and every merge's per-table breakdown (orders / loyalty /
 *        review counts). Read one row → see exactly what happened.
 * Args:  { customerId, details }  — details is any plain object; stringified here.
 * Type:  WRITE. Best-effort — the caller runs this AFTER commit and swallows
 *        errors, so an audit failure can never roll back a real number change.
 */
async function logPhoneChange({ customerId, details } = {}) {
    // Table is migration-gated (operator runs `php yii migrate`). If it isn't
    // there yet, skip silently rather than break change-phone.
    const exists = await db.schema.hasTable('mp_customer_phone_change_log').catch(() => false);
    if (!exists) { return; }

    await db('mp_customer_phone_change_log').insert({
        customer_id: customerId,
        details:     details ? JSON.stringify(details) : null,
        created_at:  db.fn.now(),
    });
}

module.exports = { IDENTITY_MAP, mergeDuplicateCustomer, logPhoneChange };
