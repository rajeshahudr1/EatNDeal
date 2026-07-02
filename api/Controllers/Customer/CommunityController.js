'use strict';

/*
 * Controllers/Customer/CommunityController.js
 *
 * What:  The customer-facing COMMUNITY (Facebook-style groups). Read endpoints
 *        work for GUESTS too (signed-out can browse). Write endpoints (post /
 *        like / comment) require a signed-in customer — the web proxy injects
 *        customer_id only for logged-in users, so a guest write 401s upstream.
 *
 *        Visible groups for a CUSTOMER: both 'user' and 'restaurant' types.
 *
 * Type:  READ + WRITE (mp_community_group / _post / _comment / _like).
 * Used:  api/Routes/index.js under /customer/community/*.
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const scope     = require('../../Helpers/communityScope');
const CC        = require('../../config/community');
const AI        = require('../../Helpers/aiModeration');
const { db }    = require('../../config/db');

const G   = 'mp_community_group';
const P   = 'mp_community_post';
const C   = 'mp_community_comment';
const L   = 'mp_community_like';
const GL  = 'mp_community_group_location';
const BLK = 'mp_community_block';

// A blocked customer can READ the community but can't post / like / comment.
async function isBlocked(customerId) {
    if (!customerId) { return false; }
    try { return !!(await db(BLK).where('customer_id', customerId).first('id')); }
    catch (e) { return false; }   // table missing (pre-migration) → don't block
}

function imageUrl(file, folder) {
    const f = String(file || '').trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/marketplace/' + folder + '/' + f;
}
function initialOf(name) { const s = String(name || '').trim(); return s ? s.charAt(0).toUpperCase() : '?'; }
// Avatar tint as an INDEX 0..6 (the web maps it to a .cavatar--t<n> CSS class
// — never an inline style, so the strict style-src 'self' CSP stays happy).
function tintFor(id) { return Math.abs(Number(id) || 0) % 7; }
// Author identity from the post/comment row.
function author(row) {
    return { name: row.author_name || 'Member', type: row.author_type, id: Number(row.author_id) || 0, initial: initialOf(row.author_name), tint: tintFor(row.author_id) };
}

// Reply threads — the parent_id column is added by a later migration, so we
// feature-detect it (cached) and keep replies working only once it exists.
let _hasParent = null;
async function hasParentCol() {
    if (_hasParent !== null) { return _hasParent; }
    try { const info = await db(C).columnInfo(); _hasParent = !!info.parent_id; }
    catch (e) { _hasParent = false; }
    return _hasParent;
}
// Resolve a reply target to a TOP-LEVEL comment id (one visual level of
// nesting) and only when it belongs to the same post; null = top-level comment.
async function resolveParent(rawParent, postId) {
    const pid = Number(rawParent) || 0;
    if (!pid) { return null; }
    const parent = await db(C).where({ id: pid, post_id: postId, status: 1 }).first('id', 'parent_id');
    if (!parent) { return null; }
    return parent.parent_id ? Number(parent.parent_id) : Number(parent.id);
}

/** groups — GET /customer/community/groups?customer_id? — visible groups (guest-ok). */
async function groups(req, res) {
    try {
        const lat = req.query.lat;
        const lng = req.query.lng;
        // Customers only see USER groups — restaurant groups live in the admin
        // (their company admin). Post counts reflect APPROVED posts only.
        const rows = await db(G + ' as g')
            .where('g.status', 1)
            .where('g.type', CC.TYPE.USER)
            .leftJoin(db(P).select('group_id').count('* as posts').where('status', 1).where('moderation_status', CC.STATUS.APPROVED).groupBy('group_id').as('p'), 'p.group_id', 'g.id')
            .orderBy('g.id', 'desc')
            .select('g.id', 'g.name', 'g.description', 'g.image', 'g.type', db.raw('COALESCE(p.posts, 0) as posts'));

        // Location filter: a group is shown only if the customer is within any
        // of its radii. A group with no locations = all-areas (shown to all).
        const ids = rows.map((g) => g.id);
        const locRows = ids.length
            ? await db(GL).whereIn('group_id', ids).select('group_id', 'lat', 'lng', 'radius_km')
            : [];
        const locsByGroup = {};
        locRows.forEach((l) => { const k = String(l.group_id); (locsByGroup[k] = locsByGroup[k] || []).push(l); });
        const visible = rows.filter((g) => scope.withinAnyLocation(lat, lng, locsByGroup[String(g.id)] || []));

        return H.successResponse(res, {
            groups: visible.map((g) => ({
                id: Number(g.id), name: g.name || '', description: g.description || '',
                image_url: imageUrl(g.image, 'community_group'), type: g.type,
                posts: Number(g.posts) || 0, initial: initialOf(g.name), tint: tintFor(g.id),
            })),
        });
    } catch (err) {
        H.log.error('community.groups', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** feed — GET /customer/community/feed?group_id=&customer_id?&offset?&limit? — posts (guest-ok). */
async function feed(req, res) {
    try {
        const groupId = Number(req.query.group_id) || 0;
        if (!groupId) { return H.errorResponse(res, 'Group is required.', 422); }
        const customerId = Number(req.query.customer_id) || 0;
        const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));
        const offset = Math.max(0, Number(req.query.offset) || 0);

        const group = await db(G).where({ id: groupId, status: 1 }).where('type', CC.TYPE.USER).first('id', 'name', 'description', 'image', 'type');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }

        // ONLY approved posts show in the feed — held (pending/rejected) posts
        // stay hidden until a moderator approves them, even from their author.
        const modWhere = (qb) => qb.where('moderation_status', CC.STATUS.APPROVED);

        const totalRow = await modWhere(db(P).where({ group_id: groupId, status: 1 })).count('* as n').first();
        const total = Number(totalRow && totalRow.n) || 0;

        const rows = await modWhere(db(P).where({ group_id: groupId, status: 1 }))
            .orderBy('id', 'desc').limit(limit).offset(offset)
            .select('id', 'author_type', 'author_id', 'author_name', 'body', 'image', 'likes_count', 'comments_count', 'moderation_status', 'ai_reason', 'created_at');

        // Which of these did the signed-in customer like?
        let likedSet = new Set();
        if (customerId && rows.length) {
            const liked = await db(L).where({ author_type: 'customer', author_id: customerId })
                .whereIn('post_id', rows.map((r) => r.id)).pluck('post_id');
            likedSet = new Set(liked.map(String));
        }

        return H.successResponse(res, {
            group: { id: Number(group.id), name: group.name, description: group.description || '', image_url: imageUrl(group.image, 'community_group'), type: group.type },
            posts: rows.map((r) => ({
                id: Number(r.id), body: r.body || '', image_url: imageUrl(r.image, 'community'),
                likes: Number(r.likes_count) || 0, comments: Number(r.comments_count) || 0,
                liked: likedSet.has(String(r.id)),
                moderation_status: r.moderation_status, ai_reason: r.ai_reason || '',
                pending: r.moderation_status === CC.STATUS.PENDING, rejected: r.moderation_status === CC.STATUS.REJECTED,
                created_at: r.created_at, author: author(r),
            })),
            total, offset, limit, has_more: offset + rows.length < total,
        });
    } catch (err) {
        H.log.error('community.feed', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

// Signed-in customer guard — returns { id, name } or sends an error.
async function requireCustomer(req, res, idVal) {
    const { row, error } = await customers.loadMarketplaceCustomer(idVal);
    if (error) { H.errorResponse(res, error.msg, error.status); return null; }
    const name = (((row.firstname || row.first_name || '') + ' ' + (row.lastname || row.last_name || '')).trim()) || 'Member';
    return { id: Number(idVal), name };
}

/** createPost — POST /customer/community/post { customer_id, group_id, body, image? } */
async function createPost(req, res) {
    try {
        const b = req.body;
        const cust = await requireCustomer(req, res, b.customer_id);
        if (!cust) { return; }
        if (await isBlocked(cust.id)) { return H.errorResponse(res, 'You have been blocked from posting in the community.', 403); }
        const groupId = Number(b.group_id) || 0;
        const group = await db(G).where({ id: groupId, status: 1 }).where('type', CC.TYPE.USER)
            .first('id', 'name', 'description', 'tags', 'ai_rules', 'is_sensitive', 'moderation');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }
        const body = String(b.body || '').trim().slice(0, 5000);
        const image = String(b.image || '').trim().slice(0, 255);
        if (!body && !image) { return H.errorResponse(res, 'Write something or add a photo.', 422); }

        // AI moderation → approved (live) or pending (held for super-admin review).
        const verdict = await AI.moderate({ group, body, imageUrl: image });
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const ins = await db(P).insert({
            group_id: groupId, author_type: 'customer', author_id: cust.id, author_name: cust.name,
            body, image: image || null, likes_count: 0, comments_count: 0, status: 1,
            moderation_status: verdict.status, ai_reason: verdict.reason || null, ai_checked_at: now,
            created_at: now,
        }).returning('id');
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        const pending = verdict.status === CC.STATUS.PENDING;
        return H.successResponse(res, { id: Number(id), moderation_status: verdict.status, pending, ai_reason: verdict.reason || '' },
            pending ? 'Sent for review — a moderator will approve it shortly.' : 'Posted.');
    } catch (err) {
        H.log.error('community.createPost', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** toggleLike — POST /customer/community/like { customer_id, post_id } → like/unlike. */
async function toggleLike(req, res) {
    try {
        const cust = await requireCustomer(req, res, req.body.customer_id);
        if (!cust) { return; }
        if (await isBlocked(cust.id)) { return H.errorResponse(res, 'You have been blocked from interacting in the community.', 403); }
        const postId = Number(req.body.post_id) || 0;
        const post = await db(P).where({ id: postId, status: 1 }).first('id');
        if (!post) { return H.errorResponse(res, 'Post not found.', 404); }

        const existing = await db(L).where({ post_id: postId, author_type: 'customer', author_id: cust.id }).first('id');
        let liked;
        if (existing) {
            await db(L).where({ id: existing.id }).del();
            await db(P).where({ id: postId }).decrement('likes_count', 1);
            liked = false;
        } else {
            await db(L).insert({ post_id: postId, author_type: 'customer', author_id: cust.id, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
            await db(P).where({ id: postId }).increment('likes_count', 1);
            liked = true;
        }
        const row = await db(P).where({ id: postId }).first('likes_count');
        return H.successResponse(res, { liked, likes: Math.max(0, Number(row && row.likes_count) || 0) });
    } catch (err) {
        H.log.error('community.toggleLike', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** comments — GET /customer/community/comments?post_id= (guest-ok). */
async function comments(req, res) {
    try {
        const postId = Number(req.query.post_id) || 0;
        if (!postId) { return H.errorResponse(res, 'Post is required.', 422); }
        const customerId = Number(req.query.customer_id) || 0;
        const hp = await hasParentCol();
        const cols = ['id', 'author_type', 'author_id', 'author_name', 'body', 'moderation_status', 'created_at'];
        if (hp) { cols.push('parent_id'); }
        const rows = await db(C).where({ post_id: postId, status: 1, moderation_status: CC.STATUS.APPROVED })
            .orderBy('id', 'asc').select(cols);
        return H.successResponse(res, {
            comments: rows.map((r) => ({ id: Number(r.id), parent_id: hp ? (Number(r.parent_id) || null) : null, body: r.body || '', pending: r.moderation_status === CC.STATUS.PENDING, created_at: r.created_at, author: author(r) })),
        });
    } catch (err) {
        H.log.error('community.comments', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** addComment — POST /customer/community/comment { customer_id, post_id, body } */
async function addComment(req, res) {
    try {
        const cust = await requireCustomer(req, res, req.body.customer_id);
        if (!cust) { return; }
        if (await isBlocked(cust.id)) { return H.errorResponse(res, 'You have been blocked from commenting in the community.', 403); }
        const postId = Number(req.body.post_id) || 0;
        // Pull the post + its group's moderation config (for the AI check).
        const post = await db(P + ' as p').where('p.id', postId).where('p.status', 1)
            .leftJoin(G + ' as g', 'g.id', 'p.group_id')
            .first('p.id', 'g.name', 'g.description', 'g.tags', 'g.ai_rules', 'g.is_sensitive', 'g.moderation');
        if (!post) { return H.errorResponse(res, 'Post not found.', 404); }
        const body = String(req.body.body || '').trim().slice(0, 2000);
        if (!body) { return H.errorResponse(res, 'Write a comment.', 422); }

        const verdict = await AI.moderate({ group: post, body, imageUrl: null });
        const approved = verdict.status === CC.STATUS.APPROVED;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const data = { post_id: postId, author_type: 'customer', author_id: cust.id, author_name: cust.name, body, status: 1,
            moderation_status: verdict.status, ai_reason: verdict.reason || null, ai_checked_at: now, created_at: now };
        let parentId = null;
        if (await hasParentCol()) { parentId = await resolveParent(req.body.parent_id, postId); data.parent_id = parentId; }
        const ins = await db(C).insert(data).returning('id');
        if (approved) { await db(P).where({ id: postId }).increment('comments_count', 1); }   // count approved only
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        const cntRow = await db(P).where({ id: postId }).first('comments_count');
        return H.successResponse(res, {
            comment: { id: Number(id), parent_id: parentId, body, pending: !approved, created_at: now, author: { name: cust.name, type: 'customer', id: cust.id, initial: initialOf(cust.name), tint: tintFor(cust.id) } },
            comments: Number(cntRow && cntRow.comments_count) || 0, moderation_status: verdict.status, pending: !approved,
        }, approved ? 'Commented.' : 'Sent for review — a moderator will approve it shortly.');
    } catch (err) {
        H.log.error('community.addComment', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** deletePost — POST /customer/community/post-delete { customer_id, post_id } — own only. */
async function deletePost(req, res) {
    try {
        const cust = await requireCustomer(req, res, req.body.customer_id);
        if (!cust) { return; }
        const postId = Number(req.body.post_id) || 0;
        const post = await db(P).where({ id: postId }).first('id', 'author_type', 'author_id');
        if (!post) { return H.errorResponse(res, 'Post not found.', 404); }
        if (!(post.author_type === 'customer' && Number(post.author_id) === cust.id)) {
            return H.errorResponse(res, 'You can only delete your own post.', 403);
        }
        await db(L).where({ post_id: postId }).del();
        await db(C).where({ post_id: postId }).del();
        await db(P).where({ id: postId }).del();
        return H.successResponse(res, { deleted: 1 }, 'Post deleted.');
    } catch (err) {
        H.log.error('community.deletePost', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** deleteComment — POST /customer/community/comment-delete { customer_id, comment_id } — own only. */
async function deleteComment(req, res) {
    try {
        const cust = await requireCustomer(req, res, req.body.customer_id);
        if (!cust) { return; }
        const commentId = Number(req.body.comment_id) || 0;
        const c = await db(C).where({ id: commentId }).first('id', 'post_id', 'author_type', 'author_id');
        if (!c) { return H.errorResponse(res, 'Comment not found.', 404); }
        if (!(c.author_type === 'customer' && Number(c.author_id) === cust.id)) {
            return H.errorResponse(res, 'You can only delete your own comment.', 403);
        }
        await db(C).where({ id: commentId }).del();
        await db(P).where({ id: c.post_id }).where('comments_count', '>', 0).decrement('comments_count', 1);
        const cntRow = await db(P).where({ id: c.post_id }).first('comments_count');
        return H.successResponse(res, { deleted: 1, comments: Number(cntRow && cntRow.comments_count) || 0 }, 'Comment deleted.');
    } catch (err) {
        H.log.error('community.deleteComment', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/** myPosts — GET /customer/community/my-posts?customer_id=&group_id?&status?
 *  The signed-in customer's OWN posts with moderation status + per-status counts,
 *  so they can track what's pending / approved / rejected (the public feed only
 *  shows approved, so this is where the author follows their submissions). */
async function myPosts(req, res) {
    try {
        const cust = await requireCustomer(req, res, req.query.customer_id);
        if (!cust) { return; }
        const groupId = Number(req.query.group_id) || 0;
        const status = [CC.STATUS.APPROVED, CC.STATUS.PENDING, CC.STATUS.REJECTED].indexOf(req.query.status) !== -1 ? req.query.status : CC.STATUS.PENDING;

        // A fresh query builder for "this customer's posts" each time it's needed.
        const mine = () => {
            let qb = db(P).where({ author_type: 'customer', author_id: cust.id, status: 1 });
            if (groupId) { qb = qb.where('group_id', groupId); }
            return qb;
        };

        // Per-status counts (drives the tab badges).
        const counts = { approved: 0, pending: 0, rejected: 0 };
        const cRows = await mine().select('moderation_status').count('* as n').groupBy('moderation_status');
        cRows.forEach((r) => { if (counts[r.moderation_status] !== undefined) { counts[r.moderation_status] = Number(r.n) || 0; } });

        const rows = await mine().where('moderation_status', status)
            .orderBy('id', 'desc').limit(50)
            .select('id', 'body', 'image', 'moderation_status', 'ai_reason', 'likes_count', 'comments_count', 'created_at');

        return H.successResponse(res, {
            counts, status,
            posts: rows.map((r) => ({
                id: Number(r.id), body: r.body || '', image_url: imageUrl(r.image, 'community'),
                moderation_status: r.moderation_status, ai_reason: r.ai_reason || '',
                likes: Number(r.likes_count) || 0, comments: Number(r.comments_count) || 0,
                created_at: r.created_at,
            })),
        });
    } catch (err) {
        H.log.error('community.myPosts', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { groups, feed, createPost, toggleLike, comments, addComment, deletePost, deleteComment, myPosts };
