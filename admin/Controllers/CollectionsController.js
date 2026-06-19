'use strict';

/*
 * Controllers/CollectionsController.js (admin layer)
 *
 * What:  Renders the marketplace-collections list + add/edit form + the
 *        full-page row-arrange, and proxies their actions (save with cover
 *        image + ordered restaurants, delete, status, reorder) to the api.
 *        Global (not company-scoped); the admin layer never touches the DB.
 *        Mirrors Controllers/MarketplaceCategoriesController.js.
 * Used:  admin/index.js (requireAdmin). Super-admin only.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /collections — the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'page', 'limit', 'sort', 'status'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/collections' + (params.length ? ('?' + params.join('&')) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load collections.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('collections/list', {
        page_title:  'Collections',
        _layoutFile: '../_layout',
        active_nav:  'collections',
        extra_js:    '/js/pages/collections.js',
        pd,
        load_error,
        search_q:   req.query.q ? String(req.query.q) : '',
        cur_limit:  req.query.limit ? String(req.query.limit) : '25',
        cur_sort:   req.query.sort ? String(req.query.sort) : 'sort_order',
        cur_status: req.query.status ? String(req.query.status) : '',
    });
}

// GET /collections/arrange — full-page drag-reorder of the rows (sort_order).
async function arrange(req, res) {
    let pd = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/collections?limit=all&sort=sort_order');
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load collections.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('collections/arrange', {
        page_title:  'Arrange rows',
        _layoutFile: '../_layout',
        active_nav:  'collections',
        extra_js:    '/js/pages/collections.js',
        pd,
        load_error,
    });
}

// GET /collections/new or /edit/:id — the add/edit form. On edit, also pulls
// the collection's currently-assigned restaurants (in position order) so the
// form pre-fills the ordered list.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let collection = null;
    let next_sort = 1;
    let assigned = [];
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/collections/get?id=' + id);
        if (r && r.body && r.body.status === 200) {
            collection = r.body.data.collection;
            if (r.body.data.next_sort) { next_sort = Number(r.body.data.next_sort) || 1; }
        } else if (id) { load_error = (r && r.body && r.body.msg) || 'Collection not found.'; }
        if (id) {
            const ar = await callApi(req, 'GET', '/api/v1/admin/collections/restaurants?id=' + id);
            if (ar && ar.body && ar.body.status === 200 && ar.body.data) { assigned = ar.body.data.restaurants || []; }
        }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('collections/form', {
        page_title:  id ? 'Edit Collection' : 'Add Collection',
        _layoutFile: '../_layout',
        active_nav:  'collections',
        extra_js:    '/js/pages/collections.js',
        collection,
        assigned,
        next_sort,
        load_error,
    });
}

// POST /collections/save — multipart (cover image via multer) + ordered
// company_ids[] → api.
async function save(req, res) {
    const body = Object.assign({}, req.body);
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/collections/save', body); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save the collection.');
    if (okBody) { return res.redirect('/collections'); }
    return res.redirect((req.body && req.body.id) ? ('/collections/edit/' + encodeURIComponent(req.body.id)) : '/collections/new');
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
const remove       = ajaxProxy('/api/v1/admin/collections/delete');
const statusToggle = ajaxProxy('/api/v1/admin/collections/status');
const reorder      = ajaxProxy('/api/v1/admin/collections/reorder');

// AJAX GET proxy — restaurant autocomplete for the form picker.
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
const companies = ajaxGetProxy('/api/v1/admin/collections/companies', ['q', 'limit']);

module.exports = { list, arrange, form, save, remove, statusToggle, reorder, companies };
