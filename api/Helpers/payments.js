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
async function post(path, body, extraHeaders) {
    if (!isConfigured()) { throw stripeError('stripe.not_configured', 'Card payments are not configured.'); }
    const res = await fetch(API_BASE + path, {
        method:  'POST',
        headers: Object.assign({
            'Authorization': 'Bearer ' + SECRET,
            'Content-Type':  'application/x-www-form-urlencoded',
        }, extraHeaders || {}),   // e.g. { 'Stripe-Account': acct } for Connect direct charges
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
async function get(path, extraHeaders) {
    if (!isConfigured()) { throw stripeError('stripe.not_configured', 'Card payments are not configured.'); }
    const res = await fetch(API_BASE + path, {
        headers: Object.assign({ 'Authorization': 'Bearer ' + SECRET }, extraHeaders || {}),  // Stripe-Account for Connect
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
async function createIntent({ amount, currency, metadata, customer, savePaymentMethod, account, applicationFeeCents }) {
    const minor = Math.round((Number(amount) || 0) * 100);
    if (minor <= 0) { throw stripeError('stripe.bad_amount', 'Amount must be greater than zero.'); }
    const body = {
        amount:   minor,
        currency: currency || CURRENCY,
        'automatic_payment_methods[enabled]': 'true',
        metadata: metadata || {},
    };
    const headers = {};
    if (account) {
        // Stripe CONNECT — DIRECT charge on the restaurant's connected account
        // (legacy StripeController.paymentCreate): the charge is created ON the
        // connected account via the Stripe-Account header and the platform keeps
        // application_fee_amount; the money lands in the restaurant's balance.
        // A platform Stripe Customer can't be used on a connected account, so
        // saved-cards are skipped for direct charges (legacy doesn't bind one).
        headers['Stripe-Account'] = account;
        if (Number(applicationFeeCents) > 0) { body.application_fee_amount = Math.round(Number(applicationFeeCents)); }
    } else if (customer) {
        // Platform charge — bind the Stripe Customer so saved cards work + a new
        // card can be saved for future orders (default: yes).
        body.customer = customer;
        if (savePaymentMethod !== false) { body.setup_future_usage = 'off_session'; }
    }
    return post('/payment_intents', body, headers);
}

/**
 * retrieveIntent
 *
 * What:  Reads a PaymentIntent by id. Used at order place-time to
 *        verify the customer actually paid before we write the order
 *        — the browser is never trusted to report success.
 * Type:  READ.
 */
async function retrieveIntent(intentId, account) {
    // Connect direct charge → the intent lives ON the connected account, so we
    // must read it with the Stripe-Account header (else Stripe 404s it).
    return get('/payment_intents/' + encodeURIComponent(intentId), account ? { 'Stripe-Account': account } : undefined);
}

/**
 * retrieveIntentDetail
 *
 * What:  Reads a PaymentIntent with the latest charge + payment method
 *        expanded, and normalises the bits worth persisting for an order:
 *        the ACTUAL method used (card / apple_pay / google_pay / link / …),
 *        card brand + last4 + expiry, the charge id and receipt URL. Used
 *        at place-time so we can store full payment details on the order
 *        (orders_payments.company_stripe_detail + sub_payment_method) —
 *        the Payment Element can charge any enabled method, so we capture
 *        which one it actually was.
 * Type:  READ.
 */
async function retrieveIntentDetail(intentId, account) {
    const id = encodeURIComponent(intentId);
    const intent = await get('/payment_intents/' + id + '?expand[]=latest_charge&expand[]=payment_method', account ? { 'Stripe-Account': account } : undefined);
    const charge = (intent && intent.latest_charge) || null;
    const pmd    = (charge && charge.payment_method_details) || {};
    const pm     = (intent && intent.payment_method) || null;
    const type   = pmd.type || (pm && pm.type) || '';
    const card   = pmd.card || (pm && pm.card) || {};
    const wallet = (card && card.wallet) || null;
    // sub-method = the wallet (Apple/Google Pay) when present, else the raw
    // method type (card / link / …).
    const sub = (wallet && wallet.type) ? wallet.type : type;
    return {
        intentId:  (intent && intent.id) || intentId,
        chargeId:  (charge && charge.id) || '',
        methodType: type,
        subMethod:  sub,
        brand:      card.brand || '',
        last4:      card.last4 || '',
        expMonth:   card.exp_month || null,
        expYear:    card.exp_year || null,
        network:    card.network || '',
        wallet:     (wallet && wallet.type) || '',
        amount:     (Number(intent && intent.amount) || 0) / 100,
        currency:   (intent && intent.currency) || '',
        status:     (intent && intent.status) || '',
        receiptUrl: (charge && charge.receipt_url) || '',
    };
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

/**
 * clonePaymentMethodToAccount
 *
 * What:  Copies a card saved on the PLATFORM customer onto a connected
 *        account so a DIRECT charge can use it. Stripe's documented route for
 *        exactly this (docs.stripe.com/connect/direct-charges-multiple-accounts):
 *        the platform PaymentMethod id is not chargeable on a connected
 *        account, a clone made on that account is. The clone is single-use —
 *        make a fresh one per order.
 * Type:  WRITE. Returns the cloned payment_method id.
 */
async function clonePaymentMethodToAccount({ customer, paymentMethodId, account }) {
    if (!customer || !paymentMethodId || !account) {
        throw stripeError('stripe.clone_args', 'Card details are incomplete. Please try another card.');
    }
    const pm = await post('/payment_methods', {
        customer:       customer,
        payment_method: paymentMethodId,
    }, { 'Stripe-Account': account });
    if (!pm || !pm.id) {
        throw stripeError('stripe.clone_failed', 'That saved card could not be used here. Please try another card.');
    }
    return pm.id;
}

/**
 * chargeSavedCard
 *
 * What:  Creates + confirms a PaymentIntent on the restaurant's connected
 *        account using a cloned card. ON-SESSION on purpose: the customer is
 *        watching the checkout, so if their bank asks for 3-D Secure the
 *        browser can complete it and the order still goes through. Sending
 *        off_session instead would just fail those orders outright.
 *        A `requires_action` result is NOT an error — the caller hands the
 *        client secret to Stripe.js to finish the challenge.
 * Type:  WRITE. Returns the PaymentIntent.
 */
async function chargeSavedCard({ amount, paymentMethodId, account, applicationFee, cartId, returnUrl }) {
    const minor = Math.round((Number(amount) || 0) * 100);
    if (minor <= 0) {
        throw stripeError('stripe.bad_amount', 'There is nothing to pay on this order.');
    }
    const body = {
        amount:              minor,
        currency:            CURRENCY,
        payment_method:      paymentMethodId,
        confirm:             'true',
        off_session:         'false',           // on-session — 3DS can be completed
        'metadata[cart_id]': String(cartId || ''),
    };
    if (returnUrl) { body.return_url = returnUrl; }
    if (Number(applicationFee) > 0) {
        body.application_fee_amount = Math.round(Number(applicationFee) * 100);
    }
    return post('/payment_intents', body, { 'Stripe-Account': account });
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
    retrieveIntentDetail,
    createCustomer,
    createSetupIntent,
    listPaymentMethods,
    detachPaymentMethod,
    clonePaymentMethodToAccount,
    chargeSavedCard,
    verifyWebhookSignature,
};
