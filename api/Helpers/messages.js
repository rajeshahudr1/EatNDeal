'use strict';

/**
 * Helpers/messages.js
 *
 * What:   Single source of truth for every user-facing message string the API
 *         can send back (errors, success notes, auth failures).
 * Why:    Coding-Conventions rule 9 — "alert / error / success messages must
 *         be properly worded AND the same text on web client + web server + api
 *         for the same condition." This file is the canonical copy; the web
 *         layer + Flutter app fetch / mirror it so the wording never drifts.
 *         Also makes future i18n a one-file change (swap text per locale).
 * Type:   READ (returns frozen object).
 * Inputs: none.
 * Output: nested object with grouped keys (auth, validation, server, brand).
 * Used:   require('./Helpers/messages') from any controller / middleware that
 *         needs a user-facing string. Examples:
 *           H.errorResponse(res, MSG.auth.failed, 401);
 *           H.errorResponse(res, MSG.validation.fieldRequired('email'), 422);
 *
 * Change log:
 *   2026-05-25 — initial; keys mirror Yii2 eatndealclean wordings where
 *                relevant + add API-specific ones.
 */

// Frozen so accidental edits at runtime throw instead of silently mutating
// the shared catalogue.
const messages = Object.freeze({

    // ── Server-level errors ─────────────────────────────────────────
    server: Object.freeze({
        // Generic 500. Don't leak internals to the caller.
        oops:           'Something went wrong on our end. Please try again in a moment.',
        notFound:       'The requested resource could not be found.',
        unavailable:    'The service is temporarily unavailable. Please try again shortly.',
        rateLimited:    'You have made too many requests. Please wait a minute and try again.',
    }),

    // ── Authentication / authorization ─────────────────────────────
    auth: Object.freeze({
        // Intentionally identical for every auth-fail mode (bad token, missing
        // token, expired token, wrong role) — never leak which condition hit.
        failed:         'Authentication failed. Please sign in again.',
        forbidden:      'You do not have permission to perform this action.',
        sessionExpired: 'Your session has expired. Please sign in again.',
        invalidCredentials: 'The email or password you entered is incorrect.',
        otpInvalid:     'The verification code is incorrect or has expired. Please request a new one.',
        otpSent:        'A verification code has been sent to your phone.',
        otpVerified:    'Verification successful.',
        otpSendFailed:  'We could not send the verification code right now. Please try again in a moment.',
        accountBanned:  'This account has been disabled. Please contact support.',
        accountDisabled:'This account is currently disabled. Please contact support.',
    }),

    // ── Validation ─────────────────────────────────────────────────
    validation: Object.freeze({
        // Static one-liners
        missingFields:   'Some required information is missing. Please review the form and try again.',
        invalidEmail:    'Please enter a valid email address.',
        invalidPhone:    'Please enter a valid phone number.',
        passwordTooShort:'Password must be at least 8 characters long.',
        passwordMismatch:'The passwords entered do not match.',

        // Helpers — return tailored sentences. Keep them as functions so
        // we don't end up with thousands of literal strings.

        /**
         * fieldRequired(field) — "The '<field>' field is required."
         * Used by the Joi validate middleware error path.
         */
        fieldRequired: (field) => `The '${field}' field is required.`,

        /**
         * fieldInvalid(field) — "The '<field>' field is not valid."
         */
        fieldInvalid:  (field) => `The '${field}' field is not valid.`,
    }),

    // ── Resource lifecycle ─────────────────────────────────────────
    resource: Object.freeze({
        created:  'Created successfully.',
        updated:  'Updated successfully.',
        deleted:  'Deleted successfully.',
        notFound: 'The requested record could not be found.',
        conflict: 'A record with the same details already exists.',
    }),

    // ── Brand-related fallbacks ────────────────────────────────────
    brand: Object.freeze({
        // Returned by /brand if brand config ever fails to load (it shouldn't,
        // but defensive UX text > silent 500).
        unavailable: 'Brand information is temporarily unavailable.',
    }),

    // ── Generic success ────────────────────────────────────────────
    success: 'success',
});

module.exports = messages;
