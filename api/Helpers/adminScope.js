'use strict';

/*
 * Helpers/adminScope.js
 *
 * What:  Resolves WHICH company an admin request may act on. The admin console
 *        has two kinds of signed-in actor (both carry JWT kind='admin'):
 *          • super_admin (legacy user.role 6, company_id 0) — may act on ANY
 *            company. The target company comes from a selector (?company_id=
 *            on the query, or company_id in the body). With no selector, list/
 *            dashboard endpoints operate across ALL companies; single-company
 *            screens must reject with "select a company first".
 *          • company (company-table login, or a user with company_id > 0) —
 *            FORCED to its own company_id. Any company_id the client sends is
 *            ignored, so one company can never read or write another's data.
 * Why:   One trustworthy place for the super-vs-company rule, reused by every
 *        admin loyalty controller, so scoping can't drift per endpoint.
 * Type:  READ (pure — only reads req.user + req params).
 * Used:  Every api/Controllers/Admin/* method.
 *
 * Change log:
 *   2026-06-09 — initial.
 */

/**
 * resolveCompanyScope
 *
 * Inputs: req — Express request (req.user from authenticate, req.query/body).
 * Output: { companyId, isSuper, role, actorId }
 *           companyId — effective company id (number) or null (super "all").
 *           isSuper   — true for a super_admin.
 *           role      — 'super_admin' | 'company' | 'admin'.
 *           actorId   — req.user.sub (for created_by / updated_by stamps).
 */
function resolveCompanyScope(req) {
    const u = (req && req.user) || {};
    const role = u.role || 'admin';
    const actorId = u.sub != null ? Number(u.sub) : null;

    if (role === 'super_admin') {
        const raw = (req.query && req.query.company_id) != null && req.query.company_id !== ''
            ? req.query.company_id
            : ((req.body && req.body.company_id) != null && req.body.company_id !== '' ? req.body.company_id : null);
        const companyId = raw != null ? Number(raw) : null;
        return {
            companyId: Number.isFinite(companyId) && companyId > 0 ? companyId : null,
            isSuper: true,
            role,
            actorId,
        };
    }

    // company / staff — pinned to their own company; client value is ignored.
    const own = Number(u.company_id) || 0;
    return { companyId: own > 0 ? own : null, isSuper: false, role, actorId };
}

/**
 * needsCompany
 *
 * What:  True when a single-company screen has no usable company id (a super
 *        admin who hasn't picked one yet). Controllers call this to short-
 *        circuit with a 422 "select a company first".
 */
function needsCompany(scope) {
    return scope.companyId == null;
}

module.exports = { resolveCompanyScope, needsCompany };
