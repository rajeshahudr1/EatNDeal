/*
 * ui/reviews-list.js
 *
 * What:  The restaurant "Ratings & reviews" MODAL — opened by the rail's
 *        "View all reviews" button OR the hero rating (the primary entry on
 *        phones, near the top). Inside: sort (All / Best first / Critical),
 *        filter by star (1–5), scrollable list + load-more pagination. The
 *        list lazy-loads on first open from /restaurant-reviews (web proxy →
 *        api). The rail shows a static top-5 preview rendered server-side.
 * Why:   No inline JS (CSP rule #6) — a global, self-guarding module. No-ops
 *        when the reviews modal isn't on the page (every non-restaurant page).
 * Used:  Loaded globally from views/_layout.ejs.
 */
(function () {
    'use strict';

    var PAGE = 5;
    var modal, listEl, moreBtn, emptyEl, sortWrap, starsWrap, loaderEl;
    var companyId, sort = 'recent', star = '', offset = 0, busy = false, loaded = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function reviewHtml(rev) {
        var starsHtml = '';
        for (var k = 1; k <= 5; k++) { starsHtml += '<span class="' + (rev.rating >= k ? 'is-on' : '') + '">★</span>'; }
        var text  = rev.review ? '<p class="rd-review__text">' + esc(rev.review) + '</p>' : '';
        var photo = rev.photo  ? '<img class="rd-review__photo" src="' + esc(rev.photo) + '" alt="Review photo" loading="lazy">' : '';
        return '<li class="rd-review">' +
                 '<div class="rd-review__head">' +
                   '<span class="rd-review__name">' + esc(rev.customerName) + '</span>' +
                   '<span class="rd-review__stars" aria-label="' + esc(rev.rating) + ' out of 5">' + starsHtml + '</span>' +
                 '</div>' + text + photo +
               '</li>';
    }

    function setBusy(b) {
        busy = b;
        if (loaderEl) { loaderEl.hidden = !b; }
        if (moreBtn)  { moreBtn.disabled = b; }
        if (modal)    { modal.classList.toggle('is-loading', b); }
    }

    function load(append) {
        if (busy || !companyId) { return; }
        setBusy(true);
        var qs = 'company_id=' + encodeURIComponent(companyId) +
                 '&sort=' + encodeURIComponent(sort) +
                 '&offset=' + offset + '&limit=' + PAGE +
                 (star ? '&stars=' + encodeURIComponent(star) : '');
        fetch('/restaurant-reviews?' + qs, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (body) {
                setBusy(false);
                if (!body || body.status !== 200 || !body.data) { return; }
                var d = body.data;
                var html = (d.reviews || []).map(reviewHtml).join('');
                if (append) { listEl.insertAdjacentHTML('beforeend', html); }
                else        { listEl.innerHTML = html; }
                if (emptyEl) { emptyEl.hidden = !(offset === 0 && (d.reviews || []).length === 0); }
                if (moreBtn) { moreBtn.hidden = !d.hasMore; }
                loaded = true;
            })
            .catch(function () { setBusy(false); });
    }

    function refresh() { offset = 0; load(false); }

    function openModal() {
        if (!modal) { return; }
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (!loaded) { refresh(); }   // lazy first load
    }
    function closeModal() {
        if (!modal) { return; }
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    function onReady() {
        modal = document.querySelector('[data-reviews-modal]');
        if (!modal) { return; }
        listEl    = modal.querySelector('[data-rv-list]');
        moreBtn   = modal.querySelector('[data-rv-more]');
        emptyEl   = modal.querySelector('[data-rv-empty]');
        loaderEl  = modal.querySelector('[data-rv-loader]');
        sortWrap  = modal.querySelector('[data-rv-sort]');
        starsWrap = modal.querySelector('[data-rv-stars]');
        companyId = modal.getAttribute('data-company-id') || '';

        // Open (View all button / hero rating) + close (× / backdrop) — delegated.
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }
            if (t.closest('[data-action="open-reviews"]'))  { ev.preventDefault(); openModal();  return; }
            if (t.closest('[data-action="close-reviews"]')) { ev.preventDefault(); closeModal(); return; }
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && modal && !modal.hidden) { closeModal(); }
        });

        if (sortWrap) {
            sortWrap.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('.rd-reviews__sort-btn');
                if (!b) { return; }
                sort = b.getAttribute('data-sort') || 'recent';
                sortWrap.querySelectorAll('.rd-reviews__sort-btn').forEach(function (x) { x.classList.toggle('is-active', x === b); });
                refresh();
            });
        }
        if (starsWrap) {
            starsWrap.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('.rd-reviews__chip');
                if (!b) { return; }
                star = b.getAttribute('data-star') || '';
                starsWrap.querySelectorAll('.rd-reviews__chip').forEach(function (x) { x.classList.toggle('is-active', x === b); });
                refresh();
            });
        }
        if (moreBtn) {
            moreBtn.addEventListener('click', function () { offset += PAGE; load(true); });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
