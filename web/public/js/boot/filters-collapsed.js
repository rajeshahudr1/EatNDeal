/*
 * boot/filters-collapsed.js
 *
 * What:  Pre-paint restore of the filter sidebar's collapsed state.
 *        Reads the saved preference and stamps .is-filters-collapsed
 *        on <html> BEFORE the body renders.
 * Why:   The class used to be added to .home-shell by home.js/pickup.js
 *        (deferred) — so on every reload / service-type switch the
 *        sidebar painted OPEN for a frame, then snapped shut (flicker).
 *        Loaded synchronously (no defer) in the <head> of _layout.ejs
 *        so the first paint already has the right layout.
 * Used:  views/_layout.ejs. The CSS keys off html.is-filters-collapsed
 *        (home-v2.css); home.js / pickup.js toggle the same class.
 */
(function () {
    'use strict';
    try {
        if (window.localStorage.getItem('eatndeal_filters_collapsed') === '1') {
            document.documentElement.classList.add('is-filters-collapsed');
        }
    } catch (e) { /* private mode / storage blocked — default open */ }
})();
