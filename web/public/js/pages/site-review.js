/*
 * pages/site-review.js — the /reviews page (reviews of EatNDeal itself).
 * Star picker + submit. The api validates and moderates; this is just the
 * interaction layer. The form still needs JS only for the star picker — the
 * rating is a hidden input, so nothing is lost if the toast module is absent.
 */
(function () {
    'use strict';

    var D = window.EatNDealDom || {};
    var toast = D.showToastSafe || function (t, m) {
        if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(t, m); }
    };

    /* ── "View more" ────────────────────────────────────────────────────
     * Appends the next batch in place. Set up before the form guard below:
     * the list is PUBLIC, so a signed-out visitor has no form but must still
     * be able to page through the reviews. */
    (function viewMore() {
        var btn  = document.querySelector('[data-sr-more]');
        var list = document.querySelector('[data-sr-list]');
        if (!btn || !list) { return; }

        var busy = false;

        // Escape before injecting — name/review/reply are customer-written, and
        // the server-rendered cards go through EJS's <%= %>. Same rule here.
        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Mirrors the star markup in views/site-review/index.ejs.
        function stars(rating) {
            var v = Math.round((Number(rating) || 0) * 2) / 2;
            var out = '';
            for (var i = 1; i <= 5; i++) {
                if (v >= i)            { out += '<span class="sr-star is-full">★</span>'; }
                else if (v >= i - 0.5) { out += '<span class="sr-star is-half">★</span>'; }
                else                   { out += '<span class="sr-star">★</span>'; }
            }
            return '<span class="sr-stars sr-stars--sm">' + out + '</span>';
        }

        function dmy(v) {
            var d = new Date(v);
            if (isNaN(d.getTime())) { return ''; }
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        }

        var BRAND = btn.getAttribute('data-brand') || '';

        function card(r) {
            return '<li class="sr__item">'
                + '<div class="sr__item-head">'
                +   '<span class="sr__name">' + esc(r.name) + '</span>'
                +   '<span class="sr__date">' + esc(dmy(r.created_at)) + '</span>'
                + '</div>'
                + stars(r.rating)
                + (r.review ? '<p class="sr__body">' + esc(r.review) + '</p>' : '')
                + (r.reply ? '<p class="sr__reply"><strong>' + esc(BRAND) + ' replied:</strong> ' + esc(r.reply) + '</p>' : '')
                + '</li>';
        }

        btn.addEventListener('click', function () {
            if (busy) { return; }
            busy = true;
            btn.disabled = true;
            var was = btn.textContent;
            btn.textContent = 'Loading…';

            var offset = Number(btn.getAttribute('data-offset')) || 0;
            fetch('/reviews/more?offset=' + encodeURIComponent(offset), {
                credentials: 'same-origin',
                headers:     { Accept: 'application/json' },
            })
                .then(function (r) { return r.json().catch(function () { return null; }); })
                .then(function (env) {
                    busy = false;
                    btn.disabled = false;
                    btn.textContent = was;

                    var d = env && env.status === 200 && env.data;
                    if (!d) { toast('error', (env && env.msg) || 'Could not load more reviews.'); return; }

                    (d.reviews || []).forEach(function (r) { list.insertAdjacentHTML('beforeend', card(r)); });

                    // The api decides when we're done — trust hasMore, not a
                    // short page (the last batch can be exactly full).
                    if (d.hasMore) { btn.setAttribute('data-offset', String(d.nextOffset)); }
                    else { var w = btn.closest('.sr__more'); if (w) { w.remove(); } else { btn.remove(); } }
                })
                .catch(function () {
                    busy = false;
                    btn.disabled = false;
                    btn.textContent = was;
                    toast('error', 'Could not reach the server.');
                });
        });
    }());

    var form = document.querySelector('[data-sr-form]');
    if (!form) { return; }                       // signed out, or not this page

    var hidden = form.querySelector('[data-sr-rating]');
    var stars  = Array.prototype.slice.call(form.querySelectorAll('[data-sr-star]'));
    var submit = form.querySelector('[data-sr-submit]');
    var textEl = form.querySelector('[name="review"]');

    // What the server rendered — i.e. the review as already saved. defaultValue
    // is the markup's value, so it keeps meaning what it says however much the
    // customer types. Both empty = writing a new review, not editing one.
    var savedRating = hidden ? (Number(hidden.defaultValue) || 0) : 0;
    var savedText   = textEl ? textEl.defaultValue.trim() : '';
    var isEdit      = savedRating > 0 || savedText !== '';

    function paint(n) {
        stars.forEach(function (b) {
            var v = Number(b.getAttribute('data-sr-star'));
            b.classList.toggle('is-on', v <= n);
            b.setAttribute('aria-checked', v === n ? 'true' : 'false');
        });
    }

    form.addEventListener('click', function (e) {
        var b = e.target.closest('[data-sr-star]');
        if (!b) { return; }
        e.preventDefault();
        var n = Number(b.getAttribute('data-sr-star'));
        if (hidden) { hidden.value = String(n); }
        paint(n);
    });

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var rating = Number(hidden && hidden.value) || 0;
        var text   = (form.querySelector('[name="review"]').value || '').trim();

        // Checked here only to save a round trip — the api re-validates both.
        if (rating < 1 || rating > 5) { toast('error', 'Please choose a rating between 1 and 5 stars.'); return; }
        if (!text) { toast('error', 'Please write your review.'); return; }

        // Nothing actually edited — don't send it. This isn't just a wasted
        // round trip: the api puts an edited review back in the approval queue,
        // so a stray Update on an unchanged review would quietly pull a live
        // one down and give nothing back for it. 'info', not 'error' — they
        // haven't done anything wrong.
        if (isEdit && rating === savedRating && text === savedText) {
            toast('info', 'Your review is already saved. Change the rating or the text to update it.');
            return;
        }

        if (submit) { submit.disabled = true; }
        fetch('/reviews/submit', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', Accept: 'application/json' },
            body:        JSON.stringify({ rating: rating, review: text }),
        })
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .then(function (env) {
                if (submit) { submit.disabled = false; }
                if (env && env.status === 200) {
                    toast('success', env.msg || 'Thanks for your review!');
                    // Reload so the list + average show the review back to its
                    // author (the api merges their own copy in, approved or not).
                    setTimeout(function () { window.location.reload(); }, 900);
                    return;
                }
                if (env && env.status === 401) {
                    window.location.href = '/signin?next=%2Freviews';
                    return;
                }
                toast('error', (env && env.msg) || 'Could not save your review.');
            })
            .catch(function () {
                if (submit) { submit.disabled = false; }
                toast('error', 'Could not reach the server.');
            });
    });
}());
