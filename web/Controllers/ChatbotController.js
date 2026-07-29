'use strict';

/*
 * Controllers/ChatbotController.js
 *
 * What:  Relays the help-chatbot question to the api, injecting the signed-in
 *        customer_id from the session so personalised answers (orders, cashback,
 *        offers) work, PLUS the customer's saved lat/lng so "restaurants near me"
 *        / "cuisines near me" can answer. Guests get the FAQ / sign-in nudge.
 * Used:  web/index.js — POST /chatbot/ask (called by /js/ui/chatbot.js).
 */

const { callApi } = require('../Helpers/apiClient');

async function ask(req, res) {
    const user = (req.session && req.session.user) || null;
    const loc  = (req.session && req.session.userLocation) || null;
    const payload = { message: (req.body && req.body.message) || '' };
    if (user && user.id) { payload.customer_id = user.id; }
    // Conversation context (last restaurant etc.) — echoed by the widget so
    // short follow-ups stay on topic. Sanitised to the two known keys.
    const ctx = req.body && req.body.ctx;
    if (ctx && typeof ctx === 'object' && Number(ctx.companyId) > 0) {
        payload.ctx = { intent: String(ctx.intent || ''), companyId: Number(ctx.companyId), companyName: String(ctx.companyName || '').slice(0, 120) };
    }
    // Saved delivery location (top-of-app selector) → drives the "near me"
    // intents; the postcode drives zone-based delivery-fee answers.
    if (loc && loc.lat != null && loc.lng != null) { payload.lat = loc.lat; payload.lng = loc.lng; }
    if (loc && loc.postcode) { payload.postcode = loc.postcode; }
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/customer/chatbot/ask', payload); }
    catch (e) { apiRes = { body: { status: 0, show: true, msg: 'Could not reach the assistant. Please try again.' } }; }
    return res.status(200).json((apiRes && apiRes.body) || { status: 0, show: true, msg: 'Something went wrong.' });
}

module.exports = { ask };
