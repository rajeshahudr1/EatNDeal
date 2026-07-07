'use strict';

/*
 * Controllers/AppController.js — GET /app
 *
 * What:  Smart app-download link. Detects the device (or an explicit
 *        ?platform=ios|android from a QR) and redirects to the right store
 *        when its URL is configured (brand.config appStoreUrl / playStoreUrl).
 *        Desktop, unknown device, or an unpublished store → the download
 *        landing page (both platform QRs + store buttons).
 * Why:   ONE link/QR that "just works" for every device (the home card's QRs
 *        encode <site>/app?platform=…). No hardcoded store URLs.
 * Used:  web/index.js — GET /app.
 */

async function appRedirect(req, res) {
    const brand = res.locals.brand || {};
    const ua    = String(req.headers['user-agent'] || '').toLowerCase();
    const param = String((req.query && req.query.platform) || '').toLowerCase();

    const platform = (param === 'ios' || param === 'android') ? param
        : /iphone|ipad|ipod/.test(ua) ? 'ios'
        : /android/.test(ua)          ? 'android'
        : '';

    const store = platform === 'ios'     ? (brand.appStoreUrl  || '')
        :         platform === 'android' ? (brand.playStoreUrl || '')
        :         '';

    // A real store link for this device → send them straight there.
    if (store) { return res.redirect(store); }

    // Desktop / unknown / store not published yet → the download page.
    return res.render('app-download', {
        page_title:       'Get the ' + (brand.name || 'EatNDeal') + ' app',
        _layoutFile:      '../_layout',
        active_nav:       '',
        show_promo_strip: false,
    });
}

module.exports = { appRedirect };
