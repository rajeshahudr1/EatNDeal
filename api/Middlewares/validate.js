'use strict';

/**
 * Middlewares/validate.js
 *
 * What:   Factory that turns a Joi schema into Express middleware. Validates
 *         req.body / req.query / req.params BEFORE the controller runs and
 *         replaces the source with Joi's sanitised value (trimmed strings,
 *         applied defaults, lowercased emails, etc.).
 * Why:    Dual-side validation is one of the project rules (Coding-Conventions
 *         #3) — the API ALWAYS validates input, even though the web/app
 *         already validated client-side. This middleware is the api half.
 * Type:   READ (rejects on failure with 422 envelope; doesn't touch DB).
 * Inputs: schema (Joi.Schema) — the validation rules
 *         source ('body' | 'query' | 'params', default 'body')
 * Output: Express middleware function.
 * Used:   In Routes/index.js — wrap before controller:
 *           router.post('/login', validate(loginSchema), AuthController.login);
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const H       = require('../Helpers/helper');
const MSG     = require('../Helpers/messages');

const VALID_SOURCES = new Set(['body', 'query', 'params']);

/**
 * validate
 *
 * What:   Build a request-validating middleware from a Joi schema.
 * Why:    See file header.
 * Type:   READ.
 * Inputs: schema (Joi.Schema), source ('body' | 'query' | 'params').
 * Output: middleware function (req, res, next) => void.
 * Used:   Every protected route registration in Routes/index.js.
 */
function validate(schema, source = 'body') {
    if (!schema || typeof schema.validate !== 'function') {
        throw new TypeError('validate(schema) requires a Joi schema');
    }
    if (!VALID_SOURCES.has(source)) {
        throw new TypeError(
            `validate(schema, source): source must be one of: ${[...VALID_SOURCES].join(', ')}`
        );
    }

    // Return a middleware closure capturing the schema + source.
    return function validateMiddleware(req, res, next) {
        // abortEarly:true → stop on first violation, surface ONE message.
        // Matches the existing Yii2 system's single-message style.
        const { error, value } = schema.validate(req[source] || {}, {
            abortEarly: true,
        });

        if (error) {
            // Prefer the developer-written Joi message verbatim; fall back to
            // the catch-all from messages.js if Joi gives us nothing useful.
            const msg = (error.details && error.details[0] && error.details[0].message)
                || MSG.validation.missingFields;
            return H.errorResponse(res, msg, 422);
        }

        // Replace the request source with the sanitised value so controllers
        // see trimmed strings + defaults applied + types coerced.
        req[source] = value;
        return next();
    };
}

/**
 * validateQuery
 *
 * What:   Shorthand for validate(schema, 'query').
 * Why:    GET endpoints often want query-string validation; this saves the
 *         second argument repeatedly. Identical behaviour.
 * Type:   READ.
 * Inputs: schema.
 * Output: middleware function.
 * Used:   In Routes/index.js for GET handlers.
 */
function validateQuery(schema) {
    return validate(schema, 'query');
}

module.exports = { validate, validateQuery };
