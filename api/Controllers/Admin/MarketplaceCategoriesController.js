'use strict';

/*
 * Controllers/Admin/MarketplaceCategoriesController.js
 *
 * What:  Admin CRUD for the GLOBAL marketplace category master
 *        (mp_marketplace_category) — the platform-wide cuisine/category list
 *        used by the marketplace home rail. NOT company-scoped (one global
 *        list). Each row: name, slug, icon (emoji or image), image (a file in
 *        the Yii uploads tree under marketplace/category/), status, sort_order.
 * Type:  READ + WRITE (mp_marketplace_category, mp_marketplace_category_assign).
 * Used:  api/Routes/index.js — /admin/marketplace-categories/*.
 *
 * Change log:
 *   2026-06-10 — initial (list/search/filter/sort/paginate + get/save/delete).
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');

const T = 'mp_marketplace_category';
const T_ASSIGN = 'mp_marketplace_category_assign';

const SORTS = {
    sort_order:  ['sort_order', 'asc'],
    restaurants: ['restaurants', 'desc'], // assigned-count desc (special-cased below)
    name_asc:    ['name', 'asc'],
    name_desc:   ['name', 'desc'],
    newest:      ['id', 'desc'],
};
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));
function idList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    return [...new Set(arr.map((n) => Number(n)).filter((n) => n > 0))];
}
function slugify(s, id) {
    const base = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || ('category-' + (id || ''));
}
function imageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    const base = H.getUploadsBaseUrl();
    return base + '/marketplace/category/' + f;
}

/**
 * list — GET /api/v1/admin/marketplace-categories
 * Search (q) + status filter + sort + server-side pagination.
 */
async function list(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const statusF = String(req.query.status || ''); // '', 'active', 'inactive'
        const sortKey = SORTS[req.query.sort] ? req.query.sort : 'sort_order';
        const sort = SORTS[sortKey];
        const limitRaw = String(req.query.limit || '25');
        const isAll = limitRaw === 'all';
        const limit = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);
        let page = Number(req.query.page) || 1;
        if (page < 1) { page = 1; }

        const companyF = Number(req.query.company) || 0;
        const base = () => db(T).modify((qb) => {
            if (q) { qb.andWhereRaw('LOWER(name) LIKE ?', ['%' + q + '%']); }
            if (statusF === 'active') { qb.andWhere('status', 1); }
            else if (statusF === 'inactive') { qb.andWhere('status', '!=', 1); }
            // Restaurant filter: only categories this company is assigned to.
            if (companyF) {
                qb.whereExists(function () {
                    this.select(db.raw('1')).from(T_ASSIGN + ' as af')
                        .whereRaw('af.category_id = ' + T + '.id').andWhere('af.company_id', companyF);
                });
            }
        });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        let qb = base()
            .leftJoin(db(T_ASSIGN).select('category_id').count('* as restaurants').groupBy('category_id').as('a'),
                'a.category_id', T + '.id')
            .select(T + '.id', T + '.name', T + '.slug', T + '.icon', T + '.image',
                    T + '.status', T + '.sort_order', db.raw('COALESCE(a.restaurants, 0) as restaurants'));
        // "Restaurants first" orders by assigned count desc (then sort_order);
        // every other key orders by its own column.
        if (sortKey === 'restaurants') {
            qb = qb.orderByRaw('COALESCE(a.restaurants, 0) DESC, ' + T + '.sort_order ASC');
        } else {
            qb = qb.orderBy(T + '.' + sort[0], sort[1]);
        }
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;

        // Selected-restaurant name (so the filter box can show it).
        let companyName = '';
        if (companyF) {
            const cr = await db('company').where('id', companyF).select('business_name').first();
            companyName = (cr && cr.business_name) || ('Company #' + companyF);
        }

        const categories = rows.map((r) => ({
            id: Number(r.id),
            name: r.name || '',
            slug: r.slug || '',
            icon: r.icon || '',
            image: r.image || '',
            image_url: imageUrl(r.image),
            status: Number(r.status),
            sort_order: Number(r.sort_order) || 0,
            restaurants: Number(r.restaurants) || 0,
        }));

        return H.successResponse(res, {
            categories,
            total,
            page,
            limit: isAll ? 'all' : limit,
            total_pages: totalPages,
            sort: sortKey,
            status: statusF,
            company: companyF || 0,
            company_name: companyName,
        });
    } catch (err) {
        console.error('[admin.mpCategories.list]', err && err.message);
        return H.errorResponse(res, 'Could not load marketplace categories.', 500);
    }
}

/** getCategory — GET /api/v1/admin/marketplace-categories/get?id=
 *  id=0 (add): returns { category:null, next_sort }. Else the row + next_sort. */
async function getCategory(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const maxRow = await db(T).max('sort_order as m').first();
        const nextSort = (Number(maxRow && maxRow.m) || 0) + 1;
        if (!id) { return H.successResponse(res, { category: null, next_sort: nextSort }); }
        const r = await db(T).where('id', id).first();
        if (!r) { return H.errorResponse(res, 'Category not found.', 404); }
        return H.successResponse(res, {
            next_sort: nextSort,
            category: {
                id: Number(r.id),
                name: r.name || '',
                slug: r.slug || '',
                icon: r.icon || '',
                image: r.image || '',
                image_url: imageUrl(r.image),
                status: Number(r.status),
                sort_order: Number(r.sort_order) || 0,
            },
        });
    } catch (err) {
        console.error('[admin.mpCategories.getCategory]', err && err.message);
        return H.errorResponse(res, 'Could not load the category.', 500);
    }
}

/**
 * save — POST /api/v1/admin/marketplace-categories/save
 * Create (no id) or update a global marketplace category. Name + slug unique.
 */
async function save(req, res) {
    try {
        const b = req.body;
        const id = Number(b.id) || 0;
        const name = str(b.name).trim();
        if (!name) { return H.errorResponse(res, 'Category name is required.', 422); }

        let slug = slugify(b.slug ? b.slug : name);
        // Slug must be unique (excluding this row).
        const slugClash = await db(T).whereRaw('LOWER(slug) = ?', [slug.toLowerCase()]).andWhere('id', '!=', id).first();
        if (slugClash) { slug = slug + '-' + (Date.now().toString(36).slice(-4)); }

        // Name unique (excluding this row).
        const nameClash = await db(T).whereRaw('LOWER(name) = ?', [name.toLowerCase()]).andWhere('id', '!=', id).first();
        if (nameClash) { return H.errorResponse(res, 'A category with that name already exists.', 409); }

        const patch = {
            name: name.slice(0, 120),
            slug: slug.slice(0, 140),
            icon: str(b.icon).slice(0, 255),
            status: Number(b.status) === 1 ? 1 : 0,
            sort_order: Number(b.sort_order) || 0,
            updated_at: nowStr(),
        };
        if (b.image) { patch.image = str(b.image).slice(0, 255); }   // new upload filename

        if (id) {
            const owned = await db(T).where('id', id).first();
            if (!owned) { return H.errorResponse(res, 'Category not found.', 404); }
            await db(T).where('id', id).update(patch);
            return H.successResponse(res, { saved: true, id }, 'Category updated.');
        }
        const ins = await db(T).insert({ ...patch, created_at: nowStr() }).returning('id');
        const newId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        return H.successResponse(res, { saved: true, id: newId }, 'Category created.');
    } catch (err) {
        console.error('[admin.mpCategories.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the category.', 500);
    }
}

/** remove — POST /api/v1/admin/marketplace-categories/delete { ids:[] } */
async function remove(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        await db(T_ASSIGN).whereIn('category_id', ids).del();
        const n = await db(T).whereIn('id', ids).del();
        return H.successResponse(res, { deleted: n }, n + ' categor' + (n === 1 ? 'y' : 'ies') + ' deleted.');
    } catch (err) {
        console.error('[admin.mpCategories.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST /admin/marketplace-categories/status { ids:[], status } */
async function statusToggle(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select a category.', 422); }
        const status = Number(req.body.status) === 1 ? 1 : 0;
        const n = await db(T).whereIn('id', ids).update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.mpCategories.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

/**
 * companies — GET /api/v1/admin/marketplace-categories/companies?q=&limit=
 * Autocomplete: marketplace restaurants matching the query (default 10).
 */
// A short secondary detail to disambiguate same-named restaurants in the UI.
function companyDetail(r) {
    const domain = str(r.domain_name).trim();
    const email = str(r.email).trim();
    return domain || email || ('ID ' + r.id);
}
function mapCompany(r) {
    return { id: Number(r.id), name: r.business_name || ('Company #' + r.id), detail: companyDetail(r) };
}

async function companies(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
        let qb = db('company').where('is_marketplace', 1).andWhere('is_active', 1).whereNull('deleted_at')
            .orderBy('business_name', 'asc').limit(limit).select('id', 'business_name', 'domain_name', 'email');
        if (q) { qb = qb.andWhereRaw('LOWER(business_name) LIKE ?', ['%' + q + '%']); }
        const rows = await qb;
        return H.successResponse(res, { companies: rows.map(mapCompany) });
    } catch (err) {
        console.error('[admin.mpCategories.companies]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/** restaurants — GET .../restaurants?id=  → a category's assigned restaurants. */
async function restaurants(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const rows = await db(T_ASSIGN + ' as a').join('company as c', 'c.id', 'a.company_id')
            .where('a.category_id', id).whereNull('c.deleted_at')
            .orderBy('c.business_name', 'asc')
            .select('c.id', 'c.business_name', 'c.domain_name', 'c.email');
        return H.successResponse(res, {
            restaurants: rows.map(mapCompany),
            count: rows.length,
        });
    } catch (err) {
        console.error('[admin.mpCategories.restaurants]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/**
 * assign — POST .../assign  { category_ids:[], company_ids:[], mode }
 * Assign restaurants to one or many categories. mode 'set' replaces the
 * category's restaurants; 'add' appends without removing existing ones.
 */
async function assign(req, res) {
    try {
        const categoryIds = idList(req.body.category_ids);
        const companyIds = idList(req.body.company_ids);
        const mode = req.body.mode === 'add' ? 'add' : 'set';
        if (!categoryIds.length) { return H.errorResponse(res, 'Select a category.', 422); }

        for (const catId of categoryIds) {
            let toInsert = companyIds;
            if (mode === 'set') {
                await db(T_ASSIGN).where('category_id', catId).del();
            } else {
                const existing = await db(T_ASSIGN).where('category_id', catId).pluck('company_id');
                const exSet = new Set(existing.map(Number));
                toInsert = companyIds.filter((c) => !exSet.has(c));
            }
            if (toInsert.length) {
                await db(T_ASSIGN).insert(toInsert.map((c) => ({ category_id: catId, company_id: c })));
            }
        }
        return H.successResponse(res, { saved: true }, 'Restaurants assigned.');
    } catch (err) {
        console.error('[admin.mpCategories.assign]', err && err.message);
        return H.errorResponse(res, 'Could not assign restaurants.', 500);
    }
}

/** reorder — POST .../reorder { ids:[] }  → save sort_order by array position. */
async function reorder(req, res) {
    try {
        const ids = idList(req.body.ids);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        const now = nowStr();
        for (let i = 0; i < ids.length; i++) {
            await db(T).where('id', ids[i]).update({ sort_order: i + 1, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Order saved.');
    } catch (err) {
        console.error('[admin.mpCategories.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the order.', 500);
    }
}

module.exports = { list, getCategory, save, remove, statusToggle, companies, restaurants, assign, reorder };
