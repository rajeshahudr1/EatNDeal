/*
 * pages/community-review.js (admin) — AI-moderation review queue.
 *
 * Two tabs: Pending (held items) and Rejected (so a super-admin can revisit and
 * re-approve). Loads from GET /community/pending?status=…, approves/rejects via
 * POST /community/moderate.
 */
(function () {
    'use strict';

    var A = window.AdminApi, U = window.AdminUi, toast = U.showToastSafe;
    var root = document.querySelector('[data-cmrev]');
    if (!root) { return; }
    var listEl   = root.querySelector('[data-cmrev-list]');
    var emptyEl  = root.querySelector('[data-cmrev-empty]');
    var emptyMsg = root.querySelector('[data-cmrev-emptymsg]');
    var groupSel = root.querySelector('[data-cmrev-group]');
    var searchEl = root.querySelector('[data-cmrev-search]');
    var status   = 'pending';
    // Honour ?group_id= passed from a group feed's "Pending" link.
    var groupId  = (new URLSearchParams(window.location.search)).get('group_id') || '';
    var q        = '';
    var searchTimer = null;
    var groupsLoaded = false;

    function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

    function card(it) {
        var img = it.image_url ? '<div class="cmrev-card__img"><img src="' + esc(it.image_url) + '" alt=""></div>' : '';
        var acts = (status === 'rejected')
            ? '<span class="cmrev-card__rej">Rejected</span><button type="button" class="ly-btn ly-btn--primary ly-btn--sm" data-cmrev-act="approve">Re-approve</button>'
            : '<button type="button" class="ly-btn ly-btn--ghost ly-btn--sm" data-cmrev-act="reject">Reject</button>'
              + '<button type="button" class="ly-btn ly-btn--primary ly-btn--sm" data-cmrev-act="approve">Approve</button>';
        return '<article class="cmrev-card" data-kind="' + esc(it.kind) + '" data-id="' + esc(it.id) + '">'
            + '<div class="cmrev-card__head">'
            +   '<span class="cmrev-card__type">' + (it.kind === 'comment' ? '💬 Comment' : '📝 Post') + '</span>'
            +   '<span class="cmrev-card__group">' + esc(it.group_name || '—') + '</span>'
            + '</div>'
            + '<div class="cmrev-card__by">' + esc(it.author_name || 'Member') + '</div>'
            + (it.body ? '<p class="cmrev-card__body">' + esc(it.body) + '</p>' : '')
            + img
            + (it.ai_reason ? '<p class="cmrev-card__reason">🤖 ' + esc(it.ai_reason) + '</p>' : '')
            + '<div class="cmrev-card__acts">' + acts + '</div></article>';
    }

    function render(items) {
        listEl.innerHTML = (items || []).map(card).join('');
        if (emptyEl)  { emptyEl.hidden = (items && items.length > 0); }
        if (emptyMsg) { emptyMsg.textContent = (status === 'rejected') ? 'No rejected items.' : 'Nothing waiting for review.'; }
    }

    function populateGroups(groups) {
        if (!groupSel || groupsLoaded) { return; }   // populate once from the first load
        groupSel.innerHTML = '<option value="">All groups</option>' + (groups || []).map(function (g) {
            return '<option value="' + g.id + '">' + esc(g.name) + '</option>';
        }).join('');
        if (groupId) { groupSel.value = String(groupId); }   // reflect ?group_id= in the dropdown
        groupsLoaded = true;
    }

    function load() {
        var qs = 'status=' + status
            + (groupId ? '&group_id=' + encodeURIComponent(groupId) : '')
            + (q ? '&q=' + encodeURIComponent(q) : '');
        A.getJson('/community/pending?' + qs).then(function (env) {
            var data = (env && env.data) || {};
            render(data.items || []);
            populateGroups(data.groups || []);
        }).catch(function () { toast('error', 'Could not load the queue.'); });
    }

    var pendingReject = null;   // { cardEl } awaiting a reason from the modal

    // Send an approve/reject to the API + drop the card on success.
    function doModerate(cardEl, action, reason) {
        if (!cardEl) { return; }
        var btns = cardEl.querySelectorAll('[data-cmrev-act]');
        btns.forEach(function (b) { b.disabled = true; });
        A.post('/community/moderate', { id: cardEl.getAttribute('data-id'), kind: cardEl.getAttribute('data-kind'), action: action, reason: reason || '' }).then(function (env) {
            if (!A.isSuccess(env)) { btns.forEach(function (b) { b.disabled = false; }); toast('error', env.msg || 'Could not update.'); return; }
            cardEl.parentNode.removeChild(cardEl);
            toast('success', action === 'approve' ? 'Approved.' : 'Rejected.');
            if (!listEl.querySelector('.cmrev-card') && emptyEl) { emptyEl.hidden = false; }
        }).catch(function () { btns.forEach(function (b) { b.disabled = false; }); toast('error', 'Could not update.'); });
    }

    root.addEventListener('click', function (e) {
        var tab = e.target.closest('[data-cmrev-tab]');
        if (tab) {
            status = tab.getAttribute('data-cmrev-tab');
            root.querySelectorAll('[data-cmrev-tab]').forEach(function (t) { t.classList.toggle('is-active', t === tab); });
            load();
            return;
        }
        // Reject reason modal — confirm / cancel.
        if (e.target.closest('[data-reject-cancel]')) { U.hideModals(); pendingReject = null; return; }
        if (e.target.closest('[data-reject-confirm]')) {
            var ta = root.querySelector('[data-reject-reason]');
            if (pendingReject) { doModerate(pendingReject.cardEl, 'reject', ta ? ta.value.trim() : ''); }
            U.hideModals(); pendingReject = null;
            return;
        }
        var btn = e.target.closest('[data-cmrev-act]');
        if (!btn) { return; }
        var cardEl = btn.closest('.cmrev-card');
        var action = btn.getAttribute('data-cmrev-act');
        // Reject → ask for a reason first (the author sees it). Approve → straight through.
        if (action === 'reject') {
            pendingReject = { cardEl: cardEl };
            var rta = root.querySelector('[data-reject-reason]'); if (rta) { rta.value = ''; }
            U.showModal('reject-reason');
            setTimeout(function () { if (rta) { rta.focus(); } }, 50);
            return;
        }
        doModerate(cardEl, action, '');
    });

    if (groupSel) { groupSel.addEventListener('change', function () { groupId = groupSel.value; load(); }); }
    if (searchEl) {
        searchEl.addEventListener('input', function () {
            if (searchTimer) { clearTimeout(searchTimer); }
            searchTimer = setTimeout(function () { q = searchEl.value.trim(); load(); }, 300);
        });
    }

    load();
})();
