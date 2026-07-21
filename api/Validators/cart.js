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
const C = require('./common');

const idRule = C.idRule;

const customerIdRule = idRule.required().messages({
    'any.required':       'Please sign in to use the cart.',
    'alternatives.match': 'Customer id is not valid.',
});

// Guest cart owner — a session token the web layer mints for visitors who
// aren't signed in. On the cart-BUILD endpoints (add / qty / remove / clear /
// set-mode / read) the cart may belong to EITHER a customer OR a guest, so
// customer_id becomes optional and guest_id is accepted; the controller
// (resolveOwner) still requires at least one. Mirrors legacy, which stores
// guest carts with user_id=0 keyed by localID. The CHECKOUT-stage endpoints
// (address / coupons / vouchers / loyalty / charity / place) stay
// login-required — their schemas keep customerIdRule.
const guestIdRule = Joi.string().trim().max(64).pattern(/^[A-Za-z0-9_]+$/).messages({
    'string.pattern.base': 'Guest id is not valid.',
});
const ownerCustomerIdRule = idRule.optional();

// Optional ACTIVE browse/header location — the area the customer picked at the
// top of the site. The web forwards it (from req.session.userLocation) so the
// cart's delivery address + the "delivers here?" check FOLLOW the header
// location, instead of silently falling back to the customer's default saved
// address. All optional; the controller ignores them when absent.
const browseLocationFields = {
    loc_postcode: Joi.string().trim().max(20).allow('', null),
    loc_label:    Joi.string().trim().max(200).allow('', null),
    loc_lat:      Joi.number().min(-90).max(90).allow(null, ''),
    loc_lng:      Joi.number().min(-180).max(180).allow(null, ''),
    // The header's Delivery/Pickup choice (2 = pickup, 3 = delivery). The cart
    // read syncs itself to this so the mode is the same on every screen.
    serve_type:   Joi.number().valid(2, 3).allow(null, ''),
};

// ── GET /customer/cart ─────────────────────────────────────────────
// Read the customer's open marketplace cart (any branch). No filtering
// other than identity — the helper resolves the cart itself.
const cartGetSchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
    ...browseLocationFields,
});

// ── POST /customer/cart/add ────────────────────────────────────────
// Add ONE product (with optional modifier picks + a remark) to the
// customer's open cart. branch_id + company_id are derived from the
// product server-side; the client never sends them (prevents a forged
// "add this product to a different restaurant's cart" attack).
const cartAddSchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
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
    // The customer's active order mode (header Delivery/Pickup toggle), so a
    // FRESH cart is created in the right mode: 2 = pickup/collection, 3 =
    // delivery (default). Only honoured when the cart is first created — it
    // stops the "doesn't deliver here" gate from firing on a Collection order.
    serve_type: Joi.number().valid(2, 3).default(3),
    ...browseLocationFields,
});

// ── POST /customer/cart/surprise-box ───────────────────────────────
// The "Too Good To Go" box. Keyed by COMPANY, not product_id: the box is
// configured on the `branch` row and has no `products` row at all, so
// /cart/add's product lookup can't reach it. serve_type is accepted (not
// forced to 2) so the pickup-only rule answers with legacy's real message
// instead of a bare schema rejection.
const cartSurpriseBoxSchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
    company_id:  idRule.required().messages({
        'any.required': 'A restaurant is required.',
    }),
    qty: Joi.number().integer().min(1).max(99).default(1)
        .messages({
            'number.min': 'Quantity must be at least 1.',
            'number.max': 'Quantity cannot exceed 99.',
        }),
    serve_type: Joi.number().valid(2, 3).optional(),   // 2 = pickup, 3 = delivery
    local_id:   Joi.string().trim().max(64).optional().allow('', null),
});

// ── POST /customer/cart/update-qty ─────────────────────────────────
// Set a line item's quantity to a specific value. qty=0 is rejected
// (clients should call /remove-item to delete a line instead).
const cartUpdateQtySchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
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
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
    item_id:     idRule.required().messages({
        'any.required': 'Cart item is required.',
    }),
});

// ── POST /customer/cart/clear ──────────────────────────────────────
// Close the customer's open cart (`is_open=0`). Identity is the only
// input — the open cart is resolved server-side.
const cartClearSchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
});

// ── POST /customer/cart/set-mode ───────────────────────────────────
// Switch the cart between Delivery (3) and Pickup (2). Recomputes the
// delivery fee server-side (pickup zeros it; delivery re-matches the
// saved postcode zone).
const cartSetModeSchema = Joi.object({
    customer_id: ownerCustomerIdRule,
    guest_id:    guestIdRule,
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

// ── POST /customer/cart/apply-voucher ──────────────────────────────
// Customer-specific reward voucher. Code is up to 10 chars (legacy
// customer_voucher.voucher_code max). Validation + discount math run in
// Helpers/vouchers.validate().
const cartApplyVoucherSchema = Joi.object({
    customer_id: customerIdRule,
    code:        Joi.string().trim().min(1).max(10).required()
        .messages({
            'string.empty': 'Enter a voucher code.',
            'string.max':   'Voucher code is too long.',
            'any.required': 'Enter a voucher code.',
        }),
});

// ── POST /customer/cart/remove-voucher ─────────────────────────────
const cartRemoveVoucherSchema = Joi.object({
    customer_id: customerIdRule,
});

// ── POST /customer/cart/apply-loyalty ──────────────────────────────
// Redeem loyalty cashback against the cart. The amount is the £ the
// customer wants to spend; the controller clamps it to maxRedeemable
// (balance / restaurant cap / sub-total), so we only bound it loosely here.
const cartApplyLoyaltySchema = Joi.object({
    customer_id: customerIdRule,
    amount: Joi.number().min(0).max(100000).required()
        .messages({
            'number.base':  'Enter a valid reward amount.',
            'number.min':   'Reward amount can\'t be negative.',
            'any.required': 'Enter a reward amount.',
        }),
});

// ── POST /customer/cart/remove-loyalty ─────────────────────────────
const cartRemoveLoyaltySchema = Joi.object({
    customer_id: customerIdRule,
});

// ── POST /customer/cart/set-charity ────────────────────────────────
// The customer's chosen charity contribution amount (No → 0, a % tier of
// sub-total, or a Custom £). The helper clamps + rounds; here we just
// bound it to a sane non-negative range.
const cartSetCharitySchema = Joi.object({
    customer_id:    customerIdRule,
    charity_amount: Joi.number().min(0).max(1000).required()
        .messages({
            'number.base': 'Enter a valid charity amount.',
            'number.min':  'Charity amount can\'t be negative.',
            'number.max':  'That charity amount is too large.',
            'any.required': 'Enter a charity amount.',
        }),
});

// ── POST /customer/cart/claim ──────────────────────────────────────
// Adopt a guest cart (user_id=0, keyed by localID=guest_id) into a
// just-signed-in customer's account. Called by the web layer right after
// login. Both ids required.
const cartClaimSchema = Joi.object({
    customer_id: customerIdRule,
    guest_id:    guestIdRule.required().messages({ 'any.required': 'Guest id is required.' }),
});

module.exports = {
    cartGetSchema,
    cartClaimSchema,
    cartAddSchema,
    cartSurpriseBoxSchema,
    cartUpdateQtySchema,
    cartRemoveItemSchema,
    cartClearSchema,
    cartSetModeSchema,
    cartSetAddressSchema,
    cartSetScheduleSchema,
    cartSetInstructionsSchema,
    cartApplyCouponSchema,
    cartRemoveCouponSchema,
    cartApplyVoucherSchema,
    cartRemoveVoucherSchema,
    cartApplyLoyaltySchema,
    cartRemoveLoyaltySchema,
    cartSetCharitySchema,
};
