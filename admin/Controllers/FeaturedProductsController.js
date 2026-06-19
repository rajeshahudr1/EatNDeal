'use strict';

/*
 * Controllers/FeaturedProductsController.js (admin layer)
 *
 * What:  Renders the featured-products list + add/edit form (pick a restaurant,
 *        then its products, ordered) and proxies their actions to the api. An
 *        "entry" is keyed by company_id (one restaurant = one product row on the
 *        home feed). The admin layer never touches the DB.
 * Used:  admin/index.js (requireAdmin). Super-admin only.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /featured-products — the list page (one row per restaurant).
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const url = '/api/v1/admin/featured-products' + (req.query.q ? ('?q=' + encodeURIComponent(String(req.query.q))) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load featured products.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('featured-products/list', {
        page_title:  'Featured Products',
        _layoutFile: '../_layout',
        active_nav:  'featured-products',
        extra_js:    '/js/pages/featured-products.js',
        pd,
        load_error,
        search_q: req.query.q ? String(req.query.q) : '',
    });
}

// GET /featured-products/new or /edit/:companyId — the add/edit form.
async function form(req, res) {
    const companyId = Number(req.params.companyId) || 0;
    let company = null;
    let products = [];
    let load_error = null;
    if (companyId) {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/featured-products/get?company_id=' + companyId);
            if (r && r.body && r.body.status === 200 && r.body.data) {
                company = r.body.data.company;
                products = r.body.data.products || [];
            } else { load_error = (r && r.body && r.body.msg) || 'Entry not found.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }

    res.render('featured-products/form', {
        page_title:  companyId ? 'Edit Featured Products' : 'Add Featured Products',
        _layoutFile: '../_layout',
        active_nav:  'featured-products',
        extra_js:    '/js/pages/featured-products.js',
        company,
        products,
        load_error,
    });
}

// POST /featured-products/save — { company_id, product_ids[] } → api.
async function save(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/featured-products/save', req.body || {}); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save featured products.');
    if (okBody) { return res.redirect('/featured-products'); }
    return res.redirect((req.body && req.body.company_id) ? ('/featured-products/edit/' + encodeURIComponent(req.body.company_id)) : '/featured-products/new');
}

// AJAX proxies.
function ajaxProxy(path) {
    return async function (req, res) {
        let apiRes;
        try { apiRes = await callApi(req, 'POST', path, req.body || {}); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        return res.status(200).json((apiRes && apiRes.body) || { status: 0, msg: 'No response.' });
    };
}
const remove       = ajaxProxy('/api/v1/admin/featured-products/delete');
const statusToggle = ajaxProxy('/api/v1/admin/featured-products/status');
const reorder      = ajaxProxy('/api/v1/admin/featured-products/reorder');

function ajaxGetProxy(basePath, keys) {
    return async function (req, res) {
        const params = [];
        keys.forEach((k) => { if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); } });
        const url = basePath + (params.length ? ('?' + params.join('&')) : '');
        let apiRes;
        try { apiRes = await callApi(req, 'GET', url); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        return res.status(200).json((apiRes && apiRes.body) || { status: 0, msg: 'No response.' });
    };
}
const companies = ajaxGetProxy('/api/v1/admin/featured-products/companies', ['q', 'limit']);
const products  = ajaxGetProxy('/api/v1/admin/featured-products/products', ['company_id', 'q', 'limit']);

module.exports = { list, form, save, remove, statusToggle, reorder, companies, products };
