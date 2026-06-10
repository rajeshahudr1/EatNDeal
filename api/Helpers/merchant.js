'use strict';

/*
 * Helpers/merchant.js
 *
 * What:  Resolves "is this customer a marketplace merchant, and for which
 *        company?" Phase-4 ships with a SIMPLE env-driven allowlist so we
 *        can launch the dashboard today without a new auth model. A real
 *        `mp_merchant_staff` table + role check lands in Phase-5 when the
 *        merchant flow stabilises.
 *
 *        Env shape (api/.env):
 *           MERCHANT_STAFF=101:1,102:2,103:1
 *        Means: customer 101 is staff for company 1, customer 102 is
 *        staff for company 2, customer 103 is also for company 1.
 *
 *        Each entry maps ONE customer to ONE company — multi-company
 *        staff just get multiple entries (the merchant page resolves to
 *        the first one for now; Phase-5 picks one explicitly).
 *
 *        Lookup is O(1) — the env string is parsed once at module load.
 *        Hot-reload the api process to pick up env edits.
 *
 * Type:  READ (pure).
 */

const rawStaff = process.env.MERCHANT_STAFF || '';

// Parse "101:1,102:2" → Map { '101' => '1', '102' => '2' }.
// Whitespace tolerant; malformed entries are silently dropped (caller
// just gets a "not staff" answer for that customer).
const staffMap = (() => {
    const m = new Map();
    rawStaff.split(',').forEach((entry) => {
        const [cust, comp] = String(entry || '').split(':').map((s) => String(s || '').trim());
        if (!cust || !comp) { return; }
        if (!/^\d+$/.test(cust) || !/^\d+$/.test(comp)) { return; }
        m.set(cust, comp);
    });
    return m;
})();

/**
 * companyForStaff
 *
 * What:  Returns the company_id (as a string) the given customer is
 *        marketplace staff for, or null when they aren't on the
 *        allowlist. Pure lookup against the parsed env map.
 * Type:  READ.
 */
function companyForStaff(customerId) {
    if (!customerId) { return null; }
    return staffMap.get(String(customerId)) || null;
}

/**
 * isStaff
 *
 * What:  Boolean shortcut for the same lookup. Used by the web layer's
 *        merchant route middleware.
 * Type:  READ.
 */
function isStaff(customerId) {
    return companyForStaff(customerId) != null;
}

/**
 * staffCount
 *
 * What:  Diagnostic — how many entries did we parse? The api can log
 *        this at startup so misconfigured env (e.g. typo'd commas)
 *        surfaces immediately.
 * Type:  READ.
 */
function staffCount() {
    return staffMap.size;
}

module.exports = { companyForStaff, isStaff, staffCount };
