'use strict';

/*
 * Helpers/payments.js
 *
 * What:  Thin wrapper around the Stripe REST API. Used by the cart
 *        checkout flow to:
 *           • createIntent(amount, currency, metadata) — returns
 *             { id, client_secret, status, amount, currency } for
 *             Stripe.js to confirm in the browser.
 *           • retrieveIntent(id) — used at order place-time to
 *             verify the PaymentIntent really succeeded server-side
 *             (the browser is never trusted).
 *
 *        Uses fetch (Node 20+) to POST x-www-form-urlencoded to
 *        api.stripe.com — no `stripe` npm dep needed. Stripe's auth
 *        is a bearer token (the secret key); responses come as JSON.
 *
 * Config:
 *           STRIPE_SECRET_KEY      — sk_test_… or sk_live_…
 *           STRIPE_PUBLISHABLE_KEY — pk_test_… (returned to browser)
 *           STRIPE_CURRENCY        — defaults to 'gbp'
 *
 *        When STRIPE_SECRET_KEY is unset the controller layer disables
 *        the Card payment option entirely (graceful degradation —
 *        Cash on Delivery keeps working without any keys).
 *
 * Type:  READ + WRITE (talks to Stripe; never writes our DB).
 */

const crypto      = require('crypto');

const SECRET         = process.env.STRIPE_SECRET_KEY      || '';
const PUBLISHABLE    = process.env.STRIPE_PUBLISHABLE_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET  || '';
const CURRENCY       = (process.env.STRIPE_CURRENCY || 'gbp').toLowerCase();
const API_BASE       = 'https://api.stripe.com/v1';

// 5-minute default tolerance for the timestamp on a Stripe webhook —
// matches the official SDK's default.
const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * isConfigured
 *
 * What:  True only when the secret key is present. Every controller
 *        path that talks to Stripe gates on this so missing config
 *        surfaces as a friendly 503 instead of a 500 stack trace.
 * Type:  READ (pure).
 */
function isConfigured() {
    return SECRET.length > 0;
}

/**
 * publishableKey
 *
 * What:  Returns the public key for browser use. Empty string when not
 *        configured (the cart UI then hides the Card option).
 * Type:  READ (pure).
 */
function publishableKey() {
    return PUBLISHABLE;
}

/**
 * buildForm
 *
 * What:  Stripe accepts only application/x-www-form-urlencoded bodies
 *        — and supports nested keys via bracket notation
 *        (metadata[cart_id]=42). This walks a plain object and emits
 *        the right encoding.
 * Type:  READ (pure).
 */
function buildForm(obj) {
    const out = [];
    function walk(key, val) {
        if (val == null) { return; }
        if (typeof val === 'object' && !Array.isArray(val)) {
            Object.keys(val).forEach((k) => walk(key + '[' + k + ']', val[k]));
            return;
        }
        out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
    }
    Object.keys(obj || {}).forEach((k) => walk(k, obj[k]));
    return out.join('&');
}

/**
 * stripeError
 *
 * What:  Standardises every error this module throws — caller checks
 *        `err.code` to decide whether to surface the customer-facing
 *        message verbatim or fall back to a generic one.
 * Type:  READ (pure).
 */
function stripeError(code, msg, extra) {
    const e = new Error(msg || code);
    e.code = code;
    if (extra) { e.extra = extra; }
    return e;
}

/**
 * post
 *
 * What:  Stripe's `POST /v1/<resource>` call with form encoding +
 *        bearer auth. Returns the parsed JSON or throws.
 * Type:  WRITE (talks to Stripe).
 */
async function post(path, body) {
    if (!isConfigured()) { throw stripeError('stripe.not_configured', 'Card payments are not configured.'); }
    const res = await fetch(API_BASE + path, {
        method:  'POST',
        headers: {
            'Authorization': 'Bearer ' + SECRET,
            'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: buildForm(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
        const msg = (json && json.error && json.error.message) || 'Stripe request failed.';
        throw stripeError('stripe.error', msg, json && json.error);
    }
    return json;
}

/**
 * get
 *
 * What:  Stripe's `GET /v1/<resource>/<id>` call. Same auth shape.
 * Type:  READ (talks to Stripe).
 */
async function get(path) {
    if (!isConfigured()) { throw stripeError('stripe.not_configured', 'Card payments are not configured.'); }
    const res = await fetch(API_BASE + path, {
        headers: { 'Authorization': 'Bearer ' + SECRET },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
        const msg = (json && json.error && json.error.message) || 'Stripe request failed.';
        throw stripeError('stripe.error', msg, json && json.error);
    }
    return json;
}

/**
 * createIntent
 *
 * What:  Creates a Stripe PaymentIntent for the given amount + currency
 *        and returns the row. We use `automatic_payment_methods` so
 *        the customer sees every payment method Stripe enables on the
 *        account (cards, Apple/Google Pay, etc.) — the dashboard
 *        controls which ones light up.
 *
 *        `metadata` should include `cart_id` + `customer_id` so the
 *        place-order step can verify the PaymentIntent it was handed
 *        actually belongs to this customer's open cart.
 *
 *        amount is in MAJOR units (£12.50) — Stripe wants minor units
 *        (1250), so we × 100 here.
 * Type:  WRITE.
 */
async function createIntent({ amount, currency, metadata, customer, savePaymentMethod }) {
    const minor = Math.round((Number(amount) || 0) * 100);
    if (minor <= 0) { throw stripeError('stripe.bad_amount', 'Amount must be greater than zero.'); }
    const body = {
        amount:   minor,
        currency: currency || CURRENCY,
        'automatic_payment_methods[enabled]': 'true',
        metadata: metadata || {},
    };
    // When the caller supplies a Stripe Customer id, bind the intent
    // to it so saved cards become reusable for this checkout AND any
    // card entered here can be saved for future orders (default: yes).
    if (customer) {
        body.customer = customer;
        if (savePaymentMethod !== false) {
            body.setup_future_usage = 'off_session';
        }
    }
    return post('/payment_intents', body);
}

/**
 * retrieveIntent
 *
 * What:  Reads a PaymentIntent by id. Used at order place-time to
 *        verify the customer actually paid before we write the order
 *        — the browser is never trusted to report success.
 * Type:  READ.
 */
async function retrieveIntent(intentId) {
    return get('/payment_intents/' + encodeURIComponent(intentId));
}

/**
 * createCustomer / createSetupIntent / listPaymentMethods / detachPaymentMethod
 *
 * What:  Saved-card plumbing. Each marketplace customer has one Stripe
 *        Customer (lookup mapping in mp_customer_stripe). Saved cards
 *        themselves stay on Stripe — we never store PANs locally, only
 *        ids. The Payment Methods tab + the cart checkout pull this
 *        list on demand.
 *          • createCustomer        — first-save provisioning.
 *          • createSetupIntent     — Stripe.js confirms it to attach.
 *          • listPaymentMethods    — every card the customer can re-use.
 *          • detachPaymentMethod   — remove from saved list.
 * Type:  WRITE / READ as labelled.
 */
async function createCustomer({ email, name, customerId }) {
    return post('/customers', {
        email: email || undefined,
        name:  name  || undefined,
        'metadata[marketplace_customer_id]': String(customerId || ''),
    });
}

async function createSetupIntent({ customer }) {
    return post('/setup_intents', {
        customer:    customer,
        usage:       'off_session',
        'payment_method_types[]': 'card',
    });
}

async function listPaymentMethods({ customer }) {
    const url = '/payment_methods?customer=' + encodeURIComponent(customer)
              + '&type=card&limit=20';
    const res = await get(url);
    const rows = (res && res.data) || [];
    return rows.map((pm) => ({
        id:       pm.id,
        brand:    (pm.card && pm.card.brand)     || '',
        last4:    (pm.card && pm.card.last4)     || '',
        expMonth: (pm.card && pm.card.exp_month) || null,
        expYear:  (pm.card && pm.card.exp_year)  || null,
    }));
}

async function detachPaymentMethod(paymentMethodId) {
    return post('/payment_methods/' + encodeURIComponent(paymentMethodId) + '/detach', {});
}

/**
 * isWebhookConfigured
 *
 * What:  True when STRIPE_WEBHOOK_SECRET is set. The webhook route
 *        gates on this so an unconfigured webhook returns 503 instead
 *        of accepting unsigned events.
 * Type:  READ (pure).
 */
function isWebhookConfigured() {
    return WEBHOOK_SECRET.length > 0;
}

/**
 * verifyWebhookSignature
 *
 * What:  Validates the `Stripe-Signature` header against the raw request
 *        body using HMAC-SHA256. Mirrors the official `stripe.webhooks
 *        .constructEvent()` algorithm so we don't need the SDK as a
 *        dependency.
 *
 *        Header format:
 *           t=<unix-seconds>,v1=<hex-sig>[,v1=<hex-sig>...]
 *
 *        Steps:
 *          1. Reject when missing / unparseable.
 *          2. Reject when |now − t| > tolerance (default 300 s) — guards
 *             against replay of an old signed payload.
 *          3. Compute HMAC-SHA256( "<t>.<rawBody>", WEBHOOK_SECRET ).
 *          4. Constant-time compare against every v1 entry.
 *
 *        Throws `webhook.*` on any failure; returns true on pass.
 *
 * Type:  READ (pure cryptographic compare).
 */
function verifyWebhookSignature(rawBody, signatureHeader, opts) {
    opts = opts || {};
    if (!WEBHOOK_SECRET) {
        throw stripeError('webhook.not_configured', 'Webhook secret is not configured.');
    }
    if (!rawBody) {
        throw stripeError('webhook.no_body', 'Missing webhook body.');
    }
    if (!signatureHeader) {
        throw stripeError('webhook.no_signature', 'Missing webhook signature.');
    }

    const parts = String(signatureHeader).split(',').map((p) => p.trim().split('='));
    let ts = null;
    const v1s = [];
    const v0s = [];
    parts.forEach(([k, v]) => {
        if (k === 't') { ts = v; }
        else if (k === 'v1') { v1s.push(v); }
        else if (k === 'v0') { v0s.push(v); }
    });
    if (!ts || !v1s.length) {
        // Defensive log so a misconfigured Stripe account that signs
        // ONLY with v0 surfaces quickly during integration. Stripe
        // deprecated v0 years ago; we still reject — same outcome —
        // but the log saves a debugging round trip.
        if (ts && v0s.length && !v1s.length && typeof console !== 'undefined' && console.warn) {
            console.warn('[stripe.webhook] received v0-only signature; v1 required. Check Stripe Dashboard webhook signing version.');
        }
        throw stripeError('webhook.bad_signature', 'Invalid webhook signature.');
    }

    // Replay-window check.
    const tolerance = (opts.toleranceSec || WEBHOOK_TOLERANCE_SEC) * 1000;
    const now = Date.now();
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > tolerance) {
        throw stripeError('webhook.stale', 'Webhook timestamp is outside the tolerance window.');
    }

    const bodyStr = (typeof rawBody === 'string') ? rawBody : rawBody.toString('utf8');
    const signedPayload = ts + '.' + bodyStr;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const ok = v1s.some((v1) => {
        const vBuf = Buffer.from(v1, 'utf8');
        return vBuf.length === expectedBuf.length && crypto.timingSafeEqual(vBuf, expectedBuf);
    });
    if (!ok) {
        throw stripeError('webhook.bad_signature', 'Webhook signature does not match.');
    }
    return true;
}

module.exports = {
    isConfigured,
    isWebhookConfigured,
    publishableKey,
    createIntent,
    retrieveIntent,
    createCustomer,
    createSetupIntent,
    listPaymentMethods,
    detachPaymentMethod,
    verifyWebhookSignature,
};
