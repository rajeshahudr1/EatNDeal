'use strict';

/*
 * Controllers/Admin/CustomersController.js
 *
 * What:  Super-admin "Customers" screen — ALL marketplace customers
 *        (customer rows with company_id IS NULL). Ports the legacy POS
 *        customer module (backend/modules/pos/CustomerController.php)
 *        minus the voucher features (user request 28 Jul 2026):
 *          list + search + banned filter, edit, ban/unban (with the
 *          legacy reason list), soft delete, order history + summary,
 *          About-You profile details.
 * Type:  READ + WRITE (customer; READ orders/orders_payments/
 *        customer_rewards/customer_profile).
 * Used:  api/Routes/index.js — /admin/customers/* (super admin only).
 *
 * Status values (legacy User model): '1' active, '0' inactive,
 * '2' soft-deleted (never listed), '3' banned. Strings on this table.
 *
 * Change log:
 *   2026-07-28 — initial port.
 */

const H       = require('../../Helpers/helper');
const { db }  = require('../../config/db');
const Profile = require('../../Helpers/customerProfile');
const Scope   = require('../../Helpers/adminScope');

const T = 'customer';

/**
 * scopeCid — the effective customer scope for this request.
 * Super admin: no company picked (or explicit 0) → 0 = MARKETPLACE
 * customers (company_id IS NULL); a picked company → that company's own
 * POS customers. A company login is always forced to its own id by
 * resolveCompanyScope, whatever the query says.
 */
function scopeCid(req) {
    const s = Scope.resolveCompanyScope(req);
    return (s.companyId == null || Number(s.companyId) === 0) ? 0 : Number(s.companyId);
}

// Legacy ban reasons (backend _form.php dropdown). "Other" needs the
// free-text other_banned_reason, same as the Yii rule.
const BAN_REASONS = ['Nuisance Customer', 'Non payment', 'Abusive', 'Other'];

const SORTS = {
    newest:    ['id', 'desc'],
    oldest:    ['id', 'asc'],
    name_asc:  ['firstname', 'asc'],
    name_desc: ['firstname', 'desc'],
};
const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const str = (v) => (v == null ? '' : String(v));

// Customer scope — cid 0 = marketplace (company_id IS NULL, see
// Helpers/customerLookup.js); cid > 0 = that restaurant's own POS
// customers. Soft-deleted rows are always excluded.
function scoped(cid) {
    const q = db(T).andWhere(T + '.status', '!=', '2');
    return cid ? q.where(T + '.company_id', cid) : q.whereNull(T + '.company_id');
}

// One-line address in the legacy fullAddress order: door, house/flat,
// street, city, postcode — skipping empties.
function fullAddress(r) {
    return [r.door_no, r.house_no, r.street, r.city, r.postcode]
        .map((s) => str(s).trim()).filter(Boolean).join(', ');
}

function mapRow(r) {
    return {
        id:           Number(r.id),
        firstname:    r.firstname || '',
        lastname:     r.lastname || '',
        name:         (str(r.firstname) + ' ' + str(r.lastname)).trim(),
        email:        r.email || '',
        contact_no:   r.contact_no || '',
        postcode:     r.postcode || '',
        door_no:      r.door_no || '',
        house_no:     r.house_no || '',
        street:       r.street || '',
        city:         r.city || '',
        address:      fullAddress(r),
        status:       str(r.status),
        banned_reason:       r.banned_reason || '',
        other_banned_reason: r.other_banned_reason || '',
        is_registered: Number(r.is_registered) === 1,
        created_at:   r.created_at || null,
        total_orders: Number(r.total_orders) || 0,
        has_profile:  Number(r.has_profile) > 0,
    };
}

/**
 * list — GET /api/v1/admin/customers
 * q searches the same fields the legacy search modal offered (phone,
 * first/last name, email, postcode, door no, street, city) in ONE box.
 * status filter: '' all, 'active', 'inactive', 'banned'. Date range on
 * created_at (legacy index date filter). Server-side pagination.
 */
async function list(req, res) {
    try {
        const q        = String(req.query.q || '').trim().toLowerCase();
        const statusF  = String(req.query.status || '');
        const dateFrom = String(req.query.date_from || '').trim();
        const dateTo   = String(req.query.date_to || '').trim();
        const sortKey  = SORTS[req.query.sort] ? req.query.sort : 'newest';
        const sort     = SORTS[sortKey];
        const limitRaw = String(req.query.limit || '25');
        const isAll    = limitRaw === 'all';
        const limit    = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);
        let page       = Math.max(1, Number(req.query.page) || 1);
        const cid      = scopeCid(req);

        // 'deleted' filter shows ONLY soft-deleted rows (so they can be
        // restored); every other filter keeps excluding them as before.
        const base = () => db(T).modify((qb) => {
            if (cid) { qb.where(T + '.company_id', cid); } else { qb.whereNull(T + '.company_id'); }
            if (statusF === 'deleted') { qb.andWhere(T + '.status', '2'); }
            else { qb.andWhere(T + '.status', '!=', '2'); }
            if (q) {
                qb.andWhere(function () {
                    this.whereRaw('LOWER(firstname) LIKE ?', ['%' + q + '%'])
                        .orWhereRaw('LOWER(lastname) LIKE ?',  ['%' + q + '%'])
                        .orWhereRaw('LOWER(email) LIKE ?',     ['%' + q + '%'])
                        .orWhere('contact_no', 'like', '%' + q + '%')
                        .orWhereRaw('LOWER(postcode) LIKE ?',  ['%' + q + '%'])
                        .orWhereRaw('LOWER(door_no) LIKE ?',   ['%' + q + '%'])
                        .orWhereRaw('LOWER(street) LIKE ?',    ['%' + q + '%'])
                        .orWhereRaw('LOWER(city) LIKE ?',      ['%' + q + '%']);
                });
            }
            if (statusF === 'active')        { qb.andWhere('status', '1'); }
            else if (statusF === 'inactive') { qb.andWhere('status', '0'); }
            else if (statusF === 'banned')   { qb.andWhere('status', '3'); }
            if (dateFrom) { qb.whereRaw('DATE(customer.created_at) >= ?', [dateFrom]); }
            if (dateTo)   { qb.whereRaw('DATE(customer.created_at) <= ?', [dateTo]); }
        });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        // Per-row order count + whether an About-You profile exists — both
        // as correlated subqueries so the page stays ONE query however
        // long the list is. Marketplace orders link on customer.id +
        // is_marketplace; a restaurant's POS orders link the legacy way
        // (user_id = app_id AND customer_terminal = terminalid).
        const orderCountSql = cid
            ? db.raw('(SELECT COUNT(*) FROM orders o WHERE o.user_id = customer.app_id AND o.customer_terminal = customer.terminalid AND o.company_id = ?) as total_orders', [cid])
            : db.raw('(SELECT COUNT(*) FROM orders o WHERE o.user_id = customer.id AND o.is_marketplace = 1) as total_orders');
        let qb = base().select(
            T + '.*',
            orderCountSql,
            db.raw('(SELECT COUNT(*) FROM customer_profile p WHERE p.customer_id = customer.id AND p.company_id = ? AND p.deleted_at IS NULL) as has_profile', [cid || Profile.MARKETPLACE_COMPANY_ID]),
        ).orderBy(T + '.' + sort[0], sort[1]);
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;

        // Legacy header stats: total + joined this month.
        const mStart = new Date();
        const monthStart = mStart.getFullYear() + '-' + String(mStart.getMonth() + 1).padStart(2, '0') + '-01';
        const mCnt = await scoped(cid).whereRaw('DATE(customer.created_at) >= ?', [monthStart]).count('* as n').first();
        const bCnt = await scoped(cid).where('status', '3').count('* as n').first();
        // Soft-deleted rows — scoped() excludes them, so count directly.
        const dCnt = await db(T)
            .modify((qb) => { if (cid) { qb.where('company_id', cid); } else { qb.whereNull('company_id'); } })
            .where('status', '2').count('* as n').first();

        return H.successResponse(res, {
            customers:   rows.map(mapRow),
            marketplace: cid === 0,
            total,
            this_month:  Number(mCnt && mCnt.n) || 0,
            banned:      Number(bCnt && bCnt.n) || 0,
            deleted:     Number(dCnt && dCnt.n) || 0,
            page,
            limit:       isAll ? 'all' : limit,
            total_pages: totalPages,
            sort:        sortKey,
            status:      statusF,
            ban_reasons: BAN_REASONS,
        });
    } catch (err) {
        console.error('[admin.customers.list]', err && err.message);
        return H.errorResponse(res, 'Could not load customers.', 500);
    }
}

/**
 * getCustomer — GET /api/v1/admin/customers/get?id=
 * The row + About-You profile (marketplace customer_profile, company 0)
 * for the edit form and the details popup.
 */
async function getCustomer(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const cid = scopeCid(req);
        if (!id) { return H.errorResponse(res, 'Customer not found.', 404); }
        const r = await scoped(cid).where(T + '.id', id).first();
        if (!r) { return H.errorResponse(res, 'Customer not found.', 404); }

        let profile = null;
        if (await Profile.tableExists()) {
            const p = await db(Profile.TABLE)
                .where({ customer_id: id, company_id: cid || Profile.MARKETPLACE_COMPANY_ID })
                .whereNull('deleted_at').first();
            if (p) { profile = Profile.view(p); }
        }
        return H.successResponse(res, { customer: mapRow(r), profile, ban_reasons: BAN_REASONS });
    } catch (err) {
        console.error('[admin.customers.get]', err && err.message);
        return H.errorResponse(res, 'Could not load the customer.', 500);
    }
}

/**
 * save — POST /api/v1/admin/customers/save
 * Edit only (marketplace customers sign themselves up — the legacy
 * "create customer" belongs to the per-restaurant POS, not here).
 * Same editable set as the legacy _form: names, contact, email, address.
 * Duplicate contact_no check across marketplace customers (excl. self),
 * mirroring the legacy per-company duplicate rule.
 */
async function save(req, res) {
    try {
        const b  = req.body;
        const id = Number(b.id) || 0;
        const cid = scopeCid(req);
        if (!id) { return H.errorResponse(res, 'Customer not found.', 404); }
        const row = await scoped(cid).where(T + '.id', id).first();
        if (!row) { return H.errorResponse(res, 'Customer not found.', 404); }

        const firstname = str(b.firstname).trim();
        const contactNo = str(b.contact_no).trim();
        const email     = str(b.email).trim();
        if (!firstname) { return H.errorResponse(res, 'First name is required.', 422); }
        if (!contactNo) { return H.errorResponse(res, 'Contact number is required.', 422); }
        if (!/^\+?[0-9 ]{7,15}$/.test(contactNo)) { return H.errorResponse(res, 'Enter a valid contact number.', 422); }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { return H.errorResponse(res, 'Enter a valid email address.', 422); }

        const dup = await scoped(cid).where('contact_no', contactNo).andWhere(T + '.id', '!=', id).first();
        if (dup) { return H.errorResponse(res, 'Another customer already uses that contact number.', 409); }

        await db(T).where('id', id).update({
            firstname: firstname.slice(0, 255),
            lastname:  str(b.lastname).trim().slice(0, 255),
            contact_no: contactNo.slice(0, 255),
            email:      email.slice(0, 255),
            postcode:   str(b.postcode).trim().slice(0, 255),
            door_no:    str(b.door_no).trim().slice(0, 255),
            house_no:   str(b.house_no).trim().slice(0, 255),
            street:     str(b.street).trim().slice(0, 255),
            city:       str(b.city).trim().slice(0, 255),
            updated_at: nowStr(),
        });
        return H.successResponse(res, { saved: true, id }, 'Customer updated.');
    } catch (err) {
        console.error('[admin.customers.save]', err && err.message);
        return H.errorResponse(res, 'Could not save the customer.', 500);
    }
}

/**
 * ban — POST /api/v1/admin/customers/ban { id, banned_reason, other_banned_reason }
 * Legacy actionBanned: status '3' + reason; other_banned_reason kept only
 * when the reason is "Other" (nulled otherwise, same as Yii).
 */
async function ban(req, res) {
    try {
        const id = Number(req.body.id) || 0;
        const reason = str(req.body.banned_reason).trim();
        const other  = str(req.body.other_banned_reason).trim();
        if (!id) { return H.errorResponse(res, 'Customer not found.', 404); }
        if (!BAN_REASONS.includes(reason)) { return H.errorResponse(res, 'Pick a ban reason.', 422); }
        if (reason === 'Other' && !other) { return H.errorResponse(res, 'Enter the other reason.', 422); }
        const row = await scoped(scopeCid(req)).where(T + '.id', id).first();
        if (!row) { return H.errorResponse(res, 'Customer not found.', 404); }

        await db(T).where('id', id).update({
            status: '3',
            banned_reason: reason,
            other_banned_reason: reason === 'Other' ? other.slice(0, 255) : null,
            updated_at: nowStr(),
        });
        return H.successResponse(res, { banned: true }, 'Customer banned.');
    } catch (err) {
        console.error('[admin.customers.ban]', err && err.message);
        return H.errorResponse(res, 'Could not ban the customer.', 500);
    }
}

/** unban — POST /api/v1/admin/customers/unban { id } — legacy actionReset. */
async function unban(req, res) {
    try {
        const id = Number(req.body.id) || 0;
        const row = await scoped(scopeCid(req)).where(T + '.id', id).andWhere('status', '3').first();
        if (!row) { return H.errorResponse(res, 'Customer not found.', 404); }
        await db(T).where('id', id).update({
            status: '1',
            banned_reason: null,
            other_banned_reason: null,
            updated_at: nowStr(),
        });
        return H.successResponse(res, { reset: true }, 'Customer unbanned.');
    } catch (err) {
        console.error('[admin.customers.unban]', err && err.message);
        return H.errorResponse(res, 'Could not unban the customer.', 500);
    }
}

/** restore — POST /api/v1/admin/customers/restore { id } — bring a
 *  soft-deleted customer back (status '2' → '1'). */
async function restore(req, res) {
    try {
        const id = Number(req.body.id) || 0;
        const cid = scopeCid(req);
        const row = await db(T)
            .modify((qb) => { if (cid) { qb.where('company_id', cid); } else { qb.whereNull('company_id'); } })
            .where({ id, status: '2' }).first();
        if (!row) { return H.errorResponse(res, 'Customer not found.', 404); }
        await db(T).where('id', id).update({ status: '1', updated_at: nowStr() });
        return H.successResponse(res, { restored: true }, 'Customer restored.');
    } catch (err) {
        console.error('[admin.customers.restore]', err && err.message);
        return H.errorResponse(res, 'Could not restore the customer.', 500);
    }
}

/** remove — POST /api/v1/admin/customers/delete { id } — soft delete
 *  (status '2', never a hard .del() — project convention). */
async function remove(req, res) {
    try {
        const id = Number(req.body.id) || 0;
        const row = await scoped(scopeCid(req)).where(T + '.id', id).first();
        if (!row) { return H.errorResponse(res, 'Customer not found.', 404); }
        await db(T).where('id', id).update({ status: '2', updated_at: nowStr() });
        return H.successResponse(res, { deleted: true }, 'Customer deleted.');
    } catch (err) {
        console.error('[admin.customers.remove]', err && err.message);
        return H.errorResponse(res, 'Could not delete the customer.', 500);
    }
}

/**
 * orders — GET /api/v1/admin/customers/orders?id=&page=&limit=
 * Legacy actionHistory: the customer's orders (marketplace link:
 * orders.user_id = customer.id AND is_marketplace = 1, same filter as
 * Helpers/orders.listForCustomer) + the summary cards:
 *   serve-type counts, completed/cancelled/refund, and the
 *   customer_rewards cashback totals (earned/available/redeemed/expired).
 */
async function orders(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const cid = scopeCid(req);
        const cust = await scoped(cid).where(T + '.id', id).first();
        if (!cust) { return H.errorResponse(res, 'Customer not found.', 404); }

        const limitRaw = String(req.query.limit || '25');
        const isAll = limitRaw === 'all';
        const limit = isAll ? 0 : (PAGE_SIZES.includes(Number(limitRaw)) ? Number(limitRaw) : 25);
        let page = Math.max(1, Number(req.query.page) || 1);
        // Search: order number OR restaurant name.
        const q = String(req.query.q || '').trim().toLowerCase();

        // Marketplace: orders.user_id = customer.id + is_marketplace.
        // Restaurant POS: the legacy actionHistory link — user_id = app_id
        // AND customer_terminal = terminalid, scoped to the company.
        const base = () => (cid
            ? db('orders as o').where('o.user_id', cust.app_id)
                .andWhere('o.customer_terminal', cust.terminalid)
                .andWhere('o.company_id', cid)
            : db('orders as o').where('o.user_id', id).andWhere('o.is_marketplace', 1))
            .modify((qb) => {
                if (q) {
                    qb.andWhere(function () {
                        this.whereRaw('LOWER(o.order_number) LIKE ?', ['%' + q + '%'])
                            .orWhereExists(function () {
                                this.select(db.raw('1')).from('company as cq')
                                    .whereRaw('cq.id = o.company_id')
                                    .andWhereRaw('LOWER(cq.business_name) LIKE ?', ['%' + q + '%']);
                            });
                    });
                }
            });

        const cnt = await base().count('* as n').first();
        const total = Number(cnt && cnt.n) || 0;
        const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) { page = totalPages; }

        let qb = base()
            .leftJoin('company as c', 'c.id', 'o.company_id')
            .select('o.id', 'o.order_number', 'o.internal_order_id', 'o.created_at',
                    'o.grand_total', 'o.order_status', 'o.serve_type', 'o.order_from',
                    'c.business_name')
            .orderBy('o.created_at', 'desc');
        if (!isAll) { qb = qb.limit(limit).offset((page - 1) * limit); }
        const rows = await qb;

        // Payment per order — ONE query for the page (legacy did this row
        // by row, an N+1). payment_type is the stored 'Cash'/'Card' label;
        // payment_id === 1 is only the legacy-row fallback (see
        // Helpers/orders.js note from 28 Jul 2026).
        const ids = rows.map((r) => r.id);
        const pays = ids.length
            ? await db('orders_payments').whereIn('orders_id', ids)
                .orderBy('id', 'desc')
                .select('orders_id', 'payment_id', 'payment_type', 'sub_payment_method')
            : [];
        const payBy = new Map();
        pays.forEach((p) => { const k = String(p.orders_id); if (!payBy.has(k)) { payBy.set(k, p); } });

        // Legacy history.php status/type wording.
        function statusText(s) {
            const v = String(s == null ? '' : s);
            if (v === '1') { return 'Refund'; }
            if (v === '2') { return 'Cancelled'; }
            if (v === '9') { return 'Void'; }
            if (v === '')  { return 'Completed'; }
            return 'On Going';
        }
        function typeText(t) {
            const v = Number(t);
            if (v === 1) { return 'In-store'; }
            if (v === 2) { return 'Pickup'; }
            return 'Delivery';
        }

        const list = rows.map((r) => {
            const pay = payBy.get(String(r.id));
            const method = pay
                ? (str(pay.sub_payment_method).trim()
                    || str(pay.payment_type).trim()
                    || (Number(pay.payment_id) === 1 ? 'Cash' : 'Card'))
                : 'Cash';
            return {
                id:            Number(r.id),
                number:        r.order_number || '',
                internal_id:   Number(r.internal_order_id) || 0,
                restaurant:    r.business_name || '',
                created_at:    r.created_at || null,
                grand_total:   Number(r.grand_total) || 0,
                payment:       method,
                status:        statusText(r.order_status),
                type:          typeText(r.serve_type),
                order_through: String(r.order_from) === '2' ? 'Online' : 'Offline',
            };
        });

        // Summary cards — over ALL the customer's orders, not just the page.
        const sum = await base()
            .select(
                db.raw("COUNT(*) FILTER (WHERE o.serve_type = 2) as pickup"),
                db.raw("COUNT(*) FILTER (WHERE o.serve_type = 3) as delivery"),
                db.raw("COUNT(*) FILTER (WHERE o.serve_type NOT IN (2,3)) as instore"),
                db.raw("COUNT(*) FILTER (WHERE o.order_status = '') as completed"),
                db.raw("COUNT(*) FILTER (WHERE o.order_status = '2') as cancelled"),
                db.raw("COUNT(*) FILTER (WHERE o.order_status = '1') as refunded"),
                db.raw('COALESCE(SUM(o.grand_total), 0) as spend'),
            ).first();

        // Cashback summary (legacy row 2) — the customer_rewards ledger,
        // using the SAME formulas as Helpers/loyalty.js walletTotals
        // (amount / used_amount / is_expired; expired_from 3 = fully used,
        // so "expired" only counts rows flagged from a real expiry).
        const rw = await db('customer_rewards as cr')
            .where('cr.customer_id', id)
            .modify((qb) => { if (cid) { qb.andWhere('cr.company_id', cid); } })
            .select(
                db.raw('COALESCE(SUM(cr.amount), 0) as earned'),
                db.raw("COALESCE(SUM(CASE WHEN cr.is_expired = 0 AND (cr.tier_type IS NULL OR cr.is_redeemable = 1) AND (cr.expiry_date IS NULL OR cr.expiry_date >= NOW()) THEN cr.amount - COALESCE(cr.used_amount,0) ELSE 0 END), 0) as available"),
                db.raw('COALESCE(SUM(COALESCE(cr.used_amount,0)), 0) as redeemed'),
                db.raw('COALESCE(SUM(CASE WHEN cr.is_expired = 1 AND cr.expired_from != 3 THEN cr.amount - COALESCE(cr.used_amount,0) ELSE 0 END), 0) as expired'),
            ).first();

        return H.successResponse(res, {
            customer: mapRow(cust),
            // View (order detail) is marketplace-only — the admin order
            // page reads the marketplace loadDetail builder.
            marketplace: cid === 0,
            orders: list,
            total,
            page,
            limit: isAll ? 'all' : limit,
            total_pages: totalPages,
            summary: {
                instore:   Number(sum && sum.instore)   || 0,
                pickup:    Number(sum && sum.pickup)    || 0,
                delivery:  Number(sum && sum.delivery)  || 0,
                completed: Number(sum && sum.completed) || 0,
                cancelled: Number(sum && sum.cancelled) || 0,
                refunded:  Number(sum && sum.refunded)  || 0,
                spend:     Math.round(Number(sum && sum.spend) * 100) / 100 || 0,
            },
            rewards: {
                earned:    Math.round(Number(rw && rw.earned)    * 100) / 100 || 0,
                available: Math.round(Number(rw && rw.available) * 100) / 100 || 0,
                redeemed:  Math.round(Number(rw && rw.redeemed)  * 100) / 100 || 0,
                expired:   Math.round(Number(rw && rw.expired)   * 100) / 100 || 0,
            },
        });
    } catch (err) {
        console.error('[admin.customers.orders]', err && err.message);
        return H.errorResponse(res, 'Could not load the order history.', 500);
    }
}

/**
 * orderDetail — GET /api/v1/admin/customers/order?id=
 * Full single-order payload for the admin View page — the same data the
 * legacy POS /pos/default/view screen shows (items + modifiers, bill
 * breakdown, payment, delivery address, notes). Reuses the customer-side
 * Helpers/orders.loadDetail so admin and customer read ONE builder.
 */
async function orderDetail(req, res) {
    try {
        const id = Number(req.query.id) || 0;
        const row = await db('orders').where('id', id).andWhere('is_marketplace', 1)
            .select('user_id').first();
        if (!row) { return H.errorResponse(res, 'Order not found.', 404); }
        const Orders = require('../../Helpers/orders');
        const detail = await Orders.loadDetail(id, row.user_id);
        if (!detail) { return H.errorResponse(res, 'Order not found.', 404); }
        return H.successResponse(res, { order: detail, customer_id: Number(row.user_id) });
    } catch (err) {
        console.error('[admin.customers.orderDetail]', err && err.message);
        return H.errorResponse(res, 'Could not load the order.', 500);
    }
}

module.exports = { list, getCustomer, save, ban, unban, remove, restore, orders, orderDetail };
