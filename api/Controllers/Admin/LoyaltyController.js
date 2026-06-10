'use strict';

/*
 * Controllers/Admin/LoyaltyController.js
 *
 * What:  The admin console's loyalty management endpoints. One controller, one
 *        method group per screen (dashboard, cashback, tiers, referral/streak,
 *        challenges, events, review-claims, segments). Every method is company-
 *        scoped via Helpers/adminScope.resolveCompanyScope:
 *          • super_admin → acts on ?company_id (selector); some reads span all.
 *          • company     → forced to its own company_id.
 * Why:   Replicates the legacy EatNDeal backend loyalty admin against the SAME
 *        tables (no new schema). Reads/writes go through Helpers/loyaltyAdmin so
 *        scoping + soft-delete + the loyalty_rules master-gate stay consistent.
 * Type:  READ + WRITE (loyalty config + ledger on approve).
 * Used:  api/Routes/index.js (authenticate + requireRole('admin')).
 *
 * Change log:
 *   2026-06-09 — initial; dashboard. (Other screens added incrementally.)
 */

const H  = require('../../Helpers/helper');
const { db } = require('../../config/db');
const { resolveCompanyScope } = require('../../Helpers/adminScope');
const LA = require('../../Helpers/loyaltyAdmin');
const Loyalty = require('../../Helpers/loyalty');

// Scope a query builder to a company when one is selected; leave wide-open
// (all companies) when a super admin has picked none.
function scoped(q, companyId) {
    return companyId != null ? q.where('company_id', companyId) : q;
}

// Single-company screens need a concrete company. For a super admin who
// hasn't picked one, reply 422 and signal the caller to stop. Returns the
// resolved scope when OK, or null when it already sent the error response.
function requireCompany(req, res) {
    const scope = resolveCompanyScope(req);
    if (scope.companyId == null) {
        H.errorResponse(res, 'Select a company first.', 422, { code: 'no_company' });
        return null;
    }
    return scope;
}

// Parse a money/number field safely to a fixed-2 string for DECIMAL columns.
function money(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

/**
 * dashboard
 *
 * GET /api/v1/admin/loyalty/dashboard?company_id=
 *
 * Read-only rollups for the landing screen:
 *   loyaltyOn          — is loyalty enabled (selected company) / how many on (all)
 *   totals.earned      — SUM(customer_rewards.amount)
 *   totals.redeemed    — SUM(customer_rewards.used_amount)
 *   totals.outstanding — SUM(amount-used_amount) where live + redeemable
 *   pendingReviewClaims— COUNT(customer_review.admin_status = 0)
 *   perCompany[]       — (super, no selector) per-company earned/redeemed
 */
async function dashboard(req, res) {
    try {
        const scope = resolveCompanyScope(req);
        const cid = scope.companyId;   // null = all (super, no selector)

        // ── Ledger rollups ──
        const tot = await scoped(db(LA.T.rewards), cid)
            .select(
                db.raw('COALESCE(SUM(amount),0)::float as earned'),
                db.raw('COALESCE(SUM(used_amount),0)::float as redeemed'),
                db.raw('COALESCE(SUM(CASE WHEN is_expired = 0 AND is_redeemable = 1 THEN amount - used_amount ELSE 0 END),0)::float as outstanding'),
            )
            .first();

        // ── Pending review claims ──
        const pend = await scoped(db(LA.T.customerReview), cid)
            .where('admin_status', 0)
            .count('* as n')
            .first();

        // ── Loyalty on/off + company-level config (commission / phone orders) ──
        let loyaltyOn = false;
        let commission = 0;
        let phoneOrders = false;
        let companiesWithLoyalty = 0;
        if (cid != null) {
            const cfg = await db(LA.T.config).where('company_id', cid).first();
            loyaltyOn = !!(cfg && Number(cfg.loyalty_status) === 1);
            commission = cfg ? Number(cfg.loyalty_commission) || 0 : 0;
            phoneOrders = !!(cfg && Number(cfg.enable_loyalty_phone_order) === 1);
        } else {
            const c = await db(LA.T.config).where('loyalty_status', 1).count('* as n').first();
            companiesWithLoyalty = Number(c && c.n) || 0;
        }

        // ── Per-company breakdown (super admin, no company selected) ──
        let perCompany = null;
        if (scope.isSuper && cid == null) {
            perCompany = await db(LA.T.rewards + ' as r')
                .join('company as c', 'c.id', 'r.company_id')
                .whereNull('c.deleted_at')
                .groupBy('c.id', 'c.business_name')
                .select(
                    'c.id',
                    'c.business_name',
                    db.raw('COALESCE(SUM(r.amount),0)::float as earned'),
                    db.raw('COALESCE(SUM(r.used_amount),0)::float as redeemed'),
                )
                .orderBy('earned', 'desc')
                .limit(50);
        }

        return H.successResponse(res, {
            scope: { isSuper: scope.isSuper, companyId: cid },
            loyaltyOn,
            commission,
            phoneOrders,
            companiesWithLoyalty,
            totals: {
                earned:      Number(tot && tot.earned) || 0,
                redeemed:    Number(tot && tot.redeemed) || 0,
                outstanding: Number(tot && tot.outstanding) || 0,
            },
            pendingReviewClaims: Number(pend && pend.n) || 0,
            perCompany,
        });
    } catch (err) {
        console.error('[admin.loyalty.dashboard]', err && err.message);
        return H.errorResponse(res, 'Could not load the dashboard.', 500);
    }
}

/**
 * masterToggle — POST /api/v1/admin/loyalty/master-toggle {status}
 * Company-LEVEL loyalty on/off (company_loyalty.loyalty_status). This is the
 * gate the user means: when it's ON for a company, that company's login shows
 * the Loyalty menu. Typically a super-admin action (they enable loyalty for a
 * company); a company can also flip its own.
 */
async function masterToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const on = truthy(req.body.status);

        const existing = await db(LA.T.config).where('company_id', cid).first();
        if (existing) {
            await db(LA.T.config).where('company_id', cid)
                .update({ loyalty_status: on ? 1 : 2, updated_at: LA.nowStr(), updated_by: scope.actorId });
        } else {
            await db(LA.T.config).insert({
                company_id: cid, loyalty_status: on ? 1 : 2, loyalty_commission: '0.00',
                expiry_duration_days: 0, notify_before_days: 0, use_max_cashback: '0.00',
                cash_king: '0.00', collection_cashback: '0.00',
                created_at: LA.nowStr(), created_by: scope.actorId,
            });
        }
        return H.successResponse(res, { loyaltyOn: on }, on ? 'Loyalty enabled for this company.' : 'Loyalty disabled for this company.');
    } catch (err) {
        console.error('[admin.loyalty.masterToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update loyalty.', 500);
    }
}

/**
 * companyConfigSave — POST /api/v1/admin/loyalty/company-config
 * The company-level loyalty settings that sit next to the on/off toggle in the
 * legacy admin: platform Commission (%) + Enable loyalty for phone orders.
 * (enable_loyalty_phone_order uses 1 = on / 2 = off, matching legacy.)
 */
async function companyConfigSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const patch = {
            loyalty_commission:         money(b.loyalty_commission),
            enable_loyalty_phone_order: truthy(b.enable_loyalty_phone_order) ? 1 : 2,
            updated_at: LA.nowStr(),
            updated_by: scope.actorId,
        };
        const existing = await db(LA.T.config).where('company_id', cid).first();
        if (existing) {
            await db(LA.T.config).where('company_id', cid).update(patch);
        } else {
            await db(LA.T.config).insert({
                company_id: cid, loyalty_status: 2, ...patch,
                expiry_duration_days: 0, notify_before_days: 0,
                use_max_cashback: '0.00', cash_king: '0.00', collection_cashback: '0.00',
                created_at: LA.nowStr(), created_by: scope.actorId,
            });
        }
        return H.successResponse(res, { saved: true }, 'Loyalty settings saved.');
    } catch (err) {
        console.error('[admin.loyalty.companyConfigSave]', err && err.message);
        return H.errorResponse(res, 'Could not save loyalty settings.', 500);
    }
}

// ── Screen 2: Cashback Rules ───────────────────────────────────────

function mapCashbackRow(r) {
    return {
        id:               Number(r.id),
        min_order_amount: Number(r.min_order_amount) || 0,
        cashback:         Number(r.cashback) || 0,
        value_type:       r.value_type || '%',
        tier_type:        r.tier_type || '',
        apply_on:         Number(r.apply_on) || 1,
        order_count:      Number(r.order_count) || 0,
        status:           Number(r.status) || 0,
    };
}

/**
 * cashbackGet — GET /api/v1/admin/loyalty/cashback?company_id=
 * Returns the per-row rules + the global company_loyalty knobs + the master
 * on/off flag for the cashback rule type.
 */
async function cashbackGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const rules = await LA.activeRows(LA.T.cashback, cid)
            .select('id', 'min_order_amount', 'value_type', 'cashback', 'apply_on', 'status', 'order_count', 'tier_type')
            .orderBy('tier_type', 'asc')
            .orderBy('min_order_amount', 'asc');

        const cfg = await db(LA.T.config).where('company_id', cid).first();
        const flags = await LA.getMasterFlags(cid);

        return H.successResponse(res, {
            rules: rules.map(mapCashbackRow),
            config: {
                loyalty_status:       cfg ? Number(cfg.loyalty_status) || 0 : 0,
                expiry_duration_days: cfg ? Number(cfg.expiry_duration_days) || 0 : 0,
                notify_before_days:   cfg ? Number(cfg.notify_before_days) || 0 : 0,
                use_max_cashback:     cfg ? Number(cfg.use_max_cashback) || 0 : 0,
                cash_king:            cfg ? Number(cfg.cash_king) || 0 : 0,
                collection_cashback:  cfg ? Number(cfg.collection_cashback) || 0 : 0,
            },
            masterOn: !!flags[LA.RULE_TYPES.cashback],
        });
    } catch (err) {
        console.error('[admin.loyalty.cashbackGet]', err && err.message);
        return H.errorResponse(res, 'Could not load cashback rules.', 500);
    }
}

/**
 * cashbackUpsert — POST /api/v1/admin/loyalty/cashback
 * Insert (no id) or update (id) one cashback rule, scoped to the company.
 */
async function cashbackUpsert(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const companyId = scope.companyId;
        const b = req.body;

        const row = {
            company_id:       companyId,
            min_order_amount: money(b.min_order_amount),
            cashback:         money(b.cashback),
            value_type:       '%',   // legacy locks Estamp cashback to % only
            tier_type:        b.tier_type ? String(b.tier_type) : null,
            apply_on:         Number(b.apply_on) || 1,
            order_count:      b.order_count != null ? Number(b.order_count) : 5,
            status:           1,
        };

        if (b.id) {
            const upd = await db(LA.T.cashback)
                .where({ id: Number(b.id), company_id: companyId })
                .whereNull('deleted_at')
                .update({ ...row, updated_at: LA.nowStr(), updated_by: scope.actorId });
            if (!upd) { return H.errorResponse(res, 'That rule no longer exists.', 404); }
        } else {
            await db(LA.T.cashback).insert({ ...row, created_at: LA.nowStr(), created_by: scope.actorId });
        }
        return H.successResponse(res, { saved: true }, 'Cashback rule saved.');
    } catch (err) {
        console.error('[admin.loyalty.cashbackUpsert]', err && err.message);
        return H.errorResponse(res, 'Could not save the rule.', 500);
    }
}

/**
 * cashbackDelete — DELETE /api/v1/admin/loyalty/cashback/:id  (soft delete)
 */
async function cashbackDelete(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const n = await LA.softDelete(LA.T.cashback, Number(req.params.id), scope.companyId, scope.actorId);
        if (!n) { return H.errorResponse(res, 'That rule no longer exists.', 404); }
        return H.successResponse(res, { deleted: true }, 'Cashback rule removed.');
    } catch (err) {
        console.error('[admin.loyalty.cashbackDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the rule.', 500);
    }
}

/**
 * cashbackToggle — POST /api/v1/admin/loyalty/cashback/toggle {status}
 * Flips the cashback master flag (loyalty_rules rule_type='cashback').
 */
async function cashbackToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = Number(req.body.status) === 1 || req.body.status === true || req.body.status === '1';
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.cashback, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Cashback enabled.' : 'Cashback disabled.');
    } catch (err) {
        console.error('[admin.loyalty.cashbackToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

/**
 * configSave — POST /api/v1/admin/loyalty/config
 * Updates the global company_loyalty knobs (expiry / notify / max / cash_king /
 * collection / company-level loyalty on-off).
 */
async function configSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;

        const patch = {
            expiry_duration_days: Number(b.expiry_duration_days) || 0,
            notify_before_days:   Number(b.notify_before_days) || 0,
            use_max_cashback:     money(b.use_max_cashback),
            cash_king:            money(b.cash_king),
            collection_cashback:  money(b.collection_cashback),
            updated_at:           LA.nowStr(),
            updated_by:           scope.actorId,
        };
        if (b.loyalty_status != null && b.loyalty_status !== '') {
            patch.loyalty_status = Number(b.loyalty_status) === 1 ? 1 : 2;
        }

        const existing = await db(LA.T.config).where('company_id', cid).first();
        if (existing) {
            await db(LA.T.config).where('company_id', cid).update(patch);
        } else {
            await db(LA.T.config).insert({
                company_id: cid,
                loyalty_status: patch.loyalty_status != null ? patch.loyalty_status : 2,
                loyalty_commission: '0.00',
                ...patch,
                created_at: LA.nowStr(),
                created_by: scope.actorId,
            });
        }
        return H.successResponse(res, { saved: true }, 'Settings saved.');
    } catch (err) {
        console.error('[admin.loyalty.configSave]', err && err.message);
        return H.errorResponse(res, 'Could not save settings.', 500);
    }
}

// ── Screen 3: Tier Config ──────────────────────────────────────────

const TIER_TYPES = ['bronze', 'silver', 'gold'];

function truthy(v) { return v === '1' || v === 1 || v === true || v === 'true'; }

/**
 * tiersGet — GET /api/v1/admin/loyalty/tiers?company_id=
 * The three fixed tiers (bronze/silver/gold) + the master flag. Missing tiers
 * come back as zeroed defaults so the form always has all three rows.
 */
async function tiersGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const rows = await LA.activeRows(LA.T.tier, cid)
            .select('id', 'type', 'min_amount', 'max_amount', 'free_delivery_lifetime');
        const byType = {};
        rows.forEach((r) => {
            byType[r.type] = {
                min_amount: Number(r.min_amount) || 0,
                max_amount: Number(r.max_amount) || 0,
                free_delivery_lifetime: !!r.free_delivery_lifetime,
            };
        });
        const tiers = {};
        TIER_TYPES.forEach((t) => {
            tiers[t] = byType[t] || { min_amount: 0, max_amount: 0, free_delivery_lifetime: false };
        });

        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { tiers, masterOn: !!flags[LA.RULE_TYPES.membershipTier] });
    } catch (err) {
        console.error('[admin.loyalty.tiersGet]', err && err.message);
        return H.errorResponse(res, 'Could not load tiers.', 500);
    }
}

/**
 * tiersSave — POST /api/v1/admin/loyalty/tiers
 * Upserts all three tiers by (company_id, type). Flat form fields:
 *   <type>_min_amount, <type>_max_amount, <type>_free.
 */
async function tiersSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;

        for (const type of TIER_TYPES) {
            const patch = {
                min_amount:             money(b[type + '_min_amount']),
                // Gold is the top tier: max_amount = 0 is the legacy "and above"
                // (no upper limit) sentinel — force it so the band stays open.
                max_amount:             type === 'gold' ? 0 : money(b[type + '_max_amount']),
                free_delivery_lifetime: truthy(b[type + '_free']),
            };
            const existing = await db(LA.T.tier)
                .where({ company_id: cid, type })
                .whereNull('deleted_at')
                .first();
            if (existing) {
                await db(LA.T.tier).where('id', existing.id)
                    .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                await db(LA.T.tier).insert({
                    company_id: cid, type, ...patch,
                    created_at: LA.nowStr(), created_by: scope.actorId,
                });
            }
        }
        return H.successResponse(res, { saved: true }, 'Tiers saved.');
    } catch (err) {
        console.error('[admin.loyalty.tiersSave]', err && err.message);
        return H.errorResponse(res, 'Could not save tiers.', 500);
    }
}

/**
 * tiersToggle — POST /api/v1/admin/loyalty/tiers/toggle {status}
 */
async function tiersToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.membershipTier, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Tiers enabled.' : 'Tiers disabled.');
    } catch (err) {
        console.error('[admin.loyalty.tiersToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Screen 4: Referral & Streak ────────────────────────────────────

/**
 * referralStreakGet — GET /api/v1/admin/loyalty/referral-streak?company_id=
 * The single referral config + the list of streak/milestone rows + both
 * master flags (referral, product_streak).
 */
async function referralStreakGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const refRow = await LA.activeRows(LA.T.referral, cid).first();
        const referral = {
            referrer_cashback: refRow ? Number(refRow.referrer_cashback) || 0 : 0,
            referee_cashback:  refRow ? Number(refRow.referee_cashback) || 0 : 0,
            value_type:        refRow ? (refRow.value_type || '£') : '£',
            trigger:           refRow ? Number(refRow.trigger) || 2 : 2,
        };

        const rows = await LA.activeRows(LA.T.orderCashback, cid)
            .select('id', 'order_count', 'type', 'duration_type', 'value_type', 'cashback', 'min_order_amount')
            .orderBy('order_count', 'asc');
        const streaks = rows.map((s) => ({
            id:               Number(s.id),
            order_count:      Number(s.order_count) || 0,
            type:             Number(s.type) || 1,
            duration_type:    Number(s.duration_type) || 1,
            value_type:       s.value_type || '£',
            cashback:         Number(s.cashback) || 0,
            min_order_amount: Number(s.min_order_amount) || 0,
        }));

        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, {
            referral,
            streaks,
            masterReferral: !!flags[LA.RULE_TYPES.referral],
            masterStreak:   !!flags[LA.RULE_TYPES.streak],
        });
    } catch (err) {
        console.error('[admin.loyalty.referralStreakGet]', err && err.message);
        return H.errorResponse(res, 'Could not load referral & streak.', 500);
    }
}

/**
 * referralSave — POST /api/v1/admin/loyalty/referral  (upsert single config)
 */
async function referralSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const patch = {
            value_type:        '£',   // legacy locks referral rewards to £ only
            referrer_cashback: money(b.referrer_cashback),
            referee_cashback:  money(b.referee_cashback),
            trigger:           Number(b.trigger) === 1 ? 1 : 2,
        };
        const existing = await db(LA.T.referral).where('company_id', cid).whereNull('deleted_at').first();
        if (existing) {
            await db(LA.T.referral).where('id', existing.id)
                .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
        } else {
            await db(LA.T.referral).insert({ company_id: cid, ...patch, created_at: LA.nowStr(), created_by: scope.actorId });
        }
        return H.successResponse(res, { saved: true }, 'Referral settings saved.');
    } catch (err) {
        console.error('[admin.loyalty.referralSave]', err && err.message);
        return H.errorResponse(res, 'Could not save referral settings.', 500);
    }
}

/**
 * streakUpsert — POST /api/v1/admin/loyalty/streak  (add / edit one row)
 */
async function streakUpsert(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const row = {
            company_id:       cid,
            order_count:      Number(b.order_count) || 0,
            type:             Number(b.type) === 2 ? 2 : 1,
            duration_type:    Number(b.duration_type) === 2 ? 2 : 1,
            value_type:       '£',   // legacy locks streak rewards to £ only
            cashback:         money(b.cashback),
            min_order_amount: money(b.min_order_amount || 0),
        };
        if (b.id) {
            const upd = await db(LA.T.orderCashback)
                .where({ id: Number(b.id), company_id: cid }).whereNull('deleted_at')
                .update({ ...row, updated_at: LA.nowStr(), updated_by: scope.actorId });
            if (!upd) { return H.errorResponse(res, 'That milestone no longer exists.', 404); }
        } else {
            await db(LA.T.orderCashback).insert({ ...row, created_at: LA.nowStr(), created_by: scope.actorId });
        }
        return H.successResponse(res, { saved: true }, 'Streak milestone saved.');
    } catch (err) {
        console.error('[admin.loyalty.streakUpsert]', err && err.message);
        return H.errorResponse(res, 'Could not save the milestone.', 500);
    }
}

/**
 * streakDelete — DELETE /api/v1/admin/loyalty/streak/:id  (soft delete)
 */
async function streakDelete(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const n = await LA.softDelete(LA.T.orderCashback, Number(req.params.id), scope.companyId, scope.actorId);
        if (!n) { return H.errorResponse(res, 'That milestone no longer exists.', 404); }
        return H.successResponse(res, { deleted: true }, 'Milestone removed.');
    } catch (err) {
        console.error('[admin.loyalty.streakDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the milestone.', 500);
    }
}

/** referralToggle — POST /api/v1/admin/loyalty/referral/toggle {status} */
async function referralToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.referral, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Referral enabled.' : 'Referral disabled.');
    } catch (err) {
        console.error('[admin.loyalty.referralToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

/** streakToggle — POST /api/v1/admin/loyalty/streak/toggle {status} */
async function streakToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.streak, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Streaks enabled.' : 'Streaks disabled.');
    } catch (err) {
        console.error('[admin.loyalty.streakToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Screen 5: Challenges (Smart Campaigns) ─────────────────────────

const CAMPAIGN_TYPES = ['top_spenders', 'most_referrals', 'most_orders', 'most_reviews', 'inactive'];

/**
 * challengesGet — GET /api/v1/admin/loyalty/challenges?company_id=
 * One config row per fixed campaign type + the master flag. Missing types
 * come back zeroed so all five always render.
 */
async function challengesGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const rows = await LA.activeRows(LA.T.campaign, cid).select('type', 'target_value', 'value_type', 'cashback');
        const byType = {};
        rows.forEach((r) => {
            byType[r.type] = {
                target_value: Number(r.target_value) || 0,
                value_type:   r.value_type || '£',
                cashback:     Number(r.cashback) || 0,
            };
        });
        const campaigns = {};
        CAMPAIGN_TYPES.forEach((t) => {
            campaigns[t] = byType[t] || { target_value: 0, value_type: (t === 'inactive' ? '%' : '£'), cashback: 0 };
        });

        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { campaigns, masterOn: !!flags[LA.RULE_TYPES.smartCampaign] });
    } catch (err) {
        console.error('[admin.loyalty.challengesGet]', err && err.message);
        return H.errorResponse(res, 'Could not load challenges.', 500);
    }
}

/**
 * challengesSave — POST /api/v1/admin/loyalty/challenges
 * Upserts all five campaign types by (company_id, type). Flat fields:
 *   <type>_target, <type>_cashback, <type>_vt.
 */
async function challengesSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;

        for (const type of CAMPAIGN_TYPES) {
            const patch = {
                target_value: Number(b[type + '_target']) || 0,
                // Legacy: only the "inactive" row is £/%-selectable; the count-
                // based rows (spenders / referrals / orders / reviews) are £.
                value_type:   type === 'inactive' ? (b[type + '_vt'] === '%' ? '%' : '£') : '£',
                cashback:     money(b[type + '_cashback']),
            };
            const existing = await db(LA.T.campaign).where({ company_id: cid, type }).whereNull('deleted_at').first();
            if (existing) {
                await db(LA.T.campaign).where('id', existing.id)
                    .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                await db(LA.T.campaign).insert({ company_id: cid, type, ...patch, created_at: LA.nowStr(), created_by: scope.actorId });
            }
        }
        return H.successResponse(res, { saved: true }, 'Challenges saved.');
    } catch (err) {
        console.error('[admin.loyalty.challengesSave]', err && err.message);
        return H.errorResponse(res, 'Could not save challenges.', 500);
    }
}

/** challengesToggle — POST /api/v1/admin/loyalty/challenges/toggle {status} */
async function challengesToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.smartCampaign, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Challenges enabled.' : 'Challenges disabled.');
    } catch (err) {
        console.error('[admin.loyalty.challengesToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Screen 6: Event Rewards ────────────────────────────────────────

// Fixed event types (loyalty_event_cashback_rule.event_type).
const EVENT_TYPES = [1, 2, 3]; // 1=signup, 2=profile completion, 3=google review

/**
 * eventsGet — GET /api/v1/admin/loyalty/events?company_id=
 * One config per event type + the master flag. Missing types come back zeroed.
 */
async function eventsGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const rows = await LA.activeRows(LA.T.event, cid).select('event_type', 'value_type', 'cashback');
        const byType = {};
        rows.forEach((r) => {
            byType[Number(r.event_type)] = { value_type: r.value_type || '£', cashback: Number(r.cashback) || 0 };
        });
        const events = {};
        EVENT_TYPES.forEach((t) => { events[t] = byType[t] || { value_type: '£', cashback: 0 }; });

        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { events, masterOn: !!flags[LA.RULE_TYPES.event] });
    } catch (err) {
        console.error('[admin.loyalty.eventsGet]', err && err.message);
        return H.errorResponse(res, 'Could not load event rewards.', 500);
    }
}

/**
 * eventsSave — POST /api/v1/admin/loyalty/events
 * Upserts all three event types by (company_id, event_type). Flat fields:
 *   event_<type>_cashback, event_<type>_vt.
 */
async function eventsSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;

        for (const type of EVENT_TYPES) {
            const patch = {
                value_type: '£',   // legacy locks event rewards to £ only
                cashback:   money(b['event_' + type + '_cashback']),
            };
            const existing = await db(LA.T.event).where({ company_id: cid, event_type: type }).whereNull('deleted_at').first();
            if (existing) {
                await db(LA.T.event).where('id', existing.id)
                    .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                await db(LA.T.event).insert({ company_id: cid, event_type: type, ...patch, created_at: LA.nowStr(), created_by: scope.actorId });
            }
        }
        return H.successResponse(res, { saved: true }, 'Event rewards saved.');
    } catch (err) {
        console.error('[admin.loyalty.eventsSave]', err && err.message);
        return H.errorResponse(res, 'Could not save event rewards.', 500);
    }
}

/** eventsToggle — POST /api/v1/admin/loyalty/events/toggle {status} */
async function eventsToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.event, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Event rewards enabled.' : 'Event rewards disabled.');
    } catch (err) {
        console.error('[admin.loyalty.eventsToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Screen 7: Google / Facebook Review Claims ─────────────────────

const REVIEW_TYPE_LABEL = { 1: 'Google', 2: 'Facebook' };
const REVIEW_STATUS = { pending: 0, approved: 1, rejected: 2 };
const REVIEW_STATUS_LABEL = { 0: 'Pending', 1: 'Approved', 2: 'Rejected' };

/**
 * reviewClaimsGet — GET /api/v1/admin/loyalty/review-claims
 *   ?company_id=&status=pending|approved|rejected&date_from=&date_to=&q=
 * The approval queue: customer review submissions joined to the customer, with
 * the configured reward shown per row. Super admins (no company) see ALL
 * companies' claims; companies see only their own.
 */
async function reviewClaimsGet(req, res) {
    try {
        const scope = resolveCompanyScope(req);
        const cid = scope.companyId; // null = all (super)

        let q = db('customer_review as cr')
            .leftJoin('customer as c', 'c.id', 'cr.customer_id');
        if (cid != null) { q = q.where('cr.company_id', cid); }

        const status = req.query.status;
        if (status && REVIEW_STATUS[status] != null) { q = q.where('cr.admin_status', REVIEW_STATUS[status]); }
        if (req.query.date_from) { q = q.whereRaw('DATE(cr.review_date) >= ?', [req.query.date_from]); }
        if (req.query.date_to)   { q = q.whereRaw('DATE(cr.review_date) <= ?', [req.query.date_to]); }
        if (req.query.q) {
            const s = '%' + String(req.query.q).trim() + '%';
            q = q.where((b) => {
                b.where('c.firstname', 'ilike', s).orWhere('c.lastname', 'ilike', s).orWhere('c.contact_no', 'ilike', s);
            });
        }

        const rows = await q
            .select(
                'cr.id', 'cr.company_id', 'cr.customer_id', 'cr.review_type', 'cr.admin_status',
                'cr.review_date', 'cr.notes', 'cr.review_photo', 'cr.reject_reason',
                'c.firstname', 'c.lastname', 'c.contact_no',
            )
            .orderBy('cr.admin_status', 'asc')   // pending first
            .orderBy('cr.review_date', 'desc')
            .limit(300);

        // Reward config lookup: company_id:type → { cashback, value_type }.
        let ruleQ = db('loyalty_review_cashback_rule').whereNull('deleted_at');
        if (cid != null) { ruleQ = ruleQ.where('company_id', cid); }
        const rules = await ruleQ.select('company_id', 'type', 'value_type', 'cashback');
        const ruleMap = {};
        rules.forEach((r) => { ruleMap[r.company_id + ':' + r.type] = { cashback: Number(r.cashback) || 0, value_type: r.value_type || '£' }; });

        // Review screenshots are stored under /review-images/*. We keep the URL
        // relative (the admin serves /review-images from the web runtime folder),
        // so it loads same-origin even when the customer web app isn't running.
        const photoUrl = (p) => {
            const f = String(p || '').trim();
            if (!f) { return ''; }
            if (/^https?:\/\//i.test(f)) { return f; }
            return f.charAt(0) === '/' ? f : ('/' + f);
        };
        const claims = rows.map((r) => {
            const rule = ruleMap[r.company_id + ':' + r.review_type] || { cashback: 0, value_type: '£' };
            return {
                id:            Number(r.id),
                company_id:    Number(r.company_id),
                customer_name: [r.firstname, r.lastname].filter(Boolean).join(' ') || ('Customer #' + r.customer_id),
                contact_no:    r.contact_no || '',
                review_type:   Number(r.review_type),
                type_label:    REVIEW_TYPE_LABEL[r.review_type] || 'Review',
                admin_status:  Number(r.admin_status),
                status_label:  REVIEW_STATUS_LABEL[r.admin_status] || 'Pending',
                review_date:   r.review_date,
                notes:         r.notes || '',
                review_photo:  r.review_photo || '',
                review_photo_url: photoUrl(r.review_photo),
                reject_reason: r.reject_reason || '',
                reward:        rule.cashback,
                reward_vt:     rule.value_type,
            };
        });

        // Status counts (scoped) for the filter chips.
        let countQ = db('customer_review');
        if (cid != null) { countQ = countQ.where('company_id', cid); }
        const counts = await countQ.select('admin_status').count('* as n').groupBy('admin_status');
        const tally = { pending: 0, approved: 0, rejected: 0 };
        counts.forEach((c) => {
            if (Number(c.admin_status) === 0) { tally.pending = Number(c.n); }
            else if (Number(c.admin_status) === 1) { tally.approved = Number(c.n); }
            else if (Number(c.admin_status) === 2) { tally.rejected = Number(c.n); }
        });

        return H.successResponse(res, { claims, counts: tally });
    } catch (err) {
        console.error('[admin.loyalty.reviewClaimsGet]', err && err.message);
        return H.errorResponse(res, 'Could not load review claims.', 500);
    }
}

// Load a pending review the actor is allowed to act on (company login is
// pinned to its own company). Returns the row, or sends an error + null.
async function loadActionableClaim(req, res) {
    const scope = resolveCompanyScope(req);
    const id = Number(req.body && req.body.id);
    if (!id) { H.errorResponse(res, 'Missing claim id.', 422); return null; }

    const review = await db('customer_review').where('id', id).first();
    if (!review) { H.errorResponse(res, 'That claim no longer exists.', 404); return null; }
    if (!scope.isSuper && Number(review.company_id) !== Number(scope.companyId)) {
        H.errorResponse(res, 'That claim belongs to another company.', 403); return null;
    }
    if (Number(review.admin_status) !== 0) {
        H.errorResponse(res, 'This claim has already been processed.', 422, { code: 'already_done' }); return null;
    }
    return { review, scope };
}

/**
 * reviewApprove — POST /api/v1/admin/loyalty/review-claims/approve {id}
 * Marks the claim approved and GRANTS the configured review reward through the
 * shared award() path (commission skim + expiry + ledger + audit row).
 */
async function reviewApprove(req, res) {
    try {
        const got = await loadActionableClaim(req, res);
        if (!got) { return; }
        const { review, scope } = got;

        // Grant the configured reward (flat £ per review type), if any.
        const rule = await db('loyalty_review_cashback_rule')
            .where({ company_id: review.company_id, type: review.review_type })
            .whereNull('deleted_at').first();
        let granted = 0;
        if (rule && Number(rule.cashback) > 0) {
            const cfg = await Loyalty.loadConfig(review.company_id);
            if (cfg) {
                await Loyalty.award({
                    companyId:  review.company_id,
                    customerId: review.customer_id,
                    entityType: 'review',
                    entityId:   rule.id,
                    relatedId:  review.id,
                    amount:     Number(rule.cashback),
                    cfg,
                });
                granted = Number(rule.cashback);
            }
        }

        await db('customer_review').where('id', review.id).update({
            admin_status: 1,
            reject_reason: null,
            updated_at: LA.nowStr(),
            updated_by: scope.actorId,
        });

        return H.successResponse(res, { approved: true, granted },
            granted > 0 ? 'Review approved — reward granted.' : 'Review approved.');
    } catch (err) {
        console.error('[admin.loyalty.reviewApprove]', err && err.message);
        return H.errorResponse(res, 'Could not approve the claim.', 500);
    }
}

/**
 * reviewReject — POST /api/v1/admin/loyalty/review-claims/reject {id, reject_reason}
 * Marks the claim rejected with a required reason. No reward is granted.
 */
async function reviewReject(req, res) {
    try {
        const reason = String((req.body && req.body.reject_reason) || '').trim();
        if (!reason) { return H.errorResponse(res, 'A reason is required to reject a claim.', 422); }

        const got = await loadActionableClaim(req, res);
        if (!got) { return; }
        const { review, scope } = got;

        await db('customer_review').where('id', review.id).update({
            admin_status: 2,
            reject_reason: reason.slice(0, 500),
            updated_at: LA.nowStr(),
            updated_by: scope.actorId,
        });
        return H.successResponse(res, { rejected: true }, 'Review rejected.');
    } catch (err) {
        console.error('[admin.loyalty.reviewReject]', err && err.message);
        return H.errorResponse(res, 'Could not reject the claim.', 500);
    }
}

// ── Screen 8: Customer Segments (computed analytics) ───────────────

/**
 * segmentsGet — GET /api/v1/admin/loyalty/segments?company_id=
 * Derived, read-only analytics. Each customer's lifetime spend (completed
 * orders) is bucketed into the company's tier bands; plus an "inactive" count
 * (no order within N days, N from the inactive smart_campaign). No CRUD —
 * legacy had no segment table.
 */
async function segmentsGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;

        const tierRows = await db(LA.T.tier).where('company_id', cid).whereNull('deleted_at')
            .select('type', 'min_amount', 'max_amount').orderBy('min_amount', 'asc');
        const buckets = tierRows.map((t) => ({
            type: t.type, min: Number(t.min_amount) || 0, max: Number(t.max_amount) || 0,
            customerCount: 0, totalSpend: 0,
        }));

        // Per-customer completed spend + last order date. Completed = the
        // legacy convention status='1' AND order_status='' (see getCustomerTier).
        const rows = await db('orders')
            .where({ company_id: cid, status: '1', order_status: '' })
            .whereNotNull('user_id')
            .groupBy('user_id')
            .select('user_id')
            .sum({ spend: 'sub_total' })
            .max({ last: 'created_at' });

        const inactiveCampaign = await db(LA.T.campaign)
            .where({ company_id: cid, type: 'inactive' }).whereNull('deleted_at').first();
        const days = (inactiveCampaign && Number(inactiveCampaign.target_value) > 0)
            ? Number(inactiveCampaign.target_value) : 30;
        const cutoff = Date.now() - days * 86400000;

        let inactiveCount = 0;
        let grandSpend = 0;
        rows.forEach((r) => {
            const sp = Number(r.spend) || 0;
            grandSpend += sp;
            const b = buckets.find((x) => sp >= x.min && (x.max === 0 || sp <= x.max));
            if (b) { b.customerCount += 1; b.totalSpend = Math.round((b.totalSpend + sp) * 100) / 100; }
            if (r.last && new Date(r.last).getTime() < cutoff) { inactiveCount += 1; }
        });

        return H.successResponse(res, {
            tiers: buckets,
            inactive: { days, customerCount: inactiveCount },
            totalCustomers: rows.length,
            totalSpend: Math.round(grandSpend * 100) / 100,
        });
    } catch (err) {
        console.error('[admin.loyalty.segmentsGet]', err && err.message);
        return H.errorResponse(res, 'Could not load segments.', 500);
    }
}

// ── Section 8: Special Offer (date-based cashback) ──────────────────
// loyalty_special_offer_rule: value_type (£/%), cashback, offer_date.
// Variable rows — per-row upsert + soft-delete (matches the streak screen).

async function specialOfferGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const rows = await LA.activeRows(LA.T.specialOffer, cid)
            .select('id', 'value_type', 'cashback', 'offer_date')
            .orderBy('offer_date', 'asc');
        const offers = rows.map((r) => ({
            id: Number(r.id),
            value_type: r.value_type || '£',
            cashback: Number(r.cashback) || 0,
            offer_date: r.offer_date ? new Date(r.offer_date).toISOString().slice(0, 10) : '',
        }));
        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { offers, masterOn: !!flags[LA.RULE_TYPES.specialOffer] });
    } catch (err) {
        console.error('[admin.loyalty.specialOfferGet]', err && err.message);
        return H.errorResponse(res, 'Could not load special offers.', 500);
    }
}

async function specialOfferUpsert(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const patch = {
            value_type: b.value_type === '%' ? '%' : '£',
            cashback:   money(b.cashback),
            offer_date: b.offer_date || null,
        };
        if (Number(patch.cashback) <= 0) { return H.errorResponse(res, 'Enter a cashback greater than 0.', 422); }

        const id = Number(b.id) || 0;
        if (id) {
            const owned = await db(LA.T.specialOffer).where({ id, company_id: cid }).whereNull('deleted_at').first();
            if (!owned) { return H.errorResponse(res, 'That offer was not found.', 404); }
            await db(LA.T.specialOffer).where('id', id)
                .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
        } else {
            await db(LA.T.specialOffer).insert({
                company_id: cid, ...patch, created_at: LA.nowStr(), created_by: scope.actorId,
            });
        }
        return H.successResponse(res, { saved: true }, 'Special offer saved.');
    } catch (err) {
        console.error('[admin.loyalty.specialOfferUpsert]', err && err.message);
        return H.errorResponse(res, 'Could not save the special offer.', 500);
    }
}

async function specialOfferDelete(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const id = Number(req.params.id) || 0;
        const n = await LA.softDelete(LA.T.specialOffer, id, scope.companyId, scope.actorId);
        if (!n) { return H.errorResponse(res, 'That offer was not found.', 404); }
        return H.successResponse(res, { deleted: true }, 'Special offer removed.');
    } catch (err) {
        console.error('[admin.loyalty.specialOfferDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the offer.', 500);
    }
}

async function specialOfferToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.specialOffer, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Special offers enabled.' : 'Special offers disabled.');
    } catch (err) {
        console.error('[admin.loyalty.specialOfferToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Section 6: Review Cashback rewards (per review/share type) ──────
// loyalty_review_cashback_rule: 8 fixed review/share types, flat £ payout
// each (legacy locks value_type='£'). Upsert by (company_id, type).
const REVIEW_REWARD_TYPES = [
    { id: 1, name: 'Google Review' },
    { id: 2, name: 'Website Review' },
    { id: 3, name: 'Transfer Your Loyalty To Us' },
    { id: 4, name: 'Facebook Share' },
    { id: 5, name: 'TikTok Share' },
    { id: 6, name: 'Instagram Share' },
    { id: 7, name: 'Live Video' },
    { id: 8, name: 'Whatsapp Share' },
];

async function reviewRewardsGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const rows = await LA.activeRows(LA.T.review, cid).select('type', 'value_type', 'cashback');
        const byType = {};
        rows.forEach((r) => { byType[Number(r.type)] = Number(r.cashback) || 0; });
        const types = REVIEW_REWARD_TYPES.map((t) => ({ id: t.id, name: t.name, cashback: byType[t.id] || 0 }));
        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { types, masterOn: !!flags[LA.RULE_TYPES.review] });
    } catch (err) {
        console.error('[admin.loyalty.reviewRewardsGet]', err && err.message);
        return H.errorResponse(res, 'Could not load review rewards.', 500);
    }
}

async function reviewRewardsSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        for (const t of REVIEW_REWARD_TYPES) {
            const cashback = money(b['review_' + t.id + '_cashback']);
            const existing = await db(LA.T.review).where({ company_id: cid, type: t.id }).whereNull('deleted_at').first();
            if (Number(cashback) <= 0) {
                // Legacy skips empty rows; soft-delete a previously-set one.
                if (existing) {
                    await db(LA.T.review).where('id', existing.id)
                        .update({ deleted_at: LA.nowStr(), deleted_by: scope.actorId });
                }
                continue;
            }
            const patch = { value_type: '£', cashback };   // legacy locks the unit to £
            if (existing) {
                await db(LA.T.review).where('id', existing.id)
                    .update({ ...patch, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                await db(LA.T.review).insert({
                    company_id: cid, type: t.id, ...patch, created_at: LA.nowStr(), created_by: scope.actorId,
                });
            }
        }
        return H.successResponse(res, { saved: true }, 'Review rewards saved.');
    } catch (err) {
        console.error('[admin.loyalty.reviewRewardsSave]', err && err.message);
        return H.errorResponse(res, 'Could not save review rewards.', 500);
    }
}

async function reviewRewardsToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.review, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Review rewards enabled.' : 'Review rewards disabled.');
    } catch (err) {
        console.error('[admin.loyalty.reviewRewardsToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Section 4: Product Cashback (low-selling items) ─────────────────
// loyalty_product_cashback_rule (£ cashback, value_type locked to £) +
// loyalty_product_cashback_items (selected products). Parent + child soft-
// delete sync, mirroring the legacy save. Cashback can't exceed the lowest
// selected product's price.

const insertId = (ins) => (Array.isArray(ins) ? (ins[0].id || ins[0]) : ins);

/**
 * productCatalog — the company's branch menu: active, non-variant products
 * with their pre-tax price. Mirrors the legacy product list query.
 */
async function productCatalog(companyId) {
    const branch = await db('branch').where('company_id', companyId).first();
    const bid = branch ? Number(branch.id) : 0;
    const cats = await db('categories')
        .where('company_id', companyId)
        .andWhereRaw("status <> '2'")
        .andWhereRaw("? = ANY (string_to_array(branch_id, ',')::int[])", [bid])
        .select('id');
    const catIds = cats.map((c) => Number(c.id));
    if (!catIds.length) { return []; }
    const rows = await db('products')
        .leftJoin('product_product_category', function join() {
            this.on('product_product_category.product_id', '=', 'products.id')
                .andOn('product_product_category.status', '=', db.raw("'1'"));
        })
        .whereRaw("products.status = '1'")
        .andWhere('products.product_type', 0)
        .andWhere('products.company_id', companyId)
        .whereIn('product_product_category.category_id', catIds)
        .distinct('products.id', 'products.name', 'products.price_before_tax')
        .orderBy('products.name', 'asc');
    return rows.map((p) => ({ id: Number(p.id), name: p.name, price: Number(p.price_before_tax) || 0 }));
}

/** categoryCatalog — the company's branch categories (for BOGO). */
async function categoryCatalog(companyId) {
    const branch = await db('branch').where('company_id', companyId).first();
    const bid = branch ? Number(branch.id) : 0;
    const rows = await db('categories')
        .where('company_id', companyId)
        .andWhereRaw("status <> '2'")
        .andWhereRaw("? = ANY (string_to_array(branch_id, ',')::int[])", [bid])
        .orderBy('id', 'asc')
        .select('id', 'name');
    return rows.map((c) => ({ id: Number(c.id), name: c.name }));
}

// Normalise a posted id-list (single value or array) → unique positive ints.
function idList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    return [...new Set(arr.map((n) => Number(n)).filter((n) => n > 0))];
}

async function productCashbackGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const rules = await LA.activeRows(LA.T.product, cid).select('id', 'value_type', 'cashback').orderBy('id', 'asc');
        const ruleIds = rules.map((r) => Number(r.id));
        let items = [];
        if (ruleIds.length) {
            items = await db(LA.T.productItems)
                .whereIn('product_cashback_rule_id', ruleIds).whereNull('deleted_at')
                .select('product_cashback_rule_id', 'product_id');
        }
        const byRule = {};
        items.forEach((it) => {
            const k = Number(it.product_cashback_rule_id);
            (byRule[k] = byRule[k] || []).push(Number(it.product_id));
        });
        const products = await productCatalog(cid);
        const pname = {}; products.forEach((p) => { pname[p.id] = p.name; });
        const out = rules.map((r) => ({
            id: Number(r.id),
            value_type: r.value_type || '£',
            cashback: Number(r.cashback) || 0,
            product_ids: byRule[Number(r.id)] || [],
            product_names: (byRule[Number(r.id)] || []).map((id) => pname[id] || ('#' + id)),
        }));
        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { rules: out, products, masterOn: !!flags[LA.RULE_TYPES.productCashback] });
    } catch (err) {
        console.error('[admin.loyalty.productCashbackGet]', err && err.message);
        return H.errorResponse(res, 'Could not load product cashback.', 500);
    }
}

async function productCashbackUpsert(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;

        const productIds = idList(b.product_ids);
        if (!productIds.length) { return H.errorResponse(res, 'Select at least one product.', 422); }
        const cashback = money(b.cashback);
        if (Number(cashback) <= 0) { return H.errorResponse(res, 'Enter a cashback greater than 0.', 422); }

        // Cashback can't exceed the lowest selected product price (legacy rule).
        const catalog = await productCatalog(cid);
        const priceById = {}; catalog.forEach((p) => { priceById[p.id] = p.price; });
        const prices = productIds.map((id) => priceById[id]).filter((p) => p != null);
        const lowest = prices.length ? Math.min(...prices) : null;
        if (lowest != null && Number(cashback) > lowest) {
            return H.errorResponse(res, 'Cashback can’t be more than the lowest selected product price (£' + lowest.toFixed(2) + ').', 422);
        }

        const id = Number(b.id) || 0;
        let ruleId;
        if (id) {
            const owned = await db(LA.T.product).where({ id, company_id: cid }).whereNull('deleted_at').first();
            if (!owned) { return H.errorResponse(res, 'That rule was not found.', 404); }
            await db(LA.T.product).where('id', id)
                .update({ value_type: '£', cashback, updated_at: LA.nowStr(), updated_by: scope.actorId });
            ruleId = id;
        } else {
            const ins = await db(LA.T.product).insert({
                company_id: cid, value_type: '£', cashback, created_at: LA.nowStr(), created_by: scope.actorId,
            }).returning('id');
            ruleId = insertId(ins);
        }

        // Sync child product rows: revive existing, insert new, soft-delete dropped.
        const existing = await db(LA.T.productItems).where('product_cashback_rule_id', ruleId).select('id', 'product_id', 'deleted_at');
        const byPid = {}; existing.forEach((e) => { byPid[Number(e.product_id)] = e; });
        for (const pid of productIds) {
            const e = byPid[pid];
            if (e) {
                await db(LA.T.productItems).where('id', e.id)
                    .update({ deleted_at: null, deleted_by: null, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                await db(LA.T.productItems).insert({
                    product_cashback_rule_id: ruleId, product_id: pid,
                    created_at: LA.nowStr(), created_by: scope.actorId,
                });
            }
        }
        const keep = new Set(productIds);
        const drop = existing.filter((e) => !e.deleted_at && !keep.has(Number(e.product_id))).map((e) => e.id);
        if (drop.length) {
            await db(LA.T.productItems).whereIn('id', drop).update({ deleted_at: LA.nowStr(), deleted_by: scope.actorId });
        }
        return H.successResponse(res, { saved: true }, 'Product cashback saved.');
    } catch (err) {
        console.error('[admin.loyalty.productCashbackUpsert]', err && err.message);
        return H.errorResponse(res, 'Could not save product cashback.', 500);
    }
}

async function productCashbackDelete(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const id = Number(req.params.id) || 0;
        const n = await LA.softDelete(LA.T.product, id, scope.companyId, scope.actorId);
        if (!n) { return H.errorResponse(res, 'That rule was not found.', 404); }
        await db(LA.T.productItems).where('product_cashback_rule_id', id).whereNull('deleted_at')
            .update({ deleted_at: LA.nowStr(), deleted_by: scope.actorId });
        return H.successResponse(res, { deleted: true }, 'Product cashback removed.');
    } catch (err) {
        console.error('[admin.loyalty.productCashbackDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the rule.', 500);
    }
}

async function productCashbackToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.productCashback, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Product cashback enabled.' : 'Product cashback disabled.');
    } catch (err) {
        console.error('[admin.loyalty.productCashbackToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Section 7: Buy X Get Y (BOGO) ───────────────────────────────────
// loyalty_bogof_rule (apply_on 1=Product/2=Category, buy_quantity,
// get_quantity) + loyalty_bogof_buy (a product_id OR category_id per row).
// Parent + child soft-delete sync; switching apply_on retires the old items.

function bogofKey(row) {
    return row.product_id != null ? ('p_' + Number(row.product_id)) : ('c_' + Number(row.category_id));
}

async function bogofGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const rules = await LA.activeRows(LA.T.bogof, cid)
            .select('id', 'apply_on', 'buy_quantity', 'get_quantity').orderBy('id', 'asc');
        const ruleIds = rules.map((r) => Number(r.id));
        let items = [];
        if (ruleIds.length) {
            items = await db(LA.T.bogofBuy).whereIn('bogof_rule_id', ruleIds).whereNull('deleted_at')
                .select('bogof_rule_id', 'product_id', 'category_id');
        }
        const prodByRule = {}; const catByRule = {};
        items.forEach((it) => {
            const k = Number(it.bogof_rule_id);
            if (it.product_id != null) { (prodByRule[k] = prodByRule[k] || []).push(Number(it.product_id)); }
            if (it.category_id != null) { (catByRule[k] = catByRule[k] || []).push(Number(it.category_id)); }
        });
        const products = await productCatalog(cid);
        const categories = await categoryCatalog(cid);
        const pname = {}; products.forEach((p) => { pname[p.id] = p.name; });
        const cname = {}; categories.forEach((c) => { cname[c.id] = c.name; });
        const out = rules.map((r) => {
            const k = Number(r.id);
            const pids = prodByRule[k] || [];
            const cids = catByRule[k] || [];
            const applyOn = Number(r.apply_on) || 1;
            return {
                id: k, apply_on: applyOn,
                buy_quantity: Number(r.buy_quantity) || 0,
                get_quantity: Number(r.get_quantity) || 0,
                product_ids: pids, category_ids: cids,
                item_names: (applyOn === 2 ? cids.map((id) => cname[id] || ('#' + id)) : pids.map((id) => pname[id] || ('#' + id))),
            };
        });
        const flags = await LA.getMasterFlags(cid);
        return H.successResponse(res, { rules: out, products, categories, masterOn: !!flags[LA.RULE_TYPES.bogof] });
    } catch (err) {
        console.error('[admin.loyalty.bogofGet]', err && err.message);
        return H.errorResponse(res, 'Could not load BOGO offers.', 500);
    }
}

async function bogofUpsert(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const applyOn = Number(b.apply_on) === 2 ? 2 : 1;
        const buyQty = Math.max(1, Number(b.buy_quantity) || 0);
        const getQty = Math.max(1, Number(b.get_quantity) || 0);
        const itemIds = applyOn === 2 ? idList(b.category_ids) : idList(b.product_ids);
        if (!itemIds.length) {
            return H.errorResponse(res, applyOn === 2 ? 'Select at least one category.' : 'Select at least one product.', 422);
        }

        const id = Number(b.id) || 0;
        let ruleId;
        if (id) {
            const owned = await db(LA.T.bogof).where({ id, company_id: cid }).whereNull('deleted_at').first();
            if (!owned) { return H.errorResponse(res, 'That offer was not found.', 404); }
            await db(LA.T.bogof).where('id', id)
                .update({ apply_on: applyOn, buy_quantity: buyQty, get_quantity: getQty, updated_at: LA.nowStr(), updated_by: scope.actorId });
            ruleId = id;
        } else {
            const ins = await db(LA.T.bogof).insert({
                company_id: cid, apply_on: applyOn, buy_quantity: buyQty, get_quantity: getQty,
                created_at: LA.nowStr(), created_by: scope.actorId,
            }).returning('id');
            ruleId = insertId(ins);
        }

        // Sync child buy rows. Keys: p_<productId> / c_<categoryId>. Reviving an
        // existing row, inserting new, soft-deleting everything else (which
        // includes the other apply_on type when it was switched).
        const existing = await db(LA.T.bogofBuy).where('bogof_rule_id', ruleId).select('id', 'product_id', 'category_id', 'deleted_at');
        const existByKey = {}; existing.forEach((e) => { existByKey[bogofKey(e)] = e; });
        const newKeys = itemIds.map((x) => (applyOn === 2 ? 'c_' : 'p_') + x);
        for (const itemId of itemIds) {
            const key = (applyOn === 2 ? 'c_' : 'p_') + itemId;
            const e = existByKey[key];
            if (e) {
                await db(LA.T.bogofBuy).where('id', e.id)
                    .update({ deleted_at: null, deleted_by: null, updated_at: LA.nowStr(), updated_by: scope.actorId });
            } else {
                const row = { bogof_rule_id: ruleId, created_at: LA.nowStr(), created_by: scope.actorId };
                if (applyOn === 2) { row.category_id = itemId; } else { row.product_id = itemId; }
                await db(LA.T.bogofBuy).insert(row);
            }
        }
        const keep = new Set(newKeys);
        const drop = existing.filter((e) => !e.deleted_at && !keep.has(bogofKey(e))).map((e) => e.id);
        if (drop.length) {
            await db(LA.T.bogofBuy).whereIn('id', drop).update({ deleted_at: LA.nowStr(), deleted_by: scope.actorId });
        }
        return H.successResponse(res, { saved: true }, 'Buy X Get Y offer saved.');
    } catch (err) {
        console.error('[admin.loyalty.bogofUpsert]', err && err.message);
        return H.errorResponse(res, 'Could not save the offer.', 500);
    }
}

async function bogofDelete(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const id = Number(req.params.id) || 0;
        const n = await LA.softDelete(LA.T.bogof, id, scope.companyId, scope.actorId);
        if (!n) { return H.errorResponse(res, 'That offer was not found.', 404); }
        await db(LA.T.bogofBuy).where('bogof_rule_id', id).whereNull('deleted_at')
            .update({ deleted_at: LA.nowStr(), deleted_by: scope.actorId });
        return H.successResponse(res, { deleted: true }, 'Offer removed.');
    } catch (err) {
        console.error('[admin.loyalty.bogofDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the offer.', 500);
    }
}

async function bogofToggle(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const on = truthy(req.body.status);
        await LA.setMasterFlag(scope.companyId, LA.RULE_TYPES.bogof, on, scope.actorId);
        return H.successResponse(res, { masterOn: on }, on ? 'Buy X Get Y enabled.' : 'Buy X Get Y disabled.');
    } catch (err) {
        console.error('[admin.loyalty.bogofToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update the setting.', 500);
    }
}

// ── Review CMS Pages (loyalty_cms_pages — NEW 2026-06-09) ───────────
// Per review/share type, a company authors a title + rich-text description +
// an example screenshot shown to customers on the review submission page.
// Keyed uniquely by (company_id, review_type_slug). Upsert-only (no delete);
// timestamps are INTEGER unix seconds (this table differs from the others).
const REVIEW_CMS_TYPES = [
    { slug: 'google-review', name: 'Google Review' },
    { slug: 'website-review', name: 'Website Review' },
    { slug: 'transfer-loyalty-review', name: 'Transfer Your Loyalty To Us' },
    { slug: 'facebook-review', name: 'Facebook Share' },
    { slug: 'tiktok-review', name: 'TikTok Share' },
    { slug: 'instagram-review', name: 'Instagram Share' },
    { slug: 'live-video-review', name: 'Live Video' },
    { slug: 'whatsapp-review', name: 'Whatsapp Share' },
];

function nowUnix() { return Math.floor(Date.now() / 1000); }

// ── Rich-text sanitizer for the CMS description ──────────────────────
// Admin-authored HTML is rendered back to the admin AND to customers, so we
// allowlist a small set of formatting tags + safe attributes and strip
// scripts, styles, event handlers and dangerous URL schemes. Conservative by
// design (no external dependency); the editor only emits these tags anyway.
const CMS_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'span', 'div', 'img', 'font', 'pre', 'code', 'hr']);
const CMS_ATTR = {
    a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'],
    font: ['color'], span: ['style'], div: ['style'], p: ['style'], li: ['style'],
};
// Decode HTML entities (numeric + a few named) so a scheme like
// "j&#97;vascript:" can't slip a URL check that only sees the raw text.
const CMS_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/' };
function cmsSafeChar(c) { try { return (c >= 0 && c <= 0x10FFFF) ? String.fromCodePoint(c) : ''; } catch (e) { return ''; } }
function decodeEntities(str) {
    return String(str == null ? '' : str)
        .replace(/&#x([0-9a-f]+);?/gi, (m, h) => cmsSafeChar(parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (m, d) => cmsSafeChar(parseInt(d, 10)))
        .replace(/&(amp|lt|gt|quot|apos|colon|tab|newline|sol);/gi, (m, e) => CMS_ENT[e.toLowerCase()] || m);
}
function sanitizeCmsHtml(html) {
    let s = String(html == null ? '' : html);
    // Remove dangerous elements WITH their content, then comments.
    s = s.replace(/<(script|style|iframe|object|embed|svg|math|form|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/<\/?(script|style|iframe|object|embed|svg|math|form|textarea|input|button|link|meta|base)\b[^>]*>/gi, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // Opening tags: drop non-allowlisted; scrub attributes on the rest.
    s = s.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g, (m, tag, attrs, selfClose) => {
        const t = tag.toLowerCase();
        if (!CMS_TAGS.has(t)) { return ''; }
        const allow = CMS_ATTR[t] || [];
        let out = '';
        String(attrs).replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g, (am, name, val) => {
            const n = name.toLowerCase();
            if (n.indexOf('on') === 0) { return ''; }            // event handlers
            if (allow.indexOf(n) === -1) { return ''; }
            let v = String(val).replace(/^["']|["']$/g, '');
            if (n === 'href' || n === 'src') {
                // Decode + strip control/space, then allow ONLY safe schemes
                // (relative/anchor URLs have no scheme and are allowed).
                const probe = decodeEntities(v).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
                if (/^[a-z][a-z0-9+.\-]*:/.test(probe) && !/^(https?:|mailto:|tel:)/.test(probe)) { return ''; }
            }
            if (n === 'style') {
                const probe = decodeEntities(v).toLowerCase();
                if (/expression|javascript:|vbscript:|url\s*\(|[\\@]|&#/.test(probe)) { return ''; }
            }
            out += ' ' + n + '="' + v.replace(/"/g, '&quot;') + '"';
            return '';
        });
        return '<' + t + out + (selfClose ? ' /' : '') + '>';
    });
    // Closing tags: keep only allowlisted.
    s = s.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g, (m, tag) => (CMS_TAGS.has(tag.toLowerCase()) ? '</' + tag.toLowerCase() + '>' : ''));
    return s.trim().slice(0, 20000);
}

async function cmsPagesGet(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const rows = await db(LA.T.cmsPages).where('company_id', cid)
            .select('review_type_slug', 'title', 'description', 'screenshot');
        const bySlug = {}; rows.forEach((r) => { bySlug[r.review_type_slug] = r; });
        const upBase = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
        const pages = REVIEW_CMS_TYPES.map((t) => {
            const r = bySlug[t.slug];
            const shot = r ? (r.screenshot || '') : '';
            return {
                slug: t.slug,
                name: t.name,
                title: r && r.title ? r.title : t.name,
                description: r ? sanitizeCmsHtml(r.description || '') : '',
                screenshot: shot,
                screenshot_url: shot ? (upBase + '/' + cid + '/loyalty/' + shot) : '',
            };
        });
        return H.successResponse(res, { pages });
    } catch (err) {
        console.error('[admin.loyalty.cmsPagesGet]', err && err.message);
        return H.errorResponse(res, 'Could not load review CMS pages.', 500);
    }
}

async function cmsPageSave(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const b = req.body;
        const slug = String(b.review_type_slug || '');
        const type = REVIEW_CMS_TYPES.find((t) => t.slug === slug);
        if (!type) { return H.errorResponse(res, 'Unknown review type.', 422); }

        const patch = {
            title:       String(b.title || type.name).slice(0, 255),
            description: sanitizeCmsHtml(b.description),
        };
        if (b.screenshot) { patch.screenshot = String(b.screenshot).slice(0, 255); }

        const existing = await db(LA.T.cmsPages).where({ company_id: cid, review_type_slug: slug }).first();
        if (existing) {
            await db(LA.T.cmsPages).where('id', existing.id).update({ ...patch, updated_at: nowUnix() });
        } else {
            await db(LA.T.cmsPages).insert({
                company_id: cid, review_type_slug: slug, ...patch,
                created_at: nowUnix(), updated_at: nowUnix(),
            });
        }
        return H.successResponse(res, { saved: true }, 'Review CMS page saved.');
    } catch (err) {
        console.error('[admin.loyalty.cmsPageSave]', err && err.message);
        return H.errorResponse(res, 'Could not save the CMS page.', 500);
    }
}

// ── Save All — the single "Save All Settings" for the whole config page ──
// Ports the legacy single-form save: header config + master toggles + all 10
// sections in one POST. Each multi-row section upserts the posted rows and
// soft-deletes the ones dropped from the form (legacy existingIds−keptIds).
function asRows(v) {
    if (Array.isArray(v)) { return v.filter(Boolean); }
    if (v && typeof v === 'object') { return Object.values(v); }
    return [];
}

async function saveAll(req, res) {
    try {
        const scope = requireCompany(req, res);
        if (!scope) { return; }
        const cid = scope.companyId;
        const actor = scope.actorId;
        const b = req.body;
        const now = LA.nowStr();

        // 1) Header config (company_loyalty)
        const cfgPatch = {
            expiry_duration_days: Number(b.expiry_duration_days) || 0,
            notify_before_days:   Number(b.notify_before_days) || 0,
            use_max_cashback:     money(b.use_max_cashback),
            cash_king:            money(b.cash_king),
            collection_cashback:  money(b.collection_cashback),
            loyalty_commission:   money(b.loyalty_commission),
            enable_loyalty_phone_order: truthy(b.enable_loyalty_phone_order) ? 1 : 2,
            updated_at: now, updated_by: actor,
        };
        if (scope.isSuper && b.loyalty_status != null && b.loyalty_status !== '') {
            cfgPatch.loyalty_status = Number(b.loyalty_status) === 1 ? 1 : 2;
        }
        const cfgRow = await db(LA.T.config).where('company_id', cid).first();
        if (cfgRow) { await db(LA.T.config).where('company_id', cid).update(cfgPatch); }
        else {
            await db(LA.T.config).insert({
                company_id: cid, loyalty_status: cfgPatch.loyalty_status != null ? cfgPatch.loyalty_status : 2,
                ...cfgPatch, created_at: now, created_by: actor,
            });
        }

        // 2) Master on/off toggles (loyalty_rules)
        const toggleMap = {
            on_cashback: LA.RULE_TYPES.cashback, on_event: LA.RULE_TYPES.event,
            on_referral: LA.RULE_TYPES.referral, on_streak: LA.RULE_TYPES.streak,
            on_review: LA.RULE_TYPES.review, on_tier: LA.RULE_TYPES.membershipTier,
            on_campaign: LA.RULE_TYPES.smartCampaign, on_special: LA.RULE_TYPES.specialOffer,
            on_product: LA.RULE_TYPES.productCashback, on_bogof: LA.RULE_TYPES.bogof,
        };
        for (const k of Object.keys(toggleMap)) { await LA.setMasterFlag(cid, toggleMap[k], truthy(b[k]), actor); }

        // 3) Events (Account Setup) — £
        for (const t of EVENT_TYPES) {
            const patch = { value_type: '£', cashback: money(b['event_' + t + '_cashback']) };
            const ex = await db(LA.T.event).where({ company_id: cid, event_type: t }).whereNull('deleted_at').first();
            if (ex) { await db(LA.T.event).where('id', ex.id).update({ ...patch, updated_at: now, updated_by: actor }); }
            else { await db(LA.T.event).insert({ company_id: cid, event_type: t, ...patch, created_at: now, created_by: actor }); }
        }

        // 4) Order Cashback rules — % (multi-row)
        {
            const existing = await db(LA.T.cashback).where('company_id', cid).whereNull('deleted_at').select('id');
            const kept = [];
            for (const r of asRows(b.cashback)) {
                if (Number(money(r.cashback)) <= 0) { continue; }
                const patch = {
                    min_order_amount: money(r.min_order_amount), cashback: money(r.cashback),
                    value_type: '%', tier_type: r.tier_type ? String(r.tier_type) : null,
                    apply_on: 1, order_count: 5, status: 1,
                };
                const id = Number(r.id) || 0;
                if (id) {
                    const owned = await db(LA.T.cashback).where({ id, company_id: cid }).whereNull('deleted_at').first();
                    if (owned) { await db(LA.T.cashback).where('id', id).update({ ...patch, updated_at: now, updated_by: actor }); kept.push(id); }
                } else {
                    const ins = await db(LA.T.cashback).insert({ company_id: cid, ...patch, created_at: now, created_by: actor }).returning('id');
                    kept.push(insertId(ins));
                }
            }
            const del = existing.map((e) => Number(e.id)).filter((x) => !kept.includes(x));
            if (del.length) { await db(LA.T.cashback).whereIn('id', del).update({ deleted_at: now, deleted_by: actor }); }
        }

        // 5) Referral — £ (single)
        {
            const patch = { value_type: '£', referrer_cashback: money(b.referrer_cashback), referee_cashback: money(b.referee_cashback), trigger: Number(b.trigger) === 1 ? 1 : 2 };
            const ex = await db(LA.T.referral).where('company_id', cid).whereNull('deleted_at').first();
            if (ex) { await db(LA.T.referral).where('id', ex.id).update({ ...patch, updated_at: now, updated_by: actor }); }
            else { await db(LA.T.referral).insert({ company_id: cid, ...patch, created_at: now, created_by: actor }); }
        }

        // 6) Product Cashback — £ (multi-row + items)
        {
            const existing = await db(LA.T.product).where('company_id', cid).whereNull('deleted_at').select('id');
            const kept = [];
            for (const r of asRows(b.product)) {
                const pids = idList(r.product_ids);
                if (!pids.length || Number(money(r.cashback)) <= 0) { continue; }
                const id = Number(r.id) || 0;
                let ruleId;
                if (id) {
                    const owned = await db(LA.T.product).where({ id, company_id: cid }).whereNull('deleted_at').first();
                    if (!owned) { continue; }
                    await db(LA.T.product).where('id', id).update({ value_type: '£', cashback: money(r.cashback), updated_at: now, updated_by: actor });
                    ruleId = id;
                } else {
                    const ins = await db(LA.T.product).insert({ company_id: cid, value_type: '£', cashback: money(r.cashback), created_at: now, created_by: actor }).returning('id');
                    ruleId = insertId(ins);
                }
                kept.push(ruleId);
                const exItems = await db(LA.T.productItems).where('product_cashback_rule_id', ruleId).select('id', 'product_id', 'deleted_at');
                const byPid = {}; exItems.forEach((e) => { byPid[Number(e.product_id)] = e; });
                for (const pid of pids) {
                    const e = byPid[pid];
                    if (e) { await db(LA.T.productItems).where('id', e.id).update({ deleted_at: null, deleted_by: null, updated_at: now, updated_by: actor }); }
                    else { await db(LA.T.productItems).insert({ product_cashback_rule_id: ruleId, product_id: pid, created_at: now, created_by: actor }); }
                }
                const keep = new Set(pids);
                const drop = exItems.filter((e) => !e.deleted_at && !keep.has(Number(e.product_id))).map((e) => e.id);
                if (drop.length) { await db(LA.T.productItems).whereIn('id', drop).update({ deleted_at: now, deleted_by: actor }); }
            }
            const del = existing.map((e) => Number(e.id)).filter((x) => !kept.includes(x));
            if (del.length) {
                await db(LA.T.product).whereIn('id', del).update({ deleted_at: now, deleted_by: actor });
                await db(LA.T.productItems).whereIn('product_cashback_rule_id', del).whereNull('deleted_at').update({ deleted_at: now, deleted_by: actor });
            }
        }

        // 7) Order Streak — £ (multi-row)
        {
            const existing = await db(LA.T.orderCashback).where('company_id', cid).whereNull('deleted_at').select('id');
            const kept = [];
            for (const r of asRows(b.streak)) {
                if (!Number(r.order_count) || Number(money(r.cashback)) <= 0) { continue; }
                const patch = {
                    order_count: Number(r.order_count) || 0, type: Number(r.type) === 2 ? 2 : 1,
                    duration_type: Number(r.duration_type) === 2 ? 2 : 1, value_type: '£',
                    cashback: money(r.cashback), min_order_amount: money(r.min_order_amount || 0),
                };
                const id = Number(r.id) || 0;
                if (id) {
                    const owned = await db(LA.T.orderCashback).where({ id, company_id: cid }).whereNull('deleted_at').first();
                    if (owned) { await db(LA.T.orderCashback).where('id', id).update({ ...patch, updated_at: now, updated_by: actor }); kept.push(id); }
                } else {
                    const ins = await db(LA.T.orderCashback).insert({ company_id: cid, ...patch, created_at: now, created_by: actor }).returning('id');
                    kept.push(insertId(ins));
                }
            }
            const del = existing.map((e) => Number(e.id)).filter((x) => !kept.includes(x));
            if (del.length) { await db(LA.T.orderCashback).whereIn('id', del).update({ deleted_at: now, deleted_by: actor }); }
        }

        // 8) Review rewards — £ (8 fixed types)
        for (const t of REVIEW_REWARD_TYPES) {
            const cashback = money(b['review_' + t.id + '_cashback']);
            const ex = await db(LA.T.review).where({ company_id: cid, type: t.id }).whereNull('deleted_at').first();
            if (Number(cashback) <= 0) {
                if (ex) { await db(LA.T.review).where('id', ex.id).update({ deleted_at: now, deleted_by: actor }); }
                continue;
            }
            if (ex) { await db(LA.T.review).where('id', ex.id).update({ value_type: '£', cashback, updated_at: now, updated_by: actor }); }
            else { await db(LA.T.review).insert({ company_id: cid, type: t.id, value_type: '£', cashback, created_at: now, created_by: actor }); }
        }

        // 9) BOGO — (multi-row + buy items)
        {
            const existing = await db(LA.T.bogof).where('company_id', cid).whereNull('deleted_at').select('id');
            const kept = [];
            for (const r of asRows(b.bogof)) {
                const applyOn = Number(r.apply_on) === 2 ? 2 : 1;
                const itemIds = applyOn === 2 ? idList(r.category_ids) : idList(r.product_ids);
                if (!itemIds.length) { continue; }
                const id = Number(r.id) || 0;
                let ruleId;
                const rPatch = { apply_on: applyOn, buy_quantity: Math.max(1, Number(r.buy_quantity) || 0), get_quantity: Math.max(1, Number(r.get_quantity) || 0) };
                if (id) {
                    const owned = await db(LA.T.bogof).where({ id, company_id: cid }).whereNull('deleted_at').first();
                    if (!owned) { continue; }
                    await db(LA.T.bogof).where('id', id).update({ ...rPatch, updated_at: now, updated_by: actor });
                    ruleId = id;
                } else {
                    const ins = await db(LA.T.bogof).insert({ company_id: cid, ...rPatch, created_at: now, created_by: actor }).returning('id');
                    ruleId = insertId(ins);
                }
                kept.push(ruleId);
                const exBuy = await db(LA.T.bogofBuy).where('bogof_rule_id', ruleId).select('id', 'product_id', 'category_id', 'deleted_at');
                const byKey = {}; exBuy.forEach((e) => { byKey[bogofKey(e)] = e; });
                const newKeys = itemIds.map((x) => (applyOn === 2 ? 'c_' : 'p_') + x);
                for (const itemId of itemIds) {
                    const key = (applyOn === 2 ? 'c_' : 'p_') + itemId;
                    const e = byKey[key];
                    if (e) { await db(LA.T.bogofBuy).where('id', e.id).update({ deleted_at: null, deleted_by: null, updated_at: now, updated_by: actor }); }
                    else {
                        const row = { bogof_rule_id: ruleId, created_at: now, created_by: actor };
                        if (applyOn === 2) { row.category_id = itemId; } else { row.product_id = itemId; }
                        await db(LA.T.bogofBuy).insert(row);
                    }
                }
                const keep = new Set(newKeys);
                const drop = exBuy.filter((e) => !e.deleted_at && !keep.has(bogofKey(e))).map((e) => e.id);
                if (drop.length) { await db(LA.T.bogofBuy).whereIn('id', drop).update({ deleted_at: now, deleted_by: actor }); }
            }
            const del = existing.map((e) => Number(e.id)).filter((x) => !kept.includes(x));
            if (del.length) {
                await db(LA.T.bogof).whereIn('id', del).update({ deleted_at: now, deleted_by: actor });
                await db(LA.T.bogofBuy).whereIn('bogof_rule_id', del).whereNull('deleted_at').update({ deleted_at: now, deleted_by: actor });
            }
        }

        // 10) Special Offer — (multi-row)
        {
            const existing = await db(LA.T.specialOffer).where('company_id', cid).whereNull('deleted_at').select('id');
            const kept = [];
            for (const r of asRows(b.special)) {
                if (Number(money(r.cashback)) <= 0) { continue; }
                const patch = { value_type: r.value_type === '%' ? '%' : '£', cashback: money(r.cashback), offer_date: r.offer_date || null };
                const id = Number(r.id) || 0;
                if (id) {
                    const owned = await db(LA.T.specialOffer).where({ id, company_id: cid }).whereNull('deleted_at').first();
                    if (owned) { await db(LA.T.specialOffer).where('id', id).update({ ...patch, updated_at: now, updated_by: actor }); kept.push(id); }
                } else {
                    const ins = await db(LA.T.specialOffer).insert({ company_id: cid, ...patch, created_at: now, created_by: actor }).returning('id');
                    kept.push(insertId(ins));
                }
            }
            const del = existing.map((e) => Number(e.id)).filter((x) => !kept.includes(x));
            if (del.length) { await db(LA.T.specialOffer).whereIn('id', del).update({ deleted_at: now, deleted_by: actor }); }
        }

        // 11) Membership Tiers — (gold max = 0 sentinel)
        for (const type of TIER_TYPES) {
            const patch = {
                min_amount: money(b[type + '_min_amount']),
                max_amount: type === 'gold' ? 0 : money(b[type + '_max_amount']),
                free_delivery_lifetime: truthy(b[type + '_free']),
            };
            const ex = await db(LA.T.tier).where({ company_id: cid, type }).whereNull('deleted_at').first();
            if (ex) { await db(LA.T.tier).where('id', ex.id).update({ ...patch, updated_at: now, updated_by: actor }); }
            else { await db(LA.T.tier).insert({ company_id: cid, type, ...patch, created_at: now, created_by: actor }); }
        }

        // 12) Smart Campaign — (5 fixed types; inactive £/%, rest £)
        for (const type of CAMPAIGN_TYPES) {
            const patch = {
                target_value: Number(b[type + '_target']) || 0,
                value_type: type === 'inactive' ? (b[type + '_vt'] === '%' ? '%' : '£') : '£',
                cashback: money(b[type + '_cashback']),
            };
            const ex = await db(LA.T.campaign).where({ company_id: cid, type }).whereNull('deleted_at').first();
            if (ex) { await db(LA.T.campaign).where('id', ex.id).update({ ...patch, updated_at: now, updated_by: actor }); }
            else { await db(LA.T.campaign).insert({ company_id: cid, type, ...patch, created_at: now, created_by: actor }); }
        }

        return H.successResponse(res, { saved: true }, 'Loyalty configuration saved.');
    } catch (err) {
        console.error('[admin.loyalty.saveAll]', err && err.message);
        return H.errorResponse(res, 'Could not save the loyalty configuration.', 500);
    }
}

module.exports = {
    dashboard, masterToggle, companyConfigSave, saveAll,
    cashbackGet, cashbackUpsert, cashbackDelete, cashbackToggle, configSave,
    tiersGet, tiersSave, tiersToggle,
    referralStreakGet, referralSave, streakUpsert, streakDelete, referralToggle, streakToggle,
    challengesGet, challengesSave, challengesToggle,
    eventsGet, eventsSave, eventsToggle,
    reviewClaimsGet, reviewApprove, reviewReject,
    segmentsGet,
    specialOfferGet, specialOfferUpsert, specialOfferDelete, specialOfferToggle,
    reviewRewardsGet, reviewRewardsSave, reviewRewardsToggle,
    productCashbackGet, productCashbackUpsert, productCashbackDelete, productCashbackToggle,
    bogofGet, bogofUpsert, bogofDelete, bogofToggle,
    cmsPagesGet, cmsPageSave,
};
