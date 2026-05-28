/*
 * pages/product.js
 *
 * What:  Drives the rich product page (views/partials/product-detail.ejs):
 *          • Image gallery — thumbnail click swaps the main image.
 *          • Option rules — single-select groups act as radios; multi
 *            groups enforce their max limit.
 *          • Quantity stepper + live totals: line total, subtotal, and
 *            the Add bar(s) = (base + selected option prices) × qty.
 *          • A live "selected options" summary in the order panel.
 *          • Customization-note character counter.
 *          • Add to cart → validates required groups, then toasts (the
 *            cart backend is a later milestone).
 *          • Image-fallback + tint painting (home.js isn't loaded here).
 * Used:  Loaded only on the product view (SiteController extra_js).
 */

(function () {
    'use strict';

    function qa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
    function toast(type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } }

    var root, basePrice = 0, sym = '£', qty = 1;

    function applyTints(scope) {
        qa('[data-tint]', scope || document).forEach(function (el) {
            var t = el.getAttribute('data-tint');
            if (t) { el.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.45), transparent 60%), ' + t; }
        });
    }
    function bindImageFallback() {
        document.addEventListener('error', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'IMG' && t.hasAttribute('data-img-fallback')) { t.style.display = 'none'; }
        }, true);
    }
    function money(n) { return sym + (Math.round(n * 100) / 100).toFixed(2); }

    /**
     * recompute — sum base + checked option prices, update the line
     * total / subtotal / Add bars / qty, and the selected-options
     * summary in the order panel.
     */
    function recompute() {
        var perItem = basePrice;
        var picked = [];
        qa('.pd-group input:checked', root).forEach(function (inp) {
            var pr = parseFloat(inp.getAttribute('data-price'));
            if (isFinite(pr)) { perItem += pr; }
            var nm = inp.getAttribute('data-name');
            if (nm) { picked.push(nm); }
        });
        var total = perItem * qty;

        qa('[data-total]', root).forEach(function (el) { el.textContent = money(total); });
        var lineEl = root.querySelector('[data-line-total]');
        if (lineEl) { lineEl.textContent = money(perItem * qty); }
        var subEl = root.querySelector('[data-subtotal]');
        if (subEl) { subEl.textContent = money(total); }
        var sumEl = root.querySelector('[data-selected-summary]');
        if (sumEl) { sumEl.textContent = picked.join(' · '); }
    }

    /** enforceMax — for a multi group with a max, undo the over-limit tick. */
    function enforceMax(input) {
        var group = input.closest('.pd-group');
        if (!group || group.getAttribute('data-type') !== 'multi') { return; }
        var max = Number(group.getAttribute('data-max')) || 0;
        if (max <= 0) { return; }
        if (input.checked && qa('input:checked', group).length > max) {
            input.checked = false;
            toast('info', 'You can choose up to ' + max + '.');
        }
    }

    function bindOptions() {
        root.addEventListener('change', function (ev) {
            var inp = ev.target;
            if (!inp || (inp.type !== 'checkbox' && inp.type !== 'radio')) { return; }
            enforceMax(inp);
            recompute();
        });
    }

    function bindGallery() {
        var main = root.querySelector('[data-gallery-main] img') || null;
        root.addEventListener('click', function (ev) {
            var thumb = ev.target.closest && ev.target.closest('[data-gallery-thumb]');
            if (!thumb) { return; }
            var src = thumb.getAttribute('data-gallery-thumb');
            var mainWrap = root.querySelector('[data-gallery-main]');
            if (!mainWrap || !src) { return; }
            var img = mainWrap.querySelector('img');
            if (!img) { img = document.createElement('img'); img.setAttribute('data-img-fallback', ''); mainWrap.appendChild(img); }
            img.style.display = '';
            img.src = src;
            qa('[data-gallery-thumb]', root).forEach(function (t) { t.classList.toggle('is-active', t === thumb); });
        });
    }

    function bindQty() {
        root.addEventListener('click', function (ev) {
            var inc = ev.target.closest && ev.target.closest('[data-action="pd-qty-inc"]');
            var dec = ev.target.closest && ev.target.closest('[data-action="pd-qty-dec"]');
            if (!inc && !dec) { return; }
            ev.preventDefault();
            qty = Math.max(1, Math.min(99, qty + (inc ? 1 : -1)));
            var qEl = root.querySelector('[data-qty]');
            if (qEl) { qEl.textContent = String(qty); }
            recompute();
        });
    }

    function bindNote() {
        var note = root.querySelector('[data-note]');
        var count = root.querySelector('[data-note-count]');
        if (!note || !count) { return; }
        note.addEventListener('input', function () { count.textContent = String(note.value.length); });
    }

    /** firstInvalidGroup — a required group with fewer than `min` picks. */
    function firstInvalidGroup() {
        var bad = null;
        qa('.pd-group', root).forEach(function (g) {
            if (bad) { return; }
            var min = Number(g.getAttribute('data-min')) || 0;
            if (min < 1) { return; }
            if (qa('input:checked', g).length < min) { bad = g; }
        });
        return bad;
    }

    function bindAdd() {
        root.addEventListener('click', function (ev) {
            var add = ev.target.closest && ev.target.closest('[data-action="pd-add"]');
            if (!add) { return; }
            ev.preventDefault();
            var bad = firstInvalidGroup();
            if (bad) {
                var name = bad.querySelector('.pd-group__name');
                toast('error', 'Please choose: ' + (name ? name.textContent : 'a required option') + '.');
                bad.scrollIntoView({ behavior: 'smooth', block: 'center' });
                bad.classList.add('is-invalid');
                window.setTimeout(function () { bad.classList.remove('is-invalid'); }, 1500);
                return;
            }
            toast('success', 'Added ' + qty + ' to cart — checkout coming soon.');
        });
    }

    /**
     * applyStock — when the product is out of stock, disable the Add
     * buttons and relabel them so the user can browse but not order.
     */
    function applyStock() {
        if (root.getAttribute('data-instock') !== '0') { return; }
        qa('[data-action="pd-add"]', root).forEach(function (btn) {
            btn.disabled = true;
            btn.classList.add('is-disabled');
            var label = btn.querySelector('span');
            if (label) { label.textContent = 'Out of stock'; }
            var total = btn.querySelector('[data-total]');
            if (total) { total.textContent = ''; }
        });
    }

    function onReady() {
        root = document.querySelector('[data-product]');
        if (!root) { return; }
        basePrice = parseFloat(root.getAttribute('data-base-price')) || 0;
        sym = root.getAttribute('data-currency') || '£';

        bindImageFallback();
        applyTints();
        bindGallery();
        bindOptions();
        bindQty();
        bindNote();
        bindAdd();
        recompute();
        applyStock();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
