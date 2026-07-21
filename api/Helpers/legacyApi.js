'use strict';

/*
 * Helpers/legacyApi.js
 *
 * What:  ONE place that talks to the legacy Eat-n-Deal backend api
 *        (backend/controllers/api/*). Every call shares the same plumbing:
 *
 *          base url from env  →  + action  →  api_key injected
 *          →  multipart POST  →  JSON envelope  →  { ok, data, message }
 *
 * Why:   Only the ACTION and its PARAMETERS differ between calls. Keeping the
 *        transport here means a new legacy endpoint is a new small function
 *        with its own parameters — not another copy of the fetch/key/error
 *        handling, and never another env var per endpoint.
 *
 *        To add one:
 *            const ACTIONS = { ..., orderPlace: 'order-place' };
 *            async function orderPlace({ orderId, total }) {
 *                return post(ACTIONS.orderPlace, { order_id: orderId, total });
 *            }
 *
 * Config (env):
 *        UPLOAD_API_URL — BASE only, e.g. "https://host/admin/api/default".
 *                         No action on the end; post() appends it.
 *        UPLOAD_API_KEY — shared secret, injected into every call. Server-side
 *                         only; it must never reach a browser.
 *
 * Contract: post() NEVER throws and never rejects — a legacy server that is
 *        down, slow or returning junk comes back as { ok:false, message } so
 *        callers stay simple and a marketplace request can't 500 because a
 *        restaurant's server had a bad day.
 *
 * Type:  WRITE (network).
 */

const H = require('./helper');

// Actions available on the legacy DefaultController. Named here so no call
// site ever hardcodes a URL fragment.
const ACTIONS = Object.freeze({
    uploadFile: 'upload-file',      // DefaultController::actionUploadFile
});

const DEFAULT_TIMEOUT_MS = 20000;

/** baseUrl / apiKey — read per call so a changed env doesn't need a restart. */
function baseUrl() { return String(process.env.UPLOAD_API_URL || '').trim(); }
function apiKey()  { return String(process.env.UPLOAD_API_KEY || '').trim(); }

/** isConfigured — both halves present. Type: READ (pure). */
function isConfigured() { return !!(baseUrl() && apiKey()); }

/**
 * url — base + action, tolerating a slash on either side (the live base has a
 * trailing one) so the result never contains "//".
 * Type: READ (pure).
 */
function url(action) {
    const b = baseUrl();
    if (!b) { return ''; }
    return b.replace(/\/+$/, '') + '/' + String(action || '').replace(/^\/+/, '');
}

/**
 * post
 *
 * What:  POST `params` to one legacy action as multipart form-data (what the
 *        Yii controller reads), with api_key added.
 * Type:  WRITE (network).
 *
 * Input:  action  — a value from ACTIONS
 *         params  — plain object; every value is sent as a form field. null /
 *                   undefined values are skipped so an optional parameter is
 *                   simply absent rather than the string "undefined".
 *         opts    — { timeoutMs }
 * Output: { ok, data, message } — ok mirrors the legacy `success` flag.
 */
async function post(action, params, opts) {
    opts = opts || {};
    if (!isConfigured()) {
        return { ok: false, data: null, message: 'The restaurant server is not configured.' };
    }

    const form = new FormData();
    form.append('api_key', apiKey());
    Object.keys(params || {}).forEach((k) => {
        const v = params[k];
        if (v === undefined || v === null) { return; }
        form.append(k, typeof v === 'string' ? v : String(v));
    });

    // A hung legacy server would otherwise hold this request open until the
    // client gives up — bound it and report the timeout like any other failure.
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);

    try {
        const r = await fetch(url(action), { method: 'POST', body: form, signal: ctrl.signal });
        const json = await r.json().catch(() => null);
        if (!json) {
            return { ok: false, data: null, message: 'The restaurant server sent an unreadable response.' };
        }
        if (json.success !== true) {
            return { ok: false, data: json, message: json.message || 'The restaurant server rejected the request.' };
        }
        return { ok: true, data: json, message: json.message || '' };
    } catch (e) {
        const aborted = e && e.name === 'AbortError';
        H.log.error('legacyApi.' + action, aborted ? 'timeout' : (e && e.message));
        return {
            ok: false, data: null,
            message: aborted ? 'The restaurant server took too long to respond.'
                             : 'Could not reach the restaurant server.',
        };
    }
}

/**
 * uploadFile
 *
 * What:  Store one image on a restaurant's legacy server. Parameter names are
 *        the controller's (upload_path / file_name / image_data) — mapped here
 *        so callers pass readable ones.
 * Type:  WRITE (network).
 *
 * Input:  { uploadPath, fileName, imageBase64 }
 */
async function uploadFile({ uploadPath, fileName, imageBase64 }) {
    return post(ACTIONS.uploadFile, {
        upload_path: uploadPath,
        file_name:   fileName,
        image_data:  imageBase64,
        // is_web_ordering — tells the legacy side this upload came from the
        // web-ordering/marketplace app rather than the POS. Fixed at 1: every
        // upload from this codebase is web ordering. If a POS-side caller is
        // ever added, this becomes a parameter instead of a constant.
        is_web_ordering: 1,
    });
}

module.exports = { ACTIONS, post, uploadFile, url, isConfigured };
