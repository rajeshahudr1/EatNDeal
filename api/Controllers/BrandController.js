'use strict';

/**
 * Controllers/BrandController.js
 *
 * What:   Exposes the brand identity (name, logo URL, colours, support
 *         contacts) as a public read-only endpoint.
 * Why:    Single source of truth for brand info — the web PWA and the
 *         future Flutter app each fetch /brand once on splash and cache it.
 *         Changing config/brand.js (or the BRAND_* env vars) propagates
 *         to every client without any code change on the consumer side.
 * Type:   READ (no DB).
 * Inputs: none (public endpoint).
 * Output: 200 envelope with `data` = the frozen brand object.
 * Used:   GET /api/v1/brand — wired in Routes/index.js.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const H            = require('../Helpers/helper');
const MSG          = require('../Helpers/messages');
const { brand }    = require('../config/brand');

/**
 * get
 *
 * What:   Returns the current brand identity.
 * Why:    Web + app fetch this on splash. No auth — brand info is public.
 * Type:   READ.
 * Inputs: req, res (Express).
 * Output: 200 { status:200, show:false, msg:"success", data: { ...brand } }
 *         500 { status:500, show:true,  msg:"<unavailable>" }       (safety net)
 * Used:   GET /api/v1/brand.
 */
function get(req, res) {
    // config/brand.js builds + freezes the object at module load. If it ever
    // failed to construct, `brand` would be undefined — handle that gracefully
    // instead of throwing.
    if (!brand) {
        return H.errorResponse(res, MSG.brand.unavailable, 500);
    }
    return H.successResponse(res, brand);
}

module.exports = { get };
