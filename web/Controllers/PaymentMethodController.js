'use strict';

/*
 * Controllers/PaymentMethodController.js
 *
 * What:   Thin proxy between the browser and the api's saved-cards
 *         endpoints. customer_id is injected from the session so the
 *         client can't spoof another customer.
 *           GET  /payment-methods          → list saved cards
 *           POST /payment-method/setup     → SetupIntent client_secret
 *           POST /payment-method/delete    → detach card
 */

const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

const needUser = (req, res) => requireUser(req, res, 'Please sign in to manage payment methods.');

async function list(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const qs = new URLSearchParams({ customer_id: String(user.id) });
    const apiRes = await callApi(req, 'GET', '/api/v1/customer/payment-methods?' + qs.toString());
    return relay(res, apiRes);
}

async function setupIntent(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/payment-method/setup',
        { customer_id: user.id });
    return relay(res, apiRes);
}

async function remove(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = { customer_id: user.id, payment_method_id: req.body.payment_method_id };
    const apiRes = await callApi(req, 'POST', '/api/v1/customer/payment-method/delete', payload);
    return relay(res, apiRes);
}

module.exports = { list, setupIntent, remove };
