'use strict';

/*
 * Validators/adminLoyalty.js
 *
 * What:  Joi schemas for the admin loyalty management endpoints. Every write
 *        schema permits an optional company_id (a super admin's selector value
 *        rides in the body/query; Helpers/adminScope decides whether to trust
 *        it). Field shapes mirror the legacy admin forms.
 * Why:   Coding-Conventions rule #3 — server-side validation on every input.
 * Used:  api/Routes/index.js — wraps each /admin/loyalty/* route.
 *
 * Change log:
 *   2026-06-09 — initial (cashback rules + global config + toggle + scope query).
 */

const Joi = require('joi');

// Optional company id (super-admin selector). Ignored for company logins.
//
// min(0), NOT positive(): 0 is the MARKETPLACE's own loyalty programme
// (EatNDeal itself — no restaurant owns it) and is a perfectly valid scope.
// `positive()` rejected it with '"company_id" must be a positive number', so
// EVERY loyalty screen 422'd at scope 0 and the console showed a bare
// "Could not load loyalty configuration" — the page asks ~9 endpoints and only
// reports failure when all of them fall over, which hid the real reason.
// Same 0-is-falsy trap as Helpers/adminScope (`companyId > 0`) and
// Middlewares/companyContext (`sel && …`); this was the third layer.
const companyIdOpt = Joi.number().integer().min(0).optional().allow('', null);

// Query schema for GET screens — just the optional company_id.
const scopeQuerySchema = Joi.object({
    company_id: companyIdOpt,
});

const money = (label) => Joi.number().min(0).max(1000000).required().messages({
    'number.base': `${label} must be a number.`,
    'number.min':  `${label} can’t be negative.`,
    'any.required': `${label} is required.`,
});

// POST /admin/loyalty/cashback  (add / edit one rule)
const cashbackRowSchema = Joi.object({
    company_id:       companyIdOpt,
    id:               Joi.number().integer().positive().optional().allow('', null),
    min_order_amount: money('Minimum order'),
    cashback:         money('Cashback'),
    value_type:       Joi.string().valid('£', '%').default('%'),
    tier_type:        Joi.string().valid('bronze', 'silver', 'gold').optional().allow('', null),
    apply_on:         Joi.number().integer().valid(1, 2, 3).default(1),
    order_count:      Joi.number().integer().min(0).max(999).default(5),
});

// POST /admin/loyalty/cashback/toggle
const toggleSchema = Joi.object({
    company_id: companyIdOpt,
    status:     Joi.alternatives(Joi.number().valid(1, 2), Joi.boolean(), Joi.string().valid('1', '2', 'true', 'false')).required(),
});

// POST /admin/loyalty/config  (global company_loyalty knobs)
const configSchema = Joi.object({
    company_id:           companyIdOpt,
    loyalty_status:       Joi.number().valid(1, 2).optional().allow('', null),
    expiry_duration_days: Joi.number().integer().min(0).max(3650).required(),
    notify_before_days:   Joi.number().integer().min(0).max(365).required(),
    use_max_cashback:     money('Max redeemable'),
    cash_king:            money('Cash king %'),
    collection_cashback:  money('Collection cashback'),
});

// POST /admin/loyalty/company-config  (company-level commission + phone orders)
const companyConfigSchema = Joi.object({
    company_id:                 companyIdOpt,
    loyalty_commission:         money('Commission'),
    enable_loyalty_phone_order: Joi.any().optional(),
});

// POST /admin/loyalty/tiers  (upsert bronze/silver/gold at once)
const tiersSchema = Joi.object({
    company_id:        companyIdOpt,
    bronze_min_amount: money('Bronze min'),
    bronze_max_amount: money('Bronze max'),
    bronze_free:       Joi.any().optional(),
    silver_min_amount: money('Silver min'),
    silver_max_amount: money('Silver max'),
    silver_free:       Joi.any().optional(),
    gold_min_amount:   money('Gold min'),
    gold_max_amount:   money('Gold max'),
    gold_free:         Joi.any().optional(),
});

// POST /admin/loyalty/referral  (single referral config)
const referralSchema = Joi.object({
    company_id:        companyIdOpt,
    value_type:        Joi.string().valid('£', '%').default('£'),
    referrer_cashback: money('Referrer reward'),
    referee_cashback:  money('Friend reward'),
    trigger:           Joi.number().valid(1, 2).default(2),
});

// POST /admin/loyalty/streak  (add / edit a streak or milestone row)
const streakSchema = Joi.object({
    company_id:       companyIdOpt,
    id:               Joi.number().integer().positive().optional().allow('', null),
    order_count:      Joi.number().integer().min(1).max(999).required(),
    type:             Joi.number().valid(1, 2).default(1),           // 1=streak, 2=milestone
    duration_type:    Joi.number().valid(1, 2).default(1),           // 1=weekly, 2=monthly
    value_type:       Joi.string().valid('£', '%').default('£'),
    cashback:         money('Reward'),
    min_order_amount: Joi.number().min(0).max(1000000).default(0),
});

// POST /admin/loyalty/challenges  (upsert all 5 smart-campaign types)
const campaignFields = { company_id: companyIdOpt };
['top_spenders', 'most_referrals', 'most_orders', 'most_reviews', 'inactive'].forEach((t) => {
    campaignFields[t + '_target']   = Joi.number().integer().min(0).max(1000000).default(0);
    campaignFields[t + '_cashback'] = Joi.number().min(0).max(1000000).default(0);
    campaignFields[t + '_vt']       = Joi.string().valid('£', '%').default('£');
});
const challengesSchema = Joi.object(campaignFields);

// POST /admin/loyalty/events  (upsert the 3 event types)
const eventFields = { company_id: companyIdOpt };
[1, 2, 3].forEach((t) => {
    eventFields['event_' + t + '_cashback'] = Joi.number().min(0).max(1000000).default(0);
    eventFields['event_' + t + '_vt']       = Joi.string().valid('£', '%').default('£');
});
const eventsSchema = Joi.object(eventFields);

// GET /admin/loyalty/review-claims  (list filters)
const reviewListSchema = Joi.object({
    company_id: companyIdOpt,
    status:     Joi.string().valid('pending', 'approved', 'rejected').optional().allow('', null),
    date_from:  Joi.string().isoDate().optional().allow('', null),
    date_to:    Joi.string().isoDate().optional().allow('', null),
    q:          Joi.string().max(60).optional().allow('', null),
});

// POST /admin/loyalty/review-claims/approve
const reviewApproveSchema = Joi.object({
    company_id: companyIdOpt,
    id:         Joi.number().integer().positive().required(),
});

// POST /admin/loyalty/review-claims/reject
const reviewRejectSchema = Joi.object({
    company_id:    companyIdOpt,
    id:            Joi.number().integer().positive().required(),
    reject_reason: Joi.string().trim().min(2).max(500).required().messages({
        'string.empty': 'A reason is required to reject a claim.',
        'any.required': 'A reason is required to reject a claim.',
    }),
});

// POST /admin/reviews — the super admin posts a MARKETPLACE review by hand.
// Same 3 inputs as the legacy POS modal (review-rating/index.php:210-243), but
// legacy validates customer_name on the CLIENT ONLY and casts rating with (int)
// and no range check — so a direct POST there banks a nameless review, or a
// rating of 99 that skews the public average for good. Both are checked here.
// Messages match the legacy toasts so the wording is unchanged for the user.
const reviewRatingSaveSchema = Joi.object({
    customer_name: Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Please enter customer name',
        'any.required': 'Please enter customer name',
    }),
    review: Joi.string().trim().min(1).max(2000).required().messages({
        'string.empty': 'Review cannot be empty',
        'any.required': 'Review cannot be empty',
    }),
    rating: Joi.number().integer().min(1).max(5).required().messages({
        'number.base': 'Please choose a rating between 1 and 5 stars',
        'number.min':  'Please choose a rating between 1 and 5 stars',
        'number.max':  'Please choose a rating between 1 and 5 stars',
        'any.required': 'Please choose a rating between 1 and 5 stars',
    }),
});

// POST /admin/reviews/reply — public reply + the Publish Online toggle. Both
// optional: the page saves either through this one endpoint, like legacy
// update-reply (which writes exactly these two fields and nothing else).
const reviewRatingReplySchema = Joi.object({
    id:             Joi.number().integer().positive().required(),
    review_reply:   Joi.string().trim().max(2000).optional().allow('', null),
    publish_online: Joi.alternatives()
        .try(Joi.boolean(), Joi.number().valid(0, 1), Joi.string().valid('0', '1', 'on'))
        .optional(),
});

// POST /admin/loyalty/special-offer  (add / edit one date-based offer)
const specialOfferSchema = Joi.object({
    company_id: companyIdOpt,
    id:         Joi.number().integer().positive().optional().allow('', null),
    value_type: Joi.string().valid('£', '%').default('£'),
    cashback:   money('Cashback'),
    offer_date: Joi.string().isoDate().optional().allow('', null).messages({
        'string.isoDate': 'Enter a valid offer date.',
    }),
});

// POST /admin/loyalty/review-rewards  (upsert the 8 review/share types; £ only)
const reviewRewardFields = { company_id: companyIdOpt };
[1, 2, 3, 4, 5, 6, 7, 8].forEach((t) => {
    reviewRewardFields['review_' + t + '_cashback'] = Joi.number().min(0).max(1000000).default(0);
});
const reviewRewardsSchema = Joi.object(reviewRewardFields);

// POST /admin/loyalty/product-cashback  (add / edit one rule + its products)
const productCashbackSchema = Joi.object({
    company_id:  companyIdOpt,
    id:          Joi.number().integer().positive().optional().allow('', null),
    cashback:    money('Cashback'),
    // product_ids[] — a single checkbox arrives as one value; .single() wraps it.
    product_ids: Joi.array().items(Joi.number().integer().positive()).single().default([]),
});

// POST /admin/loyalty/bogof  (add / edit one Buy X Get Y offer)
const bogofSchema = Joi.object({
    company_id:   companyIdOpt,
    id:           Joi.number().integer().positive().optional().allow('', null),
    apply_on:     Joi.number().valid(1, 2).default(1),     // 1=Product, 2=Category
    buy_quantity: Joi.number().integer().min(1).max(999).default(1),
    get_quantity: Joi.number().integer().min(1).max(999).default(1),
    product_ids:  Joi.array().items(Joi.number().integer().positive()).single().default([]),
    category_ids: Joi.array().items(Joi.number().integer().positive()).single().default([]),
});

// POST /admin/loyalty/cms-pages  (upsert one review CMS page by slug)
const cmsPageSchema = Joi.object({
    company_id:       companyIdOpt,
    review_type_slug: Joi.string().max(100).required(),
    title:            Joi.string().trim().max(255).required().messages({
        'string.empty': 'A title is required.',
        'any.required': 'A title is required.',
    }),
    description:      Joi.string().allow('', null).max(20000),
    screenshot:       Joi.string().max(255).allow('', null),
});

module.exports = {
    scopeQuerySchema,
    cashbackRowSchema,
    toggleSchema,
    configSchema,
    companyConfigSchema,
    tiersSchema,
    referralSchema,
    streakSchema,
    challengesSchema,
    eventsSchema,
    reviewListSchema,
    reviewRatingSaveSchema,
    reviewRatingReplySchema,
    reviewApproveSchema,
    reviewRejectSchema,
    specialOfferSchema,
    reviewRewardsSchema,
    productCashbackSchema,
    bogofSchema,
    cmsPageSchema,
};
