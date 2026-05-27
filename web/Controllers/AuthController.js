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
const { callApi }  = require('../Helpers/apiClient');
const oauth        = require('../Helpers/oauthProviders');

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

    return res.redirect('/signin?step=otp');
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
        return res.redirect(safeNext(pending.next));
    }

    // 'new' or 'pending' → ask for Personal Details.
    req.session.pendingAuth = { ...pending, otp_verified: true, dev_otp: null };
    return res.redirect('/signin?step=profile');
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

    if (!firstname) {
        req.flash('error', 'Please enter your name.');
        return res.redirect('/signin?step=profile');
    }

    const apiRes = await callApi(req, 'POST', '/api/v1/auth/save-profile', {
        country_code: pending.country_code,
        contact_no:   pending.contact_no,
        firstname,
        lastname,
        email,
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
    req.flash('success', 'Welcome to ' + (res.locals.brand && res.locals.brand.name ? res.locals.brand.name : 'EatNDeal') + ', ' + firstname + '.');
    return res.redirect(safeNext(pending.next));
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
function accountPage(req, res) {
    const user = (req.session && req.session.user) || null;
    if (!user) {
        return res.redirect('/signin?next=' + encodeURIComponent('/account'));
    }
    return res.render('account/index', {
        page_title:       'My profile',
        _layoutFile:      '../_layout',
        active_nav:       '',
        extra_js:         '/js/pages/account.js',
        show_promo_strip: false,
        account_user:     user,
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

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = { provider, state, next, ts: Date.now() };

    const url = oauth.buildAuthUrl(provider, {
        state,
        redirectUri: oauth.callbackUrl(provider, req),
    });
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

    // `needs_phone` is true when the customer came in fresh via social
    // and has no contact_no yet. Future: bounce them through a
    // mini-form to add a phone (required for checkout). For now we
    // surface a friendly nudge via flash and land at the next URL.
    if (body.data.needs_phone) {
        req.flash('success', 'Welcome! Add your mobile number from My profile to complete checkout later.');
    } else {
        req.flash('success', 'Welcome back, ' + (body.data.customer.firstname || '').trim() + '.');
    }

    return res.redirect(safeNext(stashed.next));
}

/**
 * signOut
 *
 * What:  Clears the session user + pending auth and bounces home. Mounted
 *        on POST so it can't be triggered by a stray <img src> or link.
 * Type:  WRITE.
 */
function signOut(req, res) {
    if (req.session) {
        req.session.user        = null;
        req.session.pendingAuth = null;
    }
    return res.redirect('/');
}

module.exports = {
    signinPage,
    startOtp,
    verifyOtp,
    saveProfile,
    accountPage,
    updateProfile,
    oauthRedirect,
    oauthCallback,
    signOut,
};
