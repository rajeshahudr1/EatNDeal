'use strict';

/*
 * Controllers/Marketplace/ProductsController.js
 *
 * What:  GET /api/v1/marketplace/products — list of dishes that
 *        surface on the home "For you" rail.
 *
 *        Filters applied:
 *          • products.show_marketplace = 1
 *          • products.status           = '1'   (active)
 *          • company.is_marketplace    = 1
 *          • company.is_active         = 1
 *          • company.is_maintenance    = 0 / null
 *          • company.deleted_at IS NULL
 *
 *        Each row is joined with its company + first branch so we can
 *        surface the restaurant name + slug + lat/lng (for distance +
 *        delivery-time estimate).
 *
 * Used:  Wired in api/Routes/index.js as
 *           GET /api/v1/marketplace/products?lat=&lng=&limit=
 */

const H        = require('../../Helpers/helper');
const MSG      = require('../../Helpers/messages');
const { db }   = require('../../config/db');
const distance = require('../../Helpers/distance');
const M        = require('../../Helpers/marketplace');

/**
 * list
 *
 * What:  Returns the "For you" product rail. Price uses the chain in
 *        Helpers/marketplace.pickPrice so the dashboard never shows a
 *        £0.00 dish when the merchant hasn't set a marketplace_price.
 * Type:  READ.
 *
 * Query params (sanitised by middleware):
 *   lat?, lng? — customer lat/lng (used for time estimate)
 *   limit?     — int 1..50 (default 12)
 *
 * Output: { products: [ { id, name, priceFrom, rating, deliveryMinutes,
 *                         restaurant, restaurantSlug, veg, tint, initial } ] }
 */
async function list(req, res) {
    try {
        const lat     = req.query.lat != null ? Number(req.query.lat) : null;
        const lng     = req.query.lng != null ? Number(req.query.lng) : null;
        const limit   = req.query.limit ? Math.min(50, Math.max(1, Number(req.query.limit))) : 12;
        const offset  = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
        const cuisine = req.query.cuisine ? String(req.query.cuisine).trim().toLowerCase() : null;
        // Restaurant filter — limits the results to a single
        // company. Accepts an integer company id. The web side
        // resolves slug → id before calling this endpoint.
        const restaurantId = req.query.restaurant
            ? Math.max(0, Number(req.query.restaurant)) || null
            : null;
        const hasUserLocation = Number.isFinite(lat) && Number.isFinite(lng);
        // Same nearest-first strategy as the restaurants endpoint —
        // pull a larger candidate set when we're sorting by distance
        // so SQL's LIMIT doesn't strip the closest rows. We also
        // ensure the pool covers the requested page (offset + limit)
        // plus one extra row so has_more can be set reliably.
        const fetchLimit = hasUserLocation
            ? Math.max(200, offset + limit + 1)
            : (offset + limit + 1);

        // Single JOIN: product → company → first NOT-DELETED branch.
        // The branch sub-select keeps the JOIN to one row per company
        // so the product list isn't multiplied by branch count. The
        // status filter inside the sub-select means a deleted branch
        // never sneaks in as the "primary" branch for the company.
        const rows = await db
            .from('products as p')
            .innerJoin('company as c', 'c.id', 'p.company_id')
            .leftJoin(
                db('branch')
                    .select('company_id', db.raw('MIN(id) AS branch_id'))
                    .whereNot('status', '2')
                    .groupBy('company_id')
                    .as('bm'),
                'bm.company_id', 'c.id',
            )
            .leftJoin('branch as b', 'b.id', 'bm.branch_id')
            // Best image per product:
            //   prefer is_primary=1 → else lowest id → else none.
            // We pick MIN(id) FILTERed by is_primary first then fall
            // back to a separate MIN(id) sub-select so primary always
            // wins. status='1' filters out soft-deleted image rows.
            .leftJoin(
                db('product_image')
                    .select(
                        'product_id',
                        db.raw(`(
                            SELECT url FROM product_image pi2
                            WHERE pi2.product_id = product_image.product_id
                              AND pi2.status = '1'
                            ORDER BY pi2.is_primary DESC, pi2.id ASC
                            LIMIT 1
                        ) AS url`),
                    )
                    .where('status', '1')
                    .groupBy('product_id')
                    .as('pi'),
                'pi.product_id', 'p.id',
            )
            .select(
                'p.id                  as product_id',
                'p.name                as product_name',
                'p.veg_non_veg',
                'p.marketplace_price',
                'p.online_platform_price',
                'p.price_after_tax',
                'p.is_recommended',
                'p.is_featured',
                'c.id                  as company_id',
                'c.business_name       as company_name',
                'c.domain_name         as company_domain',
                'b.direction_latitude  as branch_lat',
                'b.direction_longitude as branch_lng',
                'pi.url                as image_url',
            )
            .where('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .andWhere('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .andWhere(function () { this.where('c.is_maintenance', 0).orWhereNull('c.is_maintenance'); })
            .whereNull('c.deleted_at')
            // ── Cuisine filter ────────────────────────────────────
            // When ?cuisine=<name> is set, only return products
            // linked to a category whose name contains <name>. Uses
            // the product_product_category join so we match the same
            // "in this category" relationship the search-overlay
            // expansion uses.
            .modify(function (qb) {
                if (!cuisine) { return; }
                qb.whereExists(function () {
                    this.select(db.raw('1'))
                        .from('product_product_category as ppc')
                        .innerJoin('categories as cat', 'cat.id', 'ppc.category_id')
                        .whereRaw('ppc.product_id = p.id')
                        .andWhere('ppc.status', '1')
                        .andWhereRaw('LOWER(cat.name) LIKE ?', ['%' + cuisine + '%']);
                });
            })
            // ── Restaurant filter ─────────────────────────────────
            // Single-restaurant focus page (/?restaurant=<slug> in
            // the web). All other filters still apply (e.g. the
            // user can also restrict by cuisine), so we just AND
            // this in.
            .modify(function (qb) {
                if (!restaurantId) { return; }
                qb.andWhere('c.id', restaurantId);
            })
            .orderBy([
                { column: 'p.is_recommended', order: 'desc' },
                { column: 'p.is_featured',    order: 'desc' },
                { column: 'p.id',             order: 'asc'  },
            ])
            .limit(fetchLimit);

        // Capture km on a separate sortKm field so we keep the
        // human-readable distanceKm shape unchanged while having a
        // numeric sort key with Infinity for "no coords known".
        const products = rows.map(r => {
            const name = String(r.product_name || '').trim();
            const km   = distance.kmBetween(lat, lng, r.branch_lat, r.branch_lng);
            return {
                id:              String(r.product_id),
                name,
                priceFrom:       M.pickPrice(r),
                rating:          4.5,                       // TODO: derive from review_rating table
                deliveryMinutes: km != null ? distance.estimateDeliveryMinutes(km) : null,
                restaurant:      String(r.company_name || '').trim(),
                restaurantSlug:  r.company_domain ? M.slugify(r.company_domain) : M.slugify(r.company_name, r.company_id),
                veg:             M.isVegProduct(r),
                tint:            M.tintFor(r.product_id),
                initial:         M.initialFor(name),
                // Build the full public URL via the shared helper —
                // central YII_UPLOADS_URL env knob in api/Helpers/
                // marketplace.js lets us relocate the whole uploads
                // tree without touching this controller.
                image:           M.yiiImageUrl('product', r.company_id, r.image_url),
                // Internal sort keys only; stripped before send.
                _km:             km == null ? Infinity : km,
                _companyId:      String(r.company_id),
            };
        });

        // ── Build the full ordered pool ───────────────────────────
        // Same shape in two modes; the difference is just how rows
        // are arranged before slicing:
        //   • cuisine filter set → pure distance ASC (id tiebreaker).
        //     The user is asking "show me everything in <cuisine>",
        //     so the rail is one-per-row in distance order — no
        //     restaurant diversification.
        //   • no cuisine → deterministic round-robin across
        //     restaurants. Sort restaurants by (distance, id), sort
        //     each restaurant's products by id, then round-robin
        //     one-per-restaurant-per-round. Result: nearby kitchens
        //     lead, every restaurant gets airtime before any one
        //     restaurant's #2 dish shows up. Deterministic so "See
        //     more" / auto-load pagination never duplicates a row
        //     between pages.
        let ordered;
        if (cuisine) {
            ordered = products.slice().sort((a, b) => {
                if (a._km !== b._km) { return a._km - b._km; }
                return Number(a.id) - Number(b.id);
            });
        } else {
            const groups = new Map();
            for (const p of products) {
                const key = p._companyId;
                if (!groups.has(key)) { groups.set(key, []); }
                groups.get(key).push(p);
            }
            // Stable sort within each restaurant (by product id) and
            // across restaurants (by distance, then company id).
            for (const group of groups.values()) {
                group.sort((a, b) => Number(a.id) - Number(b.id));
            }
            const byRestaurant = Array.from(groups.values()).sort((a, b) => {
                if (a[0]._km !== b[0]._km) { return a[0]._km - b[0]._km; }
                return Number(a[0]._companyId) - Number(b[0]._companyId);
            });
            ordered = [];
            let round = 0;
            while (true) {
                let pickedAny = false;
                for (const g of byRestaurant) {
                    if (round < g.length) {
                        ordered.push(g[round]);
                        pickedAny = true;
                    }
                }
                if (!pickedAny) { break; }
                round += 1;
            }
        }

        // Slice [offset, offset+limit) + strip internal sort keys.
        const sliced = ordered.slice(offset, offset + limit).map(p => {
            const out = Object.assign({}, p);
            delete out._km;
            delete out._companyId;
            return out;
        });
        const hasMore = ordered.length > offset + limit;
        return H.successResponse(res, { products: sliced, has_more: hasMore });
    } catch (err) {
        H.log.error('marketplace.products.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list };
