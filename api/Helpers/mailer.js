'use strict';

/*
 * Helpers/mailer.js
 *
 * What:  Sends transactional emails (order confirmation to the customer + the
 *        restaurant), ported from the legacy webordering PaymentController
 *        SwiftMailer flow — but with EVERY value DYNAMIC: nothing is hardcoded
 *        (the legacy hardcoded `bookings@helopos.co.uk`). All transport + sender
 *        config comes from ONE place — the .env file. The recipient + signature
 *        come from the DB (setting / branch). One env flip switches demo↔live.
 *
 *        Two providers (same shape as Helpers/otpSender):
 *          • demo — DEFAULT. Logs the email, sends NOTHING. Zero config, never
 *                   breaks an order (used in dev / when SMTP isn't set up).
 *          • smtp — real send via nodemailer over SMTP from the env config.
 *
 *        Every send is BEST-EFFORT: it never throws, so an email hiccup can
 *        never affect a placed order (the order is already committed when this
 *        runs).
 *
 * Env vars (ALL config lives in api/.env — the existing "common file"; these
 * keys ALREADY exist there, this just consumes them — nothing new/hardcoded):
 *   MAIL_HOST       — SMTP host. BLANK → demo (log only, no send). Set → send.
 *   MAIL_PORT       — SMTP port (default 587; 465 = implicit SSL)
 *   MAIL_USERNAME   — SMTP username
 *   MAIL_PASSWORD   — SMTP password
 *   MAIL_ENCRYPTION — 'ssl' forces secure (465 is secure regardless)
 *   MAIL_FROM       — the From address
 *   MAIL_FROM_NAME  — the From display name (default 'EatNDeal')
 *
 * Used:  api/Controllers/Customer/OrderController.place (best-effort, after the
 *        order commits).
 *
 * Change log:
 *   2026-06-11 — initial; port of webordering order email, fully env-driven.
 */

const { db } = require('../config/db');
const H = require('./helper');
const F = require('./format');
const brand = require('../brand.config.js');

// ── Config — read straight from api/.env (the one common file). Uses the
//    EXISTING MAIL_* keys; nothing hardcoded. ───────────────────────────
function provider() {
    // Existing convention: MAIL_HOST blank → log only (demo); set → SMTP send.
    return String(process.env.MAIL_HOST || '').trim() ? 'smtp' : 'demo';
}
function fromAddress() {
    const email = String(process.env.MAIL_FROM || '').trim();
    const name  = String(process.env.MAIL_FROM_NAME || 'EatNDeal').trim();
    return email ? { name, address: email } : null;
}
function smtpConfig() {
    const host = String(process.env.MAIL_HOST || '').trim();
    const port = Number(process.env.MAIL_PORT) || 587;
    const user = String(process.env.MAIL_USERNAME || '').trim();
    const pass = String(process.env.MAIL_PASSWORD || '');
    const enc  = String(process.env.MAIL_ENCRYPTION || '').toLowerCase();
    return {
        host,
        port,
        secure: port === 465 || enc === 'ssl',
        auth: (user || pass) ? { user, pass } : undefined,
        // Pool + keep the connection warm. The first order would otherwise pay
        // the full SMTP handshake (TLS + AUTH) on send; pooling reuses one open
        // connection across orders so a send is fast and never reconnects. This
        // (with the setImmediate defer in OrderController.place) keeps email
        // fully off the place-order response path.
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
    };
}

let _transport = null;
function transport() {
    if (_transport) { return _transport; }
    const nodemailer = require('nodemailer');   // lazy — demo mode never needs it
    _transport = nodemailer.createTransport(smtpConfig());
    return _transport;
}

/**
 * sendMail — low-level send. BEST-EFFORT: returns {ok,...}, never throws.
 * In demo mode (or when From / SMTP host aren't configured) it only logs.
 */
async function sendMail({ to, subject, html, text, replyTo, attachments }) {
    const recipients = (Array.isArray(to) ? to : [to]).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    if (!recipients.length) { return { ok: false, skipped: 'no-recipient' }; }

    const from = fromAddress();
    if (provider() === 'demo' || !from || !smtpConfig().host) {
        H.log.info('mail', 'demo (not sent)', { to: recipients, subject });
        return { ok: true, demo: true };
    }
    try {
        const info = await transport().sendMail({ from, to: recipients, subject, html, text, replyTo: replyTo || undefined, attachments: (attachments && attachments.length) ? attachments : undefined });
        H.log.info('mail', 'sent', { to: recipients, subject, id: info && info.messageId });
        return { ok: true, messageId: info && info.messageId };
    } catch (err) {
        H.log.warn('mail', 'send failed', { to: recipients, subject, err: err && err.message });
        return { ok: false, error: err && err.message };
    }
}

// ── Order confirmation ───────────────────────────────────────────────
function esc(s) { return F.escapeHtml(s); }
function money(n) { return F.CURRENCY_SYMBOL + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

// Absolute public URL for a restaurant's own logo (branch.business_image).
// Emails land in external inboxes, so the src MUST be absolute — we build it
// off WEB_URL (the origin that serves the Yii uploads tree under /yii-uploads).
// VERIFIED: business_image files live in the "<companyId>/branch" folder on
// disk (NOT "branch_logos" — that 404s); see StoreSettingsController note.
function restaurantLogoUrl(companyId, businessImage) {
    const file = String(businessImage || '').trim();
    if (!file) { return ''; }
    if (/^https?:\/\//i.test(file)) { return file; }   // already a full URL
    const web = String(process.env.WEB_URL || '').replace(/\/$/, '');
    const up  = String(process.env.YII_UPLOADS_URL || '/yii-uploads').replace(/\/$/, '');
    if (!web || !companyId) { return ''; }
    return web + up + '/' + companyId + '/branch/' + file.split('/').map(encodeURIComponent).join('/');
}

// One-line restaurant address from the branch row (best-effort).
function restaurantAddress(branch) {
    const parts = [];
    if (branch) {
        ['address_1', 'address_2', 'city', 'state', 'postcode'].forEach((k) => {
            const v = String(branch[k] == null ? '' : branch[k]).trim();
            if (v) { parts.push(v); }
        });
    }
    return parts.join(', ');
}

// Restaurant identity (recipient + branding for the email) — DYNAMIC from the
// DB. Returns the restaurant's OWN name / email / logo / address so every email
// is branded as the ordering restaurant, NOT as the EatNDeal marketplace.
async function restaurantContact(companyId, branch) {
    let email = (branch && branch.email) ? String(branch.email).trim() : '';
    let name  = (branch && (branch.business_name || branch.name)) ? String(branch.business_name || branch.name).trim() : '';
    let image = (branch && branch.business_image) ? String(branch.business_image).trim() : '';
    try {
        const s = await db('setting').where('company_id', companyId).first('email', 'business_name', 'trading_name');
        if (s) {
            if (!email && s.email) { email = String(s.email).trim(); }
            if (!name && (s.business_name || s.trading_name)) { name = String(s.business_name || s.trading_name).trim(); }
        }
    } catch (e) { /* best-effort */ }
    name = name || 'the restaurant';
    return {
        email,
        name,
        logoUrl:   restaurantLogoUrl(companyId, image),
        address:   restaurantAddress(branch),
        copyright: '© ' + name + '. All rights reserved.',
    };
}

const RED = '#E5252A';

// Shared branded shell — logo header + body + footer. Branding is per-restaurant
// (`b` = { name, logoUrl, email, address, copyright }): the header shows the
// restaurant's OWN logo (absolute <img>) when it has one, else its name as a
// wordmark — never the EatNDeal logo. The footer carries the restaurant's
// name · email · address. A small "Ordered via <brand>" credit line stays at
// the very bottom so the marketplace origin is still clear.
function wrapEmail(bodyHtml, b) {
    b = b || {};
    const name = b.name || brand.name;
    const head = b.logoUrl
        ? '<img src="' + b.logoUrl + '" alt="' + esc(name) + '" height="46" style="display:block;margin:0 auto;border:0;max-height:54px;">'
        : '<div style="font-size:22px;font-weight:800;color:' + RED + ';">' + esc(name) + '</div>';
    const footerLines = [];
    footerLines.push(esc(name) + (b.email ? ' &middot; ' + esc(b.email) : ''));
    if (b.address) { footerLines.push(esc(b.address)); }
    footerLines.push(esc(b.copyright || ('© ' + name)));
    return ''
        + '<div style="background:#f4f4f5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">'
        +   '<table align="center" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">'
        +     '<tr><td style="padding:22px 24px;text-align:center;border-bottom:3px solid ' + RED + ';">' + head + '</td></tr>'
        +     '<tr><td style="padding:24px;">' + bodyHtml + '</td></tr>'
        +     '<tr><td style="padding:16px 24px;background:#fafafa;border-top:1px solid #eee;text-align:center;color:#9a9a9a;font-size:12px;line-height:1.7;">'
        +       footerLines.join('<br>')
        +       '<br><span style="color:#bdbdbd;">Ordered via ' + esc(brand.name) + '</span>'
        +     '</td></tr>'
        +   '</table>'
        + '</div>';
}

// Shared order-summary bits.
function modeLabel(order, cart) {
    const serve = Number(order && order.serve_type) || Number(cart && cart.serve_type) || 0;
    return serve === 3 ? 'Delivery' : 'Collection / Pickup';
}
function itemsTable(items) {
    const rows = (items || []).map(function (it) {
        const name = esc(it.product_name || it.name || 'Item');
        const qty  = Number(it.product_qty || it.qty || it.quantity || 1);
        const price = (it.total_price != null) ? it.total_price : (it.price != null ? it.price : null);
        return '<tr>'
            + '<td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#1c1c1c;">' + qty + ' &times; ' + name + '</td>'
            + '<td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:right;color:#1c1c1c;white-space:nowrap;">' + (price != null ? money(price) : '') + '</td>'
            + '</tr>';
    }).join('');
    if (!rows) { return ''; }
    return '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 4px;">'
        + '<tr><th align="left" style="padding:6px 0;border-bottom:2px solid #eee;color:#6b6b6b;font-size:11px;letter-spacing:.04em;text-transform:uppercase;">Item</th>'
        + '<th align="right" style="padding:6px 0;border-bottom:2px solid #eee;color:#6b6b6b;font-size:11px;letter-spacing:.04em;text-transform:uppercase;">Amount</th></tr>'
        + rows + '</table>';
}
// Cash | Card from the chosen payment_option (2 = card), with a fallback to
// the order's card surcharge.
function paymentLabel(paymentOption, order) {
    const po = Number(paymentOption);
    if (po === 2) { return 'Card'; }
    if (po === 1) { return 'Cash'; }
    return (order && Number(order.stripe_service_charge) > 0) ? 'Card' : 'Cash';
}

// Order meta box — order #, type, payment, and (pre-order) schedule.
function metaTable(order, cart, paymentLbl) {
    const o = order || {}, c = cart || {};
    const num = esc((o.order_number || o.id) || '');
    const mrow = function (lbl, val, strong) {
        return '<tr><td style="color:#6b6b6b;padding:3px 0;">' + esc(lbl) + '</td><td align="right" style="padding:3px 0;' + (strong ? 'font-weight:700;' : '') + 'color:#1c1c1c;">' + val + '</td></tr>';
    };
    const arr = [mrow('Order number', '#' + num, true), mrow('Type', modeLabel(o, c))];
    if (paymentLbl) { arr.push(mrow('Payment', esc(paymentLbl))); }
    if (Number(o.is_pre_order != null ? o.is_pre_order : c.is_pre_order) === 1) {
        const when = String(o.scheduled_time || c.scheduled_time || '').trim();
        arr.push(mrow('When', when ? esc(when) : 'Scheduled for later'));
    }
    return infoBox('<table width="100%" cellpadding="0" cellspacing="0">' + arr.join('') + '</table>');
}

// Full price breakdown — every charge the checkout showed, then the total.
// Credits (discount / reward) render green with a minus sign.
function breakdownTable(order, cart) {
    const o = order || {}, c = cart || {};
    const serve = Number(o.serve_type) || Number(c.serve_type) || 0;
    const pick = function (k) { const v = (o[k] != null) ? o[k] : c[k]; return Number(v) || 0; };
    const lines = [];                          // [label, valueHtml, isCredit]
    lines.push(['Subtotal', money(pick('sub_total')), false]);
    if (pick('bag_charge') > 0) { lines.push(['Bag charge', money(pick('bag_charge')), false]); }
    if (serve === 3) {
        const free = Number(o.free_delivery != null ? o.free_delivery : c.free_delivery) === 1;
        lines.push(['Delivery fee', free ? 'Free' : money(pick('delivery_fees')), false]);
    }
    if (pick('service_charge_amount') > 0) { lines.push(['Service charge', money(pick('service_charge_amount')), false]); }
    if (Number(o.stripe_service_charge) > 0) { lines.push(['Card fee', money(o.stripe_service_charge), false]); }
    if (pick('charity_amount') > 0) { lines.push(['Charity', money(pick('charity_amount')), false]); }
    if (pick('discount') > 0) {
        const src = (Number(o.coupon_id || c.coupon_id) > 0) ? 'Coupon'
                  : (Number(o.voucher_id || c.voucher_id) > 0) ? 'Voucher' : 'Discount';
        const code = String(c.promocode || '').trim();
        lines.push([src + (code ? ' (' + esc(code) + ')' : ''), '-' + money(pick('discount')), true]);
    }
    if (pick('used_cashback') > 0) { lines.push(['Reward applied', '-' + money(pick('used_cashback')), true]); }

    const rowsHtml = lines.map(function (l) {
        return '<tr><td style="padding:5px 0;color:' + (l[2] ? '#14A35E' : '#6b6b6b') + ';">' + l[0] + '</td>'
            + '<td align="right" style="padding:5px 0;color:' + (l[2] ? '#14A35E' : '#1c1c1c') + ';white-space:nowrap;">' + l[1] + '</td></tr>';
    }).join('');
    const gt = money(o.grand_total != null ? o.grand_total : c.grandtotal);
    return '<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;margin-top:8px;">'
        + rowsHtml
        + '<tr><td style="padding:9px 0 0;border-top:1px solid #eee;font-weight:800;color:#1c1c1c;">Total</td>'
        + '<td align="right" style="padding:9px 0 0;border-top:1px solid #eee;font-weight:800;font-size:17px;color:#1c1c1c;white-space:nowrap;">' + gt + '</td></tr>'
        + '</table>';
}
function infoBox(inner, bg, border) {
    return '<table width="100%" cellpadding="0" cellspacing="0" style="background:' + (bg || '#f7f7f8') + ';' + (border ? 'border:1px solid ' + border + ';' : '') + 'border-radius:10px;margin:0 0 16px;">'
        + '<tr><td style="padding:13px 15px;color:#1c1c1c;">' + inner + '</td></tr></table>';
}

// CUSTOMER email — a thank-you + the FULL order summary (everything the
// checkout showed: type, payment, schedule, items, every charge, discount,
// reward, total).
function buildCustomerHtml({ order, customer, items, cart, restBrand, paymentLbl }) {
    const restaurantName = (restBrand && restBrand.name) || 'the restaurant';
    const first = esc((customer && (customer.firstname || customer.first_name)) || 'there');
    const serve = Number(order && order.serve_type) || Number(cart && cart.serve_type) || 0;
    const addr  = (serve === 3) ? esc(((order && order.delivery_address) || (cart && cart.delivery_address)) || '') : '';
    const body = ''
        + '<h1 style="font-size:20px;margin:0 0 6px;color:#1c1c1c;">Thank you for your order! &#127881;</h1>'
        + '<p style="margin:0 0 16px;color:#6b6b6b;">Hi ' + first + ', your order from <strong>' + esc(restaurantName) + '</strong> is confirmed.</p>'
        + metaTable(order, cart, paymentLbl)
        + (addr ? '<p style="margin:-6px 0 14px;color:#6b6b6b;">Deliver to: ' + addr + '</p>' : '')
        + itemsTable(items)
        + breakdownTable(order, cart)
        + '<p style="margin:18px 0 0;color:#6b6b6b;">We&rsquo;ll let you know as soon as <strong>' + esc(restaurantName) + '</strong> starts preparing it.</p>';
    return wrapEmail(body, restBrand);
}

// RESTAURANT / admin email — NEW-ORDER alert + the CUSTOMER's details + the
// FULL order summary (same breakdown the customer sees).
function buildRestaurantHtml({ order, customer, items, cart, restBrand, paymentLbl }) {
    const num    = esc((order && (order.order_number || order.id)) || '');
    const cName  = esc((((customer && (customer.firstname || customer.first_name)) || '') + ' ' + ((customer && (customer.lastname || customer.last_name)) || '')).trim() || 'Customer');
    const cPhone = esc((customer && customer.contact_no) || '');
    const serve  = Number(order && order.serve_type) || Number(cart && cart.serve_type) || 0;
    const addr   = (serve === 3) ? esc(((order && order.delivery_address) || (cart && cart.delivery_address)) || '') : '';
    const body = ''
        + '<h1 style="font-size:20px;margin:0 0 6px;color:' + RED + ';">&#128276; New order &mdash; #' + num + '</h1>'
        + '<p style="margin:0 0 16px;color:#6b6b6b;">A new order just came in. Please prepare it.</p>'
        + infoBox('<strong>Customer</strong><br>' + cName + (cPhone ? ' &middot; ' + cPhone : '')
            + '<br><span style="color:#6b6b6b;">' + modeLabel(order, cart) + (addr ? ' &middot; ' + addr : '') + '</span>', '#fff4e5', '#ffe0b2')
        + metaTable(order, cart, paymentLbl)
        + itemsTable(items)
        + breakdownTable(order, cart);
    return wrapEmail(body, restBrand);
}

/**
 * sendOrderConfirmation — emails the order to the customer (a THANK-YOU) AND
 * the restaurant (a NEW-ORDER alert with the customer's details) — two
 * DIFFERENT branded templates, both with the logo header (CID-embedded).
 * Recipients + restaurant name are DYNAMIC (DB); From + transport are DYNAMIC
 * (env). Best-effort.
 *
 * Input: { order, customer, items, cart, companyId, branch }
 * Output: { customer?: {...}, restaurant?: {...} } send results.
 */
async function sendOrderConfirmation({ order, customer, items, cart, companyId, branch, paymentOption }) {
    if (!order) { return {}; }
    // restBrand = the ORDERING restaurant's own identity (name / logo / email /
    // address). Every email below is branded with THIS, not the EatNDeal
    // marketplace. The logo is an absolute <img> in the header (no attachment).
    const restBrand = await restaurantContact(companyId, branch);
    const num = (order.order_number || order.id) || '';
    const paymentLbl = paymentLabel(paymentOption, order);

    const out = {};
    const custEmail = (customer && customer.email) ? String(customer.email).trim() : '';
    if (custEmail) {
        const html = buildCustomerHtml({ order, customer, items, cart, restBrand, paymentLbl });
        out.customer = await sendMail({ to: custEmail, subject: restBrand.name + ' — order #' + num + ' confirmed', html, replyTo: restBrand.email });
    }
    if (restBrand.email) {
        const html = buildRestaurantHtml({ order, customer, items, cart, restBrand, paymentLbl });
        out.restaurant = await sendMail({ to: restBrand.email, subject: 'New order #' + num + ' — ' + restBrand.name, html });
    }
    return out;
}

module.exports = { provider, sendMail, sendOrderConfirmation, buildCustomerHtml, buildRestaurantHtml };
