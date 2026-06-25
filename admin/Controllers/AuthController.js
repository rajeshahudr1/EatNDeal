'use strict';

/*
 * Controllers/AuthController.js
 *
 * What:  Admin-side auth on the admin (PWA) layer. A single email + password
 *        login screen plus the POST handler that authenticates via the api:
 *
 *          GET  /login   → render the login page (bare layout)
 *          POST /login   → validate, call api, set session, redirect
 *          POST /logout  → destroy the session, back to /login
 *
 * Why:   Coding-Conventions — the admin layer NEVER touches the database.
 *        Credentials are posted to the api which owns the admin table and
 *        issues the session JWT. We only store that token + a small admin
 *        profile object on req.session.
 *
 * Type:  READ + WRITE (writes to req.session; calls api endpoints).
 * Used:  Wired in admin/index.js.
 *
 * Change log:
 *   2026-06-09 — initial login + logout.
 */

const { callApi }      = require('../Helpers/apiClient');
const { validateLogin } = require('../Validators/auth');

// The api endpoint that authenticates an admin and returns { token, admin }.
// Kept as a constant so there is one place to change if the route moves.
const ADMIN_LOGIN_PATH = '/api/v1/admin/auth/login';

/**
 * safeNext
 *
 * What:  Sanitises the post-login redirect target. Only same-origin
 *        ABSOLUTE paths ("/something") are allowed — never a full URL —
 *        so a crafted ?next=https://evil.com cannot turn the login into
 *        an open redirect.
 * Type:  READ (pure).
 */
function safeNext(raw) {
    const v = String(raw || '').trim();
    if (v.startsWith('/') && !v.startsWith('//')) { return v; }
    return '/';
}

/**
 * loginPage
 *
 * What:  Renders the admin login screen. If an admin is already signed in,
 *        skip straight to wherever they were headed. Prefills the email
 *        from a failed previous attempt (stashed on the session) so the
 *        admin does not have to retype it.
 * Type:  READ.
 */
function loginPage(req, res) {
    if (req.session && req.session.admin) {
        return res.redirect(safeNext(req.query.next));
    }

    // One-shot sticky email after a failed attempt.
    const prefillEmail = (req.session && req.session.loginEmail) || '';
    if (req.session) { delete req.session.loginEmail; }

    res.render('auth/login', {
        page_title:  'Sign in',
        _layoutFile: '../_layout',
        bare:        true,
        next:        safeNext(req.query.next),
        email:       prefillEmail,
        extra_js:    '/js/pages/login.js',
    });
}

/**
 * doLogin
 *
 * What:  Validates the submitted email + password, authenticates against the
 *        api, and on success stores the session token + admin profile then
 *        redirects to `next`. On any failure it flashes a friendly message
 *        and returns to /login with the email prefilled.
 * Type:  WRITE (req.session) + READ (api).
 */
async function doLogin(req, res) {
    const next = safeNext(req.body && req.body.next);

    // ── 1. Server-side validation (mirror of the client checks) ──
    const check = validateLogin(req.body);
    if (!check.ok) {
        if (req.session) { req.session.loginEmail = String((req.body && req.body.email) || '').trim(); }
        if (req.flash) { req.flash('error', check.message); }
        return res.redirect('/login?next=' + encodeURIComponent(next));
    }

    const { email, password } = check.value;

    // ── 2. Authenticate via the api ──
    let apiRes;
    try {
        apiRes = await callApi(req, 'POST', ADMIN_LOGIN_PATH, { email, password });
    } catch (err) {
        apiRes = { status: 0, body: null, networkError: err && err.message };
    }

    const body = apiRes && apiRes.body;

    // Network / api-down — be explicit so it is not mistaken for bad creds.
    if (apiRes && apiRes.networkError) {
        if (req.session) { req.session.loginEmail = email; }
        if (req.flash) { req.flash('error', 'Cannot reach the server right now. Please try again.'); }
        return res.redirect('/login?next=' + encodeURIComponent(next));
    }

    // ── 3. Success — store the session and go ──
    if (body && body.status === 200 && body.data && body.data.token) {
        req.session.token = body.data.token;
        req.session.admin = body.data.admin || { email };
        delete req.session.loginEmail;
        return req.session.save(() => res.redirect(next));
    }

    // ── 4. Rejected — wrong creds, disabled, or endpoint not built yet ──
    if (req.session) { req.session.loginEmail = email; }
    const msg = (body && body.msg)
        ? body.msg
        : 'Invalid email or password.';
    if (req.flash) { req.flash('error', msg); }
    return res.redirect('/login?next=' + encodeURIComponent(next));
}

/**
 * logout
 *
 * What:  Clears the admin session and returns to the login page.
 * Type:  WRITE (destroys req.session).
 */
function logout(req, res) {
    if (req.session) {
        return req.session.destroy(() => res.redirect('/login'));
    }
    return res.redirect('/login');
}

// ── Forgot / reset password ────────────────────────────────────────

/**
 * forgotPage
 *
 * What:  Renders the "Forgot password" screen (enter email).
 * Type:  READ.
 */
function forgotPage(req, res) {
    res.render('auth/forgot', {
        page_title:  'Forgot password',
        _layoutFile: '../_layout',
        bare:        true,
        sent:        false,
        email:       '',
        dev_reset_url: '',
        extra_js:    '/js/pages/auth-extra.js',
    });
}

/**
 * doForgot
 *
 * What:  Asks the api to issue a reset token for the submitted email, then
 *        re-renders the page in its "sent" state. The api always replies with
 *        the same generic message (anti-enumeration). In non-production the
 *        api also returns the token so we can show a clickable reset link
 *        here (no mailer is wired yet).
 * Type:  WRITE (via api) + READ.
 */
async function doForgot(req, res) {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();

    if (!email) {
        if (req.flash) { req.flash('error', 'Enter your email address.'); }
        return res.redirect('/forgot-password');
    }

    let apiRes;
    try {
        apiRes = await callApi(req, 'POST', '/api/v1/admin/auth/forgot-password', { email });
    } catch (err) {
        apiRes = { body: null, networkError: err && err.message };
    }
    const body = apiRes && apiRes.body;

    if (apiRes && apiRes.networkError) {
        if (req.flash) { req.flash('error', 'Cannot reach the server right now. Please try again.'); }
        return res.redirect('/forgot-password');
    }

    const ok = !!(body && body.status === 200);
    const devUrl = (ok && body.data && body.data.dev_token)
        ? ('/reset-password?token=' + encodeURIComponent(body.data.dev_token))
        : '';

    return res.render('auth/forgot', {
        page_title:    'Forgot password',
        _layoutFile:   '../_layout',
        bare:          true,
        sent:          ok,
        email,
        dev_reset_url: devUrl,
        extra_js:      '/js/pages/auth-extra.js',
    });
}

/**
 * resetPage
 *
 * What:  Renders the "Set a new password" screen for a reset token. The token
 *        rides in the query string (from the email / dev link) and is carried
 *        through as a hidden field.
 * Type:  READ.
 */
function resetPage(req, res) {
    const token = String((req.query && req.query.token) || '').trim();
    res.render('auth/reset', {
        page_title:  'Reset password',
        _layoutFile: '../_layout',
        bare:        true,
        token,
        extra_js:    '/js/pages/auth-extra.js',
    });
}

/**
 * doReset
 *
 * What:  Sends the token + new password to the api; on success bounces back to
 *        the login page with a success flash.
 * Type:  WRITE (via api).
 */
async function doReset(req, res) {
    const token    = String((req.body && req.body.token) || '').trim();
    const password = String((req.body && req.body.password) || '');

    if (!token) {
        if (req.flash) { req.flash('error', 'This reset link is missing its token.'); }
        return res.redirect('/login');
    }
    if (password.length < 6) {
        if (req.flash) { req.flash('error', 'Password must be at least 6 characters.'); }
        return res.redirect('/reset-password?token=' + encodeURIComponent(token));
    }

    let apiRes;
    try {
        apiRes = await callApi(req, 'POST', '/api/v1/admin/auth/reset-password', { token, password });
    } catch (err) {
        apiRes = { body: null, networkError: err && err.message };
    }
    const body = apiRes && apiRes.body;

    if (body && body.status === 200) {
        if (req.flash) { req.flash('success', body.msg || 'Your password has been reset. Please sign in.'); }
        return res.redirect('/login');
    }

    if (req.flash) { req.flash('error', (body && body.msg) || 'Could not reset your password. The link may have expired.'); }
    return res.redirect('/reset-password?token=' + encodeURIComponent(token));
}

// ── My Profile ──────────────────────────────────────────────────────

async function profilePage(req, res) {
    let profile = null;
    try {
        const r = await callApi(req, 'GET', '/api/v1/admin/auth/me');
        if (r && r.body && r.body.status === 200) { profile = r.body.data.profile; }
    } catch (e) { /* render empty form */ }
    res.render('auth/profile', {
        page_title:  'My Profile',
        _layoutFile: '../_layout',
        active_nav:  '',
        extra_js:    '/js/pages/account.js',
        profile,
    });
}

async function updateProfile(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/auth/profile', req.body); }
    catch (e) { apiRes = null; }
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        // Keep the topbar name/email in sync with the edit.
        if (req.session && req.session.admin) {
            const fn = String(req.body.first_name || '').trim();
            const ln = String(req.body.last_name || '').trim();
            const bn = String(req.body.business_name || '').trim();
            req.session.admin.name  = [fn, ln].filter(Boolean).join(' ') || bn || req.session.admin.name;
            // Email is never editable — leave req.session.admin.email untouched.
        }
        if (req.flash) { req.flash('success', body.msg || 'Profile updated.'); }
        return req.session.save(() => res.redirect('/profile'));
    }
    if (req.flash) { req.flash('error', (body && body.msg) || 'Could not update your profile.'); }
    return res.redirect('/profile');
}

// ── Change Password ─────────────────────────────────────────────────

function changePasswordPage(req, res) {
    res.render('auth/change-password', {
        page_title:  'Change Password',
        _layoutFile: '../_layout',
        active_nav:  '',
        extra_js:    '/js/pages/account.js',
    });
}

async function doChangePassword(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/admin/auth/change-password', req.body); }
    catch (e) { apiRes = null; }
    const body = apiRes && apiRes.body;
    if (body && body.status === 200) {
        if (req.flash) { req.flash('success', body.msg || 'Password changed.'); }
        return res.redirect('/change-password');
    }
    if (req.flash) { req.flash('error', (body && body.msg) || 'Could not change your password.'); }
    return res.redirect('/change-password');
}

module.exports = {
    loginPage, doLogin, logout, forgotPage, doForgot, resetPage, doReset,
    profilePage, updateProfile, changePasswordPage, doChangePassword,
};
