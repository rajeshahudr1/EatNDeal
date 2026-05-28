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
        const limit  = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit))) : 50;
        const parent = req.query.parent ? String(req.query.parent).trim().toLowerCase() : null;

        // The marketplace category model is now a flat GLOBAL list
        // (mp_marketplace_category) — there are no sub-categories, so
        // a ?parent= drill-down has nothing to return.
        if (parent) { return H.successResponse(res, { categories: [] }); }

        // Read the global marketplace category master. Active rows
        // only, ordered by the admin-set sort_order.
        //
        // Restaurants-only gate: a category surfaces on the home rail
        // ONLY when at least one LIVE marketplace company is assigned
        // to it (mp_marketplace_category_assign → company). An empty
        // category would tap through to a blank feed, so we hide it —
        // "category aayegi usper jis me restaurant ho > 0".
        const rows = await db('mp_marketplace_category as mc')
            .select('mc.id', 'mc.name', 'mc.slug', 'mc.icon', 'mc.image', 'mc.sort_order')
            .where('mc.status', 1)
            .whereExists(function () {
                this.select(db.raw('1'))
                    .from('mp_marketplace_category_assign as mca')
                    .innerJoin('company as co', 'co.id', 'mca.company_id')
                    .whereRaw('mca.category_id = mc.id')
                    .andWhere('co.is_marketplace', 1)
                    .andWhere('co.is_active', 1)
                    .whereNull('co.deleted_at');
            })
            .orderBy([{ column: 'mc.sort_order', order: 'asc' }, { column: 'mc.id', order: 'asc' }])
            .limit(limit);

        // Treat a value as an image/icon PATH (→ render as <img>) when
        // it looks like a URL, an absolute path, or a filename with an
        // extension. An emoji ("🍕") matches none of these → it's
        // rendered as text in the initial slot instead.
        const isPath = (s) => !!s && (s.indexOf('/') !== -1 || /\.[a-z0-9]{2,5}$/i.test(s) || s.indexOf('http') === 0);

        const categories = rows.map(r => {
            const name  = String(r.name  || '').trim();
            const image = String(r.image || '').trim();
            const icon  = String(r.icon  || '').trim();

            // ── Condition: IMAGE first, then ICON ──────────────────
            //   1. image present (a real path)  → show the image
            //   2. else icon is a path          → show the icon image
            //   3. else icon is an emoji        → show it as text
            //   4. else                         → first-letter fallback
            let viewIcon    = null;                 // non-null → view renders <img src>
            let viewInitial = M.initialFor(name);   // shown when viewIcon is null
            if (isPath(image))      { viewIcon = image; }
            else if (isPath(icon))  { viewIcon = icon; }
            else if (icon)          { viewInitial = icon; }   // emoji → text

            return {
                id:         String(r.id),
                name,
                searchName: M.normaliseName(name),
                slug:       r.slug || M.slugify(name, r.id),
                icon:       viewIcon,
                initial:    viewInitial,
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
