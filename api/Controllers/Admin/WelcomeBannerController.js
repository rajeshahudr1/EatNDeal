'use strict';

/*
 * Controllers/Admin/WelcomeBannerController.js
 *
 * What:  Super-admin CRUD for the ONE home WELCOME strip (mp_welcome_banner).
 *          GET  /admin/welcome-banner/get   → the current config (for the form)
 *          POST /admin/welcome-banner/save  → upsert the single config row
 *        Single-row config: the latest row is THE config (we update it in place,
 *        or insert the first one).
 * Type:  READ + WRITE (mp_welcome_banner).
 * Used:  api/Routes/index.js — /admin/welcome-banner/* (authenticate + admin).
 */

const H       = require('../../Helpers/helper');
const { db }  = require('../../config/db');
const WB      = require('../../config/welcomeBanner');   // MODE / TYPE enum IDs

const T = 'mp_welcome_banner';
const str = (v) => (v == null ? '' : String(v));
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

function imageUrl(file) {
    const f = str(file).trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
    return H.getUploadsBaseUrl() + '/marketplace/welcome_banner/' + f;
}

// Table-exists guard (cached) — before the migration, the admin still loads.
let _ready = null;
async function ready() {
    if (_ready !== null) { return _ready; }
    try { const r = await db.raw("select to_regclass('public.mp_welcome_banner') as t"); _ready = !!((r.rows || r)[0] || {}).t; }
    catch (e) { _ready = false; }
    return _ready;
}

/** getConfig — GET /admin/welcome-banner/get — current config for the form. */
async function getConfig(req, res) {
    try {
        if (!(await ready())) { return H.successResponse(res, { enabled: false, banner: null }); }
        const r = await db(T).orderBy('id', 'desc').first();
        // A soft-deleted (status = 2) config reads as "no banner" — the form
        // starts fresh; saving re-activates it.
        const live = (r && Number(r.status) !== WB.STATUS.DELETED) ? r : null;
        return H.successResponse(res, {
            enabled: true,
            banner: live ? {
                id:           Number(live.id),
                is_active:    Number(r.is_active) || 0,
                mode:         Number(r.mode) || WB.MODE.FIX,
                content_type: Number(r.content_type) || WB.TYPE.TEXT,
                title:        r.title || '',
                subtitle:     r.subtitle || '',
                image:        r.image || '',
                image_url:    imageUrl(r.image),
                link_url:     r.link_url || '',
            } : null,
        });
    } catch (err) {
        H.log.error('admin.welcomeBanner.get', err && err.message);
        return H.errorResponse(res, 'Could not load the welcome banner.', 500);
    }
}

/** save — POST /admin/welcome-banner/save — upsert the single config row. */
async function save(req, res) {
    try {
        if (!(await ready())) { return H.errorResponse(res, 'Run the mp_welcome_banner migration first (php yii migrate).', 422); }
        const b = req.body;

        const mode = Number(b.mode) === WB.MODE.NEW_CUSTOMER ? WB.MODE.NEW_CUSTOMER : WB.MODE.FIX;
        const type = Number(b.content_type) === WB.TYPE.IMAGE ? WB.TYPE.IMAGE : WB.TYPE.TEXT;
        const isActive = (Number(b.is_active) === 1 || b.is_active === '1' || b.is_active === 'on') ? 1 : 0;

        const patch = {
            is_active:    isActive,
            mode,
            content_type: type,
            title:        str(b.title).slice(0, 255),
            subtitle:     str(b.subtitle).slice(0, 500),
            link_url:     str(b.link_url).slice(0, 500),
            status:       WB.STATUS.ACTIVE,   // saving (re)activates the config
            updated_at:   nowStr(),
        };
        // Only overwrite the image when a NEW file was uploaded (multer stamped
        // the relative /upload/welcome_banner/<file> path onto b.image).
        if (b.image) { patch.image = str(b.image).slice(0, 255); }

        const existing = await db(T).orderBy('id', 'desc').first();

        // Validate the chosen content type has something to show (only when active).
        if (isActive === 1) {
            if (type === WB.TYPE.TEXT && !patch.title && !patch.subtitle) {
                return H.errorResponse(res, 'Add a title or subtitle for the text banner.', 422);
            }
            if (type === WB.TYPE.IMAGE && !patch.image && !(existing && existing.image)) {
                return H.errorResponse(res, 'Upload a banner image (or switch to Text).', 422);
            }
        }

        let id;
        if (existing) { await db(T).where('id', existing.id).update(patch); id = existing.id; }
        else { const ins = await db(T).insert(Object.assign({}, patch, { created_at: nowStr() })).returning('id'); id = Array.isArray(ins) ? (ins[0].id || ins[0]) : ins; }

        return H.successResponse(res, { saved: true, id: Number(id) }, 'Welcome banner saved.');
    } catch (err) {
        H.log.error('admin.welcomeBanner.save', err && err.message);
        return H.errorResponse(res, 'Could not save the welcome banner.', 500);
    }
}

/** remove — POST /admin/welcome-banner/delete — soft-delete the config (status = 2). */
async function remove(req, res) {
    try {
        if (!(await ready())) { return H.successResponse(res, { deleted: 0 }, 'Nothing to delete.'); }
        const existing = await db(T).orderBy('id', 'desc').first('id');
        if (!existing) { return H.successResponse(res, { deleted: 0 }, 'Nothing to delete.'); }
        await db(T).where('id', existing.id).update({ status: WB.STATUS.DELETED, updated_at: nowStr() });
        return H.successResponse(res, { deleted: 1 }, 'Welcome banner deleted.');
    } catch (err) {
        H.log.error('admin.welcomeBanner.delete', err && err.message);
        return H.errorResponse(res, 'Could not delete the welcome banner.', 500);
    }
}

module.exports = { getConfig, save, remove };
