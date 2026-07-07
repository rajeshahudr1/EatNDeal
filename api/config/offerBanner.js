'use strict';

/*
 * config/offerBanner.js
 *
 * Enum IDs for mp_offer_banner — content type + rule type + status are stored
 * and sent as INTEGER IDs (never strings), mirroring the Yii constants classes
 * common/constants/MpOfferBannerContentType + MpOfferBannerRuleType.
 *
 * See [[project-offer-banner]]: a banner stores a RULE; clicking it resolves
 * that rule LIVE against the discount/coupon data into a filtered restaurant
 * list. The "40% off" number is NOT stored on the banner — MIN_DISCOUNT reads
 * the max active % from `discounts` + percent `coupons` (via offers.js pct).
 */
module.exports = {
    // What the card shows (only one).
    TYPE: { TEXT: 1, IMAGE: 2 },

    // How the banner resolves to a set of restaurants when clicked. Each maps
    // onto a real offer type in the `discounts` / `coupons` data (discount_type
    // 1=percent, 2=amount, 3=item; coupons.for_item, coupons.free_delivery).
    RULE: {
        MIN_DISCOUNT:  1,   // "X% off or more"   → rule_value (percent); match pct >= value
        UPTO_DISCOUNT: 2,   // "Up to X% off"     → rule_value (percent); match 0 < pct <= value
        AMOUNT_OFF:    3,   // "£X off or more"   → rule_value (amount);  match amount >= value
        FREE_DELIVERY: 4,   // "Free delivery"    → coupons.free_delivery = 1
        FREE_ITEM:     5,   // "Free / item deal" → discounts type 3 OR coupons.for_item = 1
        COUPON_CODE:   6,   // a shared code      → rule_code
        ANY_OFFER:     7,   // "Offers near you"  → any active offer (existing offer=1 flag)
        CATEGORY:      8,   // a cuisine/category → category_id
        MANUAL_PICK:   9,   // super-admin hand-picks → mp_offer_banner_assign
        UPTO_AMOUNT:  10,   // "Up to £X off"     → rule_value (amount);  match 0 < amount <= value
    },

    // Row lifecycle (integer `status` column) — legacy convention:
    // 0 = In-Active, 1 = Active, 2 = Deleted (soft-delete).
    // Public reads only status = 1; admin lists hide status = 2.
    STATUS: { INACTIVE: 0, ACTIVE: 1, DELETED: 2 },
};
