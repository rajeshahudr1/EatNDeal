'use strict';

/*
 * Controllers/MarketplaceCategoriesController.js (admin layer)
 *
 * What:  Renders the global marketplace-category list + add/edit form and
 *        proxies their actions (save with image upload, delete, status) to the
 *        api. Global (not company-scoped). The admin layer never touches the DB.
 * Used:  admin/index.js (requireAdmin). Super-admin only (gated in the menu).
 *
 * Change log:
 *   2026-06-10 — list + form + save + delete + status.
 */

const { callApi } = require('../Helpers/apiClient');

function flashFromApi(req, apiRes, fallback) {
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) { if (req.flash) { req.flash('success', body.msg || 'Saved.'); } return true; }
    if (req.flash) { req.flash('error', (body && body.msg) || fallback || 'Something went wrong.'); }
    return false;
}

// GET /marketplace-categories — the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'page', 'limit', 'sort', 'status', 'company'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/marketplace-categories' + (params.length ? ('?' + params.join('&')) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load categories.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('marketplace-categories/list', {
        page_title:  'Marketplace Categories',
        _layoutFile: '../_layout',
        active_nav:  'mp-categories',
        extra_js:    '/js/pages/mp-categories.js',
        pd,
        load_error,
        search_q:    req.query.q ? String(req.query.q) : '',
        cur_limit:   req.query.limit ? String(req.query.limit) : '25',
        cur_sort:    req.query.sort ? String(req.query.sort) : 'sort_order',
        cur_status:  req.query.status ? String(req.query.status) : '',
        cur_company: req.query.company ? String(req.query.company) : '',
        cur_company_name: (pd && pd.company_name) ? String(pd.company_name) : '',
    });
}

// GET /marketplace-categories/arrange — full-page drag-and-drop reorder of
// every category (loads all on one page so the saved order is global).
async function arrange(req, res) {
    let pd = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/marketplace-categories?limit=all&sort=sort_order');
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load categories.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('marketplace-categories/arrange', {
        page_title:  'Arrange sort order',
        _layoutFile: '../_layout',
        active_nav:  'mp-categories',
        extra_js:    '/js/pages/mp-categories.js',
        pd,
        load_error,
    });
}

// GET /marketplace-categories/new  or  /edit/:id — the add/edit form.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let category = null;
    let next_sort = 1;
    let load_error = null;
    // Always hit /get — even on add (id=0) — to pull the next sort number.
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/marketplace-categories/get?id=' + id);
        if (r && r.body && r.body.status === 200) {
            category = r.body.data.category;
            if (r.body.data.next_sort) { next_sort = Number(r.body.data.next_sort) || 1; }
        } else if (id) { load_error = (r && r.body && r.body.msg) || 'Category not found.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('marketplace-categories/form', {
        page_title:  id ? 'Edit Category' : 'Add Category',
        _layoutFile: '../_layout',
        active_nav:  'mp-categories',
        extra_js:    '/js/pages/mp-category-form.js',
        category,
        next_sort,
        load_error,
    });
}

// POST /marketplace-categories/save — multipart (image via multer) → api.
async function save(req, res) {
    const body = Object.assign({}, req.body);
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/marketplace-categories/save', body); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save the category.');
    if (okBody) { return res.redirect('/marketplace-categories'); }
    return res.redirect((req.body && req.body.id) ? ('/marketplace-categories/edit/' + encodeURIComponent(req.body.id)) : '/marketplace-categories/new');
}

// AJAX proxies (JSON in/out) for delete + status.
function ajaxProxy(path) {
    return async function (req, res) {
        let apiRes;
        try { apiRes = await callApi(req, 'POST', path, req.body || {}); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        const body = (apiRes && apiRes.body) || { status: 0, msg: 'No response.' };
        return res.status(200).json(body);
    };
}
const remove       = ajaxProxy('/api/v1/admin/marketplace-categories/delete');
const statusToggle = ajaxProxy('/api/v1/admin/marketplace-categories/status');
const assign       = ajaxProxy('/api/v1/admin/marketplace-categories/assign');
const reorder      = ajaxProxy('/api/v1/admin/marketplace-categories/reorder');

// AJAX GET proxies (autocomplete restaurants + a category's assigned list).
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
const companies    = ajaxGetProxy('/api/v1/admin/marketplace-categories/companies', ['q', 'limit']);
const restaurants  = ajaxGetProxy('/api/v1/admin/marketplace-categories/restaurants', ['id']);

module.exports = { list, arrange, form, save, remove, statusToggle, companies, restaurants, assign, reorder };
