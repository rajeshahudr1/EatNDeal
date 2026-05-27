'use strict';

/*
 * Helpers/oauthProviders.js
 *
 * What:  Builds the provider-specific bits of the OAuth dance so the
 *        web AuthController stays provider-agnostic.
 *          • buildAuthUrl(provider, { state, redirectUri })  → the URL
 *            we redirect the browser to so the user can sign in at the
 *            provider's domain.
 *          • exchangeCode(provider, { code, redirectUri })   → swaps
 *            the `?code=...` we get on the callback for tokens. Returns
 *            { id_token } for Google or { access_token } for Facebook.
 *            Those tokens are then forwarded to api/v1/auth/social-signin
 *            which does the actual verification + customer upsert.
 *          • isConfigured(provider) — true iff env vars are set; the
 *            controller uses this to short-circuit a "not configured"
 *            toast before any redirect.
 *          • callbackUrl(provider, req) — the canonical callback URL
 *            we register with the provider AND echo back during the
 *            token exchange (must match exactly per OAuth spec).
 *
 * Why:   The redirect-flow OAuth code is the same shape for every
 *        provider — only the URLs, parameter names, and scopes differ.
 *        Centralising those differences here means
 *        web/Controllers/AuthController.js can call two functions and
 *        stay readable.
 *
 * Used:  web/Controllers/AuthController.js (oauthRedirect + oauthCallback).
 *
 * Change log:
 *   2026-05-26 — initial; Google + Facebook providers.
 */

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FB_AUTH_URL      = 'https://www.facebook.com/v18.0/dialog/oauth';
const FB_TOKEN_URL     = 'https://graph.facebook.com/v18.0/oauth/access_token';

/**
 * isConfigured
 *
 * What:  Returns true if BOTH the client id and client secret are set
 *        for the given provider — that's the minimum the redirect-flow
 *        needs. We surface this to the controller so a misconfigured
 *        provider shows a friendly toast instead of bouncing the user
 *        to a 400 page on Google / Facebook.
 * Type:  READ.
 */
function isConfigured(provider) {
    switch (String(provider || '').toLowerCase()) {
        case 'google':
            return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
        case 'facebook':
            return Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
        default:
            return false;
    }
}

/**
 * callbackUrl
 *
 * What:  Returns the exact callback URL we register with the provider
 *        AND echo back at the token-exchange step. Per the OAuth 2.0
 *        spec the redirect_uri sent at /token MUST match what we used
 *        in the initial /authorize call (the provider includes it in
 *        the request that was signed).
 *
 *        Source of truth is APP_URL from env (so dev + prod don't have
 *        to maintain a separate var). req is unused today but accepted
 *        so we can swap to `req.headers.host`-based detection later
 *        without a controller-side change.
 *
 * Type:  READ (pure).
 */
function callbackUrl(provider /*, req */) {
    const base = String(process.env.APP_URL || 'http://localhost:4502').replace(/\/$/, '');
    return base + '/signin/oauth/' + provider + '/callback';
}

/**
 * buildAuthUrl
 *
 * What:  Returns the URL we redirect the browser to so the user signs
 *        in at the provider's domain. The provider then redirects them
 *        back to `redirectUri` with a `?code=...` (and our `state` so
 *        we can verify the response is for THIS browser, not a
 *        forged/cross-site response).
 * Type:  READ.
 *
 * Inputs:
 *   provider    — 'google' | 'facebook'
 *   state       — opaque per-request random string (we stash it in the
 *                  session before the redirect and check it on callback)
 *   redirectUri — usually callbackUrl(provider)
 *
 * Output: string (absolute URL).
 */
function buildAuthUrl(provider, { state, redirectUri }) {
    switch (String(provider || '').toLowerCase()) {
        case 'google': {
            const params = new URLSearchParams({
                client_id:     String(process.env.GOOGLE_CLIENT_ID || ''),
                redirect_uri:  redirectUri,
                response_type: 'code',
                scope:         'openid email profile',
                // prompt=select_account lets the user pick which Google
                // account when they're signed into many — better UX
                // than silently using the most-recent one.
                prompt:        'select_account',
                access_type:   'online',
                state,
            });
            return GOOGLE_AUTH_URL + '?' + params.toString();
        }
        case 'facebook': {
            const params = new URLSearchParams({
                client_id:     String(process.env.FACEBOOK_APP_ID || ''),
                redirect_uri:  redirectUri,
                response_type: 'code',
                scope:         'public_profile,email',
                state,
            });
            return FB_AUTH_URL + '?' + params.toString();
        }
        default:
            throw new Error('Unknown provider: ' + provider);
    }
}

/**
 * exchangeCode
 *
 * What:  Swaps the authorization code (sent to our callback) for
 *        tokens. Returns the shape the api endpoint expects:
 *          { provider: 'google',   id_token: '<jwt>' }
 *          { provider: 'facebook', access_token: '<token>' }
 *        We deliberately throw OUT the access_token Google also returns
 *        — we don't need it (id_token alone identifies the user) and
 *        passing fewer secrets around is safer.
 *
 * Type:  WRITE (external HTTPS to the provider's token endpoint).
 *
 * Inputs:
 *   provider    — 'google' | 'facebook'
 *   code        — the `?code=...` query param from the callback
 *   redirectUri — MUST be byte-identical to the one we used in
 *                  buildAuthUrl. Sending a different URL here makes the
 *                  provider reject the exchange with invalid_grant.
 *
 * Output:
 *   { ok: true,  payload: { provider, id_token? , access_token? } }
 *   { ok: false, error: '<short reason>' }
 */
async function exchangeCode(provider, { code, redirectUri }) {
    const p = String(provider || '').toLowerCase();
    if (!code) {
        return { ok: false, error: 'Missing authorization code.' };
    }

    if (p === 'google') {
        try {
            const body = new URLSearchParams({
                code,
                client_id:     String(process.env.GOOGLE_CLIENT_ID || ''),
                client_secret: String(process.env.GOOGLE_CLIENT_SECRET || ''),
                redirect_uri:  redirectUri,
                grant_type:    'authorization_code',
            });
            const res = await fetch(GOOGLE_TOKEN_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body,
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json || !json.id_token) {
                return { ok: false, error: (json && (json.error_description || json.error)) || 'Google token exchange failed.' };
            }
            return { ok: true, payload: { provider: 'google', id_token: String(json.id_token) } };
        } catch (err) {
            return { ok: false, error: err && err.message };
        }
    }

    if (p === 'facebook') {
        try {
            // Facebook accepts the code on a GET with query string. Form
            // POST works too — sticking with GET for readability and
            // matches the official docs.
            const url = FB_TOKEN_URL + '?' + new URLSearchParams({
                code,
                client_id:     String(process.env.FACEBOOK_APP_ID || ''),
                client_secret: String(process.env.FACEBOOK_APP_SECRET || ''),
                redirect_uri:  redirectUri,
            }).toString();
            const res  = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json || !json.access_token) {
                return { ok: false, error: (json && json.error && json.error.message) || 'Facebook token exchange failed.' };
            }
            return { ok: true, payload: { provider: 'facebook', access_token: String(json.access_token) } };
        } catch (err) {
            return { ok: false, error: err && err.message };
        }
    }

    return { ok: false, error: 'Unknown provider: ' + provider };
}

module.exports = {
    isConfigured,
    callbackUrl,
    buildAuthUrl,
    exchangeCode,
};
