'use strict';

/*
 * Controllers/CustomersController.js (admin layer)
 *
 * What:  Super-admin "Customers" — every MARKETPLACE customer (the legacy
 *        POS customer module minus vouchers): list + search + status
 *        filter, edit form, ban with reason / unban, soft delete,
 *        order history + summary, About-You profile popup.
 *        Renders pages and proxies actions to the api — the admin layer
 *        never touches the DB.
 * Used:  admin/index.js (requireAdmin + requireSuperPage).
 *
 * Change log:
 *   2026-07-28 — initial port from the legacy POS customer module.
 */

const { callApi } = require('../Helpers/apiClient');
const CC = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;
const activeCompanyId = CC.activeCompanyId;

// "&company_id=N" fragment (empty when no company is picked — the api
// then scopes to MARKETPLACE customers; company logins are forced to
// their own id server-side regardless).
function cidQS(res) {
    const id = activeCompanyId(res);
    return id != null ? ('&company_id=' + encodeURIComponent(id)) : '';
}

// GET /customers — the list page.
async function list(req, res) {
    let pd = null;
    let load_error = null;
    const params = [];
    ['q', 'page', 'limit', 'sort', 'status', 'date_from', 'date_to'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    const url = '/api/v1/admin/customers?' + params.join('&') + cidQS(res);
    try {
        const r = await callApi(req, 'GET', url);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else if (r && r.body) { load_error = r.body.msg; }
        else { load_error = 'Could not load customers.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('customers/list', {
        page_title:  'Customers',
        _layoutFile: '../_layout',
        active_nav:  'customers',
        extra_js:    '/js/pages/customers.js',
        pd,
        load_error,
        search_q:   req.query.q ? String(req.query.q) : '',
        cur_limit:  req.query.limit ? String(req.query.limit) : '25',
        cur_sort:   req.query.sort ? String(req.query.sort) : 'newest',
        cur_status: req.query.status ? String(req.query.status) : '',
    });
}

// GET /customers/edit/:id — the edit form (marketplace customers sign
// themselves up, so there is no "add" here — edit only, like the api).
async function form(req, res) {
    const id = Number(req.params.id) || 0;
    let customer = null;
    let profile = null;
    let ban_reasons = [];
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/customers/get?id=' + id + cidQS(res));
        if (r && r.body && r.body.status === 200) {
            customer    = r.body.data.customer;
            profile     = r.body.data.profile;
            ban_reasons = r.body.data.ban_reasons || [];
        } else { load_error = (r && r.body && r.body.msg) || 'Customer not found.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('customers/form', {
        page_title:  'Edit Customer',
        _layoutFile: '../_layout',
        active_nav:  'customers',
        extra_js:    '/js/pages/customers.js',
        customer,
        profile,
        ban_reasons,
        load_error,
    });
}

// POST /customers/save — form post → api → flash + redirect.
async function save(req, res) {
    let apiRes;
    const body = Object.assign({}, req.body);
    if (activeCompanyId(res) != null) { body.company_id = activeCompanyId(res); }
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/customers/save', body); }
    catch (e) { apiRes = null; }
    const ok = flashFromApi(req, apiRes, 'Could not save the customer.');
    if (ok) { return res.redirect('/customers'); }
    return res.redirect('/customers/edit/' + encodeURIComponent(Number(req.body && req.body.id) || 0));
}

// GET /customers/history/:id — the order-history page (legacy actionHistory).
async function history(req, res) {
    const id = Number(req.params.id) || 0;
    let pd = null;
    let load_error = null;
    const params = ['id=' + id];
    ['page', 'limit', 'q'].forEach((k) => {
        if (req.query[k] != null && req.query[k] !== '') { params.push(k + '=' + encodeURIComponent(String(req.query[k]))); }
    });
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/customers/orders?' + params.join('&') + cidQS(res));
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load the order history.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('customers/history', {
        page_title:  'Order History',
        _layoutFile: '../_layout',
        active_nav:  'customers',
        extra_js:    '/js/pages/customers.js',
        pd,
        load_error,
        cust_id:   id,
        cur_limit: req.query.limit ? String(req.query.limit) : '25',
        search_q:  req.query.q ? String(req.query.q) : '',
    });
}

// GET /customers/order/:id — the admin order View page (legacy POS
// /pos/default/view): items + modifiers, bill breakdown, payment,
// delivery address, notes.
async function order(req, res) {
    const id = Number(req.params.id) || 0;
    let pd = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/customers/order?id=' + id);
        if (r && r.body && r.body.status === 200) { pd = r.body.data; }
        else { load_error = (r && r.body && r.body.msg) || 'Order not found.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('customers/order', {
        page_title:  'Order Details',
        _layoutFile: '../_layout',
        active_nav:  'customers',
        extra_js:    '/js/pages/customers.js',
        pd,
        load_error,
    });
}

// AJAX proxies (JSON in/out) — the active company rides along so the api
// scopes ban/unban/delete to the same customer set the list showed.
function ajaxProxy(path) {
    return async function (req, res) {
        let apiRes;
        const body = Object.assign({}, req.body || {});
        if (activeCompanyId(res) != null) { body.company_id = activeCompanyId(res); }
        try { apiRes = await callApi(req, 'POST', path, body); }
        catch (e) { apiRes = { body: { status: 0, msg: 'Could not reach the server.' } }; }
        return res.status(200).json((apiRes && apiRes.body) || { status: 0, msg: 'No response.' });
    };
}
const ban    = ajaxProxy('/api/v1/admin/customers/ban');
const unban  = ajaxProxy('/api/v1/admin/customers/unban');
const remove = ajaxProxy('/api/v1/admin/customers/delete');

module.exports = { list, form, save, history, order, ban, unban, remove };
