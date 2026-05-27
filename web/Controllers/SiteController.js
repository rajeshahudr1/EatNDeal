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
async function fetchMarketplace(req, lat, lng, cuisine) {
    const qs = new URLSearchParams();
    if (Number.isFinite(lat)) qs.set('lat', String(lat));
    if (Number.isFinite(lng)) qs.set('lng', String(lng));
    if (cuisine)              qs.set('cuisine', cuisine);
    const suffix = qs.toString() ? ('?' + qs.toString()) : '';

    // Categories fetch always pulls the full top-level list (no
    // cuisine param). When a filter is active we additionally fetch
    // the SUB-categories of the selected one so the row can expand
    // inline: e.g. picking Kebab inserts Chicken Kebab / Donner Kebab
    // / etc. right after the Kebab pill.
    const calls = [
        callApi(req, 'GET', '/api/v1/marketplace/restaurants' + suffix),
        callApi(req, 'GET', '/api/v1/marketplace/products'    + suffix),
        callApi(req, 'GET', '/api/v1/marketplace/categories'),
    ];
    if (cuisine) {
        calls.push(callApi(req, 'GET', '/api/v1/marketplace/categories?parent=' + encodeURIComponent(cuisine)));
    }
    const [rRes, pRes, cRes, sRes] = await Promise.all(calls);

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
    return {
        featured,
        for_you:        forYou,
        categories,
        sub_categories: subCategories,
        featured_more:  featuredMore,
        for_you_more:   forYouMore,
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
    let viewMode = '';
    if (restaurantSlug)                                            { viewMode = 'restaurant'; }
    else if (rawView === 'restaurants' || rawView === 'cuisines')  { viewMode = rawView; }

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
    let featuredMore       = false;
    let forYouMore         = false;
    if (userLocation) {
        try {
            const lat = userLocation.lat != null ? Number(userLocation.lat) : null;
            const lng = userLocation.lng != null ? Number(userLocation.lng) : null;
            const latLng = (Number.isFinite(lat) ? '&lat=' + lat : '')
                         + (Number.isFinite(lng) ? '&lng=' + lng : '');

            if (viewMode === 'restaurants') {
                // Full restaurants grid — pull the largest page the
                // api allows (50). The grid auto-loads more on scroll
                // via the existing pagination helper.
                const r = await callApi(req, 'GET',
                    '/api/v1/marketplace/restaurants?limit=50' + latLng);
                liveFeatured = (r.body && r.body.status === 200 && r.body.data && r.body.data.restaurants) || [];
                featuredMore = !!(r.body && r.body.status === 200 && r.body.data && r.body.data.has_more);
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
                // Single-restaurant focus — fetch ALL marketplace
                // restaurants once, find the one whose slug matches,
                // then ask the api for that restaurant's products.
                // Two calls in parallel: restaurants list + a
                // products call we'll only USE if the restaurant
                // turns out to exist. Keeps latency to one round trip.
                const r = await callApi(req, 'GET',
                    '/api/v1/marketplace/restaurants?limit=200' + latLng);
                const list = (r.body && r.body.status === 200 && r.body.data && r.body.data.restaurants) || [];
                liveRestaurant = list.find(x => String(x.slug || '').toLowerCase() === restaurantSlug) || null;
                if (liveRestaurant) {
                    const p = await callApi(req, 'GET',
                        '/api/v1/marketplace/products?limit=50&restaurant=' + encodeURIComponent(liveRestaurant.id) + latLng);
                    liveForYou   = (p.body && p.body.status === 200 && p.body.data && p.body.data.products) || [];
                    forYouMore   = !!(p.body && p.body.status === 200 && p.body.data && p.body.data.has_more);
                }
            } else {
                // Default home (with optional ?cuisine= filter).
                const out = await fetchMarketplace(req, lat, lng, cuisine);
                liveFeatured      = out.featured;
                liveForYou        = out.for_you;
                liveCategories    = out.categories;
                liveSubCategories = out.sub_categories || [];
                featuredMore      = !!out.featured_more;
                forYouMore        = !!out.for_you_more;
            }
        } catch (err) {
            // Don't fail the whole page — fall through to the static
            // arrays declared further down.
            console.error('[SiteController] marketplace fetch failed:', err && err.message);
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
    const finalFeatured = liveFeatured != null ? liveFeatured : featured;
    const finalForYou   = liveForYou   != null ? liveForYou   : forYou;
    let   finalCuisines = (liveCategories && liveCategories.length)
        ? liveCategories
        : cuisines;
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
    if (fromSearch) {
        finalCuisines = finalCuisines.filter(c => {
            const key = String(c.searchName || c.name || '').toLowerCase();
            return key === cuisine;
        });
    }
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

    res.render('site/index', {
        page_title:    null,                  // null → use brand.name as the title
        _layoutFile:   '../_layout',          // ejs-locals layout path (relative to this view)
        active_nav:    'home',                // header highlights "home" link
        extra_js:      '/js/pages/home.js',   // per-page script the layout will emit
        user_location:    userLocation,
        cuisines:         finalCuisines,
        selected_cuisine: cuisine || null,
        featured:         finalFeatured,
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
        selected_restaurant: liveRestaurant,
        how_it_works:        howItWorks,
    });
  } catch (err) {
    // Express 4 doesn't auto-route rejected promises from async
    // handlers to the global error handler — we hand it off explicitly
    // so the 500 page renders instead of an unhandled-rejection log.
    next(err);
  }
}

module.exports = { index };
