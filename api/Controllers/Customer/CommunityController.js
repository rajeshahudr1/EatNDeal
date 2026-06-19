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
const { db }    = require('../../config/db');

const G = 'mp_community_group';
const P = 'mp_community_post';
const C = 'mp_community_comment';
const L = 'mp_community_like';

function imageUrl(file, folder) {
    const f = String(file || '').trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return f; }
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

/** groups — GET /customer/community/groups?customer_id? — visible groups (guest-ok). */
async function groups(req, res) {
    try {
        const rows = await db(G + ' as g')
            .where('g.status', 1)
            .whereIn('g.type', ['user', 'restaurant'])
            .leftJoin(db(P).select('group_id').count('* as posts').where('status', 1).groupBy('group_id').as('p'), 'p.group_id', 'g.id')
            .orderBy('g.id', 'desc')
            .select('g.id', 'g.name', 'g.description', 'g.image', 'g.type', db.raw('COALESCE(p.posts, 0) as posts'));
        return H.successResponse(res, {
            groups: rows.map((g) => ({
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

        const group = await db(G).where({ id: groupId, status: 1 }).first('id', 'name', 'description', 'image', 'type');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }

        const totalRow = await db(P).where({ group_id: groupId, status: 1 }).count('* as n').first();
        const total = Number(totalRow && totalRow.n) || 0;

        const rows = await db(P).where({ group_id: groupId, status: 1 })
            .orderBy('id', 'desc').limit(limit).offset(offset)
            .select('id', 'author_type', 'author_id', 'author_name', 'body', 'image', 'likes_count', 'comments_count', 'created_at');

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
                liked: likedSet.has(String(r.id)), created_at: r.created_at, author: author(r),
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
        const groupId = Number(b.group_id) || 0;
        const group = await db(G).where({ id: groupId, status: 1 }).whereIn('type', ['user', 'restaurant']).first('id');
        if (!group) { return H.errorResponse(res, 'Group not found.', 404); }
        const body = String(b.body || '').trim().slice(0, 5000);
        const image = String(b.image || '').trim().slice(0, 255);
        if (!body && !image) { return H.errorResponse(res, 'Write something or add a photo.', 422); }

        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const ins = await db(P).insert({
            group_id: groupId, author_type: 'customer', author_id: cust.id, author_name: cust.name,
            body, image: image || null, likes_count: 0, comments_count: 0, status: 1, created_at: now,
        }).returning('id');
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        return H.successResponse(res, { id: Number(id) }, 'Posted.');
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
        const rows = await db(C).where({ post_id: postId, status: 1 }).orderBy('id', 'asc')
            .select('id', 'author_type', 'author_id', 'author_name', 'body', 'created_at');
        return H.successResponse(res, {
            comments: rows.map((r) => ({ id: Number(r.id), body: r.body || '', created_at: r.created_at, author: author(r) })),
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
        const postId = Number(req.body.post_id) || 0;
        const post = await db(P).where({ id: postId, status: 1 }).first('id');
        if (!post) { return H.errorResponse(res, 'Post not found.', 404); }
        const body = String(req.body.body || '').trim().slice(0, 2000);
        if (!body) { return H.errorResponse(res, 'Write a comment.', 422); }

        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const ins = await db(C).insert({ post_id: postId, author_type: 'customer', author_id: cust.id, author_name: cust.name, body, status: 1, created_at: now }).returning('id');
        await db(P).where({ id: postId }).increment('comments_count', 1);
        const id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins;
        const cntRow = await db(P).where({ id: postId }).first('comments_count');
        return H.successResponse(res, {
            comment: { id: Number(id), body, created_at: now, author: { name: cust.name, type: 'customer', id: cust.id, initial: initialOf(cust.name), tint: tintFor(cust.id) } },
            comments: Number(cntRow && cntRow.comments_count) || 0,
        }, 'Commented.');
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

module.exports = { groups, feed, createPost, toggleLike, comments, addComment, deletePost, deleteComment };
