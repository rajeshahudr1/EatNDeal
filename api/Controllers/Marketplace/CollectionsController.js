'use strict';

/*
 * Controllers/Marketplace/CollectionsController.js
 *
 * What:  The marketplace HOME FEED — an ordered stack of "rows":
 *           • a single "Featured" row (admin-granted, time-bound paid
 *             placements from mp_featured_placement, ordered by priority), then
 *           • each active curated collection (mp_collection by sort_order),
 *             its restaurants in the admin-set position order
 *             (mp_collection_assign.position).
 *
 *        Every restaurant is rendered as the SAME card shape the rest of the
 *        marketplace uses (M.toRestaurantCard) — location/rating/open-state
 *        enriched exactly like the favourites rail. Empty rows are dropped, so
 *        with nothing configured the endpoint returns [] and the homepage looks
 *        exactly like before.
 * Type:  READ.
 * Used:  GET /api/v1/marketplace/home-feed?lat=&lng=&customer_id=
 */

const H          = require('../../Helpers/helper');
const MSG        = require('../../Helpers/messages');
const customers  = require('../../Helpers/customerLookup');
const M          = require('../../Helpers/marketplace');
const OrderTime  = require('../../Helpers/orderTime');
const StoreHours = require('../../Helpers/storeHours');
const Fav        = require('../Customer/FavouriteController');
const { db }     = require('../../config/db');

const numOrNull = customers.coerceNum;

/**
 * loadCardsByCompanyIds
 *
 * What:  Builds a Map(company_id → restaurant card) for the given company ids,
 *        using the same query + enrichment as FavouriteController.list (the
 *        canonical "render these specific restaurants" path). Only LIVE
 *        marketplace companies/branches survive (eligible scopes), so a row
 *        silently drops a restaurant that went offline.
 * Type:  READ.
 */
async function loadCardsByCompanyIds(companyIds, { lat, lng, favSet }) {
    const ids = [...new Set((companyIds || []).map(Number).filter((n) => n > 0))];
    if (!ids.length) { return new Map(); }

    const rows = await db
        .from('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .whereIn('c.id', ids)
        .modify(M.eligibleCompanyScope, 'c')
        .modify(M.eligibleBranchScope,  'b')
        .select(
            'c.id as company_id', 'c.business_name', 'c.domain_name', 'c.business_category',
            'b.id as branch_id', 'b.name as branch_name', 'b.trading_name as branch_trading_name',
            'b.banner_image', 'b.business_image',
            'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
            'b.start_time', 'b.end_time', 'b.open_as_usual', 'b.closed_until',
            'b.closed', 'b.closed_reopen_date', 'b.clossed_repoen_time', 'b.clossed_text',
            'b.closed_for', 'b.closed_for_time',
            'b.show_delivery_option', 'b.show_delivery_option_tab', 'b.delivery_closed_util_date',
            'b.show_pickup_option', 'b.show_pickup_option_tab', 'b.pickup_closed_util_date',
            'b.delivery_waiting_time', 'b.pickup_waiting_time',
            M.avgRatingSubq(db, 'c'),
        )
        .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }]);

    // One canonical card per company (lowest branch id).
    const seen = new Set();
    const uniq = rows.filter((r) => {
        if (seen.has(r.company_id)) { return false; }
        seen.add(r.company_id); return true;
    });
    if (!uniq.length) { return new Map(); }

    const timesByBranch = await OrderTime.computeForBranches(uniq);
    const availByBranch = await StoreHours.availabilityForBranches(uniq);

    const map = new Map();
    uniq.forEach((r) => {
        const card = M.toRestaurantCard(r, {
            lat, lng,
            times:       timesByBranch[String(r.branch_id)],
            isFavourite: favSet ? favSet.has(String(r.company_id)) : false,
        });
        const av = availByBranch.get(String(r.branch_id));
        if (av) { card.isOpen = av.isOpen; card.openStatus = av.status; card.hours = av.hours; card.opensAt = av.reopenAt; }
        map.set(String(r.company_id), card);
    });
    return map;
}

// Active featured placements GROUPED BY their label ("Featured" / "Sponsored"),
// each ordered by priority DESC → one home-feed row per label. A restaurant
// shows in ONE row only (its highest-priority placement's label).
async function activeFeaturedGroups() {
    const now = new Date();
    const rows = await db('mp_featured_placement')
        .where('status', 1)
        .andWhere(function () { this.whereNull('starts_at').orWhere('starts_at', '<=', now); })
        .andWhere(function () { this.whereNull('ends_at').orWhere('ends_at', '>=', now); })
        .orderBy('priority', 'desc').orderBy('id', 'asc')
        .select('company_id', 'label');
    const groups = new Map();   // label -> [companyId, …]
    const seen = new Set();
    rows.forEach((r) => {
        const k = String(r.company_id);
        if (seen.has(k)) { return; }
        seen.add(k);
        const label = String(r.label || '').trim() || 'Featured';
        if (!groups.has(label)) { groups.set(label, []); }
        groups.get(label).push(Number(r.company_id));
    });
    return groups;
}

// `mp_featured_product.company_position` (migration m260619_150000) orders the
// restaurant entries; feature-detect it so the feed works before the migration.
let _hasFpPos = null;
async function hasFeaturedProductPos() {
    if (_hasFpPos !== null) { return _hasFpPos; }
    try {
        const r = await db('information_schema.columns')
            .where({ table_name: 'mp_featured_product', column_name: 'company_position' }).first('column_name');
        _hasFpPos = !!r;
    } catch (e) { _hasFpPos = false; }
    return _hasFpPos;
}

// Admin-featured PRODUCTS → one row per restaurant (heading = restaurant name,
// cards = its chosen dishes, ordered by position). Mirrors the product-image
// join the marketplace ProductsController uses.
async function featuredProductRows() {
    const withPos = await hasFeaturedProductPos();
    const qb = db('mp_featured_product as f')
        .join('products as p', 'p.id', 'f.product_id')
        .join('company as c',  'c.id', 'f.company_id')
        .where('f.status', 1)
        .andWhere('p.show_marketplace', 1)
        .andWhere('p.status', '1')
        .modify(M.eligibleCompanyScope, 'c')
        .leftJoin(
            db('product_image')
                .select('product_id', db.raw(`(
                    SELECT url FROM product_image pi2
                    WHERE pi2.product_id = product_image.product_id AND pi2.status = '1'
                    ORDER BY pi2.is_primary DESC, pi2.id ASC LIMIT 1
                ) AS url`))
                .where('status', '1').groupBy('product_id').as('pi'),
            'pi.product_id', 'p.id',
        )
        .select('f.company_id', 'f.position', 'c.business_name', 'c.domain_name',
                'p.id as product_id', 'p.name as product_name', 'p.veg_non_veg',
                'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax',
                'pi.url as image_url');
    // Entry order (which restaurant's row first) when the column exists.
    if (withPos) { qb.orderBy('f.company_position', 'asc'); }
    qb.orderBy('c.business_name', 'asc').orderBy('f.position', 'asc');
    const rows = await qb;

    // Group by restaurant (preserving order), build one row each. Collapse
    // duplicate-named dishes so a card never repeats in the row.
    const byCompany = new Map();
    const namesByCompany = new Map();
    rows.forEach((r) => {
        const k = String(r.company_id);
        if (!byCompany.has(k)) {
            byCompany.set(k, {
                type: 'product',
                section: 'products',
                companyId: Number(r.company_id),
                title: r.business_name || 'Restaurant',
                // Slug MUST be run through M.slugify — the /?restaurant=<slug>
                // resolver (RestaurantsController.detail) matches against
                // M.slugify(domain_name). Using the raw domain here left dots
                // in ("eatndeal2.neutroveg.com") so the "View all" link never
                // resolved; slugify strips them → "eatndeal2neutrovegcom",
                // identical to every other call site.
                restaurantSlug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(r.business_name, r.company_id),
                products: [],
            });
            namesByCompany.set(k, new Set());
        }
        const nm = String(r.product_name || '').trim().toLowerCase();
        if (namesByCompany.get(k).has(nm)) { return; }
        namesByCompany.get(k).add(nm);
        byCompany.get(k).products.push({
            id:    String(r.product_id),
            name:  String(r.product_name || '').trim(),
            price: M.pickPrice(r),
            image: M.yiiImageUrl('product', r.company_id, r.image_url) || null,
            veg:   M.isVegProduct(r),
        });
    });
    return [...byCompany.values()].filter((row) => row.products.length);
}

// The admin-configured order of the 4 home-feed sections. Graceful default
// (featured → sponsored → collections → products) when mp_feed_section is
// missing/empty. Returns [{ key, position, status }] sorted by position.
const DEFAULT_SECTIONS = ['favourites', 'order-again', 'featured', 'sponsored', 'collections', 'products', 'restaurants'];
async function feedSectionOrder() {
    let saved = [];
    try { saved = await db('mp_feed_section').select('section', 'position', 'status'); } catch (e) { saved = []; }
    const by = new Map(saved.map((r) => [r.section, { position: Number(r.position) || 0, status: Number(r.status) }]));
    return DEFAULT_SECTIONS
        .map((key, i) => ({ key, position: by.has(key) ? by.get(key).position : (100 + i), status: by.has(key) ? by.get(key).status : 1 }))
        .sort((a, b) => a.position - b.position);
}

/**
 * homeFeed — GET /api/v1/marketplace/home-feed
 *
 * Output: 200 envelope, data = { rows: [
 *           { type:'featured',   title, restaurants:[card,...] },
 *           { type:'collection', id, title, subtitle, image_url, restaurants:[...] },
 *           ...
 *         ] }
 */
async function homeFeed(req, res) {
    try {
        const lat = numOrNull(req.query.lat);
        const lng = numOrNull(req.query.lng);
        const customerId = req.query.customer_id || null;

        // 1. Gather the row definitions (featured + collections) and every
        //    company id they reference, so cards load in ONE query.
        const featGroups = await activeFeaturedGroups();
        const allFeaturedIds = [];
        featGroups.forEach((ids) => ids.forEach((id) => allFeaturedIds.push(id)));

        const collections = await db('mp_collection').where('status', 1)
            .orderBy('sort_order', 'asc').orderBy('id', 'asc')
            .select('id', 'name', 'subtitle', 'image');

        const assigns = collections.length
            ? await db('mp_collection_assign')
                .whereIn('collection_id', collections.map((c) => c.id))
                .orderBy('position', 'asc')
                .select('collection_id', 'company_id', 'position')
            : [];
        const idsByCollection = new Map();
        assigns.forEach((a) => {
            const k = String(a.collection_id);
            if (!idsByCollection.has(k)) { idsByCollection.set(k, []); }
            idsByCollection.get(k).push(Number(a.company_id));
        });

        // The full 6-section order (incl. favourites + restaurants, which the
        // WEB renders) — always returned so the web can position every section.
        const order = await feedSectionOrder();

        const allIds = [...new Set([...allFeaturedIds, ...assigns.map((a) => Number(a.company_id))])];
        if (!allIds.length) { return H.successResponse(res, { rows: [], order }); }

        // 2. Favourites (optional) + cards in one batch.
        let favSet = new Set();
        if (customerId) {
            try { favSet = await Fav.favouriteIdSet(customerId, allIds); } catch (e) { favSet = new Set(); }
        }
        const cards = await loadCardsByCompanyIds(allIds, { lat, lng, favSet });

        // 3. Build each SECTION's rows into a bucket (empties dropped).
        const buckets = { featured: [], sponsored: [], collections: [], products: [] };

        // Featured / Sponsored — one row per label; the 'Sponsored' label goes to
        // the sponsored section, every other label to the featured section.
        const LABEL_ORDER = ['Featured', 'Sponsored'];
        const rank = (l) => { const i = LABEL_ORDER.indexOf(l); return i === -1 ? 99 : i; };
        [...featGroups.keys()].sort((a, b) => rank(a) - rank(b)).forEach((label) => {
            const list = featGroups.get(label).map((id) => cards.get(String(id))).filter(Boolean);
            if (!list.length) { return; }
            const isSponsored = String(label).toLowerCase() === 'sponsored';
            const row = { type: 'featured', section: isSponsored ? 'sponsored' : 'featured', title: label, restaurants: list };
            if (isSponsored) { buckets.sponsored.push(row); } else { buckets.featured.push(row); }
        });

        const imageUrl = (file) => {
            const f = String(file || '').trim();
            if (!f) { return ''; }
            if (/^https?:\/\//i.test(f) || f.startsWith('/')) { return H.mediaUrl(f); }
            return H.getUploadsBaseUrl() + '/marketplace/collection/' + f;
        };
        collections.forEach((c) => {
            const list = (idsByCollection.get(String(c.id)) || []).map((id) => cards.get(String(id))).filter(Boolean);
            if (list.length) {
                buckets.collections.push({
                    type: 'collection',
                    section: 'collections',
                    id: Number(c.id),
                    title: c.name || '',
                    subtitle: c.subtitle || '',
                    image_url: imageUrl(c.image),
                    restaurants: list,
                });
            }
        });

        // Featured-PRODUCT rows (one per restaurant). Best-effort.
        try {
            const prodRows = await featuredProductRows();
            prodRows.forEach((r) => buckets.products.push(r));
        } catch (e) { H.log.warn('marketplace.homeFeed.products', e && e.message); }

        // 4. Emit the CURATED buckets (favourites + restaurants are web-side) in
        //    the configured order, skipping hidden ones. The web uses `order` to
        //    slot My Favourites + Top restaurants around them.
        const rows = [];
        order.forEach((s) => {
            if (Number(s.status) === 0) { return; }
            (buckets[s.key] || []).forEach((r) => rows.push(r));
        });

        return H.successResponse(res, { rows, order });
    } catch (err) {
        H.log.error('marketplace.homeFeed', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { homeFeed };
