'use strict';

/*
 * Controllers/Marketplace/CategoriesController.js
 *
 * What:  GET /api/v1/marketplace/categories — returns the list of
 *        category names that surface in the "What's on your mind?"
 *        cuisine row on the homepage.
 *
 *        Source: `categories` joined to `company`, filtered to rows
 *        belonging to marketplace-enabled companies and flagged for
 *        application-menu display.
 *
 *        Deduped by lowercased name so two restaurants both calling
 *        their starters "STARTERS" share a single pill.
 *
 * Why:   The wtw_eatndeal schema has no top-level cuisine taxonomy
 *        (we identified that as a gap). Until a real cuisine table
 *        lands, the per-restaurant category list is the closest
 *        proxy — and it surfaces the actual menu sections users will
 *        recognise once they tap through.
 *
 * Used:  Wired in api/Routes/index.js as
 *           GET /api/v1/marketplace/categories?limit=
 */

const H        = require('../../Helpers/helper');
const MSG      = require('../../Helpers/messages');
const { db }   = require('../../config/db');
const M        = require('../../Helpers/marketplace');

/**
 * mapIcon
 *
 * What:  Returns the public URL for a category's image when the row
 *        has one, else null. Delegates to M.yiiImageUrl so the actual
 *        path prefix lives in one place (api/Helpers/marketplace.js).
 *        Pills with no image render a brand-tinted circle with the
 *        category's first letter — same placeholder pattern as the
 *        restaurant + dish cards.
 * Type:  READ (pure).
 */
function mapIcon(categoryImage, companyId) {
    return M.yiiImageUrl('category', companyId, categoryImage);
}

/**
 * titleCase
 *
 * What:  "MAIN COURSE CLASSICS" → "Main Course Classics" so pills don't
 *        scream when the merchant stored them in upper-case (very
 *        common in the live data). Leaves the string alone when it's
 *        already mixed-case.
 * Type:  READ (pure).
 */
function titleCase(s) {
    const str = String(s || '');
    if (str !== str.toUpperCase()) { return str; }
    return str.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
}

/**
 * list
 *
 * What:  Returns the deduped category list ready to render. Order:
 *        is_featured DESC, then alphabetical, then earliest id (stable).
 * Type:  READ.
 *
 * Query params (sanitised by middleware):
 *   limit?  — int 1..50 (default 12)
 *
 * Output: { categories: [ { id, name, slug, icon, tint } ] }
 */
async function list(req, res) {
    try {
        const limit  = req.query.limit ? Math.min(50, Math.max(1, Number(req.query.limit))) : 12;
        const parent = req.query.parent ? String(req.query.parent).trim().toLowerCase() : null;

        // When ?parent=<name> is set, we return the CHILD categories
        // of every top-level row whose name matches. Example:
        //   /api/v1/marketplace/categories?parent=kebab
        //   → Chicken Kebab, Mixed Grill Kebab, Donner Kebab, …
        // Without the param the endpoint behaves as before (top-level
        // marketplace pills only).
        let parentIds = null;
        if (parent) {
            const rows = await db('categories as pcat')
                .innerJoin('company as pc', 'pc.id', 'pcat.company_id')
                .select('pcat.id')
                .where('pc.is_marketplace', 1)
                .andWhere('pc.is_active', 1)
                .whereNull('pc.deleted_at')
                .andWhere(function () { this.where('pcat.parent', 0).orWhereNull('pcat.parent'); })
                .andWhereRaw('LOWER(pcat.name) = ?', [parent]);
            parentIds = rows.map(r => r.id);
            // No matching top-level parent → no children to return.
            if (!parentIds.length) {
                return H.successResponse(res, { categories: [] });
            }
        }

        // A category qualifies only when it currently has at least
        // ONE active product that's also flagged for marketplace
        // display. The EXISTS subquery walks product_product_category
        // (the M2M join) → products and short-circuits as soon as one
        // match is found, so it stays cheap even with hundreds of
        // categories.
        const rows = await db('categories as cat')
            .innerJoin('company as c', 'c.id', 'cat.company_id')
            .select(
                'cat.id',
                'cat.name',
                'cat.category_image',
                'cat.is_featured',
                'cat.parent',
                'cat.company_id',
            )
            .where('c.is_marketplace', 1)
            .andWhere('c.is_active', 1)
            .andWhere(function () { this.where('c.is_maintenance', 0).orWhereNull('c.is_maintenance'); })
            .whereNull('c.deleted_at')
            .andWhere('cat.is_display_application_menu', 1)
            // When ?parent=<name> is set, look up children of THOSE
            // matching top-level rows. Otherwise return top-level
            // categories (parent = 0 / null) as before.
            .modify(function (qb) {
                if (parentIds) {
                    qb.whereIn('cat.parent', parentIds);
                } else {
                    qb.andWhere(function () { this.where('cat.parent', 0).orWhereNull('cat.parent'); });
                }
            })
            // ── Has-marketplace-product filter ─────────────────────
            .whereExists(function () {
                this.select(db.raw('1'))
                    .from('product_product_category as ppc')
                    .innerJoin('products as p', 'p.id', 'ppc.product_id')
                    .whereRaw('ppc.category_id = cat.id')
                    .andWhere('ppc.status', '1')
                    .andWhere('p.show_marketplace', 1)
                    .andWhere('p.status', '1')
                    // Safety belt — keep the product within the
                    // same company that owns the category, even if
                    // the join table somehow holds a cross-tenant
                    // row (shouldn't, but bilingual data is messy).
                    .andWhereRaw('p.company_id = cat.company_id');
            });

        // Dedupe by a *normalised* key (Burger + Burgers + "Burger /
        // برغر" all collapse to "burger"). Shared with the search
        // endpoint so the cuisine pill's data-search-name attribute
        // matches the keys SearchController returns. See
        // api/Helpers/marketplace.normaliseName for the full pipeline.
        const normaliseName = M.normaliseName;

        // Picks per normalised key with this preference:
        //   1. Row that HAS a category_image  (real artwork beats no
        //      artwork, regardless of which row Postgres returned first).
        //   2. First-encountered row otherwise.
        // Earlier code kept the FIRST row blindly — and Postgres
        // happened to return image-less duplicates first for many
        // pills, so even though e.g. "Garlic Bread" had an image on
        // id=29, the api was serving the empty id=48 row. Result:
        // every pill on the homepage showed a letter placeholder.
        const seen = new Map();
        for (const r of rows) {
            const name = String(r.name || '').trim();
            if (!name) { continue; }
            const key = normaliseName(name);
            if (!key) { continue; }              // pure-punctuation rows
            const hasImg = !!String(r.category_image || '').trim();
            const existing = seen.get(key);
            if (!existing) {
                seen.set(key, r);
                continue;
            }
            // Replace ONLY when the incoming row has an image and
            // the kept one doesn't — never demote a kept-with-image
            // back to an imageless duplicate.
            const existingHasImg = !!String(existing.category_image || '').trim();
            if (hasImg && !existingHasImg) {
                seen.set(key, r);
            }
        }

        // Sort: featured first, then alphabetical, then by id for stability.
        const sorted = Array.from(seen.values()).sort((a, b) => {
            const af = Number(a.is_featured) || 0;
            const bf = Number(b.is_featured) || 0;
            if (af !== bf) { return bf - af; }
            const an = String(a.name || '').toLowerCase();
            const bn = String(b.name || '').toLowerCase();
            if (an !== bn) { return an < bn ? -1 : 1; }
            return Number(a.id) - Number(b.id);
        });

        const categories = sorted.slice(0, limit).map(r => {
            // Display the cleaned-up canonical form (singular, no
            // trailing translation) so the pill reads tidily even
            // when the merchant stored "Burger / برغر" or "BURGERS".
            const norm    = normaliseName(r.name);
            const cleaned = titleCase(norm);
            return {
                id:         String(r.id),
                name:       cleaned,
                // The KEY the search endpoint also uses to match this
                // pill. Stamped on the rendered <a> as data-search-name
                // so the home-page search filter doesn't need a name
                // round-trip — it just checks "is my data-search-name
                // in the api's returned categoryNames set?".
                searchName: norm,
                slug:       M.slugify(cleaned, r.id),
                // icon === null  → view renders the initial-letter
                //                  placeholder over the brand tint.
                // icon === url   → view renders <img src>.
                icon:       mapIcon(r.category_image, r.company_id),
                initial:    M.initialFor(cleaned),
                tint:       M.tintFor(r.id),
            };
        });

        return H.successResponse(res, { categories });
    } catch (err) {
        H.log.error('marketplace.categories.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list };
