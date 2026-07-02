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
        // Location-scope the user groups: a group shows only if the customer is
        // inside one of its areas (groups with no areas are global).
        const loc = (req.session && req.session.userLocation) || null;
        const qs = new URLSearchParams();
        if (loc && loc.lat != null && loc.lng != null) { qs.set('lat', String(loc.lat)); qs.set('lng', String(loc.lng)); }
        const url = '/api/v1/customer/community/groups' + (qs.toString() ? ('?' + qs.toString()) : '');
        const apiRes = await callApi(req, 'GET', url);
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

    // The author's own pending/approved/rejected counts (for the "My posts" badge).
    let myCounts = { approved: 0, pending: 0, rejected: 0 };
    if (user) {
        try {
            const mp = await callApi(req, 'GET', '/api/v1/customer/community/my-posts?customer_id=' + user.id + '&group_id=' + groupId + '&status=pending');
            if (mp && mp.body && mp.body.data && mp.body.data.counts) { myCounts = mp.body.data.counts; }
        } catch (e) { /* non-fatal — badge just shows 0 */ }
    }

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
        my_counts:        myCounts,
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

// GET /community/my-posts?group_id=&status= — the signed-in customer's OWN
// posts by moderation status (+ per-status counts). Sign-in required.
async function myPostsData(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    if (req.query.group_id) { qs.set('group_id', String(req.query.group_id)); }
    if (req.query.status) { qs.set('status', String(req.query.status)); }
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/community/my-posts?' + qs.toString());
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
    // Store the photo as a "/upload/community/<file>" path. The file lands in
    // the api's shared MEDIA_DIR (api/public/upload/community), the api serves
    // it at /upload + builds the FULL url on read (mediaUrl), so it shows on
    // both web + admin. (Must be /upload — NOT /media — or the api can't map it.)
    if (req.file) {
        const mediaUrl = (process.env.MEDIA_URL || '/upload').replace(/\/$/, '');
        payload.image = mediaUrl + '/community/' + req.file.filename;
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

module.exports = { groupsPage, groupPage, feedData, myPostsData, commentsData, createPost, like, comment, deletePost, deleteComment };
