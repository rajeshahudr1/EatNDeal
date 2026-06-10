'use strict';

/*
 * Helpers/customerProfile.js
 *
 * What:  Read + sanitise + serialise the marketplace customer's optional
 *        "About You" profile, stored in the EXISTING legacy `customer_profile`
 *        table (reused — NOT a new mp_ table, per the "if a migration already
 *        exists, use it" rule). One row per customer.
 *
 *        Scope note: customer_profile also has gender / dob columns, but we
 *        deliberately DON'T touch those here — gender + date-of-birth live on
 *        the `customer` row (customer.gender / customer.birthdate) and photo
 *        on customer.image, all saved by AuthController.updateProfile /
 *        updateAvatar exactly as before. This helper only owns the extra
 *        personalisation fields (anniversary + the About-You questions).
 *
 *        Marketplace rows store company_id = 0 (the table's company_id is
 *        NOT NULL, but a marketplace customer isn't tied to one restaurant).
 *        Lookups key on customer_id alone — it's globally unique in the
 *        `customer` table, so it can't collide with a legacy per-tenant row.
 *
 * Why:   Keeps the controller thin: one place owns the allowed option
 *        lists, the JSON (de)serialisation of the multi-select fields, and
 *        the "only write what was sent" upsert mapping.
 *
 * Used:  api/Controllers/Customer/AuthController.js — getAbout + updateAbout.
 *
 * Change log:
 *   2026-06-04 — initial; ported the "About You" fields from the legacy
 *                Yii customer_profile (common/config/params.php lists),
 *                reusing that existing table rather than a new mp_ one.
 */

const { db } = require('../config/db');

const TABLE = 'customer_profile';

// company_id sentinel for marketplace rows (the column is NOT NULL but a
// marketplace customer has no single tenant — see header note).
const MARKETPLACE_COMPANY_ID = 0;

// Allowed option tokens — mirror the legacy common/config/params.php lists
// (favoriteFoodCategory / orderType / takeawayFrequency / offerTime /
// hearAboutUs / marketingPreferences). Anything outside these is dropped
// server-side, so the DB only ever holds known tokens.
const OPTIONS = {
    favorite_food_category: ['pizzas', 'kebabs', 'burgers', 'grill_food', 'desserts', 'curries', 'chinese', 'english', 'other'],
    order_type:             ['collection', 'delivery', 'eat_in'],
    takeaway_frequency:     ['weekly', 'monthly', 'occasionally'],
    offer_time:             ['lunch', 'afternoon', 'evening', 'late_night', 'weekdays', 'weekends'],
    hear_about_us:          ['tiktok', 'facebook', 'instagram', 'friend', 'google', 'walk_in'],
    marketing_preferences:  ['exclusive_discounts', 'birthday_rewards', 'early_access_offers', 'sms_updates', 'whatsapp_offers'],
};

// Whether customer_profile exists yet (legacy m260506_112337 + later
// column-adding migrations). Checked once + cached so the endpoints degrade
// gracefully on a DB where the migrations haven't been run — never a hard
// error.
let _exists = null;
async function tableExists() {
    if (_exists !== null) { return _exists; }
    try {
        const r = await db.raw(
            'select 1 from information_schema.tables where table_name = ? limit 1',
            [TABLE],
        );
        const rows = r && (r.rows || r);
        _exists = Array.isArray(rows) ? rows.length > 0 : false;
    } catch (e) { _exists = false; }
    return _exists;
}

// ── small coercers ─────────────────────────────────────────────────
// Postgres returns a `date` column as a JS Date at LOCAL midnight, so we
// format from the local parts (a naive toISOString() would shift a day in
// negative-offset zones). Strings pass through after a YYYY-MM-DD check.
function toISODate(v) {
    if (!v) { return ''; }
    if (v instanceof Date) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }
    const mt = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return mt ? mt[0] : '';
}

function parseArr(v) {
    if (Array.isArray(v)) { return v; }
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
}

function num(v) {
    if (v == null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Keep only the allowed, de-duplicated tokens from a (possibly single)
// value — checkboxes arrive as an array, or as a lone string when exactly
// one is ticked.
function cleanArr(v, allowed) {
    const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const x = String(list[i]).trim();
        if (allowed.indexOf(x) !== -1 && out.indexOf(x) === -1) { out.push(x); }
    }
    return out;
}

function oneOf(v, allowed) {
    const s = String(v == null ? '' : v).trim();
    return allowed.indexOf(s) !== -1 ? s : null;
}

function yesNo(v) {
    if (v === 1 || v === '1' || v === true)  { return 1; }
    if (v === 0 || v === '0' || v === false) { return 0; }
    return null;
}

/**
 * view
 *
 * What:  The web/app-facing shape of a saved profile row — multi-selects
 *        decoded back to arrays, yes/no as 0|1|null, dates as YYYY-MM-DD.
 *        Returns null when there's no row yet.
 * Type:  READ (pure).
 */
function view(row) {
    if (!row) { return null; }
    return {
        // gender + dob live HERE (customer_profile), not on the customer
        // row — the customer.gender migration was dropped; only the photo
        // (customer.image) stays on customer.
        gender:                       row.gender || '',
        dob:                          toISODate(row.dob),
        anniversary_date:             toISODate(row.anniversary_date),
        favorite_food_category:       parseArr(row.favorite_food_category),
        other_food_category:          row.other_food_category || '',
        order_type:                   row.order_type || '',
        takeaway_frequency:           row.takeaway_frequency || '',
        offer_time:                   parseArr(row.offer_time),
        hear_about_us:                row.hear_about_us || '',
        work_in_hospitality_industry: num(row.work_in_hospitality_industry),
        family_size:                  num(row.family_size),
        has_children:                 num(row.has_children),
        is_student:                   num(row.is_student),
        work_nearby:                  num(row.work_nearby),
        marketing_preferences:        parseArr(row.marketing_preferences),
    };
}

/**
 * buildWrite
 *
 * What:  Maps an incoming (already Joi-validated) body to DB columns. Only
 *        keys actually PRESENT on the body are written, so a partial save
 *        touches just what it sends. Multi-selects are JSON-stringified; the
 *        "other food" free text is cleared unless "other" is chosen (legacy
 *        beforeSave parity).
 * Type:  READ (pure) — returns a column→value object; the caller persists.
 */
function buildWrite(body) {
    const w = {};
    const has = function (k) { return Object.prototype.hasOwnProperty.call(body, k); };

    // gender + dob now belong to this table (customer_profile), saved here
    // instead of on the customer row.
    if (has('gender')) { w.gender = oneOf(body.gender, ['male', 'female', 'other', 'na']); }
    if (has('dob')) {
        const d = String(body.dob || '').trim();
        w.dob = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }

    let favourites = null;
    if (has('favorite_food_category')) {
        favourites = cleanArr(body.favorite_food_category, OPTIONS.favorite_food_category);
        w.favorite_food_category = JSON.stringify(favourites);
    }
    if (has('other_food_category')) {
        // Only keep the free text when "other" is among the chosen
        // categories — matches the legacy customer_profile beforeSave().
        const chosenOther = favourites ? (favourites.indexOf('other') !== -1) : true;
        const txt = String(body.other_food_category || '').trim().slice(0, 255);
        w.other_food_category = (chosenOther && txt) ? txt : null;
    }
    if (has('order_type'))            { w.order_type = oneOf(body.order_type, OPTIONS.order_type); }
    if (has('takeaway_frequency'))    { w.takeaway_frequency = oneOf(body.takeaway_frequency, OPTIONS.takeaway_frequency); }
    if (has('offer_time'))            { w.offer_time = JSON.stringify(cleanArr(body.offer_time, OPTIONS.offer_time)); }
    if (has('hear_about_us'))         { w.hear_about_us = oneOf(body.hear_about_us, OPTIONS.hear_about_us); }
    if (has('marketing_preferences')) { w.marketing_preferences = JSON.stringify(cleanArr(body.marketing_preferences, OPTIONS.marketing_preferences)); }
    if (has('work_in_hospitality_industry')) { w.work_in_hospitality_industry = yesNo(body.work_in_hospitality_industry); }
    if (has('has_children'))          { w.has_children = yesNo(body.has_children); }
    if (has('is_student'))            { w.is_student = yesNo(body.is_student); }
    if (has('work_nearby'))           { w.work_nearby = yesNo(body.work_nearby); }
    if (has('family_size')) {
        const n = num(body.family_size);
        w.family_size = (n == null) ? null : Math.max(0, Math.min(99, Math.trunc(n)));
    }
    if (has('anniversary_date')) {
        const d = String(body.anniversary_date || '').trim();
        w.anniversary_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }
    return w;
}

module.exports = { TABLE, MARKETPLACE_COMPANY_ID, OPTIONS, tableExists, view, buildWrite };
