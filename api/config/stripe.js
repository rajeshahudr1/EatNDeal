'use strict';

/*
 * config/stripe.js — Stripe Connect fee formula (faithful port of the legacy
 * CompanyStripeSettings::calculateStripeCharge).
 *
 * NO static fee values, NO defaults. Every input — service_charge, commission —
 * comes from company_stripe_settings (DB); grandtotal/charity/used_cashback come
 * from the cart. If a restaurant has no Connect row / connected account, the
 * CALLER errors (exactly like the legacy, which returns success:false) — never a
 * fallback or default.
 *
 * Legacy formula:
 *   grandAmount   = grandtotal − charity − usedCashback
 *   finalAmount   = grandAmount + service_charge          (what the CUSTOMER pays)
 *   appFeesCents  = round((grandAmount × commission%) + service_charge) × 100   (PLATFORM cut)
 *   companyAmount = finalAmount − appFees                 (restaurant nets)
 */
function computeStripeCharge({ grandtotal, charityAmount, usedCashback, serviceCharge, commission }) {
    const grandAmount = (Number(grandtotal) || 0) - (Number(charityAmount) || 0) - (Number(usedCashback) || 0);
    const svc = Number(serviceCharge) || 0;
    const finalAmount = grandAmount + svc;
    const totalCommission = (grandAmount * (Number(commission) || 0) / 100) + svc;
    const appFees = Math.round(totalCommission * 100) / 100;
    const appFeesCents = Math.round(appFees * 100);
    const companyAmount = Math.round((finalAmount - appFees) * 100) / 100;
    return { grandAmount, finalAmount, appFees, appFeesCents, companyAmount };
}

module.exports = { computeStripeCharge };
