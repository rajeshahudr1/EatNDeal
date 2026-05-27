'use strict';

/*
 * Helpers/socialAuth.js
 *
 * What:  Verifies a social-sign-in payload server-side and returns a
 *        normalised profile the rest of the auth flow can use.
 *
 *        Google flow:
 *          • Web layer redirects the user to Google, receives an
 *            authorization code, exchanges it for tokens, and POSTs
 *            the resulting `id_token` (a signed JWT) to /api/v1/auth/
 *            social-signin. We verify that JWT here.
 *          • google-auth-library.OAuth2Client.verifyIdToken checks
 *            the signature against Google's published JWKs, AND
 *            checks that the `aud` claim equals our GOOGLE_CLIENT_ID
 *            (i.e. the token was minted for THIS application — stops
 *            an attacker who has a token meant for someone else's app
 *            from logging in as that user here).
 *
 *        Facebook flow:
 *          • Web layer exchanges code → access_token, then sends us
 *            the access_token.
 *          • We call Facebook Graph API /debug_token to confirm the
 *            token's `app_id` matches FACEBOOK_APP_ID (same "minted-
 *            for-us" check), then call /me?fields=id,email,first_name,
 *            last_name to fetch the profile.
 *
 *        Both paths return the same shape so the caller doesn't have
 *        to branch:
 *          {
 *            ok: true,
 *            profile: {
 *              provider:   'google' | 'facebook',
 *              social_id:  '<provider's sub / user id>',
 *              email:      '<user email or empty>',
 *              firstname:  '<given name>',
 *              lastname:   '<family name>',
 *              email_verified: bool   // only Google supplies this
 *            }
 *          }
 *        or { ok: false, error: '<short reason>' }
 *
 * Why:   Keeps the customer-table upsert (in AuthController.socialSignin)
 *        free of provider-specific noise. ALL provider quirks
 *        (different field names, different verification endpoints) live
 *        in this one file.
 *
 * Used:  api/Controllers/Customer/AuthController.socialSignin.
 *
 * Env vars used:
 *   GOOGLE_CLIENT_ID            — required to verify a Google id_token
 *   FACEBOOK_APP_ID             — required to confirm a Facebook token
 *                                  belongs to our app
 *   FACEBOOK_APP_SECRET         — used to build the {app_id}|{app_secret}
 *                                  access token Facebook expects for
 *                                  /debug_token calls
 *
 * Change log:
 *   2026-05-26 — initial; Google + Facebook providers.
 */

const { OAuth2Client } = require('google-auth-library');

const FB_GRAPH = 'https://graph.facebook.com/v18.0';

// Cache one OAuth2Client per process — verifyIdToken pulls the Google JWK
// set lazily and caches it internally, so reusing the client saves
// network round-trips on subsequent verifications.
let _googleClient = null;
function googleClient() {
    if (_googleClient) return _googleClient;
    _googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    return _googleClient;
}

/**
 * isConfigured
 *
 * What:  Returns true when the given provider has the env vars it needs
 *        to actually verify a token. Web layer uses this to gate the
 *        "Sign in with X" button — disabled providers show a "not
 *        configured" toast instead of redirecting.
 * Why:   Avoids cryptic 500 errors when CLIENT_ID is blank.
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
 * verifyGoogle
 *
 * What:  Verifies a Google ID token (a JWT signed by Google). Checks:
 *          • signature against Google's published JWKs
 *          • `aud` claim matches our GOOGLE_CLIENT_ID
 *          • token not expired (library enforces by default)
 *        Returns a normalised profile on success.
 * Why:   See file header.
 * Type:  READ (external HTTPS to fetch JWKs the first time, then cached).
 * Inputs: idToken (string)
 * Output: { ok, profile? , error? }
 */
async function verifyGoogle(idToken) {
    if (!process.env.GOOGLE_CLIENT_ID) {
        return { ok: false, error: 'Google sign-in is not configured.' };
    }
    if (!idToken || typeof idToken !== 'string') {
        return { ok: false, error: 'Missing Google id_token.' };
    }
    try {
        const ticket = await googleClient().verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload() || {};
        if (!payload.sub) {
            return { ok: false, error: 'Google profile missing subject identifier.' };
        }
        return {
            ok: true,
            profile: {
                provider:       'google',
                social_id:      String(payload.sub),
                email:          String(payload.email || '').toLowerCase(),
                firstname:      String(payload.given_name  || '').trim(),
                lastname:       String(payload.family_name || '').trim(),
                email_verified: Boolean(payload.email_verified),
            },
        };
    } catch (err) {
        return { ok: false, error: 'Could not verify the Google sign-in.' };
    }
}

/**
 * verifyFacebook
 *
 * What:  Verifies a Facebook user access_token by:
 *          1. Calling Graph /debug_token to confirm:
 *               • token is valid (not expired, not revoked)
 *               • `app_id` matches our FACEBOOK_APP_ID
 *          2. Calling /me?fields=id,email,first_name,last_name
 *             with the user token to fetch the profile.
 *        Returns a normalised profile on success.
 *
 * Why:   Facebook doesn't issue signed JWTs by default — the only way
 *        to be sure a token is ours is to ask Facebook directly.
 *
 * Type:  READ (two HTTPS round-trips to Graph).
 * Inputs: accessToken (string)
 * Output: { ok, profile? , error? }
 */
async function verifyFacebook(accessToken) {
    const appId     = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
        return { ok: false, error: 'Facebook sign-in is not configured.' };
    }
    if (!accessToken || typeof accessToken !== 'string') {
        return { ok: false, error: 'Missing Facebook access_token.' };
    }

    // App-level access token used by /debug_token. Format is
    // "{app_id}|{app_secret}" per the Facebook docs — yes, with the
    // pipe character. Cleaner than minting one through another call.
    const appAccessToken = `${appId}|${appSecret}`;

    try {
        // 1) Verify the token belongs to us + is still valid.
        const debugUrl = `${FB_GRAPH}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appAccessToken)}`;
        const debugRes = await fetch(debugUrl);
        const debugJson = await debugRes.json().catch(() => ({}));
        const debugData = debugJson && debugJson.data;
        if (!debugData || !debugData.is_valid) {
            return { ok: false, error: 'Facebook token is not valid.' };
        }
        if (String(debugData.app_id) !== String(appId)) {
            // Token was minted for a DIFFERENT Facebook app — refuse.
            return { ok: false, error: 'Facebook token does not belong to this app.' };
        }

        // 2) Fetch the profile.
        const meUrl = `${FB_GRAPH}/me?fields=id,email,first_name,last_name&access_token=${encodeURIComponent(accessToken)}`;
        const meRes = await fetch(meUrl);
        const me    = await meRes.json().catch(() => ({}));
        if (!me || !me.id) {
            return { ok: false, error: 'Could not load your Facebook profile.' };
        }
        return {
            ok: true,
            profile: {
                provider:  'facebook',
                social_id: String(me.id),
                email:     String(me.email || '').toLowerCase(),
                firstname: String(me.first_name || '').trim(),
                lastname:  String(me.last_name  || '').trim(),
                // Facebook doesn't surface email_verified — assume true
                // because Facebook only returns an email after they've
                // verified it on the user's account.
                email_verified: Boolean(me.email),
            },
        };
    } catch (err) {
        return { ok: false, error: 'Could not verify the Facebook sign-in.' };
    }
}

/**
 * verify
 *
 * What:  Provider-agnostic entry point. Delegates to verifyGoogle or
 *        verifyFacebook based on `provider`.
 * Type:  READ.
 */
async function verify({ provider, idToken, accessToken }) {
    switch (String(provider || '').toLowerCase()) {
        case 'google':   return verifyGoogle(idToken);
        case 'facebook': return verifyFacebook(accessToken);
        default:         return { ok: false, error: 'Unknown provider.' };
    }
}

module.exports = {
    verify,
    verifyGoogle,
    verifyFacebook,
    isConfigured,
};
