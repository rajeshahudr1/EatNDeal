'use strict';

/**
 * Middlewares/deviceHeaders.js
 *
 * What:   Reads device-context headers off every authenticated request and
 *         attaches them to `req.device` so the controller can persist them
 *         (e.g. updating cart.devicetype / cart.devicetoken on cart actions,
 *         orders.created_from on order placement).
 * Why:    The live wtw_eatndeal DB already has columns for device tracking
 *         (cart.devicetype, cart.devicetoken, orders.created_from). Both
 *         the web PWA and the future Flutter app should be passing these
 *         headers; this middleware normalises them in one place.
 * Type:   READ (annotates req; no DB).
 * Inputs: Headers on req:
 *           X-Device-Token  — FCM / web-push token (string)
 *           X-Device-OS     — 'web' | 'android' | 'ios'
 *           X-Device-Model  — free-text device model (string, optional)
 *           X-App-Version   — semver string (optional)
 *           X-FCM-Token     — explicit FCM token if separate from X-Device-Token
 * Output: side-effect — sets req.device = { token, os, model, appVersion, fcmToken }.
 *         Missing headers result in nulls (not undefined) so DB writes are
 *         predictable.
 * Used:   Mounted AFTER `authenticate` on routes that care about device
 *         provenance (cart actions, order placement, push registration).
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const ALLOWED_OS = new Set(['web', 'android', 'ios']);

/**
 * normaliseOs
 *
 * What:   Lower-cases + validates the X-Device-OS header value.
 * Why:    Restricts the column value to a known set so we don't get random
 *         strings polluting cart.devicetype / orders.created_from-style fields.
 * Type:   READ (pure function).
 * Inputs: value (string | undefined).
 * Output: one of 'web' / 'android' / 'ios', or null if unrecognised.
 * Used:   Only inside this middleware.
 */
function normaliseOs(value) {
    if (typeof value !== 'string') return null;
    const lower = value.trim().toLowerCase();
    return ALLOWED_OS.has(lower) ? lower : null;
}

/**
 * deviceHeaders
 *
 * What:   Express middleware — populates req.device from request headers.
 * Why:    See file header.
 * Type:   READ.
 * Inputs: req, res, next.
 * Output: calls next() after setting req.device.
 * Used:   Routes/index.js — after `authenticate` on routes that write
 *         device-tagged rows.
 */
function deviceHeaders(req, res, next) {
    const h = req.headers;

    // Pull each header, default to null (not undefined) so DB writes are
    // explicit nulls rather than "missing property" weirdness.
    const token      = typeof h['x-device-token'] === 'string' && h['x-device-token'].trim() !== ''
                     ? h['x-device-token'].trim() : null;
    const os         = normaliseOs(h['x-device-os']);
    const model      = typeof h['x-device-model'] === 'string' && h['x-device-model'].trim() !== ''
                     ? h['x-device-model'].trim() : null;
    const appVersion = typeof h['x-app-version'] === 'string' && h['x-app-version'].trim() !== ''
                     ? h['x-app-version'].trim() : null;
    const fcmToken   = typeof h['x-fcm-token'] === 'string' && h['x-fcm-token'].trim() !== ''
                     ? h['x-fcm-token'].trim() : null;

    req.device = { token, os, model, appVersion, fcmToken };
    next();
}

module.exports = { deviceHeaders };
