'use strict';

/*
 * Controllers/Admin/CollectionsController.js
 *
 * What:  Admin CRUD for marketplace COLLECTIONS — the curated home-feed rows
 *        ("Popular near you", "Healthy picks", …). Each row: name (title),
 *        subtitle, slug, image (cover, in the Yii uploads tree under
 *        marketplace/collection/), status, sort_order (row order on the feed),
 *        plus its hand-picked restaurants WITH a position (the order they
 *        appear inside the row).
 * Type:  READ + WRITE (mp_collection, mp_collection_assign).
 * Used:  api/Routes/index.js — /admin/collections/*.
 *
 * Mirrors Admin/MarketplaceCategoriesController.js (same conventions) — the
 * only structural addition is the ORDERED assignment (position column).
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');

const T = 'mp_collection';
const T_ASSIGN = 'mp_collection_assign';

const SORTS = {
    sort_order:  ['sort_order', 'asc'],
    restaurants: ['restaurants', 'desc'],
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
// Ordered id list — preserves the order the client sent (for positions).
// De-dupes keeping first occurrence; drops non-positive.
function orderedIdList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    const seen = new Set();
    const out = [];
    arr.map((n) => Number(n)).forEach((n) => {
        if (n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    });
    return out;
}
function slugify(s, id) {
    const base = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || ('collection-' + (id || ''));
}
function imageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    const base = H.getUploadsBaseUrl();
    return base + '/marketplace/collection/' + f;
}

/**
 * list — GET /api/v1/admin/collections
 * Search (q) + status filter + sort + server-side pagination + per-row count.
 */
async function list(req, res) {
    try {
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
            if (q) { qb.andWhereRaw('LOWER(name) LIKE ?', ['%' + q + '%']); }
            if (statusF === 'active') { qb.andWhere('status', 1); }
            else if (statusF === 'inactive') { qb.andWhere('status', '!=', 1); }
        });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        let qb = base()
            .leftJoin(db(T_ASSIGN).select('collection_id').count('* as restaurants').groupBy('collection_id').as('a'),
                'a.collection_id', T + '.id')
            .select(T + '.id', T + '.name', T + '.subtitle', T + '.slug', T + '.image',
                    T + '.status', T + '.sort_order', db.raw('COALESCE(a.restaurants, 0) as restaurants'));
        if (sortKey === 'restaurants') {
            qb = qb.orderByRaw('COALESCE(a.restaurants, 0) DESC, ' + T + '.sort_order ASC');
        } else {
            qb = qb.orderBy(T + '.' + sort[0], sort[1]);
        }
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;

        const collections = rows.map((r) => ({
            id: Number(r.id),
            name: r.name || '',
            subtitle: r.subtitle || '',
            slug: r.slug || '',
            image: r.image || '',
            image_url: imageUrl(r.image),
            status: Number(r.status),
            sort_order: Number(r.sort_order) || 0,
            restaurants: Number(r.restaurants) || 0,
        }));

        return H.successResponse(res, {
            collections,
            total,
            page,
            limit: isAll ? 'all' : limit,
            total_pages: totalPages,
            sort: sortKey,
            status: statusF,
        });
    } catch (err) {
        console.error('[admin.collections.list]', err && err.message);
        return H.errorResponse(res, 'Could not load collections.', 500);
    }
}

/** getCollection — GET /api/v1/admin/collections/get?id= */
async function getCollection(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const maxRow = await db(T).max('sort_order as m').first();
        const nextSort = (Number(maxRow && maxRow.m) || 0) + 1;
        if (!id) { return H.successResponse(res, { collection: null, next_sort: nextSort }); }
        const r = await db(T).where('id', id).first();
        if (!r) { return H.errorResponse(res, 'Collection not found.', 404); }
        return H.successResponse(res, {
            next_sort: nextSort,
            collection: {
                id: Number(r.id),
                name: r.name || '',
                subtitle: r.subtitle || '',
                slug: r.slug || '',
                image: r.image || '',
                image_url: imageUrl(r.image),
                status: Number(r.status),
                sort_order: Number(r.sort_order) || 0,
            },
        });
    } catch (err) {
        console.error('[admin.collections.getCollection]', err && err.message);
        return H.errorResponse(res, 'Could not load the collection.', 500);
    }
}

/**
 * save — POST /api/v1/admin/collections/save
 * Create (no id) or update. Name + slug unique.
 */
async function save(req, res) {
    try {
        const b = req.body;
        const id = Number(b.id) || 0;
        const name = str(b.name).trim();
        if (!name) { return H.errorResponse(res, 'Collection title is required.', 422); }

        let slug = slugify(b.slug ? b.slug : name);
        const slugClash = await db(T).whereRaw('LOWER(slug) = ?', [slug.toLowerCase()]).andWhere('id', '!=', id).first();
        if (slugClash) { slug = slug + '-' + (Date.now().toString(36).slice(-4)); }

        const nameClash = await db(T).whereRaw('LOWER(name) = ?', [name.toLowerCase()]).andWhere('id', '!=', id).first();
        if (nameClash) { return H.errorResponse(res, 'A collection with that title already exists.', 409); }

        const patch = {
            name: name.slice(0, 120),
            subtitle: str(b.subtitle).slice(0, 180),
            slug: slug.slice(0, 140),
            status: Number(b.status) === 1 ? 1 : 0,
            sort_order: Number(b.sort_order) || 0,
            updated_at: nowStr(),
        };
        if (b.image) { patch.image = str(b.image).slice(0, 255); }

        if (id) {
            const owned = await db(T).where('id', id).first();
            if (!owned) { return H.errorResponse(res, 'Collection not found.', 404); }
            await db(T).where('id', id).update(patch);
            // Re-assign restaurants (with order) whenever the form's picker was
            // submitted — even if now empty (the sentinel says "the picker ran").
            if (b.company_ids_submitted) { await assignOrdered(id, orderedIdList(b.company_ids)); }
            return H.successResponse(res, { saved: true, id }, 'Collection updated.');
        }
        const ins = await db(T).insert({ ...patch, created_at: nowStr() }).returning('id');
        const newId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        if (b.company_ids_submitted) { await assignOrdered(newId, orderedIdList(b.company_ids)); }
        return H.successResponse(res, { saved: true, id: newId }, 'Collection created.');
    } catch (err) {
        console.error('[admin.collections.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the collection.', 500);
    }
}

/** remove — POST /api/v1/admin/collections/delete { ids:[] } */
async function remove(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        await db(T_ASSIGN).whereIn('collection_id', ids).del();
        const n = await db(T).whereIn('id', ids).del();
        return H.successResponse(res, { deleted: n }, n + ' collection' + (n === 1 ? '' : 's') + ' deleted.');
    } catch (err) {
        console.error('[admin.collections.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST /admin/collections/status { ids:[], status } */
async function statusToggle(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select a collection.', 422); }
        const status = Number(req.body.status) === 1 ? 1 : 0;
        const n = await db(T).whereIn('id', ids).update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.collections.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

// A short secondary detail to disambiguate same-named restaurants in the UI.
function companyDetail(r) {
    const domain = str(r.domain_name).trim();
    const email = str(r.email).trim();
    return domain || email || ('ID ' + r.id);
}
function mapCompany(r) {
    return { id: Number(r.id), name: r.business_name || ('Company #' + r.id), detail: companyDetail(r) };
}

/** companies — GET /admin/collections/companies?q=&limit= — autocomplete. */
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
        console.error('[admin.collections.companies]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/** restaurants — GET .../restaurants?id= → a collection's assigned restaurants IN POSITION ORDER. */
async function restaurants(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const rows = await db(T_ASSIGN + ' as a').join('company as c', 'c.id', 'a.company_id')
            .where('a.collection_id', id).whereNull('c.deleted_at')
            .orderBy('a.position', 'asc').orderBy('c.business_name', 'asc')
            .select('c.id', 'c.business_name', 'c.domain_name', 'c.email', 'a.position');
        return H.successResponse(res, {
            restaurants: rows.map((r) => ({ ...mapCompany(r), position: Number(r.position) || 0 })),
            count: rows.length,
        });
    } catch (err) {
        console.error('[admin.collections.restaurants]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/**
 * assignOrdered — replace a collection's restaurants with `companyIds`,
 * stamping position by array order (1-based). Shared by save() + assign().
 */
async function assignOrdered(collectionId, companyIds) {
    await db(T_ASSIGN).where('collection_id', collectionId).del();
    if (companyIds.length) {
        const now = nowStr();
        await db(T_ASSIGN).insert(companyIds.map((c, i) => ({
            collection_id: collectionId, company_id: c, position: i + 1, created_at: now,
        })));
    }
}

/**
 * assign — POST .../assign { collection_id, company_ids:[] }
 * Sets the collection's restaurants in the given ORDER (position by index).
 */
async function assign(req, res) {
    try {
        const collectionId = Number(req.body.collection_id) || 0;
        if (!collectionId) { return H.errorResponse(res, 'Select a collection.', 422); }
        await assignOrdered(collectionId, orderedIdList(req.body.company_ids));
        return H.successResponse(res, { saved: true }, 'Restaurants saved.');
    } catch (err) {
        console.error('[admin.collections.assign]', err && err.message);
        return H.errorResponse(res, 'Could not save restaurants.', 500);
    }
}

/** reorder — POST .../reorder { ids:[] } → save collection sort_order (row order). */
async function reorder(req, res) {
    try {
        const ids = orderedIdList(req.body.ids);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        const now = nowStr();
        for (let i = 0; i < ids.length; i++) {
            await db(T).where('id', ids[i]).update({ sort_order: i + 1, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Order saved.');
    } catch (err) {
        console.error('[admin.collections.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the order.', 500);
    }
}

module.exports = { list, getCollection, save, remove, statusToggle, companies, restaurants, assign, reorder };
