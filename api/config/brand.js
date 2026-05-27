'use strict';

/**
 * config/brand.js
 *
 * What:  Thin wrapper around api/brand.config.js. Loads the identity
 *        config and exposes it as a frozen object so accidental mutation
 *        at runtime throws.
 * Why:   The brand-identity file is the single source of truth. This
 *        wrapper exists for two reasons:
 *          1. `require('./config/brand')` is a familiar import shape for
 *             controllers (matches other config modules).
 *          2. Freezing the object guarantees no controller can mutate
 *             shared state by accident — change the file, restart the
 *             api, done.
 *        NO environment variables — operators edit api/brand.config.js
 *        directly to rebrand. NO colour fields — colours live in
 *        web/public/css/base.css (:root block). This module owns
 *        IDENTITY only.
 * Type:  READ (returns config object).
 * Inputs: api/brand.config.js (sibling file at api root).
 * Output: { brand: <frozen identity object> }.
 * Used:   require('./config/brand') anywhere in the api — most often by
 *         Controllers/BrandController.js which surfaces it at /brand.
 *
 * Change log:
 *   2026-05-25 — collapsed env-driven version into a thin loader; removed
 *                all colour fields (now in CSS).
 */

const brandConfig = require('../brand.config');

const brand = Object.freeze({ ...brandConfig });

module.exports = { brand };
