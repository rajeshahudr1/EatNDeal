/*
 * ui/favourites.js
 *
 * What:  Wires the heart icon (`[data-fav-toggle]`) on every restaurant
 *        card + the detail-page hero. One delegated click handler so it
 *        works for ANY card the page renders now or later (the home page
 *        swaps the rail when a cuisine pill is tapped).
 * Why:   Centralised so we don't repeat the same toggle logic in
 *        home.js / restaurant.js / account.js.
 * How:   Click → POST /favourite/toggle → flip `.is-active`, swap
 *        aria-pressed / aria-label, fire a toast. Pre-empt the parent
 *        `<a>` link so a click on the heart never navigates.
 *
 * Auth:  The view ONLY renders the button when the customer is signed
 *        in (EJS gate on `user_session`). This file is still defensive:
 *        if a 401 comes back (guest curl, session expired) it redirects
 *        to /signin with `next=` set to the current page.
 */
(function () {
    'use strict';

    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };

    // Flip the visible state on the button. Pure DOM — the server is
    // the source of truth, so we wait for its reply before painting.
    function paint(btn, isFav) {
        btn.classList.toggle('is-active', !!isFav);
        btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
        btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
        btn.classList.add('is-pulsing');
        window.setTimeout(function () { btn.classList.remove('is-pulsing'); }, 380);
        // Sync any sibling buttons that point to the same restaurant
        // (e.g. the same card appears in two rails) so they don't go
        // out of sync after one tap.
        var id = btn.getAttribute('data-fav-toggle');
        if (!id) { return; }
        var twins = document.querySelectorAll('[data-fav-toggle="' + id + '"]');
        for (var i = 0; i < twins.length; i++) {
            var t = twins[i];
            if (t === btn) { continue; }
            t.classList.toggle('is-active', !!isFav);
            t.setAttribute('aria-pressed', isFav ? 'true' : 'false');
            t.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
        }
    }

    async function postToggle(companyId, branchId) {
        var body = { company_id: companyId };
        if (branchId) { body.branch_id = branchId; }
        var res = await fetch('/favourite/toggle', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify(body),
        });
        var env = null;
        try { env = await res.json(); } catch (e) { env = null; }
        return env || { status: 500, msg: 'Network error.' };
    }

    /**
     * pruneFavRail
     *
     * What:  A rail marked [data-fav-rail] lists ONLY favourites, so a card
     *        that has just been un-hearted no longer belongs there — drop it,
     *        and hide the whole section once none are left. Rails that merely
     *        contain hearts (Order again, Offers, search results) are untouched:
     *        the heart there is a control, not the reason the card is listed.
     * Type:  WRITE (DOM).
     */
    function pruneFavRail(btn) {
        var rail = btn.closest && btn.closest('[data-fav-rail]');
        if (!rail) { return; }
        var card = btn.closest('li') || btn.closest('[data-search-id]');
        if (card && card.parentNode) { card.parentNode.removeChild(card); }
        // Nothing left → the heading and empty scroller would look broken.
        if (!rail.querySelector('[data-fav-toggle]')) { rail.hidden = true; }
    }

    /**
     * needsReload
     *
     * What:  Any add OR remove on a page that shows a favourites section
     *        (home rail, Account → Favourites) re-fetches the page. The
     *        section — its cards, their order, the empty state — is built
     *        server-side, so patching it in JS only ever half-matched what
     *        a reload gives for free.
     * Type:  READ (DOM) → boolean.
     */
    function needsReload() {
        var path = window.location.pathname;
        if (path === '/') { return true; }
        if (path === '/account' && window.location.search.indexOf('tab=favourites') !== -1) { return true; }
        return false;
    }

    document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('[data-fav-toggle]');
        if (!btn) { return; }
        // Always swallow the click — the heart sits inside an <a> card,
        // and we don't want the parent link's navigation to fire.
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.disabled) { return; }

        var companyId = btn.getAttribute('data-fav-toggle');
        var branchId  = btn.getAttribute('data-fav-branch') || '';
        var name      = btn.getAttribute('data-fav-name') || 'Restaurant';
        if (!companyId) { return; }

        btn.disabled = true;
        postToggle(companyId, branchId).then(function (env) {
            btn.disabled = false;
            if (env.status === 401) {
                // Guest curl OR session expired — bounce to sign-in and
                // come back to whatever page they were on.
                var here = window.location.pathname + window.location.search;
                window.location.href = '/signin?next=' + encodeURIComponent(here);
                return;
            }
            if (env.status !== 200 || !env.data) {
                toast('error', (env.msg) || 'Could not update favourites.');
                return;
            }
            var isFav = !!env.data.isFavourite;
            paint(btn, isFav);
            if (!isFav) { pruneFavRail(btn); }
            toast('success', isFav ? (name + ' added to favourites.') : (name + ' removed from favourites.'));
            // Let the toast be readable, then re-render server-side where
            // a whole section appears/disappears (see needsReload).
            if (needsReload()) {
                window.setTimeout(function () { window.location.reload(); }, 900);
            }
        }).catch(function () {
            btn.disabled = false;
            toast('error', 'Could not update favourites.');
        });
    });
})();
