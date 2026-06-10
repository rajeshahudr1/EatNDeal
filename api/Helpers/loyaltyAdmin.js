'use strict';

/*
 * Helpers/loyaltyAdmin.js
 *
 * What:  Admin-side CRUD/list helpers for the loyalty configuration tables.
 *        Earn/redeem RUNTIME logic stays in Helpers/loyalty.js — this file is
 *        only the admin console's read/write side (list rows, the loyalty_rules
 *        master on/off toggle, soft-deletes), all company-scoped.
 * Why:   Keeps company scoping + soft-delete + the loyalty_rules master-gate in
 *        ONE place so every admin screen behaves identically.
 * Type:  READ + WRITE (loyalty config tables).
 * Used:  api/Controllers/Admin/LoyaltyController.js.
 *
 * Legacy model (verified 2026-06-09): every config table is company_id-scoped
 * with soft-deletes (deleted_at/deleted_by). A rule TYPE is enabled/disabled
 * per company via a row in loyalty_rules (status 1=on, 2=off). cash_king is
 * always-on (never gated) — matches the runtime engine in loyalty.js.
 *
 * Change log:
 *   2026-06-09 — initial (table constants, master toggle, soft-delete, lists).
 */

const { db } = require('../config/db');

// Canonical table names (single source of truth for the admin side).
const T = {
    config:        'company_loyalty',
    rules:         'loyalty_rules',
    cashback:      'loyalty_cashback_rule',
    tier:          'loyalty_membership_tier',
    referral:      'loyalty_referral_cashback_rule',
    orderCashback: 'loyalty_order_cashback_rule',   // streak / milestone
    event:         'loyalty_event_cashback_rule',
    campaign:      'loyalty_smart_campaign',         // challenges
    review:        'loyalty_review_cashback_rule',   // review reward rules (per type)
    customerReview:'customer_review',                // review-claim approval queue
    rewards:       'customer_rewards',               // ledger
    // Sections ported 2026-06-09 (Product Cashback, BOGO, Special Offer, CMS):
    product:       'loyalty_product_cashback_rule',
    productItems:  'loyalty_product_cashback_items',
    bogof:         'loyalty_bogof_rule',
    bogofBuy:      'loyalty_bogof_buy',
    specialOffer:  'loyalty_special_offer_rule',
    cmsPages:      'loyalty_cms_pages',              // review CMS pages (per review-type slug)
};

// Master rule types (loyalty_rules.rule_type) the admin can toggle.
const RULE_TYPES = {
    cashback:          'cashback',
    event:             'event_cashback',
    referral:          'referral',
    streak:            'product_streak',
    review:            'review',
    membershipTier:    'membership_tier',
    smartCampaign:     'smart_campaign',
    specialOffer:      'special_offer',
    productCashback:   'product_cashback',
    bogof:             'bogof',
};

const RULE_ON = 1;
const RULE_OFF = 2;

/**
 * nowStr — UTC "YYYY-MM-DD HH:mm:ss", matching the legacy Yii write format.
 */
function nowStr() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * activeRows — SELECT * FROM <table> for one company, excluding soft-deleted
 * rows. The base read every list screen uses.
 */
function activeRows(table, companyId) {
    return db(table).where('company_id', companyId).whereNull('deleted_at');
}

/**
 * getConfig — the company_loyalty row for a company (or null). Holds the global
 * knobs: loyalty_status, cash_king, loyalty_commission, expiry/notify days,
 * use_max_cashback, collection_cashback.
 */
async function getConfig(companyId) {
    return db(T.config).where('company_id', companyId).first() || null;
}

/**
 * getMasterFlags — map of { rule_type: boolean-on } for a company, read from
 * loyalty_rules (status 1 = on). Soft-deleted rows excluded.
 */
async function getMasterFlags(companyId) {
    const rows = await db(T.rules)
        .where('company_id', companyId)
        .whereNull('deleted_at')
        .select('rule_type', 'status');
    const map = {};
    rows.forEach((r) => { map[r.rule_type] = Number(r.status) === RULE_ON; });
    return map;
}

/**
 * setMasterFlag — upsert a loyalty_rules row to enable/disable a rule type for
 * a company. status: true → 1 (on), false → 2 (off).
 */
async function setMasterFlag(companyId, ruleType, on, actorId) {
    const status = on ? RULE_ON : RULE_OFF;
    const existing = await db(T.rules)
        .where({ company_id: companyId, rule_type: ruleType })
        .whereNull('deleted_at')
        .first();
    if (existing) {
        await db(T.rules).where('id', existing.id).update({
            status,
            updated_at: nowStr(),
            updated_by: actorId,
        });
        return existing.id;
    }
    const ins = await db(T.rules).insert({
        company_id: companyId,
        rule_type:  ruleType,
        priority:   0,
        status,
        created_at: nowStr(),
        created_by: actorId,
    }).returning('id');
    return Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
}

/**
 * softDelete — mark a config row deleted (deleted_at + deleted_by), scoped to
 * the owning company so an id from another company can't be deleted.
 * Returns the number of rows affected (0 = not found / not owned).
 */
async function softDelete(table, id, companyId, actorId) {
    return db(table)
        .where({ id, company_id: companyId })
        .whereNull('deleted_at')
        .update({ deleted_at: nowStr(), deleted_by: actorId });
}

module.exports = {
    db, T, RULE_TYPES, RULE_ON, RULE_OFF,
    nowStr, activeRows, getConfig, getMasterFlags, setMasterFlag, softDelete,
};
