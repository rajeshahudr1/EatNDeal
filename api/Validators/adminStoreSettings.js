'use strict';

/*
 * Validators/adminStoreSettings.js
 *
 * What:  Joi schema for the admin Store Settings save. The controller already
 *        coerces every field through a strict column whitelist (int01 / money /
 *        enums), so this schema is intentionally permissive — it only guards
 *        the few free-text-ish fields that benefit from a shape check and lets
 *        the rest through with .unknown(true).
 * Used:  api/Routes/index.js — POST /admin/store-settings.
 *
 * Change log:
 *   2026-06-09 — initial.
 */

const Joi = require('joi');

// Reusable, friendly-message field builders. Every editable column the form
// posts is validated server-side here; toggles / enums / select-driven fields
// (already coerced through the controller's strict whitelist) pass via
// .unknown(true). Empty strings are allowed everywhere optional.
const money = (label) => Joi.number().min(0).max(9999999).allow('', null).messages({
    'number.base': label + ' must be a number.',
    'number.min':  label + ' cannot be negative.',
    'number.max':  label + ' is too large.',
});
const pct = (label) => Joi.number().min(0).max(100).allow('', null).messages({
    'number.base': label + ' must be a number.',
    'number.min':  label + ' cannot be negative.',
    'number.max':  label + ' cannot be more than 100.',
});
const whole = (label) => Joi.number().integer().min(0).max(1000000).allow('', null).messages({
    'number.base':    label + ' must be a whole number.',
    'number.integer': label + ' must be a whole number.',
    'number.min':     label + ' cannot be negative.',
});
const text = (max, label) => Joi.string().max(max).allow('', null).messages({
    'string.max': label + ' is too long (max ' + max + ' characters).',
});
const timeRule = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).allow('', null).messages({
    'string.pattern.base': 'Enter a valid time (HH:MM).',
});

const storeSettingsSchema = Joi.object({
    company_id: Joi.number().integer().positive().optional().allow('', null),
    branch_id:  Joi.number().integer().positive().optional().allow('', null),
    // Contact + identity
    email: Joi.string().trim().email({ tlds: false }).max(255).optional().allow('', null).messages({
        'string.email': 'Enter a valid store email address.',
    }),
    contact_number: Joi.string().trim().pattern(/^[0-9+\-() ]{0,15}$/).allow('', null).messages({
        'string.pattern.base': 'Enter a valid contact number (digits only, max 15).',
    }),
    branch_info:           text(5000, 'Store information'),
    thirdparty_print_text: text(1000, 'Third-party print text'),
    // SEO
    page_title:            text(1000, 'Page title'),
    page_meta_keyword:     text(2000, 'Meta keywords'),
    page_meta_description: text(2000, 'Meta description'),
    // Upselling / labels
    upselling_msg:         text(1000, 'Upselling message'),
    offline_upselling_msg: text(1000, 'Offline upselling message'),
    third_party_label:     text(1000, 'Third-party label'),
    // Surprise box text
    saving_product_description: text(5000, 'Surprise box description'),
    about_surprise_box:         text(5000, 'About surprise box'),
    ingredients_allergens:      text(5000, 'Ingredients & allergens'),
    collection_instructions:    text(5000, 'Collection instructions'),
    // Money (£)
    service_charge_offline_order: money('Service charge'),
    offline_bag_charge:           money('Offline bag charge'),
    online_bag_charge:            money('Online bag charge'),
    price:                        money('Surprise box price'),
    discount_price:               money('Surprise box discount price'),
    // Percentages (0–100)
    fix_charity_percentage:          pct('Charity percentage'),
    third_party_percentage:          pct('Third-party percentage'),
    third_online_website_percentage: pct('Online website percentage'),
    // Whole-number quantities
    qty:                 whole('Surprise box quantity'),
    offline_per_bag_qty: whole('Items per bag (offline)'),
    online_per_bag_qty:  whole('Items per bag (online)'),
    // Times (HH:MM)
    start_time: timeRule,
    end_time:   timeRule,
}).unknown(true);

const storeScopeQuery = Joi.object({
    company_id: Joi.number().integer().positive().optional().allow('', null),
    branch_id:  Joi.number().integer().positive().optional().allow('', null),
});

// POST /admin/store-settings/website-status
const websiteStatusSchema = Joi.object({
    company_id:          Joi.number().integer().positive().optional().allow('', null),
    branch_id:           Joi.number().integer().positive().optional().allow('', null),
    status_mode:         Joi.string().valid('open', 'closed_for', 'closed_until').required(),
    closed_for_list:     Joi.string().valid('today', '30min', '1hours', '2hours', '3hours', '4hours').optional().allow('', null),
    closed_reopen_date:  Joi.string().optional().allow('', null),
    clossed_repoen_time: Joi.string().optional().allow('', null),
    clossed_text:        Joi.string().max(500).optional().allow('', null),
}).unknown(true);

// POST /admin/store-settings/tips  (replace-all; parallel arrays)
const tipsSaveSchema = Joi.object({
    company_id: Joi.number().integer().positive().optional().allow('', null),
    branch_id:  Joi.number().integer().positive().optional().allow('', null),
    tip_label:  Joi.any().optional(),
    tip_value:  Joi.any().optional(),
}).unknown(true);

// POST /admin/store-settings/advance  (one row)
const advanceSaveSchema = Joi.object({
    company_id:   Joi.number().integer().positive().optional().allow('', null),
    branch_id:    Joi.number().integer().positive().optional().allow('', null),
    id:           Joi.number().integer().positive().optional().allow('', null),
    order_type:   Joi.number().valid(1, 2).required(),
    service_type: Joi.number().valid(1, 4).required(),
    min:          Joi.number().min(0).required(),
    max:          Joi.number().min(0).required(),
    time:         Joi.number().integer().min(0).required(),
});

// POST /admin/store-settings/advance/delete
const advanceDeleteSchema = Joi.object({
    company_id: Joi.number().integer().positive().optional().allow('', null),
    id:         Joi.number().integer().positive().required(),
});

// POST /admin/store-settings/image  (filename(s) only — file written by admin)
const imageSaveSchema = Joi.object({
    company_id:     Joi.number().integer().positive().optional().allow('', null),
    branch_id:      Joi.number().integer().positive().optional().allow('', null),
    business_image: Joi.string().max(255).optional().allow('', null),
    discount_icon:  Joi.string().max(255).optional().allow('', null),
    surprise_image: Joi.string().max(255).optional().allow('', null),
}).unknown(true);

module.exports = {
    storeSettingsSchema, storeScopeQuery, websiteStatusSchema,
    tipsSaveSchema, advanceSaveSchema, advanceDeleteSchema, imageSaveSchema,
};
