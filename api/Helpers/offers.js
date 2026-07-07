'use strict';

/*
 * Helpers/offers.js
 *
 * What:  One place that knows how to read the live "offers" data and turn
 *        it into display-ready shapes for the marketplace:
 *          • store_offer_banner_table  → marketing banners (per company,
 *                                         optionally per category)
 *          • coupons                   → promo CODES (per branch)
 *          • discounts                 → auto discounts (per company,
 *                                         optionally per product)
 *        Loyalty/cashback is intentionally NOT covered here.
 *
 * Why:   The restaurant cards (badge), the restaurant detail page (offers
 *        strip) and the home "Best offers" rail all need the SAME notion
 *        of "what's active right now", so the active-window rules live in
 *        one file instead of being copy-pasted into three controllers.
 *
 * Active rules (kept deliberately simple for DISPLAY — final redemption
 * is validated at checkout when that lands):
 *   • banners  : publish_online=1 AND now within [start_date, end_date]
 *   • coupons  : is_active=1 AND not expired AND platform in (All, Website)
 *   • discounts: status=1 AND now within [start_date, end_date]
 * Day-of-week / postcode / per-customer gating is left to checkout.
 *
 * Type:  READ.
 * Used:  Marketplace RestaurantsController (list badge + detail strip) and
 *        the /marketplace/offers feed.
 */

const F = require('./format');

const { db } = require('../config/db');
const M       = require('./marketplace');

// now-within-window helper (NULL bound = open-ended).
function withinWindow(qb, startCol, endCol) {
    qb.where((b) => { b.whereNull(startCol).orWhere(startCol, '<=', db.raw('CURRENT_DATE')); })
      .andWhere((b) => { b.whereNull(endCol).orWhere(endCol, '>=', db.raw('CURRENT_DATE')); });
}

/**
 * bannersForCompany — active store-offer banners for one company.
 * Type: READ. Output: [{ id, title, details, terms, categoryId }]
 */
async function bannersForCompany(companyId) {
    const rows = await db('store_offer_banner_table')
        .where('company_id', companyId)
        .andWhere('publish_online', 1)
        .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
        .orderBy('id', 'desc')
        .select('id', 'offer_title', 'offer_details', 'offer_terms', 'category_id');
    return rows.map((r) => ({
        id:         String(r.id),
        title:      String(r.offer_title || '').trim(),
        details:    String(r.offer_details || '').trim(),
        terms:      String(r.offer_terms || '').trim(),
        categoryId: r.category_id != null ? String(r.category_id) : null,
    })).filter((b) => b.title);
}

/**
 * couponsForBranch — active promo codes for one branch (website-eligible).
 * Type: READ. Output: [{ code, type(1=%,2=amount), value, minOrder, freeDelivery }]
 */
async function couponsForBranch(branchId) {
    const rows = await db('coupons')
        .where('branch_id', branchId)
        .andWhere('is_active', 1)
        .whereIn('platform', [1, 2])                 // 1=All, 2=Website
        .andWhere((qb) => { qb.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
        .orderBy('id', 'desc')
        .select('id', 'code', 'discount_type', 'discount_value', 'min_order_value', 'free_delivery');
    return rows.map((r) => ({
        code:         String(r.code || '').trim(),
        type:         Number(r.discount_type) || 1,
        value:        r.discount_value != null ? Number(r.discount_value) : 0,
        minOrder:     r.min_order_value != null ? Number(r.min_order_value) : 0,
        freeDelivery: Number(r.free_delivery) === 1,
    })).filter((c) => c.code);
}

/**
 * discountsForCompany — active auto-discounts for one company.
 * Type: READ. Output: [{ type, value, minOrder, maxDiscount, product }]
 */
async function discountsForCompany(companyId) {
    const rows = await db('discounts')
        .where('company_id', companyId)
        .andWhere('status', 1)
        .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
        .orderBy('id', 'desc')
        .select('id', 'discount_type', 'discount_value', 'min_order_value', 'max_discount', 'product_id');

    // Resolve product names for product-specific discounts in one query.
    const pids = rows.map((r) => r.product_id).filter(Boolean);
    const names = {};
    if (pids.length) {
        const ps = await db('products').whereIn('id', pids).select('id', 'name');
        ps.forEach((p) => { names[String(p.id)] = String(p.name || '').trim(); });
    }
    return rows.map((r) => ({
        type:        Number(r.discount_type) || 1,
        value:       r.discount_value != null ? Number(r.discount_value) : null,
        minOrder:    r.min_order_value != null ? Number(r.min_order_value) : 0,
        maxDiscount: r.max_discount != null ? Number(r.max_discount) : null,
        product:     r.product_id ? (names[String(r.product_id)] || null) : null,
    }));
}

/**
 * offersForRestaurant — everything the restaurant detail page shows.
 * Type: READ. Output: { banners, coupons, discounts, hasAny }
 */
async function offersForRestaurant(companyId, branchId) {
    const [banners, coupons, discounts] = await Promise.all([
        bannersForCompany(companyId),
        branchId ? couponsForBranch(branchId) : Promise.resolve([]),
        discountsForCompany(companyId),
    ]);
    return {
        banners,
        coupons,
        discounts,
        hasAny: !!(banners.length || coupons.length || discounts.length),
    };
}

/**
 * offersFeed — active banners across all marketplace companies, for the
 * home "Best offers" rail. Each carries the restaurant name + slug so the
 * card can deep-link to that restaurant.
 * Type: READ. Output: [{ id, title, details, terms, restaurant:{name,slug} }]
 */
async function offersFeed(limit) {
    const rows = await db('store_offer_banner_table as o')
        .innerJoin('company as c', 'c.id', 'o.company_id')
        .where('o.publish_online', 1)
        .andWhere('c.is_marketplace', 1)
        .andWhere((qb) => withinWindow(qb, 'o.start_date', 'o.end_date'))
        .orderBy('o.id', 'desc')
        .limit(limit || 8)
        .select(
            'o.id', 'o.offer_title', 'o.offer_details', 'o.offer_terms',
            'o.company_id', 'c.business_name', 'c.domain_name',
        );
    return rows.map((r) => {
        const name = String(r.business_name || '').trim();
        return {
            id:      String(r.id),
            title:   String(r.offer_title || '').trim(),
            details: String(r.offer_details || '').trim(),
            terms:   String(r.offer_terms || '').trim(),
            restaurant: {
                id:   String(r.company_id),
                name,
                slug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
            },
        };
    }).filter((o) => o.title);
}

/**
 * groupedOffers — every marketplace restaurant that has at least one
 * active offer, with its offers grouped under it. Batched (≈5 queries
 * total regardless of restaurant count) for the dedicated Offers page.
 * Type: READ.
 * Output: [ { id, slug, name, cuisines, image, initial, tint,
 *             offers:{ banners, coupons, discounts }, count } ]
 */
async function groupedOffers() {
    const cos = await db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .where('c.is_marketplace', 1)
        .whereNull('c.deleted_at')
        .andWhere('b.status', '<>', '2')
        .select(
            'c.id as company_id', 'b.id as branch_id',
            'c.business_name', 'c.domain_name', 'c.business_category',
            'b.banner_image', 'b.business_image',
        )
        .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }]);
    const seen = new Set();
    const rows = cos.filter((r) => { if (seen.has(r.company_id)) { return false; } seen.add(r.company_id); return true; });
    if (!rows.length) { return []; }

    const companyIds = rows.map((r) => r.company_id);
    const branchIds  = rows.map((r) => r.branch_id);

    // Batched active offers.
    const banners = await db('store_offer_banner_table')
        .whereIn('company_id', companyIds).andWhere('publish_online', 1)
        .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
        .orderBy('id', 'desc')
        .select('company_id', 'offer_title', 'offer_details', 'offer_terms');
    const coupons = await db('coupons')
        .whereIn('branch_id', branchIds).andWhere('is_active', 1).whereIn('platform', [1, 2])
        .andWhere((qb) => { qb.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
        .orderBy('id', 'desc')
        .select('branch_id', 'code', 'discount_type', 'discount_value', 'min_order_value', 'free_delivery');
    const discounts = await db('discounts')
        .whereIn('company_id', companyIds).andWhere('status', 1)
        .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
        .orderBy('id', 'desc')
        .select('company_id', 'discount_type', 'discount_value', 'min_order_value', 'max_discount', 'product_id');

    const pids = [...new Set(discounts.map((d) => d.product_id).filter(Boolean))];
    const pNames = {};
    if (pids.length) {
        (await db('products').whereIn('id', pids).select('id', 'name')).forEach((p) => { pNames[String(p.id)] = String(p.name || '').trim(); });
    }

    // Group offers by company / branch.
    const bByCo = {}, dByCo = {}, cByBr = {};
    banners.forEach((b) => {
        const t = String(b.offer_title || '').trim(); if (!t) { return; }
        (bByCo[b.company_id] = bByCo[b.company_id] || []).push({ title: t, details: String(b.offer_details || '').trim(), terms: String(b.offer_terms || '').trim() });
    });
    discounts.forEach((d) => {
        (dByCo[d.company_id] = dByCo[d.company_id] || []).push({
            type: Number(d.discount_type) || 1,
            value: d.discount_value != null ? Number(d.discount_value) : null,
            minOrder: d.min_order_value != null ? Number(d.min_order_value) : 0,
            maxDiscount: d.max_discount != null ? Number(d.max_discount) : null,
            product: d.product_id ? (pNames[String(d.product_id)] || null) : null,
        });
    });
    coupons.forEach((c) => {
        const code = String(c.code || '').trim(); if (!code) { return; }
        (cByBr[c.branch_id] = cByBr[c.branch_id] || []).push({
            code, type: Number(c.discount_type) || 1,
            value: c.discount_value != null ? Number(c.discount_value) : 0,
            minOrder: c.min_order_value != null ? Number(c.min_order_value) : 0,
            freeDelivery: Number(c.free_delivery) === 1,
        });
    });

    const out = [];
    rows.forEach((r) => {
        const bn = bByCo[r.company_id] || [];
        const dc = dByCo[r.company_id] || [];
        const cp = cByBr[r.branch_id] || [];
        const count = bn.length + dc.length + cp.length;
        if (!count) { return; }
        const name = String(r.business_name || '').trim();
        out.push({
            id:       String(r.company_id),
            slug:     r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
            name,
            cuisines: M.cuisinesFor({ business_category: r.business_category }),
            image:    M.yiiImageUrl('banner', r.company_id, r.banner_image) || M.yiiImageUrl('logo', r.company_id, r.business_image) || null,
            initial:  M.initialFor(name),
            tint:     M.tintFor(r.company_id),
            offers:   { banners: bn, coupons: cp, discounts: dc },
            count,
        });
    });
    return out;
}

/**
 * offerSummaries — for a set of (companyId, branchId) pairs, returns a
 * map companyId → { count, label } where count is the number of active
 * offers and label is a short representative one ("50% OFF" / "Free
 * delivery" / "£5 OFF" / "Offer"). Batched (3 queries). Used to enrich
 * the restaurant cards with an offer count + sample.
 * Type: READ.
 */
async function offerSummaries(pairs) {
    const result = {};
    if (!pairs || !pairs.length) { return result; }
    const companyIds = pairs.map((p) => p.companyId);
    const branchIds  = pairs.map((p) => p.branchId);
    const br2co = {};
    pairs.forEach((p) => { br2co[String(p.branchId)] = String(p.companyId); });

    const [banners, coupons, discounts] = await Promise.all([
        db('store_offer_banner_table').whereIn('company_id', companyIds).andWhere('publish_online', 1)
            .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date')).select('company_id'),
        db('coupons').whereIn('branch_id', branchIds).andWhere('is_active', 1).whereIn('platform', [1, 2])
            .andWhere((qb) => { qb.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
            .select('branch_id', 'discount_type', 'discount_value', 'free_delivery', 'for_item'),
        db('discounts').whereIn('company_id', companyIds).andWhere('status', 1)
            .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date')).select('company_id', 'discount_type', 'discount_value'),
    ]);

    // Per company we track BOTH the max and the min positive offer value, per
    // type. Max drives "X off or more"; min drives "up to X off" (a restaurant
    // qualifies for "up to 5" if it has ANY offer <= 5 — e.g. offers 1/2/5/50
    // still match "up to 5" via its min=1, even though its headline is 50).
    const acc = {};   // companyId → { count, pct, pctMin, amount, amountMin, freeDelivery, hasItem }
    function bump(co) { return (acc[co] = acc[co] || { count: 0, pct: 0, pctMin: 0, amount: 0, amountMin: 0, freeDelivery: false, hasItem: false }); }
    function addPct(e, val) { const v = Number(val) || 0; if (v > 0) { e.pct = Math.max(e.pct, v); e.pctMin = e.pctMin === 0 ? v : Math.min(e.pctMin, v); } }
    function addAmt(e, val) { const v = Number(val) || 0; if (v > 0) { e.amount = Math.max(e.amount, v); e.amountMin = e.amountMin === 0 ? v : Math.min(e.amountMin, v); } }
    banners.forEach((b) => { bump(String(b.company_id)).count += 1; });
    discounts.forEach((d) => {
        const e = bump(String(d.company_id)); e.count += 1;
        if (Number(d.discount_type) === 1) { addPct(e, d.discount_value); }
        else if (Number(d.discount_type) === 2) { addAmt(e, d.discount_value); }
        else if (Number(d.discount_type) === 3) { e.hasItem = true; }   // item / free-item deal
    });
    coupons.forEach((c) => {
        const co = br2co[String(c.branch_id)]; if (!co) { return; }
        const e = bump(co); e.count += 1;
        if (Number(c.free_delivery) === 1) { e.freeDelivery = true; }
        if (Number(c.for_item) === 1)       { e.hasItem = true; }       // item / free-item coupon
        if (Number(c.discount_type) === 1) { addPct(e, c.discount_value); }
        else if (Number(c.discount_type) === 2) { addAmt(e, c.discount_value); }
    });

    Object.keys(acc).forEach((co) => {
        const e = acc[co];
        let label = 'Offer';
        if (e.pct > 0) { label = Math.round(e.pct) + '% OFF'; }
        else if (e.freeDelivery) { label = 'Free delivery'; }
        else if (e.amount > 0) { label = '£' + Math.round(e.amount) + ' OFF'; }
        // pct/pctMin/amount/amountMin/freeDelivery/hasItem are exposed (additive
        // — existing callers read only .count/.label) so the offer-banner rules
        // can match restaurants by their live offer type/value. Max → "X or more",
        // min → "up to X" (has any offer <= X).
        result[co] = { count: e.count, label, pct: e.pct, pctMin: e.pctMin, amount: e.amount, amountMin: e.amountMin, freeDelivery: e.freeDelivery, hasItem: e.hasItem };
    });
    return result;
}

// "Valid till D MMM YYYY" — dates are stored as local-midnight timestamps
// (so they read as the previous day's 18:30 in UTC); nudge +12h so the
// intended calendar date shows.
function fmtValidTill(val) {
    return F.formatValidTill(val);
}
function round(n) { return Math.round(Number(n) || 0); }

/**
 * offersPageData — categorized offers for the dedicated Offers page,
 * mapped from REAL data:
 *   • restaurantOffers = promo codes (coupons)
 *   • productOffers    = product-level auto-discounts (discounts.product_id)
 *   • commonOffers     = order-level discounts (no product) + store banners
 * Batched. Currency assumed GBP (£). Type: READ.
 */
async function offersPageData() {
    const empty = { restaurantOffers: [], productOffers: [], commonOffers: [], total: 0 };
    const cos = await db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .where('c.is_marketplace', 1).whereNull('c.deleted_at').andWhere('b.status', '<>', '2')
        .select('c.id as company_id', 'b.id as branch_id', 'c.business_name', 'c.domain_name', 'b.banner_image', 'b.business_image')
        .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }]);
    const seen = new Set();
    const rows = cos.filter((r) => { if (seen.has(r.company_id)) { return false; } seen.add(r.company_id); return true; });
    if (!rows.length) { return empty; }

    const info = {}; const br2co = {};
    rows.forEach((r) => {
        const name = String(r.business_name || '').trim();
        info[String(r.company_id)] = {
            id: String(r.company_id), name,
            slug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
            image: M.yiiImageUrl('banner', r.company_id, r.banner_image) || M.yiiImageUrl('logo', r.company_id, r.business_image) || null,
            initial: M.initialFor(name), tint: M.tintFor(r.company_id),
        };
        br2co[String(r.branch_id)] = String(r.company_id);
    });
    const companyIds = rows.map((r) => r.company_id);
    const branchIds  = rows.map((r) => r.branch_id);

    const [coupons, discounts, banners] = await Promise.all([
        db('coupons').whereIn('branch_id', branchIds).andWhere('is_active', 1).whereIn('platform', [1, 2])
            .andWhere((qb) => { qb.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
            .orderBy('id', 'desc').select('branch_id', 'code', 'discount_type', 'discount_value', 'min_order_value', 'free_delivery', 'expiry_date'),
        db('discounts').whereIn('company_id', companyIds).andWhere('status', 1)
            .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
            .orderBy('id', 'desc').select('company_id', 'discount_type', 'discount_value', 'min_order_value', 'product_id', 'end_date'),
        db('store_offer_banner_table').whereIn('company_id', companyIds).andWhere('publish_online', 1)
            .andWhere((qb) => withinWindow(qb, 'start_date', 'end_date'))
            .orderBy('id', 'desc').select('company_id', 'offer_title', 'offer_details', 'end_date'),
    ]);

    const pids = [...new Set(discounts.map((d) => d.product_id).filter(Boolean))];
    const pn = {};
    if (pids.length) { (await db('products').whereIn('id', pids).select('id', 'name')).forEach((p) => { pn[String(p.id)] = String(p.name || '').trim(); }); }

    const moneyLabel = (type, val) => (Number(type) === 1 ? round(val) + '% OFF' : '£' + round(val) + ' OFF');

    const restaurantOffers = [];
    coupons.forEach((c) => {
        const r = info[br2co[String(c.branch_id)]]; if (!r) { return; }
        const code = String(c.code || '').trim(); if (!code) { return; }
        restaurantOffers.push({
            restaurant: r,
            label: moneyLabel(c.discount_type, c.discount_value),
            sub: c.min_order_value > 0 ? ('on orders above £' + round(c.min_order_value)) : (Number(c.free_delivery) === 1 ? 'Free delivery included' : 'on all orders'),
            code,
            freeDelivery: Number(c.free_delivery) === 1,
            validTill: fmtValidTill(c.expiry_date),
        });
    });

    const productOffers = [];
    const commonOffers = [];
    discounts.forEach((d) => {
        const r = info[String(d.company_id)]; if (!r) { return; }
        const label = Number(d.discount_type) === 3 ? 'Special deal' : moneyLabel(d.discount_type, d.discount_value);
        if (d.product_id) {
            productOffers.push({ restaurant: r, product: pn[String(d.product_id)] || 'Selected item', label, sub: 'on this item', validTill: fmtValidTill(d.end_date) });
        } else {
            commonOffers.push({ restaurant: r, label, sub: d.min_order_value > 0 ? ('on orders above £' + round(d.min_order_value)) : 'on all orders', code: null, validTill: fmtValidTill(d.end_date) });
        }
    });
    banners.forEach((b) => {
        const r = info[String(b.company_id)]; if (!r) { return; }
        const t = String(b.offer_title || '').trim(); if (!t) { return; }
        commonOffers.push({ restaurant: r, label: t, sub: String(b.offer_details || '').trim(), code: null, validTill: fmtValidTill(b.end_date), isBanner: true });
    });

    return {
        restaurantOffers,
        productOffers,
        commonOffers,
        total: restaurantOffers.length + productOffers.length + commonOffers.length,
    };
}

module.exports = {
    bannersForCompany,
    couponsForBranch,
    discountsForCompany,
    offersForRestaurant,
    offersFeed,
    groupedOffers,
    offerSummaries,
    offersPageData,
};
