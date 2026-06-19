/*
 * pages/feed-sections.js  (admin layer)
 *
 * What:  The "Feed Order" page — drag the 4 home-feed sections to reorder, toggle
 *        each show/hide, and save the order to /feed-sections/reorder.
 * Used:  extra_js for feed-sections/arrange.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    var root = document.querySelector('[data-feedorder]');
    if (!root) { return; }
    var list = root.querySelector('[data-list][data-draggable]');
    if (list) { enableDrag(list, '.pr-item'); }

    document.addEventListener('click', function (e) {
        if (!e.target.closest('[data-action="fo-save"]')) { return; }
        if (!list) { return; }
        var order = Array.prototype.map.call(list.children, function (el) { return el.getAttribute('data-key'); }).filter(Boolean);
        var disabled = [];
        Array.prototype.forEach.call(root.querySelectorAll('.fo-enable'), function (cb) {
            if (!cb.checked) { disabled.push(cb.getAttribute('data-key')); }
        });
        A.post('/feed-sections/reorder', { order: order, disabled: disabled }).then(function (res) {
            if (A.isSuccess(res)) { toast('success', res.msg || 'Feed order saved.'); }
            else { toast('error', res.msg || 'Could not save the feed order.'); }
        });
    });

    // ─────────────────────── shared drag util ───────────────────
    function enableDrag(container, itemSel) {
        var dragged = null;
        container.addEventListener('dragstart', function (e) {
            var row = e.target.closest(itemSel);
            if (!row) { return; }
            dragged = row; row.classList.add('is-dragging');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); } catch (x) { /* ignore */ }
        });
        container.addEventListener('dragend', function () { if (dragged) { dragged.classList.remove('is-dragging'); } dragged = null; });
        container.addEventListener('dragover', function (e) {
            if (!dragged) { return; }
            e.preventDefault();
            var after = afterElement(container, itemSel, e.clientY);
            if (after == null) { container.appendChild(dragged); }
            else if (after !== dragged) { container.insertBefore(dragged, after); }
        });
    }
    function afterElement(container, itemSel, y) {
        var els = Array.prototype.slice.call(container.querySelectorAll(itemSel + ':not(.is-dragging)'));
        var closest = null, closestOffset = -Infinity;
        els.forEach(function (el) {
            var box = el.getBoundingClientRect();
            var offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
        });
        return closest;
    }
})();
