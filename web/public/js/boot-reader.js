/*
 * boot-reader.js
 *
 * What:  Reads <body data-*> attributes set by views/_layout.ejs and writes
 *        them onto a single global `window.boot` object. Everything in the
 *        page boots off of this — apiUrl, currency, current location state,
 *        active nav.
 * Why:   Coding-Conventions rule #6 forbids inline <script>, so we cannot
 *        do `window.boot = { ... }` inline in the EJS template. Instead the
 *        template stamps data-* attrs onto <body>; this tiny script (the
 *        FIRST one loaded) reads them and freezes the resulting object.
 *        NOTE: brand colours are NOT in window.boot — colours live in
 *        /css/base.css (:root variables). Only runtime CONFIG (api url,
 *        currency symbol, location flag, etc.) lives here.
 * Used:  First <script defer> in views/_layout.ejs. Every other JS file
 *        loaded later assumes `window.boot` exists.
 */

(function () {
    'use strict';

    /**
     * readDataset
     *
     * What:  Copies <body data-*> attribute values into a flat object.
     *        Coerces "true" / "false" strings to booleans so checks read
     *        naturally (boot.hasLocation === true).
     * Why:   Single point of conversion; everything downstream gets clean
     *        booleans + strings.
     * Type:  READ.
     * Inputs: none.
     * Output: object.
     * Used:   Inside this IIFE only.
     */
    function readDataset() {
        var body = document.body;
        var d    = body && body.dataset ? body.dataset : {};

        // lat / lng — empty strings convert to NaN via Number() so we
        // promote them to null first. Pagination + nearby endpoints
        // check `Number.isFinite(lat)` so null is the right sentinel.
        var rawLat = d.lat ? Number(d.lat) : NaN;
        var rawLng = d.lng ? Number(d.lng) : NaN;

        return Object.freeze({
            brandName:      d.brandName       || 'EatNDeal',
            currency:       d.currency        || 'GBP',
            currencySymbol: d.currencySymbol  || '£',
            apiUrl:         (d.apiUrl || '').replace(/\/$/, ''),
            hasLocation:    d.hasLocation === 'true',
            lat:            Number.isFinite(rawLat) ? rawLat : null,
            lng:            Number.isFinite(rawLng) ? rawLng : null,
            activeNav:      d.activeNav       || '',
        });
    }

    // Expose as a single read-only global. Frozen so accidental writes throw
    // (in strict mode) instead of silently mutating shared state.
    window.boot = readDataset();
})();
