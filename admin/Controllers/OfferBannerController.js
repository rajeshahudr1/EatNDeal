'use strict';

/*
 * Controllers/OfferBannerController.js (admin layer)
 *
 * What:  Renders the OFFER BANNER carousel list + add/edit form and proxies
 *        their actions (save with banner image + rule + optional hand-picked
 *        restaurants, delete, status, reorder) to the api. Global (not
 *        company-scoped); the admin layer never touches the DB.
 *        Mirrors Controllers/CollectionsController.js (list/reorder/manual-pick)
 *        + the welcome-banner image upload.
 * Used:  admin/index.js (requireAdmin + requireSuper). Super-admin only.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /offer-banner — the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'page', 'limit', 'sort', 'status'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/offer-banner' + (params.length ? ('?' + params.join('&')) : '');
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load offer banners.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('offer-banner/list', {
        page_title:  'Offer Banners',
        _layoutFile: '../_layout',
        active_nav:  'offer-banner',
        extra_js:    '/js/pages/offer-banner.js',
        pd,
        load_error,
        search_q:   req.query.q ? String(req.query.q) : '',
        cur_limit:  req.query.limit ? String(req.query.limit) : '25',
        cur_sort:   req.query.sort ? String(req.query.sort) : 'sort_order',
        cur_status: req.query.status ? String(req.query.status) : '',
    });
}

// GET /offer-banner/arrange — full-page drag-reorder of the carousel (sort_order).
async function arrange(req, res) {
    let pd = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/offer-banner?limit=all&sort=sort_order');
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load offer banners.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('offer-banner/arrange', {
        page_title:  'Arrange banners',
        _layoutFile: '../_layout',
        active_nav:  'offer-banner',
        extra_js:    '/js/pages/offer-banner.js',
        pd,
        load_error,
    });
}

// GET /offer-banner/new or /edit/:id — the add/edit form. On edit, also pulls
// the banner's hand-picked restaurants (manual-pick rule). Always loads the
// marketplace categories so the CATEGORY rule can offer a dropdown.
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let banner = null;
    let next_sort = 1;
    let assigned = [];
    let categories = [];
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/offer-banner/get?id=' + id);
        if (r && r.body && r.body.status === 200) {
            banner = r.body.data.banner;
            if (r.body.data.next_sort) { next_sort = Number(r.body.data.next_sort) || 1; }
        } else if (id) { load_error = (r && r.body && r.body.msg) || 'Offer banner not found.'; }

        if (id) {
            const ar = await callApi(req, 'GET', '/api/v1/admin/offer-banner/restaurants?id=' + id);
            if (ar && ar.body && ar.body.status === 200 && ar.body.data) { assigned = ar.body.data.restaurants || []; }
        }
        // Categories for the CATEGORY rule picker (best-effort — never blocks the form).
        const cr = await callApi(req, 'GET', '/api/v1/admin/marketplace-categories?limit=all&sort=name_asc');
        if (cr && cr.body && cr.body.status === 200 && cr.body.data) { categories = cr.body.data.categories || []; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('offer-banner/form', {
        page_title:  id ? 'Edit Offer Banner' : 'Add Offer Banner',
        _layoutFile: '../_layout',
        active_nav:  'offer-banner',
        extra_js:    '/js/pages/offer-banner.js',
        banner,
        assigned,
        categories,
        next_sort,
        load_error,
    });
}

// POST /offer-banner/save — multipart (banner image via multer) + rule fields
// + ordered company_ids[] (manual pick) → api.
async function save(req, res) {
    const body = Object.assign({}, req.body);
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/offer-banner/save', body); }
    catch (e) { apiRes = null; }
    const okBody = flashFromApi(req, apiRes, 'Could not save the offer banner.');
    if (okBody) { return res.redirect('/offer-banner'); }
    return res.redirect((req.body && req.body.id) ? ('/offer-banner/edit/' + encodeURIComponent(req.body.id)) : '/offer-banner/new');
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
const remove       = ajaxProxy('/api/v1/admin/offer-banner/delete');
const statusToggle = ajaxProxy('/api/v1/admin/offer-banner/status');
const reorder      = ajaxProxy('/api/v1/admin/offer-banner/reorder');

// AJAX GET proxy — restaurant autocomplete for the manual-pick picker.
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
const companies = ajaxGetProxy('/api/v1/admin/offer-banner/companies', ['q', 'limit']);

module.exports = { list, arrange, form, save, remove, statusToggle, reorder, companies };
