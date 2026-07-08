'use strict';

/*
 * Controllers/AuthController.js
 *
 * What:  Customer-side auth flow on the web (PWA) layer. Three screens
 *        (mobile → OTP → Personal Details) all under /signin?step=…,
 *        plus three POST handlers that drive the steps via the api/
 *        layer:
 *
 *          GET  /signin                  → mobile number entry (default)
 *          GET  /signin?step=otp         → 6-digit OTP screen
 *          GET  /signin?step=profile     → Personal Details
 *          POST /signin/start            → send OTP
 *          POST /signin/verify           → verify OTP, branch to next page
 *          POST /signin/save-profile     → create / finish customer
 *
 *        Pending phone (the number being verified) lives on
 *        req.session.pendingAuth = { country_code, contact_no, next }.
 *        We DO NOT pass the phone through query strings — that would
 *        leak the number into browser history and proxy logs.
 *
 *        Branching after OTP verify:
 *          customer_status === 'existing' → mark req.session.user,
 *                                           redirect to `next`
 *          'new' / 'pending'              → redirect to ?step=profile
 *          'banned' / 'disabled' / etc.   → flash the api's friendly
 *                                           message back to /signin
 *
 * Why:   Coding-Conventions — web NEVER touches the database. Every
 *        decision routes through the api/v1/auth/* endpoints.
 *
 * Type:  READ + WRITE (writes to req.session; calls api endpoints).
 * Used:  Wired in web/index.js.
 *
 * Change log:
 *   2026-05-25 — initial signinPage action.
 *   2026-05-26 — added ?step=otp and ?step=profile demo branches.
 *   2026-05-26 — wired real /api/v1/auth/* and added startOtp /
 *                verifyOtp / saveProfile POST handlers.
 */

const crypto       = require('node:crypto');
const fs           = require('node:fs');
const path         = require('node:path');
const { callApi }  = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');
const oauth        = require('../Helpers/oauthProviders');
const appAuthTokens = require('../Helpers/appAuthTokens');

// Mobile app deep-link scheme for the social-sign-in handoff (see appAuthTokens
// + oauthCallback). The Android app must register an intent-filter for
// "<scheme>://auth". Sanitised to a valid URI scheme.
const APP_AUTH_SCHEME = String(process.env.APP_AUTH_SCHEME || 'eatndeal').replace(/[^a-z0-9.+-]/gi, '').toLowerCase() || 'eatndeal';

const OAUTH_PROVIDERS = new Set(['google', 'facebook']);

// ── Helpers ───────────────────────────────────────────────────────

/**
 * normalisePhone
 *
 * What:  Strips spaces / hyphens / parens / leading "+" so the value we
 *        carry in the session matches what the api stores in customer_otp.
 * Type:  READ (pure).
 */
function normalisePhone(raw) {
    return String(raw || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
}

/**
 * normaliseCountry
 *
 * What:  Cleans the country-dial input ("+44", "44", "+44 ", etc.) down
 *        to plain digits so it round-trips through the api validator.
 * Type:  READ (pure).
 */
function normaliseCountry(raw) {
    return String(raw || '').replace(/[\s\-()+]/g, '');
}

/**
 * formatPhoneDisplay
 *
 * What:  Builds a user-facing string like "+44 7712345678" from the
 *        session's stored country + contact pieces. Light formatting
 *        only — we don't try to fully prettify per-country.
 */
function formatPhoneDisplay(country, contact) {
    if (!country || !contact) { return ''; }
    return '+' + country + ' ' + contact;
}

/**
 * safeNext
 *
 * What:  Validates a `next` URL is same-origin (starts with "/") before
 *        we redirect to it. Stops open-redirect attempts like
 *          /signin?next=https://evil.example
 * Type:  READ (pure).
 */
function safeNext(raw) {
    const value = typeof raw === 'string' ? raw : '';
    if (value.startsWith('/') && !value.startsWith('//')) { return value; }
    return '/';
}

// ── GET handlers ──────────────────────────────────────────────────

/**
 * signinPage
 *
 * What:   Picks the right view based on the ?step query param + session
 *         state. Falls back to step=1 (mobile entry) when the session
 *         doesn't carry a pending phone (e.g. user pasted /signin?step=otp
 *         directly without going through step 1).
 * Type:   READ.
 */
function signinPage(req, res) {
    const step      = String((req.query && req.query.step) || '').toLowerCase();
    const queryNext = safeNext(req.query && req.query.next);
    const pending   = (req.session && req.session.pendingAuth) || null;

    // ── step=otp ─────────────────────────────────────────────────
    // Requires a pending phone in session. Otherwise bounce to step 1
    // so the user re-enters their number (instead of staring at a page
    // with no number to verify).
    if (step === 'otp') {
        if (!pending || !pending.contact_no) {
            return res.redirect('/signin' + (queryNext !== '/' ? '?next=' + encodeURIComponent(queryNext) : ''));
        }
        return res.render('auth/otp', {
            page_title:       'Verify code',
            _layoutFile:      '../_layout',
            active_nav:       '',
            extra_js:         '/js/pages/otp.js',
            show_promo_strip: false,
            // Focused flow — no header / footer / bottom-nav / drawer.
            // Back link inside the card lets the user return to step 1.
            bare:             true,
            phone_display:    formatPhoneDisplay(pending.country_code, pending.contact_no),
            next:             pending.next || queryNext,
        });
    }

    // ── step=profile ─────────────────────────────────────────────
    // Requires OTP-verified state in session. Otherwise bounce back.
    if (step === 'profile') {
        if (!pending || !pending.contact_no || !pending.otp_verified) {
            return res.redirect('/signin' + (queryNext !== '/' ? '?next=' + encodeURIComponent(queryNext) : ''));
        }
        return res.render('auth/profile', {
            page_title:       'Personal details',
            _layoutFile:      '../_layout',
            active_nav:       '',
            extra_js:         '/js/pages/profile.js',
            show_promo_strip: false,
            bare:             true,
            next:             pending.next || queryNext,
        });
    }

    // ── Default: step 1 (mobile-number entry) ───────────────────
    // Clear any half-finished auth state so the user starts fresh.
    if (req.session) { req.session.pendingAuth = null; }
    return res.render('auth/signin', {
        page_title:       'Sign in',
        _layoutFile:      '../_layout',
        active_nav:       '',
        extra_js:         '/js/pages/signin.js',
        show_promo_strip: false,
        bare:             true,
        next:             queryNext,
    });
}

// ── POST handlers ─────────────────────────────────────────────────

/**
 * startOtp
 *
 * What:  Step 1 → Step 2 transition. Calls /api/v1/auth/send-otp, and on
 *        success stashes (country_code, contact_no, next) in
 *        req.session.pendingAuth so step 2 / 3 can find them.
 * Type:  WRITE (session + api call).
 */
async function startOtp(req, res) {
    const country = normaliseCountry((req.body && req.body.country_dial) || (req.body && req.body.country_code));
    const contact = normalisePhone(req.body && req.body.mobile);
    const next    = safeNext((req.body && req.body.next) || (req.query && req.query.next));

    if (!country || !contact) {
        req.flash('error', 'Please enter your mobile number.');
        return res.redirect('/signin' + (next !== '/' ? '?next=' + encodeURIComponent(next) : ''));
    }

    const apiRes = await callApi(req, 'POST', '/api/v1/auth/send-otp', {
        country_code: country,
        contact_no:   contact,
    });

    if (!apiRes.body || apiRes.body.status !== 200) {
        const msg = (apiRes.body && apiRes.body.msg) || 'Could not send the verification code. Please try again.';
        req.flash('error', msg);
        return res.redirect('/signin' + (next !== '/' ? '?next=' + encodeURIComponent(next) : ''));
    }

    req.session.pendingAuth = {
        country_code: country,
        contact_no:   contact,
        next:         next,
        otp_verified: false,
        // Dev-only convenience — surfaces the demo OTP into a flash so
        // the developer doesn't have to inspect the DB while testing.
        dev_otp:      (apiRes.body.data && apiRes.body.data.dev_otp) || null,
    };

    if (apiRes.body.data && apiRes.body.data.dev_otp) {
        req.flash('success', 'Demo OTP: ' + apiRes.body.data.dev_otp);
    }

    // Persist the session (pendingAuth + flash) BEFORE redirecting. The
    // file-backed store writes async, so a bare redirect races the next
    // GET /signin?step=otp — which then finds no pendingAuth and bounces
    // straight back to step 1 (only the flash shows, the OTP page never
    // loads). Saving first guarantees the OTP page sees the pending number.
    return req.session.save(function () {
        res.redirect('/signin?step=otp');
    });
}

/**
 * verifyOtp
 *
 * What:  Step 2 → (Step 3 OR landing) transition. Calls
 *        /api/v1/auth/verify-otp. Branches on customer_status:
 *          'existing' → req.session.user set, redirect to next
 *          'new' / 'pending' → redirect to ?step=profile
 *          'banned' / 'disabled' / 'deleted' → flash + back to /signin
 * Type:  WRITE.
 */
async function verifyOtp(req, res) {
    const pending = (req.session && req.session.pendingAuth) || null;
    if (!pending || !pending.contact_no) {
        return res.redirect('/signin');
    }
    const otp = String((req.body && req.body.otp) || '').replace(/\D/g, '');

    if (otp.length !== 6) {
        req.flash('error', 'Please enter the 6-digit verification code.');
        return res.redirect('/signin?step=otp');
    }

    const apiRes = await callApi(req, 'POST', '/api/v1/auth/verify-otp', {
        country_code: pending.country_code,
        contact_no:   pending.contact_no,
        otp,
    });

    const body = apiRes.body || {};
    if (body.status === 403) {
        // Account blocked. Wipe the pending state and surface the api's
        // user-safe wording.
        req.session.pendingAuth = null;
        req.flash('error', body.msg || 'This account cannot sign in right now.');
        return res.redirect('/signin');
    }
    if (body.status !== 200) {
        req.flash('error', body.msg || 'The verification code is incorrect or has expired.');
        return res.redirect('/signin?step=otp');
    }

    const data    = body.data || {};
    const cstatus = data.customer_status;

    if (cstatus === 'existing' && data.customer) {
        // Real session login — minimal payload for now (JWT comes when
        // the api login endpoint lands in Phase 2).
        req.session.user        = data.customer;
        req.session.pendingAuth = null;
        req.flash('success', 'Welcome back, ' + (data.customer.firstname || '').trim() + '.');
        // Save before redirect so the landing page sees the logged-in user
        // (same async-store race as startOtp).
        return req.session.save(function () {
            redirectAfterSave(req, res, safeNext(pending.next));
        });
    }

    // 'new' or 'pending' → ask for Personal Details. Save first so the
    // step=profile page finds otp_verified=true (it gates on it).
    req.session.pendingAuth = { ...pending, otp_verified: true, dev_otp: null };
    return req.session.save(function () {
        res.redirect('/signin?step=profile');
    });
}

/**
 * saveProfile
 *
 * What:  Step 3 submit. Calls /api/v1/auth/save-profile. On success
 *        clears the pending state and signs the user in.
 * Type:  WRITE.
 */
async function saveProfile(req, res) {
    const pending = (req.session && req.session.pendingAuth) || null;
    if (!pending || !pending.contact_no || !pending.otp_verified) {
        return res.redirect('/signin');
    }

    // The form has a single "What's your name?" field — split it into
    // first / last on the simplest rule (first word vs the rest). Most
    // users type a single name; if they type two, we keep both.
    const nameRaw  = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ');
    const spaceIdx = nameRaw.indexOf(' ');
    const firstname = spaceIdx === -1 ? nameRaw : nameRaw.slice(0, spaceIdx);
    const lastname  = spaceIdx === -1 ? ''      : nameRaw.slice(spaceIdx + 1);
    const email     = String((req.body && req.body.email) || '').trim();
    // Optional "Invite & Earn" code from a friend → binds referred_by.
    const referredCode = String((req.body && req.body.referred_code) || '').trim();

    if (!firstname) {
        req.flash('error', 'Please enter your name.');
        return res.redirect('/signin?step=profile');
    }

    const apiRes = await callApi(req, 'POST', '/api/v1/auth/save-profile', {
        country_code:  pending.country_code,
        contact_no:    pending.contact_no,
        firstname,
        lastname,
        email,
        referred_code: referredCode,
    });

    const body = apiRes.body || {};
    if (body.status === 403) {
        req.session.pendingAuth = null;
        req.flash('error', body.msg || 'This account cannot sign in right now.');
        return res.redirect('/signin');
    }
    if (body.status !== 200 || !body.data || !body.data.customer) {
        req.flash('error', body.msg || 'Could not save your details. Please try again.');
        return res.redirect('/signin?step=profile');
    }

    req.session.user        = body.data.customer;
    req.session.pendingAuth = null;
    // Just signed up → let the home page show the one-time "new customer"
    // welcome strip on the next load (SiteController clears it after showing).
    req.session.welcomeOnce = true;
    req.flash('success', 'Welcome to ' + (res.locals.brand && res.locals.brand.name ? res.locals.brand.name : 'EatNDeal') + ', ' + firstname + '.');
    // Save before redirect so the landing page is already signed-in.
    return req.session.save(function () {
        redirectAfterSave(req, res, safeNext(pending.next));
    });
}

/**
 * accountPage
 *
 * What:  GET /account — the signed-in user's profile screen. Shows their
 *        name + email + phone (read-only — the phone is the identity
 *        key and can't be edited here) and lets them update name +
 *        email via the same page's POST handler.
 *
 *        Unauthenticated visitors are bounced to /signin with a
 *        `next=/account` so they land back here after the OTP flow.
 * Type:  READ.
 */
async function accountPage(req, res) {
    let user = (req.session && req.session.user) || null;
    if (!user) {
        return res.redirect('/signin?next=' + encodeURIComponent('/account'));
    }

    // Re-hydrate from the DB so the form always shows the latest values
    // (birthdate / gender, etc.) — the stored session.user may predate
    // those fields being added to the public view. Best-effort: if the
    // refresh fails we just render the session copy.
    try {
        const apiRes = await callApi(req, 'GET', '/api/v1/auth/me?customer_id=' + encodeURIComponent(user.id));
        if (apiRes.body && apiRes.body.status === 200 && apiRes.body.data && apiRes.body.data.customer) {
            user = apiRes.body.data.customer;
            req.session.user = user;
        }
    } catch (e) { /* keep the session copy */ }

    // Profile stats — fetched in parallel on every render so the
    // counts at the bottom of the My Profile card are accurate even
    // when the customer hasn't opened the Orders / Favourites tabs
    // yet. Each call is wrapped in its own try/catch so one slow or
    // failing endpoint can't blank the whole stats row.
    const stats = {
        orders:       0,
        favourites:   0,
        rewardPoints: Number(user.loyalty_points) || 0,
        offers:       0,
    };
    const statQS = new URLSearchParams({ customer_id: String(user.id) });
    const [ordersStatRes, favsStatRes] = await Promise.all([
        callApi(req, 'GET', '/api/v1/customer/orders?'     + statQS.toString()).catch(() => null),
        callApi(req, 'GET', '/api/v1/customer/favourites?' + statQS.toString()).catch(() => null),
    ]);
    if (ordersStatRes && ordersStatRes.body && ordersStatRes.body.status === 200 && ordersStatRes.body.data) {
        stats.orders = (ordersStatRes.body.data.orders || []).length;
    }
    if (favsStatRes && favsStatRes.body && favsStatRes.body.status === 200 && favsStatRes.body.data) {
        stats.favourites = (favsStatRes.body.data.favourites || []).length;
    }

    // Which account tab is active. Only "profile" has a real screen today;
    // the rest render a placeholder panel (with the tab highlighted) until
    // those features land. "help" is a separate page, not a tab here.
    const TABS = {
        profile:       'My Profile',
        addresses:     'Addresses',
        payment:       'Payment Methods',
        orders:        'My Orders',
        favourites:    'Favourites',
        rewards:       'Rewards',
        notifications: 'Notifications',
        settings:      'Settings',
    };
    let activeTab = String((req.query && req.query.tab) || 'profile').toLowerCase();
    if (!TABS[activeTab]) { activeTab = 'profile'; }

    // Favourites tab — fetch the customer's saved restaurants so the
    // panel renders the live list. Other tabs still show their
    // placeholder until those features land.
    let favourites = null;
    if (activeTab === 'favourites') {
        try {
            const loc = (req.session && req.session.userLocation) || {};
            const qs = new URLSearchParams({ customer_id: String(user.id) });
            if (loc.lat != null && loc.lat !== '') { qs.set('lat', String(loc.lat)); }
            if (loc.lng != null && loc.lng !== '') { qs.set('lng', String(loc.lng)); }
            const favRes = await callApi(req, 'GET', '/api/v1/customer/favourites?' + qs.toString());
            if (favRes.body && favRes.body.status === 200 && favRes.body.data) {
                favourites = favRes.body.data.favourites || [];
            } else {
                favourites = [];
            }
        } catch (e) { favourites = []; }
        stats.favourites = favourites.length;
    }

    // Orders tab — fetch the customer's marketplace orders (newest
    // first, paginated). Same envelope handling as favourites.
    let orders = null;
    // Order filters carried in the URL query (?status=&search=&date_from=&date_to=).
    const orderFilters = {
        status:    ['active', 'completed', 'cancelled'].indexOf(String(req.query.status || '')) !== -1 ? String(req.query.status) : '',
        search:    String(req.query.search || '').trim().slice(0, 60),
        date_from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from || '') ? req.query.date_from : '',
        date_to:   /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to || '') ? req.query.date_to : '',
    };
    if (activeTab === 'orders') {
        try {
            const qs = new URLSearchParams({ customer_id: String(user.id), limit: '20' });
            if (orderFilters.status)    { qs.set('status', orderFilters.status); }
            if (orderFilters.search)    { qs.set('search', orderFilters.search); }
            if (orderFilters.date_from) { qs.set('date_from', orderFilters.date_from); }
            if (orderFilters.date_to)   { qs.set('date_to', orderFilters.date_to); }
            const oRes = await callApi(req, 'GET', '/api/v1/customer/orders?' + qs.toString());
            orders = (oRes.body && oRes.body.status === 200 && oRes.body.data && oRes.body.data.orders) || [];
        } catch (e) { orders = []; }
        stats.orders = orders.length;
    }

    // Addresses tab — fetch the customer's saved-address book so the
    // tab renders the live list inline (same cards + actions the
    // location modal shows, no popup needed).
    let addresses = null;
    if (activeTab === 'addresses') {
        try {
            const qs = new URLSearchParams({ customer_id: String(user.id) });
            const aRes = await callApi(req, 'GET', '/api/v1/customer/addresses?' + qs.toString());
            addresses = (aRes.body && aRes.body.status === 200 && aRes.body.data && aRes.body.data.addresses) || [];
        } catch (e) { addresses = []; }
    }

    // Payment Methods tab — pull saved cards from Stripe via the api.
    // Returns an empty list when Stripe isn't configured OR the customer
    // has never saved one; the UI handles both with the same empty state.
    let paymentMethods = null;
    if (activeTab === 'payment') {
        try {
            const qs = new URLSearchParams({ customer_id: String(user.id) });
            const pmRes = await callApi(req, 'GET', '/api/v1/customer/payment-methods?' + qs.toString());
            paymentMethods = (pmRes.body && pmRes.body.status === 200 && pmRes.body.data && pmRes.body.data.paymentMethods) || [];
        } catch (e) { paymentMethods = []; }
    }

    // Profile tab — load the optional "About You" preferences so the
    // "Complete your profile" section renders pre-filled. Best-effort:
    // null (no row / not enabled / failed) just shows an empty form.
    let about = null;
    if (activeTab === 'profile') {
        try {
            const abRes = await callApi(req, 'GET', '/api/v1/auth/about?customer_id=' + encodeURIComponent(user.id));
            if (abRes.body && abRes.body.status === 200 && abRes.body.data) {
                about = abRes.body.data.about || null;
            }
        } catch (e) { about = null; }
    }

    // Rewards tab — the customer's per-restaurant reward cards (loyalty).
    // Each restaurant is a separate card/balance; null/[] = empty wallet.
    let rewardCards = null;
    if (activeTab === 'rewards') {
        try {
            const rwRes = await callApi(req, 'GET', '/api/v1/customer/loyalty/wallet?customer_id=' + encodeURIComponent(user.id));
            rewardCards = (rwRes.body && rwRes.body.status === 200 && rwRes.body.data && rwRes.body.data.cards) || [];
        } catch (e) { rewardCards = []; }
    }

    return res.render('account/index', {
        page_title:       TABS[activeTab],
        _layoutFile:      '../_layout',
        // The account page hosts both the Profile area and the Orders
        // tab (the bottom-nav "Orders" item routes here via /orders).
        // Highlight the matching bottom-nav icon: Orders when the orders
        // tab is open, otherwise Profile.
        active_nav:       activeTab === 'orders' ? 'orders' : 'profile',
        // Only the Profile EDIT screen becomes the chrome-less focused
        // "app screen" on mobile (it has its own sticky save bar). Every
        // other tab (Addresses / Payment / Orders / Favourites / Rewards)
        // keeps the site header + bottom-nav like the Orders screen, so the
        // whole account section feels consistent on a phone. The CSS keys
        // the focused treatment off the body class `view-profilefocus`
        // (set via view_mode) instead of active_nav.
        view_mode:        activeTab === 'profile' ? 'profilefocus' : '',
        extra_js:         '/js/pages/account.js',
        // Full site chrome (header + footer) like the mockup, but NO promo
        // strip on this page.
        show_promo_strip: false,
        bare:             false,
        account_user:     user,
        account_stats:    stats,
        active_tab:       activeTab,
        active_tab_label: TABS[activeTab],
        favourites:       favourites,
        orders:           orders,
        addresses:        addresses,
        payment_methods:  paymentMethods,
        account_about:    about,
        reward_cards:     rewardCards,
        // Invite & Earn — the customer's own referral code (from /auth/me).
        referral_code:    user.referral_code || '',
        // Order-history filter state (echoed back into the filter bar).
        order_filters:    orderFilters,
    });
}

/**
 * updateProfile
 *
 * What:  POST /account — saves name / email / phone changes for the
 *        signed-in customer. Calls /api/v1/auth/update-profile which
 *        looks the row up by customer_id (NOT by phone — that lookup
 *        would fail if the phone itself is what's changing).
 *
 *        Phone is OPTIONAL on this form:
 *          • Social-signup users have NULL phone and add one here.
 *          • OTP-signup users already have a phone; they can edit it
 *            in place (no re-OTP for now — Phase 2 will add a verify
 *            step before accepting a new number).
 * Type:  WRITE.
 */
async function updateProfile(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) {
        return res.redirect('/signin?next=' + encodeURIComponent('/account'));
    }

    // Same name-splitting rule as the sign-up flow — first word vs the
    // rest. Trim whitespace + collapse multiple spaces.
    const nameRaw  = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ');
    const spaceIdx = nameRaw.indexOf(' ');
    const firstname = spaceIdx === -1 ? nameRaw : nameRaw.slice(0, spaceIdx);
    const lastname  = spaceIdx === -1 ? ''      : nameRaw.slice(spaceIdx + 1);
    const email     = String((req.body && req.body.email) || '').trim();

    // Phone fields — both empty = no change. Otherwise both must be
    // populated (the api enforces the "travel together" rule too).
    const country   = normaliseCountry((req.body && req.body.country_dial) || (req.body && req.body.country_code));
    const contact   = normalisePhone(req.body && req.body.mobile);

    if (!firstname) {
        req.flash('error', 'Please enter your name.');
        return res.redirect('/account');
    }
    if (Boolean(country) !== Boolean(contact)) {
        req.flash('error', 'Please enter both your country code and mobile number.');
        return res.redirect('/account');
    }

    const payload = {
        customer_id: user.id,
        firstname,
        lastname,
        email,
    };
    if (contact) {
        payload.country_code = country;
        payload.contact_no   = contact;
    }
    // NOTE: gender + date-of-birth are NOT sent here anymore — they're
    // saved into customer_profile via /auth/update-about below (forwarded
    // in aboutPayload). Only name / email / phone live on the customer row.

    const apiRes = await callApi(req, 'POST', '/api/v1/auth/update-profile', payload);

    const body = apiRes.body || {};
    if (body.status === 403) {
        // Account just got disabled / banned while signed in — wipe the
        // session so a refresh sends them through sign-in again.
        req.session.user = null;
        req.flash('error', body.msg || 'This account cannot be updated.');
        return res.redirect('/');
    }
    if (body.status === 409) {
        // Duplicate phone — surface as a non-destructive error.
        req.flash('error', body.msg || 'That mobile number is already in use.');
        return res.redirect('/account');
    }
    if (body.status !== 200 || !body.data || !body.data.customer) {
        req.flash('error', body.msg || 'Could not save your details. Please try again.');
        return res.redirect('/account');
    }

    req.session.user = body.data.customer;

    // Optional "About You" preferences — present only when the profile
    // form's section was rendered (hidden about_present=1). Forwarded to
    // the api, which sanitises every value against the allowed option
    // lists. Best-effort: a failure here doesn't undo the profile save —
    // it just surfaces a soft warning. (gender / DOB / photo are NOT here —
    // they were saved above on the customer row.)
    if (String((req.body && req.body.about_present) || '') === '1') {
        const arr = function (v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); };
        const aboutPayload = {
            customer_id:                  user.id,
            // gender + dob now save into customer_profile (the basic-card
            // Gender/DOB controls post into this same form).
            gender:                       String((req.body && req.body.gender) || '').trim().toLowerCase(),
            dob:                          String((req.body && req.body.birthdate) || '').trim(),
            anniversary_date:             String((req.body && req.body.anniversary_date) || '').trim(),
            favorite_food_category:       arr(req.body && req.body.favorite_food_category),
            other_food_category:          String((req.body && req.body.other_food_category) || '').trim(),
            order_type:                   String((req.body && req.body.order_type) || '').trim(),
            takeaway_frequency:           String((req.body && req.body.takeaway_frequency) || '').trim(),
            offer_time:                   arr(req.body && req.body.offer_time),
            hear_about_us:                String((req.body && req.body.hear_about_us) || '').trim(),
            work_in_hospitality_industry: String((req.body && req.body.work_in_hospitality_industry) || '').trim(),
            family_size:                  String((req.body && req.body.family_size) || '').trim(),
            has_children:                 String((req.body && req.body.has_children) || '').trim(),
            is_student:                   String((req.body && req.body.is_student) || '').trim(),
            work_nearby:                  String((req.body && req.body.work_nearby) || '').trim(),
            marketing_preferences:        arr(req.body && req.body.marketing_preferences),
        };
        try {
            const abRes = await callApi(req, 'POST', '/api/v1/auth/update-about', aboutPayload);
            if (!abRes.body || abRes.body.status !== 200) {
                req.flash('error', (abRes.body && abRes.body.msg) || 'Your details were saved, but some preferences could not be.');
                return res.redirect('/account');
            }
        } catch (e) {
            req.flash('error', 'Your details were saved, but your preferences could not be saved — please try again.');
            return res.redirect('/account');
        }
    }

    req.flash('success', 'Your profile has been updated.');
    return res.redirect('/account');
}

/**
 * oauthRedirect
 *
 * What:  Step 1 of the social-sign-in dance — kicks the user out to
 *        the provider's sign-in page.
 *          • Validates the provider name (google | facebook).
 *          • Refuses if the provider isn't configured (no CLIENT_ID/SECRET).
 *          • Mints a random 16-byte `state` and stashes it on
 *            req.session.oauthState alongside the requested next-URL.
 *            On callback we compare the returned `state` to this value
 *            — stops CSRF (an attacker forging a callback for a victim
 *            can't guess the state value).
 *          • Redirects to the provider's authorize endpoint.
 *
 * Why:   Single entry-point keeps the redirect details (URL building,
 *        scopes) inside Helpers/oauthProviders.js.
 *
 * Type:  WRITE (session).
 * Used:  GET /signin/oauth/:provider.
 */
function oauthRedirect(req, res) {
    const provider = String(req.params && req.params.provider || '').toLowerCase();
    const next     = safeNext(req.query && req.query.next);

    if (!OAUTH_PROVIDERS.has(provider)) {
        return res.redirect('/signin');
    }
    if (!oauth.isConfigured(provider)) {
        req.flash('error', provider.charAt(0).toUpperCase() + provider.slice(1) + ' sign-in is not configured yet.');
        return res.redirect('/signin' + (next !== '/' ? '?next=' + encodeURIComponent(next) : ''));
    }

    // `?app=1` marks a sign-in started from the mobile app (opened in a Chrome
    // Custom Tab). We stash it in the state so the callback knows to hand the
    // result back to the app via a deep link instead of rendering a web page.
    const isApp = String((req.query && req.query.app) || '') === '1';

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = { provider, state, next, ts: Date.now(), app: isApp };

    const url = oauth.buildAuthUrl(provider, {
        state,
        redirectUri: oauth.callbackUrl(provider, req),
    });
    // SAVE the session (with oauthState) BEFORE redirecting to the provider.
    // saveUninitialized:false + the async FileStore mean an immediate redirect
    // races the write — Google bounces back before oauthState is durable, so
    // the callback sees an empty session and shows "session expired" on the
    // FIRST attempt (the second works because the cookie/session now exist).
    // Saving first makes the state durable + sets the cookie up front.
    if (req.session && typeof req.session.save === 'function') {
        return req.session.save(function () { res.redirect(url); });
    }
    return res.redirect(url);
}

/**
 * oauthCallback
 *
 * What:  Step 2 — the provider sent the user back to us with `?code=...
 *        &state=...`. We:
 *          1. Confirm the state matches what we stashed (CSRF guard).
 *          2. Exchange the code for tokens at the provider.
 *          3. POST the resulting token to /api/v1/auth/social-signin.
 *             The api verifies the token + upserts the customer.
 *          4. Set req.session.user and redirect to the original `next`.
 *
 *        Failure modes all redirect back to /signin with a flash error
 *        — never crash the page or surface raw provider messages.
 *
 * Type:  WRITE (session + api call + external HTTPS).
 * Used:  GET /signin/oauth/:provider/callback.
 */
async function oauthCallback(req, res) {
    const provider = String(req.params && req.params.provider || '').toLowerCase();
    const stashed  = (req.session && req.session.oauthState) || null;

    // Clear the stash early — even on failure, a stale state value
    // shouldn't linger and let a retry succeed without a fresh state.
    if (req.session) { req.session.oauthState = null; }

    if (!OAUTH_PROVIDERS.has(provider)) {
        return res.redirect('/signin');
    }
    if (req.query && req.query.error) {
        // User clicked "Cancel" at Google/Facebook, OR the provider
        // returned an error. `error_description` is the user-readable
        // bit when provided.
        const reason = String(req.query.error_description || req.query.error);
        req.flash('error', reason || 'Sign-in was cancelled.');
        return res.redirect('/signin');
    }
    if (!stashed || stashed.provider !== provider) {
        req.flash('error', 'Sign-in session expired. Please try again.');
        return res.redirect('/signin');
    }
    if (!req.query || req.query.state !== stashed.state) {
        // CSRF guard — the state on the URL doesn't match the value we
        // generated. Either an attacker is replaying a callback, or the
        // user clicked an old tab. Either way: refuse.
        req.flash('error', 'Sign-in failed (bad state). Please try again.');
        return res.redirect('/signin');
    }

    const code        = String(req.query.code || '');
    const redirectUri = oauth.callbackUrl(provider, req);

    const exch = await oauth.exchangeCode(provider, { code, redirectUri });
    if (!exch.ok) {
        req.flash('error', exch.error || 'Sign-in failed. Please try again.');
        return res.redirect('/signin');
    }

    // Hand the verified token to the api, which does the customer
    // lookup / insert + returns the public-view row.
    const apiRes = await callApi(req, 'POST', '/api/v1/auth/social-signin', exch.payload);
    const body   = apiRes.body || {};

    if (body.status === 403) {
        req.flash('error', body.msg || 'This account cannot sign in right now.');
        return res.redirect('/signin');
    }
    if (body.status !== 200 || !body.data || !body.data.customer) {
        req.flash('error', body.msg || 'Could not complete sign-in.');
        return res.redirect('/signin');
    }

    req.session.user = body.data.customer;
    // A brand-new social signup → show the one-time "new customer" welcome
    // strip on the next home load (existing social logins don't get it).
    if (body.data.created) { req.session.welcomeOnce = true; }

    // ── Mobile-app handoff ────────────────────────────────────────────
    // This callback ran inside the app's Chrome Custom Tab, so the session
    // we just set lives THERE, not in the app's WebView. Mint a one-time
    // token carrying the signed-in customer and deep-link it back to the
    // app; the app then loads /app-auth?token=… inside the WebView to
    // establish the session where it's actually needed. (No web session
    // save needed here — the Custom-Tab session is throwaway.)
    if (stashed.app) {
        const handoff = appAuthTokens.issue({
            user:        body.data.customer,
            welcomeOnce: !!body.data.created,
            next:        safeNext(stashed.next),
        });
        return res.redirect(APP_AUTH_SCHEME + '://auth?token=' + encodeURIComponent(handoff));
    }

    // `needs_phone` is true when the customer came in fresh via social
    // and has no contact_no yet. Future: bounce them through a
    // mini-form to add a phone (required for checkout). For now we
    // surface a friendly nudge via flash and land at the next URL.
    if (body.data.needs_phone) {
        req.flash('success', 'Welcome! Add your mobile number from My profile to complete checkout later.');
    } else {
        req.flash('success', 'Welcome back, ' + (body.data.customer.firstname || '').trim() + '.');
    }

    return redirectAfterSave(req, res, safeNext(stashed.next));
}

/**
 * appAuth — GET /app-auth?token=…
 *
 * What:  Second half of the mobile-app social-sign-in handoff. The app, after
 *        catching the "<scheme>://auth?token=…" deep link from the Custom Tab,
 *        loads THIS url INSIDE its WebView. We consume the one-time token and
 *        set req.session.user on the WebView's session — so the WebView is now
 *        signed in — then redirect to the original `next`.
 * Why:   OAuth can't run inside a WebView (providers block it); this bridges
 *        the session from the external tab back into the app. See
 *        Helpers/appAuthTokens.js for the full rationale.
 * Type:  WRITE (session).
 * Used:  GET /app-auth (web/index.js).
 */
function appAuth(req, res) {
    const data = appAuthTokens.consume(req.query && req.query.token);
    if (!data || !data.user) {
        req.flash('error', 'Your sign-in link expired. Please try again.');
        return res.redirect('/signin');
    }
    req.session.user = data.user;
    if (data.welcomeOnce) { req.session.welcomeOnce = true; }
    req.flash('success', 'Welcome, ' + (data.user.firstname || '').trim() + '.');
    return redirectAfterSave(req, res, safeNext(data.next));
}

/**
 * redirectAfterSave
 *
 * What:  Persists the session to the store, THEN redirects. The
 *        file-backed session store writes asynchronously, so redirecting
 *        immediately after setting req.session.user can race the disk
 *        write — the next page load then reads the old session and shows
 *        the wrong logged-in/out state until a manual refresh. Saving
 *        first guarantees the new state is durable before we navigate.
 * Type:  WRITE.
 */
function redirectAfterSave(req, res, url) {
    if (!req.session || typeof req.session.save !== 'function') { return res.redirect(url); }
    req.session.save(function () { res.redirect(url); });
}

/**
 * uploadAvatar
 *
 * What:  POST /account/avatar — multer has already stored the uploaded
 *        file on the web disk (web/runtime/avatars) and set req.file. We
 *        forward the resulting web-relative path to the api to persist on
 *        customer.image, then refresh the session so the header + profile
 *        show the new photo. Returns JSON for the in-page uploader.
 * Type:  WRITE.
 */
async function uploadAvatar(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) { return res.status(200).json({ status: 401, show: true, msg: 'Please sign in.' }); }
    if (!req.file) { return res.status(200).json({ status: 400, show: true, msg: 'Please choose an image (PNG or JPG, under 3 MB).' }); }

    // Avatar is one of the 4 "our-server" media types (community, home feed,
    // avatar, marketplace category). multer wrote the file into the shared api
    // upload tree (MEDIA_DIR/avatar). We persist only the RELATIVE path; the
    // api turns it into a full url on read — the web never builds the url.
    const mediaUrl = (process.env.MEDIA_URL || '/upload').replace(/\/$/, '');
    const imagePath = mediaUrl + '/avatar/' + req.file.filename;
    const apiRes = await callApi(req, 'POST', '/api/v1/auth/update-avatar', { customer_id: user.id, image: imagePath });
    const body = apiRes.body || {};

    if (body.status !== 200 || !body.data || !body.data.customer) {
        // Persistence failed — remove the orphaned file so it doesn't pile up.
        // req.file.path is the actual saved location (whatever MEDIA_DIR resolved to).
        try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
        return res.status(200).json({ status: body.status || 502, show: true, msg: body.msg || 'Could not save your photo. Please try again.' });
    }

    req.session.user = body.data.customer;
    // Persist the session before replying so the header avatar reflects the
    // new photo immediately on the next render (file-store writes async).
    return req.session.save(function () {
        // Hand back the FULL url the api built (customer.image), not the
        // relative path — so the in-page uploader shows the photo at once.
        res.status(200).json({ status: 200, show: false, msg: 'Profile photo updated.', data: { image: body.data.customer.image } });
    });
}

/**
 * changePhoneSendOtp
 *
 * What:  POST /account/phone/send-otp — sends an OTP to the NEW mobile number
 *        the signed-in customer typed on My Profile. Reuses /auth/send-otp.
 *        Returns the JSON envelope for the in-page AJAX flow.
 * Type:  WRITE.
 */
async function changePhoneSendOtp(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const country = normaliseCountry((req.body && req.body.country_dial) || (req.body && req.body.country_code));
    const contact = normalisePhone(req.body && req.body.mobile);
    if (!country || !contact) {
        return res.status(200).json({ status: 422, show: true, msg: 'Please enter your new mobile number.' });
    }
    const apiRes = await callApi(req, 'POST', '/api/v1/auth/send-otp', { country_code: country, contact_no: contact });
    return relay(res, apiRes);
}

/**
 * changePhoneVerify
 *
 * What:  POST /account/phone/verify — verifies the OTP for the new number and
 *        (on success) updates the customer's mobile via /auth/change-phone. The
 *        session user is refreshed so the header/profile show the new number.
 *        The customer's loyalty auto-re-syncs to the new number on the next
 *        loyalty/checkout read (handled entirely in the api).
 * Type:  WRITE.
 */
async function changePhoneVerify(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const country = normaliseCountry((req.body && req.body.country_dial) || (req.body && req.body.country_code));
    const contact = normalisePhone(req.body && req.body.mobile);
    const otp     = String((req.body && req.body.otp) || '').replace(/\D/g, '');
    const apiRes  = await callApi(req, 'POST', '/api/v1/auth/change-phone', {
        customer_id: user.id, country_code: country, contact_no: contact, otp,
    });
    const body = apiRes && apiRes.body;
    if (body && body.status === 200 && body.data && body.data.customer) {
        req.session.user = body.data.customer;
        return req.session.save(function () { return relay(res, apiRes); });
    }
    return relay(res, apiRes);
}

/**
 * deleteAccount
 *
 * What:  POST /account/delete — soft-deletes the signed-in customer's account
 *        (api sets status='2'), then wipes the session (fresh id — like a clean
 *        sign-out) while KEEPING the chosen location, and tells the client to
 *        redirect home.
 * Type:  WRITE.
 */
async function deleteAccount(req, res) {
    const user = requireUser(req, res, 'Please sign in.');
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/auth/delete-account', { customer_id: user.id });
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        const loc = (req.session && req.session.userLocation) || null;
        return req.session.regenerate(function () {
            if (loc && req.session) { req.session.userLocation = loc; }
            const done = function () { res.status(200).json({ status: 200, show: false, msg: body.msg || 'Account deleted.', data: { redirect: '/' } }); };
            if (req.session && typeof req.session.save === 'function') { return req.session.save(done); }
            return done();
        });
    }
    return relay(res, apiRes);
}

/**
 * signOut
 *
 * What:  Signs the customer out and bounces home — but KEEPS the chosen
 *        delivery/pickup location so the home page shows the restaurant
 *        feed, not the "Step 1 of 3" location picker. The location isn't
 *        tied to the account (the guest already picked it), so wiping it on
 *        logout just made people re-enter their postcode for no reason.
 *        Mounted on POST so it can't be triggered by a stray <img src>.
 * Type:  WRITE.
 */
function signOut(req, res) {
    if (!req.session) { return res.redirect('/'); }
    // Stash the location, then REGENERATE the session (fresh id — drops the
    // signed-in user + everything else, a clean sign-out) and re-attach
    // only that location. regenerate()'s callback runs AFTER the store
    // write, so there's no stale-session race (the reason the old code
    // destroyed the whole session instead of nulling the user).
    const loc = req.session.userLocation || null;
    req.session.regenerate(function (err) {
        if (!err && loc && req.session) { req.session.userLocation = loc; }
        const done = function () { res.redirect('/'); };
        if (req.session && typeof req.session.save === 'function') {
            return req.session.save(done);
        }
        return done();
    });
}

module.exports = {
    signinPage,
    startOtp,
    verifyOtp,
    saveProfile,
    accountPage,
    updateProfile,
    uploadAvatar,
    oauthRedirect,
    oauthCallback,
    appAuth,
    changePhoneSendOtp,
    changePhoneVerify,
    deleteAccount,
    signOut,
};
