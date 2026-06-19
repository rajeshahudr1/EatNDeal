'use strict';

/*
 * Controllers/Admin/FeaturedController.js
 *
 * What:  Admin CRUD for FEATURED / SPONSORED placements (mp_featured_placement)
 *        — an admin grants a restaurant (that paid extra, offline) a time-bound,
 *        priority-ordered spot in the dedicated "Featured" row at the top of the
 *        marketplace home feed. Fields: company, priority, label, starts_at,
 *        ends_at, amount_paid (record only), notes, status.
 * Type:  READ + WRITE (mp_featured_placement).
 * Used:  api/Routes/index.js — /admin/featured/*.
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');

const T = 'mp_featured_placement';
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));
// Normalise a datetime-ish input to 'YYYY-MM-DD HH:MM:SS' or null.
function dt(v) {
    const s = str(v).trim();
    if (!s) { return null; }
    const d = new Date(s);
    if (isNaN(d.getTime())) { return null; }
    return d.toISOString().slice(0, 19).replace('T', ' ');
}
// Is the placement live right now? (status=1 AND inside its date window.)
function isLive(r, now) {
    if (Number(r.status) !== 1) { return false; }
    if (r.starts_at && new Date(r.starts_at) > now) { return false; }
    if (r.ends_at && new Date(r.ends_at) < now) { return false; }
    return true;
}

/** list — GET /api/v1/admin/featured */
async function list(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const statusF = String(req.query.status || '');   // '', 'active', 'inactive'
        const limitRaw = String(req.query.limit || '25');
        const isAll = limitRaw === 'all';
        const limit = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);
        let page = Number(req.query.page) || 1;
        if (page < 1) { page = 1; }

        const base = () => db(T + ' as f').join('company as c', 'c.id', 'f.company_id').modify((qb) => {
            if (q) { qb.andWhereRaw('LOWER(c.business_name) LIKE ?', ['%' + q + '%']); }
            if (statusF === 'active') { qb.andWhere('f.status', 1); }
            else if (statusF === 'inactive') { qb.andWhere('f.status', '!=', 1); }
        });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        let qb = base()
            .select('f.id', 'f.company_id', 'f.priority', 'f.label', 'f.starts_at', 'f.ends_at',
                    'f.amount_paid', 'f.notes', 'f.status', 'c.business_name', 'c.domain_name')
            .orderBy('f.status', 'desc').orderBy('f.priority', 'desc').orderBy('f.id', 'desc');
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;
        const now = new Date();

        const placements = rows.map((r) => ({
            id: Number(r.id),
            company_id: Number(r.company_id),
            company_name: r.business_name || ('Company #' + r.company_id),
            company_detail: str(r.domain_name).trim() || ('ID ' + r.company_id),
            priority: Number(r.priority) || 0,
            label: r.label || 'Featured',
            starts_at: r.starts_at || null,
            ends_at: r.ends_at || null,
            amount_paid: r.amount_paid != null ? Number(r.amount_paid) : null,
            notes: r.notes || '',
            status: Number(r.status),
            live: isLive(r, now),
        }));

        return H.successResponse(res, {
            placements, total, page, limit: isAll ? 'all' : limit, total_pages: totalPages, status: statusF,
        });
    } catch (err) {
        console.error('[admin.featured.list]', err && err.message);
        return H.errorResponse(res, 'Could not load featured placements.', 500);
    }
}

/** getPlacement — GET /api/v1/admin/featured/get?id= */
async function getPlacement(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        if (!id) { return H.successResponse(res, { placement: null }); }
        const r = await db(T + ' as f').join('company as c', 'c.id', 'f.company_id')
            .where('f.id', id)
            .select('f.id', 'f.company_id', 'f.priority', 'f.label', 'f.starts_at', 'f.ends_at',
                    'f.amount_paid', 'f.notes', 'f.status', 'c.business_name', 'c.domain_name')
            .first();
        if (!r) { return H.errorResponse(res, 'Placement not found.', 404); }
        return H.successResponse(res, {
            placement: {
                id: Number(r.id),
                company_id: Number(r.company_id),
                company_name: r.business_name || ('Company #' + r.company_id),
                company_detail: str(r.domain_name).trim() || ('ID ' + r.company_id),
                priority: Number(r.priority) || 0,
                label: r.label || 'Featured',
                starts_at: r.starts_at || null,
                ends_at: r.ends_at || null,
                amount_paid: r.amount_paid != null ? Number(r.amount_paid) : null,
                notes: r.notes || '',
                status: Number(r.status),
            },
        });
    } catch (err) {
        console.error('[admin.featured.getPlacement]', err && err.message);
        return H.errorResponse(res, 'Could not load the placement.', 500);
    }
}

/** save — POST /api/v1/admin/featured/save */
async function save(req, res) {
    try {
        const b = req.body;
        const id = Number(b.id) || 0;
        const companyId = Number(b.company_id) || 0;
        if (!companyId) { return H.errorResponse(res, 'Select a restaurant.', 422); }

        // The restaurant must be a live marketplace company.
        const co = await db('company').where('id', companyId).andWhere('is_marketplace', 1)
            .andWhere('is_active', 1).whereNull('deleted_at').first('id');
        if (!co) { return H.errorResponse(res, 'That restaurant is not available on the marketplace.', 422); }

        const startsAt = dt(b.starts_at);
        const endsAt = dt(b.ends_at);
        if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) {
            return H.errorResponse(res, 'End date must be after the start date.', 422);
        }
        let amount = null;
        if (str(b.amount_paid).trim() !== '') {
            amount = Number(b.amount_paid);
            if (isNaN(amount) || amount < 0) { return H.errorResponse(res, 'Enter a valid amount.', 422); }
        }

        const patch = {
            company_id: companyId,
            priority: Number(b.priority) || 0,
            label: (str(b.label).trim() || 'Featured').slice(0, 40),
            starts_at: startsAt,
            ends_at: endsAt,
            amount_paid: amount,
            notes: str(b.notes).slice(0, 255),
            status: Number(b.status) === 1 ? 1 : 0,
            updated_at: nowStr(),
        };

        if (id) {
            const owned = await db(T).where('id', id).first();
            if (!owned) { return H.errorResponse(res, 'Placement not found.', 404); }
            await db(T).where('id', id).update(patch);
            return H.successResponse(res, { saved: true, id }, 'Placement updated.');
        }
        const ins = await db(T).insert({ ...patch, created_at: nowStr() }).returning('id');
        const newId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        return H.successResponse(res, { saved: true, id: newId }, 'Placement created.');
    } catch (err) {
        console.error('[admin.featured.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the placement.', 500);
    }
}

/** remove — POST /api/v1/admin/featured/delete { ids:[] } */
async function remove(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        const n = await db(T).whereIn('id', ids).del();
        return H.successResponse(res, { deleted: n }, n + ' placement' + (n === 1 ? '' : 's') + ' deleted.');
    } catch (err) {
        console.error('[admin.featured.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST /admin/featured/status { ids:[], status } */
async function statusToggle(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select a placement.', 422); }
        const status = Number(req.body.status) === 1 ? 1 : 0;
        const n = await db(T).whereIn('id', ids).update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.featured.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

/**
 * reorder — POST /admin/featured/delete { ids:[] in display order }
 * Drag-reorder: the FIRST id gets the highest priority, so the home
 * Featured / Sponsored rows (ordered by priority DESC) match the drag order.
 * Each label group keeps its members' relative order.
 */
async function reorder(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to reorder.', 422); }
        const now = nowStr();
        const n = ids.length;
        for (let i = 0; i < ids.length; i++) {
            await db(T).where('id', ids[i]).update({ priority: n - i, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Order saved.');
    } catch (err) {
        console.error('[admin.featured.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the order.', 500);
    }
}

/** companies — GET /admin/featured/companies?q=&limit= — autocomplete restaurants. */
async function companies(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
        let qb = db('company').where('is_marketplace', 1).andWhere('is_active', 1).whereNull('deleted_at')
            .orderBy('business_name', 'asc').limit(limit).select('id', 'business_name', 'domain_name', 'email');
        if (q) { qb = qb.andWhereRaw('LOWER(business_name) LIKE ?', ['%' + q + '%']); }
        const rows = await qb;
        return H.successResponse(res, {
            companies: rows.map((r) => ({
                id: Number(r.id),
                name: r.business_name || ('Company #' + r.id),
                detail: str(r.domain_name).trim() || str(r.email).trim() || ('ID ' + r.id),
            })),
        });
    } catch (err) {
        console.error('[admin.featured.companies]', err && err.message);
        return H.errorResponse(res, 'Could not load restaurants.', 500);
    }
}

module.exports = { list, getPlacement, save, remove, statusToggle, reorder, companies };
