'use strict';

/*
 * Helpers/appAuthTokens.js
 *
 * What:  A tiny in-memory store of ONE-TIME "sign-in handoff" tokens used to
 *        carry a completed social sign-in from an external browser tab back
 *        into the mobile app's WebView.
 *
 *        Why it's needed: Google (and OAuth in general) BLOCK sign-in inside
 *        embedded WebViews, so the mobile app opens the Google flow in a
 *        Chrome Custom Tab. The session that flow creates lands in that tab —
 *        NOT in the app's WebView (separate cookie jars). So on success we mint
 *        a short-lived one-time token, deep-link it back to the app
 *        (<scheme>://auth?token=…), and the app loads /app-auth?token=… inside
 *        the WebView. That endpoint consumes the token and establishes the
 *        session in the WebView. The token is single-use + expires fast.
 *
 * Store: process memory (single web instance). Good enough for this handoff —
 *        tokens live ≤2 min and are consumed once. For a multi-instance deploy,
 *        swap this for Redis/DB behind the same issue()/consume() API.
 *
 * Used:  web/Controllers/AuthController.js (oauthCallback issues; appAuth consumes).
 */

const crypto = require('node:crypto');

const TTL_MS = 2 * 60 * 1000;      // 2 minutes — plenty for a redirect round-trip
const store  = new Map();          // token → { data, expires }

/**
 * issue
 *
 * What:  Mints a random one-time token bound to `data` (the session bits we
 *        want to re-establish in the WebView). Returns the token string.
 * Type:  WRITE (in-memory).
 */
function issue(data) {
    const token = crypto.randomBytes(32).toString('hex');
    store.set(token, { data: data || {}, expires: Date.now() + TTL_MS });
    return token;
}

/**
 * consume
 *
 * What:  Looks up + DELETES the token (single use). Returns its data when the
 *        token exists and hasn't expired, else null.
 * Type:  WRITE (deletes on read).
 */
function consume(token) {
    const key = String(token || '');
    const rec = store.get(key);
    if (!rec) { return null; }
    store.delete(key);                          // one-time — gone after first read
    if (rec.expires < Date.now()) { return null; }
    return rec.data;
}

// Opportunistic sweep of expired tokens so a burst of abandoned sign-ins can't
// grow the map unbounded. unref() so it never keeps the process alive.
const sweep = setInterval(function () {
    const now = Date.now();
    for (const [k, v] of store) { if (v.expires < now) { store.delete(k); } }
}, 60 * 1000);
if (typeof sweep.unref === 'function') { sweep.unref(); }

module.exports = { issue, consume };
