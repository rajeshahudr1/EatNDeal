'use strict';

/**
 * Controllers/SiteController.js
 *
 * What:   Renders the public landing page of the EatNDeal Marketplace.
 *         Phase-0 scope: ONE landing page with header, hero, cuisines,
 *         featured restaurants, "how it works", and footer. Login + sign-up
 *         are entry points in the header (not separate pages yet), and a
 *         full-screen location modal opens on the user's first visit.
 * Why:    Food-delivery convention (Zomato, Swiggy, Foodhub) — the landing
 *         page is browsable WITHOUT login. The user picks a location first,
 *         then sees restaurants. Auth only kicks in at checkout.
 * Type:   READ.
 * Inputs: req, res.
 * Output: rendered HTML (views/site/index.ejs inside views/_layout.ejs).
 * Used:   GET /  (wired in web/index.js).
 *
 * Change log:
 *   2026-05-25 — initial landing-page action; data still placeholder until
 *                /restaurants + /cuisines API endpoints are built.
 */

const { callApi } = require('../Helpers/apiClient');

/**
 * fetchMarketplace
 *
 * What:   Calls GET /api/v1/marketplace/restaurants AND /products in
 *         parallel using the user's saved lat/lng. Returns
 *         { featured, for_you } on success.
 * Why:    Both rails on the homepage are live now — the api owns
 *         filtering by company.is_marketplace=1, the price-fallback
 *         chain, distance + delivery-time, etc. We keep a small JS
 *         layer here only for the apiClient call.
 * Type:   READ (network).
 *
 * Inputs: req, lat, lng
 * Output: { featured, for_you } — arrays of view-ready cards.
 *         On error any array can be null; the caller decides how to
 *         fall back.
 */
async function fetchMarketplace(req, lat, lng, cuisine, filters, postcode) {
    filters = filters || {};

    // Build per-endpoint query strings — the validator rejects
    // unknown fields, so categories can't see e.g. ?rating= and
    // products can't see ?max_km=. The base block (lat/lng/cuisine)
    // is shared.
    // Signed-in customer (if any) → forwarded to the api so cards
    // come back with `isFavourite` already painted. Guests omit it.
    const sessUser = (req.session && req.session.user) || null;
    const customerId = sessUser && sessUser.id ? String(sessUser.id) : null;

    function baseQs() {
        const qs = new URLSearchParams();
        if (Number.isFinite(lat)) qs.set('lat', String(lat));
        if (Number.isFinite(lng)) qs.set('lng', String(lng));
        if (cuisine)              qs.set('cuisine', cuisine);
        if (postcode)             qs.set('postcode', postcode);
        if (customerId)           qs.set('customer_id', customerId);
        return qs;
    }
    // Restaurants: every restaurant-level filter.
    const rqs = baseQs();
    if (filters.sort)     rqs.set('sort',     filters.sort);
    if (filters.rating)   rqs.set('rating',   String(filters.rating));
    if (filters.max_km)   rqs.set('max_km',   String(filters.max_km));
    if (filters.max_min)  rqs.set('max_min',  String(filters.max_min));
    if (filters.open_now) rqs.set('open_now', '1');
    if (filters.veg)      rqs.set('veg',      '1');
    if (filters.offer)    rqs.set('offer',    '1');
    if (filters.price)    rqs.set('price',    filters.price);
    if (filters.delivery) rqs.set('delivery', filters.delivery);
    // Products: dish-level filters only (veg / offer / price /
    // recommended / featured). Sort + rating + km don't apply here.
    const pqs = baseQs();
    if (filters.veg)         pqs.set('veg',         '1');
    if (filters.offer)       pqs.set('offer',       '1');
    if (filters.price)       pqs.set('price',       filters.price);
    if (filters.recommended) pqs.set('recommended', '1');
    if (filters.featured)    pqs.set('featured',    '1');
    // Categories: no filter params — the cuisine strip is the same
    // regardless of which restaurant filters are active.

    const calls = [
        callApi(req, 'GET', '/api/v1/marketplace/restaurants?' + rqs.toString()),
        callApi(req, 'GET', '/api/v1/marketplace/products?'    + pqs.toString()),
        callApi(req, 'GET', '/api/v1/marketplace/categories'),
        callApi(req, 'GET', '/api/v1/marketplace/offers?limit=8'),
    ];
    // Sub-categories only when a cuisine is selected; the curated home FEED
    // (Featured + collection rows) only on the PLAIN home (no cuisine filter —
    // the shelves are a homepage surface, not a filtered result).
    const subIdx  = cuisine ? (calls.push(callApi(req, 'GET', '/api/v1/marketplace/categories?parent=' + encodeURIComponent(cuisine))) - 1) : -1;
    const feedIdx = !cuisine ? (calls.push(callApi(req, 'GET', '/api/v1/marketplace/home-feed?' + baseQs().toString())) - 1) : -1;
    const results = await Promise.all(calls);
    const rRes = results[0], pRes = results[1], cRes = results[2], oRes = results[3];
    const sRes = subIdx  >= 0 ? results[subIdx]  : null;
    const feedRes = feedIdx >= 0 ? results[feedIdx] : null;

    const featured      = (rRes.body && rRes.body.status === 200 && rRes.body.data && rRes.body.data.restaurants) || null;
    const forYou        = (pRes.body && pRes.body.status === 200 && pRes.body.data && pRes.body.data.products)    || null;
    const categories    = (cRes.body && cRes.body.status === 200 && cRes.body.data && cRes.body.data.categories)  || null;
    const subCategories = (sRes && sRes.body && sRes.body.status === 200 && sRes.body.data && sRes.body.data.categories) || [];
    // has_more flags drive the "See more" / "View all" markup. The
    // api returns the flag alongside the row array; we forward it
    // up as-is. Default to false when the response didn't include
    // the field (older api, error path).
    const featuredMore = !!(rRes.body && rRes.body.status === 200 && rRes.body.data && rRes.body.data.has_more);
    const forYouMore   = !!(pRes.body && pRes.body.status === 200 && pRes.body.data && pRes.body.data.has_more);
    // Dynamic filter facet counts (delivery/price/rating/veg/open/offer)
    // computed by the restaurants endpoint over the candidate set. The
    // sidebar renders its badge numbers from these.
    const facets = (rRes.body && rRes.body.status === 200 && rRes.body.data && rRes.body.data.facets) || null;
    const homeOffers = (oRes && oRes.body && oRes.body.status === 200 && oRes.body.data && oRes.body.data.offers) || [];
    // Curated home feed — ordered rows (Featured + collections). Empty when
    // nothing is configured / on a filtered view, so the page is unchanged.
    const homeFeed = (feedRes && feedRes.body && feedRes.body.status === 200 && feedRes.body.data && feedRes.body.data.rows) || [];
    // The admin-configured order of ALL 6 home sections (incl. My Favourites +
    // Top restaurants, which the web renders) — drives the section layout.
    const homeFeedOrder = (feedRes && feedRes.body && feedRes.body.status === 200 && feedRes.body.data && feedRes.body.data.order) || null;
    return {
        featured,
        for_you:        forYou,
        categories,
        sub_categories: subCategories,
        featured_more:  featuredMore,
        for_you_more:   forYouMore,
        facets,
        home_offers:    homeOffers,
        home_feed:      homeFeed,
        home_feed_order: homeFeedOrder,
    };
}

/**
 * reorderCuisinesByPick
 *
 * What:  When the user has selected a cuisine (?cuisine=<name>), move
 *        that pill to the FRONT of the row so it's the first thing
 *        the user sees + already marked active. Other pills keep
 *        their original order behind it. Matches the Zomato/Swiggy
 *        pattern.
 * Type:  WRITE (in-place reorder of a shallow array copy).
 */
function reorderCuisinesByPick(cuisines, pick) {
    if (!cuisines || !cuisines.length || !pick) { return cuisines; }
    const target = String(pick).toLowerCase();
    const list = cuisines.slice();
    const idx = list.findIndex(c => {
        const key = (c.searchName || c.name || '').toLowerCase();
        return key === target || key.indexOf(target) !== -1;
    });
    if (idx > 0) {
        const picked = list.splice(idx, 1)[0];
        list.unshift(picked);
    }
    return list;
}

/**
 * index
 *
 * What:   Renders the landing page. Pulls the user's saved location from the
 *         session (if any) so the location chip in the header shows the
 *         picked area. If no location is set yet, the layout fires the
 *         full-screen location modal client-side via window.boot.needsLocation.
 * Why:    See file header.
 * Type:   READ.
 * Inputs: req — Express request (req.session.userLocation may exist)
 *         res — Express response.
 * Output: Rendered EJS page.
 * Used:   GET / (web/index.js route).
 */
async function index(req, res, next) {
  try {
    // Saved location (object: {label, postcode, lat, lng}) from the location
    // modal. When absent, the front-end JS opens the modal on DOM-ready.
    const userLocation = (req.session && req.session.userLocation) || null;

    // ── Location gate ─────────────────────────────────────────────
    // No saved location yet → render the dedicated location LANDING
    // page (header + footer visible, no promo strip) instead of the
    // restaurant feed. The user picks a postcode / city / shares
    // their location; that saves + reloads into the feed. Matches the
    // "Step 1 of 3 — where do you want to order from?" mockup.
    if (!userLocation) {
        return res.render('site/location', {
            page_title:        'Choose your location',
            _layoutFile:       '../_layout',
            active_nav:        'home',
            extra_js:          '/js/pages/location-page.js',
            user_location:     null,
            show_promo_strip:  false,   // remove the offer row on the gate
            is_location_page:  true,    // layout skips the modal + auto-open
        });
    }

    // Active cuisine filter from the URL (?cuisine=burger). Empty
    // when the user is on the unfiltered home page. We forward this
    // to the api so the products + restaurants come back already
    // filtered — much simpler than re-filtering client-side, and the
    // user can share / refresh the URL without losing the state.
    const cuisine = String((req.query && req.query.cuisine) || '').trim().toLowerCase();

    // `?from=search` is the marker the search overlay appends when
    // the user picked a category from the typed-results list. We use
    // it to decide whether to MOVE the selected pill to position 0
    // (search-driven → yes, surfaces the result the user typed) or
    // leave it where it is (direct pill click → no, the user already
    // sees the pill at its current spot and a jump would feel jarring).
    const fromSearch = String((req.query && req.query.from) || '').trim().toLowerCase() === 'search';

    // ── View modes ────────────────────────────────────────────────
    // The home page doubles as the entry point for two "browse all"
    // surfaces accessed via the section heads' View all / See all
    // links and via the restaurant-card href:
    //
    //   /?view=restaurants — full vertical grid of every restaurant
    //                        (no cuisine strip / no For You). Used
    //                        when the user taps the section-head
    //                        "View all" on Popular near you.
    //   /?view=cuisines   — full grid of every category
    //                        (no restaurants / no For You). Used by
    //                        the cuisine-row "See all" link.
    //   /?restaurant=<slug> — single restaurant focus. The page
    //                        shows that one card + every product
    //                        from that restaurant underneath. Used
    //                        when the user clicks a restaurant card.
    //
    // Mutually exclusive — the first one set wins. Empty / unknown
    // values fall through to the default home layout.
    const rawView   = String((req.query && req.query.view)       || '').trim().toLowerCase();
    const restaurantSlug = String((req.query && req.query.restaurant) || '').trim().toLowerCase();
    const productId      = String((req.query && req.query.product)    || '').trim();
    // Clean product URL: ?rest=<restaurant-slug>&item=<product-slug>
    // (no numeric id in the URL). `product` id kept as a fallback.
    const itemSlug       = String((req.query && req.query.item)       || '').trim();
    const restScopeSlug  = String((req.query && req.query.rest)       || '').trim();
    let viewMode = '';
    if (restaurantSlug)                                            { viewMode = 'restaurant'; }
    else if (itemSlug || productId)                                { viewMode = 'product'; }
    else if (rawView === 'restaurants' || rawView === 'cuisines')  { viewMode = rawView; }

    // ── Delivery vs Pickup ────────────────────────────────────────
    // The header toggle navigates with ?mode=pickup / no param. Query
    // wins; else fall back to the saved mode; default delivery. We
    // persist the choice onto the saved location so the toggle stays
    // in sync across navigations. Pickup swaps the default home feed
    // for the map+list view (handled below + in the template); it does
    // NOT affect the focused view modes (?view= / ?restaurant=).
    let orderMode = String((req.query && req.query.mode) || '').trim().toLowerCase();
    if (orderMode !== 'pickup' && orderMode !== 'delivery') {
        orderMode = (userLocation && userLocation.mode === 'pickup') ? 'pickup' : 'delivery';
    }
    if (req.session && req.session.userLocation && req.session.userLocation.mode !== orderMode) {
        req.session.userLocation.mode = orderMode;
    }
    const isPickup = orderMode === 'pickup' && !viewMode;

    // ── Phase-2 filter params from the URL ────────────────────────
    // Read each filter the sidebar/sheet can set. The whole object
    // is forwarded as-is to fetchMarketplace and to the api.
    // Empty/invalid values are coerced to falsy so they're dropped
    // before hitting the api (keeps the url tidy + the Joi schema
    // happy).
    const q = req.query || {};
    const allowedSort = ['relevance', 'distance', 'rating', 'time', 'price-asc', 'price-desc'];
    const allowedPrice = ['low', 'mid', 'high'];
    const filters = {
        sort:        allowedSort.indexOf(String(q.sort || '')) !== -1 ? String(q.sort) : '',
        rating:      q.rating  && !isNaN(Number(q.rating))  ? Number(q.rating)  : '',
        max_km:      q.max_km  && !isNaN(Number(q.max_km))  ? Number(q.max_km)  : '',
        max_min:     q.max_min && !isNaN(Number(q.max_min)) ? Number(q.max_min) : '',
        open_now:    String(q.open_now || '') === '1',
        veg:         String(q.veg      || '') === '1',
        offer:       String(q.offer    || '') === '1',
        price:       allowedPrice.indexOf(String(q.price || '').toLowerCase()) !== -1 ? String(q.price).toLowerCase() : '',
        // Delivery-time buckets — comma list of valid keys (15,30,45,60).
        delivery:    /^(15|30|45|60)(,(15|30|45|60))*$/.test(String(q.delivery || '')) ? String(q.delivery) : '',
        recommended: String(q.recommended || '') === '1',
        featured:    String(q.featured    || '') === '1',
    };

    // "Browse" — the dynamic sidebar filter that narrows the home to ONE
    // curated set: favourites | collection-<id> | featured | sponsored |
    // offer-<id>. Empty = normal home. Resolved against the fetched feed below.
    const browse = String((q.browse || '')).trim();

    // ── Live marketplace data ───────────────────────────────────────
    // Both rails (Popular near you + For you) come from the api now.
    // The /static fallbacks below are kept ONLY for two cases:
    //   • the user hasn't picked a location yet — we don't render
    //     either rail anyway, so the arrays stay []
    //   • the api is unreachable / errored — we degrade to the
    //     hand-rolled list rather than rendering an empty page
    let liveFeatured       = null;
    let liveForYou         = null;
    let liveCategories     = null;
    let liveSubCategories  = [];
    let liveRestaurant     = null;   // populated only when viewMode === 'restaurant'
    let liveMenuCategories = [];     // restaurant page: left-rail menu
    let liveSections       = [];     // restaurant page: products grouped by category
    let liveReviews        = null;   // restaurant page: published customer reviews (+ avg + count)
    let liveRewardBalance  = 0;      // restaurant page: this customer's reward-card balance here
    let liveRewardStreak   = null;   // restaurant page: order-streak progress ("1 more order → £5")
    let liveOffers         = null;   // restaurant page: active offers (banners/coupons/discounts)
    let liveProduct        = null;   // product page: the product
    let liveProductGroups  = [];     // product page: selectable option groups
    let liveProductRelated = [];     // product page: "you may also like"
    let featuredMore       = false;
    let forYouMore         = false;
    let liveFacets         = null;   // dynamic filter counts for the sidebar
    let liveHomeOffers     = [];     // home "Best offers" rail (real banners)
    let liveHomeFeed       = [];     // curated rows (Featured + collections)
    let liveHomeFeedOrder  = null;   // admin section order (all 6 sections)
    let cuisineNoMatch     = false;  // cuisine filter returned 0 → showing fallback restaurants
    let myFavourites       = [];     // signed-in customer's saved restaurants (default home only)
    let orderAgain         = [];     // signed-in customer's recently-ordered restaurants (top 10)
    let browseOptions      = [];     // dynamic "Browse" filter list (favs/collections/offers/sponsored)
    let browseActive       = false;  // a browse option is picked → show only its restaurants
    let browseLabel        = '';     // the picked option's label (for the heading)
    if (userLocation) {
        try {
            const lat = userLocation.lat != null ? Number(userLocation.lat) : null;
            const lng = userLocation.lng != null ? Number(userLocation.lng) : null;
            // Customer postcode → real delivery-zone (fee / min-order /
            // deliverability) matching in the api.
            const custPostcode = userLocation.postcode ? String(userLocation.postcode) : '';
            const latLng = (Number.isFinite(lat) ? '&lat=' + lat : '')
                         + (Number.isFinite(lng) ? '&lng=' + lng : '');
            // Signed-in customer id → forwarded so the api paints the
            // heart icon (isFavourite) on every card / detail header.
            const sessUser   = (req.session && req.session.user) || null;
            const customerId = sessUser && sessUser.id ? String(sessUser.id) : null;

            if (viewMode === 'restaurants') {
                // Full restaurants grid — pull the largest page the
                // api allows (50) and forward any active filters.
                const fqs = new URLSearchParams();
                fqs.set('limit', '50');
                if (Number.isFinite(lat)) fqs.set('lat', String(lat));
                if (Number.isFinite(lng)) fqs.set('lng', String(lng));
                if (custPostcode)         fqs.set('postcode', custPostcode);
                if (filters.sort)     fqs.set('sort',     filters.sort);
                if (filters.rating)   fqs.set('rating',   String(filters.rating));
                if (filters.max_km)   fqs.set('max_km',   String(filters.max_km));
                if (filters.max_min)  fqs.set('max_min',  String(filters.max_min));
                if (filters.open_now) fqs.set('open_now', '1');
                if (filters.veg)      fqs.set('veg',      '1');
                if (filters.offer)    fqs.set('offer',    '1');
                if (filters.price)    fqs.set('price',    filters.price);
                if (filters.delivery) fqs.set('delivery', filters.delivery);
                if (customerId)       fqs.set('customer_id', customerId);
                const r = await callApi(req, 'GET',
                    '/api/v1/marketplace/restaurants?' + fqs.toString());
                liveFeatured = (r.body && r.body.status === 200 && r.body.data && r.body.data.restaurants) || [];
                featuredMore = !!(r.body && r.body.status === 200 && r.body.data && r.body.data.has_more);
                liveFacets   = (r.body && r.body.status === 200 && r.body.data && r.body.data.facets) || null;
            } else if (viewMode === 'cuisines') {
                // Full categories grid — `all=1` opens up the listing
                // so sub-categories (Chicken Kebab, Donner Kebab,
                // Margherita Pizza …) surface alongside top-level
                // pills. The home strip omits this flag and stays
                // top-level only. We pull 500 — far above the actual
                // distinct count today, so we never paginate this
                // surface.
                const c = await callApi(req, 'GET',
                    '/api/v1/marketplace/categories?all=1&limit=500');
                liveCategories = (c.body && c.body.status === 200 && c.body.data && c.body.data.categories) || [];
            } else if (viewMode === 'restaurant') {
                // Single-restaurant page — ONE detail call returns the
                // restaurant header/info, its menu categories, and the
                // products grouped into sections. The api resolves the
                // slug → company id itself.
                const dqs = new URLSearchParams();
                dqs.set('slug', restaurantSlug);
                if (Number.isFinite(lat)) dqs.set('lat', String(lat));
                if (Number.isFinite(lng)) dqs.set('lng', String(lng));
                if (custPostcode)         dqs.set('postcode', custPostcode);
                if (customerId)           dqs.set('customer_id', customerId);
                const d = await callApi(req, 'GET', '/api/v1/marketplace/restaurant?' + dqs.toString());
                const dd = (d.body && d.body.status === 200 && d.body.data) || null;
                liveRestaurant     = dd ? dd.restaurant : null;
                liveMenuCategories = dd ? (dd.categories || []) : [];
                liveSections       = dd ? (dd.sections   || []) : [];
                liveOffers         = dd ? (dd.offers     || null) : null;
                // Published customer reviews for this restaurant (separate
                // call — keeps the detail endpoint lean). Best-effort.
                if (liveRestaurant && liveRestaurant.id) {
                    try {
                        const rv = await callApi(req, 'GET',
                            '/api/v1/marketplace/reviews?sort=best&limit=5&company_id=' + encodeURIComponent(liveRestaurant.id));
                        liveReviews = (rv.body && rv.body.status === 200 && rv.body.data) || null;
                    } catch (e) { liveReviews = null; }

                    // Signed-in customer's reward-card balance at THIS
                    // restaurant (loyalty, per company_id). Best-effort.
                    if (customerId) {
                        try {
                            const lb = await callApi(req, 'GET',
                                '/api/v1/customer/loyalty/balance?customer_id=' + encodeURIComponent(customerId) +
                                '&company_id=' + encodeURIComponent(liveRestaurant.id));
                            liveRewardBalance = (lb.body && lb.body.status === 200 && lb.body.data && Number(lb.body.data.balance)) || 0;
                            liveRewardStreak  = (lb.body && lb.body.status === 200 && lb.body.data && lb.body.data.streak) || null;
                        } catch (e) { liveRewardBalance = 0; liveRewardStreak = null; }
                    }
                }
            } else if (viewMode === 'product') {
                // Single-product page — product + its selectable option
                // groups (sizes / toppings / add-ons) from the api.
                const pdq = new URLSearchParams();
                if (itemSlug && restScopeSlug) { pdq.set('item', itemSlug); pdq.set('rest', restScopeSlug); }
                else if (productId)            { pdq.set('id', productId); }
                if (Number.isFinite(lat)) pdq.set('lat', String(lat));
                if (Number.isFinite(lng)) pdq.set('lng', String(lng));
                const d = await callApi(req, 'GET', '/api/v1/marketplace/product?' + pdq.toString());
                const dd = (d.body && d.body.status === 200 && d.body.data) || null;
                liveProduct        = dd ? dd.product : null;
                liveProductGroups  = dd ? (dd.groups || []) : [];
                liveProductRelated = dd ? (dd.related || []) : [];
            } else if (isPickup) {
                // ── Pickup ─────────────────────────────────────────
                // Fetch a wider set of restaurants WITH coords for the
                // map, plus the cuisine rail. The cuisine filter still
                // applies so a rail tap narrows the map; sidebar filters
                // are not part of the pickup surface.
                const pqs = new URLSearchParams();
                pqs.set('limit', '50');
                if (Number.isFinite(lat)) pqs.set('lat', String(lat));
                if (Number.isFinite(lng)) pqs.set('lng', String(lng));
                if (cuisine)              pqs.set('cuisine', cuisine);
                // Forward the sidebar filters so Pickup respects them too.
                if (filters.sort)     pqs.set('sort',     filters.sort);
                if (filters.rating)   pqs.set('rating',   String(filters.rating));
                if (filters.max_km)   pqs.set('max_km',   String(filters.max_km));
                if (filters.max_min)  pqs.set('max_min',  String(filters.max_min));
                if (filters.open_now) pqs.set('open_now', '1');
                if (filters.veg)      pqs.set('veg',      '1');
                if (filters.offer)    pqs.set('offer',    '1');
                if (filters.price)    pqs.set('price',    filters.price);
                if (filters.delivery) pqs.set('delivery', filters.delivery);
                if (customerId)           pqs.set('customer_id', customerId);
                const [rRes, cRes] = await Promise.all([
                    callApi(req, 'GET', '/api/v1/marketplace/restaurants?' + pqs.toString()),
                    callApi(req, 'GET', '/api/v1/marketplace/categories'),
                ]);
                liveFeatured   = (rRes.body && rRes.body.status === 200 && rRes.body.data && rRes.body.data.restaurants) || [];
                featuredMore   = !!(rRes.body && rRes.body.status === 200 && rRes.body.data && rRes.body.data.has_more);
                liveCategories = (cRes.body && cRes.body.status === 200 && cRes.body.data && cRes.body.data.categories) || [];
            } else {
                // Default home (with optional ?cuisine= filter + any
                // sidebar/sheet filters).
                const out = await fetchMarketplace(req, lat, lng, cuisine, filters, custPostcode);
                liveFeatured      = out.featured;
                liveForYou        = out.for_you;
                liveCategories    = out.categories;
                liveSubCategories = out.sub_categories || [];
                featuredMore      = !!out.featured_more;
                forYouMore        = !!out.for_you_more;
                liveFacets        = out.facets || null;
                liveHomeOffers    = out.home_offers || [];
                liveHomeFeed      = out.home_feed || [];
                liveHomeFeedOrder = out.home_feed_order || null;

                // Empty cuisine → don't show a blank feed. Fall back to
                // nearby restaurants (with a note) so the user still has
                // something to browse instead of nothing.
                if (cuisine && Array.isArray(liveFeatured) && liveFeatured.length === 0) {
                    const fqs = new URLSearchParams();
                    fqs.set('limit', '24');
                    if (Number.isFinite(lat)) fqs.set('lat', String(lat));
                    if (Number.isFinite(lng)) fqs.set('lng', String(lng));
                    if (custPostcode)         fqs.set('postcode', custPostcode);
                    if (customerId)           fqs.set('customer_id', customerId);
                    const fb = await callApi(req, 'GET', '/api/v1/marketplace/restaurants?' + fqs.toString());
                    if (fb.body && fb.body.status === 200 && fb.body.data) {
                        liveFeatured   = fb.body.data.restaurants || [];
                        featuredMore   = !!fb.body.data.has_more;
                        liveFacets     = fb.body.data.facets || liveFacets;
                        cuisineNoMatch = true;
                    }
                }

                // ── My Favourites rail ──────────────────────────────
                // Only on the truly default home (no cuisine, no
                // sidebar/sheet filter active) — when the user is
                // narrowing the list with anything, the page should
                // honour that narrowing without an extra rail above it.
                const hasActiveFilters = !!(
                    filters.sort || filters.rating || filters.max_km || filters.max_min ||
                    filters.open_now || filters.veg || filters.offer ||
                    filters.price || filters.delivery ||
                    filters.recommended || filters.featured || browse
                );
                if (customerId && !cuisine && !hasActiveFilters) {
                    const fqs = new URLSearchParams({ customer_id: customerId });
                    if (Number.isFinite(lat)) fqs.set('lat', String(lat));
                    if (Number.isFinite(lng)) fqs.set('lng', String(lng));
                    const favRes = await callApi(req, 'GET', '/api/v1/customer/favourites?' + fqs.toString());
                    if (favRes.body && favRes.body.status === 200 && favRes.body.data) {
                        myFavourites = favRes.body.data.favourites || [];
                    }
                    // Strip favourites from the main "Top restaurants
                    // near you" rail so the same card never appears in
                    // both places.
                    if (myFavourites.length && Array.isArray(liveFeatured) && liveFeatured.length) {
                        const favIds = new Set(myFavourites.map(f => String(f.id)));
                        liveFeatured = liveFeatured.filter(r => !favIds.has(String(r.id)));
                    }

                    // "Order again" — the customer's recently-ordered restaurants
                    // (top 10, newest first). Same gate as favourites; the rail
                    // shows only when they have at least one past order.
                    const oaRes = await callApi(req, 'GET', '/api/v1/customer/order-again?' + fqs.toString());
                    if (oaRes.body && oaRes.body.status === 200 && oaRes.body.data) {
                        orderAgain = oaRes.body.data.restaurants || [];
                    }
                    if (orderAgain.length && Array.isArray(liveFeatured) && liveFeatured.length) {
                        const oaIds = new Set(orderAgain.map(r => String(r.id)));
                        liveFeatured = liveFeatured.filter(r => !oaIds.has(String(r.id)));
                    }
                }
            }
        } catch (err) {
            // Don't fail the whole page — fall through to the static
            // arrays declared further down.
            console.error('[SiteController] marketplace fetch failed:', err && err.message);
        }
    }

    // ── Filter the curated home-feed rows by the active sidebar filters ──
    // The main grid (liveFeatured) is already filtered by the api. When the
    // user narrows the list (rating / price / delivery-time / offers / veg /
    // open-now / distance), EVERY curated row (Offer / collections / featured
    // products) must show ONLY restaurants that survived that filter — and a
    // row that ends up empty is DROPPED. We intersect each row with the
    // filtered grid's ids so the feed never advertises an excluded place.
    // (Cuisine is excluded here: with cuisine-only the favourites rail strips
    //  liveFeatured, so the intersection wouldn't be a faithful match.)
    {
        const reducing = !!(
            filters.rating || filters.max_km || filters.max_min ||
            filters.open_now || filters.veg || filters.offer || filters.price ||
            filters.delivery || filters.recommended || filters.featured
        );
        if (reducing && Array.isArray(liveHomeFeed) && liveHomeFeed.length) {
            const feat      = Array.isArray(liveFeatured) ? liveFeatured : [];
            const keepIds   = new Set(feat.map((r) => String(r.id)));
            const keepSlugs = new Set(feat.map((r) => String(r.slug || r.id).toLowerCase()));
            liveHomeFeed = liveHomeFeed
                .map((row) => (row && Array.isArray(row.restaurants))
                    ? Object.assign({}, row, { restaurants: row.restaurants.filter((r) => keepIds.has(String(r.id))) })
                    : row)
                .filter((row) => {
                    if (!row) { return false; }
                    if (Array.isArray(row.restaurants)) { return row.restaurants.length > 0; }
                    if (Array.isArray(row.products))    { return keepSlugs.has(String(row.restaurantSlug || '').toLowerCase()); }
                    return true;
                });
        }
    }

    // ── Dynamic "Browse" filter — Favourites / Collections / Offers / Sponsored ──
    // Build the option list from the curated feed; when one is picked (?browse=)
    // narrow the WHOLE page to just that set's restaurants (a section filter).
    if (!viewMode && userLocation) {
        const bSess = (req.session && req.session.user) || null;
        const bCustomerId = bSess && bSess.id ? String(bSess.id) : null;
        const bLat = userLocation.lat != null ? Number(userLocation.lat) : null;
        const bLng = userLocation.lng != null ? Number(userLocation.lng) : null;

        // Favourites for the "Favourites" option count + its target. Reuse the
        // rail's fetch when it already ran (default home); only hit the api when
        // a filter/browse suppressed the rail so we still know the fav count.
        let favsForBrowse = (myFavourites && myFavourites.length) ? myFavourites.slice() : [];
        if (bCustomerId && !favsForBrowse.length) {
            try {
                const bqs = new URLSearchParams({ customer_id: bCustomerId });
                if (Number.isFinite(bLat)) bqs.set('lat', String(bLat));
                if (Number.isFinite(bLng)) bqs.set('lng', String(bLng));
                const fr = await callApi(req, 'GET', '/api/v1/customer/favourites?' + bqs.toString());
                favsForBrowse = (fr.body && fr.body.status === 200 && fr.body.data && fr.body.data.favourites) || [];
            } catch (e) { favsForBrowse = []; }
        }

        // Pre-computed target sets (also drive each option's count).
        const featSet = (liveHomeFeed || []).filter((r) => r && r.section === 'featured').reduce((a, r) => a.concat(r.restaurants || []), []);
        const spSet   = (liveHomeFeed || []).filter((r) => r && r.section === 'sponsored').reduce((a, r) => a.concat(r.restaurants || []), []);

        // ── Build the 2-level option list: main category (group) → items.
        //    ONLY items whose count > 0 are listed (empty ones are dropped). ──
        if (favsForBrowse.length > 0) {
            browseOptions.push({ key: 'favourites', group: 'Favourites', label: 'My Favourites', count: favsForBrowse.length });
        }
        (liveHomeFeed || []).forEach((row) => {
            if (row && row.section === 'collections' && row.id && (row.restaurants || []).length > 0) {
                browseOptions.push({ key: 'collection-' + row.id, group: 'Collections', label: row.title || 'Collection', count: row.restaurants.length });
            }
        });
        if (featSet.length > 0) { browseOptions.push({ key: 'featured',  group: 'Featured',  label: 'Featured',  count: featSet.length }); }
        if (spSet.length   > 0) { browseOptions.push({ key: 'sponsored', group: 'Sponsored', label: 'Sponsored', count: spSet.length   }); }
        (liveHomeOffers || []).forEach((o) => {
            const slug = o && o.restaurant && o.restaurant.slug;
            if (o && o.id != null && slug) {
                const n = (liveFeatured || []).filter((r) => String(r.slug) === String(slug)).length;
                if (n > 0) { browseOptions.push({ key: 'offer-' + o.id, group: 'Offers', label: o.title || 'Offer', count: n }); }
            }
        });

        // ── Apply the picked option → focus the page on just that set ──
        const opt = browse ? browseOptions.find((o) => o.key === browse) : null;
        if (opt) {
            browseActive = true;
            browseLabel  = opt.label;
            let target = [];
            if (browse === 'favourites')                { target = favsForBrowse; }
            else if (browse === 'featured')             { target = featSet; }
            else if (browse === 'sponsored')            { target = spSet; }
            else if (browse.indexOf('collection-') === 0) {
                const cid = browse.slice('collection-'.length);
                const row = (liveHomeFeed || []).find((r) => r && r.section === 'collections' && String(r.id) === cid);
                target = row ? (row.restaurants || []) : [];
            } else if (browse.indexOf('offer-') === 0) {
                const oid = browse.slice('offer-'.length);
                const off = (liveHomeOffers || []).find((o) => o && String(o.id) === oid);
                const slug = off && off.restaurant && off.restaurant.slug;
                target = slug ? (liveFeatured || []).filter((r) => String(r.slug) === String(slug)) : [];
            }
            // De-dupe + focus: only the picked set shows; rails + feed dropped.
            const seenB = new Set();
            liveFeatured = target.filter((r) => { const k = String(r.id); if (seenB.has(k)) { return false; } seenB.add(k); return true; });
            liveHomeFeed = []; myFavourites = []; orderAgain = []; liveHomeOffers = [];
            featuredMore = false;
        }
    }

    // Placeholder data sets. Replaced with live API calls in the next phase:
    //   - cuisines  → GET /api/v1/cuisines
    //   - featured  → GET /api/v1/restaurants?featured=1&lat=&lng=
    //   - howItWorks is static UX copy — fine to keep here.
    // Fallback used only when the api is unreachable. Includes
    // `initial` + `tint` so the placeholder layer in the view still
    // renders correctly if one of these SVGs ever 404s.
    const cuisines = [
        { id: 1, name: 'Pizza',    icon: '/img/cuisine/pizza.svg',    initial: 'P', tint: '#FFE0B2' },
        { id: 2, name: 'Burger',   icon: '/img/cuisine/burger.svg',   initial: 'B', tint: '#FFE082' },
        { id: 3, name: 'Indian',   icon: '/img/cuisine/indian.svg',   initial: 'I', tint: '#FFAB91' },
        { id: 4, name: 'Chinese',  icon: '/img/cuisine/chinese.svg',  initial: 'C', tint: '#EF9A9A' },
        { id: 5, name: 'Italian',  icon: '/img/cuisine/italian.svg',  initial: 'I', tint: '#FFCDD2' },
        { id: 6, name: 'Japanese', icon: '/img/cuisine/japanese.svg', initial: 'J', tint: '#B0BEC5' },
        { id: 7, name: 'Mexican',  icon: '/img/cuisine/mexican.svg',  initial: 'M', tint: '#C5E1A5' },
        { id: 8, name: 'Desserts', icon: '/img/cuisine/desserts.svg', initial: 'D', tint: '#F8BBD0' },
    ];

    // ── Featured restaurants (STATIC for now) ────────────────────────
    // These mirror the real companies sitting in the wtw_eatndeal DB
    // (Alaadins Cave, Taste of London, etc.) with mock food-delivery
    // metadata. Will be replaced by GET /api/v1/restaurants?lat=&lng=
    // once the api endpoint lands — the view consumes the same shape.
    //
    // We only show this list AFTER the user has set a location, so the
    // "near you" framing makes sense. When user_location is null the
    // view shows the location-picker prompt instead.
    //
    // tint   — CSS colour used as the card image's placeholder background
    //          (we don't ship food photos yet)
    // initial — single letter shown over the placeholder, like an avatar
    // ── Featured restaurants — distanceKm is what we show on each
    // card now (used to be deliveryFee). The live api will compute
    // this from the customer's saved lat/lng vs the branch's
    // lat/lng; the static numbers below are placeholders that match
    // the post-location-set layout.
    const featured = userLocation ? [
        {
            id: 15, slug: 'alaadins-cave',
            name: 'Alaadins Cave',
            cuisines: ['Indian', 'Curry', 'Halal'],
            rating: 4.5,
            deliveryMinutes: '25-35 min',
            distanceKm: 1.2,
            offer: '50% OFF up to £12',
            isOpen: true,
            tint: '#FFE0B2',
            initial: 'A',
        },
        {
            id: 19, slug: 'taste-of-london',
            name: 'Taste of London',
            cuisines: ['British', 'Roast', 'Pies'],
            rating: 4.3,
            deliveryMinutes: '30-40 min',
            distanceKm: 2.4,
            offer: 'Free delivery',
            isOpen: true,
            tint: '#FFCDD2',
            initial: 'T',
        },
        {
            id: 20, slug: 'taste-of-india',
            name: 'Taste of India',
            cuisines: ['Indian', 'Biryani', 'Tandoori'],
            rating: 4.7,
            deliveryMinutes: '20-30 min',
            distanceKm: 0.9,
            offer: 'Buy 1 Get 1',
            isOpen: true,
            tint: '#FFAB91',
            initial: 'T',
        },
        {
            id: 21, slug: 'loads-foods',
            name: 'Loads Foods',
            cuisines: ['Fast Food', 'Burgers', 'Pizza'],
            rating: 4.1,
            deliveryMinutes: '15-25 min',
            distanceKm: 0.6,
            offer: null,
            isOpen: true,
            tint: '#C5E1A5',
            initial: 'L',
        },
        {
            id: 22, slug: 'taste-of-nature',
            name: 'Taste of Nature',
            cuisines: ['Vegan', 'Healthy', 'Bowls'],
            rating: 4.6,
            deliveryMinutes: '25-35 min',
            distanceKm: 1.8,
            offer: 'New on EatNDeal',
            isOpen: true,
            tint: '#A5D6A7',
            initial: 'T',
        },
        {
            id: 30, slug: 'pizza-corner',
            name: 'Pizza Corner',
            cuisines: ['Italian', 'Pizza', 'Pasta'],
            rating: 4.4,
            deliveryMinutes: '20-30 min',
            distanceKm: 1.1,
            offer: '20% OFF',
            isOpen: true,
            tint: '#FFE082',
            initial: 'P',
        },
        {
            id: 31, slug: 'dragon-wok',
            name: 'Dragon Wok',
            cuisines: ['Chinese', 'Noodles', 'Wok'],
            rating: 4.2,
            deliveryMinutes: '30-40 min',
            distanceKm: 2.7,
            offer: null,
            isOpen: false,
            tint: '#EF9A9A',
            initial: 'D',
        },
        {
            id: 32, slug: 'sushi-bay',
            name: 'Sushi Bay',
            cuisines: ['Japanese', 'Sushi', 'Sashimi'],
            rating: 4.8,
            deliveryMinutes: '35-45 min',
            distanceKm: 3.4,
            offer: 'Premium',
            isOpen: true,
            tint: '#B0BEC5',
            initial: 'S',
        },
    ] : [];

    // ── "For you" — recommended dishes (STATIC for now) ──────────────
    // Horizontal scroller of individual dishes between cuisines and
    // featured restaurants. Will be powered by
    //   GET /api/v1/recommendations/dishes?customer_id=…&lat=&lng=
    // once the recommender lands. The view consumes the same shape so
    // switching to live data is a controller-only change.
    //
    // tint    — placeholder photo background colour (no food photos yet)
    // initial — single-letter chip over the placeholder
    // priceFrom — entry-level price, displayed under the dish name
    // restaurant — string for the "From …" sub-line
    // restaurantSlug — link target
    // veg — small green dot before the dish name when true
    const forYou = userLocation ? [
        { id: 1, name: 'Chicken Tikka Masala', priceFrom: 9.95,  rating: 4.6, deliveryMinutes: '25-35 min', restaurant: 'Alaadins Cave',   restaurantSlug: 'alaadins-cave',   veg: false, tint: '#FFE0B2', initial: 'C' },
        { id: 2, name: 'Margherita Pizza',     priceFrom: 7.50,  rating: 4.4, deliveryMinutes: '20-30 min', restaurant: 'Pizza Corner',    restaurantSlug: 'pizza-corner',    veg: true,  tint: '#FFE082', initial: 'M' },
        { id: 3, name: 'Smash Burger',         priceFrom: 6.99,  rating: 4.2, deliveryMinutes: '15-25 min', restaurant: 'Loads Foods',     restaurantSlug: 'loads-foods',     veg: false, tint: '#C5E1A5', initial: 'S' },
        { id: 4, name: 'Veg Hakka Noodles',    priceFrom: 8.20,  rating: 4.1, deliveryMinutes: '30-40 min', restaurant: 'Dragon Wok',      restaurantSlug: 'dragon-wok',      veg: true,  tint: '#EF9A9A', initial: 'N' },
        { id: 5, name: 'Buddha Bowl',          priceFrom: 9.00,  rating: 4.7, deliveryMinutes: '25-35 min', restaurant: 'Taste of Nature', restaurantSlug: 'taste-of-nature', veg: true,  tint: '#A5D6A7', initial: 'B' },
        { id: 6, name: 'Salmon Sashimi 8 pcs', priceFrom: 12.50, rating: 4.8, deliveryMinutes: '35-45 min', restaurant: 'Sushi Bay',       restaurantSlug: 'sushi-bay',       veg: false, tint: '#B0BEC5', initial: 'S' },
        { id: 7, name: 'Lamb Biryani',         priceFrom: 11.95, rating: 4.7, deliveryMinutes: '20-30 min', restaurant: 'Taste of India',  restaurantSlug: 'taste-of-india',  veg: false, tint: '#FFAB91', initial: 'L' },
        { id: 8, name: 'Sunday Roast',         priceFrom: 14.50, rating: 4.3, deliveryMinutes: '30-40 min', restaurant: 'Taste of London', restaurantSlug: 'taste-of-london', veg: false, tint: '#FFCDD2', initial: 'R' },
    ] : [];

    const howItWorks = [
        {
            step:  1,
            title: 'Tell us where you are',
            body:  'Enter your postcode or share your location and we will show every restaurant that can deliver to you.',
            icon:  '/img/how/location.svg',
        },
        {
            step:  2,
            title: 'Pick a restaurant',
            body:  'Browse menus, reviews, deals and delivery times. Filter by cuisine, price or rating.',
            icon:  '/img/how/restaurant.svg',
        },
        {
            step:  3,
            title: 'Pay and enjoy',
            body:  'Checkout securely, track your order in real time, and earn loyalty points on every order.',
            icon:  '/img/how/enjoy.svg',
        },
    ];

    // Pick LIVE data whenever the api responded (even if the array
    // came back empty — that's an accurate signal of "no marketplace-
    // flagged rows yet"). The static placeholder arrays only kick in
    // when the api was unreachable (network error / 500). That keeps
    // the dashboard reflecting real flag state while still avoiding
    // a blank page during a brief api outage.
    //
    // Cuisines are a special case: when api returns an EMPTY category
    // list (no marketplace-enabled categories yet) we keep the static
    // generic-cuisine fallback (Pizza / Burger / …) so the "What's on
    // your mind?" pill row never goes blank. The empty case is too
    // common during onboarding to leave the row empty.
    let   finalFeatured = liveFeatured != null ? liveFeatured : featured;
    const finalForYou   = liveForYou   != null ? liveForYou   : forYou;

    // #2 De-dup the main "Top restaurants near you" grid: drop any restaurant
    // already shown ABOVE it — in the curated feed rows (Featured + collections)
    // or My Favourites — so the same card never appears twice on the home.
    {
        const shownIds = new Set();
        (myFavourites || []).forEach((r) => { if (r && r.id != null) { shownIds.add(String(r.id)); } });
        (liveHomeFeed || []).forEach((row) => {
            ((row && row.restaurants) || []).forEach((r) => { if (r && r.id != null) { shownIds.add(String(r.id)); } });
        });
        if (Array.isArray(finalFeatured) && shownIds.size) {
            finalFeatured = finalFeatured.filter((r) => !(r && r.id != null && shownIds.has(String(r.id))));
        }
    }
    // Only the REAL marketplace categories (from the api) drive the cuisine row
    // + "Popular cuisines". On a fresh DB with none added, show NOTHING — never
    // the hardcoded demo list (which looked like categories nobody created).
    let   finalCuisines = (liveCategories && liveCategories.length)
        ? liveCategories
        : [];
    void cuisines;   // demo fallback kept for reference but intentionally unused
    // Cuisine row behaves differently depending on how the selection
    // was made:
    //   • from=search → NARROW the row to just the selected pill;
    //                    sub-pills (spliced below) follow it. Other
    //                    main cuisines are hidden so the row reads
    //                    as "you're in Kebab-land + here are its
    //                    sub-categories".
    //   • direct pill click → KEEP every main cuisine visible. The
    //                    clicked pill stays in place; it just gets
    //                    the active underline (added by home.js) and
    //                    its sub-pills are spliced in right after.
    // NOTE: a search-driven category pick used to NARROW the rail to
    // just the chosen pill — that left a single isolated pill (with a
    // stray active ring) and a broken-looking gap. We now ALWAYS keep
    // the full rail; the chosen category is simply marked active in
    // place (home.js) and the restaurants below are filtered to it —
    // exactly like a direct pill tap. `fromSearch` is no longer used to
    // filter the row.
    void fromSearch;
    if (cuisine && liveSubCategories.length) {
        const target = cuisine.toLowerCase();
        const idx = finalCuisines.findIndex(c =>
            String(c.searchName || c.name || '').toLowerCase() === target
        );
        if (idx !== -1) {
            const subs = liveSubCategories.map(s => Object.assign({}, s, { isSub: true }));
            finalCuisines = finalCuisines.slice(0, idx + 1)
                .concat(subs)
                .concat(finalCuisines.slice(idx + 1));
        }
    }

    // Display label for the selected category — the real category name when we
    // can match the picked searchName, else a capitalised form. Drives the
    // "<Category> near you" heading so a category click reads as a category view.
    let selectedCuisineLabel = null;
    if (cuisine) {
        const match = (finalCuisines || []).find(c => !c.isSub && String(c.searchName || c.name || '').toLowerCase() === cuisine.toLowerCase());
        selectedCuisineLabel = (match && match.name) || (cuisine.charAt(0).toUpperCase() + cuisine.slice(1));
    }

    res.render('site/index', {
        page_title:    null,                  // null → use brand.name as the title
        _layoutFile:   '../_layout',          // ejs-locals layout path (relative to this view)
        active_nav:    'home',                // header highlights "home" link
        // Per-view script: pickup map, restaurant detail, product
        // detail, or the home page bindings.
        extra_js:      isPickup ? '/js/pages/pickup.js'
                       : (viewMode === 'restaurant' ? '/js/pages/restaurant.js'
                       : (viewMode === 'product'    ? '/js/pages/product.js'
                       : '/js/pages/home.js')),
        // Delivery (default) vs Pickup — drives the layout branch in
        // views/site/index.ejs.
        order_mode:    orderMode,
        // Suppress the layout's top promo strip on the home page —
        // the home view renders it lower down, after "Best offers
        // for you", per the user's layout request. Other pages keep
        // the default top strip (they don't set this flag).
        show_promo_strip: false,
        user_location:    userLocation,
        cuisines:         finalCuisines,
        selected_cuisine: cuisine || null,
        selected_cuisine_label: selectedCuisineLabel,
        // True when the picked cuisine had no restaurants and we fell
        // back to nearby ones (the view shows a note).
        cuisine_no_match: cuisineNoMatch,
        // Dynamic filter facet counts for the sidebar badges (null when
        // the api was unreachable — the sidebar then hides the numbers).
        facet_counts:     liveFacets,
        featured:         finalFeatured,
        my_favourites:    myFavourites,
        order_again:      orderAgain,
        browse_options:   browseOptions,
        browse:           browse || '',
        browse_active:    browseActive,
        browse_label:     browseLabel,
        home_offers:      liveHomeOffers,
        home_feed:        liveHomeFeed,
        home_feed_order:  liveHomeFeedOrder,
        for_you:          finalForYou,
        // has_more flags from the api → drive both the "View all"
        // header link and the "See more" load-more block at the
        // bottom of each section. False when the api didn't return a
        // value (no location yet, or api was down).
        featured_more:    featuredMore,
        for_you_more:     forYouMore,
        // View mode + selected restaurant.
        //   view_mode:           ''           default home
        //                        'restaurants' full grid of all restaurants
        //                        'cuisines'    full grid of all categories
        //                        'restaurant'  single restaurant + its menu
        //   selected_restaurant: the restaurant object (when viewMode='restaurant')
        view_mode:           viewMode,
        // Show the header search + mobile search/filter row on every
        // browse surface this controller serves — default home feed,
        // the all-restaurants / all-cuisines grids, search results and
        // a single restaurant's menu — but NOT on the product-detail
        // page (viewMode === 'product'), where there is a single item
        // and nothing to search. The pre-location landing page renders
        // 'site/location' (separate branch) and never sets this, so it
        // inherits the default OFF.
        show_search:         viewMode !== 'product',
        // Delivery/Pickup header toggle shows on every browse surface this
        // controller serves — home, restaurants/cuisines grids, a single
        // restaurant, AND the product page.
        show_mode_toggle:    true,
        selected_restaurant: liveRestaurant,
        // Restaurant page: left-rail menu categories + product sections.
        menu_categories:     liveMenuCategories,
        menu_sections:       liveSections,
        restaurant_reviews:  liveReviews,
        restaurant_reward_balance: liveRewardBalance,
        restaurant_reward_streak:  liveRewardStreak,
        restaurant_offers:   liveOffers,
        // Product page: the product + its selectable option groups + related.
        product:             liveProduct,
        product_groups:      liveProductGroups,
        product_related:     liveProductRelated,
        how_it_works:        howItWorks,
    });
  } catch (err) {
    // Express 4 doesn't auto-route rejected promises from async
    // handlers to the global error handler — we hand it off explicitly
    // so the 500 page renders instead of an unhandled-rejection log.
    next(err);
  }
}

/**
 * offersPage
 *
 * What:  GET /offers — every marketplace restaurant that has active offers,
 *        grouped under it (restaurant header + its banners/codes/discounts),
 *        with a restaurant jump-list sidebar. Read-only.
 * Type:  READ.
 */
async function offersPage(req, res, next) {
    try {
        const apiRes = await callApi(req, 'GET', '/api/v1/marketplace/offers?page=1');
        const d = (apiRes.body && apiRes.body.status === 200 && apiRes.body.data) || {};
        return res.render('site/offers', {
            page_title:       'Offers',
            _layoutFile:      '../_layout',
            active_nav:       'offers',
            extra_js:         '/js/pages/offers.js',
            show_promo_strip: false,
            offers_restaurant: d.restaurantOffers || [],
            offers_product:    d.productOffers || [],
            offers_common:     d.commonOffers || [],
            offers_total:      d.total || 0,
        });
    } catch (err) {
        next(err);
    }
}

/**
 * restaurantReviews — GET /restaurant-reviews
 *
 * JSON proxy for the restaurant page's reviews panel (sort / star filter /
 * load-more pagination). Forwards the query to the api and relays its
 * envelope so /js/ui/reviews-list.js can fetch from the web origin.
 * Type: READ.
 */
async function restaurantReviews(req, res) {
    try {
        const qs = new URLSearchParams();
        ['company_id', 'sort', 'stars', 'offset', 'limit'].forEach((k) => {
            if (req.query[k] != null && req.query[k] !== '') { qs.set(k, String(req.query[k])); }
        });
        const apiRes = await callApi(req, 'GET', '/api/v1/marketplace/reviews?' + qs.toString());
        return res.status(200).json(apiRes.body || { status: 502, show: false, msg: 'Could not load reviews.' });
    } catch (e) {
        return res.status(200).json({ status: 500, show: false, msg: 'Could not load reviews.' });
    }
}

module.exports = { index, offersPage, restaurantReviews };
