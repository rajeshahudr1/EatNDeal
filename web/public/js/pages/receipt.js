/*
 * pages/receipt.js — the printable receipt page (views/order/receipt.ejs).
 *
 * What:  Binds the "Print / Save as PDF" button to window.print(). Kept in
 *        an external file because a strict CSP blocks inline onclick=""
 *        (coding-convention #9 / CSP rule #6) — the old inline handler did
 *        nothing. Loaded via the layout's `extra_js` local (see
 *        OrderController.receipt).
 * Type:  WRITE (opens the browser print dialog on click).
 */
(function () {
    'use strict';
    function onReady() {
        var btn = document.querySelector('[data-action="print-receipt"]');
        if (!btn) { return; }
        btn.addEventListener('click', function () {
            if (typeof window.print === 'function') { window.print(); }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
