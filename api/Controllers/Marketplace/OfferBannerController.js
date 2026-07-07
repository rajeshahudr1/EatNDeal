'use strict';

/*
 * Controllers/Marketplace/OfferBannerController.js
 *
 * What:  The customer-facing read of the super-admin OFFER BANNER carousel
 *        (mp_offer_banner) shown on the marketplace home.
 *          GET /marketplace/offer-banner → { banners: [ {...} ] }
 *
 *        Each banner carries a resolved `href` — the click target that opens a
 *        filtered restaurant grid of the restaurants that actually match the
 *        banner's RULE. Resolution reuses the existing restaurant-list filters
 *        (see Marketplace/RestaurantsController: offer / min_discount / coupon /
 *        category / offer_banner), so NO extra "resolve" round-trip is needed —
 *        the href just navigates to /?view=restaurants&<filter>.
 * Type:  READ (mp_offer_banner). Only status = ACTIVE rows, in sort_order.
 * Used:  api/Routes/index.js — GET /marketplace/offer-banner (public).
 */

const H       = require('../../Helpers/helper');
const MSG     = require('../../Helpers/messages');
const { db }  = require('../../config/db');
const OB      = require('../../config/offerBanner');   // TYPE / RULE / STATUS enum IDs

const T = 'mp_offer_banner';

// Table-exists guard (cached) — degrade to "no banners" before the migration.
let _ready = null;
async function ready() {
    if (_ready !== null) { return _ready; }
    try { const r = await db.raw("select to_regclass('public.mp_offer_banner') as t"); _ready = !!((r.rows || r)[0] || {}).t; }
    catch (e) { _ready = false; }
    return _ready;
}

function imageUrl(file) {
    const f = String(file || '').trim();
    return f ? H.mediaUrl(f) : '';
}

/**
 * buildHref — turn a banner's rule into the restaurant-grid URL it links to.
 * A literal link_url override always wins. Everything else lands on the
 * existing paginated grid (/?view=restaurants) with the matching filter param.
 */
function buildHref(row) {
    const override = String(row.link_url || '').trim();
    if (override) { return override; }

    const ruleType = Number(row.rule_type) || OB.RULE.MIN_DISCOUNT;
    const val = row.rule_value == null ? 0 : Number(row.rule_value);   // % for 1/2, £ for 3
    const base = '/?view=restaurants';

    switch (ruleType) {
        case OB.RULE.UPTO_DISCOUNT:
            return val > 0 ? base + '&upto_discount=' + val : base + '&offer=1';
        case OB.RULE.AMOUNT_OFF:
            return val > 0 ? base + '&amount_off=' + val : base + '&offer=1';
        case OB.RULE.UPTO_AMOUNT:
            return val > 0 ? base + '&upto_amount=' + val : base + '&offer=1';
        case OB.RULE.FREE_DELIVERY:
            return base + '&free_delivery=1';
        case OB.RULE.FREE_ITEM:
            return base + '&free_item=1';
        case OB.RULE.COUPON_CODE: {
            const code = String(row.rule_code || '').trim();
            return code ? base + '&coupon=' + encodeURIComponent(code) : base + '&offer=1';
        }
        case OB.RULE.ANY_OFFER:
            return base + '&offer=1';
        case OB.RULE.CATEGORY: {
            const cat = Number(row.category_id) || 0;
            return cat ? base + '&category=' + cat : base + '&offer=1';
        }
        case OB.RULE.MANUAL_PICK:
            return base + '&offer_banner=' + Number(row.id);
        case OB.RULE.MIN_DISCOUNT:
        default:
            return val > 0 ? base + '&min_discount=' + val : base + '&offer=1';
    }
}

/** list — GET /marketplace/offer-banner — the active carousel for the home page. */
async function list(req, res) {
    try {
        if (!(await ready())) { return H.successResponse(res, { banners: [] }); }

        const rows = await db(T)
            .where('status', OB.STATUS.ACTIVE)
            .orderBy('sort_order', 'asc').orderBy('id', 'asc')
            .select('id', 'title', 'subtitle', 'image', 'content_type', 'rule_type',
                    'rule_value', 'rule_code', 'category_id', 'link_url');

        const banners = rows.map((row) => {
            const type = Number(row.content_type) === OB.TYPE.TEXT ? OB.TYPE.TEXT : OB.TYPE.IMAGE;
            const imgUrl = type === OB.TYPE.IMAGE ? imageUrl(row.image) : '';
            const title = String(row.title || '').trim();
            const subtitle = String(row.subtitle || '').trim();
            return {
                id:        Number(row.id),
                type,
                title,
                subtitle,
                image_url: imgUrl,
                rule_type: Number(row.rule_type) || OB.RULE.MIN_DISCOUNT,
                href:      buildHref(row),
            };
        }).filter((b) => {
            // Drop banners with nothing to render (image mode with no image, or
            // text mode with no title/subtitle) — same guard as the welcome banner.
            if (b.type === OB.TYPE.IMAGE) { return !!b.image_url; }
            return !!(b.title || b.subtitle);
        });

        return H.successResponse(res, { banners });
    } catch (err) {
        H.log.error('offerBanner.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, buildHref };
