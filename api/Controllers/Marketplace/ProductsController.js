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
const distance  = require('../../Helpers/distance');
const M         = require('../../Helpers/marketplace');
const OrderTime = require('../../Helpers/orderTime');

/**
 * resolveMpCategoryId
 *
 * What:  cuisine URL param (slug / normalised name) → mp category id.
 *        Same matcher as RestaurantsController so the products rail
 *        and the restaurants rail filter by the SAME cuisine mapping.
 */
async function resolveMpCategoryId(cuisine) {
    if (!cuisine) { return null; }
    // Same plural-robust key as RestaurantsController: lowercase, drop
    // spaces + hyphens, strip ONE trailing plural so the singularised
    // pill value ("burger") matches the master name/slug ("Burgers").
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
        const mpCategoryId = await resolveMpCategoryId(cuisine);
        // Restaurant filter — limits the results to a single
        // company. Accepts an integer company id. The web side
        // resolves slug → id before calling this endpoint.
        const restaurantId = req.query.restaurant
            ? Math.max(0, Number(req.query.restaurant)) || null
            : null;
        // ── Phase-2 filter params (all optional) ───────────────────
        const vegOnly     = String(req.query.veg         || '') === '1';
        const recOnly     = String(req.query.recommended || '') === '1';
        const featOnly    = String(req.query.featured    || '') === '1';
        const hasOffer    = String(req.query.offer       || '') === '1';
        const priceBucket = req.query.price ? String(req.query.price).toLowerCase() : null;
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
                'b.id                  as branch_id',
                'b.direction_latitude  as branch_lat',
                'b.direction_longitude as branch_lng',
                'b.delivery_waiting_time',
                'b.pickup_waiting_time',
                'pi.url                as image_url',
            )
            .where('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .modify(M.eligibleCompanyScope, 'c')
            // ── Cuisine filter ────────────────────────────────────
            // When ?cuisine=<name> is set, only return products
            // linked to a category whose name contains <name>. Uses
            // the product_product_category join so we match the same
            // "in this category" relationship the search-overlay
            // expansion uses.
            .modify(function (qb) {
                if (!cuisine) { return; }
                if (mpCategoryId) {
                    // Cuisine resolved to a global marketplace category →
                    // show products from companies ASSIGNED to it.
                    qb.whereExists(function () {
                        this.select(db.raw('1'))
                            .from('mp_marketplace_category_assign as mca')
                            .whereRaw('mca.company_id = p.company_id')
                            .andWhere('mca.category_id', mpCategoryId);
                    });
                } else {
                    // Fallback: match the product's own per-company
                    // category by like-name (legacy behaviour).
                    qb.whereExists(function () {
                        this.select(db.raw('1'))
                            .from('product_product_category as ppc')
                            .innerJoin('categories as cat', 'cat.id', 'ppc.category_id')
                            .whereRaw('ppc.product_id = p.id')
                            .andWhere('ppc.status', '1')
                            .andWhereRaw('LOWER(cat.name) LIKE ?', ['%' + cuisine + '%']);
                    });
                }
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
            // ── Diet (veg only) ───────────────────────────────────
            // veg_non_veg = 1 → veg. Excludes null + non-veg.
            .modify(function (qb) { if (vegOnly) { qb.andWhere('p.veg_non_veg', 1); } })
            // ── Recommended / Featured ───────────────────────────
            .modify(function (qb) { if (recOnly)  { qb.andWhere('p.is_recommended', 1); } })
            .modify(function (qb) { if (featOnly) { qb.andWhere('p.is_featured',    1); } })
            // ── Has offer ────────────────────────────────────────
            // Product-level: a non-empty `offer` label OR a positive
            // `discount_value`.
            .modify(function (qb) {
                if (!hasOffer) { return; }
                qb.where(function () {
                    this.where('p.discount_value', '>', 0)
                        .orWhere(function () { this.whereNotNull('p.offer').andWhere('p.offer', '<>', ''); });
                });
            })
            // ── Price bucket ─────────────────────────────────────
            // Picks the first non-null price in the same chain
            // Helpers/marketplace.pickPrice uses, so the filter
            // matches what the customer sees on the card.
            .modify(function (qb) {
                if (!priceBucket) { return; }
                // COALESCE order mirrors pickPrice():
                //   marketplace_price → online_platform_price →
                //   price_after_tax → 0
                const expr = `COALESCE(p.marketplace_price, p.online_platform_price, p.price_after_tax, 0)`;
                if (priceBucket === 'low')      { qb.andWhereRaw(expr + ' > 0 AND ' + expr + ' <= ?',  [6]); }
                else if (priceBucket === 'mid') { qb.andWhereRaw(expr + ' > ? AND ' + expr + ' <= ?', [6, 12]); }
                else if (priceBucket === 'high'){ qb.andWhereRaw(expr + ' > ?',   [12]); }
            })
            .orderBy([
                { column: 'p.is_recommended', order: 'desc' },
                { column: 'p.is_featured',    order: 'desc' },
                { column: 'p.id',             order: 'asc'  },
            ])
            .limit(fetchLimit);

        // Time labels (delivery + pickup) computed once for every
        // distinct branch on the page. Each row carries `branch_id`
        // via the join below (aliased through).
        const branchRows = rows.map(r => ({
            branch_id: r.branch_id,
            delivery_waiting_time: r.delivery_waiting_time,
            pickup_waiting_time:   r.pickup_waiting_time,
        }));
        const timesByBranch = await OrderTime.computeForBranches(branchRows);

        // Capture km on a separate sortKm field so we keep the
        // human-readable distanceKm shape unchanged while having a
        // numeric sort key with Infinity for "no coords known".
        const products = rows.map(r => {
            const name = String(r.product_name || '').trim();
            const km   = distance.kmBetween(lat, lng, r.branch_lat, r.branch_lng);
            const t    = timesByBranch[String(r.branch_id)] || { delivery: null, pickup: null };
            return {
                id:              String(r.product_id),
                name,
                priceFrom:       M.pickPrice(r),
                rating:          4.5,                       // TODO: derive from review_rating table
                deliveryMinutes: t.delivery,
                pickupMinutes:   t.pickup,
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

/**
 * optionPrice
 *
 * What:  First non-null of the tax-included → tax-excluded price for an
 *        option row, coerced to a Number (0 when neither is set).
 * Type:  READ (pure).
 */
function optionPrice(r) {
    const v = r.price_tax_included != null && r.price_tax_included !== '' ? r.price_tax_included
            : (r.price_tax_include  != null && r.price_tax_include  !== '' ? r.price_tax_include
            : (r.price_tax_excluded != null && r.price_tax_excluded !== '' ? r.price_tax_excluded : 0));
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// POS-specific dummy option names that the legacy webordering hides from
// the customer (they exist for in-store till behaviour, never for online).
// Source: common/constants/Posconstant.php — FREE/NO/LESS/CHIPS/BURGER.
const HIDDEN_OPTION_NAMES = ['Free', 'No', 'Less', 'On Chips', 'On Burger'];

/**
 * loadProductOptionGroups
 *
 * What:  Ports webordering/controllers/ProductController.php's
 *        getProductModifiers() to Node. The legacy logic is the source
 *        of truth — same dedup behaviour, same hidden-name filter, same
 *        linked-group nesting via `modifier_copy_details`.
 *
 *        Steps (mirroring the PHP):
 *          1. Read `modifier_group_products` rows for the product
 *             (status='1', ordered by sequence).
 *          2. Collect every `link_group_id` referenced by those groups
 *             in `modifier_copy_details`. Any group that appears as a
 *             link target is rendered NESTED inside its parent option,
 *             not as a top-level group → no duplicates.
 *          3. For each remaining top-level group, load its options
 *             (status='1', excluding HIDDEN_OPTION_NAMES) and attach
 *             a `linkedGroup` to each option that has a copy detail
 *             row pointing at another group.
 *
 * Type:  READ.
 * Output: an array of {id, name, type, min, max, required, options}
 *         matching the existing public shape.
 */
async function loadProductOptionGroups(productId) {
    const links = await db('modifier_group_products')
        .where('product_id', productId)
        .andWhere('status', '1')
        .orderBy('sequence', 'asc')
        .select('modifier_group_id');
    if (!links.length) { return []; }

    const linkedIds = links.map(l => l.modifier_group_id);

    // ── Step 2: which groups appear as link targets? ─────────────
    // A group whose id appears in ANY of these copy-detail rows is
    // logically nested (e.g. "Side Choice" lives inside "Add a Side
    // or Drink") and must NOT also render at the top level.
    const copyRows = await db('modifier_copy_details')
        .whereIn('group_id', linkedIds)
        .andWhere('status', '1')
        .select('group_id', 'modifier_option_id', 'link_group_id');
    const skipTopLevelIds = new Set(copyRows.map(r => String(r.link_group_id)));
    // (option_id, parent_group_id) → linked sub-group row (for nesting).
    const linkByOptionKey = new Map();
    copyRows.forEach(r => {
        linkByOptionKey.set(String(r.modifier_option_id) + ':' + String(r.group_id), String(r.link_group_id));
    });

    // ── Step 3: load every group we MIGHT need (top-level + any
    // sub-group referenced as a link target). One round trip. ──
    const allGroupIds = Array.from(new Set([
        ...linkedIds.map(String),
        ...Array.from(skipTopLevelIds),
    ]));
    if (!allGroupIds.length) { return []; }
    const groupRows = await db('modifier_group')
        .whereIn('id', allGroupIds)
        .andWhere('status', '1')
        .select('id', 'group_name', 'modifier_type', 'has_modifier_limit', 'min_limit', 'max_limit');
    const groupById = new Map(groupRows.map(g => [String(g.id), g]));

    const optRows = await db('modifier_group_options')
        .whereIn('modifier_group_id', allGroupIds)
        .andWhere('status', '1')
        .whereNotIn('option_name', HIDDEN_OPTION_NAMES)
        .orderBy('sequence', 'asc')
        .select('id', 'modifier_group_id', 'option_name', 'price_tax_include', 'price_tax_excluded', 'is_default');
    const optsByGroup = new Map();
    optRows.forEach(o => {
        const k = String(o.modifier_group_id);
        if (!optsByGroup.has(k)) { optsByGroup.set(k, []); }
        optsByGroup.get(k).push(o);
    });

    function buildGroup(g, parentGroupId) {
        const rawOpts = optsByGroup.get(String(g.id)) || [];
        const options = rawOpts.map(o => {
            const out = {
                id:        String(o.id),
                name:      String(o.option_name || '').trim(),
                price:     optionPrice(o),
                isDefault: Number(o.is_default) === 1,
            };
            // If this option has a copy-detail row inside the PARENT
            // group, attach the nested sub-group so the UI can render
            // a follow-up choice (e.g. "Side" → pick a drink type).
            // Only attached when parentGroupId is supplied; nested
            // groups themselves don't chain further.
            if (parentGroupId) {
                const sub = linkByOptionKey.get(String(o.id) + ':' + String(parentGroupId));
                if (sub) {
                    const subGroup = groupById.get(String(sub));
                    if (subGroup) { out.linkedGroup = buildGroup(subGroup, null); }
                }
            }
            return out;
        });
        // Single vs multi is driven by the group's modifier_type column
        // (legacy field). Values seen in the live DB:
        //   'Single Choice' / 'radio'        → single (radio buttons)
        //   'Multiple Choice' / 'checkbox'   → multi  (checkboxes)
        // has_modifier_limit / min_limit / max_limit are SEPARATE — they
        // only apply when has_modifier_limit = 1 (otherwise the group is
        // unbounded). For single-choice groups we force max=1 and treat
        // them as ALWAYS required — matches legacy webordering
        // products.js (line 336): `isRequired = minLimit > 0 || type
        // === 'Single Choice'`. Without this, radio groups with
        // min_limit=0 wouldn't enforce a pick on submit even though
        // the legacy UI does.
        const t = String(g.modifier_type || '').toLowerCase();
        const isSingle = (t === 'single choice' || t === 'radio');
        const limited = Number(g.has_modifier_limit) === 1;
        let max = limited ? (Number(g.max_limit) || 0) : 0;
        let min = limited ? (Number(g.min_limit) || 0) : 0;
        if (isSingle) { max = 1; min = 1; }
        return {
            id:       'm' + g.id,
            name:     String(g.group_name || '').trim() || 'Add-ons',
            type:     isSingle ? 'single' : 'multi',
            min, max,
            required: isSingle || min >= 1,
            options,
        };
    }

    // Preserve the original link order; drop groups that are link
    // targets (rendered nested) or whose group row is missing/inactive.
    const out = [];
    for (const id of linkedIds) {
        const key = String(id);
        if (skipTopLevelIds.has(key)) { continue; }
        const g = groupById.get(key);
        if (!g) { continue; }
        const built = buildGroup(g, id);
        if (built.options.length) { out.push(built); }
    }
    return out;
}

/**
 * detail
 *
 * What:  Single-product payload for the product page:
 *          { product, groups }
 *        • product — id, name, description, basePrice, image, veg,
 *          restaurant {id, name, slug}.
 *        • groups  — selectable option groups, unified from the two
 *          Yii sources: product_variants_group (sizes / portions, by
 *          product) and modifier_group via modifier_group_products
 *          (toppings / add-ons). Each: { id, name, type:single|multi,
 *          min, max, required, options:[{id,name,price,isDefault}] }.
 * Type:  READ.
 * Query (validated): id (required), lat?, lng?.
 */
async function detail(req, res) {
    try {
        // Resolve the product. Preferred (clean, no id in the URL):
        // rest = restaurant slug + item = product-name slug. `id` is
        // still accepted as an internal fallback.
        let productId = req.query.id ? Math.max(0, Number(req.query.id)) || null : null;
        const restSlug = req.query.rest ? String(req.query.rest).trim().toLowerCase() : null;
        const itemSlug = req.query.item ? String(req.query.item).trim().toLowerCase() : null;
        if (!productId && restSlug && itemSlug) {
            const cands = await db('company as c')
                .modify(M.eligibleCompanyScope, 'c')
                .select('c.id', 'c.business_name', 'c.domain_name');
            const co = cands.find(c => (c.domain_name ? M.slugify(c.domain_name) : M.slugify(c.business_name, c.id)) === restSlug);
            if (co) {
                const prods = await db('products as p')
                    .where('p.company_id', co.id).andWhere('p.show_marketplace', 1).andWhere('p.status', '1')
                    .select('p.id', 'p.name');
                const hit = prods.find(pr => M.slugify(pr.name) === itemSlug);
                productId = hit ? hit.id : null;
            }
        }
        if (!productId) { return H.errorResponse(res, 'Product not found.', 404); }

        // ── Product + company (+ primary image) ────────────────────
        const row = await db('products as p')
            .innerJoin('company as c', 'c.id', 'p.company_id')
            .leftJoin(
                db('product_image')
                    .select('product_id', db.raw(`(
                        SELECT url FROM product_image pi2
                        WHERE pi2.product_id = product_image.product_id AND pi2.status = '1'
                        ORDER BY pi2.is_primary DESC, pi2.id ASC LIMIT 1) AS url`))
                    .where('status', '1').groupBy('product_id').as('pi'),
                'pi.product_id', 'p.id',
            )
            .where('p.id', productId)
            .andWhere('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .modify(M.eligibleCompanyScope, 'c')
            .select(
                'p.id as product_id', 'p.name as product_name', 'p.product_description',
                'p.veg_non_veg', 'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax', 'p.track_stock_level',
                'c.id as company_id', 'c.business_name', 'c.domain_name', 'pi.url as image_url',
                db.raw("EXISTS (SELECT 1 FROM product_sold_out so WHERE so.product_id = p.id AND so.is_sold::text = '1') AS is_sold_out"),
                db.raw("(SELECT COALESCE(SUM(si.quantity::numeric), 0) FROM product_store_inventory si WHERE si.product_id = p.id) AS stock_qty"),
            )
            .first();
        if (!row) { return H.errorResponse(res, 'Product not found.', 404); }

        const name = String(row.product_name || '').trim();
        const tracks = Number(row.track_stock_level) === 1;
        const stockQty = row.stock_qty != null ? Number(row.stock_qty) : 0;
        const outOfStock = !!row.is_sold_out || (tracks && stockQty <= 0);
        const product = {
            id:          String(row.product_id),
            name,
            slug:        M.slugify(name),
            description: String(row.product_description || '').trim() || null,
            basePrice:   M.pickPrice(row),
            inStock:     !outOfStock,
            // Counted inventory exposed for every product (see restaurant
            // detail). tracksStock tells the view whether it's authoritative.
            stockQty:    stockQty,
            tracksStock: tracks,
            veg:         M.isVegProduct(row),
            image:       M.yiiImageUrl('product', row.company_id, row.image_url) || null,
            tint:        M.tintFor(row.product_id),
            initial:     M.initialFor(name),
            restaurant: {
                id:   String(row.company_id),
                name: String(row.business_name || '').trim(),
                slug: row.domain_name ? M.slugify(row.domain_name) : M.slugify(row.business_name, row.company_id),
            },
        };

        // ── Option groups — matches the legacy eatndealclean
        // webordering ProductController exactly (single source of
        // truth: `modifier_group_products`). Variant + meal-deal
        // tables are NOT read here — real marketplace products carry
        // every selectable group via modifier_group_products, and
        // mixing the other two sources just duplicates the same group
        // (see Test Mega Combo, which had Size/Crust/Add a Side or
        // Drink mirrored across three tables → six cards rendered).
        const groups = await loadProductOptionGroups(productId);

        // ── Image gallery (all product photos) ─────────────────────
        const imgRows = await db('product_image')
            .where('product_id', productId).andWhere('status', '1')
            .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'id', order: 'asc' }])
            .select('url');
        product.images = imgRows.map(r => M.yiiImageUrl('product', row.company_id, r.url)).filter(Boolean);
        if (!product.image && product.images.length) { product.image = product.images[0]; }

        // ── "You may also like" — other items from the same restaurant ──
        const relRows = await db('products as p')
            .leftJoin(
                db('product_image')
                    .select('product_id', db.raw(`(
                        SELECT url FROM product_image pi3
                        WHERE pi3.product_id = product_image.product_id AND pi3.status = '1'
                        ORDER BY pi3.is_primary DESC, pi3.id ASC LIMIT 1) AS url`))
                    .where('status', '1').groupBy('product_id').as('pir'),
                'pir.product_id', 'p.id',
            )
            .where('p.company_id', row.company_id)
            .andWhere('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .andWhereNot('p.id', productId)
            .orderBy([{ column: 'p.is_featured', order: 'desc' }, { column: 'p.id', order: 'asc' }])
            .limit(6)
            .select('p.id', 'p.name', 'p.veg_non_veg', 'p.marketplace_price', 'p.online_platform_price', 'p.price_after_tax', 'pir.url as image_url');
        const related = relRows.map(r => ({
            id: String(r.id), name: String(r.name || '').trim(), slug: M.slugify(r.name), price: M.pickPrice(r),
            veg: M.isVegProduct(r), image: M.yiiImageUrl('product', row.company_id, r.image_url) || null,
            tint: M.tintFor(r.id), initial: M.initialFor(r.name),
        }));

        return H.successResponse(res, { product, groups, related });
    } catch (err) {
        H.log.error('marketplace.products.detail', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, detail };
