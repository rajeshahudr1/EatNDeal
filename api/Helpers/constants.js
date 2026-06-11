'use strict';

/*
 * Helpers/constants.js
 *
 * What:  Frozen single-source-of-truth for cross-file domain constants and
 *        small data tables that were previously duplicated as parallel copies
 *        across helpers and controllers. Pure data + a couple of tiny lookups —
 *        NO DB, NO framework. Everything is Object.freeze'd so a require'r can
 *        never mutate a shared table.
 *
 *        Scope note: order-status codes live in Helpers/orderStatus.js and
 *        serve/service types live in Helpers/storeHours.js — those remain the
 *        single source for their domain (a prior project decision), so they are
 *        intentionally NOT re-homed here.
 *
 * Used:  Helpers/format.js (TINT_PALETTE), Helpers/loyalty.js + Controllers/
 *        Admin/LoyaltyController.js (REVIEW_TYPES / REVIEW_STATUSES).
 *
 * Change log:
 *   2026-06-10 — initial (dedup initiative: shared per-layer commons).
 */

// ── Card tint palette ────────────────────────────────────────────────
// Deterministic pastel background for restaurant/company placeholder cards
// (consumed by format.tintFor). Food-friendly warm+soft tones that pop on
// white. One copy here replaces the two divergent arrays that used to live
// in marketplace.js (TINT_PALETTE) and loyalty.js (TINTS).
const TINT_PALETTE = Object.freeze([
    '#FFE0B2', // peach
    '#FFCDD2', // soft red
    '#FFAB91', // terracotta
    '#C5E1A5', // lime
    '#A5D6A7', // mint
    '#FFE082', // mustard
    '#EF9A9A', // rose
    '#B0BEC5', // slate
    '#F8BBD0', // pink
    '#D1C4E9', // lavender
]);

// ── Review / share cashback types ────────────────────────────────────
// The 8 ways a customer can earn review/share cashback. `menu:false` types are
// internal (hidden from the customer earn menu). `video:true` types submit a
// video URL instead of a screenshot. One copy here replaces REVIEW_TYPES in
// loyalty.js and REVIEW_CMS_TYPES in Admin/LoyaltyController.js.
const REVIEW_TYPES = Object.freeze([
    Object.freeze({ id: 1, slug: 'google-review',           name: 'Google Review',               icon: '⭐', menu: true,  video: false }),
    Object.freeze({ id: 2, slug: 'website-review',          name: 'Website Review',              icon: '🌐', menu: false, video: false }),
    Object.freeze({ id: 3, slug: 'transfer-loyalty-review', name: 'Transfer Your Loyalty To Us', icon: '🔁', menu: true,  video: false }),
    Object.freeze({ id: 4, slug: 'facebook-review',         name: 'Facebook Share',              icon: '📘', menu: true,  video: false }),
    Object.freeze({ id: 5, slug: 'tiktok-review',           name: 'TikTok Share',                icon: '🎵', menu: true,  video: false }),
    Object.freeze({ id: 6, slug: 'instagram-review',        name: 'Instagram Share',             icon: '📸', menu: true,  video: false }),
    Object.freeze({ id: 7, slug: 'live-video-review',       name: 'Live Video',                  icon: '🎥', menu: true,  video: true  }),
    Object.freeze({ id: 8, slug: 'whatsapp-review',         name: 'Whatsapp Share',              icon: '💬', menu: true,  video: false }),
]);

// ── Review claim status (customer_review.admin_status) ───────────────
// byCode  → lowercase slug used by the customer earn UI logic.
// label   → Title-case label used by the admin claims screen.
// byName  → reverse lookup (slug → numeric code).
const REVIEW_STATUSES = Object.freeze({
    byCode: Object.freeze({ 0: 'pending', 1: 'approved', 2: 'rejected' }),
    label:  Object.freeze({ 0: 'Pending', 1: 'Approved', 2: 'Rejected' }),
    byName: Object.freeze({ pending: 0, approved: 1, rejected: 2 }),
});

module.exports = { TINT_PALETTE, REVIEW_TYPES, REVIEW_STATUSES };
