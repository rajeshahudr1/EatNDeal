'use strict';

/*
 * Controllers/Admin/FeaturedProductsController.js
 *
 * What:  Admin CRUD for FEATURED PRODUCTS (mp_featured_product) — the admin
 *        picks a restaurant, then its products (with order); the marketplace
 *        home feed shows one row PER restaurant (heading = restaurant name,
 *        cards = the chosen products). Managed PER restaurant: one "entry" =
 *        a restaurant + its ordered featured products.
 * Type:  READ + WRITE (mp_featured_product).
 * Used:  api/Routes/index.js — /admin/featured-products/*.
 */

const H      = require('../../Helpers/helper');
const M      = require('../../Helpers/marketplace');
const { db } = require('../../config/db');

const T = 'mp_featured_product';

// `company_position` is added by migration m260619_150000 — until that runs the
// column may be absent, so we feature-detect it (cached) and degrade gracefully.
let _hasCompanyPos = null;
async function hasCompanyPos() {
    if (_hasCompanyPos !== null) { return _hasCompanyPos; }
    try {
        const r = await db('information_schema.columns')
            .where({ table_name: T, column_name: 'company_position' }).first('column_name');
        _hasCompanyPos = !!r;
    } catch (e) { _hasCompanyPos = false; }
    return _hasCompanyPos;
}

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));
function orderedIdList(v) {
    let arr = v;
    if (!Array.isArray(arr)) { arr = (v != null && v !== '') ? [v] : []; }
    const seen = new Set(); const out = [];
    arr.map((n) => Number(n)).forEach((n) => { if (n > 0 && !seen.has(n)) { seen.add(n); out.push(n); } });
    return out;
}

/** list — GET /api/v1/admin/featured-products — one entry per restaurant. */
async function list(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const withPos = await hasCompanyPos();
        let qb = db(T + ' as f')
            .join('company as c', 'c.id', 'f.company_id')
            .modify((q2) => { if (q) { q2.andWhereRaw('LOWER(c.business_name) LIKE ?', ['%' + q + '%']); } })
            .groupBy('f.company_id', 'c.business_name', 'c.domain_name')
            .select('f.company_id', 'c.business_name', 'c.domain_name',
                    db.raw('COUNT(*) as products'),
                    db.raw('MAX(f.status) as status'));
        qb = withPos ? qb.orderByRaw('MAX(f.company_position) ASC, c.business_name ASC') : qb.orderBy('c.business_name', 'asc');
        const rows = await qb;
        const entries = rows.map((r) => ({
            company_id: Number(r.company_id),
            company_name: r.business_name || ('Company #' + r.company_id),
            company_detail: str(r.domain_name).trim() || ('ID ' + r.company_id),
            products: Number(r.products) || 0,
            status: Number(r.status),
        }));
        return H.successResponse(res, { entries, total: entries.length });
    } catch (err) {
        console.error('[admin.featuredProducts.list]', err && err.message);
        return H.errorResponse(res, 'Could not load featured products.', 500);
    }
}

/** getGroup — GET .../get?company_id= → the restaurant + its featured products (ordered). */
async function getGroup(req, res) {
    try {
        const companyId = Number(req.query.company_id) || 0;
        if (!companyId) { return H.successResponse(res, { company: null, products: [] }); }
        const co = await db('company').where('id', companyId).first('id', 'business_name', 'domain_name');
        if (!co) { return H.errorResponse(res, 'Restaurant not found.', 404); }
        const rows = await db(T + ' as f')
            .join('products as p', 'p.id', 'f.product_id')
            .where('f.company_id', companyId)
            .orderBy('f.position', 'asc')
            .select('p.id', 'p.name', 'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax', 'f.position');
        // Collapse duplicate NAMES (keep the first by position) so the form shows
        // each dish once; a re-save then persists the cleaned set.
        const seen = new Set();
        const deduped = rows.filter((r) => {
            const nm = String(r.name || '').trim().toLowerCase();
            if (seen.has(nm)) { return false; }
            seen.add(nm); return true;
        });
        return H.successResponse(res, {
            company: { id: Number(co.id), name: co.business_name || ('Company #' + co.id), detail: str(co.domain_name).trim() },
            products: deduped.map((r) => ({ id: Number(r.id), name: r.name || ('Product #' + r.id), price: M.pickPrice(r), position: Number(r.position) || 0 })),
        });
    } catch (err) {
        console.error('[admin.featuredProducts.getGroup]', err && err.message);
        return H.errorResponse(res, 'Could not load featured products.', 500);
    }
}

/** save — POST .../save { company_id, product_ids[] } → replace that restaurant's set. */
async function save(req, res) {
    try {
        const companyId = Number(req.body.company_id) || 0;
        if (!companyId) { return H.errorResponse(res, 'Select a restaurant.', 422); }
        const co = await db('company').where('id', companyId).andWhere('is_marketplace', 1)
            .andWhere('is_active', 1).whereNull('deleted_at').first('id');
        if (!co) { return H.errorResponse(res, 'That restaurant is not available on the marketplace.', 422); }

        const wanted = orderedIdList(req.body.product_ids);
        // Keep only products that belong to THIS company + are live, AND collapse
        // duplicate NAMES — a dish is featured ONCE even if the catalog repeats it
        // (same name, different ids). Preserves the requested order.
        let valid = [];
        if (wanted.length) {
            const rows = await db('products').whereIn('id', wanted).andWhere('company_id', companyId)
                .andWhere('show_marketplace', 1).andWhere('status', '1').select('id', 'name');
            const nameById = new Map(rows.map((r) => [Number(r.id), String(r.name || '').trim().toLowerCase()]));
            const seenNames = new Set();
            wanted.forEach((id) => {
                if (!nameById.has(id)) { return; }
                const nm = nameById.get(id) || ('id-' + id);
                if (seenNames.has(nm)) { return; }
                seenNames.add(nm);
                valid.push(id);
            });
        }

        // Preserve this restaurant's entry order (company_position) across the
        // del+insert; a brand-new entry goes to the end.
        const withPos = await hasCompanyPos();
        let cpos = 0;
        if (withPos) {
            const ex = await db(T).where('company_id', companyId).first('company_position');
            if (ex && Number(ex.company_position) > 0) { cpos = Number(ex.company_position); }
            else { const m = await db(T).max('company_position as mx').first(); cpos = (Number(m && m.mx) || 0) + 1; }
        }
        await db(T).where('company_id', companyId).del();
        if (valid.length) {
            const now = nowStr();
            await db(T).insert(valid.map((pid, i) => {
                const row = { company_id: companyId, product_id: pid, position: i + 1, status: 1, created_at: now };
                if (withPos) { row.company_position = cpos; }
                return row;
            }));
        }
        return H.successResponse(res, { saved: true, company_id: companyId, count: valid.length },
            valid.length ? 'Featured products saved.' : 'All featured products removed for this restaurant.');
    } catch (err) {
        console.error('[admin.featuredProducts.save]', err && err.message);
        return H.errorResponse(res, 'Could not save featured products.', 500);
    }
}

/** remove — POST .../delete { company_id } → drop a restaurant's whole entry. */
async function remove(req, res) {
    try {
        const companyId = Number(req.body.company_id) || 0;
        if (!companyId) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        const n = await db(T).where('company_id', companyId).del();
        return H.successResponse(res, { deleted: n }, 'Removed.');
    } catch (err) {
        console.error('[admin.featuredProducts.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST .../status { company_id, status } → toggle a restaurant's entry. */
async function statusToggle(req, res) {
    try {
        const companyId = Number(req.body.company_id) || 0;
        if (!companyId) { return H.errorResponse(res, 'Select a restaurant.', 422); }
        const status = Number(req.body.status) === 1 ? 1 : 0;
        const n = await db(T).where('company_id', companyId).update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.featuredProducts.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

/** reorder — POST .../reorder { company_ids:[] in display order } → entry order. */
async function reorder(req, res) {
    try {
        const companyIds = orderedIdList(req.body.company_ids);
        if (!companyIds.length) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        if (!(await hasCompanyPos())) {
            return H.errorResponse(res, 'Ordering needs the latest DB migration (run php yii migrate).', 409);
        }
        const now = nowStr();
        for (let i = 0; i < companyIds.length; i++) {
            await db(T).where('company_id', companyIds[i]).update({ company_position: i + 1, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Order saved.');
    } catch (err) {
        console.error('[admin.featuredProducts.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the order.', 500);
    }
}

/** companies — GET .../companies?q=&limit= — restaurant autocomplete. */
async function companies(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        // Default (no search) returns up to 50; search is case-insensitive.
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
        let qb = db('company').where('is_marketplace', 1).andWhere('is_active', 1).whereNull('deleted_at')
            .orderBy('business_name', 'asc').limit(limit).select('id', 'business_name', 'domain_name', 'email');
        if (q) { qb = qb.andWhereRaw('LOWER(business_name) LIKE ?', ['%' + q + '%']); }
        const rows = await qb;
        return H.successResponse(res, {
            companies: rows.map((r) => ({ id: Number(r.id), name: r.business_name || ('Company #' + r.id), detail: str(r.domain_name).trim() || str(r.email).trim() || ('ID ' + r.id) })),
        });
    } catch (err) {
        console.error('[admin.featuredProducts.companies]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

/** products — GET .../products?company_id=&q=&limit= — product autocomplete for ONE restaurant. */
async function products(req, res) {
    try {
        const companyId = Number(req.query.company_id) || 0;
        if (!companyId) { return H.successResponse(res, { products: [] }); }
        const q = String(req.query.q || '').trim().toLowerCase();
        // Default (no search) returns up to 50; search is case-insensitive.
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
        let qb = db('products').where('company_id', companyId).andWhere('show_marketplace', 1).andWhere('status', '1')
            .orderBy('name', 'asc').limit(limit)
            .select('id', 'name', 'marketplace_price', 'online_platform_price', 'price_after_tax');
        if (q) { qb = qb.andWhereRaw('LOWER(name) LIKE ?', ['%' + q + '%']); }
        const rows = await qb;
        return H.successResponse(res, {
            products: rows.map((r) => {
                const price = M.pickPrice(r);
                return { id: Number(r.id), name: r.name || ('Product #' + r.id), price, detail: '£' + Number(price || 0).toFixed(2) };
            }),
        });
    } catch (err) {
        console.error('[admin.featuredProducts.products]', err && err.message);
        return H.errorResponse(res, 'Could not load products.', 500);
    }
}

module.exports = { list, getGroup, save, remove, statusToggle, reorder, companies, products };
