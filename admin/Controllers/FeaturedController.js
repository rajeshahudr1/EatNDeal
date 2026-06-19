'use strict';

/*
 * Controllers/FeaturedController.js (admin layer)
 *
 * What:  Renders the featured/sponsored-placements list + add/edit form and
 *        proxies their actions (save, delete, status) to the api. A placement
 *        grants a paying restaurant a time-bound, priority-ordered spot in the
 *        "Featured" row of the marketplace home feed. The admin layer never
 *        touches the DB. Mirrors Controllers/MarketplaceCategoriesController.js.
 * Used:  admin/index.js (requireAdmin). Super-admin only.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /featured — the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'page', 'limit', 'status'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/featured' + (params.length ? ('?' + params.join('&')) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load featured placements.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('featured/list', {
        page_title:  'Featured / Sponsored',
        _layoutFile: '../_layout',
        active_nav:  'featured',
        extra_js:    '/js/pages/featured.js',
        pd,
        load_error,
        search_q:   req.query.q ? String(req.query.q) : '',
        cur_limit:  req.query.limit ? String(req.query.limit) : '25',
        cur_status: req.query.status ? String(req.query.status) : '',
    });
}

// GET /featured/new or /edit/:id — the add/edit form.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let placement = null;
    let load_error = null;
    if (id) {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/featured/get?id=' + id);
            if (r && r.body && r.body.status === 200) { placement = r.body.data.placement; }
            else { load_error = (r && r.body && r.body.msg) || 'Placement not found.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }

    res.render('featured/form', {
        page_title:  id ? 'Edit Placement' : 'Add Featured Placement',
        _layoutFile: '../_layout',
        active_nav:  'featured',
        extra_js:    '/js/pages/featured.js',
        placement,
        load_error,
    });
}

// POST /featured/save — plain form → api.
async function save(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/featured/save', req.body || {}); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save the placement.');
    if (okBody) { return res.redirect('/featured'); }
    return res.redirect((req.body && req.body.id) ? ('/featured/edit/' + encodeURIComponent(req.body.id)) : '/featured/new');
}

// AJAX proxies.
function ajaxProxy(path) {
    return async function (req, res) {
        let apiRes;
        try { apiRes = await callApi(req, 'POST', path, req.body || {}); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        const body = (apiRes && apiRes.body) || { status: 0, msg: 'No response.' };
        return res.status(200).json(body);
    };
}
const remove       = ajaxProxy('/api/v1/admin/featured/delete');
const statusToggle = ajaxProxy('/api/v1/admin/featured/status');
const reorder      = ajaxProxy('/api/v1/admin/featured/reorder');

function ajaxGetProxy(basePath, keys) {
    return async function (req, res) {
        const params = [];
        keys.forEach((k) => {
            if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
        });
        const url = basePath + (params.length ? ('?' + params.join('&')) : '');
        let apiRes;
        try { apiRes = await callApi(req, 'GET', url); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        const body = (apiRes && apiRes.body) || { status: 0, msg: 'No response.' };
        return res.status(200).json(body);
    };
}
const companies = ajaxGetProxy('/api/v1/admin/featured/companies', ['q', 'limit']);

module.exports = { list, form, save, remove, statusToggle, reorder, companies };
