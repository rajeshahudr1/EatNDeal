'use strict';

/*
 * Validators/cart.js
 *
 * What:  Joi schemas for the marketplace cart endpoints. Each schema is
 *        narrow on purpose — only the fields THAT endpoint accepts; the
 *        cart helper layer (Helpers/cart.js) does its own row-level
 *        validation downstream, so this layer just guards against junk
 *        input (wrong types, missing customer_id, etc.).
 *
 * Auth model: Phase-1 — the web layer supplies customer_id from
 *        req.session.user.id. All cart endpoints are login-required, so
 *        every schema requires customer_id.
 */

const Joi = require('joi');

const idRule = Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().pattern(/^[0-9]+$/));

const customerIdRule = idRule.required().messages({
    'any.required':       'Please sign in to use the cart.',
    'alternatives.match': 'Customer id is not valid.',
});

// ── GET /customer/cart ─────────────────────────────────────────────
// Read the customer's open marketplace cart (any branch). No filtering
// other than identity — the helper resolves the cart itself.
const cartGetSchema = Joi.object({
    customer_id: customerIdRule,
});

// ── POST /customer/cart/add ────────────────────────────────────────
// Add ONE product (with optional modifier picks + a remark) to the
// customer's open cart. branch_id + company_id are derived from the
// product server-side; the client never sends them (prevents a forged
// "add this product to a different restaurant's cart" attack).
const cartAddSchema = Joi.object({
    customer_id: customerIdRule,
    product_id:  idRule.required().messages({
        'any.required': 'A product is required.',
    }),
    qty: Joi.number().integer().min(1).max(99).default(1)
        .messages({
            'number.min': 'Quantity must be at least 1.',
            'number.max': 'Quantity cannot exceed 99.',
        }),
    options: Joi.array().items(Joi.object({
        groupId:  idRule.required(),
        optionId: idRule.required(),
    })).default([]),
    remark: Joi.string().trim().max(120).allow('', null)
        .messages({ 'string.max': 'Special instructions are too long.' }),
    // When true, an existing open cart for a DIFFERENT branch will be
    // closed before the new item is added. The client only sets this
    // after asking the customer to confirm via a dialog.
    replace_cart: Joi.boolean().truthy(1, '1', 'true').falsy(0, '0', 'false', '').default(false),
});

// ── POST /customer/cart/update-qty ─────────────────────────────────
// Set a line item's quantity to a specific value. qty=0 is rejected
// (clients should call /remove-item to delete a line instead).
const cartUpdateQtySchema = Joi.object({
    customer_id: customerIdRule,
    item_id:     idRule.required().messages({
        'any.required': 'Cart item is required.',
    }),
    qty: Joi.number().integer().min(1).max(99).required()
        .messages({
            'number.min':   'Quantity must be at least 1.',
            'number.max':   'Quantity cannot exceed 99.',
            'any.required': 'Quantity is required.',
        }),
});

// ── POST /customer/cart/remove-item ────────────────────────────────
// Soft-delete one line item.
const cartRemoveItemSchema = Joi.object({
    customer_id: customerIdRule,
    item_id:     idRule.required().messages({
        'any.required': 'Cart item is required.',
    }),
});

// ── POST /customer/cart/clear ──────────────────────────────────────
// Close the customer's open cart (`is_open=0`). Identity is the only
// input — the open cart is resolved server-side.
const cartClearSchema = Joi.object({
    customer_id: customerIdRule,
});

// ── POST /customer/cart/set-mode ───────────────────────────────────
// Switch the cart between Delivery (3) and Pickup (2). Recomputes the
// delivery fee server-side (pickup zeros it; delivery re-matches the
// saved postcode zone).
const cartSetModeSchema = Joi.object({
    customer_id: customerIdRule,
    serve_type:  Joi.number().integer().valid(2, 3).required()
        .messages({
            'any.only':     'Mode must be Delivery or Pickup.',
            'any.required': 'Mode is required.',
        }),
});

// ── POST /customer/cart/set-address ────────────────────────────────
// Attach a saved customer_address to the cart. Server verifies the row
// belongs to this customer, then re-resolves the delivery zone for the
// new postcode and updates the cart's delivery_fees.
const cartSetAddressSchema = Joi.object({
    customer_id: customerIdRule,
    address_id:  idRule.required().messages({
        'any.required': 'Address is required.',
    }),
});

// ── POST /customer/cart/apply-coupon ───────────────────────────────
// Apply a promo code to the customer's open cart. The code is validated
// server-side via Helpers/coupons.validate() — eligibility rules + the
// discount amount are computed there.
const cartApplyCouponSchema = Joi.object({
    customer_id: customerIdRule,
    code:        Joi.string().trim().min(1).max(40).required()
        .messages({
            'string.empty': 'Enter a coupon code.',
            'string.max':   'Coupon code is too long.',
            'any.required': 'Enter a coupon code.',
        }),
});

// ── POST /customer/cart/remove-coupon ──────────────────────────────
// Wipes the applied coupon + restores any free-delivery override.
const cartRemoveCouponSchema = Joi.object({
    customer_id: customerIdRule,
});

// ── POST /customer/cart/set-schedule ───────────────────────────────
// Toggle "schedule for later" on the cart.
//   is_pre_order = true  → scheduled_at must be an ISO datetime
//                          (any parseable form is accepted; the
//                          controller verifies it's in the future).
//   is_pre_order = false → scheduled_at ignored; clears the timestamp.
const cartSetScheduleSchema = Joi.object({
    customer_id:  customerIdRule,
    is_pre_order: Joi.boolean().truthy(1, '1', 'true').falsy(0, '0', 'false', '').required(),
    scheduled_at: Joi.string().trim().max(40).allow('', null),
});

// ── POST /customer/cart/set-instructions ───────────────────────────
// Drop-off preset (closed set, mirrors Cart.DROP_OFF_OPTIONS) + an
// optional free-text note. Either may be empty (clears the column).
const cartSetInstructionsSchema = Joi.object({
    customer_id:    customerIdRule,
    drop_off_option: Joi.string().trim()
        .valid('hand_to_me', 'meet_at_door', 'meet_outside', 'meet_reception', 'leave_at_door')
        .allow('', null)
        .messages({ 'any.only': 'Pick a valid drop-off option.' }),
    instructions:   Joi.string().trim().max(200).allow('', null)
        .messages({ 'string.max': 'Delivery instructions are too long.' }),
});

module.exports = {
    cartGetSchema,
    cartAddSchema,
    cartUpdateQtySchema,
    cartRemoveItemSchema,
    cartClearSchema,
    cartSetModeSchema,
    cartSetAddressSchema,
    cartSetScheduleSchema,
    cartSetInstructionsSchema,
    cartApplyCouponSchema,
    cartRemoveCouponSchema,
};
