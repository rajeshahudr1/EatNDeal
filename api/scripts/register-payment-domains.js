'use strict';

/*
 * scripts/register-payment-domains.js
 *
 * What:  Registers the marketplace checkout domain(s) as Stripe payment-method
 *        domains on EVERY enabled connected account, so wallets (Google Pay /
 *        Apple Pay / Link) render in the Payment Element at checkout.
 *
 * Why:   We do Stripe CONNECT direct charges — the charge runs ON the
 *        restaurant's connected account. Stripe suppresses wallets unless the
 *        checkout domain is a registered payment-method domain ON that account
 *        (the { stripeAccount } header). Our whole marketplace checks out on ONE
 *        domain (eatsndeals.co.uk), so that domain must be registered on each
 *        connected account. (Legacy did this per-restaurant with the company's
 *        OWN domain at onboarding — wrong for the marketplace; see
 *        Helpers/stripeConnect.registerPaymentMethodDomain.)
 *
 *        Idempotent — safe to re-run. Skips domains already registered, then
 *        validates them and prints the google_pay / apple_pay status.
 *
 * NOTE:  You CANNOT register `localhost`. For local dev, Google Pay renders on
 *        http://localhost in TEST mode (Chrome) without any registration — this
 *        script is for a real domain (eatsndeals.co.uk / a deployed test URL).
 *
 * Usage (from the api/ folder):
 *        node scripts/register-payment-domains.js eatsndeals.co.uk www.eatsndeals.co.uk
 *        # no args → PAYMENT_DOMAINS env (comma-separated) or the two defaults.
 *        # optional: COMPANY_ID=15 node scripts/... to target one company.
 */

require('dotenv').config();
const { db }        = require('../config/db');
const StripeConnect = require('../Helpers/stripeConnect');

function targetDomains() {
    const cli = process.argv.slice(2).filter(Boolean);
    if (cli.length) { return cli; }
    const env = String(process.env.PAYMENT_DOMAINS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    if (env.length) { return env; }
    return ['eatsndeals.co.uk', 'www.eatsndeals.co.uk'];
}

(async () => {
    const key  = String(process.env.STRIPE_SECRET_KEY || '');
    const mode = key.startsWith('sk_live_') ? 'LIVE' : key.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN';
    const domains = targetDomains();

    if (!key) {
        console.error('STRIPE_SECRET_KEY not set — aborting.');
        process.exit(1);
    }

    console.log(`Stripe mode : ${mode}`);
    console.log(`Domains     : ${domains.join(', ')}`);
    if (mode === 'LIVE') {
        console.log('⚠️  Running against LIVE Stripe — this registers real domains on real accounts.');
    }
    console.log('');

    let ok = 0, fail = 0;
    try {
        const q = db('company_stripe_settings')
            .where('is_enable', 1)
            .whereNotNull('stripe_account_id')
            .select('company_id', 'stripe_account_id');
        if (process.env.COMPANY_ID) { q.andWhere('company_id', process.env.COMPANY_ID); }
        const accounts = await q;

        if (!accounts.length) {
            console.log('No enabled connected accounts found in company_stripe_settings.');
            return;
        }

        for (const a of accounts) {
            console.log(`Company ${a.company_id} — account ${a.stripe_account_id}`);
            for (const domain of domains) {
                try {
                    const pmd = await StripeConnect.registerPaymentMethodDomain({
                        account_id:  a.stripe_account_id,
                        domain_name: domain,
                    });
                    const gp = pmd.google_pay && pmd.google_pay.status;
                    const ap = pmd.apple_pay && pmd.apple_pay.status;
                    const lk = pmd.link      && pmd.link.status;
                    console.log(`   ${domain}  →  google_pay=${gp}  apple_pay=${ap}  link=${lk}  enabled=${pmd.enabled}`);
                    ok++;
                } catch (e) {
                    console.log(`   ${domain}  →  ERROR: ${e.message}`);
                    fail++;
                }
            }
            console.log('');
        }
        console.log(`Done. ${ok} registered/validated, ${fail} failed.`);
        console.log('Wallets still need Google Pay / Apple Pay ENABLED in the Stripe Dashboard');
        console.log('(Settings → Payment methods) for the connected account.');
    } catch (e) {
        console.error('ERR', e.message);
        process.exitCode = 1;
    } finally {
        await db.destroy();
    }
})();
