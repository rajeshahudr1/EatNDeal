'use strict';

/*
 * Helpers/loyalty.js
 *
 * What:  The marketplace loyalty engine — PHASE 1 (earn + balance + wallet
 *        cards). Per-restaurant "reward cards": one global marketplace
 *        customer earns cashback that is PARTITIONED by company_id, so each
 *        restaurant is a separate card/balance for that one customer.
 *
 *        Reuses the legacy loyalty tables (company_loyalty config +
 *        customer_rewards ledger + admin_reward_commissions) — NO new
 *        tables. Every read/write is scoped to (customer_id, company_id).
 *
 *        Phase 1 earn rule = cash_king: `company_loyalty.cash_king` % of the
 *        order sub-total, minus the admin commission, credited to the
 *        restaurant's card. (Stamps / tiers / event / referral / redeem land
 *        in later phases — earnForOrder is written to extend.)
 *
 *        EVERYTHING is guarded on the legacy tables existing + the
 *        restaurant having loyalty switched on, and earn NEVER throws — a
 *        loyalty hiccup must never block or roll back an order.
 *
 * Used:  OrderController.place (earnForOrder, best-effort after the order
 *        commits) + LoyaltyController (cardsFor / balanceFor).
 *
 * Change log:
 *   2026-06-05 — initial (Phase 1: cash_king earn + wallet cards).
 */

const F = require('./format');
const C = require('./constants');
const H = require('./helper');

const { db } = require('../config/db');
const crypto = require('node:crypto');
const M      = require('./marketplace');
const { sanitizeCmsHtml } = require('./cmsSanitize');

const REWARDS     = 'customer_rewards';
const CONFIG      = 'company_loyalty';
const STREAK_RULE = 'loyalty_order_cashback_rule';
const STREAK_PROG = 'loyalty_order_cashback_progress';

function round2(n) { return F.round2(n); }

// Stable card tint per company (delegates to the shared palette).
function tintFor(id) { return F.tintFor(id); }

// ── Table-exists guard (cached) ─────────────────────────────────────
// Loyalty is opt-in legacy schema; degrade to "no loyalty" when the
// migrations haven't run, rather than erroring.
let _ready = null;
async function isReady() {
    if (_ready !== null) { return _ready; }
    try {
        const r = await db.raw(
            "select to_regclass('public.customer_rewards') as a, to_regclass('public.company_loyalty') as b",
        );
        const row = (r.rows || r)[0] || {};
        _ready = !!(row.a && row.b);
    } catch (e) { _ready = false; }
    return _ready;
}

/**
 * loadConfig
 *
 * What:  A restaurant's loyalty config row — ONLY when loyalty is switched
 *        ON for that company (loyalty_status = 1). null otherwise.
 * Type:  READ.
 */
async function loadConfig(companyId) {
    if (!companyId || !(await isReady())) { return null; }
    const row = await db(CONFIG).where({ company_id: companyId }).first();
    if (!row || Number(row.loyalty_status) !== 1) { return null; }
    return row;
}

/**
 * ruleEnabled
 *
 * What:  Is a given loyalty rule TYPE switched on for the company in the
 *        master `loyalty_rules` table (status = 1, not deleted)? This is the
 *        legacy customerCashback gate — EVERY rule type except cash_king
 *        requires it (CustomerRewards.php: `if (!$rule && ruleType !=
 *        'cash_king') return false`). cash_king is exempt. Best-effort:
 *        false when the table is absent.
 * Type:  READ.
 */
async function ruleEnabled(companyId, ruleType) {
    if (!companyId || !ruleType) { return false; }
    try {
        const row = await db('loyalty_rules')
            .where({ company_id: companyId, rule_type: ruleType, status: 1 })
            .whereNull('deleted_at')
            .first();
        return !!row;
    } catch (e) { return false; }
}

/**
 * earnForOrder
 *
 * What:  Credits the restaurant's reward card after an order. Phase 1 =
 *        cash_king (% of sub-total). Commission is skimmed before the
 *        customer's net amount (mirrors legacy saveReward). Best-effort:
 *        swallows every error so it can NEVER fail the order.
 * Type:  WRITE.
 *
 * Inputs: { customerId, companyId, orderId, subtotal }
 */
async function earnForOrder({ customerId, companyId, orderId, subtotal }) {
    try {
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const sub = Number(subtotal) || 0;
        const cashKing = Number(cfg.cash_king) || 0;
        if (sub <= 0 || cashKing <= 0) { return; }

        const gross = round2(sub * cashKing / 100);
        if (gross <= 0) { return; }

        // Admin commission skim → the customer's net credit.
        const commPct    = Number(cfg.loyalty_commission) || 0;
        const commission = commPct > 0 ? round2(gross * commPct / 100) : 0;
        const net        = round2(gross - commission);
        if (net <= 0) { return; }

        // Expiry / notify from the restaurant's config (0 days = never).
        const days   = Number(cfg.expiry_duration_days) || 0;
        const notify = Number(cfg.notify_before_days) || 0;
        const expiryDate = days > 0 ? new Date(Date.now() + days * 86400000) : null;
        const notifyDate = (days > 0 && notify > 0) ? new Date(Date.now() + (days - notify) * 86400000) : null;

        const inserted = await db(REWARDS).insert({
            uuid:         crypto.randomUUID(),
            company_id:   companyId,
            customer_id:  customerId,
            entity_type:  'cash_king',
            entity_id:    cfg.id,
            related_id:   orderId,
            amount:       net,
            used_amount:  0,
            tier_type:    null,    // normal pool (not a locked stamp)
            is_redeemable: 1,      // immediately usable
            is_expired:   0,
            expiry_date:  expiryDate,
            notify_date:  notifyDate,
            created_at:   db.fn.now(),
            created_by:   customerId,
        }).returning('id');

        const rewardId = inserted && inserted[0] && (inserted[0].id || inserted[0]);
        if (commission > 0 && rewardId) {
            try {
                await db('admin_reward_commissions').insert({
                    customer_reward_id: rewardId,
                    company_id:         companyId,
                    customer_id:        customerId,
                    reward_amount:      gross,
                    commission_percent: commPct,
                    commission_amount:  commission,
                    created_at:         db.fn.now(),
                });
            } catch (e) { /* commission audit is optional */ }
        }
    } catch (e) {
        // Best-effort — loyalty must never block an order.
    }
}

/**
 * linkedCustomerIds
 *
 * What:  The set of customer ids that belong to the SAME PERSON as the given
 *        marketplace customer — matched by MOBILE NUMBER across every company
 *        (marketplace company_id NULL + each restaurant's own POS row
 *        company_id > 0). One mobile = one person: they may have a separate
 *        `customer` row (with its own password) in each restaurant, but their
 *        loyalty follows the number, so we aggregate every row's rewards.
 *
 *        Mobile is the RIGHT key (not email): the marketplace verifies the
 *        number by OTP at sign-up, so linking by it is trustworthy. A customer
 *        with NO mobile yet (e.g. a fresh Google sign-in) links to ONLY their
 *        own id — the moment they add a mobile on My Profile, the next read
 *        auto-picks up their restaurant points.
 *
 *        Computed on EVERY read (no copy / no cache) so the wallet is always
 *        live — this is the "sync on loyalty/checkout open" the product wants.
 * Type:  READ. Returns number[] (always includes the passed id).
 */
async function linkedCustomerIds(customerId) {
    const id = Number(customerId) || 0;
    if (!id) { return []; }
    const me = await db('customer').where({ id }).first('id', 'contact_no', 'country_code');
    if (!me) { return []; }
    const contact = String(me.contact_no || '').trim();
    if (!contact) { return [id]; }   // no mobile yet → only their own points

    let q = db('customer').where('contact_no', contact);
    // country_code is INTEGER in the schema; match it too when we have one so
    // the same local number in a different country stays separate.
    if (me.country_code != null && me.country_code !== '') { q = q.andWhere('country_code', me.country_code); }
    const rows = await q.select('id');

    const ids = rows.map((r) => Number(r.id));
    if (!ids.includes(id)) { ids.push(id); }
    return ids;
}

/**
 * balanceFor
 *
 * What:  The usable balance on ONE restaurant's card (not expired, not
 *        fully used). £, 2-dp. Aggregated across ALL of the person's
 *        mobile-linked accounts (see linkedCustomerIds).
 * Type:  READ.
 */
async function balanceFor(customerId, companyId) {
    if (!customerId || !companyId || !(await isReady())) { return 0; }
    const ids = await linkedCustomerIds(customerId);
    if (!ids.length) { return 0; }
    const row = await db(REWARDS)
        // is_redeemable = 1 only — LOCKED stamp rewards (is_redeemable = 0)
        // aren't spendable yet, so they don't count toward the balance.
        .whereIn('customer_id', ids)
        .andWhere({ company_id: companyId, is_expired: 0, is_redeemable: 1 })
        .andWhere(function () {
            this.whereNull('expiry_date').orWhere('expiry_date', '>=', db.fn.now());
        })
        .select(db.raw('COALESCE(SUM(amount - COALESCE(used_amount,0)), 0) as bal'))
        .first();
    return round2(row && row.bal);
}

/**
 * cardsFor
 *
 * What:  The customer's reward-card wallet — one card per restaurant they've
 *        earned anything at, with its live balance + lifetime earned/used.
 *        Newest-active first. Each card carries enough to render + link to
 *        the restaurant.
 * Type:  READ.
 *
 * Output: [ { companyId, name, slug, initial, tint, balance, earned, used } ]
 */
async function cardsFor(customerId) {
    if (!customerId || !(await isReady())) { return []; }
    const ids = await linkedCustomerIds(customerId);
    if (!ids.length) { return []; }
    const rows = await db(REWARDS + ' as cr')
        // INNER join + eligibility → only restaurants that are LIVE on the
        // marketplace (active, not deleted, not in maintenance) show a card.
        // Points at a restaurant that isn't on the marketplace are hidden
        // (the customer can't order there to redeem them anyway).
        .innerJoin('company as c', 'c.id', 'cr.company_id')
        .whereIn('cr.customer_id', ids)
        .modify((qb) => M.eligibleCompanyScope(qb, 'c'))
        .groupBy('cr.company_id', 'c.business_name', 'c.domain_name')
        .havingRaw('SUM(cr.amount) > 0')
        .select(
            'cr.company_id',
            'c.business_name',
            'c.domain_name',
            db.raw("COALESCE(SUM(CASE WHEN cr.is_expired = 0 AND cr.is_redeemable = 1 AND (cr.expiry_date IS NULL OR cr.expiry_date >= NOW()) THEN cr.amount - COALESCE(cr.used_amount,0) ELSE 0 END), 0) as balance"),
            db.raw('COALESCE(SUM(cr.amount), 0) as earned'),
            db.raw('COALESCE(SUM(cr.used_amount), 0) as used'),
            db.raw('MAX(cr.created_at) as last_at'),
        )
        .orderBy('balance', 'desc')
        .orderBy('last_at', 'desc');

    return rows.map((r) => {
        const name = String(r.business_name || '').trim() || 'Restaurant';
        return {
            companyId: String(r.company_id),
            name,
            slug:      r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
            initial:   name.charAt(0).toUpperCase(),
            tint:      tintFor(r.company_id),
            balance:   round2(r.balance),
            earned:    round2(r.earned),
            used:      round2(r.used),
        };
    });
}

// Friendly labels for the customer_rewards.entity_type values.
const REWARD_TYPE_LABELS = {
    cash_king:           'Cashback',
    cashback:            'Cashback',
    product_cashback:    'Product cashback',
    collection_cashback: 'Collection cashback',
    referral:            'Referral bonus',
    event_cashback:      'Bonus',
    special_offer:       'Special offer',
    smart_campaign:      'Campaign reward',
    product_streak:      'Streak reward',
};
// Lifecycle status of one reward row (mirrors the legacy expired_from logic).
function rewardStatus(r) {
    const ef = Number(r.expired_from) || 0;
    if (ef === 2) { return 'reversed'; }
    if (Number(r.is_expired) === 1 && (ef === 1 || ef === 4)) { return 'expired'; }
    if (ef === 3 || (Number(r.used_amount) > 0 && Number(r.used_amount) >= Number(r.amount))) { return 'redeemed'; }
    return 'earned';
}

/**
 * historyFor
 *
 * What:  A customer's reward transaction history (the customer_rewards ledger)
 *        — one row per earn event with its used amount, status and expiry.
 *        Optionally scoped to ONE restaurant. Plus the wallet TOTALS (earned /
 *        available / used / expired) for the same scope. Newest first.
 * Type:  READ.
 *
 * Inputs: customerId, { companyId?, filter? (''|earned|redeemed|expired|reversed),
 *                       limit (1..100), offset }
 * Output: { totals: { available, earned, used, expired },
 *           transactions: [{ id, date, companyId, restaurant, entity_type,
 *                            type_label, earned, used, status, expiry_date }],
 *           total_count }
 */
async function historyFor(customerId, opts) {
    const o = opts || {};
    const companyId = Number(o.companyId) || 0;
    const filter = String(o.filter || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(o.limit) || 50));
    const offset = Math.max(0, Number(o.offset) || 0);
    if (!customerId || !(await isReady())) { return { totals: { available: 0, earned: 0, used: 0, expired: 0 }, transactions: [], total_count: 0 }; }
    const ids = await linkedCustomerIds(customerId);
    if (!ids.length) { return { totals: { available: 0, earned: 0, used: 0, expired: 0 }, transactions: [], total_count: 0 }; }

    // Wallet totals for the scope (unaffected by the status filter / paging).
    // Aggregated across the person's mobile-linked accounts, and only for
    // restaurants that are LIVE on the marketplace.
    let tq = db(REWARDS + ' as cr')
        .innerJoin('company as c', 'c.id', 'cr.company_id')
        .whereIn('cr.customer_id', ids)
        .modify((qb) => M.eligibleCompanyScope(qb, 'c'));
    if (companyId) { tq = tq.where('cr.company_id', companyId); }
    const t = await tq.select(
        db.raw('COALESCE(SUM(cr.amount), 0) as earned'),
        db.raw('COALESCE(SUM(COALESCE(cr.used_amount,0)), 0) as used'),
        db.raw('COALESCE(SUM(CASE WHEN cr.is_expired = 1 THEN cr.amount - COALESCE(cr.used_amount,0) ELSE 0 END), 0) as expired'),
        db.raw('COALESCE(SUM(CASE WHEN cr.is_expired = 0 AND cr.is_redeemable = 1 AND (cr.expiry_date IS NULL OR cr.expiry_date >= NOW()) THEN cr.amount - COALESCE(cr.used_amount,0) ELSE 0 END), 0) as available'),
    ).first();
    const totals = {
        available: round2(t && t.available),
        earned:    round2(t && t.earned),
        used:      round2(t && t.used),
        expired:   round2(t && t.expired),
    };

    // Filtered, paginated history rows.
    const base = () => {
        let q = db(REWARDS + ' as cr')
            .innerJoin('company as c', 'c.id', 'cr.company_id')
            .whereIn('cr.customer_id', ids)
            .modify((qb) => M.eligibleCompanyScope(qb, 'c'));
        if (companyId) { q = q.where('cr.company_id', companyId); }
        if (filter === 'earned')   { q = q.where('cr.is_expired', 0).where('cr.expired_from', 0); }
        else if (filter === 'redeemed') { q = q.where('cr.expired_from', 3); }
        else if (filter === 'expired')  { q = q.where('cr.is_expired', 1).whereIn('cr.expired_from', [1, 4]); }
        else if (filter === 'reversed') { q = q.where('cr.expired_from', 2); }
        return q;
    };
    const cnt = await base().count('cr.id as n').first();
    const rows = await base()
        .select('cr.id', 'cr.company_id', 'c.business_name', 'cr.entity_type', 'cr.amount',
                'cr.used_amount', 'cr.is_expired', 'cr.expired_from', 'cr.is_redeemable',
                'cr.expiry_date', 'cr.created_at')
        .orderBy('cr.id', 'desc').limit(limit).offset(offset);

    const transactions = rows.map((r) => {
        const name = String(r.business_name || '').trim() || 'Restaurant';
        return {
            id:          Number(r.id),
            date:        r.created_at,
            companyId:   String(r.company_id),
            restaurant:  name,
            entity_type: r.entity_type || '',
            type_label:  REWARD_TYPE_LABELS[r.entity_type] || 'Cashback',
            earned:      round2(r.amount),
            used:        round2(r.used_amount),
            status:      rewardStatus(r),
            expiry_date: r.expiry_date || null,
        };
    });
    return { totals, transactions, total_count: Number(cnt && cnt.n) || 0 };
}

// ── Review / share cashback types (mirror the admin REVIEW_CMS_TYPES +
//    REVIEW_REWARD_TYPES; menu:false types are hidden from the customer). ──
const REVIEW_TYPES = C.REVIEW_TYPES;
const REVIEW_STATUS_LBL = C.REVIEW_STATUSES.byCode;
function cmsShotUrl(companyId, file) {
    const f = String(file || '').trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.charAt(0) === '/') { return f; }
    const base = H.getUploadsBaseUrl();
    return base + '/' + companyId + '/loyalty/' + f;
}
async function reviewMasterOn(companyId) {
    if (!companyId) { return false; }
    const r = await db('loyalty_rules').where({ company_id: companyId, rule_type: 'review' }).whereNull('deleted_at').first('status');
    return !!(r && Number(r.status) === 1);
}

/**
 * reviewTypesFor
 *
 * What:  The review / share cashback types a restaurant offers, each with its
 *        admin CMS content (title + HTML instructions + example screenshot),
 *        reward amount, and the customer's current claim status (pending /
 *        approved / rejected). Only menu types WITH a configured reward (and
 *        only when the restaurant's review-rewards master is ON). Type: READ.
 */
async function reviewTypesFor(companyId, customerId) {
    const cid = Number(companyId) || 0;
    if (!cid) { return { company: null, masterOn: false, types: [] }; }
    const co = await db('company').where('id', cid).first('id', 'business_name', 'domain_name');
    const masterOn = await reviewMasterOn(cid);
    const rules = await db('loyalty_review_cashback_rule').where('company_id', cid).whereNull('deleted_at').andWhere('cashback', '>', 0).select('type', 'value_type', 'cashback');
    const ruleBy = {}; rules.forEach((r) => { ruleBy[Number(r.type)] = { cashback: round2(r.cashback), value_type: r.value_type || '£' }; });
    const cms = await db('loyalty_cms_pages').where('company_id', cid).select('review_type_slug', 'title', 'description', 'screenshot');
    const cmsBy = {}; cms.forEach((c) => { cmsBy[c.review_type_slug] = c; });
    const claimBy = {};
    if (customerId) {
        const claims = await db('customer_review').where({ company_id: cid, customer_id: customerId }).select('review_type', 'admin_status', 'reject_reason');
        claims.forEach((c) => { claimBy[Number(c.review_type)] = c; });
    }
    const types = (masterOn ? REVIEW_TYPES.filter((t) => t.menu && ruleBy[t.id]) : []).map((t) => {
        const rule = ruleBy[t.id];
        const cmsRow = cmsBy[t.slug] || {};
        const claim = claimBy[t.id];
        return {
            id: t.id, slug: t.slug, name: t.name, icon: t.icon, video: t.video,
            reward: rule.cashback, value_type: rule.value_type,
            title: cmsRow.title || t.name,
            description: cmsRow.description ? sanitizeCmsHtml(cmsRow.description) : '',
            screenshot_url: cmsShotUrl(cid, cmsRow.screenshot),
            status: claim ? (REVIEW_STATUS_LBL[Number(claim.admin_status)] || 'pending') : '',
            reject_reason: (claim && Number(claim.admin_status) === 2) ? (claim.reject_reason || '') : '',
        };
    });
    const name = (co && co.business_name) || 'Restaurant';
    return {
        company: co ? { id: Number(co.id), name, slug: co.domain_name ? M.slugify(co.domain_name) : M.slugify(name, co.id) } : null,
        masterOn, types,
    };
}

/**
 * reviewRestaurants — marketplace restaurants currently offering review
 * cashback (review master ON + at least one rule with cashback > 0). Used by
 * the /earn picker when no restaurant is chosen yet. Type: READ.
 */
async function reviewRestaurants() {
    const rows = await db('loyalty_review_cashback_rule as r')
        .join('company as c', 'c.id', 'r.company_id')
        .whereNull('r.deleted_at').andWhere('r.cashback', '>', 0)
        // Count only the customer-facing (menu) review types, so the picker's
        // "up to £X / N ways" matches what the customer can actually claim.
        .whereIn('r.type', C.REVIEW_TYPES.filter((t) => t.menu).map((t) => t.id))
        .andWhere('c.is_marketplace', 1).andWhere('c.is_active', 1).whereNull('c.deleted_at')
        .whereExists(function () {
            this.select(db.raw('1')).from('loyalty_rules as lr')
                .whereRaw('lr.company_id = r.company_id').andWhere('lr.rule_type', 'review').andWhere('lr.status', 1).whereNull('lr.deleted_at');
        })
        .groupBy('c.id', 'c.business_name', 'c.domain_name')
        .select('c.id', 'c.business_name', 'c.domain_name', db.raw('MAX(r.cashback) as max_reward'), db.raw('COUNT(DISTINCT r.type) as type_count'))
        .orderBy('c.business_name', 'asc').limit(100);
    return rows.map((r) => {
        const name = r.business_name || 'Restaurant';
        return { companyId: String(r.id), name, slug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.id), maxReward: round2(r.max_reward), typeCount: Number(r.type_count) || 0 };
    });
}

/**
 * maxRedeemable
 *
 * What:  The most cashback a customer may spend on ONE order at this
 *        restaurant. Legacy cap = MIN(usable balance, sub_total,
 *        use_max_cashback) — where use_max_cashback is treated as "no cap"
 *        when empty/0 (matches the PHP `!empty()` check). 0 when loyalty is
 *        off / no balance / empty cart.
 * Type:  READ.
 *
 * Inputs: { customerId, companyId, subTotal }
 */
async function maxRedeemable({ customerId, companyId, subTotal }) {
    if (!customerId || !companyId) { return 0; }
    const cfg = await loadConfig(companyId);        // null ⇒ loyalty off
    if (!cfg) { return 0; }
    const sub = Number(subTotal) || 0;
    if (sub <= 0) { return 0; }
    const bal = await balanceFor(customerId, companyId);
    if (bal <= 0) { return 0; }

    let max = Math.min(bal, sub);
    const flatCap = Number(cfg.use_max_cashback) || 0;   // 0 = no cap (legacy)
    if (flatCap > 0) { max = Math.min(max, flatCap); }
    return round2(Math.max(0, max));
}

/**
 * consumeForRedeem
 *
 * What:  Spends `amount` of the customer's reward balance at this restaurant
 *        against an order — the WRITE half of redeem. Consumes
 *        customer_rewards rows FIFO (oldest id first), locked FOR UPDATE so
 *        two concurrent checkouts can't double-spend the same balance.
 *        Mirrors legacy saveOrder:
 *          • increments each row's used_amount up to its remaining balance
 *          • a fully-consumed row → is_expired = 1, expired_from = 3 (used)
 *          • writes ONE customer_used_rewards ledger row (the JSON breakdown
 *            is what reverseForOrder reads to un-spend on cancel)
 *        Runs INSIDE the order-place transaction (pass its trx) so a
 *        rolled-back order never burns cashback.
 * Type:  WRITE (transactional — caller's trx).
 *
 * Inputs: trx, { customerId, companyId, orderId, amount }
 * Output: { consumed, breakdown }  (consumed may be < amount if the live
 *          balance fell short — caller decides whether to roll back).
 */
async function consumeForRedeem(trx, { customerId, companyId, orderId, amount }) {
    const want = round2(amount);
    if (!trx || !customerId || !companyId || want <= 0) { return { consumed: 0, breakdown: [] }; }

    // Spend across ALL of the person's mobile-linked accounts at this
    // restaurant (same person, one number). FIFO by reward id (oldest first),
    // only live + redeemable + with remaining balance.
    const ids = await linkedCustomerIds(customerId);
    if (!ids.length) { return { consumed: 0, breakdown: [] }; }
    const rows = await trx(REWARDS)
        .whereIn('customer_id', ids)
        .andWhere({ company_id: companyId, is_expired: 0, is_redeemable: 1 })
        .andWhere(function () {
            this.whereNull('expiry_date').orWhere('expiry_date', '>=', db.fn.now());
        })
        .andWhereRaw('amount > COALESCE(used_amount, 0)')
        .orderBy('id', 'asc')
        .forUpdate();

    let remaining = want;
    const breakdown = [];
    for (const r of rows) {
        if (remaining <= 0) { break; }
        const already = Number(r.used_amount) || 0;
        const total   = Number(r.amount) || 0;
        const avail   = round2(total - already);
        if (avail <= 0) { continue; }

        const take    = round2(Math.min(remaining, avail));
        const newUsed = round2(already + take);
        const patch   = { used_amount: newUsed };
        if (newUsed >= total) { patch.is_expired = 1; patch.expired_from = 3; }   // 3 = used
        await trx(REWARDS).where({ id: r.id }).update(patch);

        breakdown.push({
            reward_id:    r.id,
            entity_type:  r.entity_type,
            entity_id:    r.entity_id,
            total_amount: total,
            before_used:  already,
            used_amount:  take,
        });
        remaining = round2(remaining - take);
    }

    const consumed = round2(want - remaining);
    // Ledger — NOT swallowed: if this insert throws, the whole order
    // transaction rolls back (we never want consumed rows without a ledger,
    // because reverseForOrder relies on it to un-spend on cancel).
    if (consumed > 0 && orderId) {
        await trx('customer_used_rewards').insert({
            company_id:      companyId,
            customer_id:     customerId,
            order_id:        orderId,
            used_amount:     consumed,
            related_json:    JSON.stringify(breakdown),
            order_cancelled: 0,
            created_at:      db.fn.now(),
            created_by:      customerId,
        });
    }
    return { consumed, breakdown };
}

/**
 * reverseForOrder
 *
 * What:  Undoes an order's loyalty when it is cancelled/refunded:
 *          1. RESTORES spent cashback — reads the customer_used_rewards
 *             ledger, decrements each consumed row's used_amount back, and
 *             un-expires rows that had been fully-used (expired_from = 3).
 *             (Legacy never did this — it's the fair fix for the customer.)
 *          2. EXPIRES earned cashback — every reward EARNED on this order
 *             (related_id = orderId) → is_expired = 1, expired_from = 2
 *             (order cancelled). Mirrors legacy expiredLoyaltyCashback.
 *          3. Marks the ledger order_cancelled = 1 (idempotent — a second
 *             call finds nothing to restore).
 *        Self-transactional. Best-effort guard on the tables existing.
 * Type:  WRITE (transactional).
 *
 * NOTE: not yet wired — the marketplace has no Node cancel endpoint; legacy
 *       POS cancellation runs its own (earned-only) expiry. Call this from a
 *       future /order/cancel so marketplace redeems are restored.
 */
async function reverseForOrder(orderId) {
    if (!orderId || !(await isReady())) { return { restored: 0, expiredEarned: 0 }; }
    return db.transaction(async (trx) => {
        let restored = 0;
        const ledgers = await trx('customer_used_rewards')
            .where({ order_id: orderId, order_cancelled: 0 })
            .forUpdate();

        for (const L of ledgers) {
            let entries = [];
            try { entries = JSON.parse(L.related_json || '[]'); } catch (e) { entries = []; }
            for (const e of (Array.isArray(entries) ? entries : [])) {
                const rid  = e && e.reward_id;
                const back = round2(e && e.used_amount);
                if (!rid || back <= 0) { continue; }
                const row = await trx(REWARDS).where({ id: rid }).first();
                if (!row) { continue; }
                const newUsed = round2(Math.max(0, (Number(row.used_amount) || 0) - back));
                const patch   = { used_amount: newUsed };
                if (Number(row.is_expired) === 1 && Number(row.expired_from) === 3
                    && newUsed < (Number(row.amount) || 0)) {
                    patch.is_expired   = 0;
                    patch.expired_from = null;
                }
                await trx(REWARDS).where({ id: rid }).update(patch);
                restored = round2(restored + back);
            }
            await trx('customer_used_rewards').where({ id: L.id }).update({ order_cancelled: 1 });
        }

        const expiredEarned = await trx(REWARDS)
            .where({ related_id: orderId, is_expired: 0 })
            .update({ is_expired: 1, expired_from: 2 });

        return { restored, expiredEarned };
    });
}

// ── Date helpers for the order-streak window logic (local Y-m-d, to
//    mirror the legacy PHP date() comparisons exactly) ────────────────
function fmtDate(d) {
    return F.formatDateIso(d);
}
function mondayThisWeek() {
    const n = new Date();
    const dow = (n.getDay() + 6) % 7;   // 0 = Monday
    return fmtDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() - dow));
}
function firstOfMonth() {
    const n = new Date();
    return fmtDate(new Date(n.getFullYear(), n.getMonth(), 1));
}
function lastOfMonth() {
    const n = new Date();
    return fmtDate(new Date(n.getFullYear(), n.getMonth() + 1, 0));
}
function dayDiffStr(aStr, bStr) {   // a − b in whole days
    return Math.floor((Date.parse(aStr + 'T00:00:00Z') - Date.parse(bStr + 'T00:00:00Z')) / 86400000);
}

// Upsert one loyalty_order_cashback_progress row.
async function saveStreakProgress(prog, isNew, userId) {
    if (isNew) {
        await db(STREAK_PROG).insert({
            company_id:      prog.company_id,
            customer_id:     prog.customer_id,
            rule_id:         prog.rule_id,
            current_streak:  prog.current_streak,
            reward_ready:    prog.reward_ready,
            last_order_date: prog.last_order_date,
            created_at:      db.fn.now(),
            updated_at:      db.fn.now(),
            created_by:      userId,
            updated_by:      userId,
        });
    } else {
        await db(STREAK_PROG).where({ id: prog.id }).update({
            current_streak:  prog.current_streak,
            reward_ready:    prog.reward_ready,
            last_order_date: prog.last_order_date,
            updated_at:      db.fn.now(),
            updated_by:      userId,
        });
    }
}

/**
 * earnOrderStreak
 *
 * What:  The legacy "product_streak" earn rule, ported EXACTLY from
 *        webordering (CustomerRewards::customerCashback ruleType
 *        'product_streak'). A reward is given for a run of qualifying orders
 *        at a restaurant:
 *          • type 1 = STREAK — same/next-day orders build current_streak;
 *            a >1-day gap resets it. Reaching order_count flags reward_ready;
 *            the NEXT qualifying order awards (deferred) + restarts at 1.
 *          • type 2 = MILESTONE — counts completed orders in the week/month
 *            window; awards when count crosses each multiple of the target.
 *        Weekly (duration_type 1) / monthly (2) windows reset progress.
 *        min_order_amount gates (and zeroes progress on a too-small order).
 *        Idempotent per (rule, order). Commission is skimmed like cash_king.
 *        Best-effort — never throws, never blocks an order.
 * Type:  WRITE.
 *
 * Inputs: { customerId, companyId, orderId, subtotal }
 */
async function earnOrderStreak({ customerId, companyId, orderId, subtotal }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        // Master gate — product_streak must be switched on in loyalty_rules
        // (exactly like legacy customerCashback). Off ⇒ no award.
        if (!(await ruleEnabled(companyId, 'product_streak'))) { return; }
        const cfg = await loadConfig(companyId);              // loyalty_status = 1 gate
        if (!cfg) { return; }

        const rules = await db(STREAK_RULE)
            .where({ company_id: companyId })
            .whereNull('deleted_at')
            .orderBy('order_count', 'desc');
        if (!rules.length) { return; }

        const orderAmount = Number(subtotal) || 0;
        const today = fmtDate(new Date());
        let matchedRule = null;

        for (const row of rules) {
            const durType = Number(row.duration_type);
            let startDate;
            if (durType === 1)      { startDate = fmtDate(new Date(Date.now() - 7 * 86400000)) + ' 00:00:00'; }
            else if (durType === 2) { startDate = firstOfMonth() + ' 00:00:00'; }
            else { continue; }

            // Below the rule's minimum → this order doesn't count; zero progress.
            if (orderAmount < (Number(row.min_order_amount) || 0)) {
                await db(STREAK_PROG)
                    .where({ company_id: companyId, customer_id: customerId, rule_id: row.id })
                    .update({ current_streak: 0, reward_ready: 0 });
                continue;
            }

            const target = parseInt(row.order_count, 10) || 0;

            // ── type 1: STREAK ──────────────────────────────────────
            if (Number(row.type) === 1) {
                let prog = await db(STREAK_PROG)
                    .where({ company_id: companyId, customer_id: customerId, rule_id: row.id })
                    .first();
                const isNew = !prog;
                if (!prog) {
                    prog = {
                        company_id: companyId, customer_id: customerId, rule_id: row.id,
                        current_streak: 0, reward_ready: 0, last_order_date: null,
                    };
                }

                // Weekly / monthly window elapsed → reset.
                const last = fmtDate(prog.last_order_date);
                if (last) {
                    if (durType === 1 && last < mondayThisWeek()) { prog.current_streak = 0; prog.reward_ready = 0; }
                    if (durType === 2 && last < firstOfMonth())   { prog.current_streak = 0; prog.reward_ready = 0; }
                }

                // Previous streak completed → award on THIS order, restart at 1.
                if (Number(prog.reward_ready) === 1) {
                    matchedRule = row;
                    prog.reward_ready = 0;
                    prog.current_streak = 1;
                    prog.last_order_date = today;
                    await saveStreakProgress(prog, isNew, customerId);
                    break;
                }

                // Otherwise advance the counter.
                if (!last) {
                    prog.current_streak = 1;
                } else {
                    const dd = dayDiffStr(today, last);
                    if (dd === 0 || dd === 1) { prog.current_streak = (Number(prog.current_streak) || 0) + 1; }
                    else { prog.current_streak = 1; }
                }
                if ((Number(prog.current_streak) || 0) >= target) { prog.reward_ready = 1; }
                prog.last_order_date = today;
                await saveStreakProgress(prog, isNew, customerId);
            }

            // ── type 2: MILESTONE ───────────────────────────────────
            if (Number(row.type) === 2) {
                const endDate = lastOfMonth() + ' 23:59:59';
                const cntRow = await db('orders')
                    .where({ company_id: companyId, user_id: customerId, status: '1', order_status: '' })
                    .andWhereBetween('created_at', [startDate, endDate])
                    .andWhere('sub_total', '>=', Number(row.min_order_amount) || 0)
                    .count({ c: '*' }).first();
                const cnt = Number(cntRow && cntRow.c) || 0;
                if (cnt > target && ((cnt - 1) % target === 0)) { matchedRule = row; break; }
            }
        }

        if (!matchedRule) { return; }

        // Idempotency — never reward the same (rule, order) twice.
        const already = await db(REWARDS).where({
            company_id: companyId, customer_id: customerId,
            entity_type: 'product_streak', entity_id: matchedRule.id, related_id: orderId,
        }).first();
        if (already) { return; }

        let amount = Number(matchedRule.cashback) || 0;
        if (String(matchedRule.value_type) === '%') {
            amount = orderAmount * (Number(matchedRule.cashback) || 0) / 100;
        }
        amount = round2(amount);
        if (amount <= 0) { return; }

        // Commission skim (mirrors legacy saveReward).
        const commPct    = Number(cfg.loyalty_commission) || 0;
        const commission = commPct > 0 ? round2(amount * commPct / 100) : 0;
        const net        = round2(amount - commission);
        if (net <= 0) { return; }

        const days       = Number(cfg.expiry_duration_days) || 0;
        const expiryDate = days > 0 ? new Date(Date.now() + days * 86400000) : null;

        const inserted = await db(REWARDS).insert({
            uuid:         crypto.randomUUID(),
            company_id:   companyId,
            customer_id:  customerId,
            entity_type:  'product_streak',
            entity_id:    matchedRule.id,
            related_id:   orderId,
            amount:       net,
            used_amount:  0,
            tier_type:    null,
            is_redeemable: 1,   // spendable balance (our redeem gates on is_redeemable=1)
            is_expired:   0,
            expiry_date:  expiryDate,
            notify_date:  null,
            json_data:    JSON.stringify(matchedRule),
            created_at:   db.fn.now(),
            created_by:   customerId,
        }).returning('id');

        const rewardId = inserted && inserted[0] && (inserted[0].id || inserted[0]);
        if (commission > 0 && rewardId) {
            try {
                await db('admin_reward_commissions').insert({
                    customer_reward_id: rewardId,
                    company_id:         companyId,
                    customer_id:        customerId,
                    reward_amount:      amount,
                    commission_percent: commPct,
                    commission_amount:  commission,
                    created_at:         db.fn.now(),
                });
            } catch (e) { /* commission audit is optional */ }
        }
    } catch (e) {
        // Best-effort — loyalty must never block an order.
    }
}

/**
 * streakProgressFor
 *
 * What:  The customer's live order-streak status at a restaurant, for the
 *        UI ("1 more order → £5" / "Reward ready"). Picks the top rule
 *        (highest order_count). null when loyalty off / no rule.
 * Type:  READ.
 *
 * Output: { target, current, ready, remaining, valueType, cashback, rewardLabel } | null
 */
async function streakProgressFor(customerId, companyId) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return null; }
        if (!(await ruleEnabled(companyId, 'product_streak'))) { return null; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return null; }
        const rule = await db(STREAK_RULE)
            .where({ company_id: companyId }).whereNull('deleted_at')
            .orderBy('order_count', 'desc').first();
        if (!rule) { return null; }

        const prog = await db(STREAK_PROG)
            .where({ company_id: companyId, customer_id: customerId, rule_id: rule.id }).first();
        const target  = parseInt(rule.order_count, 10) || 0;
        const current = prog ? (Number(prog.current_streak) || 0) : 0;
        const ready   = prog ? Number(prog.reward_ready) === 1 : false;
        const cashback = round2(rule.cashback);
        const isPct    = String(rule.value_type) === '%';
        return {
            target,
            current,
            ready,
            remaining:   ready ? 0 : Math.max(0, target - current),
            valueType:   String(rule.value_type),
            cashback,
            rewardLabel: isPct ? (cashback + '%') : ('£' + cashback.toFixed(2)),
        };
    } catch (e) { return null; }
}

/**
 * award
 *
 * What:  Shared "give a reward" write — mirrors legacy CustomerRewards::
 *        saveReward. Skims the company loyalty_commission %, inserts the
 *        customer_rewards row, and (when commission > 0) the
 *        admin_reward_commissions audit row. Returns the new reward id (or
 *        false). Caller passes the already-resolved config to avoid a re-read.
 * Type:  WRITE.
 *
 * opts: { companyId, customerId, entityType, entityId, relatedId, amount,
 *         tierType?, isRedeemable?=1, jsonData?, expiryDays?=cfg, cfg }
 */
async function award(opts) {
    const cfg = opts.cfg || await loadConfig(opts.companyId);
    if (!cfg) { return false; }
    const gross = round2(opts.amount);
    if (gross <= 0) { return false; }

    const commPct    = Number(cfg.loyalty_commission) || 0;
    const commission = commPct > 0 ? round2(gross * commPct / 100) : 0;
    const net        = round2(gross - commission);
    if (net <= 0) { return false; }

    const days = (opts.expiryDays != null)
        ? Number(opts.expiryDays)
        : (Number(cfg.expiry_duration_days) || 0);
    const expiryDate = days > 0 ? new Date(Date.now() + days * 86400000) : null;

    const inserted = await db(REWARDS).insert({
        uuid:          crypto.randomUUID(),
        company_id:    opts.companyId,
        customer_id:   opts.customerId,
        entity_type:   opts.entityType,
        entity_id:     opts.entityId != null ? opts.entityId : null,
        related_id:    opts.relatedId != null ? opts.relatedId : null,
        amount:        net,
        used_amount:   0,
        tier_type:     opts.tierType != null ? opts.tierType : null,
        is_redeemable: opts.isRedeemable != null ? opts.isRedeemable : 1,
        is_expired:    0,
        expiry_date:   expiryDate,
        notify_date:   null,
        json_data:     opts.jsonData != null ? JSON.stringify(opts.jsonData) : null,
        created_at:    db.fn.now(),
        created_by:    opts.customerId,
    }).returning('id');

    const rewardId = inserted && inserted[0] && (inserted[0].id || inserted[0]);
    if (commission > 0 && rewardId) {
        try {
            await db('admin_reward_commissions').insert({
                customer_reward_id: rewardId,
                company_id:         opts.companyId,
                customer_id:        opts.customerId,
                reward_amount:      gross,
                commission_percent: commPct,
                commission_amount:  commission,
                created_at:         db.fn.now(),
            });
        } catch (e) { /* audit row optional */ }
    }
    return rewardId || true;
}

/**
 * getCustomerTier
 *
 * What:  The customer's membership tier at a restaurant, by lifetime spend
 *        on completed orders (status='1', order_status='' = completed),
 *        excluding the current order. 'bronze' when no tier matches. Mirrors
 *        legacy CustomerRewards::getCustomerTier — used by the stamp-card.
 * Type:  READ.
 */
async function getCustomerTier(companyId, customerId, excludeOrderId) {
    let q = db('orders').where({ company_id: companyId, user_id: customerId, status: '1', order_status: '' });
    if (excludeOrderId) { q = q.andWhere('id', '!=', excludeOrderId); }
    const row = await q.sum({ s: 'sub_total' }).first();
    const totalSpent = Number(row && row.s) || 0;

    const tier = await db('loyalty_membership_tier')
        .where({ company_id: companyId }).whereNull('deleted_at')
        .andWhere('min_amount', '<=', totalSpent)
        .andWhereRaw('(max_amount = 0 OR max_amount >= ?)', [totalSpent])
        .orderBy('min_amount', 'desc').first();
    return tier ? tier.type : 'bronze';
}

/**
 * earnStampCashback
 *
 * What:  Legacy "cashback" rule (stamp card) — ported exactly. Each
 *        qualifying order drops a LOCKED stamp (is_redeemable=0, tier_type =
 *        the customer's tier) sized by the tier's LoyaltyCashbackRule. Every
 *        `order_count` stamps, the oldest N locked stamps UNLOCK
 *        (is_redeemable=1) so they become spendable. Master-gated.
 * Type:  WRITE. Best-effort.
 */
async function earnStampCashback({ customerId, companyId, orderId, subtotal }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'cashback'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const amt = Number(subtotal) || 0;
        if (amt <= 0) { return; }

        const tier = await getCustomerTier(companyId, customerId, orderId);
        const rule = await db('loyalty_cashback_rule')
            .where({ company_id: companyId, tier_type: tier }).whereNull('deleted_at')
            .andWhere('min_order_amount', '<=', amt)
            .orderBy('min_order_amount', 'desc').first();
        if (!rule) { return; }

        let amount = Number(rule.cashback) || 0;
        if (String(rule.value_type) === '%') { amount = round2(amt * (Number(rule.cashback) || 0) / 100); }
        if (amount <= 0) { return; }

        // Locked stamp (expiry null, like legacy).
        await award({
            companyId, customerId, entityType: 'cashback',
            entityId: rule.id, relatedId: orderId, amount,
            tierType: rule.tier_type, isRedeemable: 0, jsonData: rule, expiryDays: 0, cfg,
        });

        // Unlock the oldest N locked stamps whenever the stamp count crosses
        // a multiple of the rule's order_count.
        const requiredCount = parseInt(rule.order_count, 10) || 0;
        if (requiredCount > 0) {
            const cntRow = await db(REWARDS)
                .where({ customer_id: customerId, company_id: companyId })
                .whereNotNull('tier_type').count({ c: '*' }).first();
            const total = Number(cntRow && cntRow.c) || 0;
            if (total > 0 && total % requiredCount === 0) {
                const locked = await db(REWARDS)
                    .where({ customer_id: customerId, company_id: companyId, is_expired: 0, is_redeemable: 0 })
                    .whereNotNull('tier_type').orderBy('id', 'asc').limit(requiredCount);
                for (const lr of locked) {
                    await db(REWARDS).where({ id: lr.id }).update({ is_redeemable: 1 });
                }
            }
        }
    } catch (e) { /* best-effort */ }
}

/**
 * earnProductCashback
 *
 * What:  Legacy "product_cashback" — a per-item reward when an ordered
 *        product is in a product-cashback rule. amount = rule.cashback × qty.
 *        Called once per qualifying line item. Master-gated.
 * Type:  WRITE. Best-effort.
 */
async function earnProductCashback({ customerId, companyId, orderId, productId, qty }) {
    try {
        if (!customerId || !companyId || !productId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'product_cashback'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const q = Number(qty) || 0;
        if (q <= 0) { return; }

        const rule = await db('loyalty_product_cashback_rule as r')
            .innerJoin('loyalty_product_cashback_items as i', 'i.product_cashback_rule_id', 'r.id')
            .where({ 'r.company_id': companyId, 'i.product_id': productId })
            .whereNull('r.deleted_at').whereNull('i.deleted_at')
            .select('r.*').first();
        if (!rule || Number(rule.cashback) <= 0) { return; }

        await award({
            companyId, customerId, entityType: 'product_cashback',
            entityId: rule.id, relatedId: orderId,
            amount: round2(Number(rule.cashback) * q),
            jsonData: rule, cfg,
        });
    } catch (e) { /* best-effort */ }
}

/**
 * earnSpecialOffer
 *
 * What:  Legacy "special_offer" — a one-per-day cashback when there's an
 *        offer rule dated today. Flat £ or % of sub-total. Idempotent per
 *        (offer, day). Master-gated.
 * Type:  WRITE. Best-effort.
 */
async function earnSpecialOffer({ customerId, companyId, orderId, subtotal }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'special_offer'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const today = fmtDate(new Date());
        const rule = await db('loyalty_special_offer_rule')
            .where({ company_id: companyId }).whereNull('deleted_at')
            .whereRaw('DATE(offer_date) = ?', [today]).first();
        if (!rule || Number(rule.cashback) <= 0) { return; }

        // One per offer per day.
        const already = await db(REWARDS)
            .where({ company_id: companyId, customer_id: customerId, entity_type: 'special_offer', entity_id: rule.id })
            .whereRaw('DATE(created_at) = CURRENT_DATE').first();
        if (already) { return; }

        let amount = Number(rule.cashback) || 0;
        if (String(rule.value_type) === '%') { amount = round2((Number(subtotal) || 0) * (Number(rule.cashback) || 0) / 100); }
        if (amount <= 0) { return; }

        await award({
            companyId, customerId, entityType: 'special_offer',
            entityId: rule.id, relatedId: rule.id, amount, jsonData: rule, cfg,
        });
    } catch (e) { /* best-effort */ }
}

/**
 * earnReferral
 *
 * What:  Legacy 'referral' — on a customer's FIRST order at a restaurant,
 *        if they were referred (customer.referred_by set), both sides earn
 *        from loyalty_referral_cashback_rule (trigger 2). Exact legacy
 *        mapping: the new customer earns referrer_cashback; the referrer
 *        (referred_by) earns referee_cashback. Idempotent per rule.
 * Type:  WRITE. Best-effort. Master-gated.
 */
async function earnReferral({ customerId, companyId, orderId }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'referral'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        // FIRST completed order at this restaurant only.
        const prior = await db('orders')
            .where({ company_id: companyId, user_id: customerId, status: '1' })
            .andWhere('id', '!=', orderId).first('id');
        if (prior) { return; }

        const cust = await db('customer').where({ id: customerId }).first('referred_by');
        const referredBy = cust && cust.referred_by;
        if (!referredBy) { return; }

        const rule = await db('loyalty_referral_cashback_rule')
            .where({ company_id: companyId, trigger: 2 }).whereNull('deleted_at').first();
        if (!rule) { return; }
        const referrerCb = Number(rule.referrer_cashback) || 0;
        const refereeCb  = Number(rule.referee_cashback) || 0;
        if (referrerCb <= 0 && refereeCb <= 0) { return; }

        const already = await db(REWARDS)
            .where({ company_id: companyId, customer_id: customerId, entity_type: 'referral', entity_id: rule.id }).first();
        if (already) { return; }

        if (referrerCb > 0) {
            await award({ companyId, customerId, entityType: 'referral', entityId: rule.id, relatedId: orderId, amount: referrerCb, jsonData: rule, cfg });
        }
        if (refereeCb > 0) {
            await award({ companyId, customerId: referredBy, entityType: 'referral', entityId: rule.id, relatedId: orderId, amount: refereeCb, jsonData: rule, cfg });
        }
    } catch (e) { /* best-effort */ }
}

/**
 * earnEventCashback
 *
 * What:  Legacy 'event_cashback' — birthday (event_type 1) / anniversary
 *        (event_type 2) bonus from loyalty_event_cashback_rule, awarded when
 *        today matches the customer's dob / anniversary_date
 *        (customer_profile). Idempotent per rule. Master-gated.
 * Type:  WRITE. Best-effort.
 */
async function earnEventCashback({ customerId, companyId, orderId }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'event_cashback'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        let prof = null;
        try { prof = await db('customer_profile').where({ customer_id: customerId }).first('dob', 'anniversary_date'); } catch (e) { prof = null; }
        if (!prof) { return; }

        const now = new Date();
        const md = (d) => { const x = new Date(d); return (x.getMonth() + 1) + '-' + x.getDate(); };
        const today = (now.getMonth() + 1) + '-' + now.getDate();
        let eventType = null;
        if (prof.dob && md(prof.dob) === today) { eventType = 1; }
        else if (prof.anniversary_date && md(prof.anniversary_date) === today) { eventType = 2; }
        if (!eventType) { return; }

        const rule = await db('loyalty_event_cashback_rule')
            .where({ company_id: companyId, event_type: eventType }).whereNull('deleted_at').first();
        if (!rule || Number(rule.cashback) <= 0) { return; }

        const already = await db(REWARDS)
            .where({ company_id: companyId, customer_id: customerId, entity_type: 'event_cashback', entity_id: rule.id }).first();
        if (already) { return; }

        await award({ companyId, customerId, entityType: 'event_cashback', entityId: rule.id, relatedId: orderId, amount: Number(rule.cashback) || 0, jsonData: rule, cfg });
    } catch (e) { /* best-effort */ }
}

/**
 * earnSmartCampaign
 *
 * What:  Legacy 'smart_campaign' — win-back / top-spender / most-referrals
 *        bonuses from loyalty_smart_campaign. At order-place fires type
 *        'inactive': awards if the customer had NO other order in the last
 *        target_value days (the just-placed order is excluded — legacy
 *        includes it, which makes it a no-op; we exclude so win-back fires
 *        as intended). Master-gated.
 * Type:  WRITE. Best-effort.
 */
async function earnSmartCampaign({ customerId, companyId, orderId, type }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (!(await ruleEnabled(companyId, 'smart_campaign'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const rules = await db('loyalty_smart_campaign')
            .where({ company_id: companyId, type }).whereNull('deleted_at');
        for (const sr of rules) {
            if (Number(sr.cashback) <= 0) { continue; }
            if (type === 'inactive') {
                const days = parseInt(sr.target_value, 10) || 0;
                if (days <= 0) { continue; }
                const start = new Date(Date.now() - days * 86400000);
                const recent = await db('orders')
                    .where({ company_id: companyId, user_id: customerId, status: '1' })
                    .andWhere('id', '!=', orderId)
                    .andWhere('created_at', '>=', start).first('id');
                if (recent) { continue; }     // still active → skip
            }
            await award({ companyId, customerId, entityType: 'smart_campaign', entityId: sr.id, relatedId: orderId, amount: Number(sr.cashback) || 0, jsonData: sr, cfg });
            return;
        }
    } catch (e) { /* best-effort */ }
}

/**
 * getFreeDelivery
 *
 * What:  Membership-tier benefit (legacy CustomerRewards::getFreeDelivery) —
 *        true when the customer's lifetime spend at a restaurant reaches a
 *        loyalty_membership_tier whose free_delivery_lifetime is set. Used
 *        to zero the delivery fee at checkout. loyalty_status gated (via
 *        loadConfig); the tier's flag is the real switch.
 * Type:  READ.
 */
async function getFreeDelivery(companyId, customerId) {
    try {
        if (!companyId || !customerId || !(await isReady())) { return false; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return false; }
        const row = await db('orders')
            .where({ company_id: companyId, user_id: customerId, status: '1', order_status: '' })
            .sum({ s: 'sub_total' }).first();
        const totalSpent = Number(row && row.s) || 0;
        if (totalSpent <= 0) { return false; }

        const tier = await db('loyalty_membership_tier')
            .where({ company_id: companyId }).whereNull('deleted_at')
            .andWhere('min_amount', '<=', totalSpent)
            .andWhereRaw('(max_amount = 0 OR max_amount >= ?)', [totalSpent])
            .orderBy('min_amount', 'desc').first('free_delivery_lifetime');
        return tier ? !!tier.free_delivery_lifetime : false;
    } catch (e) { return false; }
}

/**
 * earnCollectionCashback
 *
 * What:  Legacy 'collection_cashback' — % cashback on COLLECTION / pickup
 *        orders (serve_type 2), from company_loyalty.collection_cashback.
 *        Ported exactly: only pickup orders, only when the rate > 0.
 *        Master-gated (loyalty_rules.status), commission skimmed like the
 *        other earns.
 * Type:  WRITE. Best-effort.
 */
async function earnCollectionCashback({ customerId, companyId, orderId, subtotal, serveType }) {
    try {
        if (!customerId || !companyId || !(await isReady())) { return; }
        if (Number(serveType) !== 2) { return; }                 // collection / pickup only
        if (!(await ruleEnabled(companyId, 'collection_cashback'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }
        const pct = Number(cfg.collection_cashback) || 0;
        if (pct <= 0) { return; }
        const amount = round2((Number(subtotal) || 0) * pct / 100);
        if (amount <= 0) { return; }
        await award({
            companyId, customerId, entityType: 'collection_cashback',
            entityId: cfg.id, relatedId: orderId, amount,
            jsonData: { collection_cashback: pct }, cfg,
        });
    } catch (e) { /* best-effort */ }
}

/**
 * bogoForProduct
 *
 * What:  The active BOGOF (buy-X-get-Y) rule for a product — product-level
 *        (apply_on 1, loyalty_bogof_buy.product_id) or category-level
 *        (apply_on 2, loyalty_bogof_buy.category_id ∈ the product's
 *        categories). Mirrors legacy Commonquery::getBogoOnProduct.
 *        Master-gated (loyalty_rules 'bogof') + loyalty on. First match wins.
 * Type:  READ. Returns { buyQty, getQty, ruleId } | null.
 */
async function bogoForProduct(productId, companyId) {
    try {
        if (!productId || !companyId || !(await isReady())) { return null; }
        if (!(await ruleEnabled(companyId, 'bogof'))) { return null; }
        if (!(await loadConfig(companyId))) { return null; }

        const rules = await db('loyalty_bogof_rule')
            .where({ company_id: companyId }).whereNull('deleted_at');
        if (!rules.length) { return null; }

        const catRows = await db('product_product_category')
            .where({ product_id: productId, status: '1' }).select('category_id');
        const catIds = catRows.map(r => r.category_id).filter(v => v != null);

        for (const r of rules) {
            const applyOn = Number(r.apply_on);
            let match = false;
            if (applyOn === 1) {
                const ex = await db('loyalty_bogof_buy')
                    .where({ bogof_rule_id: r.id, product_id: productId }).whereNull('deleted_at').first('id');
                match = !!ex;
            } else if (applyOn === 2 && catIds.length) {
                const ex = await db('loyalty_bogof_buy')
                    .where({ bogof_rule_id: r.id }).whereIn('category_id', catIds).whereNull('deleted_at').first('id');
                match = !!ex;
            }
            if (match) {
                return { buyQty: Number(r.buy_quantity) || 0, getQty: Number(r.get_quantity) || 0, ruleId: r.id };
            }
        }
        return null;
    } catch (e) { return null; }
}

/**
 * payableQtyFor — units the customer PAYS for under a BOGO rule (legacy
 * Commonquery::gePaybleQuantity). No rule → the full qty.
 */
function payableQtyFor(bogo, qty) {
    const q = Number(qty) || 0;
    if (!bogo) { return q; }
    const buy = Number(bogo.buyQty) || 0;
    const get = Number(bogo.getQty) || 0;
    if (buy <= 0 || get <= 0) { return q; }
    const groupSize  = buy + get;
    const fullGroups = Math.floor(q / groupSize);
    const remaining  = q % groupSize;
    return (fullGroups * buy) + Math.min(remaining, buy);
}

/**
 * bogoMapFor — BOGO rules for a WHOLE company's menu in one pass, for the
 * "Buy X Get Y" badges. Map<product_id, { buyQty, getQty }>. Product-level
 * rules map directly; category-level rules expand to every product in the
 * category. Master-gated. Empty map when loyalty/bogof is off.
 * Type:  READ.
 */
async function bogoMapFor(companyId) {
    const map = new Map();
    try {
        if (!companyId || !(await isReady())) { return map; }
        if (!(await ruleEnabled(companyId, 'bogof'))) { return map; }
        if (!(await loadConfig(companyId))) { return map; }
        const rules = await db('loyalty_bogof_rule').where({ company_id: companyId }).whereNull('deleted_at');
        if (!rules.length) { return map; }

        for (const r of rules) {
            const info = { buyQty: Number(r.buy_quantity) || 0, getQty: Number(r.get_quantity) || 0 };
            if (info.buyQty <= 0 || info.getQty <= 0) { continue; }
            if (Number(r.apply_on) === 1) {
                const buys = await db('loyalty_bogof_buy')
                    .where({ bogof_rule_id: r.id }).whereNull('deleted_at').whereNotNull('product_id').select('product_id');
                buys.forEach(b => { const k = String(b.product_id); if (!map.has(k)) { map.set(k, info); } });
            } else if (Number(r.apply_on) === 2) {
                const cats = await db('loyalty_bogof_buy')
                    .where({ bogof_rule_id: r.id }).whereNull('deleted_at').whereNotNull('category_id').select('category_id');
                const catIds = cats.map(c => c.category_id).filter(v => v != null);
                if (catIds.length) {
                    const prods = await db('product_product_category')
                        .whereIn('category_id', catIds).where('status', '1').select('product_id');
                    prods.forEach(p => { const k = String(p.product_id); if (!map.has(k)) { map.set(k, info); } });
                }
            }
        }
    } catch (e) { /* best-effort — no badges on error */ }
    return map;
}

module.exports = {
    isReady, loadConfig, ruleEnabled, getCustomerTier, getFreeDelivery,
    earnForOrder, earnOrderStreak, earnStampCashback, earnProductCashback, earnSpecialOffer,
    earnReferral, earnEventCashback, earnSmartCampaign, earnCollectionCashback,
    bogoForProduct, payableQtyFor, bogoMapFor,
    balanceFor, cardsFor, historyFor, reviewTypesFor, reviewRestaurants, maxRedeemable, consumeForRedeem, reverseForOrder, streakProgressFor,
    linkedCustomerIds,
    // Shared reward-write (commission skim + expiry + ledger + audit row).
    // Exposed so the admin Review-Claims approval can grant a review reward
    // through the SAME path the earn rules use — keeping the ledger consistent.
    award,
};
