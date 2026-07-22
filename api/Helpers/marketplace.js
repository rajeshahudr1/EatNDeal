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

const F = require('./format');
const H = require('./helper');

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
function tintFor(seed) {
    return F.tintFor(seed);
}

/**
 * initialFor
 *
 * What:  First non-space alphanumeric character of a name, uppercased.
 *        Default '?' when the name is empty.
 * Type:  READ (pure).
 */
function initialFor(name) {
    return F.initialFor(name);
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
    return F.restaurantSlug(str, fallbackId);
}

/**
 * isVegProduct
 *
 * What:  Reads the `veg_non_veg` column. The POS "Food Type" dropdown
 *        (backend/modules/pos/views/products/_form.php) stores:
 *          0 = not set / Select
 *          1 = Non-Vegetarian
 *          2 = Vegetarian
 *          3 = Gluten Free      (an allergen tag, NOT a veg/non-veg class)
 *          4 = Vegan
 *        "Veg" for our purposes = Vegetarian OR Vegan (2 or 4). Used by the
 *        veg-only filters. (Earlier this checked `=== 1`, which is the exact
 *        OPPOSITE — 1 is NON-veg — so the veg filter was inverted.)
 * Type:  READ (pure).
 */
function isVegProduct(product) {
    const v = Number(product && product.veg_non_veg);
    return v === 2 || v === 4;
}

/**
 * vegMarker
 *
 * What:  Food-Type marker for a product card, mapped from the POS Food Type
 *        value (see isVegProduct for the full enum). Each type gets its OWN
 *        marker so Vegan / Gluten Free read distinctly (old EatNDeal only had
 *        a text label and lumped everything non-1 into "Vegetarian"):
 *          2 (Vegetarian)     → 'veg'          (green dot)
 *          1 (Non-Vegetarian) → 'non-veg'      (red triangle)
 *          4 (Vegan)          → 'vegan'         (green leaf)
 *          3 (Gluten Free)    → 'gluten-free'   (amber "GF")
 *          0 (not set)        → null            (no marker)
 *        Callers that only care about veg-vs-not use isVegProduct instead.
 * Type:  READ (pure).
 */
function vegMarker(product) {
    const v = Number(product && product.veg_non_veg);
    if (v === 2) { return 'veg'; }
    if (v === 1) { return 'non-veg'; }
    if (v === 4) { return 'vegan'; }
    if (v === 3) { return 'gluten-free'; }
    return null;
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
 *           <company_id>/branch/<file>        ← type='logo'      (branch logo = business_image)
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
    // VERIFIED: branch logos (business_image) live in the "<companyId>/branch"
    // folder on disk, NOT "branch_logos" — the latter 404s and the front-end
    // falls back to the tinted-initial placeholder. Confirmed against the live
    // uploads tree (…/uploads/1/branch/branch_1_*.jpg) and cross-checked with
    // mailer.restaurantLogoUrl + StoreSettingsController's imgUrl('branch', …).
    logo:     'branch',
    // Surprise Box ("Too Good To Go") photo. VERIFIED against the admin's own
    // reader (Admin/StoreSettingsController imgUrl('surprise_image', …)) — the
    // folder is `surprise_image`, matching the column name, NOT `discount`
    // (which is what the `discount_<company>_<ts>.jpg` FILENAME suggests, and
    // which 404s). The sibling discount_icon lives in `discount_logos`.
    surprise: 'surprise_image',
};
function yiiImageUrl(type, companyId, filename) {
    const raw = String(filename || '').trim();
    if (!raw) { return null; }
    // Already a full URL → unchanged; a "/upload/…" path → made absolute
    // against the api (H.mediaUrl); any other "/path" → unchanged.
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) { return H.mediaUrl(raw); }

    const sub = YII_FOLDERS[type];
    if (!sub || !companyId) { return null; }
    const base = H.getUploadsBaseUrl();
    const url  = base + '/' + companyId + '/' + sub + '/' + raw;
    // Cache-bust: append ?v=<upload-timestamp> pulled from the Yii filename
    // (e.g. banner_1_1783518678.jpeg → 1783518678). The filename already
    // changes per upload, so this is belt-and-suspenders — it forces a fresh
    // fetch through browser / CDN / proxy caches even for a same-name overwrite
    // the moment the stored value changes. No timestamp in the name → no param.
    const m = raw.match(/_(\d{9,})(?:\.|_|$)/);
    return m ? (url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + m[1]) : url;
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
 * companyIdBySlug
 *
 * What:  Resolve a public restaurant SLUG (e.g. "eatndeal1neutrovegcom") to its
 *        company id, using the SAME rule the restaurant detail page uses:
 *        slugify(domain_name), falling back to slugify(business_name, id).
 *        Returns null when nothing matches / the company isn't eligible.
 * Why:   Lets customer-facing URLs carry the slug instead of leaking the raw
 *        numeric company id (e.g. /earn?restaurant=<slug>).
 * Type:  READ.
 */
async function companyIdBySlug(slug) {
    const want = String(slug || '').trim().toLowerCase();
    if (!want) { return null; }
    const { db } = require('../config/db');
    const cands = await db('company as c')
        .modify(eligibleCompanyScope, 'c')
        .select('c.id', 'c.business_name', 'c.domain_name');
    const hit = cands.find((c) => (c.domain_name ? slugify(c.domain_name) : slugify(c.business_name, c.id)) === want);
    return hit ? hit.id : null;
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
        // Fulfilment modes the restaurant OFFERS (config-level) — a mode counts
        // as offered unless it's been permanently turned off (show_*_option = 0
        // AND *_tab = 3). Defaults to true when the caller's row didn't select
        // the option columns. Lets EVERY surface (home curated rows, offers,
        // collections, favourites…) filter by the header Delivery/Pickup mode.
        offersDelivery:   !(Number(row.show_delivery_option) === 0 && Number(row.show_delivery_option_tab) === 3),
        offersPickup:     !(Number(row.show_pickup_option)   === 0 && Number(row.show_pickup_option_tab)   === 3),
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
    vegMarker,
    yiiImageUrl,
    normaliseName,
    eligibleCompanyScope,
    eligibleBranchScope,
    companyIdBySlug,
    avgRatingSubq,
    loadActiveBranch,
    toRestaurantCard,
};
