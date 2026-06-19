'use strict';

/*
 * Controllers/FeedSectionsController.js (admin layer)
 *
 * What:  Renders the "Feed Order" page (drag the 4 home-feed sections into the
 *        order they appear + show/hide each) and proxies the save to the api.
 * Used:  admin/index.js (requireAdmin). Super-admin only.
 */

const { callApi } = require('../Helpers/apiClient');

// GET /feed-sections — the arrange page.
async function page(req, res) {
    let pd = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/feed-sections');
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load the feed order.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('feed-sections/arrange', {
        page_title:  'Feed Order',
        _layoutFile: '../_layout',
        active_nav:  'feed-order',
        extra_js:    '/js/pages/feed-sections.js',
        pd,
        load_error,
    });
}

// POST /feed-sections/reorder — AJAX proxy (JSON in/out).
async function reorder(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/feed-sections/reorder', req.body || {}); }
    catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
    return res.status(200).json((apiRes && apiRes.body) || { status: 0, msg: 'No response.' });
}

module.exports = { page, reorder };
