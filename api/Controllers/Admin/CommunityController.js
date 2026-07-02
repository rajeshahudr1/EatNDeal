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
const CC     = require('../../config/community');
const { db } = require('../../config/db');

const G    = 'mp_community_group';
const P    = 'mp_community_post';
const C    = 'mp_community_comment';
const L    = 'mp_community_like';
const GL   = 'mp_community_group_location';
const BLK  = 'mp_community_block';
const CUST = 'customer';
const cname = (r) => (((r.firstname || '') + ' ' + (r.lastname || '')).trim());

// Normalise the inbound locations array (JSON string OR array) → clean rows.
// Only points with finite lat/lng survive; radius falls back to the configured
// default. Used when saving a user group's coverage areas.
function parseLocations(raw) {
    let arr = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { arr = []; } }
    if (!Array.isArray(arr)) { return []; }
    return arr.map((l) => ({
        label:     (l && l.label != null ? String(l.label) : '').slice(0, 160),
        lat:       (l && l.lat != null && l.lat !== '') ? Number(l.lat) : null,
        lng:       (l && l.lng != null && l.lng !== '') ? Number(l.lng) : null,
        radius_km: (l && Number(l.radius_km) > 0) ? Math.min(500, Math.round(Number(l.radius_km))) : CC.DEFAULT_RADIUS_KM,
    })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
}

// Replace a group's coverage areas (delete-then-insert keeps save idempotent).
async function replaceLocations(groupId, locations) {
    await db(GL).where('group_id', groupId).del();
    if (locations.length) {
        await db(GL).insert(locations.map((l) => ({ ...l, group_id: groupId, created_at: nowStr() })));
    }
}

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

        // Per-group post breakdown by moderation status. "posts" = approved
        // (live) count — what a company admin sees; super-admin gets the split.
        const postAgg = db(P).select('group_id')
            .select(db.raw('COUNT(*) FILTER (WHERE moderation_status = ?) AS approved', [CC.STATUS.APPROVED]))
            .select(db.raw('COUNT(*) FILTER (WHERE moderation_status = ?) AS pending',  [CC.STATUS.PENDING]))
            .select(db.raw('COUNT(*) FILTER (WHERE moderation_status = ?) AS rejected', [CC.STATUS.REJECTED]))
            .select(db.raw('COUNT(*) AS total'))
            .where('status', 1).groupBy('group_id').as('p');

        const rows = await base()
            .leftJoin(postAgg, 'p.group_id', G + '.id')
            .select(G + '.id', G + '.name', G + '.description', G + '.image', G + '.type', G + '.status',
                db.raw('COALESCE(p.approved, 0) as approved'), db.raw('COALESCE(p.pending, 0) as pending'),
                db.raw('COALESCE(p.rejected, 0) as rejected'), db.raw('COALESCE(p.total, 0) as total_posts'))
            .orderBy(G + '.id', 'desc').limit(limit).offset((page - 1) * limit);

        return H.successResponse(res, {
            groups: rows.map((r) => ({
                id: Number(r.id), name: r.name || '', description: r.description || '',
                image: r.image || '', image_url: imageUrl(r.image), type: r.type,
                status: Number(r.status),
                posts: Number(r.approved) || 0,   // live (approved) count
                approved: Number(r.approved) || 0, pending: Number(r.pending) || 0,
                rejected: Number(r.rejected) || 0, total_posts: Number(r.total_posts) || 0,
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
        const locs = await db(GL).where('group_id', id).orderBy('id', 'asc').select('id', 'label', 'lat', 'lng', 'radius_km');
        return H.successResponse(res, {
            group: {
                id: Number(r.id), name: r.name || '', description: r.description || '', image: r.image || '', image_url: imageUrl(r.image),
                type: r.type, status: Number(r.status),
                company_id:   r.company_id != null ? Number(r.company_id) : null,
                moderation:   r.moderation || CC.MODERATION.AI,
                tags:         r.tags || '',
                ai_rules:     r.ai_rules || '',
                is_sensitive: Number(r.is_sensitive) || 0,
                locations: locs.map((l) => ({
                    id: Number(l.id), label: l.label || '',
                    lat: l.lat != null ? Number(l.lat) : null, lng: l.lng != null ? Number(l.lng) : null,
                    radius_km: Number(l.radius_km) || CC.DEFAULT_RADIUS_KM,
                })),
            },
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
        const type = (b.type === CC.TYPE.RESTAURANT) ? CC.TYPE.RESTAURANT : CC.TYPE.USER;
        const moderation = Object.values(CC.MODERATION).indexOf(b.moderation) !== -1 ? b.moderation : CC.MODERATION.AI;

        const patch = {
            name: name.slice(0, 120),
            description: str(b.description).slice(0, 255),
            type,
            // Restaurant groups belong to a company; user groups don't.
            company_id:   (type === CC.TYPE.RESTAURANT && Number(b.company_id)) ? Number(b.company_id) : null,
            moderation,
            tags:         str(b.tags).slice(0, 500),
            ai_rules:     str(b.ai_rules).slice(0, 500),
            is_sensitive: Number(b.is_sensitive) === 1 ? 1 : 0,
            status:       Number(b.status) === 1 ? 1 : 0,
            updated_at:   nowStr(),
        };
        if (b.image) { patch.image = str(b.image).slice(0, 255); }

        // Only user groups are location-scoped; restaurant groups clear theirs.
        const locations = (type === CC.TYPE.USER) ? parseLocations(b.locations) : [];

        let groupId = id;
        if (id) {
            const owned = await db(G).where('id', id).first('id');
            if (!owned) { return H.errorResponse(res, 'Group not found.', 404); }
            await db(G).where('id', id).update(patch);
        } else {
            const ins = await db(G).insert({ ...patch, created_at: nowStr() }).returning('id');
            groupId = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        }
        await replaceLocations(groupId, locations);
        return H.successResponse(res, { saved: true, id: groupId }, id ? 'Group updated.' : 'Group created.');
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
        // Feed shows only APPROVED posts — pending/rejected live in the Review
        // queue (🛡️), where the super-admin approves or rejects them.
        const totalRow = await db(P).where({ group_id: groupId, status: 1, moderation_status: CC.STATUS.APPROVED }).count('* as n').first();
        const total = Number(totalRow && totalRow.n) || 0;
        const pendRow = await db(P).where({ group_id: groupId, status: 1, moderation_status: CC.STATUS.PENDING }).count('* as n').first();
        const rows = await db(P).where({ group_id: groupId, status: 1, moderation_status: CC.STATUS.APPROVED }).orderBy('id', 'desc').limit(limit).offset(offset)
            .select('id', 'author_type', 'author_id', 'author_name', 'body', 'image', 'likes_count', 'comments_count', 'created_at');
        return H.successResponse(res, {
            group: { id: Number(group.id), name: group.name, description: group.description || '', image_url: imageUrl(group.image), type: group.type, status: Number(group.status) },
            posts: rows.map((r) => ({ id: Number(r.id), body: r.body || '', image_url: postImageUrl(r.image), likes: Number(r.likes_count) || 0, comments: Number(r.comments_count) || 0, created_at: r.created_at, author: authorOf(r) })),
            total, offset, limit, has_more: offset + rows.length < total,
            pending_count: Number(pendRow && pendRow.n) || 0,
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
        const rows = await db(C).where({ post_id: postId, status: 1, moderation_status: CC.STATUS.APPROVED }).orderBy('id', 'asc').select(cols);
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

/** pending — GET /api/v1/admin/community/pending — AI/manual-held posts + comments. */
async function pending(req, res) {
    try {
        // status: pending (default) | rejected (revisit + re-approve) | approved
        // (view live items, with the option to pull one back).
        const st  = [CC.STATUS.REJECTED, CC.STATUS.APPROVED].indexOf(req.query.status) !== -1 ? req.query.status : CC.STATUS.PENDING;
        const gid = Number(req.query.group_id) || 0;     // filter to one group (feed popup / dropdown)
        const q   = String(req.query.q || '').trim();    // text search

        let postsQ = db(P + ' as p').leftJoin(G + ' as g', 'g.id', 'p.group_id')
            .where('p.status', 1).where('p.moderation_status', st);
        let cmntsQ = db(C + ' as c').leftJoin(P + ' as p', 'p.id', 'c.post_id').leftJoin(G + ' as g', 'g.id', 'p.group_id')
            .where('c.status', 1).where('c.moderation_status', st);
        if (gid) { postsQ = postsQ.where('p.group_id', gid); cmntsQ = cmntsQ.where('p.group_id', gid); }
        if (q)   { postsQ = postsQ.where('p.body', 'ilike', '%' + q + '%'); cmntsQ = cmntsQ.where('c.body', 'ilike', '%' + q + '%'); }

        const posts = await postsQ.orderBy('p.id', 'desc').limit(200)
            .select('p.id', 'p.body', 'p.image', 'p.author_name', 'p.ai_reason', 'p.created_at', 'g.name as group_name');
        const cmnts = await cmntsQ.orderBy('c.id', 'desc').limit(200)
            .select('c.id', 'c.body', 'c.author_name', 'c.ai_reason', 'c.created_at', 'g.name as group_name');
        const items = []
            .concat(posts.map((p) => ({ kind: 'post', id: Number(p.id), group_name: p.group_name || '', author_name: p.author_name || 'Member', body: p.body || '', image_url: postImageUrl(p.image), ai_reason: p.ai_reason || '', created_at: p.created_at })))
            .concat(cmnts.map((c) => ({ kind: 'comment', id: Number(c.id), group_name: c.group_name || '', author_name: c.author_name || 'Member', body: c.body || '', image_url: '', ai_reason: c.ai_reason || '', created_at: c.created_at })))
            .sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1));

        // Distinct groups that currently have items in this status (filter dropdown).
        const grows = await db(P + ' as p').leftJoin(G + ' as g', 'g.id', 'p.group_id')
            .where('p.status', 1).where('p.moderation_status', st).whereNotNull('g.id')
            .distinct('g.id', 'g.name').orderBy('g.name', 'asc');

        return H.successResponse(res, { items, count: items.length, groups: grows.map((g) => ({ id: Number(g.id), name: g.name || '' })) });
    } catch (err) { console.error('[admin.community.pending]', err && err.message); return H.errorResponse(res, 'Could not load the review queue.', 500); }
}

/** moderate — POST /api/v1/admin/community/moderate { id, kind, action } — approve/reject. */
async function moderate(req, res) {
    try {
        const id = Number(req.body.id) || 0;
        const kind = req.body.kind === 'comment' ? 'comment' : 'post';
        const action = req.body.action === 'reject' ? 'reject' : 'approve';
        if (!id) { return H.errorResponse(res, 'Item id is required.', 422); }
        const status = action === 'approve' ? CC.STATUS.APPROVED : CC.STATUS.REJECTED;
        const reason = String(req.body.reason || '').trim().slice(0, 500);
        // On reject, save the moderator's typed reason so the author sees WHY (in
        // their "My posts" → Rejected); if they didn't type one, keep whatever
        // reason is already there (e.g. the AI's). On approve → clear the reason.
        const patch = { moderation_status: status, ai_checked_at: nowStr() };
        if (action === 'approve') { patch.ai_reason = null; }
        else if (reason) { patch.ai_reason = reason; }
        if (kind === 'post') {
            await db(P).where('id', id).update(patch);
        } else {
            const c = await db(C).where('id', id).first('post_id', 'moderation_status');
            await db(C).where('id', id).update(patch);
            // Approving a held comment now counts it on its post.
            if (action === 'approve' && c && c.moderation_status !== CC.STATUS.APPROVED) {
                await db(P).where('id', c.post_id).increment('comments_count', 1);
            }
        }
        return H.successResponse(res, { id, kind, status }, action === 'approve' ? 'Approved.' : 'Rejected.');
    } catch (err) { console.error('[admin.community.moderate]', err && err.message); return H.errorResponse(res, 'Could not update.', 500); }
}

/** blockedList — GET /api/v1/admin/community/blocked?q= — blocked customers. */
async function blockedList(req, res) {
    try {
        const q = String(req.query.q || '').trim();
        let qb = db(BLK + ' as b').leftJoin(CUST + ' as c', 'c.id', 'b.customer_id')
            .orderBy('b.id', 'desc').limit(500)
            .select('b.id', 'b.customer_id', 'b.reason', 'b.created_at', 'c.firstname', 'c.lastname', 'c.email');
        if (q) {
            qb = qb.where(function () {
                this.where('c.firstname', 'ilike', '%' + q + '%').orWhere('c.lastname', 'ilike', '%' + q + '%')
                    .orWhere('c.email', 'ilike', '%' + q + '%').orWhereRaw('CAST(b.customer_id AS TEXT) = ?', [q]);
            });
        }
        const rows = await qb;
        return H.successResponse(res, { blocked: rows.map((r) => ({
            id: Number(r.id), customer_id: Number(r.customer_id), name: cname(r) || ('#' + r.customer_id),
            email: r.email || '', reason: r.reason || '', created_at: r.created_at,
        })) });
    } catch (err) { console.error('[admin.community.blockedList]', err && err.message); return H.errorResponse(res, 'Could not load blocked users.', 500); }
}

/** searchCustomers — GET /api/v1/admin/community/customers?q= — pick someone to block. */
async function searchCustomers(req, res) {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) { return H.successResponse(res, { customers: [] }); }
        const rows = await db(CUST).where(function () {
            this.where('firstname', 'ilike', '%' + q + '%').orWhere('lastname', 'ilike', '%' + q + '%')
                .orWhere('email', 'ilike', '%' + q + '%').orWhere('contact_no', 'ilike', '%' + q + '%');
        }).orderBy('id', 'desc').limit(15).select('id', 'firstname', 'lastname', 'email', 'contact_no');
        const ids = rows.map((r) => r.id);
        const blocked = ids.length ? await db(BLK).whereIn('customer_id', ids).pluck('customer_id') : [];
        const bset = new Set(blocked.map(String));
        return H.successResponse(res, { customers: rows.map((r) => ({
            id: Number(r.id), name: cname(r) || ('#' + r.id), email: r.email || '', contact: r.contact_no || '',
            blocked: bset.has(String(r.id)),
        })) });
    } catch (err) { console.error('[admin.community.searchCustomers]', err && err.message); return H.errorResponse(res, 'Could not search.', 500); }
}

/** blockUser — POST /api/v1/admin/community/block { customer_id, reason? }. */
async function blockUser(req, res) {
    try {
        const cid = Number(req.body.customer_id) || 0;
        if (!cid) { return H.errorResponse(res, 'Customer is required.', 422); }
        const exists = await db(BLK).where('customer_id', cid).first('id');
        if (!exists) {
            let me = { id: 0 };
            try { me = await adminIdentity(req); } catch (e) { /* keep 0 */ }
            await db(BLK).insert({ customer_id: cid, reason: str(req.body.reason).slice(0, 255) || null, created_at: nowStr(), created_by: (me && me.id) || null });
        }
        return H.successResponse(res, { blocked: true, customer_id: cid }, 'User blocked.');
    } catch (err) { console.error('[admin.community.blockUser]', err && err.message); return H.errorResponse(res, 'Could not block the user.', 500); }
}

/** unblockUser — POST /api/v1/admin/community/unblock { customer_id }. */
async function unblockUser(req, res) {
    try {
        const cid = Number(req.body.customer_id) || 0;
        if (!cid) { return H.errorResponse(res, 'Customer is required.', 422); }
        await db(BLK).where('customer_id', cid).del();
        return H.successResponse(res, { blocked: false, customer_id: cid }, 'User unblocked.');
    } catch (err) { console.error('[admin.community.unblockUser]', err && err.message); return H.errorResponse(res, 'Could not unblock the user.', 500); }
}

module.exports = { list, getGroup, save, remove, statusToggle, feed, createPost, comments, addComment, deletePost, deleteComment, pending, moderate, blockedList, searchCustomers, blockUser, unblockUser };
