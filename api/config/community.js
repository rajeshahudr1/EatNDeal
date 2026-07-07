'use strict';

/*
 * config/community.js — SINGLE SOURCE for every community tunable + constant.
 *
 * No magic strings/numbers scattered across controllers/helpers: group types,
 * moderation modes/outcomes, the default coverage radius, and the OpenAI
 * moderation settings all live here and read from env where an operator may
 * want to change them. Import this everywhere instead of hardcoding values.
 */

module.exports = {
    // Who a group is for.
    TYPE: { USER: 'user', RESTAURANT: 'restaurant' },

    // How a group's posts/comments are gated.
    MODERATION: { AI: 'ai', OPEN: 'open', MANUAL: 'manual' },

    // A post/comment's moderation outcome (the `moderation_status` column).
    STATUS: { APPROVED: 'approved', PENDING: 'pending', REJECTED: 'rejected' },

    // A ROW's lifecycle (the integer `status` column) — legacy convention
    // (0 = In-Active, 1 = Active, 2 = Deleted). Delete = soft (status = 2);
    // every read filters status = 1, so deleted rows are kept but hidden.
    ROW: { INACTIVE: 0, ACTIVE: 1, DELETED: 2 },

    // Default coverage radius (km) for a group location when a row leaves it blank.
    DEFAULT_RADIUS_KM: Number(process.env.COMMUNITY_DEFAULT_RADIUS_KM) || 25,

    // OpenAI moderation (Phase B). Key supplied by the operator via env; when
    // empty, moderation fails safe (posts go to 'pending' for manual review).
    AI: {
        KEY:              process.env.OPENAI_API_KEY || '',
        BASE_URL:         (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
        MODEL:            process.env.OPENAI_MODEL || 'gpt-4o-mini',
        MODERATION_MODEL: process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest',
        TIMEOUT_MS:       Number(process.env.OPENAI_TIMEOUT_MS) || 6000,
        // Charity/sensitive groups hold a post if any safety score exceeds this
        // (stricter than the model's own binary flag). 0..1.
        SENSITIVE_THRESHOLD: Number(process.env.OPENAI_SENSITIVE_THRESHOLD) || 0.3,
    },

    enabled() { return !!this.AI.KEY; },
};
