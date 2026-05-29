'use strict';

/**
 * Validators/location.js
 *
 * What:   Validates the body of POST /location/save before the controller
 *         writes it onto req.session. Returns a clean shape with
 *         coerced types (numbers as numbers, strings trimmed) or an
 *         array of human-readable error messages.
 * Why:    Coding-Conventions rule #3 — server-side validation even though
 *         the client already validated. We don't want corrupt session
 *         data (e.g. lat as a string) breaking later restaurant search.
 *         Plain-JS implementation (no Joi) — keeps the web layer light;
 *         heavier validation happens at the api layer where it matters.
 * Type:   READ (pure function).
 * Inputs: input — req.body posted by the location modal.
 * Output: { ok: true,  value: <clean location object> }
 *           OR
 *         { ok: false, errors: [<msg1>, <msg2>, ...] }
 * Used:   web/Controllers/LocationController.js (save action).
 *
 * Allowed sources mirror what the location modal can produce:
 *   • 'postcode'    — user picked a postcode autocomplete result
 *   • 'geolocation' — browser geolocation API
 *   • 'popular'     — user tapped a popular-city chip
 *   • 'manual'      — reserved for future free-text entry
 *   • 'saved'       — user tapped a saved address card
 *   • 'recent'      — user tapped a recent-search chip
 *   • 'searched'    — re-selecting the current active pick
 *
 * Change log:
 *   2026-05-25 — initial.
 *   2026-05-29 — added saved / recent / searched (location-sheet redesign).
 */

const ALLOWED_SOURCES = new Set(['postcode', 'geolocation', 'popular', 'manual', 'saved', 'recent', 'searched']);
const MAX_LABEL_LEN   = 200;
const MAX_POSTCODE_LEN = 20;

/**
 * isNumberLike
 *
 * What:  Returns true when the value parses to a finite number (covers
 *        the case where the client sent lat/lng as a string).
 * Why:   Browser geolocation returns numbers, but JSON over the wire
 *        sometimes gets stringified by intermediate code. Be tolerant.
 * Type:  READ (pure function).
 */
function isNumberLike(value) {
    if (value === null || value === undefined || value === '') return false;
    const n = Number(value);
    return Number.isFinite(n);
}

/**
 * validateLocation
 *
 * What:  Validates the shape of an incoming location object. Trims
 *        strings, coerces lat/lng to numbers, enforces source allowlist,
 *        and clamps lat/lng to plausible ranges (−90..90 / −180..180).
 * Why:   Defends the session store from junk. See file header.
 * Type:  READ.
 * Inputs: input (any).
 * Output: { ok, value? , errors? } — see file header.
 * Used:   LocationController.save.
 */
function validateLocation(input) {
    const errors = [];

    if (!input || typeof input !== 'object') {
        return { ok: false, errors: ['Location data is missing or malformed.'] };
    }

    // ── source (required) ────────────────────────────────────────
    const source = String(input.source || '').trim().toLowerCase();
    if (!ALLOWED_SOURCES.has(source)) {
        errors.push('Location source is invalid.');
    }

    // ── label (required, free text, capped) ──────────────────────
    let label = '';
    if (typeof input.label === 'string') {
        label = input.label.trim();
    }
    if (!label) {
        errors.push('Location label is required.');
    } else if (label.length > MAX_LABEL_LEN) {
        label = label.slice(0, MAX_LABEL_LEN);
    }

    // ── postcode (optional string) ───────────────────────────────
    let postcode = null;
    if (input.postcode !== null && input.postcode !== undefined && input.postcode !== '') {
        if (typeof input.postcode !== 'string') {
            errors.push('Postcode must be text.');
        } else {
            postcode = input.postcode.trim().toUpperCase();
            if (postcode.length > MAX_POSTCODE_LEN) {
                postcode = postcode.slice(0, MAX_POSTCODE_LEN);
            }
        }
    }

    // ── lat / lng (optional but must be valid when present) ──────
    let lat = null;
    if (input.lat !== null && input.lat !== undefined && input.lat !== '') {
        if (!isNumberLike(input.lat)) {
            errors.push('Latitude is invalid.');
        } else {
            lat = Number(input.lat);
            if (lat < -90 || lat > 90) {
                errors.push('Latitude is out of range.');
                lat = null;
            }
        }
    }
    let lng = null;
    if (input.lng !== null && input.lng !== undefined && input.lng !== '') {
        if (!isNumberLike(input.lng)) {
            errors.push('Longitude is invalid.');
        } else {
            lng = Number(input.lng);
            if (lng < -180 || lng > 180) {
                errors.push('Longitude is out of range.');
                lng = null;
            }
        }
    }

    // ── mode (optional) — delivery | pickup. Defaults to delivery.
    // Carries the Delivery/Pickup choice the user made on the location
    // page so the feed header can show the same selection. ───────────
    let mode = 'delivery';
    if (typeof input.mode === 'string') {
        const m = input.mode.trim().toLowerCase();
        if (m === 'pickup' || m === 'delivery') { mode = m; }
    }

    // ── raw (optional) — pass-through; capped at 5 KB stringified ──
    let raw = null;
    if (input.raw && typeof input.raw === 'object') {
        try {
            const serialised = JSON.stringify(input.raw);
            if (serialised.length <= 5 * 1024) {
                raw = input.raw;
            }
        } catch {
            // Non-serialisable raw → drop it.
        }
    }

    // ── At least ONE of postcode / (lat+lng) must be present ─────
    // For the `postcode` source (autocomplete picks) and `geolocation`
    // source we need *something* to locate the user — but accept
    // EITHER. A region-level Nominatim pick (e.g. "Aberdeenshire,
    // Scotland") has lat/lng but no postcode, and that's fine: we
    // just need to know where on Earth they are. A pure-postcode pick
    // is also fine. Popular-city picks send neither — that's allowed
    // because we resolve to a centroid later.
    const needsLocator  = source === 'postcode' || source === 'geolocation';
    const hasPostcode   = !!postcode;
    const hasCoords     = lat !== null && lng !== null;
    if (needsLocator && !hasPostcode && !hasCoords) {
        errors.push('Location is missing coordinates or a postcode.');
    }

    if (errors.length) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        value: {
            source,
            label,
            postcode,
            lat,
            lng,
            mode,
            raw,
            savedAt: new Date().toISOString(),
        },
    };
}

module.exports = { validateLocation, ALLOWED_SOURCES };
