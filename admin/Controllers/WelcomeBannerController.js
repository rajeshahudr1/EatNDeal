'use strict';

/*
 * Controllers/WelcomeBannerController.js
 *
 * What:  Super-admin page for the home WELCOME strip (single config).
 *          GET  /welcome-banner        → the config form
 *          POST /welcome-banner/save   → multipart (optional image) → api
 * Used:  admin/index.js — super-admin only routes.
 */

const { callApi }  = require('../Helpers/apiClient');
const CC           = require('../Helpers/controllerCommon');
const flashFromApi = CC.flashFromApi;

// GET /welcome-banner — the config form.
async function form(req, res) {
    let banner = null;
    let load_error = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/welcome-banner/get');
        if (r && r.body && r.body.status === 200 && r.body.data) { banner = r.body.data.banner; }
        else { load_error = (r && r.body && r.body.msg) || 'Could not load the welcome banner.'; }
    } catch (e) { load_error = 'Could not reach the server.'; }

    res.render('welcome-banner/form', {
        page_title:  'Welcome Banner',
        _layoutFile: '../_layout',
        active_nav:  'welcome-banner',
        extra_js:    '/js/pages/welcome-banner.js',
        banner,
        load_error,
    });
}

// POST /welcome-banner/save — multer already stamped the relative /upload path
// onto req.file.filename; forward it as body.image (only when a file was sent).
async function save(req, res) {
    const body = Object.assign({}, req.body);
    if (req.file && req.file.filename) { body.image = req.file.filename; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/welcome-banner/save', body); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not save the welcome banner.');
    return res.redirect('/welcome-banner');
}

// POST /welcome-banner/delete — soft-delete the config (status = 2).
async function remove(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/welcome-banner/delete', {}); }
    catch (e) { apiRes = null; }
    flashFromApi(req, apiRes, 'Could not delete the welcome banner.');
    return res.redirect('/welcome-banner');
}

module.exports = { form, save, remove };
