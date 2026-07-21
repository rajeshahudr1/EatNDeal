'use strict';

/*
 * config/params.js — the port of legacy `common/config/params.php`.
 *
 * App-wide trading constants that legacy reads as Yii::$app->params[...].
 * They are NOT per-branch and NOT database-driven — legacy hardcodes them in
 * params.php and every consumer reads the same value, so this file is the one
 * place they live here too. Import it; never re-declare these inline.
 */

module.exports = {
    /*
     * SHOP_CLOSE_TIME — where a restaurant's TRADING DAY ends.
     *
     * A shop that serves until 2am is still working its evening, so the day
     * does not roll at midnight: it rolls at this time. Legacy uses it in six
     * places (common/helper/index.php:524 shopOpenCloseTime, Branch.php:746,
     * StoreBusinessHours.php:67, StoreBusinessHourShifts.php:80,
     * BusinessHoursController.php:242), all reading params.php:170 — which is
     * the literal below.
     *
     * Used here by Helpers/orderPlace.js to reset internal_order_id to 1 each
     * trading day, exactly like Commonquery::getOrderInternalId.
     */
    SHOP_CLOSE_TIME: '06:00:00',

    /*
     * TRADING_TZ — the clock those trading boundaries are read on. The
     * business trades in the UK and `created_at` is timestamptz, so the
     * boundary must be evaluated in UK local time rather than whatever
     * timezone the Node process happens to run in.
     */
    TRADING_TZ: 'Europe/London',
};
