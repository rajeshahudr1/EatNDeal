'use strict';

/*
 * Controllers/CommunityController.js (admin layer)
 *
 * What:  Renders the COMMUNITY groups list + add/edit form, and proxies their
 *        actions (save with optional cover image, delete, status) to the api.
 *        Global (not company-scoped); the admin layer never touches the DB.
 *        Mirrors Controllers/CollectionsController.js but simpler — a group has
 *        no restaurant picker, just name / description / type / cover.
 * Used:  admin/index.js (requireAdmin). Super-admin manages the groups.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /community — the groups list.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'type', 'page', 'limit'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/community' + (params.length ? ('?' + params.join('&')) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load groups.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('community/list', {
        page_title:  'Community',
        _layoutFile: '../_layout',
        active_nav:  'community',
        extra_js:    '/js/pages/community.js',
        pd,
        load_error,
        search_q:   req.query.q ? String(req.query.q) : '',
        cur_type:   req.query.type ? String(req.query.type) : '',
        cur_limit:  req.query.limit ? String(req.query.limit) : '25',
    });
}

// GET /community/new or /edit/:id — the add/edit form.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let group = null;
    let load_error = null;
    try {
        if (id) {
            const r = await callApi(req, 'GET', '/api/v1/admin/community/get?id=' + id);
            if (r && r.body && r.body.status === 200 && r.body.data) { group = r.body.data.group; }
            else { load_error = (r && r.body && r.body.msg) || 'Group not found.'; }
        }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('community/form', {
        page_title:  id ? 'Edit group' : 'New group',
        _layoutFile: '../_layout',
        active_nav:  'community',
        extra_js:    '/js/pages/community.js',
        group,
        load_error,
    });
}

// POST /community/save — multipart (optional cover image via multer) → api.
async function save(req, res) {
    const body = Object.assign({}, req.body);
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/community/save', body); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save the group.');
    if (okBody) { return res.redirect('/community'); }
    return res.redirect((req.body && req.body.id) ? ('/community/edit/' + encodeURIComponent(req.body.id)) : '/community/new');
}

// GET /community/feed/:id — render a group's feed (admin posts + moderation).
async function feedPage(req, res) {
    const id = Number(req.params.id) || 0;
    let group = null;
    let posts = [];
    let has_more = false;
    let next_offset = 0;
    let pending_count = 0;
    let total = 0;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/community/feed?group_id=' + id + '&limit=15&offset=0');
        if (r && r.body && r.body.status === 200 && r.body.data) {
            group = r.body.data.group;
            posts = r.body.data.posts || [];
            has_more = !!r.body.data.has_more;
            next_offset = (r.body.data.offset || 0) + posts.length;
            pending_count = Number(r.body.data.pending_count) || 0;
            total = Number(r.body.data.total) || posts.length;
        } else { load_error = (r && r.body && r.body.msg) || 'Could not load the feed.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('community/feed', {
        page_title:  group ? (group.name + ' · Feed') : 'Community feed',
        _layoutFile: '../_layout',
        active_nav:  'community',
        extra_js:    '/js/pages/community.js',
        group, posts, has_more, next_offset, pending_count, total, load_error,
    });
}

// AJAX proxies (JSON in/out).
function ajaxProxy(path) {
    return async function (req, res) {
        let apiRes;
        try { apiRes = await callApi(req, 'POST', path, req.body || {}); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        const body = (apiRes && apiRes.body) || { status: 0, msg: 'No response.' };
        return res.status(200).json(body);
    };
}
function ajaxGetProxy(basePath, keys) {
    return async function (req, res) {
        const params = [];
        keys.forEach((k) => { if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); } });
        const url = basePath + (params.length ? ('?' + params.join('&')) : '');
        let apiRes;
        try { apiRes = await callApi(req, 'GET', url); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        const body = (apiRes && apiRes.body) || { status: 0, msg: 'No response.' };
        return res.status(200).json(body);
    };
}
const remove        = ajaxProxy('/api/v1/admin/community/delete');
const statusToggle  = ajaxProxy('/api/v1/admin/community/status');
const feedData      = ajaxGetProxy('/api/v1/admin/community/feed', ['group_id', 'offset', 'limit']);
const commentsData  = ajaxGetProxy('/api/v1/admin/community/comments', ['post_id']);
// Post as the admin — optional photo arrives on req.file (multer); forward its
// bare filename (the api resolves it to /yii-uploads/marketplace/community/…).
async function createPost(req, res) {
    const body = { group_id: req.body.group_id, body: req.body.body || '' };
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/community/post', body); }
    catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
    return res.status(200).json((apiRes && apiRes.body) || { status: 0, msg: 'No response.' });
}
const addComment    = ajaxProxy('/api/v1/admin/community/comment');
const deletePost    = ajaxProxy('/api/v1/admin/community/post-delete');
const deleteComment = ajaxProxy('/api/v1/admin/community/comment-delete');

// Group-form pickers — reuse the shared admin/delivery endpoints:
//   companies  → company search (restaurant groups)
//   locSearch  → address autocomplete suggestions (user-group coverage points)
//   locResolve → resolve a picked suggestion → label + lat/lng
const companies   = ajaxGetProxy('/api/v1/admin/marketplace-categories/companies', ['q', 'limit']);
const locSearch   = ajaxProxy('/api/v1/delivery/search-address');
const locResolve  = ajaxProxy('/api/v1/delivery/retrieve-address');

// AI-moderation review queue (super-admin): page + data + approve/reject.
function reviewPage(req, res) {
    res.render('community/review', { page_title: 'Community review', _layoutFile: '../_layout', active_nav: 'community-review', extra_js: '/js/pages/community-review.js' });
}
const pendingData = ajaxGetProxy('/api/v1/admin/community/pending', ['status', 'group_id', 'q']);
const moderate    = ajaxProxy('/api/v1/admin/community/moderate');

// Blocked users — a blocked customer can read but can't post / like / comment.
function blockedPage(req, res) {
    res.render('community/blocked', { page_title: 'Blocked users', _layoutFile: '../_layout', active_nav: 'community-blocked', extra_js: '/js/pages/community-blocked.js' });
}
const blockedData   = ajaxGetProxy('/api/v1/admin/community/blocked', ['q']);
const customersData = ajaxGetProxy('/api/v1/admin/community/customers', ['q']);
const blockUser     = ajaxProxy('/api/v1/admin/community/block');
const unblockUser   = ajaxProxy('/api/v1/admin/community/unblock');

module.exports = { list, form, save, remove, statusToggle, feedPage, feedData, commentsData, createPost, addComment, deletePost, deleteComment, companies, locSearch, locResolve, reviewPage, pendingData, moderate, blockedPage, blockedData, customersData, blockUser, unblockUser };
