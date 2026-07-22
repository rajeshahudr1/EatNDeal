/*
 * ui/cart-sync.js
 *
 * What:  Keeps an open cart page in step with an address or location change
 *        made SOMEWHERE ELSE — another browser tab, or the location modal on
 *        this same page (edit a saved address, switch the active location).
 *        When that happens it re-fetches the cart's regions and swaps them in,
 *        so the customer never has to reload to see the new address, fee or
 *        deliverability.
 * Why:   The cart's delivery address follows the header location and the saved
 *        address book. Changing either used to leave an already-open cart
 *        showing the OLD address until a manual refresh — the "I changed my
 *        address but the cart didn't notice" complaint.
 * How:   • Other tab changes an address → it bumps a localStorage key; the
 *          `storage` event fires in THIS tab → we refresh.
 *        • This tab's location modal saves → it calls CartSync.refresh()
 *          directly (localStorage doesn't fire a `storage` event in the tab
 *          that wrote it).
 *        • Returning to a backgrounded cart tab (`visibilitychange`) → refresh
 *          if the sync key moved while we were away — a catch-all.
 *
 *        The refresh hits GET /cart/fragment (which re-applies the current
 *        session location to the cart server-side) and swaps via CartRender.
 * Load:  after ui/cart-render.js (it calls window.CartRender.swap).
 */
(function () {
    'use strict';

    // Shared signal key. A writer bumps it to Date.now(); readers in OTHER
    // tabs get a `storage` event. Kept in one place so the modal and this
    // module can't drift on the string.
    var SYNC_KEY = 'eatndeal:cart-sync';

    // The last value we acted on, so visibilitychange doesn't refetch when
    // nothing actually changed while we were hidden.
    var lastSeen = readKey();
    var busy = false;

    function readKey() {
        try { return window.localStorage.getItem(SYNC_KEY) || ''; }
        catch (e) { return ''; }   // storage can throw in private mode
    }

    /**
     * hasCart — is there a cart region on THIS page to refresh? On every other
     * page the swap has nothing to target, so we skip the fetch entirely.
     * Type: READ (pure-ish).
     */
    function hasCart() {
        return !!document.querySelector('[data-cart-region]');
    }

    /**
     * refresh — re-fetch the cart's regions and swap them in. No-op when there
     * is no cart on the page, when one is already in flight, or when the cart
     * is empty (nothing to update from an address change).
     * Type: WRITE (network + DOM).
     */
    function refresh() {
        if (busy || !hasCart() || !window.CartRender) { return; }
        busy = true;
        fetch('/cart/fragment', {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            busy = false;
            if (env && env.data && env.data.html) {
                window.CartRender.swap(env.data.html);
            }
        }).catch(function () { busy = false; });
    }

    /**
     * broadcast — tell OTHER tabs that an address/location changed. Writing the
     * key fires a `storage` event everywhere except here, so this never
     * refreshes the current tab (the caller decides how to handle its own tab:
     * a location save reloads; an address save calls refresh()).
     * Type: WRITE (localStorage).
     */
    function broadcast() {
        var now = String(Date.now());
        try { window.localStorage.setItem(SYNC_KEY, now); } catch (e) { /* private mode — cross-tab sync simply won't fire */ }
        lastSeen = now;   // don't let our own write trigger a visibility refetch
    }

    // Another tab changed an address/location.
    window.addEventListener('storage', function (ev) {
        if (ev.key !== SYNC_KEY || !ev.newValue) { return; }
        lastSeen = ev.newValue;
        refresh();
    });

    // Coming back to a cart tab that was in the background while the change
    // happened — the storage event may have been missed if the tab was
    // discarded/throttled, so reconcile against the stored value.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') { return; }
        var cur = readKey();
        if (cur && cur !== lastSeen) { lastSeen = cur; refresh(); }
    });

    window.CartSync = { refresh: refresh, broadcast: broadcast };
})();
