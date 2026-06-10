'use strict';

/*
 * Controllers/ProductsController.js (admin layer)
 *
 * What:  Renders the product LIST page and proxies its AJAX actions (inline
 *        price edit, status change, delete, bulk online price) to the api.
 *        Company-scoped via the topbar selector. Phase 1 of the product module
 *        (a faithful port of the legacy pos/products/list page).
 * Type:  READ + WRITE (via api). The admin layer never touches the DB.
 * Used:  admin/index.js (requireAdmin + companyContext).
 *
 * Change log:
 *   2026-06-09 — list page.
 */

const { callApi } = require('../Helpers/apiClient');

function activeCompanyId(res) {
    const ctx = res.locals.company_ctx || {};
    return ctx.selectedCompanyId != null ? ctx.selectedCompanyId : null;
}
function companyQS(res) {
    const id = activeCompanyId(res);
    return id != null ? ('?company_id=' + encodeURIComponent(id)) : '';
}
function needsCompanyPick(res) {
    const ctx = res.locals.company_ctx || {};
    return ctx.isSuper && activeCompanyId(res) == null;
}

// GET /products — render the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage its products.';
    } else {
        const params = [];
        const cid = activeCompanyId(res);
        if (cid != null) { params.push('company_id=' + encodeURIComponent(cid)); }
        ['q', 'page', 'limit', 'sort', 'category'].forEach((k) => {
            if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
        });
        const url = '/api/v1/admin/products' + (params.length ? ('?' + params.join('&')) : '');
        try {
            const r = await callApi(req, 'GET', url);
            if (r && r.body && r.body.status === 200) { pd = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load products.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('products/list', {
        page_title:  'Products',
        _layoutFile: '../_layout',
        active_nav:  'products',
        extra_js:    '/js/pages/products.js',
        pd,
        load_error,
        search_q:     req.query.q ? String(req.query.q) : '',
        cur_limit:    req.query.limit ? String(req.query.limit) : '25',
        cur_sort:     req.query.sort ? String(req.query.sort) : 'newest',
        cur_category: req.query.category ? String(req.query.category) : '',
    });
}

// Build a JSON-returning AJAX proxy: forward the body (+ company scope) to the
// api and relay the api's envelope to the page's fetch() call.
function ajaxProxy(apiPath) {
    return async function (req, res) {
        const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
        try {
            const r = await callApi(req, 'POST', apiPath, body);
            return res.json((r && r.body) ? r.body : { status: 0, show: true, msg: 'No response from server.' });
        } catch (e) {
            return res.json({ status: 0, show: true, msg: 'Could not reach the server.' });
        }
    };
}

const updatePrice     = ajaxProxy('/api/v1/admin/products/price');
const updateStatus    = ajaxProxy('/api/v1/admin/products/status');
const remove          = ajaxProxy('/api/v1/admin/products/delete');
const bulkOnlinePrice = ajaxProxy('/api/v1/admin/products/online-prices');
const bulkPrice       = ajaxProxy('/api/v1/admin/products/bulk-price');
const marketplaceToggle = ajaxProxy('/api/v1/admin/products/marketplace');

// GET /products/new  or  /products/edit/:id — render the add/edit form.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let product = null;
    let meta = { categories: [], tax: [], units: [], sections: [], allergens: [], modifiers: [] };
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to add or edit products.';
    } else {
        const qs = companyQS(res);
        try {
            const cr = await callApi(req, 'GET', '/api/v1/admin/products/meta' + qs);
            if (cr && cr.body && cr.body.status === 200) { meta = Object.assign(meta, cr.body.data); }
            if (id) {
                const pr = await callApi(req, 'GET', '/api/v1/admin/products/get' + (qs ? qs + '&' : '?') + 'id=' + id);
                if (pr && pr.body && pr.body.status === 200) { product = pr.body.data.product; }
                else { load_error = (pr && pr.body && pr.body.msg) || 'Product not found.'; }
            }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('products/form', {
        page_title:  id ? 'Edit Product' : 'Add Product',
        _layoutFile: '../_layout',
        active_nav:  'products',
        extra_js:    '/js/pages/product-form.js',
        product,
        meta,
        preCategory: req.query.category ? Number(req.query.category) : 0,
        load_error,
    });
}

// GET /products/view/:id — read-only product detail (tabs). Fetches the
// product + the option masters so the view can resolve IDs → names.
async function view(req, res) {
    const id = Number(req.params.id) || 0;
    let product = null;
    let meta = { categories: [], tax: [], units: [], sections: [], allergens: [], modifiers: [] };
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to view products.';
    } else {
        const qs = companyQS(res);
        try {
            const results = await Promise.all([
                callApi(req, 'GET', '/api/v1/admin/products/get' + (qs ? qs + '&' : '?') + 'id=' + id).catch(() => null),
                callApi(req, 'GET', '/api/v1/admin/products/meta' + qs).catch(() => null),
            ]);
            const pr = results[0];
            const mr = results[1];
            if (pr && pr.body && pr.body.status === 200) { product = pr.body.data.product; }
            else { load_error = (pr && pr.body && pr.body.msg) || 'Product not found.'; }
            if (mr && mr.body && mr.body.status === 200) { meta = Object.assign(meta, mr.body.data); }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('products/view', {
        page_title:  product ? product.name : 'Product',
        _layoutFile: '../_layout',
        active_nav:  'products',
        extra_js:    '/js/pages/product-view.js',
        product,
        meta,
        load_error,
    });
}

// POST /products/save — multipart (image via multer); forward to the api.
async function save(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/products/save', body); }
    catch (e) { apiRes = null; }
    const okBody = apiRes && apiRes.body && apiRes.body.status === 200;
    if (req.flash) { req.flash(okBody ? 'success' : 'error', (apiRes && apiRes.body && apiRes.body.msg) || (okBody ? 'Saved.' : 'Could not save the product.')); }
    if (okBody) { return res.redirect('/products'); }
    const back = (req.body && req.body.id) ? ('/products/edit/' + encodeURIComponent(req.body.id)) : '/products/new';
    return res.redirect(back);
}

module.exports = { list, updatePrice, updateStatus, remove, bulkOnlinePrice, bulkPrice, marketplaceToggle, form, view, save };
