'use strict';

/*
 * Controllers/Marketplace/PlacesController.js
 *
 * What:  Public geo helpers for the location gate page (views/site/location.ejs):
 *          • GET /api/v1/marketplace/cities        — the "popular cities" grid,
 *            built dynamically from the LIVE restaurants: branch.city grouped +
 *            a DISTINCT-company count per city, top-N by count.
 *          • GET /api/v1/marketplace/demo-location — a TEMPORARY testing helper.
 *            Returns one deliverable restaurant's own coordinates so the tester
 *            can drop into a working delivery area with one tap (IP / browser
 *            geolocation needs HTTPS + a secure context, which isn't available
 *            in the current dev/demo setup). REMOVE once real geo is wired.
 *
 * Why:   The cities list used to be hard-coded in the EJS. The user asked for
 *        it to come from the database ("jitne restaurant return hote hain us ke
 *        hisaab se city aayegi, count bhi, top 6 hi").
 *
 * Source: `company` (marketplace-eligible) INNER JOIN `branch` (not deleted).
 *         Reuses M.eligibleCompanyScope / M.eligibleBranchScope so "which
 *         restaurants count" matches the home grid exactly.
 *
 * Used:  api/Routes/index.js →
 *          GET /api/v1/marketplace/cities?limit=
 *          GET /api/v1/marketplace/demo-location
 */

const H      = require('../../Helpers/helper');
const MSG    = require('../../Helpers/messages');
const { db } = require('../../config/db');
const M      = require('../../Helpers/marketplace');

/**
 * titleCase
 *
 * What:  "LONDON"/"london" → "London" so a city reads cleanly whatever case
 *        the merchant stored it in. Leaves already-mixed-case strings alone.
 * Type:  READ (pure).
 */
function titleCase(s) {
    const str = String(s || '').trim();
    if (str !== str.toUpperCase() && str !== str.toLowerCase()) { return str; }
    return str.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
}

/**
 * looksPostcode
 *
 * What:  Rough UK postcode / outward-code test ("AB56", "BB12", "SE1 8TG") so
 *        those chunks are skipped when we fall back to parsing a place name
 *        from a free-text address.
 * Type:  READ (pure).
 */
function looksPostcode(s) {
    const t = String(s || '').trim();
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]*(\s+\d[A-Za-z]{2})?$/.test(t) && t.length <= 8;
}

/**
 * deriveCity
 *
 * What:  Best-effort city/area for a branch. Prefers the real `branch.city`
 *        column; when that's empty (most of the live rows are), falls back to
 *        the LAST non-postcode chunk of `direction_address`
 *        ("1 Central Buildings, Padiham, Burnley, BB12" → "Burnley";
 *         "London Bridge" → "London Bridge"). Returns '' when nothing usable.
 * Why:   Only 1 live branch has `city` filled, so grouping on the column alone
 *        showed a single city. Deriving from the address surfaces the rest so
 *        the grid reflects all the live restaurants (per the user).
 * Type:  READ (pure).
 */
function deriveCity(city, address) {
    const c = String(city || '').trim();
    if (c) { return c; }
    const parts = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) { return ''; }
    const named = parts.filter(p => !looksPostcode(p));
    return (named.length ? named[named.length - 1] : parts[0]) || '';
}

/**
 * cities
 *
 * What:  Top cities by number of LIVE marketplace restaurants. Groups branches
 *        by a case-insensitive city key, counts DISTINCT companies per city
 *        (a brand with two branches in one city counts once), orders by that
 *        count DESC, and returns the top `limit` (default 6).
 * Type:  READ.
 *
 * Query params:
 *   limit?  — int 1..20 (default 6)
 *
 * Output: { cities: [ { name, count } ] }   (count = restaurant count, number)
 */
async function cities(req, res) {
    try {
        const limit = req.query.limit ? Math.min(20, Math.max(1, Number(req.query.limit))) : 6;

        // Pull every eligible branch's city + address, then aggregate in JS so
        // we can fall back to an address-derived place name when `city` is
        // empty. Count DISTINCT companies per city (a brand with two branches
        // in one city counts once).
        const rows = await db('company as c')
            .innerJoin('branch as b', 'b.company_id', 'c.id')
            .modify(M.eligibleCompanyScope, 'c')
            .modify(M.eligibleBranchScope, 'b')
            .select('c.id as company_id', 'b.city', 'b.direction_address as address');

        const byKey = new Map();   // lower(city) → { name, companies:Set }
        rows.forEach(r => {
            const name = titleCase(deriveCity(r.city, r.address));
            if (!name) { return; }
            const key = name.toLowerCase();
            if (!byKey.has(key)) { byKey.set(key, { name, companies: new Set() }); }
            byKey.get(key).companies.add(String(r.company_id));
        });

        const list = [...byKey.values()]
            .map(v => ({ name: v.name, count: v.companies.size }))
            .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
            .slice(0, limit);

        return H.successResponse(res, { cities: list });
    } catch (err) {
        H.log.error('marketplace.places.cities', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * demoLocation
 *
 * What:  TEMPORARY. Returns one deliverable restaurant's own coordinates so a
 *        tester can drop straight into a working delivery area (the user asked
 *        for a demo button because browser/IP geolocation needs HTTPS which the
 *        current setup lacks). Prefers a branch with delivery switched on
 *        (show_delivery_option <> 0); falls back to any eligible branch with
 *        valid coordinates so the button always returns something.
 * Type:  READ.
 * Output: { label, city, postcode, lat, lng }
 *
 * REMOVE this (route + button) once real geolocation is available.
 */
async function demoLocation(req, res) {
    try {
        // Builder factory — `deliveryOnly` adds the "delivery is ON" gate
        // (show_delivery_option !== 0, matching Helpers/storeHours.optionClosed).
        function candidates(deliveryOnly) {
            const qb = db('company as c')
                .innerJoin('branch as b', 'b.company_id', 'c.id')
                .modify(M.eligibleCompanyScope, 'c')
                .modify(M.eligibleBranchScope, 'b')
                .whereNotNull('b.direction_latitude')
                .whereNotNull('b.direction_longitude')
                .select(
                    'c.business_name',
                    'b.city',
                    'b.postcode',
                    'b.direction_address as address',
                    'b.direction_latitude  as lat',
                    'b.direction_longitude as lng',
                )
                .orderBy('c.id', 'asc')
                .limit(50);
            if (deliveryOnly) { qb.andWhere('b.show_delivery_option', 1); }
            return qb;
        }

        // Delivery-enabled first; fall back to any branch with coordinates.
        let rows = await candidates(true);
        if (!rows.length) { rows = await candidates(false); }

        // Coordinates can be stored as text (and the live data has a few junk
        // rows, e.g. lat/lng = 123). Coerce, skip null/zero pairs, and require
        // geographically-valid ranges so the picked location can never fail the
        // web's lat∈[-90,90] / lng∈[-180,180] save validation.
        const pick = rows
            .map(r => ({ r, lat: Number(r.lat), lng: Number(r.lng) }))
            .find(x => Number.isFinite(x.lat) && Number.isFinite(x.lng)
                && x.lat >= -90 && x.lat <= 90 && x.lng >= -180 && x.lng <= 180
                && (x.lat !== 0 || x.lng !== 0));

        if (!pick) {
            return H.errorResponse(res, 'No deliverable demo location is available yet.', 404);
        }

        const cityLabel = String(pick.r.city || '').trim();
        const addrFirst  = String(pick.r.address || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '';
        const label = cityLabel || addrFirst || String(pick.r.business_name || '').trim() || 'Demo location';

        return H.successResponse(res, {
            label:    label,
            city:     cityLabel || null,
            postcode: pick.r.postcode || null,
            lat:      pick.lat,
            lng:      pick.lng,
        });
    } catch (err) {
        H.log.error('marketplace.places.demoLocation', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { cities, demoLocation };
