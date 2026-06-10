'use strict';

/*
 * Controllers/Admin/ProductsController.js
 *
 * What:  Admin product-management endpoints (Phase 1 — the LIST page), a
 *        faithful port of the legacy backend/pos ProductsController list
 *        actions: list (+ search), inline normal/online price edit, status
 *        change (single + bulk, incl. "Unavailable until" availability),
 *        soft-delete (single + bulk, with related-row cleanup), and the
 *        third-party bulk online-price update.
 * Why:   The new admin must manage the SAME live products (no migration).
 * Type:  READ + WRITE (products, product_image, product_availability,
 *        product_section, product_language, product_schedule).
 * Used:  api/Routes/index.js under /admin/products/*.
 *
 * Status codes (legacy Item Availability): 1=Available, 0=Unavailable,
 *   4=Unavailable Today, 5=Unavailable Until, 3=Sold Out, 2=Deleted.
 *
 * Change log:
 *   2026-06-09 — initial (list page).
 */

const H = require('../../Helpers/helper');
const { db } = require('../../config/db');
const { resolveCompanyScope } = require('../../Helpers/adminScope');

const STATUS_DELETED = 2;
const LIST_STATUSES = [0, 1, 3, 4, 5];

function money(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

// Resolve {companyId, actorId} + the company's branch. 422 (returns null) if
// a super admin hasn't picked a company.
async function resolveScope(req, res) {
    const scope = resolveCompanyScope(req);
    if (scope.companyId == null) {
        H.errorResponse(res, 'Select a company first.', 422, { code: 'no_company' });
        return null;
    }
    const branch = await db('branch').where('company_id', scope.companyId).first();
    return { companyId: scope.companyId, actorId: scope.actorId, branch };
}

// The branch's category ids (company + branch-scoped, not deleted).
async function branchCategoryIds(companyId, branchId) {
    return db('categories')
        .where('company_id', companyId)
        .andWhereRaw("status <> '2'")
        .andWhereRaw('? = ANY (string_to_array(branch_id, \',\')::int[])', [branchId || 0])
        .pluck('id');
}

/**
 * list — GET /api/v1/admin/products?company_id=&q=
 * Distinct products in the branch's categories with primary image + prices +
 * status + "unavailable until" date/time. Optional name search via ?q=.
 */
const SORTS = {
    newest:     ['p.id', 'desc'],
    name_asc:   ['p.name', 'asc'],
    name_desc:  ['p.name', 'desc'],
    price_asc:  ['p.price_before_tax', 'asc'],
    price_desc: ['p.price_before_tax', 'desc'],
};
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];
const PRICE_COLS = { normal: 'price_before_tax', online: 'online_platform_price', marketplace: 'marketplace_price' };

async function list(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        const bid = got.branch ? Number(got.branch.id) : 0;
        const q = String(req.query.q || '').trim().toLowerCase();
        const sortKey = SORTS[req.query.sort] ? req.query.sort : 'newest';
        const sort = SORTS[sortKey];
        const limitRaw = String(req.query.limit || '25');
        const isAll = limitRaw === 'all';
        const limit = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);

        const catIds = await branchCategoryIds(cid, bid);
        // Category dropdown — only categories that actually HAVE products, grouped
        // by name so legacy duplicate-named rows collapse into one option. Each
        // option's id is the comma-joined ids sharing that name; the filter then
        // matches products in ANY of them.
        const catRows = catIds.length
            ? await db('categories as c').where('c.company_id', cid).andWhereRaw("c.status <> '2'")
                .whereIn('c.id', catIds)
                .whereExists(function () {
                    this.select(db.raw('1')).from('product_product_category as pc')
                        .join('products as p', 'p.id', 'pc.product_id')
                        .whereRaw('pc.category_id = c.id')
                        .andWhere('p.company_id', cid).andWhereRaw("p.status <> '2'");
                })
                .orderBy('c.name', 'asc').select('c.id', 'c.name')
            : [];
        const catGroups = new Map(); // lower(name) -> { name, ids:[] }
        catRows.forEach((c) => {
            const key = String(c.name || '').trim().toLowerCase();
            if (!catGroups.has(key)) { catGroups.set(key, { name: c.name, ids: [] }); }
            catGroups.get(key).ids.push(Number(c.id));
        });
        const categories = Array.from(catGroups.values()).map((g) => ({ id: g.ids.join(','), name: g.name, ids: g.ids }));
        // The category filter param can be a single id or a comma list of same-named ids.
        const catParamRaw = String(req.query.category || '').trim();
        const validIds = catIds.map((x) => Number(x));
        const catParamIds = catParamRaw.split(',').map((x) => Number(x)).filter((x) => x > 0 && validIds.includes(x));
        const filterCats = catParamIds.length ? catParamIds : catIds;

        let rows = [];
        let total = 0;
        let page = Number(req.query.page) || 1;
        if (page < 1) { page = 1; }

        if (catIds.length) {
            // Base filter, reused for the count and the page query.
            const base = () => db('products as p')
                .innerJoin('product_product_category as pc', 'pc.product_id', 'p.id')
                .where('p.company_id', cid).andWhereRaw("p.status <> '2'")
                .whereIn('pc.category_id', filterCats)
                .modify((qb) => { if (q) { qb.andWhereRaw('LOWER(p.name) LIKE ?', ['%' + q + '%']); } });

            const cnt = await base().countDistinct('p.id as n').first();
            total = Number(cnt && cnt.n) || 0;
            const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
            if (page > totalPages) { page = totalPages; }

            let qb = base()
                .leftJoin('product_image as pi', function joinImg() {
                    this.on('p.id', 'pi.product_id').andOn('pi.is_primary', '=', db.raw("'1'"));
                })
                .leftJoin('product_availability as pa', 'p.id', 'pa.product_id')
                .groupBy('p.id', 'pi.url', 'pa.availability_date', 'pa.availability_time')
                .orderBy(sort[0], sort[1])
                .select('p.id', 'p.name', 'p.price_before_tax', 'p.online_platform_price', 'p.marketplace_price',
                        'p.show_marketplace', 'p.status', 'p.suffix', 'pi.url', 'pa.availability_date', 'pa.availability_time');
            if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
            rows = await qb;
        }

        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        const upBase = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
        const products = rows.map((p) => ({
            id: Number(p.id),
            name: p.name || '',
            suffix: p.suffix || '',
            price_before_tax: money(p.price_before_tax),
            online_platform_price: money(p.online_platform_price),
            marketplace_price: money(p.marketplace_price),
            show_marketplace: Number(p.show_marketplace) || 0,
            status: Number(p.status),
            image_url: p.url ? (upBase + '/' + cid + '/products/' + p.url) : '',
            availability_date: p.availability_date ? new Date(p.availability_date).toISOString().slice(0, 10) : '',
            availability_time: p.availability_time ? String(p.availability_time).slice(0, 5) : '',
        }));

        return H.successResponse(res, {
            products,
            total,
            page,
            limit: isAll ? 'all' : limit,
            total_pages: totalPages,
            sort: sortKey,
            categories,
            category: catParamIds.length ? catParamIds.join(',') : '',
            third_pct: got.branch ? Number(got.branch.third_online_website_percentage) || 0 : 0,
        });
    } catch (err) {
        console.error('[admin.products.list]', err && err.message);
        return H.errorResponse(res, 'Could not load products.', 500);
    }
}

/**
 * updatePrice — POST /api/v1/admin/products/price  { id, price, type }
 * Inline edit of the normal (price_before_tax) or online (online_platform_price)
 * price for one product. type: 'online' → online price, else normal.
 */
async function updatePrice(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const id = Number(req.body.id) || 0;
        const price = money(req.body.price);
        if (!id || req.body.price == null || req.body.price === '') {
            return H.errorResponse(res, 'Price can not be blank.', 422);
        }
        const col = PRICE_COLS[req.body.type] || 'price_before_tax';
        const n = await db('products').where({ id, company_id: got.companyId }).andWhereRaw("status <> '2'")
            .update({ [col]: price, updated_at: nowStr(), updated_by: got.actorId });
        if (!n) { return H.errorResponse(res, 'Product not found.', 404); }
        return H.successResponse(res, { success: true }, 'Price updated.');
    } catch (err) {
        console.error('[admin.products.updatePrice]', err && err.message);
        return H.errorResponse(res, 'Could not update the price.', 500);
    }
}

/**
 * updateStatus — POST /api/v1/admin/products/status  { ids[], status, unavailable_until }
 * Set status for one or many products. For status 5 (Unavailable Until) upsert
 * product_availability with the date/time; otherwise clear any availability row.
 */
async function updateStatus(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        let ids = req.body.ids != null ? req.body.ids : req.body.id;
        if (!Array.isArray(ids)) { ids = (ids != null && ids !== '') ? [ids] : []; }
        ids = [...new Set(ids.map((x) => Number(x)).filter((x) => x > 0))];
        const status = Number(req.body.status);
        if (!ids.length || !LIST_STATUSES.includes(status)) {
            return H.errorResponse(res, 'Missing parameters.', 422);
        }
        const until = req.body.unavailable_until ? new Date(req.body.unavailable_until) : null;
        const aDate = until && !isNaN(until) ? until.toISOString().slice(0, 10) : null;
        const aTime = until && !isNaN(until) ? until.toISOString().slice(11, 19) : null;

        for (const id of ids) {
            const owned = await db('products').where({ id, company_id: cid }).andWhereRaw("status <> '2'").first();
            if (!owned) { continue; }
            await db('products').where('id', id).update({ status, updated_at: nowStr(), updated_by: got.actorId });
            if (status === 5 && aDate) {
                const av = await db('product_availability').where('product_id', id).first();
                if (av) {
                    await db('product_availability').where('id', av.id)
                        .update({ availability_date: aDate, availability_time: aTime, updated_at: nowStr(), updated_by: got.actorId });
                } else {
                    await db('product_availability').insert({
                        product_id: id, availability_date: aDate, availability_time: aTime,
                        company_id: cid, created_at: nowStr(), created_by: got.actorId,
                    });
                }
            } else {
                await db('product_availability').where('product_id', id).del();
            }
        }
        return H.successResponse(res, { success: true }, 'Status updated successfully.');
    } catch (err) {
        console.error('[admin.products.updateStatus]', err && err.message);
        return H.errorResponse(res, 'Could not update the status.', 500);
    }
}

/**
 * remove — POST /api/v1/admin/products/delete  { ids[] }
 * Soft-delete one or many products (status=2) and clean up related rows:
 * product_section + product_language → status 2; product_availability +
 * product_schedule → hard-deleted. Mirrors the legacy delete.
 */
async function remove(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        let ids = req.body.ids != null ? req.body.ids : req.body.id;
        if (!Array.isArray(ids)) { ids = (ids != null && ids !== '') ? [ids] : []; }
        ids = [...new Set(ids.map((x) => Number(x)).filter((x) => x > 0))];
        if (!ids.length) { return H.errorResponse(res, 'No products selected.', 422); }

        for (const id of ids) {
            const owned = await db('products').where({ id, company_id: cid }).andWhereRaw("status <> '2'").first();
            if (!owned) { continue; }
            await db('products').where('id', id).update({ status: STATUS_DELETED, updated_at: nowStr(), updated_by: got.actorId });
            await db('product_section').where('product_id', id).update({ status: '2', updated_at: nowStr() });
            await db('product_language').where('product_id', id).update({ status: '2', updated_at: nowStr() });
            await db('product_availability').where('product_id', id).del();
            await db('product_schedule').where('product_id', id).del();
        }
        return H.successResponse(res, { success: true }, 'The product was successfully deleted.');
    } catch (err) {
        console.error('[admin.products.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete the product(s).', 500);
    }
}

/**
 * bulkOnlinePrice — POST /api/v1/admin/products/online-prices  { items: [{id, online_price}] }
 * Third-party % change: write the precomputed online prices for many products.
 */
/**
 * bulkPrice — POST /api/v1/admin/products/bulk-price
 * Set ONE price (normal / online / marketplace) to the same value for every
 * selected product. Body: { ids:[], type, price }.
 */
async function bulkPrice(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select at least one product.', 422); }
        if (req.body.price == null || req.body.price === '') { return H.errorResponse(res, 'Price can not be blank.', 422); }
        const col = PRICE_COLS[req.body.type] || 'price_before_tax';
        const price = money(req.body.price);
        const n = await db('products').where('company_id', got.companyId).whereIn('id', ids).andWhereRaw("status <> '2'")
            .update({ [col]: price, updated_at: nowStr(), updated_by: got.actorId });
        return H.successResponse(res, { success: true, updated: n }, n + ' product' + (n === 1 ? '' : 's') + ' updated.');
    } catch (err) {
        console.error('[admin.products.bulkPrice]', err && err.message);
        return H.errorResponse(res, 'Could not update the prices.', 500);
    }
}

/**
 * marketplaceToggle — POST /api/v1/admin/products/marketplace
 * Turn the marketplace listing (show_marketplace) on/off for one or many
 * products. Body: { ids:[]|id, show }.
 */
async function marketplaceToggle(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select a product.', 422); }
        const show = (req.body.show === 1 || req.body.show === '1' || req.body.show === true) ? 1 : 0;
        const n = await db('products').where('company_id', got.companyId).whereIn('id', ids).andWhereRaw("status <> '2'")
            .update({ show_marketplace: show, updated_at: nowStr(), updated_by: got.actorId });
        return H.successResponse(res, { success: true, updated: n }, 'Marketplace ' + (show ? 'enabled' : 'disabled') + '.');
    } catch (err) {
        console.error('[admin.products.marketplaceToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update marketplace setting.', 500);
    }
}

async function bulkOnlinePrice(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        const items = Array.isArray(req.body.items) ? req.body.items : [];
        if (!items.length) { return H.errorResponse(res, 'Nothing to update.', 422); }
        for (const it of items) {
            const id = Number(it.id) || 0;
            if (!id) { continue; }
            await db('products').where({ id, company_id: cid }).andWhereRaw("status <> '2'")
                .update({ online_platform_price: money(it.online_price), updated_at: nowStr(), updated_by: got.actorId });
        }
        return H.successResponse(res, { success: true }, 'Prices updated successfully.');
    } catch (err) {
        console.error('[admin.products.bulkOnlinePrice]', err && err.message);
        return H.errorResponse(res, 'Could not update the prices.', 500);
    }
}

// ── Add / Edit (Phase 2a — core fields) ─────────────────────────────
// Core product fields + image + category + availability + name/description
// (product_language). Advanced relations — modifiers, sections, allergens,
// schedules — are Phase 2b.

const int = (v) => Number.parseInt(v, 10) || 0;
const flag = (v) => (v === 1 || v === '1' || v === true || v === 'true' || v === 'on') ? 1 : 0;
const str = (v) => (v == null ? '' : String(v));
function idList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    return [...new Set(arr.map((n) => Number(n)).filter((n) => n > 0))];
}

// VEG: 1=Veg, 2=Non-veg, 0=None. STATUS list reused from above.
function buildPatch(b) {
    return {
        name:                            str(b.name).slice(0, 255),
        sku:                             str(b.name).slice(0, 255),
        suffix:                          str(b.suffix).slice(0, 255),
        price_before_tax:                money(b.price_before_tax),
        online_platform_price:           money(b.online_platform_price),
        product_description:             str(b.product_description),
        status:                          LIST_STATUSES.includes(int(b.status)) ? int(b.status) : 1,
        veg_non_veg:                     int(b.veg_non_veg),
        pricing_type:                    int(b.pricing_type),
        tax_id:                          int(b.tax_id),
        unit_type_id:                    int(b.unit_type_id),
        service_size:                    str(b.service_size),
        calories:                        str(b.calories),
        barcode:                         str(b.barcode),
        offer:                           0,
        min_qty_for_order:               int(b.min_qty_for_order),
        max_qty_for_order:               int(b.max_qty_for_order),
        schedule:                        (b.schedule === 'Daily' || b.schedule === 'Weekly') ? b.schedule : 'No Schedule',
        show_online:                     flag(b.show_online),
        is_recommended:                  flag(b.is_recommended),
        is_display_about_us:             flag(b.is_display_about_us),
        is_alchohol:                     flag(b.is_alchohol),
        is_tobacco:                      flag(b.is_tobacco),
        eligible_for_online_discount:    flag(b.eligible_for_online_discount),
        eligible_for_collection_discount: flag(b.eligible_for_collection_discount),
        allow_coupon:                    flag(b.allow_coupon),
        excluded_for_free_gift:          flag(b.excluded_for_free_gift),
        discount_type:                   int(b.discount_type),
        discount_value:                  int(b.discount_type) === 3 ? 0 : money(b.discount_value),
        discount_description:            str(b.discount_description),
    };
}

/**
 * getProduct — GET /api/v1/admin/products/get?company_id=&id=
 * One product for the edit form: core fields + primary image + category +
 * language (name/description) + availability (status 5).
 */
async function getProduct(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        const id = Number(req.query.id) || 0;
        const p = await db('products').where({ id, company_id: cid }).andWhereRaw("status <> '2'").first();
        if (!p) { return H.errorResponse(res, 'Product not found.', 404); }
        const img = await db('product_image').where('product_id', id).andWhereRaw("is_primary = '1'").first();
        const cat = await db('product_product_category').where('product_id', id).andWhereRaw("COALESCE(status,'1') <> '2'").first();
        const lang = await db('product_language').where('product_id', id).andWhereRaw("status <> '2'").first();
        const av = Number(p.status) === 5 ? await db('product_availability').where('product_id', id).first() : null;
        const sched = await db('product_schedule').where('product_id', id).first();
        const sectionIds = await db('product_section').where('product_id', id).andWhereRaw("status <> '2'").pluck('section_id');
        const allergenIds = await db('product_allergy_details').where('product_id', id).andWhereRaw("status <> '2'").pluck('allergy_master_id');
        const modifierIds = await db('modifier_group_products').where('product_id', id).andWhereRaw("status <> '2'").orderBy('sequence', 'asc').pluck('modifier_group_id');
        // Modifier groups WITH their options (name + price) for the detail view.
        const modGroupRows = await db('modifier_group_products as mgp')
            .join('modifier_group as mg', 'mg.id', 'mgp.modifier_group_id')
            .where('mgp.product_id', id).andWhereRaw("mgp.status <> '2'")
            .orderBy('mgp.sequence', 'asc')
            .select('mg.id', 'mg.group_name', 'mg.min_limit', 'mg.max_limit');
        const modifierGroups = [];
        for (const g of modGroupRows) {
            const opts = await db('modifier_group_options')
                .where('modifier_group_id', g.id).andWhereRaw("status <> '2'")
                .orderBy('sequence', 'asc')
                .select('id', 'option_name', 'price_tax_include');
            modifierGroups.push({
                id: Number(g.id),
                name: g.group_name || ('Group #' + g.id),
                min_limit: Number(g.min_limit) || 0,
                max_limit: Number(g.max_limit) || 0,
                options: opts.map((o) => ({ id: Number(o.id), name: o.option_name || '', price: money(o.price_tax_include) })),
            });
        }
        const upBase = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
        return H.successResponse(res, {
            product: {
                id: Number(p.id),
                name: lang && lang.name ? lang.name : (p.name || ''),
                description: lang && lang.description ? lang.description : (p.product_description || ''),
                suffix: p.suffix || '',
                price_before_tax: money(p.price_before_tax),
                online_platform_price: money(p.online_platform_price),
                marketplace_price: money(p.marketplace_price),
                status: Number(p.status),
                veg_non_veg: Number(p.veg_non_veg) || 0,
                pricing_type: Number(p.pricing_type) || 0,
                tax_id: Number(p.tax_id) || 0,
                unit_type_id: Number(p.unit_type_id) || 0,
                service_size: p.service_size || '',
                calories: p.calories || '',
                barcode: p.barcode || '',
                min_qty_for_order: Number(p.min_qty_for_order) || 0,
                max_qty_for_order: Number(p.max_qty_for_order) || 0,
                show_online: Number(p.show_online) || 0,
                is_recommended: Number(p.is_recommended) || 0,
                is_display_about_us: Number(p.is_display_about_us) || 0,
                is_alchohol: Number(p.is_alchohol) || 0,
                is_tobacco: Number(p.is_tobacco) || 0,
                eligible_for_online_discount: Number(p.eligible_for_online_discount) || 0,
                eligible_for_collection_discount: Number(p.eligible_for_collection_discount) || 0,
                allow_coupon: Number(p.allow_coupon) || 0,
                excluded_for_free_gift: Number(p.excluded_for_free_gift) || 0,
                discount_type: Number(p.discount_type) || 0,
                discount_value: money(p.discount_value),
                discount_description: p.discount_description || '',
                category_id: cat ? Number(cat.category_id) : 0,
                image: img ? (img.url || '') : '',
                image_url: img && img.url ? (upBase + '/' + cid + '/products/' + img.url) : '',
                availability_until: (av && av.availability_date)
                    ? (new Date(av.availability_date).toISOString().slice(0, 10) + 'T' + String(av.availability_time || '00:00').slice(0, 5))
                    : '',
                schedule: p.schedule || 'No Schedule',
                schedule_start_date: sched && sched.start_date ? new Date(sched.start_date).toISOString().slice(0, 10) : '',
                schedule_end_date: sched && sched.end_date ? new Date(sched.end_date).toISOString().slice(0, 10) : '',
                schedule_start_time: sched && sched.start_time ? String(sched.start_time).slice(0, 5) : '',
                schedule_end_time: sched && sched.end_time ? String(sched.end_time).slice(0, 5) : '',
                schedule_days: (sched && sched.days) ? String(sched.days).split(',').map((x) => Number(x)).filter((x) => x > 0) : [],
                section_ids: sectionIds.map((x) => Number(x)),
                allergen_ids: allergenIds.map((x) => Number(x)),
                modifier_ids: modifierIds.map((x) => Number(x)),
                modifier_groups: modifierGroups,
            },
        });
    } catch (err) {
        console.error('[admin.products.getProduct]', err && err.message);
        return H.errorResponse(res, 'Could not load the product.', 500);
    }
}

/**
 * save — POST /api/v1/admin/products/save
 * Create (no id) or update a product: core fields + category + name/description
 * (product_language) + primary image (filename from the admin upload) +
 * availability (status 5). Name must be unique within the category.
 */
async function save(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        const actor = got.actorId;
        const b = req.body;
        const id = Number(b.id) || 0;
        const categoryId = Number(b.category_id) || 0;
        const name = str(b.name).trim();
        if (!name) { return H.errorResponse(res, 'Product name is required.', 422); }
        if (!id && !categoryId) { return H.errorResponse(res, 'Pick a category for the product.', 422); }

        // Name unique within the category (excluding this product), like legacy.
        if (categoryId) {
            const dupe = await db('products as p')
                .innerJoin('product_product_category as pc', 'pc.product_id', 'p.id')
                .where('pc.category_id', categoryId)
                .andWhere('p.company_id', cid)
                .andWhereRaw('LOWER(p.name) = ?', [name.toLowerCase()])
                .andWhereRaw("p.status <> '2'")
                .andWhere('p.id', '!=', id)
                .first();
            if (dupe) { return H.errorResponse(res, 'A product with that name already exists in this category.', 409); }
        }

        const patch = buildPatch(b);
        let productId = id;

        if (id) {
            const owned = await db('products').where({ id, company_id: cid }).andWhereRaw("status <> '2'").first();
            if (!owned) { return H.errorResponse(res, 'Product not found.', 404); }
            await db('products').where('id', id).update({ ...patch, updated_at: nowStr(), updated_by: actor });
        } else {
            const ins = await db('products').insert({
                ...patch, company_id: cid, created_at: nowStr(), created_by: actor,
            }).returning('id');
            productId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        }

        // Category assignment (one row; create or repoint).
        if (categoryId) {
            const cat = await db('product_product_category').where('product_id', productId).first();
            if (cat) {
                await db('product_product_category').where('id', cat.id)
                    .update({ category_id: categoryId, status: '1', updated_at: nowStr(), updated_by: actor });
            } else {
                await db('product_product_category').insert({
                    product_id: productId, category_id: categoryId, company_id: cid, status: '1',
                    created_at: nowStr(), created_by: actor,
                });
            }
        }

        // product_language (primary name + description).
        const lang = await db('product_language').where('product_id', productId).andWhereRaw("status <> '2'").first();
        if (lang) {
            await db('product_language').where('id', lang.id)
                .update({ name, description: patch.product_description, updated_at: nowStr(), updated_by: actor });
        } else {
            await db('product_language').insert({
                product_id: productId, name, description: patch.product_description, status: '1',
                company_id: cid, created_at: nowStr(), created_by: actor,
            });
        }

        // Primary image (filename supplied by the admin layer after upload).
        if (b.image) {
            await db('product_image').where('product_id', productId).update({ is_primary: '0' });
            await db('product_image').insert({
                product_id: productId, url: str(b.image).slice(0, 255), is_primary: '1', status: '1',
                company_id: cid, created_at: nowStr(), created_by: actor,
            });
        }

        // Availability (status 5 = Unavailable Until).
        if (patch.status === 5 && b.availability_until) {
            const until = new Date(b.availability_until);
            const aDate = !isNaN(until) ? until.toISOString().slice(0, 10) : null;
            const aTime = !isNaN(until) ? until.toISOString().slice(11, 19) : null;
            const av = await db('product_availability').where('product_id', productId).first();
            if (av) {
                await db('product_availability').where('id', av.id).update({ availability_date: aDate, availability_time: aTime, updated_at: nowStr(), updated_by: actor });
            } else {
                await db('product_availability').insert({ product_id: productId, availability_date: aDate, availability_time: aTime, company_id: cid, created_at: nowStr(), created_by: actor });
            }
        } else {
            await db('product_availability').where('product_id', productId).del();
        }

        // ── Schedule (Daily / Weekly) → product_schedule ──
        if (patch.schedule === 'Daily' || patch.schedule === 'Weekly') {
            let days = b.schedule_days != null ? b.schedule_days : b.days;
            if (!Array.isArray(days)) { days = (days != null && days !== '') ? [days] : []; }
            days = [...new Set(days.map((x) => Number(x)).filter((x) => x > 0))].sort((a, c) => a - c);
            const srow = {
                start_date: b.schedule_start_date || null,
                end_date: b.schedule_end_date || null,
                start_time: b.schedule_start_time || null,
                end_time: b.schedule_end_time || null,
                days: days.length ? days.join(',') : null,
            };
            const ex = await db('product_schedule').where('product_id', productId).first();
            if (ex) { await db('product_schedule').where('id', ex.id).update({ ...srow, updated_at: nowStr(), updated_by: actor }); }
            else { await db('product_schedule').insert({ product_id: productId, ...srow, company_id: cid, created_at: nowStr(), created_by: actor }); }
        } else {
            await db('product_schedule').where('product_id', productId).del();
        }

        // ── Sections → product_section (soft-delete all, then re-activate/insert) ──
        await db('product_section').where('product_id', productId).update({ status: '2', updated_at: nowStr() });
        for (const sid of idList(b.section_ids)) {
            const ex = await db('product_section').where({ product_id: productId, section_id: sid }).first();
            if (ex) { await db('product_section').where('id', ex.id).update({ status: '1', updated_at: nowStr(), updated_by: actor }); }
            else { await db('product_section').insert({ product_id: productId, section_id: sid, company_id: cid, status: '1', created_at: nowStr(), created_by: actor }); }
        }

        // ── Allergens → product_allergy_details ──
        await db('product_allergy_details').where({ product_id: productId, company_id: cid }).update({ status: '2', updated_at: nowStr(), updated_by: actor });
        for (const aid of idList(b.allergen_ids)) {
            const ex = await db('product_allergy_details').where({ product_id: productId, allergy_master_id: aid }).first();
            if (ex) { await db('product_allergy_details').where('id', ex.id).update({ status: '1', updated_at: nowStr(), updated_by: actor }); }
            else { await db('product_allergy_details').insert({ product_id: productId, allergy_master_id: aid, company_id: cid, status: '1', created_at: nowStr(), created_by: actor }); }
        }

        // ── Modifier groups → modifier_group_products (with sequence) ──
        await db('modifier_group_products').where('product_id', productId).update({ status: '2', updated_at: nowStr(), updated_by: actor });
        let seq = 1;
        for (const mid of idList(b.modifier_ids)) {
            const ex = await db('modifier_group_products').where({ product_id: productId, modifier_group_id: mid }).first();
            if (ex) { await db('modifier_group_products').where('id', ex.id).update({ status: '1', sequence: seq, updated_at: nowStr(), updated_by: actor }); }
            else { await db('modifier_group_products').insert({ product_id: productId, modifier_group_id: mid, company_id: cid, sequence: seq, status: '1', created_at: nowStr(), created_by: actor }); }
            seq += 1;
        }

        return H.successResponse(res, { saved: true, id: productId }, id ? 'Product updated.' : 'Product created.');
    } catch (err) {
        console.error('[admin.products.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the product.', 500);
    }
}

/**
 * formMeta — GET /api/v1/admin/products/meta?company_id=
 * Every option list the add/edit form needs: branch categories, VAT/tax rates,
 * unit types, sections, allergens and modifier groups (all company-scoped).
 */
async function formMeta(req, res) {
    try {
        const got = await resolveScope(req, res);
        if (!got) { return; }
        const cid = got.companyId;
        const bid = got.branch ? Number(got.branch.id) : 0;

        const cats = await db('categories')
            .where('company_id', cid).andWhereRaw("status <> '2'")
            .andWhereRaw('? = ANY (string_to_array(branch_id, \',\')::int[])', [bid])
            .orderBy('name', 'asc').select('id', 'name');
        const tax = await db('tax').where('company_id', cid).andWhereRaw("status <> '2'")
            .orderBy('id', 'asc').select('id', 'code', 'description', 'rate');
        const units = await db('units').where('company_id', cid).andWhereRaw("status <> '2'")
            .orderBy('name', 'asc').select('id', 'name');
        const sections = await db('section').where('company_id', cid)
            .orderBy('name', 'asc').select('id', 'name');
        const allergens = await db('allergy').where('company_id', cid).andWhereRaw("status <> '2'")
            .orderBy('allergy_details', 'asc').select('id', 'allergy_details');
        const modifiers = await db('modifier_group').where('company_id', cid).andWhereRaw("status <> '2'")
            .orderBy('group_name', 'asc').select('id', 'group_name');

        return H.successResponse(res, {
            categories: cats.map((c) => ({ id: Number(c.id), name: c.name })),
            tax: tax.map((t) => ({ id: Number(t.id), label: (t.code || t.description || ('Tax #' + t.id)) + (t.rate != null ? (' (' + Number(t.rate) + '%)') : '') })),
            units: units.map((u) => ({ id: Number(u.id), name: u.name })),
            sections: sections.map((s) => ({ id: Number(s.id), name: s.name })),
            allergens: allergens.map((a) => ({ id: Number(a.id), name: a.allergy_details })),
            modifiers: modifiers.map((m) => ({ id: Number(m.id), name: m.group_name })),
        });
    } catch (err) {
        console.error('[admin.products.formMeta]', err && err.message);
        return H.errorResponse(res, 'Could not load form options.', 500);
    }
}

module.exports = { list, updatePrice, updateStatus, remove, bulkOnlinePrice, bulkPrice, marketplaceToggle, getProduct, save, formMeta };
