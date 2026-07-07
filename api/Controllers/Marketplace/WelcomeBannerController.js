'use strict';

/*
 * Controllers/Marketplace/WelcomeBannerController.js
 *
 * What:  The customer-facing read of the super-admin's WELCOME strip config
 *        (mp_welcome_banner) shown on the home page under the category rail.
 *          GET /marketplace/welcome-banner → { banner: {...} | null }
 *
 *        `banner` is null when: no config, not active, or the chosen content
 *        type has nothing to show (image mode with no image / text mode with no
 *        title+subtitle). The WEB decides WHEN to show it:
 *          • mode 'fix'          → always
 *          • mode 'new_customer' → once, right after signup (web session flag)
 *
 * Type:  READ. Single-row config (latest row wins; the admin upserts).
 * Used:  api/Routes/index.js — GET /marketplace/welcome-banner (public).
 */

const H       = require('../../Helpers/helper');
const MSG     = require('../../Helpers/messages');
const { db }  = require('../../config/db');
const WB      = require('../../config/welcomeBanner');   // MODE / TYPE enum IDs

const T = 'mp_welcome_banner';

// Table-exists guard (cached) — degrade to "no banner" before the migration.
let _ready = null;
async function ready() {
    if (_ready !== null) { return _ready; }
    try { const r = await db.raw("select to_regclass('public.mp_welcome_banner') as t"); _ready = !!((r.rows || r)[0] || {}).t; }
    catch (e) { _ready = false; }
    return _ready;
}

function imageUrl(file) {
    const f = String(file || '').trim();
    return f ? H.mediaUrl(f) : '';
}

/** loadConfig — the single latest config row, or null. (Shared with admin read.) */
async function loadConfig() {
    if (!(await ready())) { return null; }
    const row = await db(T).orderBy('id', 'desc').first();
    return row || null;
}

/** get — GET /marketplace/welcome-banner — the active banner for the home page. */
async function get(req, res) {
    try {
        const row = await loadConfig();
        // Hidden (is_active = 0) OR soft-deleted (status = 2) → no banner.
        if (!row || Number(row.is_active) !== 1 || Number(row.status) === WB.STATUS.DELETED) {
            return H.successResponse(res, { banner: null });
        }

        // mode + type are INTEGER enum IDs (see config/welcomeBanner).
        const type     = Number(row.content_type) === WB.TYPE.IMAGE ? WB.TYPE.IMAGE : WB.TYPE.TEXT;
        const title    = String(row.title || '').trim();
        const subtitle = String(row.subtitle || '').trim();
        const imgUrl   = type === WB.TYPE.IMAGE ? imageUrl(row.image) : '';

        // Nothing to actually show → treat as no banner.
        if (type === WB.TYPE.IMAGE && !imgUrl)             { return H.successResponse(res, { banner: null }); }
        if (type === WB.TYPE.TEXT  && !title && !subtitle) { return H.successResponse(res, { banner: null }); }

        return H.successResponse(res, {
            banner: {
                mode:      Number(row.mode) === WB.MODE.NEW_CUSTOMER ? WB.MODE.NEW_CUSTOMER : WB.MODE.FIX,
                type,
                title,
                subtitle,
                image_url: imgUrl,
                link:      String(row.link_url || '').trim(),
            },
        });
    } catch (err) {
        H.log.error('welcomeBanner.get', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { get, loadConfig };
