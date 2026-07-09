'use strict';

/*
 * Controllers/Marketplace/RestaurantsController.js
 *
 * What:  GET /api/v1/marketplace/restaurants — returns the list of
 *        marketplace-enabled companies (one row per company / branch
 *        pair) ready to be rendered as restaurant cards on the
 *        homepage.
 *
 *        Filters applied:
 *          • company.is_marketplace = 1
 *          • company.is_active      = 1
 *          • company.is_maintenance = 0   (skip companies in maintenance)
 *          • company.deleted_at IS NULL
 *          • branch row exists (we LEFT-JOIN but require at least one)
 *
 *        Returns the same shape the EJS view already consumes — no
 *        view changes needed. Distance + delivery-time estimates are
 *        derived in JS from the user's lat/lng (query params) vs the
 *        branch.direction_latitude/longitude columns.
 *
 * Why:   Single source of truth for "what's a marketplace restaurant"
 *        — both the home grid + the future /restaurants page hit this
 *        endpoint with different limits / filters.
 *
 * Used:  Wired in api/Routes/index.js as
 *           GET /api/v1/marketplace/restaurants?lat=&lng=&limit=
 *
 * Change log:
 *   2026-05-26 — initial; phase-1 marketplace dashboard.
 */

const H              = require('../../Helpers/helper');
const MSG            = require('../../Helpers/messages');
const { db }         = require('../../config/db');
const distance       = require('../../Helpers/distance');
const M              = require('../../Helpers/marketplace');
const A              = require('../../Helpers/availability');
const Offers         = require('../../Helpers/offers');
const OrderTime      = require('../../Helpers/orderTime');
const StoreHours     = require('../../Helpers/storeHours');
const Favourites     = require('../Customer/FavouriteController');

/**
 * resolveMpCategoryId
 *
 * What:  Maps a cuisine URL param (slug or normalised name, e.g.
 *        "italian" / "bubble-tea" / "bubble tea") to a marketplace
 *        category id in `mp_marketplace_category`. Comparison strips
 *        spaces + hyphens + case so any of those forms match.
 * Why:   The home cuisine pills now come from the global mp category
 *        master; tapping one filters restaurants by which companies
 *        are assigned to that mp category (mp_marketplace_category_assign).
 * Type:  READ. Returns the id or null when nothing matches.
 */
// Delivery-time buckets keyed by the sidebar's data-filter suffix.
// Each bound is on the numeric "centre" minutes from
// distance.estimateDeliveryMinutesNumeric. Lower bound is exclusive
// (except the first bucket, which starts at 0); upper is inclusive.
// '60' is the open-ended 45+ band.
const DELIVERY_BUCKETS = {
    '15': [0,  15],
    '30': [15, 30],
    '45': [30, 45],
    '60': [45, Infinity],
};

/**
 * deliveryMinsInBucket
 *
 * What:  True when a restaurant's centre-minutes estimate falls in the
 *        named bucket. Null minutes (no location / no coords) never
 *        match — a time filter can't apply without a distance.
 * Type:  READ (pure).
 */
function deliveryMinsInBucket(mins, key) {
    const b = DELIVERY_BUCKETS[key];
    if (!b || mins == null) { return false; }
    const lower = b[0] === 0 ? -Infinity : b[0];
    return mins > lower && mins <= b[1];
}

async function resolveMpCategoryId(cuisine) {
    if (!cuisine) { return null; }
    // Build a comparison key: lowercase, drop spaces + hyphens, then
    // strip ONE trailing plural ("es"/"s"). The home pill carries the
    // SINGULARISED searchName ("burger"), while the master stores the
    // display name/slug as a plural ("Burgers"/"burgers"); collapsing
    // both sides the same way makes them line up. Handles slug
    // ("bubble-tea") and spaced name ("Bubble Tea") forms too.
    const keyify = (s) => String(s || '').toLowerCase().replace(/[\s\-]+/g, '').replace(/(es|s)$/, '');
    const want = keyify(cuisine);
    if (!want) { return null; }
    const rows = await db('mp_marketplace_category')
        .where('status', 1)
        .select('id', 'name', 'slug');
    const hit = rows.find(r => keyify(r.slug) === want || keyify(r.name) === want);
    return hit ? hit.id : null;
}

/**
 * list
 *
 * What:  Fetches eligible (company, branch) pairs, then maps each one
 *        to the public view shape. When multiple branches exist for a
 *        single company we pick the FIRST (lowest branch.id) — the
 *        wtw_eatndeal companies all have exactly one branch today,
 *        but the SELECT DISTINCT ON guards us when that changes.
 * Type:  READ.
 *
 * Query params (already sanitised by validate middleware):
 *   lat?    — number, customer latitude   (used for distance)
 *   lng?    — number, customer longitude  (used for distance)
 *   limit?  — int 1..50 (default 24)
 *
 * Output: { restaurants: [ { id, slug, name, cuisines, rating, ... } ] }
 */
async function list(req, res) {
    try {
        const lat     = req.query.lat != null ? Number(req.query.lat) : null;
        const lng     = req.query.lng != null ? Number(req.query.lng) : null;
        const limit   = req.query.limit ? Math.min(50, Math.max(1, Number(req.query.limit))) : 24;
        const offset  = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
        const cuisine = req.query.cuisine ? String(req.query.cuisine).trim().toLowerCase() : null;
        const postcode = req.query.postcode ? String(req.query.postcode).trim() : null;
        // Resolve the cuisine to a global marketplace-category id so we
        // can filter by the company↔category assignment table.
        const mpCategoryId = await resolveMpCategoryId(cuisine);
        // ── Phase-2 filter params (all optional) ───────────────────
        // Each maps 1:1 onto the chip / radio in the filter sidebar
        // and bottom sheet. Joi already enforced the value range.
        const sort        = req.query.sort   ? String(req.query.sort)         : 'relevance';
        const minRating   = req.query.rating ? Number(req.query.rating)       : null;
        const maxKm       = req.query.max_km ? Number(req.query.max_km)       : null;
        const maxMin      = req.query.max_min? Number(req.query.max_min)      : null;
        const openNow     = String(req.query.open_now || '') === '1';
        const vegOnly     = String(req.query.veg      || '') === '1';
        const hasOffer    = String(req.query.offer    || '') === '1';
        // ── Offer-banner landing filters (arrive from an OFFER BANNER
        // click — see Marketplace/OfferBannerController.buildHref). Each
        // narrows the grid to the restaurants that match the banner's rule.
        //   min_discount — MIN_DISCOUNT: keep restaurants whose live max % ≥ n
        //   coupon       — COUPON_CODE:  keep restaurants owning that active code
        //   category     — CATEGORY:     keep restaurants in that mp category
        //   offer_banner — MANUAL_PICK:  keep the banner's hand-picked restaurants
        const minDiscount  = req.query.min_discount  ? Number(req.query.min_discount)  : null;   // pct >= n
        const uptoDiscount = req.query.upto_discount ? Number(req.query.upto_discount) : null;   // 0 < pct <= n
        const amountOff    = req.query.amount_off    ? Number(req.query.amount_off)    : null;   // £ amount >= n
        const uptoAmount   = req.query.upto_amount   ? Number(req.query.upto_amount)   : null;   // 0 < £ amount <= n
        const freeDelivery = String(req.query.free_delivery || '') === '1';                      // has free delivery
        const freeItem     = String(req.query.free_item     || '') === '1';                      // has item/free-item deal
        const coupon       = req.query.coupon       ? String(req.query.coupon).trim().toUpperCase() : null;
        const category     = req.query.category     ? Number(req.query.category)     : null;
        const offerBanner  = req.query.offer_banner ? Number(req.query.offer_banner) : null;
        // Price-for-one bucket (low ≤£6 / mid £6-12 / high >£12). A
        // restaurant matches when it has a live marketplace product in
        // that band — see the has_price_* flags below.
        const priceBucket = req.query.price ? String(req.query.price).toLowerCase() : null;
        // Delivery-time buckets — a comma list of bucket keys
        // ("15,30,45,60"). A restaurant matches if its time estimate
        // falls in ANY selected band (multi-select union). Replaces the
        // old single max_min cap; max_min is still honoured for the
        // mobile sheet which sends a single cap.
        const deliveryBuckets = String(req.query.delivery || '')
            .split(',').map(s => s.trim()).filter(s => DELIVERY_BUCKETS[s]);
        const hasUserLocation = Number.isFinite(lat) && Number.isFinite(lng);
        // We now apply the sidebar filters application-side (so we can
        // also compute dynamic facet counts over the UNfiltered set),
        // which means we need the full candidate set in one go. The set
        // is bounded (marketplace companies near the user) so a single
        // generous cap is safe and keeps the query a single round trip.
        const CANDIDATE_CAP = 2000;

        // SELECT DISTINCT ON company.id keeps one row per company even
        // if Yii ever inserts more than one branch for the same brand.
        // ORDER BY company.id then branch.id picks the lowest branch id
        // — a stable, deterministic choice.
        // INNER JOIN on branch — a company with no live branch can't
        // accept orders, so it shouldn't show on the homepage even
        // if it's flagged is_marketplace=1. Same reasoning for
        // branch.status: '2' = deleted in the Yii convention, so we
        // accept everything EXCEPT that.
        // Veg / non-veg breakdown per company. Two correlated EXISTS
        // subqueries — one for "has at least one veg product", one
        // for "has at least one non-veg product". Cheaper than
        // aggregating with COUNT because EXISTS short-circuits on
        // the first matching row. We restrict the check to live
        // marketplace-on products (the only ones a customer would
        // actually see) so a stale POS-only non-veg item can't flip
        // the restaurant's marketplace badge.
        const hasVegSubq = db.raw(
            `EXISTS (
                SELECT 1 FROM products vp
                WHERE vp.company_id = c.id
                  AND vp.status = '1'
                  AND vp.show_marketplace = 1
                  AND vp.veg_non_veg = 1
            ) AS has_veg`
        );
        const hasNonVegSubq = db.raw(
            `EXISTS (
                SELECT 1 FROM products vp
                WHERE vp.company_id = c.id
                  AND vp.status = '1'
                  AND vp.show_marketplace = 1
                  AND (vp.veg_non_veg IS NULL OR vp.veg_non_veg <> 1)
            ) AS has_non_veg`
        );

        // Average rating per company. Correlated subquery so we keep
        // the main query a single round trip. NULL when the company
        // has no published rating row yet (still appears in the list;
        // a rating filter excludes it).
        const avgRatingSubq = db.raw(
            `(SELECT ROUND(AVG(rr.rating)::numeric, 1)
                FROM review_rating rr
               WHERE rr.company_id = c.id
                 AND rr.publish_online = 1) AS avg_rating`
        );

        // "Has active offer" — true when the restaurant has ANY live
        // offer right now: a published store-offer banner, an active promo
        // coupon, a date-valid auto-discount, OR a product carrying an
        // `offer` label. EXISTS short-circuits so this stays cheap.
        const hasOfferSubq = db.raw(
            `(EXISTS (
                SELECT 1 FROM store_offer_banner_table sob
                 WHERE sob.company_id = c.id
                   AND sob.publish_online = 1
                   AND (sob.start_date IS NULL OR sob.start_date <= CURRENT_DATE)
                   AND (sob.end_date   IS NULL OR sob.end_date   >= CURRENT_DATE)
              ) OR EXISTS (
                SELECT 1 FROM coupons cp
                 WHERE cp.company_id = c.id
                   AND cp.is_active = 1
                   AND cp.platform IN (1, 2)
                   AND (cp.expiry_date IS NULL OR cp.expiry_date >= CURRENT_DATE)
              ) OR EXISTS (
                SELECT 1 FROM discounts d
                 WHERE d.company_id = c.id
                   AND d.status = 1
                   AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
                   AND (d.end_date   IS NULL OR d.end_date   >= CURRENT_DATE)
              ) OR EXISTS (
                SELECT 1 FROM products op
                 WHERE op.company_id = c.id
                   AND op.show_marketplace = 1
                   AND op.status = '1'
                   AND op.offer IS NOT NULL
                   AND op.offer <> ''
                   AND op.offer <> '0'
              )) AS has_offer`
        );

        // Price-bucket presence per company. Three correlated EXISTS
        // flags (≤£6 / £6-12 / >£12) over live marketplace products,
        // using the same COALESCE chain as Helpers/marketplace.pickPrice.
        // They drive BOTH the "Price for one" filter and its dynamic
        // facet counts.
        const priceExpr = 'COALESCE(pb.marketplace_price, pb.online_platform_price, pb.price_after_tax, 0)';
        const priceLowSubq  = db.raw(`EXISTS (SELECT 1 FROM products pb WHERE pb.company_id = c.id AND pb.show_marketplace = 1 AND pb.status = '1' AND ${priceExpr} > 0 AND ${priceExpr} <= 6) AS has_price_low`);
        const priceMidSubq  = db.raw(`EXISTS (SELECT 1 FROM products pb WHERE pb.company_id = c.id AND pb.show_marketplace = 1 AND pb.status = '1' AND ${priceExpr} > 6 AND ${priceExpr} <= 12) AS has_price_mid`);
        const priceHighSubq = db.raw(`EXISTS (SELECT 1 FROM products pb WHERE pb.company_id = c.id AND pb.show_marketplace = 1 AND pb.status = '1' AND ${priceExpr} > 12) AS has_price_high`);

        const rows = await db
            .from('company as c')
            .innerJoin('branch as b', 'b.company_id', 'c.id')
            .select(
                'c.id            as company_id',
                'c.business_name as company_name',
                'c.domain_name   as domain_name',
                'c.business_category',
                'c.is_active',
                'c.is_maintenance',
                'b.id            as branch_id',
                'b.name          as branch_name',
                'b.trading_name  as branch_trading_name',
                'b.banner_image  as banner_image',
                'b.business_image as business_image',
                'b.direction_latitude  as branch_lat',
                'b.direction_longitude as branch_lng',
                'b.direction_address   as branch_address',
                'b.city',
                'b.postcode',
                'b.closed_until',
                'b.open_as_usual',
                'b.start_time',
                'b.end_time',
                // Close-flag + per-service columns for the real open/closed
                // verdict (Helpers/storeHours), batched across the list.
                'b.closed', 'b.closed_reopen_date', 'b.clossed_repoen_time', 'b.clossed_text',
                'b.closed_for', 'b.closed_for_time',
                'b.show_delivery_option', 'b.show_delivery_option_tab', 'b.delivery_closed_util_date',
                'b.show_pickup_option', 'b.show_pickup_option_tab', 'b.pickup_closed_util_date',
                'b.delivery_waiting_time',
                'b.pickup_waiting_time',
                'b.branch_description',
                hasVegSubq,
                hasNonVegSubq,
                avgRatingSubq,
                hasOfferSubq,
                priceLowSubq,
                priceMidSubq,
                priceHighSubq,
            )
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            // ── Cuisine filter ────────────────────────────────────
            // Primary path: the cuisine resolved to a global
            // marketplace category → keep only companies ASSIGNED to
            // it in mp_marketplace_category_assign.
            // Fallback: the cuisine didn't match an mp category (e.g.
            // an old per-company name) → match companies that have a
            // marketplace product in a like-named per-company category.
            .modify(function (qb) {
                if (!cuisine) { return; }
                if (mpCategoryId) {
                    qb.whereExists(function () {
                        this.select(db.raw('1'))
                            .from('mp_marketplace_category_assign as mca')
                            .whereRaw('mca.company_id = c.id')
                            .andWhere('mca.category_id', mpCategoryId);
                    });
                } else {
                    qb.whereExists(function () {
                        this.select(db.raw('1'))
                            .from('categories as cat')
                            .innerJoin('product_product_category as ppc', 'ppc.category_id', 'cat.id')
                            .innerJoin('products as p2', 'p2.id', 'ppc.product_id')
                            .whereRaw('cat.company_id = c.id')
                            .andWhereRaw('LOWER(cat.name) LIKE ?', ['%' + cuisine + '%'])
                            .andWhere('ppc.status', '1')
                            .andWhere('p2.show_marketplace', 1)
                            .andWhere('p2.status', '1');
                    });
                }
            })
            // ── Offer-banner rule filters (SQL narrowing) ─────────
            // CATEGORY — restaurants assigned to that global mp category.
            .modify(function (qb) {
                if (!category) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1')).from('mp_marketplace_category_assign as mcat')
                        .whereRaw('mcat.company_id = c.id').andWhere('mcat.category_id', category);
                });
            })
            // COUPON_CODE — restaurants (branches) owning that active,
            // in-platform, non-expired coupon code.
            .modify(function (qb) {
                if (!coupon) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1')).from('coupons as cpf')
                        .whereRaw('cpf.branch_id = b.id')
                        .andWhereRaw('UPPER(cpf.code) = ?', [coupon])
                        .andWhere('cpf.is_active', 1).whereIn('cpf.platform', [1, 2])
                        .andWhere(function () {
                            this.whereNull('cpf.expiry_date').orWhere('cpf.expiry_date', '>=', db.raw('CURRENT_DATE'));
                        });
                });
            })
            // MANUAL_PICK — the exact restaurants the admin hand-picked
            // for this banner (mp_offer_banner_assign).
            .modify(function (qb) {
                if (!offerBanner) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1')).from('mp_offer_banner_assign as oba')
                        .whereRaw('oba.company_id = c.id').andWhere('oba.offer_banner_id', offerBanner);
                });
            })
            // NOTE: the sidebar filters (open-now / veg / rating /
            // offer / price / delivery-time / distance) are applied
            // application-side further down — NOT here — so we can also
            // compute dynamic facet counts over the unfiltered set.
            // Only the cuisine narrowing happens in SQL (above).
            .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }])
            .limit(CANDIDATE_CAP);

        // De-dupe to one branch per company (in case JS array still has
        // multiple after the SQL — defensive).
        const seen = new Set();
        const uniq = rows.filter(r => {
            if (!r.branch_id) { return false; }
            if (seen.has(r.company_id)) { return false; }
            seen.add(r.company_id);
            return true;
        });

        // ── Real delivery zones (store_delivery_charge_setup) ──────
        // When the customer gave a postcode, load each branch's
        // configured zones so we can resolve the REAL fee / min-order /
        // deliverability per restaurant (not a distance guess).
        const zonesByBranch = new Map();
        if (postcode && uniq.length) {
            const zoneRows = await db('store_delivery_charge_setup')
                .whereIn('branch_id', uniq.map(r => r.branch_id))
                .andWhere('status', 1)
                .select('branch_id', 'postcode', 'charge', 'minimum_order', 'free_delivery_above');
            zoneRows.forEach(z => {
                const k = String(z.branch_id);
                if (!zonesByBranch.has(k)) { zonesByBranch.set(k, []); }
                zonesByBranch.get(k).push(z);
            });
        }

        // Per-restaurant offer count + a representative label (for the
        // card badge: "50% OFF" + a count chip when there's more than one).
        const offerSums = await Offers.offerSummaries(uniq.map(r => ({ companyId: r.company_id, branchId: r.branch_id })));

        // Heart-icon state for the signed-in customer (single batched
        // lookup). Empty Set when no customer_id was supplied → every
        // card renders isFavourite=false and the view hides the icon.
        const customerId = req.query.customer_id ? String(req.query.customer_id) : null;
        const favSet = await Favourites.favouriteIdSet(customerId, uniq.map(r => r.company_id));

        // Single batched call → per-branch formatted delivery+pickup
        // labels ("20-50 min" / null). One source of truth for the time
        // chip across list/detail/favourites/dishes.
        const timesByBranch = await OrderTime.computeForBranches(uniq);

        // Real open/closed + hours for every card in ONE batched pass
        // (store_business_hours per service + close-flag precedence).
        const availByBranch = await StoreHours.availabilityForBranches(uniq);

        const restaurants = uniq.map(r => {
            // Postcode-zone delivery facts (matched application-side).
            const zones = zonesByBranch.get(String(r.branch_id)) || [];
            const zone  = postcode ? M.matchDeliveryZone(postcode, zones) : null;
            // Shared card mapper (rating, distance, image, vegType, lat/lng,
            // zone fields, etc. — single source of truth across surfaces).
            const summary = offerSums[String(r.company_id)] || {};
            const card = M.toRestaurantCard(r, {
                lat, lng,
                times:       timesByBranch[String(r.branch_id)],
                isFavourite: favSet.has(String(r.company_id)),
                offer:       summary.label || (r.has_offer ? 'Offer' : null),
                offerCount:  summary.count || (r.has_offer ? 1 : 0),
                postcode,
                zone,
            });
            // Override the card's open/closed with the real per-service
            // verdict (store_business_hours), so cards + the open_now facet
            // match the detail page.
            const av = availByBranch.get(String(r.branch_id));
            if (av) {
                card.isOpen     = av.isOpen;
                card.openStatus = av.status;
                card.hours      = av.hours;
                card.opensAt    = av.reopenAt;
            }
            // Append internal sort/facet keys (stripped before the
            // response slice — see _-prefix strip below).
            card._mins      = card.distanceKm != null ? distance.estimateDeliveryMinutesNumeric(card.distanceKm) : null;
            card._priceLow  = !!r.has_price_low;
            card._priceMid  = !!r.has_price_mid;
            card._priceHigh = !!r.has_price_high;
            // Fulfilment modes the restaurant OFFERS (config-level) — drives the
            // header Pickup/Delivery filter below. Stripped before the response.
            const _off = StoreHours.offeredServices(r);
            card._offersDelivery = _off.delivery;
            card._offersPickup   = _off.pickup;
            // Live offer facets (from offers.js offerSummaries) — used by the
            // offer-banner landing filters below. All stripped before response.
            card._offerPct          = Number(summary.pct) || 0;         // max % (for "X% or more")
            card._offerPctMin       = Number(summary.pctMin) || 0;      // min % (for "up to X%")
            card._offerAmount       = Number(summary.amount) || 0;      // max £ (for "£X or more")
            card._offerAmountMin    = Number(summary.amountMin) || 0;   // min £ (for "up to £X")
            card._offerFreeDelivery = !!summary.freeDelivery;
            card._offerHasItem      = !!summary.hasItem;
            return card;
        });

        // ── Dynamic facet counts ───────────────────────────────────
        // Counts are computed over the FULL candidate set (cuisine +
        // location applied, but BEFORE the sidebar filters) so each
        // badge stays stable regardless of what's currently ticked —
        // it answers "how many restaurants match THIS option", which is
        // what the sidebar numbers should show.
        const facets = {
            total:    restaurants.length,
            delivery: { '15': 0, '30': 0, '45': 0, '60': 0 },
            price:    { low: 0, mid: 0, high: 0 },
            rating:   { '4.5': 0, '4.0': 0, '3.5': 0, '3.0': 0 },
            veg: 0, open_now: 0, offer: 0,
        };
        restaurants.forEach(r => {
            ['15', '30', '45', '60'].forEach(k => { if (deliveryMinsInBucket(r._mins, k)) { facets.delivery[k]++; } });
            if (r._priceLow)  { facets.price.low++;  }
            if (r._priceMid)  { facets.price.mid++;  }
            if (r._priceHigh) { facets.price.high++; }
            ['4.5', '4.0', '3.5', '3.0'].forEach(t => { if (r.rating >= Number(t)) { facets.rating[t]++; } });
            if (r.vegType === 'pure-veg') { facets.veg++; }
            if (r.isOpen)                 { facets.open_now++; }
            if (r.offer)                  { facets.offer++; }
        });

        // ── Apply the active sidebar filters (application-side) ─────
        // All computed from the same values shown on the card, so a
        // restaurant the user sees rated 4.4 really does pass "4.0+",
        // and a "15-30 min" pick really keeps only that band.
        let filtered = restaurants;
        if (Number.isFinite(maxKm) && maxKm > 0) {
            filtered = filtered.filter(r => r.distanceKm != null && r.distanceKm <= maxKm);
        }
        if (deliveryBuckets.length) {
            filtered = filtered.filter(r => deliveryBuckets.some(k => deliveryMinsInBucket(r._mins, k)));
        } else if (Number.isFinite(maxMin) && maxMin > 0) {
            // Legacy single-cap (mobile sheet) — keep ≤ cap.
            filtered = filtered.filter(r => r._mins != null && r._mins <= maxMin);
        }
        if (openNow)   { filtered = filtered.filter(r => r.isOpen); }
        if (vegOnly)   { filtered = filtered.filter(r => r.vegType === 'pure-veg'); }
        if (hasOffer)  { filtered = filtered.filter(r => !!r.offer); }
        // ── Fulfilment mode (header Pickup/Delivery toggle) ────────
        // Keep only restaurants that OFFER the chosen mode. Config-level so a
        // pickup restaurant that's shut right now still appears under Pickup
        // (just marked Closed); only a restaurant that DOESN'T do the mode at
        // all is dropped. Applies on every surface that hits this endpoint
        // (home, ?view=restaurants, pickup, offer/collection landings).
        const modeParam = String(req.query.mode || '').toLowerCase();
        if (modeParam === 'pickup')        { filtered = filtered.filter(r => r._offersPickup); }
        else if (modeParam === 'delivery') { filtered = filtered.filter(r => r._offersDelivery); }
        // ── Offer-banner landing filters (match the live offer facets) ──
        // MIN_DISCOUNT — max % >= threshold ("X% off or more").
        if (Number.isFinite(minDiscount) && minDiscount > 0) {
            filtered = filtered.filter(r => (r._offerPct || 0) >= minDiscount);
        }
        // UPTO_DISCOUNT — restaurant has ANY % offer 0 < v <= threshold. Uses the
        // MIN % (a restaurant with 1/2/5/40% still matches "up to 5" via min=1).
        if (Number.isFinite(uptoDiscount) && uptoDiscount > 0) {
            filtered = filtered.filter(r => (r._offerPctMin || 0) > 0 && (r._offerPctMin || 0) <= uptoDiscount);
        }
        // AMOUNT_OFF — max £ amount off >= threshold ("£X off or more").
        if (Number.isFinite(amountOff) && amountOff > 0) {
            filtered = filtered.filter(r => (r._offerAmount || 0) >= amountOff);
        }
        // UPTO_AMOUNT — restaurant has ANY £ offer 0 < v <= threshold. Uses the
        // MIN £ (a restaurant with £1/2/5/50 still matches "up to £5" via min=1).
        if (Number.isFinite(uptoAmount) && uptoAmount > 0) {
            filtered = filtered.filter(r => (r._offerAmountMin || 0) > 0 && (r._offerAmountMin || 0) <= uptoAmount);
        }
        // FREE_DELIVERY / FREE_ITEM — has that offer type.
        if (freeDelivery) { filtered = filtered.filter(r => r._offerFreeDelivery); }
        if (freeItem)     { filtered = filtered.filter(r => r._offerHasItem); }
        if (minRating) { filtered = filtered.filter(r => r.rating >= minRating); }
        if (priceBucket === 'low')  { filtered = filtered.filter(r => r._priceLow); }
        if (priceBucket === 'mid')  { filtered = filtered.filter(r => r._priceMid); }
        if (priceBucket === 'high') { filtered = filtered.filter(r => r._priceHigh); }

        // ── Sort ──────────────────────────────────────────────────
        // Default ('relevance' / unset) keeps the existing nearest-
        // first ordering when we have a user location, else stable
        // by id.
        const byDistance = (a, b) => {
            const da = a.distanceKm == null ? Infinity : a.distanceKm;
            const db = b.distanceKm == null ? Infinity : b.distanceKm;
            if (da !== db) { return da - db; }
            return Number(a.id) - Number(b.id);
        };
        const byRatingDesc = (a, b) => {
            const ra = a.rating || 0;
            const rb = b.rating || 0;
            if (rb !== ra) { return rb - ra; }
            return byDistance(a, b);
        };
        if (sort === 'rating') {
            filtered.sort(byRatingDesc);
        } else if (sort === 'time' || sort === 'distance') {
            filtered.sort(byDistance);
        } else if (hasUserLocation) {
            filtered.sort(byDistance);
        }

        // Pagination slice [offset, offset+limit). has_more says
        // whether at least one row exists beyond this slice — the
        // home page renders the "See more" button only when true.
        // Strip the internal _-prefixed fields so the public card shape
        // stays clean.
        const sliced = filtered.slice(offset, offset + limit).map(r => {
            const { _mins, _priceLow, _priceMid, _priceHigh, _offerPct, _offerPctMin, _offerAmount, _offerAmountMin, _offerFreeDelivery, _offerHasItem, _offersDelivery, _offersPickup, ...view } = r;
            return view;
        });
        const hasMore = filtered.length > offset + limit;
        return H.successResponse(res, { restaurants: sliced, has_more: hasMore, facets });
    } catch (err) {
        H.log.error('marketplace.restaurants.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * fmtClock
 *
 * What:  "11:00:00" / "23:00" → "11:00 AM" / "11:00 PM" for the
 *        restaurant's opening-hours label. Returns null when the input
 *        has no parseable HH:MM.
 * Type:  READ (pure).
 */
function fmtClock(t) {
    if (!t) { return null; }
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) { return null; }
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ap = h >= 12 ? 'PM' : 'AM';
    let h12 = h % 12; if (h12 === 0) { h12 = 12; }
    return h12 + ':' + min + ' ' + ap;
}

/**
 * detail
 *
 * What:  Full single-restaurant payload for the restaurant page:
 *          { restaurant, categories, sections }
 *        • restaurant — header/info (name, rating, cuisines, address,
 *          phone, website, hours, open-now, distance, delivery-time,
 *          banner, logo, coords).
 *        • categories — the company's menu categories that actually
 *          hold marketplace products (left-rail menu), Featured first.
 *        • sections  — products grouped per category (+ a Featured
 *          Items section built from is_featured products), each ready
 *          to render as a card row.
 * Type:  READ.
 *
 * Query (validated): id? | slug?, lat?, lng?.
 */
async function detail(req, res) {
    try {
        const lat   = req.query.lat != null ? Number(req.query.lat) : null;
        const lng   = req.query.lng != null ? Number(req.query.lng) : null;
        const postcode = req.query.postcode ? String(req.query.postcode).trim() : null;
        const idArg = req.query.id ? Math.max(0, Number(req.query.id)) || null : null;
        const slug  = req.query.slug ? String(req.query.slug).trim().toLowerCase() : null;

        // ── Resolve the company id ─────────────────────────────────
        let companyId = idArg;
        if (!companyId && slug) {
            const candidates = await db('company as c')
                .modify(M.eligibleCompanyScope, 'c')
                .select('c.id', 'c.business_name', 'c.domain_name');
            const hit = candidates.find(c => {
                const s = c.domain_name ? M.slugify(c.domain_name) : M.slugify(c.business_name, c.id);
                return s === slug;
            });
            companyId = hit ? hit.id : null;
        }
        if (!companyId) { return H.errorResponse(res, 'Restaurant not found.', 404); }

        // ── Restaurant + primary branch ────────────────────────────
        const row = await db('company as c')
            .innerJoin('branch as b', 'b.company_id', 'c.id')
            .where('c.id', companyId)
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope,  'b')
            .select(
                'c.id as company_id', 'b.id as branch_id', 'c.business_name', 'c.domain_name', 'c.business_category',
                'b.direction_address', 'b.address_1', 'b.address_2', 'b.city', 'b.postcode',
                'b.contact_number', 'b.website', 'b.website_domain',
                'b.start_time', 'b.end_time', 'b.delivery_waiting_time', 'b.pickup_waiting_time',
                'b.banner_image', 'b.business_image',
                'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
                'b.open_as_usual', 'b.closed_until', 'b.name as branch_name',
                // Close-flag + per-service columns — drive the real
                // open/closed verdict (Helpers/storeHours), per legacy POS.
                'b.closed', 'b.closed_reopen_date', 'b.clossed_repoen_time', 'b.clossed_text',
                'b.closed_for', 'b.closed_for_time',
                'b.show_delivery_option', 'b.show_delivery_option_tab', 'b.delivery_closed_util_date',
                'b.show_pickup_option', 'b.show_pickup_option_tab', 'b.pickup_closed_util_date',
                'b.pre_order',
                // Surprise box ("Too Good To Go") — branch-level discounted box.
                'b.is_toogoodtogo_product', 'b.price', 'b.discount_price', 'b.qty',
                'b.about_surprise_box', 'b.saving_product_description',
                db.raw(`(SELECT ROUND(AVG(rr.rating)::numeric, 1) FROM review_rating rr
                          WHERE rr.company_id = c.id AND rr.publish_online = 1) AS avg_rating`),
                db.raw(`(SELECT COUNT(*) FROM review_rating rr
                          WHERE rr.company_id = c.id AND rr.publish_online = 1) AS rating_count`),
            )
            .orderBy('b.id', 'asc')
            .first();

        if (!row) { return H.errorResponse(res, 'Restaurant not found.', 404); }

        const name = String(row.business_name || '').trim();
        const km = distance.kmBetween(lat, lng, row.branch_lat, row.branch_lng);
        const avgRating = row.avg_rating != null ? Number(row.avg_rating) : null;
        const addr = [
            row.direction_address || [row.address_1, row.address_2].filter(Boolean).join(', '),
            row.city, row.postcode,
        ].filter(Boolean).join(', ');
        const open = fmtClock(row.start_time);
        const close = fmtClock(row.end_time);

        // Real delivery info — match the customer postcode to a zone.
        let zone = null;
        if (postcode) {
            const zoneRows = await db('store_delivery_charge_setup')
                .where('company_id', companyId).andWhere('status', 1)
                .select('postcode', 'charge', 'minimum_order', 'free_delivery_above');
            zone = M.matchDeliveryZone(postcode, zoneRows);
        }
        // Single source of truth for delivery + pickup labels.
        const detailTimes = (await OrderTime.computeForBranches([row]))[String(row.branch_id)]
                            || { delivery: null, pickup: null };

        // Heart-icon state for the signed-in customer (single row lookup).
        const detailCustomerId = req.query.customer_id ? String(req.query.customer_id) : null;
        const detailFavSet = await Favourites.favouriteIdSet(detailCustomerId, [row.company_id]);

        // Real open/closed + hours from store_business_hours (per service) +
        // the close-flag precedence — replaces the stale start_time/end_time.
        const avail = await StoreHours.availabilityForBranch(row);
        // Full Mon→Sun opening-hours table for the Restaurant Info popup.
        const weekHours = await StoreHours.weekHoursForBranch(row);

        const restaurant = {
            id:              String(row.company_id),
            slug:            row.domain_name ? M.slugify(row.domain_name) : M.slugify(name, row.company_id),
            name,
            branchId:        String(row.branch_id),
            isFavourite:     detailFavSet.has(String(row.company_id)),
            cuisines:        M.cuisinesFor({ business_category: row.business_category }),
            rating:          avgRating,   // null when no published reviews — UI hides the badge
            ratingCount:     row.rating_count != null ? Number(row.rating_count) : 0,
            isOpen:          avail ? avail.isOpen : M.isOpenNow(row),
            // Availability detail (per legacy POS) for the "Restaurant info"
            // chip: status (open/preorder/closed), per-service, why-closed.
            openStatus:      avail ? avail.status : null,
            deliveryOpen:    avail ? (avail.services.delivery.status === 'open') : null,
            pickupOpen:      avail ? (avail.services.takeaway.status === 'open') : null,
            // Config-level: does this restaurant OFFER each mode at all (used to
            // hide the Delivery/Pickup tab + the "doesn't deliver" warning for a
            // single-mode restaurant, and to pick the default fulfilment tab).
            offersDelivery:  StoreHours.offeredServices(row).delivery,
            offersPickup:    StoreHours.offeredServices(row).pickup,
            closedReason:    avail ? avail.closedReason : null,
            closedMessage:   avail ? avail.message : null,
            opensAt:         avail ? avail.reopenAt : null,
            preOrder:        Number(row.pre_order) === 1,
            distanceKm:      km != null ? km : null,
            deliveryMinutes: detailTimes.delivery,
            // Pickup time = pickup_waiting_time + max pickup advance.
            // No distance guess — matches legacy webordering exactly.
            pickupMinutes:   detailTimes.pickup,
            deliverable:      postcode ? !!zone : true,
            deliveryFee:      zone ? Number(zone.charge) : null,
            minOrder:         zone ? Number(zone.minimum_order) : null,
            freeDeliveryOver: zone ? Number(zone.free_delivery_above) : null,
            address:         addr,
            phone:           row.contact_number || null,
            website:         row.website || row.website_domain || null,
            hours:           avail && avail.hours ? avail.hours : ((open && close) ? (open + ' – ' + close) : null),
            weekHours,       // [{dow,day,short,isToday,pickup,delivery}] for the info popup

            lat:             row.branch_lat != null && row.branch_lat !== '' ? Number(row.branch_lat) : null,
            lng:             row.branch_lng != null && row.branch_lng !== '' ? Number(row.branch_lng) : null,
            image:           M.yiiImageUrl('banner', row.company_id, row.banner_image) || null,
            logo:            M.yiiImageUrl('logo', row.company_id, row.business_image) || null,
            tint:            M.tintFor(row.company_id),
            initial:         M.initialFor(name),
            // Surprise box ("Too Good To Go"): a discounted mystery box this
            // branch offers — shown at the top of the detail page when enabled.
            surpriseBox:     Number(row.is_toogoodtogo_product) === 1 ? {
                price:         Number(row.price) || 0,
                discountPrice: Number(row.discount_price) || 0,
                qty:           Number(row.qty) || 0,
                description:   String(row.saving_product_description || '').trim(),
                about:         String(row.about_surprise_box || '').trim(),
                pickupFrom:    open || '',
                pickupTo:      close || '',
            } : null,
        };

        // ── Menu categories ────────────────────────────────────────
        // Map every displayable category id → its name. The live data
        // has duplicate category rows per name (one per branch), so we
        // group sections by NORMALISED NAME below to avoid repeats.
        const catRows = await db('categories as cat')
            .where('cat.company_id', companyId)
            .andWhere('cat.status', '1')
            .andWhere(function () { this.where('cat.is_display_application_menu', 1).orWhereNull('cat.is_display_application_menu'); })
            .select('cat.id', 'cat.name', 'cat.is_featured');
        const catById = new Map();
        catRows.forEach(c => {
            catById.set(String(c.id), {
                name: String(c.name || '').trim(),
                key:  M.normaliseName(c.name),
                feat: Number(c.is_featured) === 1,
            });
        });

        // ── Products for the company, tagged with their category ────
        const prodRows = await db('products as p')
            .innerJoin('product_product_category as ppc', 'ppc.product_id', 'p.id')
            .leftJoin(
                db('product_image')
                    .select('product_id', db.raw(`(
                        SELECT url FROM product_image pi2
                        WHERE pi2.product_id = product_image.product_id AND pi2.status = '1'
                        ORDER BY pi2.is_primary DESC, pi2.id ASC LIMIT 1) AS url`))
                    .where('status', '1').groupBy('product_id').as('pi'),
                'pi.product_id', 'p.id',
            )
            .where('p.company_id', companyId)
            .andWhere('p.show_marketplace', 1)
            // Restaurant menu surface: show Available + the temporary
            // states (Sold out / Unavailable today / Unavailable until)
            // greyed with a badge; plain Unavailable ('0') + Deleted ('2')
            // stay hidden. Availability is status-driven (no stock).
            .whereIn('p.status', A.SURFACE_STATUSES)
            .andWhere('ppc.status', '1')
            .orderBy([{ column: 'p.is_featured', order: 'desc' }, { column: 'p.is_recommended', order: 'desc' }, { column: 'p.id', order: 'asc' }])
            .select(
                'p.id as product_id', 'p.name as product_name', 'p.veg_non_veg',
                'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax',
                'p.discount_type', 'p.discount_value',
                'p.is_recommended', 'p.is_featured', 'ppc.category_id', 'pi.url as image_url',
                ...A.selectColumns(db, 'p'),
            );

        // BOGOF map for the whole menu (one pass) → "Buy X Get Y" badges.
        const bogoMap = await require('../../Helpers/loyalty').bogoMapFor(companyId);

        const mapProd = (r) => {
            const avail = A.evaluate(r);
            const disc  = M.discountedPrice(r);
            const bogo  = bogoMap.get(String(r.product_id)) || null;
            return {
                bogo:          bogo,   // { buyQty, getQty } | null
                id:            String(r.product_id),
                name:          String(r.product_name || '').trim(),
                slug:          M.slugify(r.product_name),
                price:         disc.final,
                // Original (struck-through) price shown only when discounted.
                originalPrice: disc.hasDiscount ? disc.original : null,
                // Products have no per-dish reviews, so no real rating — null
                // hides the badge (we don't show the restaurant's avg as a
                // fake per-product rating).
                rating:        null,
                veg:           M.isVegProduct(r),
                isFeatured:    Number(r.is_featured) === 1,
                isRecommended: Number(r.is_recommended) === 1,
                // Availability — status-driven (no stock). Full verdict +
                // convenience boolean for the menu card / Add button.
                availability:  avail,
                available:     avail.available,
                image:         M.yiiImageUrl('product', companyId, r.image_url) || null,
                tint:          M.tintFor(r.product_id),
                initial:       M.initialFor(r.product_name),
            };
        };

        // Group products by NORMALISED category name (merging duplicate
        // category rows) + a Featured set from is_featured products.
        const groups = new Map();   // key → { name, feat, seen:Set, products:[] }
        const featured = [];
        const seenFeat = new Set();
        for (const r of prodRows) {
            const pid = String(r.product_id);
            if (Number(r.is_featured) === 1 && !seenFeat.has(pid)) { seenFeat.add(pid); featured.push(mapProd(r)); }
            const cat = catById.get(String(r.category_id));
            if (!cat || !cat.key) { continue; }     // not a displayable menu category
            if (!groups.has(cat.key)) { groups.set(cat.key, { name: cat.name, feat: cat.feat, seen: new Set(), products: [] }); }
            const g = groups.get(cat.key);
            if (cat.feat) { g.feat = true; }
            if (!g.seen.has(pid)) { g.seen.add(pid); g.products.push(mapProd(r)); }
        }

        // Featured categories first, then alphabetical.
        const ordered = Array.from(groups.values())
            .filter(g => g.products.length)
            .sort((a, b) => (b.feat ? 1 : 0) - (a.feat ? 1 : 0) || a.name.localeCompare(b.name));

        const sections = [];
        const menu = [];
        if (featured.length) {
            const featProds = featured.slice(0, 12);
            sections.push({ id: 'featured', slug: 'featured', name: 'Featured Items', featured: true, products: featProds });
            menu.push({ id: 'featured', name: 'Featured Items', featured: true, count: featProds.length });
        }
        ordered.forEach((g, i) => {
            const id = 'cat-' + i;
            sections.push({ id: id, slug: M.slugify(g.name), name: g.name, featured: false, products: g.products });
            menu.push({ id: id, name: g.name, featured: g.feat, count: g.products.length });
        });

        // Active offers for this restaurant (banners + promo codes +
        // auto-discounts) — shown as a strip on the detail page.
        const offers = await Offers.offersForRestaurant(companyId, row.branch_id);

        return H.successResponse(res, { restaurant, categories: menu, sections, offers });
    } catch (err) {
        H.log.error('marketplace.restaurants.detail', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * offers
 *
 * What:  Active store-offer banners across all marketplace restaurants —
 *        powers the home "Best offers for you" rail. Read-only.
 * Type:  READ.
 * Inputs: req.query.limit (optional, 1–20; default 8)
 * Output: 200 envelope, data = { offers: [ { id, title, details, terms, restaurant } ] }
 */
async function offers(req, res) {
    try {
        // page=1 → categorized data for the dedicated Offers page
        // (restaurant / product / common). grouped=1 → per-restaurant.
        // Otherwise the home rail feed of banners.
        if (req.query.page === '1') {
            const data = await Offers.offersPageData();
            return H.successResponse(res, data);
        }
        if (req.query.grouped === '1') {
            const restaurants = await Offers.groupedOffers();
            return H.successResponse(res, { restaurants });
        }
        const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
        const list = await Offers.offersFeed(limit);
        return H.successResponse(res, { offers: list });
    } catch (err) {
        H.log.error('marketplace.offers', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, detail, offers };
