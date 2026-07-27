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
const M       = require('../../Helpers/marketplace');
const Offers  = require('../../Helpers/offers');

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

/**
 * liveMatchFilter — drop banners whose RULE matches ZERO live restaurants.
 *
 * What:  A banner is only worth showing when clicking it would land on a
 *        non-empty restaurant grid. The rules resolve LIVE against the
 *        discounts / coupons data (see offers.offerSummaries — the same
 *        facets RestaurantsController filters by), so when the underlying
 *        offer is deleted or expires in the EPOS the banner silently
 *        disappears from the carousel too.
 * Why:   Restaurants delete offers from the EPOS; without this the
 *        super-admin banner kept showing and clicked through to an empty
 *        list ("banner me ek bhi offer nahi hai to nahi dikhna chahiye").
 * Type:  READ (3-4 batched queries regardless of banner count).
 */
async function liveMatchFilter(rows) {
    if (!rows.length) { return rows; }

    // A literal link_url override bypasses rule resolution entirely —
    // we can't verify an arbitrary target, so those banners always show.
    const ruled = rows.filter((r) => !String(r.link_url || '').trim());
    if (!ruled.length) { return rows; }

    // Eligible marketplace restaurants, one (lowest-id) branch each —
    // the same scope + branch pick the restaurant grid uses.
    const cos = await db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .modify(M.eligibleCompanyScope, 'c')
        .modify(M.eligibleBranchScope,  'b')
        .select('c.id as company_id', 'b.id as branch_id')
        .orderBy([{ column: 'c.id', order: 'asc' }, { column: 'b.id', order: 'asc' }]);
    const seen = new Set();
    const pairs = [];
    cos.forEach((r) => {
        if (seen.has(r.company_id)) { return; }
        seen.add(r.company_id);
        pairs.push({ companyId: r.company_id, branchId: r.branch_id });
    });

    // Live offer facets per company (pct / amount / free-delivery / item).
    const sums = pairs.length ? await Offers.offerSummaries(pairs) : {};
    const facets = Object.keys(sums).map((k) => sums[k]);
    const anyOffer = facets.some((f) => f.count > 0);

    // Batched lookups for the rule types the facets can't answer.
    const branchIds  = pairs.map((p) => p.branchId);
    const companyIds = pairs.map((p) => p.companyId);
    const codes   = [...new Set(ruled.filter((r) => Number(r.rule_type) === OB.RULE.COUPON_CODE)
        .map((r) => String(r.rule_code || '').trim().toUpperCase()).filter(Boolean))];
    const catIds  = [...new Set(ruled.filter((r) => Number(r.rule_type) === OB.RULE.CATEGORY)
        .map((r) => Number(r.category_id) || 0).filter(Boolean))];
    const pickIds = ruled.filter((r) => Number(r.rule_type) === OB.RULE.MANUAL_PICK).map((r) => Number(r.id));

    const [liveCodes, liveCats, livePicks] = await Promise.all([
        (codes.length && branchIds.length)
            ? db('coupons').whereIn('branch_id', branchIds)
                .whereIn(db.raw('UPPER(code)'), codes)
                .andWhere('is_active', 1).whereIn('platform', [1, 2])
                .andWhere(function () { this.whereNull('expiry_date').orWhere('expiry_date', '>=', db.raw('CURRENT_DATE')); })
                .distinct(db.raw('UPPER(code) as code'))
            : Promise.resolve([]),
        (catIds.length && companyIds.length)
            ? db('mp_marketplace_category_assign').whereIn('company_id', companyIds)
                .whereIn('category_id', catIds).distinct('category_id')
            : Promise.resolve([]),
        (pickIds.length && companyIds.length)
            ? db('mp_offer_banner_assign').whereIn('company_id', companyIds)
                .whereIn('offer_banner_id', pickIds).distinct('offer_banner_id')
            : Promise.resolve([]),
    ]);
    const codeSet = new Set(liveCodes.map((r) => String(r.code)));
    const catSet  = new Set(liveCats.map((r) => Number(r.category_id)));
    const pickSet = new Set(livePicks.map((r) => Number(r.offer_banner_id)));

    // Mirrors RestaurantsController's application-side rule filters:
    // max drives "X or more", min drives "up to X".
    function matches(row) {
        const rule = Number(row.rule_type) || OB.RULE.MIN_DISCOUNT;
        const val  = row.rule_value == null ? 0 : Number(row.rule_value);
        switch (rule) {
            case OB.RULE.UPTO_DISCOUNT:
                return val > 0 ? facets.some((f) => f.pctMin > 0 && f.pctMin <= val) : anyOffer;
            case OB.RULE.AMOUNT_OFF:
                return val > 0 ? facets.some((f) => f.amount >= val) : anyOffer;
            case OB.RULE.UPTO_AMOUNT:
                return val > 0 ? facets.some((f) => f.amountMin > 0 && f.amountMin <= val) : anyOffer;
            case OB.RULE.FREE_DELIVERY:
                return facets.some((f) => f.freeDelivery);
            case OB.RULE.FREE_ITEM:
                return facets.some((f) => f.hasItem);
            case OB.RULE.COUPON_CODE: {
                const code = String(row.rule_code || '').trim().toUpperCase();
                return code ? codeSet.has(code) : anyOffer;
            }
            case OB.RULE.ANY_OFFER:
                return anyOffer;
            case OB.RULE.CATEGORY: {
                const cat = Number(row.category_id) || 0;
                return cat ? catSet.has(cat) : anyOffer;
            }
            case OB.RULE.MANUAL_PICK:
                return pickSet.has(Number(row.id));
            case OB.RULE.MIN_DISCOUNT:
            default:
                return val > 0 ? facets.some((f) => f.pct >= val) : anyOffer;
        }
    }

    return rows.filter((r) => String(r.link_url || '').trim() || matches(r));
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

        // Hide banners whose rule matches no live restaurant/offer any more
        // (e.g. the discount was deleted in the EPOS after the banner was made).
        const live = await liveMatchFilter(rows);

        const banners = live.map((row) => {
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
