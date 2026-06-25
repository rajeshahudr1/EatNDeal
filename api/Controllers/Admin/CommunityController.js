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
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/marketplace/community_group/' + f;
}
// Post-photo url (web-served relative path stays as-is; bare filename → uploads).
function postImageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/marketplace/community/' + f;
}
function initialOf(name) { const s = str(name).trim(); return s ? s.charAt(0).toUpperCase() : '?'; }
function tintFor(id) { return Math.abs(Number(id) || 0) % 7; }
function authorOf(row) { return { name: row.author_name || 'Member', type: row.author_type, id: Number(row.author_id) || 0, initial: initialOf(row.author_name), tint: tintFor(row.author_id) }; }

// Reply threads — parent_id is added by a later migration; feature-detect it.
let _hasParent = null;
async function hasParentCol() {
    if (_hasParent !== null) { return _hasParent; }
    try { const info = await db(C).columnInfo(); _hasParent = !!info.parent_id; }
    catch (e) { _hasParent = false; }
    return _hasParent;
}
async function resolveParent(rawParent, postId) {
    const pid = Number(rawParent) || 0;
    if (!pid) { return null; }
    const parent = await db(C).where({ id: pid, post_id: postId, status: 1 }).first('id', 'parent_id');
    if (!parent) { return null; }
    return parent.parent_id ? Number(parent.parent_id) : Number(parent.id);
}

// Resolve the signed-in admin's display name (the JWT carries only sub/src).
// company-src → the restaurant's business name; user-src → the staff name.
async function adminIdentity(req) {
    const sub = Number(req.user && req.user.sub) || 0;
    const src = req.user && req.user.src;
    let name = 'Admin';
    try {
        if (src === 'company') {
            const c = await db('company').where('id', sub).first('business_name', 'first_name', 'last_name');
            name = (c && (c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' '))) || 'Restaurant';
        } else {
            const u = await db('user').where('id', sub).first('firstname', 'lastname', 'username');
            name = (u && ([u.firstname, u.lastname].filter(Boolean).join(' ') || u.username)) || 'Admin';
        }
    } catch (e) { /* keep the fallback name */ }
    return { id: sub, name: str(name).slice(0, 120) };
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

/** feed — GET /api/v1/admin/community/feed?group_id=&offset=&limit= — a group's posts. */
async function feed(req, res) {
    try {
        const groupId = Number(req.query.group_id) || 0;
        if (!groupId) { return H.errorResponse(res, 'Group is required.', 422); }
        const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const group = await db(G).where({ id: groupId }).first('id', 'name', 'description', 'image', 'type', 'status');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }
        const totalRow = await db(P).where({ group_id: groupId, status: 1 }).count('* as n').first();
        const total = Number(totalRow && totalRow.n) || 0;
        const rows = await db(P).where({ group_id: groupId, status: 1 }).orderBy('id', 'desc').limit(limit).offset(offset)
            .select('id', 'author_type', 'author_id', 'author_name', 'body', 'image', 'likes_count', 'comments_count', 'created_at');
        return H.successResponse(res, {
            group: { id: Number(group.id), name: group.name, description: group.description || '', type: group.type, status: Number(group.status) },
            posts: rows.map((r) => ({ id: Number(r.id), body: r.body || '', image_url: postImageUrl(r.image), likes: Number(r.likes_count) || 0, comments: Number(r.comments_count) || 0, created_at: r.created_at, author: authorOf(r) })),
            total, offset, limit, has_more: offset + rows.length < total,
        });
    } catch (err) { console.error('[admin.community.feed]', err && err.message); return H.errorResponse(res, 'Could not load the feed.', 500); }
}

/** createPost — POST /api/v1/admin/community/post { group_id, body } — admin posts (text). */
async function createPost(req, res) {
    try {
        const me = await adminIdentity(req);
        const groupId = Number(req.body.group_id) || 0;
        const group = await db(G).where({ id: groupId, status: 1 }).first('id');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }
        const body = str(req.body.body).trim().slice(0, 5000);
        const image = str(req.body.image).trim().slice(0, 255);
        if (!body && !image) { return H.errorResponse(res, 'Write something or add a photo.', 422); }
        const ins = await db(P).insert({ group_id: groupId, author_type: 'admin', author_id: me.id, author_name: me.name, body, image: image || null, likes_count: 0, comments_count: 0, status: 1, created_at: nowStr() }).returning('id');
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        return H.successResponse(res, { id: Number(id), image_url: postImageUrl(image), author: { name: me.name, type: 'admin', id: me.id, initial: initialOf(me.name), tint: tintFor(me.id) } }, 'Posted.');
    } catch (err) { console.error('[admin.community.createPost]', err && err.message); return H.errorResponse(res, 'Could not post.', 500); }
}

/** comments — GET /api/v1/admin/community/comments?post_id= */
async function comments(req, res) {
    try {
        const postId = Number(req.query.post_id) || 0;
        if (!postId) { return H.errorResponse(res, 'Post is required.', 422); }
        const hp = await hasParentCol();
        const cols = ['id', 'author_type', 'author_id', 'author_name', 'body', 'created_at'];
        if (hp) { cols.push('parent_id'); }
        const rows = await db(C).where({ post_id: postId, status: 1 }).orderBy('id', 'asc').select(cols);
        return H.successResponse(res, { comments: rows.map((r) => ({ id: Number(r.id), parent_id: hp ? (Number(r.parent_id) || null) : null, body: r.body || '', created_at: r.created_at, author: authorOf(r) })) });
    } catch (err) { console.error('[admin.community.comments]', err && err.message); return H.errorResponse(res, 'Could not load comments.', 500); }
}

/** addComment — POST /api/v1/admin/community/comment { post_id, body } */
async function addComment(req, res) {
    try {
        const me = await adminIdentity(req);
        const postId = Number(req.body.post_id) || 0;
        const post = await db(P).where({ id: postId, status: 1 }).first('id');
        if (!post) { return H.errorResponse(res, 'Post not found.', 404); }
        const body = str(req.body.body).trim().slice(0, 2000);
        if (!body) { return H.errorResponse(res, 'Write a comment.', 422); }
        const data = { post_id: postId, author_type: 'admin', author_id: me.id, author_name: me.name, body, status: 1, created_at: nowStr() };
        let parentId = null;
        if (await hasParentCol()) { parentId = await resolveParent(req.body.parent_id, postId); data.parent_id = parentId; }
        const ins = await db(C).insert(data).returning('id');
        await db(P).where({ id: postId }).increment('comments_count', 1);
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        const cntRow = await db(P).where({ id: postId }).first('comments_count');
        return H.successResponse(res, { comment: { id: Number(id), parent_id: parentId, body, created_at: nowStr(), author: { name: me.name, type: 'admin', id: me.id, initial: initialOf(me.name), tint: tintFor(me.id) } }, comments: Number(cntRow && cntRow.comments_count) || 0 }, 'Commented.');
    } catch (err) { console.error('[admin.community.addComment]', err && err.message); return H.errorResponse(res, 'Could not comment.', 500); }
}

/** deletePost — POST /api/v1/admin/community/post-delete { post_id } — moderation (cascade). */
async function deletePost(req, res) {
    try {
        const postId = Number(req.body.post_id || req.body.id) || 0;
        if (!postId) { return H.errorResponse(res, 'Post is required.', 422); }
        await db(L).where({ post_id: postId }).del();
        await db(C).where({ post_id: postId }).del();
        const n = await db(P).where({ id: postId }).del();
        return H.successResponse(res, { deleted: n }, 'Post removed.');
    } catch (err) { console.error('[admin.community.deletePost]', err && err.message); return H.errorResponse(res, 'Could not remove the post.', 500); }
}

/** deleteComment — POST /api/v1/admin/community/comment-delete { comment_id } — moderation. */
async function deleteComment(req, res) {
    try {
        const commentId = Number(req.body.comment_id || req.body.id) || 0;
        if (!commentId) { return H.errorResponse(res, 'Comment is required.', 422); }
        const c = await db(C).where({ id: commentId }).first('post_id');
        const n = await db(C).where({ id: commentId }).del();
        if (c && n) { await db(P).where({ id: c.post_id }).where('comments_count', '>', 0).decrement('comments_count', 1); }
        return H.successResponse(res, { deleted: n }, 'Comment removed.');
    } catch (err) { console.error('[admin.community.deleteComment]', err && err.message); return H.errorResponse(res, 'Could not remove the comment.', 500); }
}

module.exports = { list, getGroup, save, remove, statusToggle, feed, createPost, comments, addComment, deletePost, deleteComment };
