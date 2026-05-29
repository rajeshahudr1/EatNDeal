'use strict';

/*
 * Helpers/distance.js
 *
 * What:  Great-circle distance between two lat/lng points via the
 *        Haversine formula. Returns kilometres as a number.
 *
 * Why:   The marketplace dashboard surfaces "X.X km" on every
 *        restaurant card and dish card. The wtw_eatndeal database
 *        stores branch coordinates as plain numeric columns (no
 *        PostGIS extension), so we compute distance application-side
 *        instead of in a SQL expression. For the ~10-row branch set
 *        we have today the cost is negligible; once we shard / scale
 *        we'll move to PostGIS earthdistance or a precomputed grid.
 *
 * Used:  api/Controllers/Marketplace/*Controller.js to attach a
 *        `distanceKm` field to every row returned by the dashboard
 *        endpoints.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * toRad
 *
 * What:  Degrees → radians. Standalone (not Math.PI / 180 inline) so
 *        the formula reads cleanly.
 * Type:  READ (pure).
 */
function toRad(deg) {
    return (Number(deg) * Math.PI) / 180;
}

/**
 * kmBetween
 *
 * What:  Returns kilometres between (lat1, lng1) and (lat2, lng2).
 *        Returns null if any input is missing or non-numeric — the
 *        caller decides how to render "unknown distance".
 * Type:  READ (pure).
 *
 * Inputs:
 *   { lat: number, lng: number } pair OR four scalars (lat1, lng1, lat2, lng2)
 * Output: number (km, rounded to 1 dp) | null
 */
function kmBetween(lat1, lng1, lat2, lng2) {
    // Treat null / undefined / empty-string as "missing" — Number(null)
    // and Number('') both return 0 which is finite, but a finite zero
    // is a real coordinate (the Atlantic off Africa). Without this guard
    // a user with no saved lat/lng would get ~6400 km to any UK branch.
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) { return null; }
    if (lat1 === '' || lng1 === '' || lat2 === '' || lng2 === '')      { return null; }
    const a = Number(lat1);
    const b = Number(lng1);
    const c = Number(lat2);
    const d = Number(lng2);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
        return null;
    }
    const dLat = toRad(c - a);
    const dLng = toRad(d - b);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
    const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
    return Math.round(km * 10) / 10;
}

/**
 * estimateDeliveryMinutes
 *
 * What:  Turns a distance (km) into a human-readable delivery-time
 *        RANGE that scales sensibly across orders of magnitude. The
 *        unit auto-escalates so we never produce nonsense like
 *        "30h 5m - 30h 15m":
 *
 *          centre  range bucket    example output
 *          ──────  ──────────────  ──────────────────
 *          ≤ 60m   minutes         "15-25 min"
 *          ≤ 24h   hours           "2-3 hr"
 *          ≤ 30d   days            "1-2 days"
 *           > 30d  months          "1-2 months"
 *
 *        Formula for the centre:
 *          centre_min = PREP_MIN + km * KM_TO_MIN
 *            PREP_MIN  = 12   (food prep / packing buffer)
 *            KM_TO_MIN = 3    (1 km ≈ 3 min @ 20 km/h city bike avg)
 *
 *        The bucket window grows roughly proportionally so the
 *        low/high pair always looks like a real estimate at that
 *        scale (10-min window in minutes, 1-hour window in hours, etc.)
 *
 *        Returns null when the input distance is null / NaN (caller
 *        decides the empty-state copy).
 *
 * Why:   For deliverable distances (≤ ~10 km) we want a tight 10-min
 *        window. For absurd distances (cross-country marketplace
 *        listing tested from far away) we want a sensible "1-2 days"
 *        rather than "30h 5m". The escalation also surfaces
 *        accidentally-large numbers ("3 months" reads to the user as
 *        "something is wrong" instead of being misinterpretable as
 *        a normal estimate).
 * Type:  READ (pure).
 */
const PREP_MIN     = 12;
const KM_TO_MIN    = 3;
const MIN_IN_HOUR  = 60;
const MIN_IN_DAY   = 60 * 24;
const MIN_IN_MONTH = 60 * 24 * 30;

function estimateDeliveryMinutes(km) {
    const d = Number(km);
    if (!Number.isFinite(d) || d < 0) { return null; }
    const centre = PREP_MIN + d * KM_TO_MIN;

    // ── ≤ 60 min  →  X-Y min  (5-min steps, 10-min window) ───────
    if (centre <= MIN_IN_HOUR) {
        const low  = Math.max(5, Math.floor((centre - 5) / 5) * 5);
        return low + '-' + (low + 10) + ' min';
    }

    // ── ≤ 24 h  →  X-Y hr  (1-hour window) ────────────────────────
    if (centre <= MIN_IN_DAY) {
        const hours = Math.max(1, Math.floor(centre / MIN_IN_HOUR));
        return hours + '-' + (hours + 1) + ' hr';
    }

    // ── ≤ 30 days  →  X-Y days  (1-day window) ────────────────────
    if (centre <= MIN_IN_MONTH) {
        const days = Math.max(1, Math.floor(centre / MIN_IN_DAY));
        return days + '-' + (days + 1) + ' days';
    }

    // ── > 30 days  →  X-Y months  (1-month window, capped at 12) ──
    const months = Math.min(12, Math.max(1, Math.floor(centre / MIN_IN_MONTH)));
    if (months >= 12) { return '12+ months'; }
    return months + '-' + (months + 1) + ' months';
}

/**
 * estimateDeliveryMinutesNumeric
 *
 * What:  The numeric "centre" minutes behind estimateDeliveryMinutes —
 *        PREP_MIN + km * KM_TO_MIN. Used to bucket a restaurant into a
 *        delivery-time band (Up to 15 / 15-30 / 30-45 / 45+) for the
 *        sidebar filter + its dynamic facet counts. Returns null for a
 *        missing / negative distance.
 * Type:  READ (pure).
 */
function estimateDeliveryMinutesNumeric(km) {
    const d = Number(km);
    if (!Number.isFinite(d) || d < 0) { return null; }
    return PREP_MIN + d * KM_TO_MIN;
}

/**
 * estimatePickupMinutes
 *
 * What:  Pickup time RANGE — how long for the CUSTOMER to reach the shop,
 *        derived from distance (no rider, no prep buffer; just travel +
 *        a small ready buffer). Same auto-escalating buckets as
 *        estimateDeliveryMinutes so it never reads as nonsense at large
 *        distances. centre = PICKUP_BASE + km * KM_TO_MIN_PICKUP.
 * Why:   Delivery time comes from the merchant/postcode; pickup is
 *        location-driven (the user travels to collect).
 * Type:  READ (pure).
 */
const PICKUP_BASE        = 4;     // ready/collection buffer
const KM_TO_MIN_PICKUP   = 2.2;   // ≈ 27 km/h town travel

function estimatePickupMinutes(km) {
    const d = Number(km);
    if (!Number.isFinite(d) || d < 0) { return null; }
    const centre = PICKUP_BASE + d * KM_TO_MIN_PICKUP;
    if (centre <= MIN_IN_HOUR) {
        const low = Math.max(5, Math.floor((centre - 5) / 5) * 5);
        return low + '-' + (low + 10) + ' min';
    }
    if (centre <= MIN_IN_DAY) {
        const hours = Math.max(1, Math.floor(centre / MIN_IN_HOUR));
        return hours + '-' + (hours + 1) + ' hr';
    }
    if (centre <= MIN_IN_MONTH) {
        const days = Math.max(1, Math.floor(centre / MIN_IN_DAY));
        return days + '-' + (days + 1) + ' days';
    }
    const months = Math.min(12, Math.max(1, Math.floor(centre / MIN_IN_MONTH)));
    if (months >= 12) { return '12+ months'; }
    return months + '-' + (months + 1) + ' months';
}

module.exports = {
    kmBetween,
    estimateDeliveryMinutes,
    estimateDeliveryMinutesNumeric,
    estimatePickupMinutes,
};
