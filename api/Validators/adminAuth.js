'use strict';

/*
 * Validators/adminAuth.js
 *
 * What:  Joi schemas for the admin console auth endpoints —
 *          POST /api/v1/admin/auth/login
 *          POST /api/v1/admin/auth/forgot-password
 *          POST /api/v1/admin/auth/reset-password
 *
 * Why:   Coding-Conventions rule #3 — every input the API accepts is
 *        validated server-side, mirroring the admin layer's client checks.
 *
 * Used:  api/Routes/index.js — wraps each /admin/auth/* route via
 *        Middlewares/validate.
 *
 * Change log:
 *   2026-06-09 — initial (login + forgot-password + reset-password).
 */

const Joi = require('joi');

const emailRule = Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: false })
    .max(150)
    .required()
    .messages({
        'string.empty':  'Email is required.',
        'string.email':  'Enter a valid email address.',
        'any.required':  'Email is required.',
    });

const passwordRule = Joi.string()
    .min(6)
    .max(200)
    .required()
    .messages({
        'string.empty': 'Password is required.',
        'string.min':   'Password must be at least 6 characters.',
        'any.required': 'Password is required.',
    });

// POST /admin/auth/login
const adminLoginSchema = Joi.object({
    email:    emailRule,
    password: passwordRule,
});

// POST /admin/auth/forgot-password
const adminForgotSchema = Joi.object({
    email: emailRule,
});

// POST /admin/auth/reset-password
const adminResetSchema = Joi.object({
    token: Joi.string().trim().min(10).max(200).required().messages({
        'string.empty': 'The reset token is missing.',
        'any.required': 'The reset token is missing.',
    }),
    password: passwordRule,
});

// POST /admin/auth/profile  (My Profile — name, email + the personal-details
// fields ported from the legacy pos/personal-details/update screen). Which
// fields actually apply depends on the account: a COMPANY login edits
// company.{mobile,pin}; a USER/staff login edits user.{contact_no,address_1,
// address_2,postcode,city,pin}. All are optional here — the controller stores
// only the ones that belong to the signed-in account's table.
const contactRule = Joi.string().trim().pattern(/^[0-9]{0,15}$/).allow('', null).messages({
    'string.pattern.base': 'Contact number must be digits only (max 15).',
});
const adminProfileSchema = Joi.object({
    first_name:    Joi.string().trim().max(80).allow('', null),
    last_name:     Joi.string().trim().max(80).allow('', null),
    business_name: Joi.string().trim().max(150).allow('', null),
    email:         emailRule,
    mobile:        contactRule,        // company login → company.mobile
    contact_no:    contactRule,        // user/staff login → user.contact_no
    pin:           Joi.string().trim().pattern(/^[0-9]{4}$/).allow('', null).messages({
        'string.pattern.base': 'PIN must be exactly 4 digits.',
    }),
    address_1:     Joi.string().trim().max(255).allow('', null),
    address_2:     Joi.string().trim().max(255).allow('', null),
    postcode:      Joi.string().trim().max(20).allow('', null),
    city:          Joi.string().trim().max(100).allow('', null),
});

// POST /admin/auth/change-password
const adminChangePasswordSchema = Joi.object({
    current_password: Joi.string().required().messages({
        'string.empty': 'Enter your current password.',
        'any.required': 'Enter your current password.',
    }),
    new_password: Joi.string().min(6).max(200).required().messages({
        'string.empty': 'Enter a new password.',
        'string.min':   'New password must be at least 6 characters.',
        'any.required': 'Enter a new password.',
    }),
    confirm_password: Joi.string().valid(Joi.ref('new_password')).required().messages({
        'any.only':     'The passwords don’t match.',
        'string.empty': 'Confirm your new password.',
        'any.required': 'Confirm your new password.',
    }),
});

module.exports = {
    adminLoginSchema, adminForgotSchema, adminResetSchema,
    adminProfileSchema, adminChangePasswordSchema,
};
