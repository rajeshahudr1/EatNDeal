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
 *          3. price_after_tax (> 0)         — the in-store / base price
 *          4. 0                             — fallback (genuinely no price)
 *
 * Why:   Many existing rows haven't been re-priced for marketplace yet.
 *        Falling back to the regular base price keeps the catalog full
 *        instead of blanking out 28% of dishes; rows where every column
 *        is 0 surface as £0.00 — the customer sees the price for what
 *        it is and the add-to-cart guard still blocks the line.
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
 * applyProductDiscount
 *
 * What:  Reduces a unit price by the product's own discount — EXACT legacy
 *        webordering rule (CartController::actionAdd lines 711-720):
 *          discount_type 1 = flat £ off  → price − discount_value
 *          discount_type 2 = % off       → price − price·value/100
 *          anything else / value ≤ 0     → no discount
 *        Never below 0. discount_type/discount_value live on products.
 * Type:  READ (pure).
 */
function applyProductDiscount(price, row) {
    const base  = Number(price) || 0;
    const type  = Number(row && row.discount_type) || 0;
    const value = Number(row && row.discount_value) || 0;
    if (value <= 0 || base <= 0) { return base; }
    let net = base;
    if (type === 1)      { net = base - value; }
    else if (type === 2) { net = base - (base * value / 100); }
    if (net < 0) { net = 0; }
    return Math.round(net * 100) / 100;
}

/**
 * discountedPrice — pickPrice with the product discount applied, plus the
 * original (for the struck-through display). { original, final, hasDiscount,
 * discountType, discountValue }.
 * Type:  READ (pure).
 */
function discountedPrice(row) {
    const original = pickPrice(row);
    const final    = applyProductDiscount(original, row);
    return {
        original,
        final,
        hasDiscount:   final < original,
        discountType:  Number(row && row.discount_type) || 0,
        discountValue: Number(row && row.discount_value) || 0,
    };
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

/**
 * clockMinutes
 *
 * What:   "HH:MM[:SS]" → minutes-of-day (0..1439), or null when there's
 *         no parseable HH:MM. Used for the open/closed clock check.
 * Type:   READ (pure).
 */
function clockMinutes(t) {
    if (!t) { return null; }
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) { return null; }
    return (parseInt(m[1], 10) % 24) * 60 + parseInt(m[2], 10);
}

/**
 * isOpenNow
 *
 * What:   True when the branch is accepting orders RIGHT NOW: the
 *         closed-flag check (isBranchOpen) passes AND the current time
 *         falls inside the branch's daily window (start_time–end_time).
 *         Handles overnight windows (e.g. 18:00–02:00). When no usable
 *         hours are stored, falls back to the flag result (open).
 * Type:   READ (clock).
 */
function isOpenNow(branch) {
    if (!isBranchOpen(branch)) { return false; }
    const open  = clockMinutes(branch && branch.start_time);
    const close = clockMinutes(branch && branch.end_time);
    if (open == null || close == null || open === close) { return true; }
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    return close > open ? (mins >= open && mins < close)   // same-day window
                        : (mins >= open || mins < close);  // crosses midnight
}

/**
 * normalisePostcode
 *
 * What:   Uppercase + strip everything except A-Z0-9 so "ab56 1ah" and
 *         "AB561AH" compare equal. Used to match a customer postcode
 *         against a branch's configured delivery zones.
 * Type:   READ (pure).
 */
function normalisePostcode(pc) {
    return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * loadActiveBranch
 *
 * What:  Returns the canonical row for ONE branch id, joined to its
 *        company, with the marketplace-eligibility scope chain applied.
 *        Used by every endpoint that touches a cart's branch — cart
 *        get/set-mode/set-address, order place, payment intent, webhook.
 *        Returns null when the branch is missing / soft-deleted / its
 *        company is offline.
 *
 *        Centralises the 4-line eligibility chain that was duplicated
 *        across 7 controllers — single source of truth.
 * Type:  READ.
 *
 * Usage: const branch = await M.loadActiveBranch(cart.branch_id);
 *        if (!branch) return H.errorResponse(res, 'Restaurant unavailable.', 404);
 */
async function loadActiveBranch(branchId) {
    const { db } = require('../config/db');
    if (!branchId) { return null; }
    const row = await db('branch as b')
        .innerJoin('company as c', 'c.id', 'b.company_id')
        .where('b.id', branchId)
        .modify(eligibleCompanyScope, 'c')
        .modify(eligibleBranchScope,  'b')
        .first('b.*');
    return row || null;
}

/**
 * matchDeliveryZone
 *
 * What:   Given a customer postcode and a branch's delivery zones
 *         (rows from store_delivery_charge_setup), returns the BEST
 *         matching zone or null. A zone matches when the (normalised)
 *         customer postcode starts with the (normalised) zone postcode
 *         — UK zones are configured as prefixes ("BB2"), outward+sector
 *         ("SE1 6") or full codes ("B126AA"). When several match, the
 *         most specific (longest zone string) wins.
 * Type:   READ (pure).
 */
function matchDeliveryZone(customerPostcode, zones) {
    const cust = normalisePostcode(customerPostcode);
    if (!cust || !Array.isArray(zones) || !zones.length) { return null; }
    let best = null, bestLen = -1;
    for (const z of zones) {
        const zp = normalisePostcode(z.postcode);
        if (zp && cust.indexOf(zp) === 0 && zp.length > bestLen) { best = z; bestLen = zp.length; }
    }
    return best;
}

/**
 * deliveryMinutesFromWaiting
 *
 * What:   Parses a branch.delivery_waiting_time / pickup_waiting_time
 *         value into whole minutes. Matches the legacy webordering
 *         formula EXACTLY (see common/Commonquery::displayRealOrderTime):
 *
 *             total_min  =  (last_part as MINUTES)
 *                        +  (middle_part as HOURS × 60)
 *
 *         i.e. the PHP code does `date('s', strtotime($t))` for the last
 *         field and `date('i', strtotime($t)) * 60` for the middle field.
 *         The legacy admin form stores values as `day:hour:minute`, and
 *         after PHP's strtotime re-reads it as HH:MM:SS, the admin's
 *         minutes end up in the seconds slot and the admin's hours end
 *         up in the minutes slot. Reading the LAST field as minutes and
 *         the MIDDLE field as hours rebuilds the admin's intent.
 *
 *         Examples that match the legacy renderer:
 *           "0:0:25"   → 25 min            (admin set 25 min)
 *           "0:1:0"    → 60 min            (admin set 1 hour)
 *           "0:1:30"   → 90 min
 *           "00:00:20" → 20 min            (real EatNDeal row)
 *           "00:00:00" → null              (unset)
 *           "00:30"    → 30 min            (legacy two-part: H:M)
 *           "45"       → 45 min            (bare integer)
 *
 *         Days (the leading field on three-part values) are intentionally
 *         dropped — matches legacy displayRealOrderTime.
 *
 * Type:   READ (pure).
 */
/**
 * eligibleCompanyScope
 *
 * What:  Adds the standard "company is a live marketplace tenant" filter
 *        to a Knex query — used by RestaurantsController.list/detail,
 *        ProductsController.list, FavouriteController.list, SearchController,
 *        OffersController, etc. so they all share one definition of
 *        eligibility:
 *
 *           c.is_marketplace = 1
 *           c.is_active      = 1
 *           c.deleted_at IS NULL
 *           (c.is_maintenance = 0 OR c.is_maintenance IS NULL)
 *
 *        Usage (inside a Knex builder):
 *           db('company as c')
 *             .modify(M.eligibleCompanyScope, 'c')
 *             .select(...);
 *
 *        The `alias` argument (default 'c') lets callers name the table
 *        whatever they want; the filter qualifies its columns.
 * Type:  READ (query-builder modifier).
 */
function eligibleCompanyScope(qb, alias) {
    const a = alias || 'c';
    qb.where(a + '.is_marketplace', 1)
      .andWhere(a + '.is_active', 1)
      .whereNull(a + '.deleted_at')
      .andWhere(function () { this.where(a + '.is_maintenance', 0).orWhereNull(a + '.is_maintenance'); });
}

/**
 * eligibleBranchScope
 *
 * What:  Companion to eligibleCompanyScope — adds the branch-side filter
 *        (`b.status <> '2'` = not soft-deleted). Usually called alongside
 *        eligibleCompanyScope on every join that includes branches.
 * Type:  READ (query-builder modifier).
 */
function eligibleBranchScope(qb, alias) {
    const a = alias || 'b';
    qb.andWhere(a + '.status', '<>', '2');
}

/**
 * avgRatingSubq
 *
 * What:  Correlated subquery that yields a company's average published
 *        review rating (1-dp) as `avg_rating`, or NULL when it has no
 *        reviews. toRestaurantCard reads `row.avg_rating`, so EVERY card
 *        query (home grid, favourites rail, account favourites…) must
 *        SELECT this — otherwise the card silently shows no rating even
 *        for a restaurant that has reviews.
 * Why:   One definition so a new card surface can't forget it (the
 *        favourites rail did, which hid real ratings).
 * Type:  READ (query fragment). `alias` is the company table alias.
 */
function avgRatingSubq(dbi, alias) {
    const a = alias || 'c';
    return dbi.raw(
        `(SELECT ROUND(AVG(rr.rating)::numeric, 1)
            FROM review_rating rr
           WHERE rr.company_id = ${a}.id
             AND rr.publish_online = 1) AS avg_rating`
    );
}

/**
 * toRestaurantCard
 *
 * What:  Canonical (company,branch) row → public card shape. ONE definition
 *        of "what a restaurant card looks like" so every surface that
 *        renders cards (home grid, favourites rail, account favourites,
 *        future search results, pickup map) shares the exact same fields.
 *
 *        Was previously duplicated across:
 *          • RestaurantsController.list   (inline map)
 *          • FavouriteController.list     (parallel mapper with subtle
 *                                          differences — drift risk).
 *
 *        Caller supplies the joined DB row (with company + branch
 *        columns) plus a small opts bag for things the DB row doesn't
 *        carry (customer location, pre-computed time labels, favourite
 *        state, offer summaries, postcode zone).
 *
 *        Required columns on `row`:
 *          c.id (company_id), c.business_name, c.domain_name,
 *          c.business_category,
 *          b.id (branch_id), b.banner_image, b.business_image,
 *          b.direction_latitude, b.direction_longitude,
 *          b.start_time, b.end_time, b.open_as_usual, b.closed_until,
 *          b.delivery_waiting_time, b.pickup_waiting_time   (for time labels)
 *
 *        opts:
 *          lat, lng              — customer coords (for distance)
 *          times                 — { delivery, pickup } strings from
 *                                   OrderTime.computeForBranches
 *          isFavourite           — bool
 *          offer / offerCount    — strings from Offers.offerSummaries
 *          zone                  — matched delivery zone row (from
 *                                   store_delivery_charge_setup) when
 *                                   the user supplied a postcode
 *
 * Why:   Cards stay visually consistent across pages even when one
 *        controller adds a new field — adding `rating_count` here once
 *        means it appears everywhere.
 * Type:  READ (pure).
 */
function toRestaurantCard(row, opts) {
    opts = opts || {};
    const distance = require('./distance');

    // Tolerate either { c.id as company_id, b.id as branch_id } aliasing
    // OR the raw column names — callers vary.
    const companyId  = row.company_id || row.id;
    const branchId   = row.branch_id || row.bid || null;
    const businessName = row.business_name || row.company_name || row.branch_trading_name || row.branch_name || '';
    const name = String(businessName).trim();

    const lat = opts.lat, lng = opts.lng;
    const branchLat = row.branch_lat != null ? row.branch_lat : row.direction_latitude;
    const branchLng = row.branch_lng != null ? row.branch_lng : row.direction_longitude;
    const km = distance.kmBetween(lat, lng, branchLat, branchLng);

    const times = opts.times || { delivery: null, pickup: null };
    const zone  = opts.zone || null;

    const avgRating = row.avg_rating != null ? Number(row.avg_rating) : null;

    // Veg classification — only available when the caller pre-computed
    // the EXISTS flags (used on the main grid; favourites skips it).
    let vegType = null;
    if (row.has_veg != null || row.has_non_veg != null) {
        if (row.has_veg && !row.has_non_veg)       { vegType = 'pure-veg'; }
        else if (row.has_non_veg)                  { vegType = 'non-veg';  }
    }

    return {
        id:               String(companyId),
        branchId:         branchId ? String(branchId) : null,
        slug:             row.domain_name ? slugify(row.domain_name) : slugify(name, companyId),
        name,
        cuisines:         cuisinesFor({ business_category: row.business_category }),
        rating:           avgRating,   // null when no published reviews — UI hides the badge (no fake number)
        isOpen:           isOpenNow(row),
        tint:             tintFor(companyId),
        initial:          initialFor(name),
        distanceKm:       km != null ? km : null,
        deliveryMinutes:  times.delivery,
        pickupMinutes:    times.pickup,
        image:            yiiImageUrl('banner', companyId, row.banner_image)
                          || yiiImageUrl('logo', companyId, row.business_image)
                          || null,
        isFavourite:      !!opts.isFavourite,
        // Optional bits — only populated when the caller passed them.
        offer:            opts.offer || null,
        offerCount:       opts.offerCount || 0,
        vegType,
        lat:              branchLat != null && branchLat !== '' ? Number(branchLat) : null,
        lng:              branchLng != null && branchLng !== '' ? Number(branchLng) : null,
        deliverable:      opts.postcode ? !!zone : true,
        deliveryFee:      zone ? Number(zone.charge) : null,
        minOrder:         zone ? Number(zone.minimum_order) : null,
        freeDeliveryOver: zone ? Number(zone.free_delivery_above) : null,
    };
}

function deliveryMinutesFromWaiting(val) {
    if (val == null || val === '') { return null; }
    const s = String(val).trim();
    if (/^\d+$/.test(s)) { const n = parseInt(s, 10); return n > 0 ? n : null; }
    const parts = s.split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) { return null; }
    let mins = 0;
    if (parts.length === 3)      { mins = parts[2] + parts[1] * 60; }   // D:H:M → minutes + hours×60
    else if (parts.length === 2) { mins = parts[1] + parts[0] * 60; }   // H:M  → minutes + hours×60
    else                         { mins = parts[0]; }
    return mins > 0 ? mins : null;
}

module.exports = {
    pickPrice,
    applyProductDiscount,
    discountedPrice,
    tintFor,
    initialFor,
    isBranchOpen,
    isOpenNow,
    normalisePostcode,
    matchDeliveryZone,
    deliveryMinutesFromWaiting,
    cuisinesFor,
    slugify,
    isVegProduct,
    yiiImageUrl,
    normaliseName,
    eligibleCompanyScope,
    eligibleBranchScope,
    avgRatingSubq,
    loadActiveBranch,
    toRestaurantCard,
};
