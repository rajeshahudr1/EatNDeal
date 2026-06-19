'use strict';

/*
 * Controllers/Admin/CommunityController.js
 *
 * What:  Super-admin management of COMMUNITY groups — create / edit / delete /
 *        show-hide. `type`: 'user' (customers only) | 'restaurant' (admins +
 *        customers). Posts/likes/comments live on the customer + (later) admin
 *        community surfaces. Mirrors Admin/CollectionsController conventions.
 * Type:  READ + WRITE (mp_community_group + cascade).
 * Used:  api/Routes/index.js — /admin/community/*.
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');

const G = 'mp_community_group';
const P = 'mp_community_post';
const C = 'mp_community_comment';
const L = 'mp_community_like';

const PAGE_SIZES = [10, 25, 50, 100];
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));
function imageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return f; }
    return H.getUploadsBaseUrl() + '/marketplace/community_group/' + f;
}

/** list — GET /api/v1/admin/community */
async function list(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        const typeF = String(req.query.type || '');     // '', 'user', 'restaurant'
        const limitRaw = String(req.query.limit || '25');
        const limit = PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25;
        let page = Number(req.query.page) || 1; if (page < 1) { page = 1; }

        const base = () => db(G).modify((qb) => {
            if (q) { qb.andWhereRaw('LOWER(name) LIKE ?', ['%' + q + '%']); }
            if (typeF === 'user' || typeF === 'restaurant') { qb.andWhere('type', typeF); }
        });
        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        const rows = await base()
            .leftJoin(db(P).select('group_id').count('* as posts').where('status', 1).groupBy('group_id').as('p'), 'p.group_id', G + '.id')
            .select(G + '.id', G + '.name', G + '.description', G + '.image', G + '.type', G + '.status', db.raw('COALESCE(p.posts, 0) as posts'))
            .orderBy(G + '.id', 'desc').limit(limit).offset((page - 1) * limit);

        return H.successResponse(res, {
            groups: rows.map((r) => ({
                id: Number(r.id), name: r.name || '', description: r.description || '',
                image: r.image || '', image_url: imageUrl(r.image), type: r.type,
                status: Number(r.status), posts: Number(r.posts) || 0,
            })),
            total, page, limit, total_pages: totalPages, type: typeF,
        });
    } catch (err) {
        console.error('[admin.community.list]', err && err.message);
        return H.errorResponse(res, 'Could not load groups.', 500);
    }
}

/** getGroup — GET /api/v1/admin/community/get?id= */
async function getGroup(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        if (!id) { return H.successResponse(res, { group: null }); }
        const r = await db(G).where('id', id).first();
        if (!r) { return H.errorResponse(res, 'Group not found.', 404); }
        return H.successResponse(res, {
            group: { id: Number(r.id), name: r.name || '', description: r.description || '', image: r.image || '', image_url: imageUrl(r.image), type: r.type, status: Number(r.status) },
        });
    } catch (err) {
        console.error('[admin.community.getGroup]', err && err.message);
        return H.errorResponse(res, 'Could not load the group.', 500);
    }
}

/** save — POST /api/v1/admin/community/save */
async function save(req, res) {
    try {
        const b = req.body;
        const id = Number(b.id) || 0;
        const name = str(b.name).trim();
        if (!name) { return H.errorResponse(res, 'Group name is required.', 422); }
        const type = (b.type === 'restaurant') ? 'restaurant' : 'user';

        const patch = {
            name: name.slice(0, 120),
            description: str(b.description).slice(0, 255),
            type,
            status: Number(b.status) === 1 ? 1 : 0,
            updated_at: nowStr(),
        };
        if (b.image) { patch.image = str(b.image).slice(0, 255); }

        if (id) {
            const owned = await db(G).where('id', id).first();
            if (!owned) { return H.errorResponse(res, 'Group not found.', 404); }
            await db(G).where('id', id).update(patch);
            return H.successResponse(res, { saved: true, id }, 'Group updated.');
        }
        const ins = await db(G).insert({ ...patch, created_at: nowStr() }).returning('id');
        const newId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        return H.successResponse(res, { saved: true, id: newId }, 'Group created.');
    } catch (err) {
        console.error('[admin.community.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the group.', 500);
    }
}

/** remove — POST /api/v1/admin/community/delete { ids:[] } (cascades posts/comments/likes). */
async function remove(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Nothing to delete.', 422); }
        const postIds = await db(P).whereIn('group_id', ids).pluck('id');
        if (postIds.length) {
            await db(L).whereIn('post_id', postIds).del();
            await db(C).whereIn('post_id', postIds).del();
            await db(P).whereIn('id', postIds).del();
        }
        const n = await db(G).whereIn('id', ids).del();
        return H.successResponse(res, { deleted: n }, n + ' group' + (n === 1 ? '' : 's') + ' deleted.');
    } catch (err) {
        console.error('[admin.community.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete.', 500);
    }
}

/** statusToggle — POST /admin/community/status { ids:[], status } */
async function statusToggle(req, res) {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map((x) => Number(x)).filter((x) => x > 0);
        if (!ids.length) { return H.errorResponse(res, 'Select a group.', 422); }
        const status = Number(req.body.status) === 1 ? 1 : 0;
        const n = await db(G).whereIn('id', ids).update({ status, updated_at: nowStr() });
        return H.successResponse(res, { updated: n }, 'Status updated.');
    } catch (err) {
        console.error('[admin.community.statusToggle]', err && err.message);
        return H.errorResponse(res, 'Could not update status.', 500);
    }
}

module.exports = { list, getGroup, save, remove, statusToggle };
