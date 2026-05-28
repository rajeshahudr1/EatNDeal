'use strict';

/*
 * Controllers/Marketplace/SearchController.js
 *
 * What:  GET /api/v1/marketplace/search?q=<term>
 *        Relationship-aware live-search for the homepage.
 *
 *        A single typed term ("burger") expands through the
 *        category ↔ product ↔ restaurant relationships, returning
 *        ALL three sets that should remain visible on the page:
 *
 *          • categoryNames  — normalised lowercase keys (e.g. "burger")
 *                              the front-end matches against each
 *                              cuisine pill's data-search-name.
 *          • productIds     — ids the front-end matches against each
 *                              dish card's data-search-id.
 *          • restaurantIds  — ids the front-end matches against each
 *                              restaurant card's data-search-id.
 *
 *        Expansion rules:
 *          query → CATEGORY  ⇒ all products in that category
 *                            + all restaurants serving those products
 *          query → PRODUCT   ⇒ its category + its restaurant
 *          query → RESTAURANT ⇒ all its categories + all its
 *                                marketplace-on products
 *
 *        Every step also enforces the standard marketplace filters
 *        (company.is_marketplace=1, etc.) so a deleted company's
 *        product can't sneak in via the expansion.
 *
 *        Empty / too-short query (< 2 chars) returns empty sets and
 *        the front-end falls back to showing everything.
 *
 * Why:   Pure client-side filtering on the rendered DOM can't expand
 *        relationships — the page only knows about cards it currently
 *        renders. A server endpoint lets us walk the join tables and
 *        return EVERY id the user expected to see when they typed
 *        "burger", including restaurants that just happen to serve a
 *        burger even if their name has nothing to do with it.
 *
 * Used:  Wired in api/Routes/index.js. Called by web/public/js/pages/
 *        home.js as the user types.
 */

const H        = require('../../Helpers/helper');
const MSG      = require('../../Helpers/messages');
const { db }   = require('../../config/db');
const M        = require('../../Helpers/marketplace');

const MIN_QUERY_LEN = 2;

/**
 * makeTokens
 *
 * What:  Splits a user's typed query into individual lookup tokens:
 *           "Pizzas collection"  → ["pizza", "collection"]
 *           "Ice cream sundae"   → ["ice", "cream", "sundae"]
 *           "Burgers"            → ["burger"]
 *        Pipeline:
 *           lowercase → split on whitespace → strip non-alphanumerics
 *           → strip a trailing 's' / 'es' (singularise) → dedupe →
 *           drop tokens shorter than 2 chars.
 *        The singularise step matters because the DB stores
 *        "Burger" / "Pizza" / "Kebab" (singular) but users routinely
 *        type "Burgers" / "Pizzas". Without it, a LIKE %pizzas%
 *        would return zero rows even though the data is full of
 *        pizza products.
 * Why:   Empty result lists are a worse UX than slightly-fuzzy
 *        matches. The user wanted "is se related dikhao" — show
 *        something related when the full string doesn't hit.
 * Type:  READ (pure).
 */
function makeTokens(q) {
    return Array.from(new Set(
        String(q || '')
            .toLowerCase()
            .split(/\s+/)
            .map(t => t.trim().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, ''))
            .filter(t => t.length >= 2)
    ));
}

/**
 * relevanceScore
 *
 * What:  Lower = more relevant. Used to sort the rich result lists.
 *        Priority:
 *          0 → exact match against the full query
 *          1 → name starts with the full query
 *          2 → name contains the full query
 *          3.. → name contains some of the tokens (lower = more
 *                tokens matched). Falls in this bucket when the full
 *                query didn't hit but at least one token did.
 *          99 → nothing matched (should rarely happen because the
 *                SQL filter already excluded these).
 * Type:  READ (pure).
 */
function relevanceScore(name, q, tokens) {
    const n = String(name || '').toLowerCase();
    if (!q) { return 99; }
    if (n === q) { return 0; }
    if (n.indexOf(q) === 0) { return 1; }
    if (n.indexOf(q) !== -1) { return 2; }
    // Full query didn't substring-match. Score by how many tokens
    // appear in the name — more tokens → smaller (better) score.
    let matched = 0;
    if (tokens && tokens.length) {
        for (const t of tokens) {
            if (n.indexOf(t) !== -1) { matched += 1; }
        }
    }
    if (matched === 0) { return 99; }
    return 10 - matched;
}

/**
 * search
 *
 * What:  Returns the union of all category-name / product-id /
 *        restaurant-id keys that should remain visible on the
 *        marketplace dashboard for a given query.
 * Type:  READ (multiple DB round-trips, all light index lookups).
 *
 * Query params:
 *   q  — string, 2..120 chars (already trimmed by the validator)
 *
 * Output:
 *   { categoryNames: [string], productIds: [string], restaurantIds: [string] }
 */
async function search(req, res) {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (q.length < MIN_QUERY_LEN) {
            return H.successResponse(res, {
                categoryNames: [],
                productIds:    [],
                restaurantIds: [],
            });
        }
        const tokens = makeTokens(q);
        // Defensive: if the user typed only stopword-ish chars (e.g.
        // "a !") we'd have zero tokens. Fall back to the whole query
        // as a single token so we still return something rather than
        // a hard empty.
        const effectiveTokens = tokens.length ? tokens : [q];

        // Build the OR-LIKE clause for a given column. Each token
        // becomes an OR'd LIKE; matches any name that contains any
        // token. Examples:
        //   q="pizzas collection" → tokens=["pizza","collection"]
        //      → WHERE LOWER(name) LIKE '%pizza%' OR LOWER(name) LIKE '%collection%'
        //   q="burgers" → tokens=["burger"]
        //      → WHERE LOWER(name) LIKE '%burger%'
        function tokenClause(column) {
            return function () {
                for (const t of effectiveTokens) {
                    const safe = t.replace(/[%_]/g, '\\$&');
                    this.orWhereRaw(`LOWER(${column}) LIKE ?`, ['%' + safe + '%']);
                }
            };
        }

        // ── 1. Direct text matches (always honour marketplace gates)
        const matchedCats = await db('categories as cat')
            .innerJoin('company as c', 'c.id', 'cat.company_id')
            .select('cat.id', 'cat.name', 'cat.company_id', 'cat.category_image')
            .where(tokenClause('cat.name'))
            .andWhere('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .andWhere(function () { this.where('c.is_maintenance', 0).orWhereNull('c.is_maintenance'); })
            .whereNull('c.deleted_at')
            .andWhere('cat.is_display_application_menu', 1);

        const matchedProds = await db('products as p')
            .innerJoin('company as c', 'c.id', 'p.company_id')
            .select('p.id', 'p.company_id')
            .where(tokenClause('p.name'))
            .andWhere('p.show_marketplace', 1)
            .andWhere('p.status', '1')
            .andWhere('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .whereNull('c.deleted_at');

        const matchedRests = await db('company as c')
            .select('c.id')
            .where(tokenClause('c.business_name'))
            .andWhere('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .whereNull('c.deleted_at');

        // Working sets as JS Sets for O(1) membership + dedupe.
        const catRowsById = new Map();   // id → {id, name, company_id}
        const prodIds     = new Set();
        const restIds     = new Set();

        for (const r of matchedCats)  { catRowsById.set(String(r.id), r); }
        for (const r of matchedProds) { prodIds.add(String(r.id)); restIds.add(String(r.company_id)); }
        for (const r of matchedRests) { restIds.add(String(r.id)); }

        // ── 2. From matched CATEGORIES → expand to products + restaurants
        if (catRowsById.size) {
            const ids = Array.from(catRowsById.keys());
            const expProds = await db('product_product_category as ppc')
                .innerJoin('products as p', 'p.id', 'ppc.product_id')
                .innerJoin('company  as c', 'c.id', 'p.company_id')
                .select('p.id as product_id', 'p.company_id')
                .whereIn('ppc.category_id', ids)
                .andWhere('ppc.status', '1')
                .andWhere('p.show_marketplace', 1)
                .andWhere('p.status', '1')
                .andWhere('c.is_marketplace', 1)
                .andWhere('c.is_active', 1)
                .whereNull('c.deleted_at');
            for (const r of expProds) {
                prodIds.add(String(r.product_id));
                restIds.add(String(r.company_id));
            }
        }

        // ── 3. From matched PRODUCTS → expand to their categories
        // (Restaurants from product matches already added in step 1.)
        if (matchedProds.length) {
            const ids = matchedProds.map(r => r.id);
            const expCats = await db('product_product_category as ppc')
                .innerJoin('categories as cat', 'cat.id', 'ppc.category_id')
                .select('cat.id', 'cat.name', 'cat.company_id')
                .whereIn('ppc.product_id', ids)
                .andWhere('ppc.status', '1');
            for (const r of expCats) { catRowsById.set(String(r.id), r); }
        }

        // ── 4. From matched RESTAURANTS → expand to their categories + products
        if (restIds.size) {
            const ids = Array.from(restIds);
            const expCats = await db('categories')
                .select('id', 'name', 'company_id')
                .whereIn('company_id', ids)
                .andWhere('is_display_application_menu', 1);
            for (const r of expCats) { catRowsById.set(String(r.id), r); }

            const expProds = await db('products')
                .select('id', 'company_id')
                .whereIn('company_id', ids)
                .andWhere('show_marketplace', 1)
                .andWhere('status', '1');
            for (const r of expProds) { prodIds.add(String(r.id)); }
        }

        // ── 5. Normalise category names so the front-end can match
        //       them against each pill's data-search-name (which uses
        //       the same shared normaliser).
        const catNames = new Set();
        for (const r of catRowsById.values()) {
            const norm = M.normaliseName(r.name);
            if (norm) { catNames.add(norm); }
        }

        // ── 6. Rich result lists for the search OVERLAY (Zomato-style
        //       result rows shown below the input as the user types).
        //       We rebuild them from the DIRECT matches only — the
        //       expansion in steps 2-4 is only useful for hiding cards
        //       on the home grid; in the overlay we want to surface
        //       the EXACT thing the user typed first, not every
        //       relative.
        const RESULT_CAP = 5;

        // Category results — dedupe by normalised name + title case.
        // Pre-sort matched rows by relevance so "Burger" wins over
        // "Veggie Burger" when the query is "burger".
        const catSorted = matchedCats.slice().sort((a, b) => {
            const sa = relevanceScore(a.name, q, effectiveTokens);
            const sb = relevanceScore(b.name, q, effectiveTokens);
            if (sa !== sb) { return sa - sb; }
            return Number(a.id) - Number(b.id);
        });
        const catSeen   = new Set();
        const catResult = [];
        for (const r of catSorted) {
            const norm = M.normaliseName(r.name);
            if (!norm || catSeen.has(norm)) { continue; }
            catSeen.add(norm);
            const title = norm.replace(/\b\w/g, ch => ch.toUpperCase());
            catResult.push({
                name:    title,
                slug:    M.slugify(title, r.id),
                searchName: norm,
                icon:    M.yiiImageUrl('category', r.company_id, r.category_image),
                initial: M.initialFor(title),
                tint:    M.tintFor(r.id),
            });
            if (catResult.length >= RESULT_CAP) { break; }
        }

        // Product results — need name + company + image, so re-query
        // with the matched ids to get full rows. Limit upstream so
        // this stays cheap even on broad queries.
        let prodResult = [];
        if (matchedProds.length) {
            const ids = matchedProds.slice(0, RESULT_CAP * 4).map(r => r.id);
            const rows = await db('products as p')
                .innerJoin('company as c', 'c.id', 'p.company_id')
                .leftJoin(
                    db('product_image')
                        .select('product_id', db.raw(`(
                            SELECT url FROM product_image pi2
                            WHERE pi2.product_id = product_image.product_id
                              AND pi2.status = '1'
                            ORDER BY pi2.is_primary DESC, pi2.id ASC
                            LIMIT 1
                        ) AS url`))
                        .where('status', '1')
                        .groupBy('product_id')
                        .as('pi'),
                    'pi.product_id', 'p.id',
                )
                .select(
                    'p.id', 'p.name',
                    'c.id as company_id', 'c.business_name', 'c.domain_name',
                    'pi.url as image_url',
                    // Primary category name — first row from the
                    // M2M join. Used by the search overlay to send
                    // the user to /?cuisine=<that-category> instead
                    // of the restaurant detail page when they click
                    // the product row.
                    db.raw(`(
                        SELECT cat.name FROM categories cat
                        INNER JOIN product_product_category ppc ON ppc.category_id = cat.id
                        WHERE ppc.product_id = p.id
                          AND ppc.status = '1'
                        ORDER BY ppc.id ASC LIMIT 1
                    ) AS category_name`),
                )
                .whereIn('p.id', ids);
            const order = new Map(ids.map((id, i) => [String(id), i]));
            rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
            // Sort by relevance: exact name > starts-with > contains.
            // Tiebreak by id for stability.
            rows.sort((a, b) => {
                const sa = relevanceScore(a.name, q);
                const sb = relevanceScore(b.name, q);
                if (sa !== sb) { return sa - sb; }
                return Number(a.id) - Number(b.id);
            });
            prodResult = rows.slice(0, RESULT_CAP).map(r => {
                const catName = String(r.category_name || '').trim();
                return {
                    id:             String(r.id),
                    name:           String(r.name || '').trim(),
                    slug:           M.slugify(r.name),
                    restaurant:     String(r.business_name || '').trim(),
                    restaurantSlug: r.domain_name ? M.slugify(r.domain_name) : M.slugify(r.business_name, r.company_id),
                    image:          M.yiiImageUrl('product', r.company_id, r.image_url),
                    initial:        M.initialFor(r.name),
                    tint:           M.tintFor(r.id),
                    // Picking a product row in the search overlay
                    // sends the user to /?cuisine=<this category>
                    // rather than the restaurant detail page — the
                    // user wanted "show me everything like this
                    // dish", not "send me to that one restaurant".
                    categoryName:       catName,
                    categorySearchName: M.normaliseName(catName),
                };
            });
        }

        // Restaurant results — pick the company row + its primary
        // branch image (banner first, logo fallback).
        let restResult = [];
        if (matchedRests.length) {
            const ids = matchedRests.slice(0, RESULT_CAP * 2).map(r => r.id);
            const rows = await db('company as c')
                .leftJoin(
                    db('branch')
                        .select('company_id', db.raw('MIN(id) AS branch_id'))
                        .whereNot('status', '2')
                        .groupBy('company_id')
                        .as('bm'),
                    'bm.company_id', 'c.id',
                )
                .leftJoin('branch as b', 'b.id', 'bm.branch_id')
                .select(
                    'c.id', 'c.business_name', 'c.domain_name',
                    'b.banner_image', 'b.business_image',
                )
                .whereIn('c.id', ids);
            const order = new Map(ids.map((id, i) => [String(id), i]));
            rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
            // Relevance sort on the business_name column.
            rows.sort((a, b) => {
                const sa = relevanceScore(a.business_name, q, effectiveTokens);
                const sb = relevanceScore(b.business_name, q, effectiveTokens);
                if (sa !== sb) { return sa - sb; }
                return Number(a.id) - Number(b.id);
            });
            restResult = rows.slice(0, RESULT_CAP).map(r => ({
                id:      String(r.id),
                name:    String(r.business_name || '').trim(),
                slug:    r.domain_name ? M.slugify(r.domain_name) : M.slugify(r.business_name, r.id),
                image:   M.yiiImageUrl('banner', r.id, r.banner_image)
                        || M.yiiImageUrl('logo', r.id, r.business_image)
                        || null,
                initial: M.initialFor(r.business_name),
                tint:    M.tintFor(r.id),
            }));
        }

        return H.successResponse(res, {
            // Sets for the home-page card filter
            categoryNames:     Array.from(catNames),
            productIds:        Array.from(prodIds),
            restaurantIds:     Array.from(restIds),
            // Rich rows for the search overlay listing
            categoryResults:   catResult,
            productResults:    prodResult,
            restaurantResults: restResult,
        });
    } catch (err) {
        H.log.error('marketplace.search', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { search };
