'use strict';

/*
 * Controllers/Admin/StoreSettingsController.js
 *
 * What:  The admin Store Settings page — a faithful port of the legacy
 *        backend admin/pos/store-settings page. Reads + writes a BRANCH's
 *        configuration (delivery / pickup / pre-order toggles, waiting times,
 *        charges, tips, surprise box, SEO, layout …) on the live branch table.
 *        Company-scoped: super admin acts on ?company_id; a company login is
 *        pinned to its own.
 * Why:   No new schema (every column already exists). We persist ONLY an
 *        explicit whitelist of editable columns so identity / financial /
 *        compliance columns are never touched.
 * Type:  READ + WRITE (branch table).
 * Used:  api/Routes/index.js (authenticate + requireRole('admin')).
 *
 * Phase 1: getSettings + saveSettings (the main form). Website-status modal,
 * quick-tips, surprise-box image + advance-order are added in later phases.
 *
 * Change log:
 *   2026-06-09 — initial; getSettings + saveSettings.
 */

const H = require('../../Helpers/helper');
const { db } = require('../../config/db');
const { resolveCompanyScope } = require('../../Helpers/adminScope');

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function money(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
function int01(v) { return (v === '1' || v === 1 || v === true || v === 'true') ? 1 : 0; }

// Resolve the single branch for the scoped company (422 when a super admin
// hasn't picked one). Returns { branch, scope } or null (response already sent).
async function resolveBranch(req, res) {
    const scope = resolveCompanyScope(req);
    if (scope.companyId == null) {
        H.errorResponse(res, 'Select a company first.', 422, { code: 'no_company' });
        return null;
    }
    let q = db('branch').where('company_id', scope.companyId);
    if (req.query.branch_id || (req.body && req.body.branch_id)) {
        q = q.andWhere('id', Number(req.query.branch_id || req.body.branch_id));
    }
    const branch = await q.orderBy('id', 'asc').first();
    if (!branch) {
        H.errorResponse(res, 'No store found for this company.', 404, { code: 'no_branch' });
        return null;
    }
    return { branch, scope };
}

// Service-charge dropdown values: 0.00 → 1.55 stepping 0.05 (exact legacy list).
function serviceChargeOptions() {
    const out = [];
    for (let v = 0; v <= 1.55 + 1e-9; v += 0.05) { out.push((Math.round(v * 100) / 100).toFixed(2)); }
    return out;
}

// Split a stored 'DD:HH:MM' waiting-time string into parts for the form.
function splitWait(s) {
    const p = String(s || '').split(':');
    return { day: p[0] || '', hours: p[1] || '', minutes: p[2] || '' };
}
// Build 'DD:HH:MM' from the three form fields (pad to 2, blank → 0).
function joinWait(day, hours, minutes) {
    const z = (x) => String(Math.max(0, parseInt(x, 10) || 0)).padStart(2, '0');
    return z(day) + ':' + z(hours) + ':' + z(minutes);
}

/**
 * getSettings — GET /api/v1/admin/store-settings?company_id=
 * Returns the branch's editable settings + helper data (service-charge list,
 * split waiting times) for the form.
 */
async function getSettings(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const b = got.branch;

        // Build a served URL for a stored image (Yii uploads tree:
        // <companyId>/<subfolder>/<file>). Pass-through full URLs / abs paths.
        const upBase = (process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
        const webBase = String(process.env.WEB_URL || '').replace(/\/$/, '');
        const imgUrl = (sub, file) => {
            const f = String(file || '').trim();
            if (!f) { return ''; }
            if (/^https?:\/\//i.test(f)) { return f; }
            // Absolute paths (e.g. /restaurant-images/..) are served by the web
            // origin; bare filenames live in the Yii uploads tree.
            if (f.charAt(0) === '/') { return webBase + f; }
            return upBase + '/' + got.scope.companyId + '/' + sub + '/' + f;
        };

        // Quick-charity tips (label + value rows) for the tips modal.
        const tipRows = await db('quick_tips_configurator')
            .where({ company_id: got.scope.companyId, branch_id: b.id })
            .orderBy('sort_order', 'asc').orderBy('id', 'asc')
            .select('id', 'label', 'value');

        return H.successResponse(res, {
            tips: tipRows.map((t) => ({ id: Number(t.id), label: t.label || '', value: money(t.value) })),
            branch: {
                id: Number(b.id),
                business_name: b.business_name || '',
                business_image: b.business_image || '',
                discount_icon: b.discount_icon || '',
                surprise_image: b.surprise_image || '',
                banner_image: b.banner_image || '',
                // NOTE: business logos live in the "branch" folder (legacy), not
                // "branch_logos" — using the wrong folder 404'd the logo.
                business_image_url: imgUrl('branch', b.business_image),
                discount_icon_url: imgUrl('discount_logos', b.discount_icon),
                surprise_image_url: imgUrl('surprise_image', b.surprise_image),
                banner_image_url: imgUrl('banner_image', b.banner_image),
                direction_address: b.direction_address || '',
                // Legacy call-center / stock / online-paid / per-row / analytics
                close_call_center:             Number(b.close_call_center) || 0,
                coll_cus_details_bef_orders:   Number(b.coll_cus_details_bef_orders) || 0,
                out_of_stock_offline_ordering: Number(b.out_of_stock_offline_ordering) || 0,
                accept_online_paid_order:      Number(b.accept_online_paid_order) || 0,
                per_row_product:               String(b.per_row_product || '1'),
                google_analytics_code:         b.google_analytics_code || '',
                // Core
                branch_info: b.branch_info || '',
                contact_number: b.contact_number || '',
                email: b.email || '',
                thirdparty_print_text: b.thirdparty_print_text || '',
                // SEO
                page_title: b.page_title || '',
                page_meta_keyword: b.page_meta_keyword || '',
                page_meta_description: b.page_meta_description || '',
                // Service toggles + per-service closed-until tab/date
                show_delivery_option: Number(b.show_delivery_option) || 0,
                show_delivery_option_tab: Number(b.show_delivery_option_tab) || 0,
                delivery_closed_util_date: b.delivery_closed_util_date || '',
                show_pickup_option: Number(b.show_pickup_option) || 0,
                show_pickup_option_tab: Number(b.show_pickup_option_tab) || 0,
                pickup_closed_util_date: b.pickup_closed_util_date || '',
                pre_order: Number(b.pre_order) || 0,
                // Website status (badge + modal)
                closed: Number(b.closed) || 0,
                open_as_usual: Number(b.open_as_usual) || 0,
                closed_for: Number(b.closed_for) || 0,
                closed_for_list: b.closed_for_list || '',
                closed_until: Number(b.closed_until) || 0,
                closed_reopen_date: b.closed_reopen_date || '',
                clossed_repoen_time: b.clossed_repoen_time || '',
                clossed_text: b.clossed_text || '',
                // Open/Close badge: closed when flagged OR a service is off.
                store_open: !(Number(b.closed) === 1 || Number(b.show_delivery_option) === 0 || Number(b.show_pickup_option) === 0),
                // Waiting times (split)
                inStore_wait: splitWait(b.inStore_waiting_time),
                delivery_wait: splitWait(b.delivery_waiting_time),
                pickup_wait: splitWait(b.pickup_waiting_time),
                // Service charge
                service_charge_offline_order: money(b.service_charge_offline_order),
                // Payment / order processing toggles
                accept_cash_payments_online: Number(b.accept_cash_payments_online) || 0,
                show_checked_allergies: Number(b.show_checked_allergies) || 0,
                hide_cat_ordering: Number(b.hide_cat_ordering) || 0,
                auto_acc_off_orders: Number(b.auto_acc_off_orders) || 0,
                enable_image_epos: Number(b.enable_image_epos) || 0,
                payments_pbl_qr_enabled: Number(b.payments_pbl_qr_enabled) || 0,
                // Tips
                tips: Number(b.tips) || 0,
                tipe_type: Number(b.tipe_type) || 1,
                mandatory_tip_pos_ordering: Number(b.mandatory_tip_pos_ordering) || 0,
                calculate_tip_on: Number(b.calculate_tip_on) || 1,
                // Credit & bag charges
                credit_management: Number(b.credit_management) || 0,
                offline_bag_charge: money(b.offline_bag_charge),
                online_bag_charge: money(b.online_bag_charge),
                offline_per_bag_qty: Number(b.offline_per_bag_qty) || 0,
                online_per_bag_qty: Number(b.online_per_bag_qty) || 0,
                upselling_msg: b.upselling_msg || '',
                offline_upselling_msg: b.offline_upselling_msg || '',
                // Table ordering
                enable_table_service_ordering: Number(b.enable_table_service_ordering) || 0,
                edit_previous_course_details: Number(b.edit_previous_course_details) || 0,
                group_items_qty_more_one: Number(b.group_items_qty_more_one) || 0,
                sms_online_table_res_request: Number(b.sms_online_table_res_request) || 0,
                instore_all_fields_must_filled: Number(b.instore_all_fields_must_filled) || 0,
                table_cleaning: Number(b.table_cleaning) || 0,
                // Charity & savings
                fix_charity_percentage: money(b.fix_charity_percentage),
                third_party_label: b.third_party_label || '',
                third_party_percentage: money(b.third_party_percentage),
                third_online_website_percentage: money(b.third_online_website_percentage),
                // Button + layout
                button_setting_col: String(b.button_setting_col || '4'),
                webordering_category_layout: Number(b.webordering_category_layout) || 1,
                // Surprise box (Too Good To Go)
                is_toogoodtogo_product: Number(b.is_toogoodtogo_product) || 0,
                price: money(b.price),
                discount_price: money(b.discount_price),
                qty: Number(b.qty) || 0,
                start_time: b.start_time || '',
                end_time: b.end_time || '',
                saving_product_description: b.saving_product_description || '',
                about_surprise_box: b.about_surprise_box || '',
                ingredients_allergens: b.ingredients_allergens || '',
                collection_instructions: b.collection_instructions || '',
            },
            serviceChargeOptions: serviceChargeOptions(),
        });
    } catch (err) {
        console.error('[admin.storeSettings.get]', err && err.message);
        return H.errorResponse(res, 'Could not load store settings.', 500);
    }
}

/**
 * saveSettings — POST /api/v1/admin/store-settings
 * Persists ONLY the whitelisted editable columns for the scoped branch.
 */
async function saveSettings(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const b = req.body;
        const branchId = got.branch.id;

        const patch = {
            // Core text
            branch_info:           b.branch_info != null ? String(b.branch_info) : '',
            contact_number:        b.contact_number != null ? String(b.contact_number) : '',
            email:                 b.email != null ? String(b.email).trim() : got.branch.email,
            thirdparty_print_text: b.thirdparty_print_text != null ? String(b.thirdparty_print_text) : '',
            // SEO
            page_title:            b.page_title != null ? String(b.page_title) : '',
            page_meta_keyword:     b.page_meta_keyword != null ? String(b.page_meta_keyword) : '',
            page_meta_description: b.page_meta_description != null ? String(b.page_meta_description) : '',
            // Service toggles + per-service closed-until (tab 1=today,2=until,3=permanent)
            show_delivery_option:      int01(b.show_delivery_option),
            show_delivery_option_tab:  [1, 2, 3].includes(Number(b.show_delivery_option_tab)) ? Number(b.show_delivery_option_tab) : 0,
            delivery_closed_util_date: b.delivery_closed_util_date ? String(b.delivery_closed_util_date) : null,
            show_pickup_option:        int01(b.show_pickup_option),
            show_pickup_option_tab:    [1, 2, 3].includes(Number(b.show_pickup_option_tab)) ? Number(b.show_pickup_option_tab) : 0,
            pickup_closed_util_date:   b.pickup_closed_util_date ? String(b.pickup_closed_util_date) : null,
            pre_order:                 int01(b.pre_order),
            // Waiting times (concat DD:HH:MM)
            inStore_waiting_time:  joinWait(b.inStore_day, b.inStore_hours, b.inStore_minutes),
            delivery_waiting_time: joinWait(b.delivery_day, b.delivery_hours, b.delivery_minutes),
            pickup_waiting_time:   joinWait(b.pickup_day, b.pickup_hours, b.pickup_minutes),
            // Service charge
            service_charge_offline_order: money(b.service_charge_offline_order),
            // Payment / order processing
            accept_cash_payments_online: int01(b.accept_cash_payments_online),
            show_checked_allergies:      int01(b.show_checked_allergies),
            hide_cat_ordering:           int01(b.hide_cat_ordering),
            auto_acc_off_orders:         int01(b.auto_acc_off_orders),
            enable_image_epos:           int01(b.enable_image_epos),
            payments_pbl_qr_enabled:     int01(b.payments_pbl_qr_enabled),
            // Call-center / stock / online-paid / per-row product / analytics (legacy)
            close_call_center:             int01(b.close_call_center),
            coll_cus_details_bef_orders:   int01(b.coll_cus_details_bef_orders),
            out_of_stock_offline_ordering: int01(b.out_of_stock_offline_ordering),
            accept_online_paid_order:      int01(b.accept_online_paid_order),
            per_row_product:               ['1', '2'].includes(String(b.per_row_product)) ? String(b.per_row_product) : '1',
            google_analytics_code:         b.google_analytics_code != null ? String(b.google_analytics_code) : '',
            // Tips
            tips:                        int01(b.tips),
            tipe_type:                   Number(b.tipe_type) === 2 ? 2 : 1,
            mandatory_tip_pos_ordering:  int01(b.mandatory_tip_pos_ordering),
            calculate_tip_on:            Number(b.calculate_tip_on) === 2 ? 2 : 1,
            // Credit & bag charges
            credit_management:           int01(b.credit_management),
            offline_bag_charge:          money(b.offline_bag_charge),
            online_bag_charge:           money(b.online_bag_charge),
            offline_per_bag_qty:         Number(b.offline_per_bag_qty) || 0,
            online_per_bag_qty:          Number(b.online_per_bag_qty) || 0,
            upselling_msg:               b.upselling_msg != null ? String(b.upselling_msg) : '',
            offline_upselling_msg:       b.offline_upselling_msg != null ? String(b.offline_upselling_msg) : '',
            // Table ordering
            enable_table_service_ordering: int01(b.enable_table_service_ordering),
            edit_previous_course_details:  int01(b.edit_previous_course_details),
            group_items_qty_more_one:      int01(b.group_items_qty_more_one),
            sms_online_table_res_request:  int01(b.sms_online_table_res_request),
            instore_all_fields_must_filled: int01(b.instore_all_fields_must_filled),
            table_cleaning:                int01(b.table_cleaning),
            // Charity & savings
            fix_charity_percentage:        money(b.fix_charity_percentage),
            third_party_label:             b.third_party_label != null ? String(b.third_party_label) : '',
            third_party_percentage:        money(b.third_party_percentage),
            third_online_website_percentage: money(b.third_online_website_percentage),
            // Button + layout
            button_setting_col:            ['4', '5', '6'].includes(String(b.button_setting_col)) ? String(b.button_setting_col) : '4',
            webordering_category_layout:   Number(b.webordering_category_layout) === 2 ? 2 : 1,
            // Surprise box
            is_toogoodtogo_product:        int01(b.is_toogoodtogo_product),
            price:                         money(b.price),
            discount_price:                money(b.discount_price),
            qty:                           Number(b.qty) || 0,
            start_time:                    b.start_time ? String(b.start_time) : null,
            end_time:                      b.end_time ? String(b.end_time) : null,
            saving_product_description:    b.saving_product_description != null ? String(b.saving_product_description) : '',
            about_surprise_box:            b.about_surprise_box != null ? String(b.about_surprise_box) : '',
            ingredients_allergens:         b.ingredients_allergens != null ? String(b.ingredients_allergens) : '',
            collection_instructions:       b.collection_instructions != null ? String(b.collection_instructions) : '',
            // Stamps
            updated_at:                    nowStr(),
            updated_by:                    got.scope.actorId,
        };

        // Cross-field: a surprise-box discount can't exceed its full price.
        if (patch.is_toogoodtogo_product === 1
            && Number(patch.discount_price) > Number(patch.price)) {
            return H.errorResponse(res, 'Surprise box discount price cannot be higher than the price.', 422);
        }

        await db('branch').where('id', branchId).update(patch);
        return H.successResponse(res, { saved: true }, 'Store settings saved.');
    } catch (err) {
        console.error('[admin.storeSettings.save]', err && err.message);
        return H.errorResponse(res, 'Could not save store settings.', 500);
    }
}

// Compute the reopen timestamp for a "closed for X" choice, as 'YYYY-MM-DD HH:mm:ss'.
function computeClosedForTime(list) {
    const now = new Date();
    let d;
    if (list === 'today') { d = new Date(now); d.setHours(23, 59, 59, 0); }
    else if (list === '30min') { d = new Date(now.getTime() + 30 * 60000); }
    else { const h = parseInt(list, 10) || 1; d = new Date(now.getTime() + h * 3600000); }
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * saveWebsiteStatus — POST /api/v1/admin/store-settings/website-status
 * Sets the store's overall open/closed state from the modal:
 *   mode 'open'         → open_as_usual=1, everything cleared
 *   mode 'closed_for'   → closed=1, closed_for=1, closed_for_list, closed_for_time (computed)
 *   mode 'closed_until' → closed=1, closed_until=1, closed_reopen_date + clossed_repoen_time
 * An optional message (clossed_text) is saved in every mode.
 */
async function saveWebsiteStatus(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const b = req.body;
        const mode = String(b.status_mode || 'open');

        const patch = {
            open_as_usual: 0, closed: 0,
            closed_for: 0, closed_for_list: '', closed_for_time: null,
            closed_until: 0, closed_reopen_date: null, clossed_repoen_time: null,
            clossed_text: b.clossed_text != null ? String(b.clossed_text) : '',
            updated_at: nowStr(), updated_by: got.scope.actorId,
        };

        if (mode === 'closed_for') {
            const LIST = ['today', '30min', '1hours', '2hours', '3hours', '4hours'];
            const list = LIST.includes(b.closed_for_list) ? b.closed_for_list : 'today';
            patch.closed = 1; patch.closed_for = 1;
            patch.closed_for_list = list;
            patch.closed_for_time = computeClosedForTime(list);
        } else if (mode === 'closed_until') {
            patch.closed = 1; patch.closed_until = 1;
            patch.closed_reopen_date = b.closed_reopen_date ? String(b.closed_reopen_date) : null;
            patch.clossed_repoen_time = b.clossed_repoen_time ? String(b.clossed_repoen_time) : null;
        } else {
            patch.open_as_usual = 1;
        }

        await db('branch').where('id', got.branch.id).update(patch);
        return H.successResponse(res, { saved: true }, 'Store status updated.');
    } catch (err) {
        console.error('[admin.storeSettings.websiteStatus]', err && err.message);
        return H.errorResponse(res, 'Could not update store status.', 500);
    }
}

/**
 * saveTips — POST /api/v1/admin/store-settings/tips
 * Replaces the quick-charity tips for the branch with the submitted set.
 * Fields arrive as parallel arrays tip_label[] + tip_value[]. Blank labels
 * are skipped. NOTE: this table's created_at/updated_at are UNIX integers.
 */
async function saveTips(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const cid = got.scope.companyId;
        const bid = got.branch.id;
        const ts = Math.floor(Date.now() / 1000);

        let labels = req.body.tip_label;
        let values = req.body.tip_value;
        if (!Array.isArray(labels)) { labels = labels != null && labels !== '' ? [labels] : []; }
        if (!Array.isArray(values)) { values = values != null && values !== '' ? [values] : []; }

        const rows = [];
        for (let i = 0; i < labels.length; i++) {
            const label = String(labels[i] || '').trim().slice(0, 100);
            if (!label) { continue; }
            rows.push({
                company_id: cid, branch_id: bid, label, value: money(values[i]),
                sort_order: rows.length, created_at: ts, updated_at: ts,
                created_by: got.scope.actorId, updated_by: got.scope.actorId,
            });
        }

        await db('quick_tips_configurator').where({ company_id: cid, branch_id: bid }).del();
        if (rows.length) { await db('quick_tips_configurator').insert(rows); }
        return H.successResponse(res, { saved: true }, 'Quick charity tips saved.');
    } catch (err) {
        console.error('[admin.storeSettings.saveTips]', err && err.message);
        return H.errorResponse(res, 'Could not save tips.', 500);
    }
}

// ── Advance Order Waiting Time (sub-page) ───────────────────────────
// order_type: 1=value-time, 2=volume-time. service_type: 1=Pickup, 4=Delivery.

async function advanceList(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const rows = await db('advance_order_waiting_time')
            .where({ company_id: got.scope.companyId, branch_id: got.branch.id, status: 1 })
            .orderBy('order_type', 'asc').orderBy('service_type', 'asc').orderBy('min_subtotal_amount', 'asc')
            .select('id', 'order_type', 'service_type', 'min_subtotal_amount', 'max_subtotal_amount', 'time_for_new_order_min');
        return H.successResponse(res, {
            rows: rows.map((r) => ({
                id: Number(r.id),
                order_type: Number(r.order_type),
                service_type: Number(r.service_type),
                min: Number(r.min_subtotal_amount) || 0,
                max: Number(r.max_subtotal_amount) || 0,
                time: Number(r.time_for_new_order_min) || 0,
            })),
        });
    } catch (err) {
        console.error('[admin.storeSettings.advanceList]', err && err.message);
        return H.errorResponse(res, 'Could not load waiting times.', 500);
    }
}

async function advanceSave(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const cid = got.scope.companyId;
        const bid = got.branch.id;
        const b = req.body;

        const orderType = Number(b.order_type) === 2 ? 2 : 1;
        const serviceType = Number(b.service_type) === 4 ? 4 : 1;
        const min = Number(b.min) || 0;
        const max = Number(b.max) || 0;
        const time = Math.max(0, parseInt(b.time, 10) || 0);
        const id = b.id ? Number(b.id) : null;

        if (max <= min) {
            return H.errorResponse(res, 'The max amount must be greater than the min amount.', 422);
        }
        // No overlapping ranges within the same (branch, order_type, service_type).
        let q = db('advance_order_waiting_time')
            .where({ company_id: cid, branch_id: bid, order_type: orderType, service_type: serviceType, status: 1 })
            .andWhere('min_subtotal_amount', '<=', max)
            .andWhere('max_subtotal_amount', '>=', min);
        if (id) { q = q.andWhere('id', '!=', id); }
        const clash = await q.first();
        if (clash) {
            return H.errorResponse(res, 'This range overlaps an existing one.', 422, { code: 'overlap' });
        }

        if (id) {
            const upd = await db('advance_order_waiting_time')
                .where({ id, company_id: cid, status: 1 })
                .update({ min_subtotal_amount: money(min), max_subtotal_amount: money(max), time_for_new_order_min: time, updated_by: got.scope.actorId, updated_at: nowStr() });
            if (!upd) { return H.errorResponse(res, 'That row no longer exists.', 404); }
        } else {
            await db('advance_order_waiting_time').insert({
                company_id: cid, branch_id: bid, order_type: orderType, service_type: serviceType,
                min_subtotal_amount: money(min), max_subtotal_amount: money(max), time_for_new_order_min: time,
                status: 1, created_by: got.scope.actorId, created_at: nowStr(),
            });
        }
        return H.successResponse(res, { saved: true }, 'Waiting time saved.');
    } catch (err) {
        console.error('[admin.storeSettings.advanceSave]', err && err.message);
        return H.errorResponse(res, 'Could not save the waiting time.', 500);
    }
}

async function advanceDelete(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const n = await db('advance_order_waiting_time')
            .where({ id: Number(req.body.id), company_id: got.scope.companyId })
            .update({ status: 2, updated_by: got.scope.actorId, updated_at: nowStr() });
        if (!n) { return H.errorResponse(res, 'That row no longer exists.', 404); }
        return H.successResponse(res, { deleted: true }, 'Waiting time removed.');
    } catch (err) {
        console.error('[admin.storeSettings.advanceDelete]', err && err.message);
        return H.errorResponse(res, 'Could not remove the row.', 500);
    }
}

/**
 * saveImage — POST /api/v1/admin/store-settings/image
 * Stores the uploaded image FILENAME(S) on the branch row. The admin layer
 * (which has the Yii uploads path mounted) writes the file to disk and posts
 * the resulting filename here. Only the three image columns are touched.
 */
async function saveImage(req, res) {
    try {
        const got = await resolveBranch(req, res);
        if (!got) { return; }
        const patch = {};
        ['business_image', 'discount_icon', 'surprise_image', 'banner_image'].forEach((f) => {
            if (req.body[f]) { patch[f] = String(req.body[f]).slice(0, 255); }
        });
        if (!Object.keys(patch).length) { return H.errorResponse(res, 'No image was provided.', 422); }
        patch.updated_at = nowStr();
        patch.updated_by = got.scope.actorId;
        await db('branch').where('id', got.branch.id).update(patch);
        return H.successResponse(res, { saved: true }, 'Image updated.');
    } catch (err) {
        console.error('[admin.storeSettings.saveImage]', err && err.message);
        return H.errorResponse(res, 'Could not save the image.', 500);
    }
}

module.exports = {
    getSettings, saveSettings, saveWebsiteStatus,
    saveTips, advanceList, advanceSave, advanceDelete, saveImage,
};
