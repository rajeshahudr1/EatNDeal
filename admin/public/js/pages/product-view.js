/*
 * pages/product-view.js
 *
 * What:  Product detail (View) page — tab switching only. Fully read-only
 *        (Edit / Delete are not exposed here).
 * Used:  extra_js for products/view.ejs.
 */
(function () {
    'use strict';

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) { return; }

        var tab = t.closest('[data-tab]');
        if (tab) {
            var name = tab.getAttribute('data-tab');
            var tabs = document.querySelectorAll('.pv-tab');
            for (var i = 0; i < tabs.length; i++) { tabs[i].classList.toggle('is-on', tabs[i] === tab); }
            var panels = document.querySelectorAll('.pv-panel');
            for (var j = 0; j < panels.length; j++) { panels[j].hidden = panels[j].getAttribute('data-panel') !== name; }
            return;
        }
    });
})();
