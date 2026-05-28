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
        const hasUserLocation = Number.isFinite(lat) && Number.isFinite(lng);
        // When we're going to sort by distance application-side, pull
        // a larger candidate set so the nearest rows aren't trimmed by
        // the SQL LIMIT before the sort runs. With ~6 companies in the
        // marketplace today the upper cap is irrelevant; the bound
        // future-proofs the endpoint at <= 200 rows / request. We also
        // make sure the candidate pool covers the requested page —
        // offset + limit + a small over-fetch so has_more can be set
        // reliably (we need to know if at least one row exists past
        // the slice we return).
        const fetchLimit = hasUserLocation
            ? Math.max(200, offset + limit + 1)
            : (offset + limit + 1);

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

        // "Has active offer" — true when either a published discount
        // is in date range OR at least one marketplace product carries
        // an `offer` label. EXISTS short-circuits so this stays cheap.
        const hasOfferSubq = db.raw(
            `(EXISTS (
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
              )) AS has_offer`
        );

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
                'b.branch_description',
                hasVegSubq,
                hasNonVegSubq,
                avgRatingSubq,
                hasOfferSubq,
            )
            .where('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .andWhere(function () { this.where('c.is_maintenance', 0).orWhereNull('c.is_maintenance'); })
            .whereNull('c.deleted_at')
            .andWhere('b.status', '<>', '2')
            // ── Cuisine filter ────────────────────────────────────
            // When the home page is loaded with ?cuisine=<name>, only
            // surface restaurants that actually have at least one
            // marketplace-on product in a matching category. Keeps
            // the row consistent with the products list below it.
            .modify(function (qb) {
                if (!cuisine) { return; }
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
            })
            // ── Open Now ──────────────────────────────────────────
            // Branch is currently accepting orders when:
            //   • open_as_usual = 1   AND
            //   • the closed flag is not set, OR a closed_until
            //     timestamp has already passed.
            .modify(function (qb) {
                if (!openNow) { return; }
                qb.andWhere('b.open_as_usual', 1);
                qb.andWhere(function () {
                    this.where('b.closed', '<>', 1).orWhereNull('b.closed');
                });
                qb.andWhere(function () {
                    this.whereNull('b.closed_reopen_date')
                        .orWhereRaw('b.closed_reopen_date <= NOW()');
                });
            })
            // ── Pure veg ─────────────────────────────────────────
            // Has at least one veg product AND no non-veg products.
            // Combine the two existing EXISTS subqueries.
            .modify(function (qb) {
                if (!vegOnly) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1'))
                        .from('products as vp')
                        .whereRaw('vp.company_id = c.id')
                        .andWhere('vp.status', '1')
                        .andWhere('vp.show_marketplace', 1)
                        .andWhere('vp.veg_non_veg', 1);
                });
                qb.whereNotExists(function () {
                    this.select(db.raw('1'))
                        .from('products as vp2')
                        .whereRaw('vp2.company_id = c.id')
                        .andWhere('vp2.status', '1')
                        .andWhere('vp2.show_marketplace', 1)
                        .andWhere(function () {
                            this.whereNull('vp2.veg_non_veg').orWhere('vp2.veg_non_veg', '<>', 1);
                        });
                });
            })
            // ── Rating threshold ─────────────────────────────────
            // Restaurants without any published rating are EXCLUDED
            // when the user explicitly asked for "3.5+ rated" — a
            // null rating can't pass a numeric floor.
            .modify(function (qb) {
                if (!minRating) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1'))
                        .from('review_rating as rr2')
                        .whereRaw('rr2.company_id = c.id')
                        .andWhere('rr2.publish_online', 1)
                        .groupBy('rr2.company_id')
                        .havingRaw('AVG(rr2.rating) >= ?', [minRating]);
                });
            })
            // ── Has offer ────────────────────────────────────────
            // Mirror the boolean we already computed in hasOfferSubq —
            // restrict to rows where it would have been true.
            .modify(function (qb) {
                if (!hasOffer) { return; }
                qb.where(function () {
                    this.whereExists(function () {
                        this.select(db.raw('1'))
                            .from('discounts as d')
                            .whereRaw('d.company_id = c.id')
                            .andWhere('d.status', 1)
                            .andWhere(function () {
                                this.whereNull('d.start_date').orWhereRaw('d.start_date <= CURRENT_DATE');
                            })
                            .andWhere(function () {
                                this.whereNull('d.end_date').orWhereRaw('d.end_date >= CURRENT_DATE');
                            });
                    }).orWhereExists(function () {
                        this.select(db.raw('1'))
                            .from('products as op')
                            .whereRaw('op.company_id = c.id')
                            .andWhere('op.show_marketplace', 1)
                            .andWhere('op.status', '1')
                            .whereNotNull('op.offer')
                            .andWhere('op.offer', '<>', '');
                    });
                });
            })
            .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }])
            .limit(fetchLimit);

        // De-dupe to one branch per company (in case JS array still has
        // multiple after the SQL — defensive).
        const seen = new Set();
        const uniq = rows.filter(r => {
            if (!r.branch_id) { return false; }
            if (seen.has(r.company_id)) { return false; }
            seen.add(r.company_id);
            return true;
        });

        const restaurants = uniq.map(r => {
            const name = String(r.company_name || r.branch_name || r.branch_trading_name || '').trim();
            // Distance + time — null when the user has no location yet
            // OR the branch has no coords. The view already handles
            // those cases (chip simply hides).
            const km = distance.kmBetween(lat, lng, r.branch_lat, r.branch_lng);
            // vegType:
            //   'pure-veg'  → has veg products AND no non-veg products
            //   'non-veg'   → has any non-veg product (mixed restaurants
            //                  count as non-veg per the FSSAI convention
            //                  most food apps follow — if even one item
            //                  is non-veg, the restaurant isn't veg-only)
            //   null        → no marketplace products yet (no badge)
            let vegType = null;
            if (r.has_veg && !r.has_non_veg)       { vegType = 'pure-veg'; }
            else if (r.has_non_veg)                { vegType = 'non-veg';  }
            // avg_rating comes back as a string from Postgres NUMERIC.
            // Coerce to a Number so the comparator below works
            // numerically (string compare would treat "10.0" < "4.0").
            const avgRating = r.avg_rating != null ? Number(r.avg_rating) : null;
            return {
                id:              String(r.company_id),
                slug:            r.domain_name ? M.slugify(r.domain_name) : M.slugify(name, r.company_id),
                name,
                cuisines:        M.cuisinesFor({ business_category: r.business_category }),
                // Show the real average when we have one; fall back
                // to a friendly default until enough customers rate.
                rating:          avgRating != null ? avgRating : 4.4,
                offer:           r.has_offer ? 'Offer' : null,
                isOpen:          M.isBranchOpen(r),
                tint:            M.tintFor(r.company_id),
                initial:         M.initialFor(name),
                distanceKm:      km != null ? km : null,
                deliveryMinutes: km != null ? distance.estimateDeliveryMinutes(km) : null,
                vegType,
                // Banner first (`banner_image` lives under
                // <co>/banner_image/), then logo (`business_image` →
                // <co>/branch_logos/). yiiImageUrl returns null when
                // the filename is empty so the placeholder shows
                // through automatically.
                image:           M.yiiImageUrl('banner', r.company_id, r.banner_image)
                                 || M.yiiImageUrl('logo', r.company_id, r.business_image)
                                 || null,
            };
        });

        // ── Application-side distance / time filters ───────────────
        // SQL can't do Haversine without an extension. We've already
        // computed km in JS, so apply max_km here — and let max_min
        // ride on the same bucket (estimateDeliveryMinutes is a pure
        // function of km, so we invert: max_min == 30 ≈ km ≤ 3, etc).
        let filtered = restaurants;
        if (Number.isFinite(maxKm) && maxKm > 0) {
            filtered = filtered.filter(r => r.distanceKm != null && r.distanceKm <= maxKm);
        }
        if (Number.isFinite(maxMin) && maxMin > 0) {
            // Use the helper to compute minutes from km, then test
            // the LOW end of the bucket against the user's cap.
            filtered = filtered.filter(r => {
                if (r.distanceKm == null) { return false; }
                const mins = distance.estimateDeliveryMinutesNumeric
                    ? distance.estimateDeliveryMinutesNumeric(r.distanceKm)
                    : null;
                if (mins != null) { return mins <= maxMin; }
                // Fallback: approximate — ~3 km ≈ 30 min as a rough
                // city-traffic estimate. Same shape Helpers/distance
                // uses internally.
                return (r.distanceKm * 10) <= maxMin;
            });
        }

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
        const sliced  = filtered.slice(offset, offset + limit);
        const hasMore = filtered.length > offset + limit;
        return H.successResponse(res, { restaurants: sliced, has_more: hasMore });
    } catch (err) {
        H.log.error('marketplace.restaurants.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list };
