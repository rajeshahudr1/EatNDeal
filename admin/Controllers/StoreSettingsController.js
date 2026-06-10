'use strict';

/*
 * Controllers/StoreSettingsController.js (admin layer)
 *
 * What:  Renders the Store Settings page and proxies its save to the api.
 *        Company-scoped via the topbar selector. A faithful port of the legacy
 *        admin/pos/store-settings page (Phase 1 = the main settings form).
 * Type:  READ + WRITE (via api).
 * Used:  admin/index.js (requireAdmin + companyContext).
 *
 * Change log:
 *   2026-06-09 — index + save.
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
function flashFromApi(req, apiRes, fallback) {
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) { if (req.flash) { req.flash('success', body.msg || 'Saved.'); } return true; }
    if (req.flash) { req.flash('error', (body && body.msg) || fallback || 'Something went wrong.'); }
    return false;
}

async function index(req, res) {
    let ss = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage its store settings.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/store-settings' + companyQS(res));
            if (r && r.body && r.body.status === 200) { ss = r.body.data; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load store settings.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('store-settings/index', {
        page_title:  'Store Settings',
        _layoutFile: '../_layout',
        active_nav:  'store-settings',
        extra_js:    '/js/pages/store-settings.js',
        ss,
        load_error,
    });
}

async function save(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save store settings.');
    return res.redirect('/store-settings');
}

async function saveWebsiteStatus(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings/website-status', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not update store status.');
    return res.redirect('/store-settings');
}

async function saveTips(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings/tips', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save tips.');
    return res.redirect('/store-settings');
}

// ── Advance Order Waiting Time sub-page ─────────────────────────────

async function advanceIndex(req, res) {
    let rows = null;
    let load_error = null;
    if (needsCompanyPick(res)) {
        load_error = 'Pick a company from the top bar to manage advance-order waiting times.';
    } else {
        try {
            const r = await callApi(req, 'GET', '/api/v1/admin/store-settings/advance' + companyQS(res));
            if (r && r.body && r.body.status === 200) { rows = r.body.data.rows; }
            else if (r && r.body) { load_error = r.body.msg; }
            else { load_error = 'Could not load waiting times.'; }
        } catch (e) { load_error = 'Could not reach the server.'; }
    }
    res.render('store-settings/advance-order', {
        page_title:  'Advance Order Waiting Time',
        _layoutFile: '../_layout',
        active_nav:  'store-settings',
        extra_js:    '/js/pages/store-advance.js',
        rows,
        load_error,
    });
}

async function advanceSave(req, res) {
    const body = Object.assign({}, req.body, { company_id: activeCompanyId(res) });
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings/advance', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save the waiting time.');
    return res.redirect('/store-settings/advance');
}

async function advanceDelete(req, res) {
    const body = { company_id: activeCompanyId(res), id: req.body && req.body.id };
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings/advance/delete', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not remove the row.');
    return res.redirect('/store-settings/advance');
}

// Called after multer has written the file(s) to the Yii uploads tree; stores
// the resulting filename(s) on the branch via the api.
async function uploadImage(req, res) {
    const files = req.files || {};
    const updates = { company_id: activeCompanyId(res) };
    let any = false;
    ['business_image', 'discount_icon', 'surprise_image', 'banner_image'].forEach((f) => {
        if (files[f] && files[f][0]) { updates[f] = files[f][0].filename; any = true; }
    });
    if (!any) {
        if (req.flash) { req.flash('error', 'No image was selected.'); }
        return res.redirect('/store-settings');
    }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/store-settings/image', updates); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save the image.');
    return res.redirect('/store-settings');
}

module.exports = { index, save, saveWebsiteStatus, saveTips, advanceIndex, advanceSave, advanceDelete, uploadImage };
