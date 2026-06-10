'use strict';

/**
 * Controllers/PaymentController.js
 *
 * What:  Thin proxy to the api's Stripe-backed payment endpoints.
 *
 *          POST /payment/intent → forwards to /api/v1/customer/payment/intent,
 *                                  injecting customer_id from the session.
 *
 *        The api never trusts the browser for the amount — it resolves
 *        the open cart's grandtotal itself.
 */

const { callApi }            = require('../Helpers/apiClient');
const { requireUser, relay } = require('../Helpers/authProxy');

const needUser = (req, res) => requireUser(req, res, 'Please sign in to pay.');

async function intent(req, res) {
    const user = needUser(req, res);
    if (!user) { return; }
    const payload = {
        customer_id: user.id,
        save_card:   !!(req.body && req.body.save_card),
    };
    const apiRes  = await callApi(req, 'POST', '/api/v1/customer/payment/intent', payload);
    return relay(res, apiRes);
}

module.exports = { intent };
