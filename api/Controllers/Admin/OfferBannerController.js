'use strict';

/*
 * Controllers/Admin/OfferBannerController.js
 *
 * What:  Super-admin CRUD for the marketplace OFFER BANNER carousel
 *        (mp_offer_banner + mp_offer_banner_assign). Each banner is an image
 *        (or text) card + a machine-readable RULE; clicking it on the home
 *        page opens a filtered restaurant grid resolved LIVE from the
 *        discount/coupon data (see Marketplace/OfferBannerController + the
 *        min_discount/coupon filter on Marketplace/RestaurantsController).
 *          GET  /admin/offer-banner            → list (search/status/sort/paged)
 *          GET  /admin/offer-banner/get?id=    → one banner (for the form)
 *          POST /admin/offer-banner/save       → create / update (+ manual pick)
 *          POST /admin/offer-banner/delete     → SOFT delete (status = 2)
 *          POST /admin/offer-banner/status     → activate / de-activate (1 / 0)
 *          POST /admin/offer-banner/reorder    → save carousel sort_order
 *          GET  /admin/offer-banner/companies  → restaurant autocomplete (manual pick)
 *          GET  /admin/offer-banner/restaurants→ a banner's picked restaurants
 * Type:  READ + WRITE (mp_offer_banner, mp_offer_banner_assign).
 * Used:  api/Routes/index.js — /admin/offer-banner/* (authenticate + super-admin).
 *
 * Mirrors Admin/CollectionsController (list/reorder/manual-pick) but uses the
 * SOFT-DELETE convention (status = 2, never hard .del()) like the welcome
 * banner, and carries the rule columns.
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');
const OB     = require('../../config/offerBanner');   // TYPE / RULE / STATUS enum IDs

const T        = 'mp_offer_banner';
const T_ASSIGN = 'mp_offer_banner_assign';

const SORTS = {
    sort_order:  ['sort_order', 'asc'],
    title_asc:   ['title', 'asc'],
    title_desc:  ['title', 'desc'],
    newest:      ['id', 'desc'],
};
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));

// Ordered id list — preserves the order the client sent (for positions).
function orderedIdList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    const seen = new Set();
    const out = [];
    arr.map((n) => Number(n)).forEach((n) => { if (n > 0 && !seen.has(n)) { seen.add(n); out.push(n); } });
    return out;
}
function imageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/marketplace/offer_banner/' + f;
}

// Table-exists guard (cached) — before the migration, the admin still loads.
let _ready = null;
async function ready() {
    if (_ready !== null) { return _ready; }
    try { const r = await db.raw("select to_regclass('public.mp_offer_banner') as t"); _ready = !!((r.rows || r)[0] || {}).t; }
    catch (e) { _ready = false; }
    return _ready;
}

// Normalise a raw row → the shape the admin UI expects.
function mapBanner(r) {
    return {
        id:           Number(r.id),
        title:        r.title || '',
        subtitle:     r.subtitle || '',
        image:        r.image || '',
        image_url:    imageUrl(r.image),
        content_type: Number(r.content_type) || OB.TYPE.IMAGE,
        rule_type:    Number(r.rule_type) || OB.RULE.MIN_DISCOUNT,
        rule_value:   r.rule_value == null ? '' : Number(r.rule_value),
        rule_code:    r.rule_code || '',
        category_id:  r.category_id == null ? '' : Number(r.category_id),
        link_url:     r.link_url || '',
        sort_order:   Number(r.sort_order) || 0,
        status:       Number(r.status),
    };
}

/**
 * list — GET /api/v1/admin/offer-banner
 * Search (q) + status filter + sort + pagination + per-row manual-pick count.
 * ALWAYS hides soft-deleted (status = 2) rows.
 */
async function list(req, res) {
    try {
        if (!(await ready())) {
            return H.successResponse(res, { enabled: false, banners: [], total: 0, page: 1, limit: 25, total_pages: 1 });
        }
        const q = String(req.query.q || '').trim().toLowerCase();
        const statusF = String(req.query.status || '');
        const sortKey = SORTS[req.query.sort] ? req.query.sort : 'sort_order';
        const sort = SORTS[sortKey];
        const limitRaw = String(req.query.limit || '25');
        const isAll = limitRaw === 'all';
        const limit = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);
        let page = Number(req.query.page) || 1;
        if (page < 1) { page = 1; }

        const base = () => db(T).modify((qb) => {
            qb.andWhere(T + '.status', '!=', OB.STATUS.DELETED);   // never show soft-deleted
            if (q) { qb.andWhereRaw('LOWER(title) LIKE ?', ['%' + q + '%']); }
            if (statusF === 'active') { qb.andWhere(T + '.status', OB.STATUS.ACTIVE); }
            else if (statusF === 'inactive') { qb.andWhere(T + '.status', OB.STATUS.INACTIVE); }
        });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        let qb = base()
            .leftJoin(db(T_ASSIGN).select('offer_banner_id').count('* as restaurants').groupBy('offer_banner_id').as('a'),
                'a.offer_banner_id', T + '.id')
            .select(T + '.id', T + '.title', T + '.subtitle', T + '.image', T + '.content_type',
                    T + '.rule_type', T + '.rule_value', T + '.rule_code', T + '.category_id',
                    T + '.link_url', T + '.status', T + '.sort_order',
                    db.raw('COALESCE(a.restaurants, 0) as restaurants'))
            .orderBy(T + '.' + sort[0], sort[1]);
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;

        const banners = rows.map((r) => ({ ...mapBanner(r), restaurants: Number(r.restaurants) || 0 }));
        return H.successResponse(res, {
            enabled: true, banners, total, page,
            limit: isAll ? 'all' : limit, total_pages: totalPages, sort: sortKey, status: statusF,
        });
    } catch (err) {
        console.error('[admin.offerBanner.list]', err && err.message);
        return H.errorResponse(res, 'Could not load offer banners.', 500);
    }
}

/** getBanner — GET /api/v1/admin/offer-banner/get?id= */
async function getBanner(req, res) {
    try {
        if (!(await ready())) { return H.errorResponse(res, 'Run the mp_offer_banner migration first (php yii migrate).', 422); }
        const id = Number(req.query.id) || 0;
        const maxRow = await db(T).where('status', '!=', OB.STATUS.DELETED).max('sort_order as m').first();
        const nextSort = (Number(maxRow && maxRow.m) || 0) + 1;
        if (!id) { return H.successResponse(res, { banner: null, next_sort: nextSort }); }
        const r = await db(T).where('id', id).andWhere('status', '!=', OB.STATUS.DELETED).first();
        if (!r) { return H.errorResponse(res, 'Offer banner not found.', 404); }
        return H.successResponse(res, { next_sort: nextSort, banner: mapBanner(r) });
    } catch (err) {
        console.error('[admin.offerBanner.getBanner]', err && err.message);
        return H.errorResponse(res, 'Could not load the offer banner.', 500);
    }
}

/**
 * save — POST /api/v1/admin/offer-banner/save
 * Create (no id) or update. Validates the chosen content + rule (only when the
 * banner is ACTIVE, so drafts can be saved incomplete).
 */
async function save(req, res) {
    try {
        if (!(await ready())) { return H.errorResponse(res, 'Run the mp_offer_banner migration first (php yii migrate).', 422); }
        const b = req.body;
        const id = Number(b.id) || 0;

        const type = Number(b.content_type) === OB.TYPE.TEXT ? OB.TYPE.TEXT : OB.TYPE.IMAGE;
        const validRules = Object.keys(OB.RULE).map((k) => OB.RULE[k]);
        const ruleType = validRules.includes(Number(b.rule_type)) ? Number(b.rule_type) : OB.RULE.MIN_DISCOUNT;
        // status: default ACTIVE; accept INACTIVE(0) / ACTIVE(1). Never set 2 here (that's delete).
        const status = Number(b.status) === OB.STATUS.INACTIVE ? OB.STATUS.INACTIVE : OB.STATUS.ACTIVE;

        // Rule params — only the one relevant to ruleType is persisted, the rest null.
        // rule_value = percent for MIN/UPTO (capped 100), amount £ for AMOUNT_OFF.
        const usesValue = [OB.RULE.MIN_DISCOUNT, OB.RULE.UPTO_DISCOUNT, OB.RULE.AMOUNT_OFF, OB.RULE.UPTO_AMOUNT].includes(ruleType);
        const isPercent = ruleType === OB.RULE.MIN_DISCOUNT || ruleType === OB.RULE.UPTO_DISCOUNT;
        let val = (b.rule_value === '' || b.rule_value == null) ? null : Number(b.rule_value);
        if (val != null) { val = Math.max(0, isPercent ? Math.min(100, val) : Math.min(100000, val)); }
        const code = str(b.rule_code).trim().slice(0, 40).toUpperCase();
        const catId = Number(b.category_id) > 0 ? Number(b.category_id) : null;

        const patch = {
            title:        str(b.title).slice(0, 255),
            subtitle:     str(b.subtitle).slice(0, 500),
            content_type: type,
            rule_type:    ruleType,
            rule_value:   usesValue ? val : null,
            rule_code:    ruleType === OB.RULE.COUPON_CODE ? code : null,
            category_id:  ruleType === OB.RULE.CATEGORY ? catId : null,
            link_url:     str(b.link_url).slice(0, 500),
            sort_order:   Number(b.sort_order) || 0,
            status,
            updated_at:   nowStr(),
        };
        // Only overwrite the image when a NEW file was uploaded (multer stamped
        // the relative /upload/offer_banner/<file> path onto b.image).
        if (b.image) { patch.image = str(b.image).slice(0, 255); }

        const existing = id ? await db(T).where('id', id).first() : null;
        if (id && (!existing || Number(existing.status) === OB.STATUS.DELETED)) {
            return H.errorResponse(res, 'Offer banner not found.', 404);
        }

        // Completeness checks — enforced only for an ACTIVE banner.
        if (status === OB.STATUS.ACTIVE) {
            if (type === OB.TYPE.IMAGE && !patch.image && !(existing && existing.image)) {
                return H.errorResponse(res, 'Upload a banner image (or switch to Text).', 422);
            }
            if (type === OB.TYPE.TEXT && !patch.title && !patch.subtitle) {
                return H.errorResponse(res, 'Add a title or subtitle for the text banner.', 422);
            }
            if (usesValue && !(val > 0)) {
                return H.errorResponse(res, isPercent ? 'Enter the discount % (e.g. 40) for this rule.' : 'Enter the amount (£) for this rule.', 422);
            }
            if (ruleType === OB.RULE.COUPON_CODE && !code) {
                return H.errorResponse(res, 'Enter the coupon code for this rule.', 422);
            }
            if (ruleType === OB.RULE.CATEGORY && !catId) {
                return H.errorResponse(res, 'Pick a category for this rule.', 422);
            }
        }

        let bannerId;
        if (id) { await db(T).where('id', id).update(patch); bannerId = id; }
        else {
            const ins = await db(T).insert(Object.assign({}, patch, { created_at: nowStr() })).returning('id');
            bannerId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        }

        // Manual-pick restaurants — re-assign (with order) whenever the picker
        // was submitted, even if now empty (the sentinel says "the picker ran").
        if (b.company_ids_submitted) { await assignOrdered(bannerId, orderedIdList(b.company_ids)); }

        return H.successResponse(res, { saved: true, id: Number(bannerId) }, id ? 'Offer banner updated.' : 'Offer banner created.');
    } catch (err) {
        console.error('[admin.offerBanner.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the offer banner.', 500);
    }
}

/** remove — POST /api/v1/admin/offer-banner/delete { ids:[] } — SOFT delete (status = 2). */
async function remove(req, res) {
    try {
        if (!(await ready())) { return H.successResponse(res, { deleted: 0 }, 'Nothing to delete.'); }
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        const n = await db(T).whereIn('id', ids).andWhere('status', '!=', OB.STATUS.DELETED)
            .update({ status: OB.STATUS.DELETED, updated_at: nowStr() });
        return H.successResponse(res, { deleted: n }, n + ' offer banner' + (n === 1 ? '' : 's') + ' deleted.');
    } catch (err) {
        console.error('[admin.offerBanner.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST /admin/offer-banner/status { ids:[], status } — activate/de-activate (never delete). */
async function statusToggle(req, res) {
    try {
        if (!(await ready())) { return H.errorResponse(res, 'Nothing to update.', 422); }
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select an offer banner.', 422); }
        const status = Number(req.body.status) === OB.STATUS.ACTIVE ? OB.STATUS.ACTIVE : OB.STATUS.INACTIVE;
        const n = await db(T).whereIn('id', ids).andWhere('status', '!=', OB.STATUS.DELETED)
            .update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.offerBanner.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

/** reorder — POST /admin/offer-banner/reorder { ids:[] } → save carousel sort_order. */
async function reorder(req, res) {
    try {
        if (!(await ready())) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        const ids = orderedIdList(req.body.ids);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        const now = nowStr();
        for (let i = 0; i < ids.length; i++) {
            await db(T).where('id', ids[i]).update({ sort_order: i + 1, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Order saved.');
    } catch (err) {
        console.error('[admin.offerBanner.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the order.', 500);
    }
}

// ── Manual-pick restaurant helpers (rule_type = MANUAL_PICK) ─────────────────
function companyDetail(r) {
    const domain = str(r.domain_name).trim();
    const email = str(r.email).trim();
    return domain || email || ('ID ' + r.id);
}
function mapCompany(r) {
    return { id: Number(r.id), name: r.business_name || ('Company #' + r.id), detail: companyDetail(r) };
}

/** companies — GET /admin/offer-banner/companies?q=&limit= — restaurant autocomplete. */
async function companies(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
        let qb = db('company').where('is_marketplace', 1).andWhere('is_active', 1).whereNull('deleted_at')
            .orderBy('business_name', 'asc').limit(limit).select('id', 'business_name', 'domain_name', 'email');
        if (q) { qb = qb.andWhereRaw('LOWER(business_name) LIKE ?', ['%' + q + '%']); }
        const rows = await qb;
        return H.successResponse(res, { companies: rows.map(mapCompany) });
    } catch (err) {
        console.error('[admin.offerBanner.companies]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/** restaurants — GET /admin/offer-banner/restaurants?id= → a banner's picked restaurants IN ORDER. */
async function restaurants(req, res) {
    try {
        if (!(await ready())) { return H.successResponse(res, { restaurants: [], count: 0 }); }
        const id = Number(req.query.id) || 0;
        const rows = await db(T_ASSIGN + ' as a').join('company as c', 'c.id', 'a.company_id')
            .where('a.offer_banner_id', id).whereNull('c.deleted_at')
            .orderBy('a.position', 'asc').orderBy('c.business_name', 'asc')
            .select('c.id', 'c.business_name', 'c.domain_name', 'c.email', 'a.position');
        return H.successResponse(res, {
            restaurants: rows.map((r) => ({ ...mapCompany(r), position: Number(r.position) || 0 })),
            count: rows.length,
        });
    } catch (err) {
        console.error('[admin.offerBanner.restaurants]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/**
 * assignOrdered — replace a banner's manual-pick restaurants with `companyIds`,
 * stamping position by array order (1-based). Shared by save().
 */
async function assignOrdered(bannerId, companyIds) {
    await db(T_ASSIGN).where('offer_banner_id', bannerId).del();
    if (companyIds.length) {
        const now = nowStr();
        await db(T_ASSIGN).insert(companyIds.map((c, i) => ({
            offer_banner_id: bannerId, company_id: c, position: i + 1, created_at: now,
        })));
    }
}

module.exports = { list, getBanner, save, remove, statusToggle, reorder, companies, restaurants };
