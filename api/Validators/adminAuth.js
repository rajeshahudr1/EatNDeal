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

module.exports = { adminLoginSchema, adminForgotSchema, adminResetSchema };
