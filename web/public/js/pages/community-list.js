/*
 * pages/community-list.js
 *
 * The Community LANDING (groups grid). Lets each person REMOVE a group they
 * don't want — it drops into a "Removed groups" section at the bottom — and
 * RESTORE it back to the top. The hidden set is personal + saved in
 * localStorage (keyed per signed-in user, or "guest"), so it needs no server
 * round-trip and works for guests too.
 * Used: extra_js for community/index.ejs.
 */
(function () {
    'use strict';

    var root = document.querySelector('[data-community-list]');
    if (!root) { return; }
    var mainList = root.querySelector('[data-main-list]');
    var removedSection = root.querySelector('[data-removed-section]');
    var removedList = root.querySelector('[data-removed-list]');
    if (!mainList || !removedSection || !removedList) { return; }

    var KEY = 'eatndeal:community:hidden:' + (root.getAttribute('data-uid') || 'guest');
    var X_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    var RESTORE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>';

    function read() { try { return (JSON.parse(localStorage.getItem(KEY) || '[]') || []).map(String); } catch (e) { return []; } }
    function write(arr) { try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) { /* storage off — degrade to this-page-only */ } }
    var hidden = read();

    function setBtn(card, isRemoved) {
        var btn = card.querySelector('[data-action="toggle-hide"]');
        if (!btn) { return; }
        btn.innerHTML = isRemoved ? RESTORE_SVG : X_SVG;
        btn.title = isRemoved ? 'Restore to my list' : 'Remove from my list';
        btn.setAttribute('aria-label', isRemoved ? 'Restore this group' : 'Remove this group');
        card.classList.toggle('is-removed', isRemoved);
    }
    function toRemoved(card) { removedList.appendChild(card); setBtn(card, true); }
    function toMain(card) { mainList.appendChild(card); setBtn(card, false); }
    function refresh() {
        removedSection.hidden = removedList.children.length === 0;
        var emptyHint = root.querySelector('[data-main-empty]');
        if (emptyHint) { emptyHint.hidden = mainList.children.length !== 0; }
    }

    // Apply the saved hidden set on load.
    hidden.forEach(function (id) {
        var card = mainList.querySelector('.cgroup-card[data-group-id="' + id + '"]');
        if (card) { toRemoved(card); }
    });
    refresh();

    root.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('[data-action="toggle-hide"]');
        if (!btn) { return; }
        e.preventDefault();
        e.stopPropagation();
        var card = btn.closest('.cgroup-card');
        if (!card) { return; }
        var id = String(card.getAttribute('data-group-id'));
        if (card.parentNode === removedList) {
            hidden = hidden.filter(function (x) { return x !== id; });
            toMain(card);
        } else {
            if (hidden.indexOf(id) === -1) { hidden.push(id); }
            toRemoved(card);
        }
        write(hidden);
        refresh();
    });
})();
