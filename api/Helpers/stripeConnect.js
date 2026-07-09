'use strict';

/*
 * Helpers/stripeConnect.js
 *
 * EXACT port of the legacy eatndeal Node Stripe service
 *   eatndealclean/websocket/controllers/StripeController.js
 *
 * Same Stripe SDK calls, same shapes — only adapted from Express handlers to
 * plain async functions the marketplace can call. NOTHING static: account_id +
 * application-fee come from the caller (company_stripe_settings DB).
 *
 * Model: Stripe CONNECT. Each restaurant is a connected account
 * (company_stripe_settings.stripe_account_id). Customer payments are DIRECT
 * charges created ON the connected account ({ stripeAccount }) with the
 * platform's application_fee_amount. Refunds + session-retrieve also run on the
 * connected account.
 *
 * Requires the Stripe Node SDK (`npm i stripe`) — the legacy uses it too. The
 * v2 accounts API is a Stripe preview/beta (unified_accounts_beta).
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/* 1. Connect account create + onboarding link — legacy connectAccountCreate */
async function connectAccountCreate({ email, business_name, return_url, refresh_url }) {
    const account = await stripe.v2.core.accounts.create({
        contact_email: email,
        display_name: business_name,
        dashboard: 'full',
        identity: {
            business_details: { registered_name: business_name },
            country: 'gb',
            entity_type: 'company',
        },
        configuration: {
            merchant: { capabilities: { card_payments: { requested: true } } },
        },
        defaults: {
            currency: 'gbp',
            responsibilities: { fees_collector: 'application', losses_collector: 'application' },
            locales: ['en-GB'],
        },
        include: ['configuration.merchant', 'identity', 'defaults'],
    }, {
        apiVersion: '2026-05-27.preview; unified_accounts_beta=v1 header',
    });

    const accountLink = await stripe.v2.core.accountLinks.create({
        account: account.id,
        use_case: {
            type: 'account_onboarding',
            account_onboarding: {
                configurations: ['merchant'],
                return_url: return_url + '&account=' + account.id,
                refresh_url: refresh_url + '&account=' + account.id,
            },
        },
    });
    return { account, redirect_url: accountLink.url };
}

/* 2. Re-issue an onboarding link — legacy connectAccountLinkCreate */
async function connectAccountLinkCreate({ account_id, return_url, refresh_url }) {
    const accountLink = await stripe.v2.core.accountLinks.create({
        account: account_id,
        use_case: {
            type: 'account_onboarding',
            account_onboarding: {
                configurations: ['merchant'],
                return_url: return_url + '&account=' + account_id,
                refresh_url: refresh_url + '&account=' + account_id,
            },
        },
    });
    return { redirect_url: accountLink.url };
}

/* 3. Retrieve a connected account (+ register a payment-method domain) — legacy accountRetrieve */
async function accountRetrieve({ account_id, domain_name }) {
    const account = await stripe.v2.core.accounts.retrieve(account_id, {
        include: ['configuration.merchant', 'identity', 'defaults'],
    });
    if (domain_name) {
        await stripe.paymentMethodDomains.create({ domain_name: domain_name });
    }
    return { account };
}

/* 4. Create the customer payment — legacy paymentCreate.
 *    DIRECT charge: a Checkout Session (embedded Payment Element) ON the
 *    connected account, with the platform application fee. `amount` is in the
 *    smallest currency unit (pence); `appFeesCents` is the application fee. */
async function paymentCreate({ amount, appFeesCents, currency, account_id, return_url }) {
    const session = await stripe.checkout.sessions.create({
        line_items: [{
            price_data: {
                currency: currency,
                product_data: { name: 'Customer Order' },
                unit_amount: amount,
            },
            quantity: 1,
        }],
        mode: 'payment',
        ui_mode: 'elements',
        payment_method_types: ['card'],
        payment_intent_data: {
            application_fee_amount: appFeesCents,
        },
        // Append the session-id template so any redirect-based method returns
        // to a VALID url. Use ? when the base has no query string, else & — the
        // base is .../cart today, so it MUST become ?session_id=, not &session_id=
        // (the latter is a broken path → "page not found" after paying).
        return_url: return_url + (return_url.indexOf('?') === -1 ? '?' : '&') + 'session_id={CHECKOUT_SESSION_ID}',
    }, {
        stripeAccount: account_id,
    });
    return session;
}

/* 5. Retrieve the Checkout Session (poll payment_status) — legacy checkoutSessionRetrieve */
async function checkoutSessionRetrieve({ session_id, account_id }) {
    const session = await stripe.checkout.sessions.retrieve(session_id, {}, {
        stripeAccount: account_id,
    });
    return session;
}

/* 6. Refund — legacy refundPayment. flag>1 → partial (amount); else full (+ refund_application_fee). */
async function refundPayment({ payment_transaction_id, account_id, order_id, reason, flag, refund_amount }) {
    const session = await stripe.checkout.sessions.retrieve(payment_transaction_id, {}, {
        stripeAccount: account_id,
    });
    const paymentIntentId = session.payment_intent;

    const obj = {
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: { order_id: order_id, custom_reason: reason },
    };
    if (Number(flag) > 1) {
        obj.amount = parseInt(refund_amount, 10);
    } else {
        obj.refund_application_fee = true;
    }

    const refund = await stripe.refunds.create(obj, { stripeAccount: account_id });
    return refund;
}

/* 7. Register a payment-method DOMAIN on a connected account (direct charge) so
 *    wallets — Google Pay / Apple Pay / Link — can render in the Payment Element.
 *
 *    WHY it's per-account: our marketplace serves every restaurant's checkout on
 *    ONE domain (eatsndeals.co.uk), unlike legacy where each restaurant used its
 *    own subdomain. For a DIRECT charge Stripe only surfaces wallets when the
 *    checkout domain is a registered payment-method domain ON that connected
 *    account (the { stripeAccount } header) — otherwise only the card field shows.
 *    Legacy did this at onboarding via /stripe/account-retrieve using the
 *    company's OWN domain; here we register the MARKETPLACE domain instead.
 *
 *    Idempotent: reuses an existing registration for the domain, else creates it,
 *    then validates (activates Apple Pay / Google Pay). Returns the pmd object —
 *    read pmd.google_pay.status / pmd.apple_pay.status ('active' | 'inactive'). */
async function registerPaymentMethodDomain({ account_id, domain_name }) {
    if (!domain_name) { throw new Error('domain_name required'); }
    const opts = account_id ? { stripeAccount: account_id } : undefined;
    // Reuse an existing registration for this exact domain if present.
    const list = await stripe.paymentMethodDomains.list({ domain_name, limit: 1 }, opts);
    let pmd = (list && list.data && list.data[0]) || null;
    if (!pmd) {
        pmd = await stripe.paymentMethodDomains.create({ domain_name }, opts);
    }
    // Validate (re)activates the wallets on the domain. Best-effort: Apple Pay
    // needs the domain to host its verification file (Stripe auto-hosts it when
    // the page uses Stripe.js), so this can leave apple_pay inactive while
    // google_pay goes active — the caller reads the returned status.
    try { pmd = await stripe.paymentMethodDomains.validate(pmd.id, {}, opts); } catch (e) { /* keep pmd + surface status */ }
    return pmd;
}

module.exports = {
    connectAccountCreate,
    connectAccountLinkCreate,
    accountRetrieve,
    paymentCreate,
    checkoutSessionRetrieve,
    refundPayment,
    registerPaymentMethodDomain,
};
