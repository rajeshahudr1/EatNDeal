'use strict';

/*
 * Controllers/CommunityController.js
 *
 * What:  Thin proxy + SSR for the customer COMMUNITY (Facebook-style groups).
 *          GET  /community            → groups list page (guest-ok)
 *          GET  /community/g/:id       → one group's feed page (guest-ok)
 *          GET  /community/feed        → JSON, next page of posts (load-more)
 *          GET  /community/comments    → JSON, a post's comments
 *          POST /community/post        → create a post (sign-in required; photo)
 *          POST /community/like        → like / unlike (sign-in required)
 *          POST /community/comment     → add a comment (sign-in required)
 *
 * Why:    Project rule web → api → db. The browser never calls the api direct;
 *         the web injects customer_id from the SESSION (never the body) so a
 *         guest can read but can't post/like/comment, and no one can spoof
 *         another customer. Post photos are uploaded to the web disk (multer)
 *         and served from the web origin so the strict img-src 'self' CSP
 *         allows them — same pattern as avatars + review photos.
 *
 * Used:   web/index.js — /community* routes.
 */

const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

// GET /community — the groups grid (works for guests).
async function groupsPage(req, res) {
    let groups = [];
    try {
        const apiRes = await callApi(req, 'GET', '/api/v1/customer/community/groups');
        const body = apiRes && apiRes.body;
        if (body && body.status === 200 && body.data) { groups = body.data.groups || []; }
    } catch (e) { /* render an empty state rather than a 500 */ }

    return res.render('community/index', {
        page_title:       'Community',
        _layoutFile:      '../_layout',
        active_nav:       'community',
        extra_js:         '/js/pages/community-list.js',
        show_promo_strip: false,
        groups,
    });
}

// GET /community/g/:id — one group's feed (first page SSR; works for guests).
async function groupPage(req, res) {
    const groupId = Number(req.params.id) || 0;
    const user = (req.session && req.session.user) || null;

    const qs = new URLSearchParams({ group_id: String(groupId), limit: '15', offset: '0' });
    if (user) { qs.set('customer_id', String(user.id)); }

    let body = null;
    try {
        const apiRes = await callApi(req, 'GET', '/api/v1/customer/community/feed?' + qs.toString());
        body = apiRes && apiRes.body;
    } catch (e) { /* fall through to 404 */ }

    if (!body || body.status !== 200 || !body.data || !body.data.group) {
        return res.status(404).render('errors/404', {
            page_title: 'Group not found', _layoutFile: '../_layout', active_nav: 'community',
        });
    }

    const data = body.data;
    const posts = data.posts || [];
    return res.render('community/group', {
        page_title:       data.group.name + ' · Community',
        _layoutFile:      '../_layout',
        active_nav:       'community',
        extra_js:         '/js/pages/community.js',
        show_promo_strip: false,
        group:            data.group,
        posts,
        total:            Number(data.total) || posts.length,
        has_more:         !!data.has_more,
        next_offset:      (data.offset || 0) + posts.length,
        can_post:         !!user,
    });
}

// GET /community/feed?group_id=&offset=&limit= — JSON next page (load-more).
async function feedData(req, res) {
    const user = (req.session && req.session.user) || null;
    const qs = new URLSearchParams({
        group_id: String(req.query.group_id || ''),
        offset:   String(req.query.offset || 0),
        limit:    String(req.query.limit || 15),
    });
    if (user) { qs.set('customer_id', String(user.id)); }
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/community/feed?' + qs.toString());
    return relay(res, apiRes);
}

// GET /community/comments?post_id= — JSON, a post's comments (guest-ok).
async function commentsData(req, res) {
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/community/comments?post_id=' + encodeURIComponent(req.query.post_id || ''));
    return relay(res, apiRes);
}

// POST /community/post — create a post (sign-in required). multer puts the
// optional photo on req.file; we forward its web-served relative path.
async function createPost(req, res) {
    const user = requireUser(req, res, 'Please sign in to post.');
    if (!user) { return; }
    const payload = {
        customer_id: user.id,
        group_id:    req.body.group_id,
        body:        req.body.body || '',
    };
    // When the photo landed in the shared yii-uploads tree we store a BARE
    // filename (the api resolves it to /yii-uploads/marketplace/community/…,
    // which both web + admin serve). Otherwise it's a web-only runtime path.
    if (req.file) {
        payload.image = process.env.YII_UPLOADS_PATH ? req.file.filename : ('/community-images/' + req.file.filename);
    }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/community/post', payload);
    return relay(res, apiRes);
}

// POST /community/like — like / unlike one post (sign-in required).
async function like(req, res) {
    const user = requireUser(req, res, 'Please sign in to like posts.');
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/community/like', { customer_id: user.id, post_id: req.body.post_id });
    return relay(res, apiRes);
}

// POST /community/comment — add a comment (sign-in required).
async function comment(req, res) {
    const user = requireUser(req, res, 'Please sign in to comment.');
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/community/comment', { customer_id: user.id, post_id: req.body.post_id, body: req.body.body });
    return relay(res, apiRes);
}

// POST /community/post-delete — delete own post (sign-in required).
async function deletePost(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/community/post-delete', { customer_id: user.id, post_id: req.body.post_id });
    return relay(res, apiRes);
}

// POST /community/comment-delete — delete own comment (sign-in required).
async function deleteComment(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/community/comment-delete', { customer_id: user.id, comment_id: req.body.comment_id });
    return relay(res, apiRes);
}

module.exports = { groupsPage, groupPage, feedData, commentsData, createPost, like, comment, deletePost, deleteComment };
