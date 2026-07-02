'use strict';

/*
 * Helpers/communityScope.js — location scoping for community USER groups.
 *
 * A user-group covers one or more points, each with a radius (km). A customer
 * sees the group only if their location is inside ANY of the group's radii.
 * A group with NO locations = all-areas (global) → visible to everyone.
 * Restaurant groups are not location-scoped (handled by company_id elsewhere).
 *
 * Reuses the haversine in ./distance (kmBetween).
 */

const { kmBetween } = require('./distance');
const CC = require('../config/community');

/**
 * withinAnyLocation
 *
 * What:  True if (custLat, custLng) is within radius_km of ANY of the group's
 *        location points. Empty/no locations → true (global group). Missing
 *        customer coords → only global groups pass (returns false here).
 * Type:  READ (pure).
 * Inputs: custLat, custLng (number|string); locations [{lat, lng, radius_km}].
 * Output: boolean.
 */
function withinAnyLocation(custLat, custLng, locations) {
    const locs = Array.isArray(locations) ? locations : [];
    if (!locs.length) { return true; }   // no locations configured = all areas
    if (custLat == null || custLng == null || custLat === '' || custLng === '') { return false; }
    for (let i = 0; i < locs.length; i++) {
        const l = locs[i] || {};
        const km = kmBetween(custLat, custLng, l.lat, l.lng);
        if (km == null) { continue; }
        const r = Number(l.radius_km) > 0 ? Number(l.radius_km) : CC.DEFAULT_RADIUS_KM;
        if (km <= r) { return true; }
    }
    return false;
}

module.exports = { withinAnyLocation };
