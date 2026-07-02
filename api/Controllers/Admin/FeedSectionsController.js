'use strict';

/*
 * Controllers/Admin/FeedSectionsController.js
 *
 * What:  The ONE master ordering for the marketplace home feed's curated
 *        SECTIONS — Featured row, Sponsored row, Collections, Featured Products.
 *        The admin drags them into the order they should appear (and can
 *        hide a section). Stored in mp_feed_section (section, position, status).
 * Type:  READ + WRITE (mp_feed_section).
 * Used:  api/Routes/index.js — /admin/feed-sections/*.
 */

const H      = require('../../Helpers/helper');
const { db } = require('../../config/db');

const T = 'mp_feed_section';

// All home-feed sections + their default order + display meta. Every one is
// reorderable and can be shown / hidden.
const SECTIONS = [
    { key: 'favourites',  label: 'My Favourites',           icon: '❤️', hint: 'Each signed-in customer\'s saved restaurants' },
    { key: 'order-again', label: 'Order again',             icon: '🔁', hint: 'Each customer\'s recently-ordered restaurants (top 10)' },
    { key: 'featured',    label: 'Featured row',            icon: '⭐', hint: 'Paid placements labelled "Featured"' },
    { key: 'sponsored',   label: 'Sponsored row',           icon: '📌', hint: 'Paid placements labelled "Sponsored"' },
    { key: 'collections', label: 'Collections',             icon: '🗂️', hint: 'Your curated restaurant rows' },
    { key: 'products',    label: 'Featured Products',        icon: '🍔', hint: 'Admin-picked dish rows' },
    { key: 'restaurants', label: 'Top restaurants near you', icon: '🍽️', hint: 'Every other restaurant' },
];
const VALID = new Set(SECTIONS.map((s) => s.key));

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

// Saved positions/status keyed by section — {} when the table is missing/empty.
async function loadSaved() {
    try {
        const rows = await db(T).select('section', 'position', 'status');
        const map = {};
        rows.forEach((r) => { map[r.section] = { position: Number(r.position) || 0, status: Number(r.status) }; });
        return map;
    } catch (e) { return {}; }
}

/** list — GET /api/v1/admin/feed-sections → the 4 sections in saved order. */
async function list(req, res) {
    try {
        const saved = await loadSaved();
        const sections = SECTIONS
            .map((s, i) => ({
                key: s.key, label: s.label, icon: s.icon, hint: s.hint,
                position: saved[s.key] ? saved[s.key].position : (i + 1),
                status:   saved[s.key] ? saved[s.key].status   : 1,
            }))
            .sort((a, b) => a.position - b.position);
        return H.successResponse(res, { sections });
    } catch (err) {
        console.error('[admin.feedSections.list]', err && err.message);
        return H.errorResponse(res, 'Could not load the feed order.', 500);
    }
}

/**
 * reorder — POST /api/v1/admin/feed-sections/reorder
 * Body: { order: [sectionKey, …], disabled: [sectionKey, …] }
 * Saves position (by array index) + status for every known section.
 */
async function reorder(req, res) {
    try {
        const order = (Array.isArray(req.body.order) ? req.body.order : []).filter((k) => VALID.has(k));
        // Any section the client didn't send keeps the default tail order.
        SECTIONS.forEach((s) => { if (!order.includes(s.key)) { order.push(s.key); } });
        const disabled = new Set((Array.isArray(req.body.disabled) ? req.body.disabled : []).filter((k) => VALID.has(k)));

        const now = nowStr();
        for (let i = 0; i < order.length; i++) {
            const key = order[i];
            await db(T)
                .insert({ section: key, position: i + 1, status: disabled.has(key) ? 0 : 1, updated_at: now })
                .onConflict('section')
                .merge({ position: i + 1, status: disabled.has(key) ? 0 : 1, updated_at: now });
        }
        return H.successResponse(res, { saved: true }, 'Feed order saved.');
    } catch (err) {
        console.error('[admin.feedSections.reorder]', err && err.message);
        return H.errorResponse(res, 'Could not save the feed order.', 500);
    }
}

module.exports = { list, reorder };
