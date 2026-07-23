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
// customer.id <-> customer.app_id. The reward tables key on app_id (legacy
// semantics) — see linkedRewardIds and customerLookup.appIdOf.
const customers = require('./customerLookup');
const { sanitizeCmsHtml, decodeEntities } = require('./cmsSanitize');

const REWARDS     = 'customer_rewards';
const CONFIG      = 'company_loyalty';

/*
 * created_via — the CHANNEL a reward was earned through, copied from the order
 * that earned it. Legacy's values (they drive the POS loyalty-commission
 * report): 1 = website, 2 = ePOS, 3/4 = phone. 5 is OURS — the EatNDeal
 * marketplace, matching Helpers/orderPlace CREATED_VIA_MARKETPLACE.
 *
 * Hardcoded rather than read back off the order: every reward this API writes
 * comes from marketplace activity — an order placed here, a claim approved in
 * our admin, or one of our loyalty jobs — so the channel is always 5, and
 * re-reading the order per reward would only add a query to say the same thing.
 * The column used to take its default (1), filing marketplace cashback under
 * "website".
 */
const CREATED_VIA_MARKETPLACE = 5;
const STREAK_RULE = 'loyalty_order_cashback_rule';
const STREAK_PROG = 'loyalty_order_cashback_progress';

// ── Loyalty scope (company_id) ──────────────────────────────────────
// Every loyalty row is partitioned by company_id. TWO kinds of owner:
//   • company_id > 0 → a restaurant's own programme
//   • company_id = 0 → the MARKETPLACE's own programme (EatNDeal super admin),
//                      flagged is_marketplace = 1 on the row
// 0 is a VALID scope but it's FALSY in JS, so a plain `!hasScope(companyId)` guard would
// silently treat the whole marketplace programme as "no company" and no-op.
// hasScope() is the ONE place that decides what a real scope is — always use it
// instead of a truthiness check on a company id.
const MARKETPLACE_COMPANY_ID = 0;
// Display name for the marketplace's own reward card (company_id = 0 has no
// company row to read a business_name from).
const MARKETPLACE_LABEL = process.env.BRAND_NAME || 'EatNDeal';

/*
 * The marketplace's public slug — what /earn?restaurant=<slug> carries for
 * EatNDeal's OWN earn page.
 *
 * RESERVED and deliberately not just the brand name: company_id 0 has no
 * `company` row, so M.companyIdBySlug() can never resolve it (it looks the slug
 * up in `company`). Callers must therefore check THIS first and only fall back
 * to the company lookup. A plain "eatndeal" would also be ambiguous here —
 * company_id 1 is a RESTAURANT literally named "EatNDeal".
 */
const MARKETPLACE_SLUG = 'eatndeal-marketplace';

/**
 * scopeFromSlug — MARKETPLACE_COMPANY_ID for the marketplace slug, else null
 * (meaning "not the marketplace — resolve it as a normal company").
 */
function scopeFromSlug(slug) {
    return String(slug || '').trim().toLowerCase() === MARKETPLACE_SLUG ? MARKETPLACE_COMPANY_ID : null;
}

/**
 * resolveReferrerId
 *
 * What:  The referrer's REAL customer.id for a referred customer — the id our
 *        ledger is keyed by.
 *
 * Why:   `customer.referred_by` has TWO meanings, like customer_review.customer_id:
 *          • our signup      -> customer.id  (Helpers/customerLookup resolveReferrer
 *                               stores row.id)
 *          • legacy signup   -> app_id       (webordering SiteController.php:676
 *                               `$model->referred_by = $referralCustomer->app_id`)
 *        and the two collide across DIFFERENT real people (id 131 = "David",
 *        app_id 131 = "Asad"). earnReferral awarded `referred_by` straight as a
 *        customer.id, so a legacy-referred customer's friend-bonus landed in a
 *        STRANGER's wallet.
 *
 *        The referred customer's OWN origin says which it is: a marketplace
 *        customer (company_id NULL) was signed up by us, so their referred_by is
 *        a customer.id; anyone else came through legacy, so it's an app_id.
 *
 * Type:  READ.
 * Output: customer.id (number) or null when it can't be resolved — never a guess.
 */
async function resolveReferrerId(cust) {
    const raw = cust && cust.referred_by;
    if (raw == null || String(raw).trim() === '') { return null; }

    // Ours: marketplace customers have a NULL company_id (Helpers/customerLookup).
    if (cust.company_id == null) {
        const byId = await db('customer').where({ id: raw }).first('id');
        return byId ? Number(byId.id) : null;
    }
    // Legacy: referred_by is an app_id — map it back to the real row.
    const byApp = await db('customer').where({ app_id: raw }).first('id');
    return byApp ? Number(byApp.id) : null;
}

/*
 * customer_review.customer_id has TWO DIFFERENT MEANINGS — read this before
 * touching any query that joins it.
 *
 *   company_id = 0  (MARKETPLACE — written by our Node submit,
 *                    Controllers/Customer/ReviewController)      -> customer.id
 *   company_id > 0  (LEGACY — written by Yii webordering/POS)    -> customer.app_id
 *
 * Legacy keys its whole loyalty world by `app_id` (webordering
 * OrderController.php:239 `$cart->user_id = $customer->app_id`, :1344
 * `$customerId = Yii::$app->user->identity->app_id`), and CashbackReviewController.php:86
 * joins `c.app_id = cr.customer_id`. Our marketplace keys by `customer.id`,
 * because customers created by OUR signup have NO app_id at all (it comes from a
 * legacy POS counter, SiteController.php:1003-1012).
 *
 * The two are NOT interchangeable: id and app_id collide across different real
 * people (customer.id 6 = "Robert", app_id 6 = "Ravi"), so joining on the wrong
 * one silently shows — and pays — the WRONG CUSTOMER. Joining everything on
 * `c.id` was doing exactly that for the 13 legacy claims.
 *
 * Deliberately NOT "fixed" by migrating data to one key: our marketplace
 * customers have app_id = NULL, so converting would orphan their money. The
 * scope tells us the semantics deterministically, so we resolve per row instead.
 *
 * NB: `review_rating.customer_id` is a REAL customer.id even in legacy — legacy
 * resolves app_id -> customer.id before inserting (CashbackReviewController.php:168-174).
 * Do not apply this rule there.
 */
function joinReviewCustomer(q, reviewAlias, customerAlias) {
    const cr = reviewAlias || 'cr';
    const c  = customerAlias || 'c';
    return q.leftJoin(`customer as ${c}`, function () {
        this.on(function () {
            this.on(`${cr}.company_id`, '=', db.raw('?', [MARKETPLACE_COMPANY_ID]))
                .andOn(`${c}.id`, '=', `${cr}.customer_id`);
        }).orOn(function () {
            this.on(`${cr}.company_id`, '<>', db.raw('?', [MARKETPLACE_COMPANY_ID]))
                .andOn(`${c}.app_id`, '=', `${cr}.customer_id`);
        });
    });
}

/*
 * rewardCustomerIdFor — which id to CREDIT when approving a claim.
 *
 * Deliberately the row's own customer_id, unchanged: it already matches the
 * ledger that will be read back.
 *   • marketplace claim -> customer.id -> our wallet reads customer.id  ✅
 *   • legacy claim      -> app_id      -> legacy wallet reads app_id    ✅
 * Exists so this reasoning is written down rather than looking like an oversight.
 */
function rewardCustomerIdFor(review) {
    return review.customer_id;
}

// loyalty_event_cashback_rule.event_type — the SAME meanings the admin writes
// (Controllers/Admin/LoyaltyController EVENT_TYPES) and legacy reads:
//   1 = signup, 2 = profile completion, 3 = google review
// NOT birthday/anniversary — legacy has no such concept. The TRIGGER passes the
// type in; earnEventCashback never derives it.
const EVENT_SIGNUP = 1, EVENT_PROFILE_COMPLETE = 2, EVENT_GOOGLE_REVIEW = 3;
const EVENT_TYPES  = [EVENT_SIGNUP, EVENT_PROFILE_COMPLETE, EVENT_GOOGLE_REVIEW];
function hasScope(companyId) {
    return companyId !== null && companyId !== undefined && companyId !== '' && !Number.isNaN(Number(companyId));
}
// True when this scope is the marketplace's own programme (company_id = 0).
function isMarketplaceScope(companyId) {
    return hasScope(companyId) && Number(companyId) === MARKETPLACE_COMPANY_ID;
}

/*
 * ══ MARKETPLACE LOYALTY DISABLED 2026-07-20 (user request) ══════════════
 *
 * ONE switch for EatNDeal's own (company_id = 0) reward programme. While it is
 * false, company 0 is left out of every customer-facing figure:
 *     • wallet cards        (cardsFor)
 *     • wallet totals + history rows (historyFor)
 *     • checkout cap        (redeemPoolsFor)
 *     • checkout spend      (consumeAcrossPools)
 * so the totals, the cards, the history and the redeem cap all agree — an
 * "available" figure that can't be spent is worse than no figure at all.
 *
 * NOTHING is deleted: rows keep accruing in customer_rewards, and every
 * function still knows how to price the marketplace pool.
 * RESTORE: set this to true. That is the whole change — the call sites all
 * read it, so nothing else has to be touched.
 */
const MARKETPLACE_LOYALTY_ENABLED = false;

/*
 * rewardScopeWhere
 *
 * The scope filter shared by cardsFor + historyFor (totals AND rows) — kept in
 * one place so those three can never drift apart.
 *
 * Enabled : marketplace rows (company_id = 0, which has NO company row) pass
 *           through explicitly, plus any LIVE marketplace restaurant.
 * Disabled: eligible restaurants only. company 0 needs no explicit exclusion —
 *           eligibleCompanyScope tests c.is_marketplace / c.is_active, and the
 *           LEFT JOIN leaves those NULL for a row with no company, so it drops
 *           out on its own.
 *
 * `qb` is the query builder (call it with the builder, not via `this`).
 */
function rewardScopeWhere(qb) {
    if (MARKETPLACE_LOYALTY_ENABLED) {
        qb.where('cr.company_id', MARKETPLACE_COMPANY_ID)
            .orWhere(function () { M.eligibleCompanyScope(this, 'c'); });
        return;
    }
    M.eligibleCompanyScope(qb, 'c');
}

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
    if (!hasScope(companyId) || !(await isReady())) { return null; }
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
    if (!hasScope(companyId) || !ruleType) { return false; }
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

        // customer_rewards keys on app_id (legacy: customer_id = orders.user_id
        // = app_id), NOT our customer.id — see customerLookup.appIdOf. We credit
        // the RESTAURANT's own customer identity for this mobile when it exists,
        // else the marketplace customer's app_id (rewardIdentityFor). Without any
        // app_id the row could not be matched by the POS, so skip rather than
        // write a wrong identity.
        const rewardCustomerId = await rewardIdentityFor(customerId, companyId);
        if (rewardCustomerId === null) {
            H.log.error('loyalty.earnForOrder', 'customer ' + customerId + ' has no app_id — cashback skipped');
            return;
        }
        // Marketplace-channel earn — stamp is_marketplace = 1 where the column
        // exists. created_via = 5 already marks the channel regardless.
        const rewardMp = await hasRewardMpCol();

        const inserted = await db(REWARDS).insert({
            uuid:         crypto.randomUUID(),
            company_id:   companyId,
            customer_id:  rewardCustomerId,
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
            created_via:  CREATED_VIA_MARKETPLACE,   // 5 — marketplace channel
            ...(rewardMp ? { is_marketplace: 1 } : {}),
            created_at:   db.fn.now(),
            created_by:   rewardCustomerId,
        }).returning('id');

        const rewardId = inserted && inserted[0] && (inserted[0].id || inserted[0]);
        if (commission > 0 && rewardId) {
            try {
                await db('admin_reward_commissions').insert({
                    customer_reward_id: rewardId,
                    company_id:         companyId,
                    customer_id:        rewardCustomerId,   // app_id, as above
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
    const me = await db('customer').where({ id }).first('id', 'contact_no');
    if (!me) { return []; }
    const contact = String(me.contact_no || '').trim();
    if (!contact) { return [id]; }   // no mobile yet → only their own points

    // MOBILE NUMBER ONLY — country_code is deliberately NOT part of the match.
    //
    // It used to be, so that the same local number in two countries stayed two
    // people. In this database that did more harm than good: the legacy POS
    // customer form never sets country_code at all (its CustomerController
    // only handles contact_no, and dedupes on contact_no + company_id), so 85
    // POS customers carry country_code = 0 while the same person's marketplace
    // row carries 44. Matching on the code split those accounts apart, and a
    // customer's POS-issued vouchers and POS-earned cashback stayed invisible
    // to them — the exact thing this function exists to prevent.
    const rows = await db('customer').where('contact_no', contact).select('id');

    const ids = rows.map((r) => Number(r.id));
    if (!ids.includes(id)) { ids.push(id); }
    return ids;
}

/**
 * linkedRewardIds
 *
 * What:  linkedCustomerIds translated into the identity the REWARD tables
 *        actually key on — customer.app_id, which is what legacy writes into
 *        customer_rewards.customer_id (= orders.user_id = app_id).
 * Why:   Every reward read below aggregates a person's accounts. Feeding it
 *        customer.id values matched nothing legacy had written (a customer's
 *        POS-earned cashback simply never appeared in the wallet) and could
 *        match a DIFFERENT person's rows whenever their app_id happened to
 *        equal one of our ids. This is the single choke point for all of them.
 * NB:    An account with no app_id contributes nothing rather than falling back
 *        to its customer.id — see customerLookup.appIdOf. Run
 *        scripts/backfill-app-id.js if a customer is missing one.
 * Type:  READ.
 */
async function linkedRewardIds(customerId) {
    return customers.appIdsOf(await linkedCustomerIds(customerId));
}

/*
 * rewardIdentityFor
 *
 * What:  The app_id a reward EARNED at restaurant `companyId` should be credited
 *        to. Product rule:
 *          • If this person has the restaurant's OWN customer row (same mobile,
 *            company_id = X, not soft-deleted, with an app_id) → credit THAT
 *            row's app_id, so the reward lives under the restaurant's customer
 *            ("same rahe" — the restaurant tracks its own customer).
 *          • Otherwise → the marketplace customer's own app_id (unchanged
 *            behaviour). No new customer row is ever created; no duplicate.
 * Why:   Loyalty aggregates by MOBILE on read (linkedRewardIds), so REDEEM works
 *        either way — this only decides WHICH linked app_id a new reward accrues
 *        to. Returns an app_id, or null only when the customer has no app_id at
 *        all (same contract as customerLookup.appIdOf).
 * NB:    Matches contact_no only (country_code excluded), exactly like
 *        linkedCustomerIds.
 * Type:  READ.
 */
async function rewardIdentityFor(customerId, companyId) {
    // Fallback = the marketplace customer's own app_id (the current rule).
    const fallback = await customers.appIdOf(customerId);

    // Only a real restaurant scope can own a POS row (company 0 / no scope →
    // there is no "restaurant customer" to prefer, so keep the fallback).
    if (!hasScope(companyId) || Number(companyId) === MARKETPLACE_COMPANY_ID) {
        return fallback;
    }

    // The caller's mobile — the key the restaurant's row is matched on.
    const me = await db('customer').where({ id: customerId }).first('contact_no');
    const contact = String((me && me.contact_no) || '').trim();
    if (!contact) { return fallback; }   // no mobile → nothing to match at the restaurant

    // The restaurant's OWN row for this mobile: same company, must have an
    // app_id, not soft-deleted (status '2'); newest wins. contact_no only.
    const posRow = await db('customer')
        .where({ contact_no: contact, company_id: companyId })
        .whereNotNull('app_id')
        .andWhere(function () { this.whereNull('status').orWhere('status', '<>', '2'); })
        .orderBy('id', 'desc')
        .first('app_id');

    return (posRow && posRow.app_id != null) ? Number(posRow.app_id) : fallback;
}

// Whether customer_rewards.is_marketplace exists yet (migration m260715_120000).
// Column-gated (mirrors cart.hasUsedCashbackCol) so a pre-migration DB still
// earns — created_via = 5 marks the marketplace channel regardless.
let _hasRewardMpCol = null;
async function hasRewardMpCol() {
    if (_hasRewardMpCol !== null) { return _hasRewardMpCol; }
    try {
        const r = await db.raw(
            "select 1 from information_schema.columns where table_name = 'customer_rewards' and column_name = 'is_marketplace' limit 1",
        );
        const n = r && (r.rows ? r.rows.length : (Array.isArray(r) ? r.length : 0));
        _hasRewardMpCol = n > 0;
    } catch (e) { _hasRewardMpCol = false; }
    return _hasRewardMpCol;
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
    if (!customerId || !hasScope(companyId) || !(await isReady())) { return 0; }
    const ids = await linkedRewardIds(customerId);   // app_ids — reward tables key on app_id
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
    const ids = await linkedRewardIds(customerId);   // app_ids — reward tables key on app_id
    if (!ids.length) { return []; }
    const rows = await db(REWARDS + ' as cr')
        // LEFT join: a RESTAURANT card must be a LIVE marketplace company
        // (active, not deleted, not in maintenance) — points at a restaurant
        // that isn't on the marketplace are hidden (the customer can't order
        // there to redeem them anyway). Whether the MARKETPLACE's own card
        // (company_id = 0) is included is rewardScopeWhere's call — see
        // MARKETPLACE_LOYALTY_ENABLED.
        .leftJoin('company as c', 'c.id', 'cr.company_id')
        .whereIn('cr.customer_id', ids)
        .where(function () { rewardScopeWhere(this); })
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
        // company_id 0 = the marketplace's OWN card — no company row, so the
        // brand name/slug stand in for business_name/domain_name.
        const isMp = isMarketplaceScope(r.company_id);
        const name = isMp ? MARKETPLACE_LABEL : (String(r.business_name || '').trim() || 'Restaurant');
        return {
            companyId: String(r.company_id),
            name,
            isMarketplace: isMp,
            slug:      isMp ? '' : (r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id)),
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
    // NOTE: `Number(x) || 0` would collapse "no filter" into 0 — and 0 now MEANS
    // the marketplace's own programme, so that would silently show ONLY
    // marketplace rows. Keep absent as null (→ no filter, every scope).
    const companyId = hasScope(o.companyId) ? Number(o.companyId) : null;
    const filter = String(o.filter || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(o.limit) || 50));
    const offset = Math.max(0, Number(o.offset) || 0);
    if (!customerId || !(await isReady())) { return { totals: { available: 0, earned: 0, used: 0, expired: 0 }, transactions: [], total_count: 0 }; }
    const ids = await linkedRewardIds(customerId);   // app_ids — reward tables key on app_id
    if (!ids.length) { return { totals: { available: 0, earned: 0, used: 0, expired: 0 }, transactions: [], total_count: 0 }; }

    // Wallet totals for the scope (unaffected by the status filter / paging).
    // Aggregated across the person's mobile-linked accounts, and only for
    // restaurants that are LIVE on the marketplace. Whether the MARKETPLACE's
    // own rows count towards the totals is rewardScopeWhere's call — the SAME
    // clause the cards and the history rows use, so the headline figure can
    // never include money the cards below it don't show.
    let tq = db(REWARDS + ' as cr')
        .leftJoin('company as c', 'c.id', 'cr.company_id')
        .whereIn('cr.customer_id', ids)
        .where(function () { rewardScopeWhere(this); });
    if (hasScope(companyId)) { tq = tq.where('cr.company_id', companyId); }
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
            .leftJoin('company as c', 'c.id', 'cr.company_id')
            .whereIn('cr.customer_id', ids)
            .where(function () { rewardScopeWhere(this); });
        if (hasScope(companyId)) { q = q.where('cr.company_id', companyId); }
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
        // company_id 0 = the marketplace's own programme — no company row, so
        // show the brand instead of the generic "Restaurant" fallback.
        const isMp = isMarketplaceScope(r.company_id);
        const name = isMp ? MARKETPLACE_LABEL : (String(r.business_name || '').trim() || 'Restaurant');
        return {
            id:          Number(r.id),
            date:        r.created_at,
            companyId:   String(r.company_id),
            isMarketplace: isMp,
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
    // OUR uploads (admin CMS) are stored as "/upload/loyalty/<file>" and live on
    // the api server. Return them through H.mediaUrl, which makes them ABSOLUTE
    // (http://<api>/upload/…) — the customer web app (4502) does NOT serve
    // /upload, so a bare relative path 404'd and the example screenshot showed
    // broken. This is exactly what marketplace category / restaurant images do.
    // A bare filename is LEGACY media on the old Eat-n-Deal server, resolved
    // against its uploads base with the <company>/loyalty/ path.
    if (/^https?:\/\//i.test(f) || f.charAt(0) === '/') { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/' + companyId + '/loyalty/' + f;
}
async function reviewMasterOn(companyId) {
    if (!hasScope(companyId)) { return false; }
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
    // company_id 0 (the marketplace's own programme) is a VALID scope — check
    // the scope BEFORE coercing, or `Number(0) || 0` would read as "missing".
    if (!hasScope(companyId)) { return { company: null, masterOn: false, types: [] }; }
    // These tables key on app_id (legacy), not our customer.id — see
    // customerLookup.appIdOf. award() translates on its own, so it still
    // takes customerId; only the direct queries below use rcid.
    const rcid = await customers.appIdOf(customerId);
    if (rcid === null) { return { company: null, masterOn: false, types: [] }; }
    const cid = Number(companyId);
    // The MARKETPLACE has no `company` row (company_id 0 by design), so this
    // lookup returns undefined and the page rendered a nameless card. Stand the
    // brand in for it, exactly like the wallet card and the /earn picker do.
    const co = isMarketplaceScope(cid)
        ? { id: cid, business_name: MARKETPLACE_LABEL, domain_name: MARKETPLACE_SLUG }
        : await db('company').where('id', cid).first('id', 'business_name', 'domain_name');
    const masterOn = await reviewMasterOn(cid);
    const rules = await db('loyalty_review_cashback_rule').where('company_id', cid).whereNull('deleted_at').andWhere('cashback', '>', 0).select('type', 'value_type', 'cashback');
    const ruleBy = {}; rules.forEach((r) => { ruleBy[Number(r.type)] = { cashback: round2(r.cashback), value_type: r.value_type || '£' }; });
    const cms = await db('loyalty_cms_pages').where('company_id', cid).select('review_type_slug', 'title', 'description', 'screenshot');
    const cmsBy = {}; cms.forEach((c) => { cmsBy[c.review_type_slug] = c; });
    const claimBy = {};
    if (customerId) {
        // Keyed by APP_ID (rcid), not customer.id — that is what the submit
        // writes (Controllers/Customer/ReviewController.js:247) and what the
        // POS matches on. Reading by customer.id found no claim, so a fresh
        // submission showed no "under verification" banner and the button
        // stayed live, letting the customer submit into a 409.
        const claims = await db('customer_review').where({ company_id: cid, customer_id: rcid }).select('review_type', 'admin_status', 'reject_reason');
        claims.forEach((c) => { claimBy[Number(c.review_type)] = c; });
    }
    const types = (masterOn ? REVIEW_TYPES.filter((t) => t.menu && ruleBy[t.id]) : []).map((t) => {
        const rule = ruleBy[t.id];
        const cmsRow = cmsBy[t.slug] || {};
        const claim = claimBy[t.id];
        return {
            id: t.id, slug: t.slug, name: t.name, icon: t.icon, video: t.video,
            reward: rule.cashback, value_type: rule.value_type,
            // The admin editor stores the title HTML-ENCODED (e.g. &quot;…&quot;,
            // Switch &amp; …). It's rendered as PLAIN TEXT (the view escapes it),
            // so decode the entities here — otherwise the view escapes the '&'
            // again and the customer literally sees "&quot;" / "&amp;".
            title: decodeEntities(cmsRow.title || t.name),
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
    // LEFT join + an explicit scope-0 pass-through. This was an INNER join on
    // `company`, and the MARKETPLACE has no company row (company_id = 0 by
    // design) — so EatNDeal's OWN review rewards could never appear in the
    // picker no matter how they were configured. NB the "EatNDeal" card already
    // in this list is company_id = 1, a RESTAURANT that happens to be named
    // EatNDeal; the marketplace is a separate, additional card.
    const rows = await db('loyalty_review_cashback_rule as r')
        .leftJoin('company as c', 'c.id', 'r.company_id')
        .whereNull('r.deleted_at').andWhere('r.cashback', '>', 0)
        // Count only the customer-facing (menu) review types, so the picker's
        // "up to £X / N ways" matches what the customer can actually claim.
        .whereIn('r.type', C.REVIEW_TYPES.filter((t) => t.menu).map((t) => t.id))
        .andWhere(function () {
            // marketplace (0) OR a live, marketplace-visible restaurant
            this.where('r.company_id', MARKETPLACE_COMPANY_ID)
                .orWhere(function () {
                    this.where('c.is_marketplace', 1).andWhere('c.is_active', 1).whereNull('c.deleted_at');
                });
        })
        .whereExists(function () {
            this.select(db.raw('1')).from('loyalty_rules as lr')
                .whereRaw('lr.company_id = r.company_id').andWhere('lr.rule_type', 'review').andWhere('lr.status', 1).whereNull('lr.deleted_at');
        })
        .groupBy('r.company_id', 'c.id', 'c.business_name', 'c.domain_name')
        .select('r.company_id', 'c.business_name', 'c.domain_name', db.raw('MAX(r.cashback) as max_reward'), db.raw('COUNT(DISTINCT r.type) as type_count'))
        .orderBy('c.business_name', 'asc').limit(100);
    return rows.map((r) => {
        const cid = Number(r.company_id);
        // company_id 0 has no company row, so business_name comes back NULL —
        // label it with the brand, exactly like the wallet card does.
        const isMp = isMarketplaceScope(cid);
        const name = isMp ? MARKETPLACE_LABEL : (r.business_name || 'Restaurant');
        return {
            companyId: String(cid),
            name,
            slug: isMp ? MARKETPLACE_SLUG : (r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, cid)),
            maxReward: round2(r.max_reward),
            typeCount: Number(r.type_count) || 0,
            isMarketplace: isMp,
        };
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
    if (!customerId || !hasScope(companyId)) { return 0; }
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
 * redeemPoolsFor
 *
 * What:  The TWO reward pools a customer can spend on one order:
 *           • restaurant  — their cashback AT this restaurant (company_id > 0)
 *           • marketplace — their cashback with EatNDeal itself (company_id = 0)
 *
 *        Each pool is capped INDEPENDENTLY by its own programme's rules
 *        (balance / use_max_cashback / sub-total — see maxRedeemable), because
 *        the two are funded by different parties. The COMBINED spend is then
 *        clamped to the order sub-total, so the two together can never take the
 *        order below zero.
 *
 * Why:   A customer holds a card per restaurant AND the marketplace card, and
 *        can use both on the same order.
 * Type:  READ.
 *
 * Inputs:  { customerId, companyId (the cart's restaurant), subTotal }
 * Output:  { restaurant, marketplace, combined }
 */
async function redeemPoolsFor({ customerId, companyId, subTotal }) {
    const sub = Number(subTotal) || 0;
    const restaurant = await maxRedeemable({ customerId, companyId, subTotal: sub });

    // Only the cashback earned AT THE RESTAURANT BEING ORDERED FROM is
    // spendable while MARKETPLACE_LOYALTY_ENABLED is false — the same switch
    // that hides the marketplace card and keeps it out of the wallet totals.
    // Gated HERE, in the one place that computes the cap, so every caller
    // follows: the cart summary, the "Up to £X" hint, the redeem validator and
    // the order-place path all read this. `combined` then collapses to the
    // restaurant pool.
    // The second lookup is also skipped when the cart IS the marketplace scope
    // (can't happen today — a cart always belongs to a restaurant — but it
    // keeps the maths honest).
    const marketplace = (!MARKETPLACE_LOYALTY_ENABLED || isMarketplaceScope(companyId))
        ? 0
        : await maxRedeemable({ customerId, companyId: MARKETPLACE_COMPANY_ID, subTotal: sub });

    const combined = round2(Math.min(sub, round2(restaurant + marketplace)));
    return { restaurant, marketplace, combined };
}

/**
 * consumeAcrossPools
 *
 * What:  Spends `amount` across BOTH pools in one order — the restaurant's own
 *        cashback FIRST, then the marketplace's for whatever is left.
 *
 *        Restaurant-first is deliberate: that balance is only usable AT this
 *        restaurant, while the marketplace balance can be spent anywhere. Always
 *        burn the narrower pool first so the customer keeps the flexible one.
 *
 *        Each leg is a normal consumeForRedeem, so each pool gets its own FIFO
 *        walk, its own customer_used_rewards ledger row, and reverseForOrder
 *        already un-spends per company on cancel — no schema change needed.
 *
 * Type:  WRITE (transactional — caller's trx).
 * Inputs: trx, { customerId, companyId, orderId, amount }
 * Output: { consumed, byPool: { [companyId]: consumed } }
 */
async function consumeAcrossPools(trx, { customerId, companyId, orderId, amount }) {
    let remaining = round2(amount);
    const out = { consumed: 0, byPool: {} };
    if (!trx || !customerId || remaining <= 0) { return out; }

    // Restaurant pool, then the marketplace's. Deduped so a marketplace-scoped
    // cart could never be consumed twice.
    // While MARKETPLACE_LOYALTY_ENABLED is false the marketplace leg is skipped:
    // redeemPoolsFor already caps the amount to the restaurant pool, so nothing
    // should reach it anyway — but this is the code that actually MOVES money,
    // and a caller passing a larger amount must never quietly burn EatNDeal's
    // cashback. Belt and braces on purpose.
    const scopes = [];
    if (hasScope(companyId)) { scopes.push(Number(companyId)); }
    if (MARKETPLACE_LOYALTY_ENABLED && !scopes.includes(MARKETPLACE_COMPANY_ID)) {
        scopes.push(MARKETPLACE_COMPANY_ID);
    }

    for (const scope of scopes) {
        if (remaining <= 0) { break; }
        const r = await consumeForRedeem(trx, { customerId, companyId: scope, orderId, amount: remaining });
        const took = round2(r.consumed);
        if (took > 0) {
            out.consumed    = round2(out.consumed + took);
            out.byPool[scope] = took;
            remaining       = round2(remaining - took);
        }
    }
    return out;
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
    if (!trx || !customerId || !hasScope(companyId) || want <= 0) { return { consumed: 0, breakdown: [] }; }
    // These tables key on app_id (legacy), not our customer.id — see
    // customerLookup.appIdOf. award() translates on its own, so it still
    // takes customerId; only the direct queries below use rcid.
    const rcid = await customers.appIdOf(customerId);
    if (rcid === null) { return { consumed: 0, breakdown: [] }; }

    // Spend across ALL of the person's mobile-linked accounts at this
    // restaurant (same person, one number). FIFO by reward id (oldest first),
    // only live + redeemable + with remaining balance.
    const ids = await linkedRewardIds(customerId);   // app_ids — reward tables key on app_id
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
        // Keyed on app_id (`rcid`), NOT our customer.id — exactly like the
        // rows in `customer_rewards` this spend draws down (legacy
        // OrderController.php:922-928 uses identity->app_id for both). Writing
        // customer.id here put the spend ledger in a different id space from
        // the reward pool, so redemptions never reconciled against earnings.
        await trx('customer_used_rewards').insert({
            company_id:      companyId,
            customer_id:     rcid,
            order_id:        orderId,
            used_amount:     consumed,
            related_json:    JSON.stringify(breakdown),
            order_cancelled: 0,
            created_at:      db.fn.now(),
            created_by:      rcid,
        });
    }
    return { consumed, breakdown };
}

/**
 * burnUnusedStamps
 *
 * What:  Expires the customer's UNUSED stamp-card rewards at this restaurant —
 *        the "use it or lose it" rule the legacy checkout advertises:
 *          "Stamp reward must be fully used in this order. Any unused balance
 *           will expire automatically."
 *
 *        A STAMP reward is identified exactly like legacy: tier_type IS NOT
 *        NULL (only entity_type='cashback' rows carry it). Anything still live
 *        with a remaining balance is flipped to:
 *            is_expired = 1, expired_from = 4 ("Not Used"), expiry_date = now
 *
 *        Legacy runs this on EVERY order (webordering OrderController): after a
 *        redeem it burns what's left of the stamp set, and when the customer
 *        redeemed NOTHING it burns every live stamp. Both branches mean the
 *        same thing — an order either uses the stamp balance or loses it.
 *
 *        Without this the marketplace's stamp balances would accumulate for
 *        ever (we already READ expired_from=4 as "expired" in the history
 *        filter — the reader existed, this is the missing writer).
 *
 * Type:  WRITE (transactional — caller's trx, inside the order-place txn).
 * Inputs: trx, { customerId, companyId }
 * Output: { burned } — how many stamp rows were expired.
 */
async function burnUnusedStamps(trx, { customerId, companyId }) {
    if (!trx || !customerId || !hasScope(companyId)) { return { burned: 0 }; }
    try {
        // Same person across mobile-linked accounts, same restaurant scope.
        const ids = await linkedRewardIds(customerId);   // app_ids — reward tables key on app_id
        if (!ids.length) { return { burned: 0 }; }
        const burned = await trx(REWARDS)
            .whereIn('customer_id', ids)
            .andWhere({ company_id: companyId, is_expired: 0, is_redeemable: 1 })
            .whereNotNull('tier_type')                       // ⇒ a stamp reward
            .andWhereRaw('amount > COALESCE(used_amount, 0)') // still has balance
            .andWhere(function () {                           // not already lapsed
                this.whereNull('expiry_date').orWhere('expiry_date', '>=', db.fn.now());
            })
            .update({ is_expired: 1, expired_from: 4, expiry_date: db.fn.now() });
        return { burned: Number(burned) || 0 };
    } catch (e) {
        // Best-effort: never fail an order over the stamp sweep.
        try { H.log.warn('loyalty.burnUnusedStamps', e && e.message); } catch (_) { /* noop */ }
        return { burned: 0 };
    }
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return; }
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
            // duration_type: 1 = weekly cycle, 2 = monthly cycle. Anything else
            // is an unusable rule → skip. The cycle itself is enforced by the
            // window reset inside each type below (against last_order_date) —
            // both types now count via the stored progress row, so there's no
            // date-window order re-count any more.
            const durType = Number(row.duration_type);
            if (durType !== 1 && durType !== 2) { continue; }

            const target = parseInt(row.order_count, 10) || 0;
            const minAmt = Number(row.min_order_amount) || 0;

            // ── type 1: STREAK ──────────────────────────────────────
            if (Number(row.type) === 1) {
                let prog = await db(STREAK_PROG)
                    .where({ company_id: companyId, customer_id: rcid, rule_id: row.id })
                    .first();
                const isNew = !prog;
                if (!prog) {
                    prog = {
                        company_id: companyId, customer_id: rcid, rule_id: row.id,
                        current_streak: 0, reward_ready: 0, last_order_date: null,
                    };
                }

                // Weekly / monthly window elapsed → reset.
                const last = fmtDate(prog.last_order_date);
                if (last) {
                    if (durType === 1 && last < mondayThisWeek()) { prog.current_streak = 0; prog.reward_ready = 0; }
                    if (durType === 2 && last < firstOfMonth())   { prog.current_streak = 0; prog.reward_ready = 0; }
                }

                // Previous streak already COMPLETED → pay it out on this order
                // REGARDLESS of the current order's amount. Legacy comment:
                // "Reward already earned. Give cashback regardless of current
                // order amount." This MUST be checked before the min-amount
                // guard below — otherwise a customer who earned the reward and
                // then places a small order silently loses it.
                if (Number(prog.reward_ready) === 1) {
                    matchedRule = row;
                    prog.reward_ready = 0;
                    // Start the NEXT streak only if THIS order itself qualifies.
                    prog.current_streak = (orderAmount >= minAmt) ? 1 : 0;
                    prog.last_order_date = today;
                    await saveStreakProgress(prog, isNew, customerId);
                    break;
                }

                // Below the rule's minimum → this order doesn't advance the
                // streak (and can't have completed one, handled above).
                if (orderAmount < minAmt) {
                    if (!isNew) {
                        await db(STREAK_PROG)
                            .where({ company_id: companyId, customer_id: rcid, rule_id: row.id })
                            .update({ current_streak: 0, reward_ready: 0 });
                    }
                    continue;
                }

                // Advance the counter. The day-gap is measured against the last
                // QUALIFYING order (sub_total >= min, placed BEFORE this one) —
                // legacy reads the real Orders table, not progress.last_order_date,
                // so an in-between order UNDER the minimum neither extends nor
                // breaks the streak.
                const lastQualifying = await db('orders')
                    .where({ company_id: companyId, user_id: customerId, status: '1', order_status: '' })
                    .andWhere('sub_total', '>=', minAmt)
                    .andWhere('id', '<', orderId)
                    .orderBy('id', 'desc')
                    .first('created_at');

                if (!lastQualifying) {
                    prog.current_streak = 1;
                } else {
                    const dd = dayDiffStr(today, fmtDate(lastQualifying.created_at));
                    // Same or consecutive day → continue the streak; a gap resets it.
                    if (dd === 0 || dd === 1) { prog.current_streak = (Number(prog.current_streak) || 0) + 1; }
                    else { prog.current_streak = 1; }
                }
                if ((Number(prog.current_streak) || 0) >= target) { prog.reward_ready = 1; }
                prog.last_order_date = today;
                await saveStreakProgress(prog, isNew, customerId);
            }

            // ── type 2: MILESTONE ───────────────────────────────────
            // Same progress-counter + reward_ready pattern as type 1, but with
            // NO day-gap rule: a milestone just counts QUALIFYING orders, and
            // legacy pays the reward on the NEXT order after the count is hit
            // ("Milestone completed / Cashback on NEXT order").
            //
            // This used to re-COUNT orders in a month window and award on
            // `cnt > target && (cnt-1) % target === 0`, which awards at
            // different times than legacy and ignores the stored counter (so a
            // window reset or a cycle restart was never honoured).
            if (Number(row.type) === 2) {
                let prog = await db(STREAK_PROG)
                    .where({ company_id: companyId, customer_id: rcid, rule_id: row.id })
                    .first();
                const isNew = !prog;
                if (!prog) {
                    prog = {
                        company_id: companyId, customer_id: rcid, rule_id: row.id,
                        current_streak: 0, reward_ready: 0, last_order_date: null,
                    };
                }

                // Weekly / monthly window elapsed → reset the cycle.
                const last = fmtDate(prog.last_order_date);
                if (last) {
                    if (durType === 1 && last < mondayThisWeek()) { prog.current_streak = 0; prog.reward_ready = 0; }
                    if (durType === 2 && last < firstOfMonth())   { prog.current_streak = 0; prog.reward_ready = 0; }
                }

                // Milestone hit on an EARLIER order → pay out now, regardless of
                // this order's amount (same rule as type 1).
                if (Number(prog.reward_ready) === 1) {
                    matchedRule = row;
                    prog.reward_ready = 0;
                    // Start the next cycle only if THIS order qualifies.
                    prog.current_streak = (orderAmount >= minAmt) ? 1 : 0;
                    prog.last_order_date = today;
                    await saveStreakProgress(prog, isNew, customerId);
                    break;
                }

                // Count ONLY qualifying orders; hitting the target arms the
                // reward for the next order.
                if (orderAmount >= minAmt) {
                    prog.current_streak = (Number(prog.current_streak) || 0) + 1;
                    if ((Number(prog.current_streak) || 0) >= target) { prog.reward_ready = 1; }
                }
                prog.last_order_date = today;
                await saveStreakProgress(prog, isNew, customerId);
            }
        }

        if (!matchedRule) { return; }

        // Idempotency — never reward the same (rule, order) twice.
        const already = await db(REWARDS).where({
            company_id: companyId, customer_id: rcid,
            entity_type: 'product_streak', entity_id: matchedRule.id, related_id: orderId,
        }).first();
        if (already) { return; }

        let amount = Number(matchedRule.cashback) || 0;
        if (String(matchedRule.value_type) === '%') {
            amount = orderAmount * (Number(matchedRule.cashback) || 0) / 100;
        }
        amount = round2(amount);
        if (amount <= 0) { return; }

        // Granted through the SHARED award() path — same as every other rule.
        // This used to hand-roll its own ledger insert + commission skim, which
        // drifted in one important way: it hardcoded notify_date = null, so a
        // streak reward could never be picked up by the expiry job's "expires
        // soon" notify pass (it matches DATE(notify_date) = today) and would
        // silently expire on the customer. award() derives notify_date from
        // cfg.notify_before_days like legacy saveReward does.
        await award({
            companyId, customerId,
            entityType: 'product_streak',
            entityId:   matchedRule.id,
            relatedId:  orderId,
            amount,                  // GROSS — award() does the commission skim
            jsonData:   matchedRule,
            cfg,
        });
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return null; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return null; }
        if (!(await ruleEnabled(companyId, 'product_streak'))) { return null; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return null; }
        const rule = await db(STREAK_RULE)
            .where({ company_id: companyId }).whereNull('deleted_at')
            .orderBy('order_count', 'desc').first();
        if (!rule) { return null; }

        const prog = await db(STREAK_PROG)
            .where({ company_id: companyId, customer_id: rcid, rule_id: rule.id }).first();
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

    // Callers pass our customer.id; customer_rewards keys on app_id (legacy
    // semantics — see customerLookup.appIdOf). We credit the RESTAURANT's own
    // identity for this mobile when it exists, else the marketplace app_id
    // (rewardIdentityFor). No app_id ⇒ don't invent one: a wrong id credits the
    // wrong person.
    //
    // rewardResolveByCompany === false OPTS OUT (the review-claim caller): its
    // opts.customerId is the claim's own DUAL-identity id — customer.id for a
    // marketplace claim, app_id for a legacy claim — so it must keep the plain
    // appIdOf path and NOT be re-resolved against a company.
    const rewardCustomerId = (opts.rewardResolveByCompany === false)
        ? await customers.appIdOf(opts.customerId)
        : await rewardIdentityFor(opts.customerId, opts.companyId);
    if (rewardCustomerId === null) {
        H.log.error('loyalty.award', 'customer ' + opts.customerId + ' has no app_id — reward skipped');
        return false;
    }
    // Marketplace-channel earn — stamp is_marketplace = 1 where the column exists.
    const rewardMp = await hasRewardMpCol();

    const commPct    = Number(cfg.loyalty_commission) || 0;
    const commission = commPct > 0 ? round2(gross * commPct / 100) : 0;
    const net        = round2(gross - commission);
    if (net <= 0) { return false; }

    const days = (opts.expiryDays != null)
        ? Number(opts.expiryDays)
        : (Number(cfg.expiry_duration_days) || 0);
    const expiryDate = days > 0 ? new Date(Date.now() + days * 86400000) : null;
    // notify_date = expiry − notify_before_days, exactly like legacy saveReward
    // (and like earnForOrder above). This was hardcoded null, so every reward
    // granted through award() — event, review, streak, product, special_offer,
    // smart_campaign, referral — could NEVER be picked up by the expiry job's
    // "expires soon" notify pass. Only cash_king was setting it.
    const notifyDays = Number(cfg.notify_before_days) || 0;
    const notifyDate = (days > 0 && notifyDays > 0)
        ? new Date(Date.now() + (days - notifyDays) * 86400000)
        : null;

    const inserted = await db(REWARDS).insert({
        uuid:          crypto.randomUUID(),
        company_id:    opts.companyId,
        customer_id:   rewardCustomerId,   // app_id, not our customer.id
        created_via:   CREATED_VIA_MARKETPLACE,   // 5 — marketplace channel
        ...(rewardMp ? { is_marketplace: 1 } : {}),
        entity_type:   opts.entityType,
        entity_id:     opts.entityId != null ? opts.entityId : null,
        related_id:    opts.relatedId != null ? opts.relatedId : null,
        amount:        net,
        used_amount:   0,
        tier_type:     opts.tierType != null ? opts.tierType : null,
        is_redeemable: opts.isRedeemable != null ? opts.isRedeemable : 1,
        is_expired:    0,
        expiry_date:   expiryDate,
        notify_date:   notifyDate,
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
                customer_id:        rewardCustomerId,   // app_id, as above
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return; }
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
                .where({ customer_id: rcid, company_id: companyId })
                .whereNotNull('tier_type').count({ c: '*' }).first();
            const total = Number(cntRow && cntRow.c) || 0;
            if (total > 0 && total % requiredCount === 0) {
                const locked = await db(REWARDS)
                    .where({ customer_id: rcid, company_id: companyId, is_expired: 0, is_redeemable: 0 })
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
        if (!customerId || !hasScope(companyId) || !productId || !(await isReady())) { return; }
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return; }
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
            .where({ company_id: companyId, customer_id: rcid, entity_type: 'special_offer', entity_id: rule.id })
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return; }
        if (!(await ruleEnabled(companyId, 'referral'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        // FIRST completed order at this restaurant only.
        const prior = await db('orders')
            .where({ company_id: companyId, user_id: customerId, status: '1' })
            .andWhere('id', '!=', orderId).first('id');
        if (prior) { return; }

        const cust = await db('customer').where({ id: customerId }).first('referred_by', 'company_id');
        const referredBy = await resolveReferrerId(cust);
        if (referredBy == null) { return; }

        const rule = await db('loyalty_referral_cashback_rule')
            .where({ company_id: companyId, trigger: 2 }).whereNull('deleted_at').first();
        if (!rule) { return; }
        const referrerCb = Number(rule.referrer_cashback) || 0;
        const refereeCb  = Number(rule.referee_cashback) || 0;
        if (referrerCb <= 0 && refereeCb <= 0) { return; }

        const already = await db(REWARDS)
            .where({ company_id: companyId, customer_id: rcid, entity_type: 'referral', entity_id: rule.id }).first();
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
 * What:  Legacy 'event_cashback' — a one-off bonus from
 *        loyalty_event_cashback_rule for a customer LIFECYCLE event:
 *          1 = signup, 2 = profile completion, 3 = google review
 *        (the SAME meanings the admin console writes — see
 *        Controllers/Admin/LoyaltyController EVENT_TYPES).
 *
 *        The TRIGGER passes `eventType` in; this function never derives it.
 *        Legacy fires exactly one of these today: type 2, from the profile-save
 *        path when a customer_profile row is newly CREATED (webordering
 *        SiteController) — NOT at order-place.
 *
 *        Idempotent per (customer, rule). Master-gated.
 * Type:  WRITE. Best-effort.
 *
 * Inputs: { customerId, companyId, eventType (1|2|3), relatedId }
 */
async function earnEventCashback({ customerId, companyId, eventType, relatedId }) {
    try {
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
        // These tables key on app_id (legacy), not our customer.id — see
        // customerLookup.appIdOf. award() translates on its own, so it still
        // takes customerId; only the direct queries below use rcid.
        const rcid = await customers.appIdOf(customerId);
        if (rcid === null) { return; }
        // eventType is passed IN by the trigger — never derived here. Legacy
        // (CustomerRewards::customerCashback) looks the rule up by the caller's
        // eventType exactly like this.
        const type = Number(eventType) || 0;
        if (!EVENT_TYPES.includes(type)) { return; }
        if (!(await ruleEnabled(companyId, 'event_cashback'))) { return; }
        const cfg = await loadConfig(companyId);
        if (!cfg) { return; }

        const rule = await db('loyalty_event_cashback_rule')
            .where({ company_id: companyId, event_type: type }).whereNull('deleted_at').first();
        if (!rule || Number(rule.cashback) <= 0) { return; }

        // Once per customer per rule (legacy `$alreadyGiven`).
        const already = await db(REWARDS)
            .where({ company_id: companyId, customer_id: rcid, entity_type: 'event_cashback', entity_id: rule.id }).first();
        if (already) { return; }

        await award({ companyId, customerId, entityType: 'event_cashback', entityId: rule.id, relatedId, amount: Number(rule.cashback) || 0, jsonData: rule, cfg });
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
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
        if (!hasScope(companyId) || !customerId || !(await isReady())) { return false; }
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
        if (!customerId || !hasScope(companyId) || !(await isReady())) { return; }
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
        if (!productId || !hasScope(companyId) || !(await isReady())) { return null; }
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
        if (!hasScope(companyId) || !(await isReady())) { return map; }
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

/**
 * productCashbackMapFor — per-product cashback for a WHOLE company's menu in
 * one pass, for the "Cashback £X" badge (same idea as bogoMapFor). Returns
 * Map<product_id, { amount }> where amount is the flat £ reward per unit that
 * earnProductCashback grants (rule.cashback). Master-gated; empty when
 * loyalty / product_cashback is off. First rule per product wins.
 * Type:  READ.
 */
async function productCashbackMapFor(companyId) {
    const map = new Map();
    try {
        if (!hasScope(companyId) || !(await isReady())) { return map; }
        if (!(await ruleEnabled(companyId, 'product_cashback'))) { return map; }
        if (!(await loadConfig(companyId))) { return map; }
        const rows = await db('loyalty_product_cashback_rule as r')
            .innerJoin('loyalty_product_cashback_items as i', 'i.product_cashback_rule_id', 'r.id')
            .where('r.company_id', companyId)
            .whereNull('r.deleted_at').whereNull('i.deleted_at')
            .select('i.product_id', 'r.cashback');
        rows.forEach((row) => {
            const amt = Number(row.cashback) || 0;
            const k = String(row.product_id);
            if (amt > 0 && !map.has(k)) { map.set(k, { amount: amt }); }
        });
    } catch (e) { /* best-effort — no badges on error */ }
    return map;
}

module.exports = {
    isReady, loadConfig, ruleEnabled, getCustomerTier, getFreeDelivery,
    earnForOrder, earnOrderStreak, earnStampCashback, earnProductCashback, earnSpecialOffer,
    earnReferral, earnEventCashback, earnSmartCampaign, earnCollectionCashback,
    bogoForProduct, payableQtyFor, bogoMapFor, productCashbackMapFor,
    balanceFor, cardsFor, historyFor, reviewTypesFor, reviewRestaurants, maxRedeemable, consumeForRedeem, burnUnusedStamps, reverseForOrder, streakProgressFor,
    // Dual redeem — the restaurant's pool + the marketplace's, on one order.
    redeemPoolsFor, consumeAcrossPools,
    linkedCustomerIds,
    // Shared reward-write (commission skim + expiry + ledger + audit row).
    // Exposed so the admin Review-Claims approval can grant a review reward
    // through the SAME path the earn rules use — keeping the ledger consistent.
    award,
    // Loyalty scope helpers — company_id 0 is the MARKETPLACE's own programme
    // (super-admin owned, is_marketplace=1 on the row). Exported so the cart /
    // order-place / admin can reason about the two pools without re-deriving
    // the rule (and without a `!companyId` check, which 0 would fail).
    MARKETPLACE_COMPANY_ID, MARKETPLACE_LABEL, hasScope, isMarketplaceScope,
    // customer_review identity resolvers. customer_id means customer.id at
    // company_id 0 (our marketplace) but app_id at company_id > 0 (legacy) —
    // and the two collide across DIFFERENT real people, so joining on the wrong
    // one shows and pays the WRONG customer. See the block comment above
    // joinReviewCustomer for the full rule + why we don't migrate the data.
    joinReviewCustomer, rewardCustomerIdFor,
    // The marketplace's reserved public slug + its resolver. company_id 0 has no
    // company row, so companyIdBySlug() can NEVER resolve it — check this first.
    MARKETPLACE_SLUG, scopeFromSlug,
    // customer.referred_by is a customer.id for OUR signups but an app_id for
    // legacy ones — this resolves either to the real customer.id.
    resolveReferrerId,
};
