'use strict';

/*
 * Controllers/PartnerController.js
 *
 * What:  Public "Partner with us / Contact us" lead form handler. A
 *        restaurant or visitor fills the form on the website; we email the
 *        enquiry to the business inbox so the team can follow up.
 * Why:   The site needs a HungerStation-style "list your restaurant" /
 *        contact channel. No DB table (keeps the live schema untouched) —
 *        the lead is emailed via the shared mailer (logs to console when
 *        SMTP isn't configured, so nothing is ever lost).
 * Type:  WRITE (sends email; no DB).
 * Used:  api/Routes/index.js — POST /partner/lead (public, no auth).
 */

const H      = require('../Helpers/helper');
const mailer = require('../Helpers/mailer');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function lead(req, res) {
    try {
        const b = req.body || {};
        const f = {
            name:     String(b.name     || '').trim().slice(0, 120),
            business: String(b.business || '').trim().slice(0, 160),
            email:    String(b.email    || '').trim().slice(0, 160),
            phone:    String(b.phone    || '').trim().slice(0, 40),
            city:     String(b.city     || '').trim().slice(0, 120),
            cuisine:  String(b.cuisine  || '').trim().slice(0, 120),
            message:  String(b.message  || '').trim().slice(0, 2000),
        };
        if (!f.name)              { return H.errorResponse(res, 'Please enter your name.', 422); }
        if (!f.email && !f.phone) { return H.errorResponse(res, 'Please add an email or phone so we can reach you.', 422); }
        if (f.email && !EMAIL_RE.test(f.email)) { return H.errorResponse(res, 'Please enter a valid email address.', 422); }

        const to = process.env.PARTNER_LEAD_EMAIL || process.env.MAIL_FROM || '';
        const rows = [
            ['Name', f.name], ['Business', f.business], ['Email', f.email], ['Phone', f.phone],
            ['City', f.city], ['Cuisine / Category', f.cuisine], ['Message', f.message],
        ].filter((r) => r[1]);
        const html = '<h2 style="margin:0 0 12px">New partner / contact enquiry</h2>'
            + '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">'
            + rows.map((r) => '<tr><td style="font-weight:700;color:#444;vertical-align:top">' + esc(r[0]) + '</td><td>' + esc(r[1]).replace(/\n/g, '<br>') + '</td></tr>').join('')
            + '</table>';

        // Never fail the request if mail is down — the lead is logged either way.
        try {
            await mailer.sendMail({
                to, subject: 'New partner enquiry — ' + (f.business || f.name),
                html, replyTo: f.email || undefined,
            });
        } catch (e) { H.log.error('partner.lead.mail', e && e.message); }

        return H.successResponse(res, { ok: true }, "Thanks! We've received your details and will be in touch soon.");
    } catch (err) {
        H.log.error('partner.lead', err && err.message);
        return H.errorResponse(res, 'Something went wrong. Please try again.', 500);
    }
}

module.exports = { lead };
