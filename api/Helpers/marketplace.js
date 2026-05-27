'use strict';

/*
 * Helpers/marketplace.js
 *
 * What:  Shared normalisers used by every marketplace dashboard
 *        endpoint (restaurants, products, …). One place for all the
 *        "DB row → public view object" rules so the front-end shape
 *        stays stable as we add more endpoints.
 *
 *        Provides:
 *          pickPrice(row)            — products price fallback chain
 *          tintFor(seed)             — deterministic pastel for placeholders
 *          initialFor(name)          — single capital letter for placeholder
 *          isBranchOpen(branchRow)   — derive open/closed state
 *          cuisinesFor(companyRow)   — best-effort cuisine tags
 *          slugify(str)              — URL-safe slug
 *          isVegProduct(productRow)  — veg marker (FSSAI convention)
 *
 * Why:   Both /marketplace/restaurants and /marketplace/products need
 *        the same tint + initial + slug rules so the home page reads
 *        coherently. Duplicating those rules per controller would
 *        invite drift (one card with a green tint, another with grey
 *        for the same restaurant) — keeping them here prevents that.
 *
 * Used:  api/Controllers/Marketplace/RestaurantsController.js
 *        api/Controllers/Marketplace/ProductsController.js
 */

/**
 * pickPrice
 *
 * What:  Returns the "best" price for a product row, in priority order:
 *          1. marketplace_price (when > 0)  — the explicit marketplace listing
 *          2. online_platform_price (> 0)   — the existing webordering price
 *          3. price_after_tax (> 0)         — the in-store price
 *          4. 0                             — fallback
 * Why:   Many existing rows haven't been re-priced for marketplace yet
 *        — zero marketplace_price means "use the regular price". Per
 *        the user decision, the dashboard prefers showing SOMETHING
 *        over an embarrassing empty grid.
 * Type:  READ (pure).
 */
function pickPrice(row) {
    if (!row) { return 0; }
    const candidates = [row.marketplace_price, row.online_platform_price, row.price_after_tax];
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) { return Math.round(n * 100) / 100; }
    }
    return 0;
}

/**
 * tintFor
 *
 * What:  Returns a pastel hex colour from a small palette, deterministic
 *        per seed string (or per id). Used as the placeholder
 *        background on every card so they each read differently even
 *        without real photography.
 * Why:   Random tints flicker on every refresh; deterministic ones
 *        feel like a brand colour. The palette was picked to be food-
 *        friendly (warm + soft) and to pop against the white card.
 * Type:  READ (pure).
 */
const TINT_PALETTE = [
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
];
function tintFor(seed) {
    const s = String(seed == null ? '' : seed);
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return TINT_PALETTE[h % TINT_PALETTE.length];
}

/**
 * initialFor
 *
 * What:  First non-space alphanumeric character of a name, uppercased.
 *        Default '?' when the name is empty.
 * Type:  READ (pure).
 */
function initialFor(name) {
    const s = String(name || '').trim();
    if (!s) { return '?'; }
    const ch = s.replace(/[^A-Za-z0-9]/g, '').charAt(0);
    return (ch || '?').toUpperCase();
}

/**
 * isBranchOpen
 *
 * What:  Returns true when the branch's closed-window has expired
 *        (closed_until is in the past OR null) AND `open_as_usual`
 *        isn't explicitly off. The wtw_eatndeal schema uses two
 *        signals together — we honour both.
 *
 *        Note: `closed_until` is `timestamp without time zone` in the
 *        live DB. JS Date treats it as local time on parse — fine
 *        since we set the pool's timezone to UTC at connect.
 * Type:  READ.
 */
function isBranchOpen(branch) {
    if (!branch) { return false; }
    // `open_as_usual` is an integer flag (1 = open). Treat 0 / null as
    // "use closed_until to decide" rather than "definitely closed" —
    // the field isn't always set.
    if (Number(branch.open_as_usual) === 0 && branch.closed_until) {
        const until = Date.parse(branch.closed_until);
        if (Number.isFinite(until) && until > Date.now()) { return false; }
    }
    return true;
}

/**
 * cuisinesFor
 *
 * What:  Returns an array of cuisine tags to show under the restaurant
 *        name. Best-effort — the wtw_eatndeal schema doesn't have a
 *        proper cuisine table, so we infer from the free-text
 *        `business_category` field. Splits on slashes / commas / pipes
 *        / dots and trims everything.
 *        Falls back to ['Restaurant'] when the field is empty.
 * Type:  READ (pure).
 */
function cuisinesFor(company) {
    const raw = String((company && company.business_category) || '').trim();
    if (!raw) { return ['Restaurant']; }
    const parts = raw.split(/[\/,|·•]+/).map(p => p.trim()).filter(Boolean);
    return parts.length ? parts.slice(0, 3) : ['Restaurant'];
}

/**
 * slugify
 *
 * What:  URL-safe slug from a name. Falls back to "restaurant-<id>" when
 *        the name is empty. Used when company.domain_name is missing.
 * Type:  READ (pure).
 */
function slugify(str, fallbackId) {
    const s = String(str || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    if (s) { return s; }
    return fallbackId != null ? 'restaurant-' + fallbackId : 'restaurant';
}

/**
 * isVegProduct
 *
 * What:  Reads the `veg_non_veg` column. In the existing Yii schema
 *        the convention is:
 *          1 = veg
 *          2 = non-veg
 *          3 = egg / contains animal product but not meat
 *        We treat 1 as veg, everything else as non-veg.
 * Type:  READ (pure).
 */
function isVegProduct(product) {
    return Number(product && product.veg_non_veg) === 1;
}

/**
 * yiiImageUrl
 *
 * What:  Builds the public URL for an image stored under the Yii2
 *        backend uploads tree on disk. Schema only stores the bare
 *        filename (e.g. "1941362425.jpg") — to actually load it we
 *        need to prepend:
 *           <url-prefix> / <company_id> / <sub-folder> / <filename>
 *
 *        Sub-folder names are FIXED in the Yii admin code, so we map
 *        an internal "type" to its known folder name here. To
 *        relocate the entire uploads tree (e.g. behind a CDN or onto
 *        another host), only the env var `YII_UPLOADS_URL` needs to
 *        change — controllers stay unchanged.
 *
 *        Disk layout reference (D:\…\eatndealclean\backend\web\uploads\):
 *           <company_id>/products/<file>      ← type='product'
 *           <company_id>/category/<file>      ← type='category'  (singular!)
 *           <company_id>/banner_image/<file>  ← type='banner'    (branch banner)
 *           <company_id>/branch_logos/<file>  ← type='logo'      (branch logo / business_image fallback)
 *
 *        Returns null when any required piece (filename, companyId,
 *        unknown type) is missing — the front-end placeholder shows
 *        through unchanged.
 *
 * Why:   Coding-Conventions style — one helper, one env knob.
 *        Without this every controller would hand-roll the prefix
 *        and we'd drift the moment the Yii layout changes.
 *
 * Used:  RestaurantsController / ProductsController / CategoriesController.
 * Env:   YII_UPLOADS_URL — defaults to '/yii-uploads' (the route the
 *        web server publishes the on-disk folder under — see
 *        web/index.js express.static config).
 */
const YII_FOLDERS = {
    product:  'products',
    category: 'category',
    banner:   'banner_image',
    logo:     'branch_logos',
};
function yiiImageUrl(type, companyId, filename) {
    const raw = String(filename || '').trim();
    if (!raw) { return null; }
    // If the DB already stored a full URL (legacy rows that bypassed
    // the upload helper), pass it through unchanged.
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) { return raw; }

    const sub = YII_FOLDERS[type];
    if (!sub || !companyId) { return null; }
    const base = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
    return base + '/' + companyId + '/' + sub + '/' + raw;
}

/**
 * normaliseName
 *
 * What:   Canonical lowercase key for a category / restaurant / product
 *         name. Used:
 *           • CategoriesController dedupe (so "Burger" + "Burgers" +
 *             "Burger / برغر" collapse to one pill)
 *           • SearchController matching (so the live filter matches the
 *             same key the rendered cuisine pill carries in
 *             data-search-name)
 *
 *         Pipeline:
 *           1. lowercase
 *           2. drop everything after the first "/" (strips the trailing
 *              bilingual half like "Burger / برغر")
 *           3. strip non-ASCII alpha (so Arabic / accents disappear)
 *           4. collapse whitespace
 *           5. strip trailing "es" / "s" so plurals collapse
 *           6. trim
 *
 *         Returns an empty string for pure-punctuation input — callers
 *         should treat that as "no usable key" and skip the row.
 *
 * Why:    One source of truth means dedupe and search never drift —
 *         if "Burgers" collapses to "burger" on the pill, the search
 *         endpoint also sees "burger" and the two stay in sync.
 * Type:   READ (pure).
 */
function normaliseName(raw) {
    return String(raw || '')
        .toLowerCase()
        .split('/')[0]
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(es|s)$/, '');
}

module.exports = {
    pickPrice,
    tintFor,
    initialFor,
    isBranchOpen,
    cuisinesFor,
    slugify,
    isVegProduct,
    yiiImageUrl,
    normaliseName,
};
