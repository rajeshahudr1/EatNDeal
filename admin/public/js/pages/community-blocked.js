/*
 * pages/community-blocked.js (admin) — block / unblock community customers.
 *
 * Search a customer (GET /community/customers) → block (POST /community/block);
 * the blocked list (GET /community/blocked-data) supports filter + unblock.
 */
(function () {
    'use strict';

    var A = window.AdminApi, U = window.AdminUi, toast = U.showToastSafe;
    var root = document.querySelector('[data-cm-blocked]');
    if (!root) { return; }
    var listEl  = root.querySelector('[data-blk-list]');
    var emptyEl = root.querySelector('[data-blk-empty]');

    function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

    // ── Customer search → block ──
    var searchEl  = root.querySelector('[data-blk-search]');
    var suggestEl = root.querySelector('[data-blk-suggest]');
    var deb = null;
    function hideSug() { if (suggestEl) { suggestEl.hidden = true; suggestEl.innerHTML = ''; } }

    if (searchEl && suggestEl) {
        searchEl.addEventListener('input', function () {
            var q = searchEl.value.trim();
            if (deb) { clearTimeout(deb); }
            if (q.length < 2) { hideSug(); return; }
            deb = setTimeout(function () {
                A.getJson('/community/customers?q=' + encodeURIComponent(q)).then(function (env) {
                    var cs = (env && env.data && env.data.customers) || [];
                    suggestEl.innerHTML = cs.map(function (c) {
                        return '<li class="cm-ac__item" data-cid="' + c.id + '" data-name="' + esc(c.name) + '">'
                            + esc(c.name) + ' <small>' + esc(c.email || c.contact || '') + '</small>'
                            + (c.blocked ? ' <span class="blk-tag">blocked</span>' : '') + '</li>';
                    }).join('');
                    suggestEl.hidden = cs.length === 0;
                });
            }, 250);
        });
        searchEl.addEventListener('blur', function () { setTimeout(hideSug, 150); });
        suggestEl.addEventListener('mousedown', function (e) {
            var li = e.target.closest('[data-cid]'); if (!li) { return; }
            e.preventDefault();
            block(li.getAttribute('data-cid'), li.getAttribute('data-name'));
        });
    }
    function block(cid, name) {
        A.post('/community/block', { customer_id: cid }).then(function (env) {
            if (!A.isSuccess(env)) { toast('error', env.msg || 'Could not block.'); return; }
            toast('success', (name || 'User') + ' blocked.');
            hideSug(); if (searchEl) { searchEl.value = ''; }
            load();
        });
    }

    // ── Blocked list ──
    function row(b) {
        return '<div class="blk-row" data-cid="' + b.customer_id + '">'
            + '<div class="blk-row__info"><strong>' + esc(b.name) + '</strong><small>' + esc(b.email || ('#' + b.customer_id)) + '</small></div>'
            + '<button type="button" class="ly-btn ly-btn--ghost ly-btn--sm" data-blk-unblock="' + b.customer_id + '">Unblock</button></div>';
    }
    function render(rows) { listEl.innerHTML = (rows || []).map(row).join(''); if (emptyEl) { emptyEl.hidden = (rows && rows.length > 0); } }
    function load(q) {
        A.getJson('/community/blocked-data' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (env) {
            render((env && env.data && env.data.blocked) || []);
        }).catch(function () { toast('error', 'Could not load blocked users.'); });
    }

    var lsearch = root.querySelector('[data-blk-listsearch]'), lt = null;
    if (lsearch) { lsearch.addEventListener('input', function () { if (lt) { clearTimeout(lt); } lt = setTimeout(function () { load(lsearch.value.trim()); }, 300); }); }

    listEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-blk-unblock]'); if (!btn) { return; }
        btn.disabled = true;
        A.post('/community/unblock', { customer_id: btn.getAttribute('data-blk-unblock') }).then(function (env) {
            if (!A.isSuccess(env)) { btn.disabled = false; toast('error', env.msg || 'Could not unblock.'); return; }
            toast('success', 'Unblocked.');
            var r = btn.closest('.blk-row'); if (r) { r.remove(); }
            if (!listEl.querySelector('.blk-row') && emptyEl) { emptyEl.hidden = false; }
        }).catch(function () { btn.disabled = false; toast('error', 'Could not unblock.'); });
    });

    load();
})();
