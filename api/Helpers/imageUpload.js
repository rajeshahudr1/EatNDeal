'use strict';

/*
 * Helpers/imageUpload.js
 *
 * What:  ONE place that decides WHERE an uploaded image goes, and gives back the
 *        reference we store in the DB.
 *
 *          • MARKETPLACE (company_id = 0) → OUR server. Written to the api's own
 *            media tree (MEDIA_DIR → /upload/<folder>/<file>), the same tree CMS
 *            screenshots and marketplace category images use. Served by the api;
 *            H.mediaUrl() makes it absolute on read.
 *
 *          • A RESTAURANT (company_id > 0) → THAT restaurant's legacy Eat-n-Deal
 *            server. We can't write to another server's disk directly, so we POST
 *            the image (base64) to its upload API, which stores it under
 *            "<company_id>/<folder>". We keep just the bare file name; the reader
 *            rebuilds "<uploadsBase>/<company_id>/<folder>/<file>".
 *
 * Why:   Reviews need this now (a Google-review screenshot for a restaurant must
 *        land on that restaurant's server, a marketplace one on ours). Products
 *        and everything else will follow the SAME rule, so the folder list and
 *        the save/resolve logic live here once — not copied per feature.
 *
 * Config (env):
 *        UPLOAD_API_URL  — the legacy upload API endpoint (live vs local test).
 *        UPLOAD_API_KEY  — its secret key (server-side only, never sent to a page).
 *        MEDIA_DIR       — our own media root (shared with the rest of the app).
 *
 * Type:  WRITE (disk / network) + READ (url resolve).
 *
 * Change log:
 *   2026-07-17 — initial (review screenshots; marketplace vs per-restaurant).
 */

const fs   = require('fs');
const path = require('path');
const H    = require('./helper');

// ── Folder names (COMMON — reused by every feature that stores images) ──
// Marketplace and restaurant uploads use the SAME folder name; only the SERVER
// differs. Names match the legacy Eat-n-Deal upload folders so a restaurant's
// files sit beside its existing ones. Add a key here when a new feature needs
// a folder — never hardcode a folder string at a call site.
const FOLDERS = Object.freeze({
    reviews:   'reviews',          // review / share screenshots (this task)
    products:  'products',         // product images (future)
    category:  'category',         // marketplace categories
    surprise:  'surprise_image',   // Surprise Box photo
    loyalty:   'loyalty',          // loyalty CMS example screenshots
    banner:    'banner_image',
    branch:    'branch',
    community: 'community',
});

const MARKETPLACE_COMPANY_ID = 0;

// Legacy upload API — endpoint + key from env. Both blank in an env that has no
// legacy server (then restaurant uploads fail loudly instead of silently).
const UPLOAD_API_URL = (process.env.UPLOAD_API_URL || '').trim();
const UPLOAD_API_KEY = (process.env.UPLOAD_API_KEY || '').trim();

// Our own media root — the same one admin/index + web use (api/public/upload).
const MEDIA_DIR = process.env.MEDIA_DIR
    ? path.resolve(process.env.MEDIA_DIR)
    : path.join(__dirname, '..', 'public', 'upload');

// Legacy uploads URL base (e.g. /yii-uploads or the live host) for READ paths.
function legacyUrl(companyId, sub, file) {
    const base = H.getUploadsBaseUrl();
    return base + '/' + companyId + '/' + sub + '/' + file;
}

// Keep a filename safe + unique-ish. Callers pass the name we want in the DB.
function safeName(name) {
    const raw = String(name || '').trim().replace(/[^\w.\-]/g, '_');
    return raw || ('img_' + Date.now() + '.png');
}

/**
 * saveImage
 *
 * Inputs: { companyId, folder, fileName, base64 | buffer }
 *           folder — a KEY of FOLDERS (or a raw folder name).
 * Output: { ok, ref, url, message }
 *           ref — the value to store in the DB column.
 *           url — a ready-to-render URL for it.
 */
async function saveImage({ companyId, folder, fileName, base64, buffer }) {
    const cid  = Number(companyId);
    const sub  = FOLDERS[folder] || String(folder || '').trim();
    const name = safeName(fileName);
    const b64  = base64 || (buffer ? Buffer.from(buffer).toString('base64') : '');

    if (!sub)  { return { ok: false, message: 'Upload folder is required.' }; }
    if (!b64)  { return { ok: false, message: 'No image data.' }; }

    // ── MARKETPLACE → our server ────────────────────────────────────
    if (cid === MARKETPLACE_COMPANY_ID) {
        try {
            const dir = path.join(MEDIA_DIR, sub);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
        } catch (e) {
            H.log.error('imageUpload.local', e && e.message);
            return { ok: false, message: 'Could not save the image.' };
        }
        const ref = '/upload/' + sub + '/' + name;
        return { ok: true, ref, url: H.mediaUrl(ref) };
    }

    // ── RESTAURANT → legacy Eat-n-Deal upload API ───────────────────
    if (!UPLOAD_API_URL || !UPLOAD_API_KEY) {
        return { ok: false, message: 'Upload service is not configured for restaurants yet.' };
    }
    // The legacy API only accepts jpg/jpeg/png (DefaultController::actionUploadFile).
    // Reject other types here with a clear message instead of after the round trip.
    const ext = String(name.split('.').pop() || '').toLowerCase();
    if (!['jpg', 'jpeg', 'png'].includes(ext)) {
        return { ok: false, message: 'Only JPG, JPEG and PNG images are allowed.' };
    }
    try {
        const form = new FormData();
        form.append('api_key', UPLOAD_API_KEY);
        form.append('upload_path', cid + '/' + sub);   // e.g. "1/reviews"
        form.append('file_name', name);
        form.append('image_data', b64);                // base64 string

        const r = await fetch(UPLOAD_API_URL, { method: 'POST', body: form });
        const json = await r.json().catch(() => null);
        if (!json || json.success !== true) {
            return { ok: false, message: (json && json.message) || 'Upload failed on the restaurant server.' };
        }
    } catch (e) {
        H.log.error('imageUpload.legacy', e && e.message);
        return { ok: false, message: 'Could not reach the upload server.' };
    }
    // Stored as the bare file name; resolveUrl rebuilds the legacy path.
    return { ok: true, ref: name, url: legacyUrl(cid, sub, name) };
}

/**
 * resolveUrl — turn a stored ref back into a render URL.
 *   • absolute / "/upload/…" (ours)  → H.mediaUrl (api-served, made absolute)
 *   • bare "<file>" (legacy)         → <uploadsBase>/<company>/<folder>/<file>
 */
function resolveUrl(companyId, folder, ref) {
    const f = String(ref || '').trim();
    if (!f) { return ''; }
    if (/^https?:\/\//i.test(f) || f.charAt(0) === '/') { return H.mediaUrl(f); }
    const sub = FOLDERS[folder] || String(folder || '').trim();
    return legacyUrl(Number(companyId), sub, f);
}

module.exports = { FOLDERS, MARKETPLACE_COMPANY_ID, saveImage, resolveUrl };
