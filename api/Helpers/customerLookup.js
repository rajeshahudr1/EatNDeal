'use strict';

/*
 * Helpers/customerLookup.js
 *
 * What:  Look up + status-check a customer row in the live `customer`
 *        table. Powers the post-OTP branch: if the verified phone number
 *        belongs to a clean, fully-registered customer → skip the
 *        Personal Details step; if not → show it.
 *
 *        Marketplace-only filter: `company_id IS NULL`. The legacy Yii
 *        system stores per-tenant rows (each company has its own
 *        customer set, joined by `company_id`); marketplace customers
 *        live alongside those rows with company_id NULL so they don't
 *        collide with any restaurant's customer base.
 *
 *        Status rules ported from the Yii queries
 *        (SiteController.php — `andWhere(['<>', 'status', '2'])`):
 *          status = '1'  → active
 *          status = '0'  → disabled (Yii treats as login-blocked)
 *          status = '2'  → soft-deleted (Yii excludes entirely)
 *          banned_reason set → banned (independent of status)
 *          is_registered = 1 → has a saved Personal-Details profile
 *          is_registered = 0 → OTP-only stub, no profile yet
 *
 * Why:   One place for the "is this customer allowed to sign in" rule,
 *        so the same wording shows on every entry-point.
 *
 * Used:  api/Controllers/Customer/AuthController.js — verifyOtp +
 *        saveProfile both call this.
 *
 * Change log:
 *   2026-05-26 — initial.
 */

const { db } = require('../config/db');
const MSG    = require('./messages');

const TABLE = 'customer';

/**
 * normalisePhone
 *
 * What:  Strip spaces / hyphens / parens / leading "+" so the value we
 *        query with matches what we (and the Yii system) actually wrote
 *        into `contact_no`.
 * Why:   Same shape as Helpers/otpSender.js — kept duplicated rather
 *        than imported, so otpSender stays free to evolve independently.
 * Type:  READ (pure).
 */
function normalisePhone(raw) {
    return String(raw || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
}

/**
 * findByPhone
 *
 * What:  Returns the most-recent matching row for (country_code, contact_no)
 *        on a marketplace customer (company_id IS NULL). NULL when no
 *        match exists.
 * Why:   Verify + save-profile both need to know "does a row exist
 *        already, and what's its state". Wrapped here so both endpoints
 *        agree on the WHERE clause.
 * Type:  READ.
 *
 * Inputs:
 *   countryCode — '44' style, no '+'
 *   contactNo   — raw phone, normalised internally
 *
 * Output: customer row | null.
 */
async function findByPhone({ countryCode, contactNo }) {
    const country = normalisePhone(countryCode);
    const contact = normalisePhone(contactNo);
    if (!contact) { return null; }

    // country_code is INTEGER in the schema; coerce so the index is used
    // and we don't have to depend on Postgres' implicit cast.
    const country_int = Number(country) || 0;

    return db(TABLE)
        .where({ contact_no: contact, country_code: country_int })
        .whereNull('company_id')
        .orderBy('id', 'desc')
        .first();
}

/**
 * classify
 *
 * What:  Turns a customer row into a coarse status the front-end can
 *        branch on without knowing the schema:
 *
 *          'new'       — no row at all  → show Personal Details
 *          'pending'   — row exists but is_registered=0 → show Personal Details,
 *                        and the save step will UPDATE rather than INSERT
 *          'existing'  — registered + clean → skip Personal Details, go to landing
 *          'disabled'  — status='0' → block sign-in
 *          'deleted'   — status='2' → block sign-in (look like "doesn't exist")
 *          'banned'    — banned_reason set → block sign-in
 *
 * Why:   Keeps the controller branching readable. One vocabulary across
 *        verifyOtp + saveProfile + the front-end + future Flutter app.
 * Type:  READ (pure).
 */
function classify(row) {
    if (!row) { return 'new'; }
    const status = String(row.status || '').trim();
    const banned = String(row.banned_reason || '').trim();

    if (status === '2')       { return 'deleted'; }
    if (status === '0')       { return 'disabled'; }
    if (banned.length > 0)    { return 'banned'; }
    if (Number(row.is_registered) === 1) { return 'existing'; }
    return 'pending';
}

/**
 * publicView
 *
 * What:  Strips the customer row down to the fields the web / app are
 *        allowed to see. NO password, NO auth_key, NO referral/internal
 *        bookkeeping.
 * Why:   Defensive — even though we set Content-Type: application/json
 *        and a logged-in user owns this row, the row also has columns
 *        (auth_key, password) that should never leave the server.
 * Type:  READ (pure).
 */
function publicView(row) {
    if (!row) { return null; }
    return {
        id:            String(row.id),
        firstname:     row.firstname || '',
        lastname:      row.lastname || '',
        email:         row.email || '',
        contact_no:    row.contact_no || '',
        country_code:  row.country_code != null ? String(row.country_code) : '',
        // Profile-edit fields. birthdate MUST be returned or the account
        // form shows it blank and a save would wipe the stored value.
        // gender is read defensively — it's '' until the column exists
        // (see the m260529 gender migration).
        birthdate:     row.birthdate || '',
        gender:        row.gender != null ? String(row.gender) : '',
        image:         row.image != null ? String(row.image) : '',
        loyalty_points: Number(row.loyalty_points) || 0,
        is_registered: Number(row.is_registered) === 1,
        // The customer's OWN referral code — shown on their Rewards
        // "Invite & Earn" card so they can share it (legacy webordering
        // shows it on the profile page). Safe to expose to the owner.
        referral_code: row.referral_code || '',
    };
}

// ── Referral code generation (matches legacy common/helper
//    generateReferralCode) ─────────────────────────────────────────
// 8 uppercase chars from a set that omits the ambiguous I/O/0/1.
const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateReferralCode(length = 8) {
    const a = REFERRAL_CHARS.split('');
    for (let i = a.length - 1; i > 0; i--) {            // Fisher-Yates (≈ PHP str_shuffle)
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.slice(0, length).join('');
}

/**
 * resolveReferrer — given a typed referral code, return the marketplace
 * customer id that owns it (or null). Global (company_id NULL) lookup —
 * the marketplace has one customer per person across all restaurants.
 */
async function resolveReferrer(referredCode) {
    const code = String(referredCode || '').trim().toUpperCase();
    if (!code) { return null; }
    const { db } = require('../config/db');
    const row = await db('customer')
        .whereRaw('UPPER(referral_code) = ?', [code])
        .whereNull('company_id')
        .first('id');
    return row ? String(row.id) : null;
}

/**
 * loadMarketplaceCustomer
 *
 * What:  THE one guard every authed marketplace endpoint should call
 *        BEFORE touching customer-scoped data (addresses, favourites,
 *        orders…). Returns either:
 *           { row }                       — caller proceeds
 *           { error: { msg, status } }    — caller relays via H.errorResponse
 *
 *        Rules:
 *          • `company_id IS NULL` — marketplace customer (not a tenant staff
 *            account).
 *          • classify(row) gates: disabled / deleted / banned all reject
 *            with the canonical wording.
 *
 *        Was previously duplicated in AddressController + FavouriteController.
 *        Single source of truth means a future status rule (e.g. "soft-
 *        suspended" pending KYC) auto-applies everywhere.
 * Type:  READ.
 */
async function loadMarketplaceCustomer(customerId) {
    const row = await db(TABLE)
        .where({ id: customerId })
        .whereNull('company_id')
        .first();
    if (!row) { return { error: { msg: MSG.resource.notFound, status: 404 } }; }

    const state = classify(row);
    if (state === 'deleted' || state === 'disabled') {
        return { error: { msg: MSG.auth.accountDisabled, status: 403 } };
    }
    if (state === 'banned') {
        return { error: { msg: MSG.auth.accountBanned, status: 403 } };
    }
    return { row };
}

/**
 * coerceNum
 *
 * What:  Number-or-null. Empty / non-numeric inputs return null so the
 *        caller can decide "treat as missing" instead of getting NaN.
 * Type:  READ (pure).
 */
function coerceNum(v) {
    if (v == null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

module.exports = {
    findByPhone,
    classify,
    publicView,
    normalisePhone,
    loadMarketplaceCustomer,
    coerceNum,
    generateReferralCode,
    resolveReferrer,
};
