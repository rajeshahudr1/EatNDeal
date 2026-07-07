'use strict';

/*
 * config/welcomeBanner.js
 *
 * Enum IDs for mp_welcome_banner — the mode + content type are stored and sent
 * as INTEGER IDs (never strings), mirroring the Yii constants classes
 * common/constants/MpWelcomeBannerMode + MpWelcomeBannerContentType.
 */
module.exports = {
    // When to show.
    MODE: { FIX: 1, NEW_CUSTOMER: 2 },
    // What to show (only one).
    TYPE: { TEXT: 1, IMAGE: 2 },
    // Row lifecycle (integer `status` column) — legacy: 1 = Active, 2 = Deleted
    // (soft-delete). Reads exclude status = 2.
    STATUS: { ACTIVE: 1, DELETED: 2 },
};
