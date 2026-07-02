/*
 * pages/community.js  (admin layer)
 *
 * What:  Drives the two community-group pages:
 *          • form — cover-image preview + a required-name guard.
 *          • list — delete (confirm modal) + inline status toggle.
 * Used:  extra_js for community/{form,list}.ejs.
 */
(function () {
    'use strict';

    var A = window.AdminApi;
    var U = window.AdminUi;
    var toast = U.showToastSafe;

    // ─────────────────────────── FORM ───────────────────────────
    var form = document.querySelector('[data-cm-form]');
    if (form) {
        // Cover-image preview.
        form.addEventListener('change', function (e) {
            var t = e.target;
            if (!t.matches('[data-img-input]')) { return; }
            var file = t.files && t.files[0];
            var prev = form.querySelector('[data-img-prev]');
            if (!file || !prev) { return; }
            if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { toast('error', 'Choose a PNG, JPG, WEBP or GIF.'); t.value = ''; return; }
            if (file.size > 3 * 1024 * 1024) { toast('error', 'Image must be under 3 MB.'); t.value = ''; return; }
            var img = prev.querySelector('[data-img-thumb]');
            if (!img) {
                var ph = prev.querySelector('[data-img-ph]'); if (ph) { ph.parentNode.removeChild(ph); }
                img = document.createElement('img'); img.setAttribute('data-img-thumb', ''); img.alt = ''; prev.appendChild(img);
            }
            if (window.URL && window.URL.createObjectURL) { img.src = window.URL.createObjectURL(file); }
        });

        form.addEventListener('submit', function (e) {
            var name = form.querySelector('[data-cm-name]');
            if (name && name.value.trim() === '') { e.preventDefault(); toast('error', 'Group name is required.'); name.focus(); }
        });

        // ── Type toggle: locations (user) vs company (restaurant) ──
        function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }
        var typeSel = form.querySelector('[data-cm-type]');
        var locSec  = form.querySelector('[data-cm-loc-section]');
        var coSec   = form.querySelector('[data-cm-co-section]');
        function syncType() {
            var t = typeSel ? typeSel.value : 'user';
            if (locSec) { locSec.hidden = (t !== 'user'); }
            if (coSec)  { coSec.hidden  = (t !== 'restaurant'); }
        }
        if (typeSel) { typeSel.addEventListener('change', syncType); syncType(); }

        // Shared mini-autocomplete: input → fetch(items) → click → onPick(item).
        function bindAc(opts) {
            var input = form.querySelector(opts.input), list = form.querySelector(opts.list);
            if (!input || !list) { return; }
            var deb = null;
            function hide() { list.hidden = true; list.innerHTML = ''; }
            input.addEventListener('input', function () {
                var q = input.value.trim();
                if (deb) { clearTimeout(deb); }
                if (q.length < opts.min) { hide(); return; }
                deb = setTimeout(function () {
                    opts.fetch(q).then(function (items) {
                        list.innerHTML = '';
                        (items || []).forEach(function (it) {
                            var li = document.createElement('li');
                            li.className = 'cm-ac__item';
                            li.textContent = opts.label(it);
                            li.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
                            li.addEventListener('click', function () { hide(); opts.pick(it); });
                            list.appendChild(li);
                        });
                        list.hidden = !(items && items.length);
                    });
                }, 250);
            });
            input.addEventListener('blur', function () { setTimeout(hide, 150); });
            return { input: input };
        }

        // ── Coverage areas (user groups) ──
        var locRadius = form.querySelector('[data-cm-loc-radius]');
        var locChips  = form.querySelector('[data-cm-loc-chips]');
        var locJson   = form.querySelector('[data-cm-loc-json]');
        var locs = [];
        try { locs = (locJson && locJson.value) ? JSON.parse(locJson.value) : []; } catch (e2) { locs = []; }
        function saveLocs() { if (locJson) { locJson.value = locs.length ? JSON.stringify(locs) : ''; } }
        function renderLocs() {
            if (!locChips) { return; }
            locChips.innerHTML = '';
            locs.forEach(function (l, i) {
                var li = document.createElement('li');
                li.className = 'cm-chip';
                li.innerHTML = '<span>' + esc(l.label || (l.lat + ', ' + l.lng)) + ' · ' + (l.radius_km || 25) + ' km</span>' +
                    '<button type="button" class="cm-chip__x" data-cm-loc-rm="' + i + '" aria-label="Remove">×</button>';
                locChips.appendChild(li);
            });
        }
        renderLocs();
        bindAc({
            input: '[data-cm-loc-input]', list: '[data-cm-loc-suggest]', min: 3,
            fetch: function (q) { return A.post('/community/loc-search', { query: q }).then(function (env) { return (env && env.data && env.data.suggestions) || []; }); },
            label: function (s) { return s.address || ''; },
            pick:  function (s) {
                A.post('/community/loc-resolve', { id: s.id }).then(function (env) {
                    var a = env && env.data && env.data.address;
                    if (!a || a.latitude == null || a.longitude == null) { toast('error', 'Could not locate that.'); return; }
                    var r = Math.max(1, Math.min(500, Number(locRadius && locRadius.value) || 25));
                    var lbl = (s.address || a.post_town || '').split(',').slice(0, 2).join(',').trim();
                    locs.push({ label: lbl, lat: Number(a.latitude), lng: Number(a.longitude), radius_km: r });
                    saveLocs(); renderLocs();
                    var li = form.querySelector('[data-cm-loc-input]'); if (li) { li.value = ''; }
                });
            },
        });
        if (locChips) {
            locChips.addEventListener('click', function (ev) {
                var b = ev.target.closest('[data-cm-loc-rm]'); if (!b) { return; }
                locs.splice(Number(b.getAttribute('data-cm-loc-rm')), 1); saveLocs(); renderLocs();
            });
        }

        // ── Company (restaurant groups) ──
        var coId = form.querySelector('[data-cm-co-id]'), coChosen = form.querySelector('[data-cm-co-chosen]');
        bindAc({
            input: '[data-cm-co-input]', list: '[data-cm-co-suggest]', min: 2,
            fetch: function (q) {
                return A.getJson('/community/companies?q=' + encodeURIComponent(q) + '&limit=10').then(function (env) {
                    var d = env && env.data; var arr = (d && (d.companies || d.items)) || d || [];
                    return Array.isArray(arr) ? arr : [];
                });
            },
            label: function (c) { return c.name || c.label || ('#' + c.id); },
            pick:  function (c) {
                if (coId) { coId.value = c.id; }
                if (coChosen) { coChosen.textContent = 'Selected: ' + (c.name || ('#' + c.id)); }
                var ci = form.querySelector('[data-cm-co-input]'); if (ci) { ci.value = c.name || ''; }
            },
        });
    }

    // ─────────────────────────── LIST ───────────────────────────
    var listRoot = document.querySelector('[data-cm-root]');
    if (listRoot) {
        var delId = null;
        listRoot.addEventListener('click', function (e) {
            var del = e.target.closest('[data-action="cm-delete"]');
            if (del) {
                delId = del.getAttribute('data-id');
                var msg = document.querySelector('[data-delete-msg]');
                if (msg) { msg.textContent = 'Delete "' + (del.getAttribute('data-name') || 'this group') + '"? This also removes its posts, comments and likes. This cannot be undone.'; }
                U.showModal('delete');
                return;
            }
        });
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="cm-modal-cancel"]')) { U.hideModals(); delId = null; return; }
            if (e.target.closest('[data-action="cm-delete-confirm"]')) {
                if (!delId) { return; }
                A.post('/community/delete', { id: delId }).then(function (res) {
                    U.hideModals();
                    if (A.isSuccess(res)) { toast('success', res.msg || 'Deleted.'); window.location.reload(); }
                    else { toast('error', res.msg || 'Could not delete.'); }
                });
                delId = null;
            }
        });
        listRoot.addEventListener('change', function (e) {
            var sel = e.target.closest('.cm-status');
            if (!sel) { return; }
            A.post('/community/status', { id: sel.getAttribute('data-id'), status: Number(sel.value) }).then(function (res) {
                if (A.isSuccess(res)) { toast('success', 'Status updated.'); }
                else { toast('error', res.msg || 'Could not update.'); }
            });
        });
    }

    // ─────────────────────────── FEED ───────────────────────────
    var feedRoot = document.querySelector('[data-cm-feed]');
    var IS_SUPER = feedRoot ? feedRoot.getAttribute('data-is-super') === '1' : false;
    if (feedRoot) { initFeed(feedRoot); }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function timeAgo(s) {
        s = String(s || ''); if (!s) { return ''; }
        var iso = s.indexOf('T') >= 0 ? s : s.replace(' ', 'T');
        if (!/[zZ]|[+\-]\d\d:?\d\d$/.test(iso)) { iso += 'Z'; }
        var d = new Date(iso); if (isNaN(d.getTime())) { return ''; }
        var sec = Math.floor((Date.now() - d.getTime()) / 1000);
        if (sec < 45) { return 'just now'; }
        if (sec < 3600) { return Math.floor(sec / 60) + 'm'; }
        if (sec < 86400) { return Math.floor(sec / 3600) + 'h'; }
        if (sec < 604800) { return Math.floor(sec / 86400) + 'd'; }
        return d.toLocaleDateString();
    }
    function paintTimes(scope) {
        (scope || document).querySelectorAll('.cf-post__time[data-time], .cf-comment__time[data-time]').forEach(function (t) {
            if (t.getAttribute('data-painted')) { return; }
            var r = timeAgo(t.getAttribute('data-time')); if (r) { t.textContent = r; t.setAttribute('data-painted', '1'); }
        });
    }
    // One comment bubble — a top-level comment OR a reply. Super-admin sees a 🗑.
    function buildBubble(c, isReply) {
        var del = IS_SUPER ? '<button type="button" class="cf-del cf-del--sm" data-action="cf-del-comment" title="Delete comment">🗑</button>' : '';
        return '<div class="cf-comment' + (isReply ? ' cf-comment--reply' : '') + '" data-comment-id="' + c.id + '">'
            + '<span class="cavatar cavatar--sm cavatar--t' + (c.author.tint || 0) + '" aria-hidden="true">' + esc(c.author.initial) + '</span>'
            + '<div class="cf-comment__bubble"><span class="cf-comment__author">' + esc(c.author.name) + (c.author.type === 'admin' ? '<span class="cm-tag cm-tag--restaurant">Admin</span>' : '') + '</span><span class="cf-comment__text">' + esc(c.body) + '</span>'
            + '<time class="cf-comment__time" data-time="' + esc(c.created_at) + '">' + timeAgo(c.created_at) + '</time></div>' + del + '</div>';
    }
    // A top-level comment + its replies + a Reply toggle/composer.
    function buildBlock(c, repliesHtml) {
        return '<div class="cf-comment-block" data-comment-block="' + c.id + '">'
            + buildBubble(c, false)
            + '<div class="cf-comment-replies" data-replies>' + (repliesHtml || '') + '</div>'
            + '<button type="button" class="cf-comment__reply" data-action="cf-reply-toggle">Reply</button>'
            + '<form class="cf-compose cf-compose--cmt cf-compose--reply" data-cf-reply-form hidden><input type="text" name="body" placeholder="Write a reply…" maxlength="2000" autocomplete="off" required><button type="submit" class="ly-btn ly-btn--ghost ly-btn--sm">Send</button></form>'
            + '</div>';
    }
    function renderComments(comments) {
        var byParent = {};
        comments.forEach(function (c) { if (c.parent_id) { (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c); } });
        return comments.filter(function (c) { return !c.parent_id; }).map(function (c) {
            var replies = (byParent[c.id] || []).map(function (r) { return buildBubble(r, true); }).join('');
            return buildBlock(c, replies);
        }).join('');
    }
    function buildPost(p) {
        var media = p.image_url ? '<div class="cf-post__media"><img src="' + esc(p.image_url) + '" alt="" loading="lazy"></div>' : '';
        var body = p.body ? '<p class="cf-post__body">' + esc(p.body) + '</p>' : '';
        var del = IS_SUPER ? '<button type="button" class="cf-del" data-action="cf-del-post" title="Delete post">🗑</button>' : '';
        return '<article class="cf-post" data-post-id="' + p.id + '">'
            + '<header class="cf-post__head"><span class="cavatar cavatar--t' + (p.author.tint || 0) + '" aria-hidden="true">' + esc(p.author.initial) + '</span>'
            + '<span class="cf-post__meta"><span class="cf-post__author">' + esc(p.author.name) + (p.author.type === 'admin' ? '<span class="cm-tag cm-tag--restaurant">Admin</span>' : '') + '</span>'
            + '<time class="cf-post__time" data-time="' + esc(p.created_at) + '">' + timeAgo(p.created_at) + '</time></span>'
            + del + '</header>'
            + body + media
            + '<div class="cf-post__stats"><span data-likes-n>' + (p.likes || 0) + '</span> like' + (Number(p.likes) === 1 ? '' : 's') + ' · <span data-comments-n>' + (p.comments || 0) + '</span> comment' + (Number(p.comments) === 1 ? '' : 's') + '</div>'
            + '<div class="cf-post__actions"><button type="button" class="cf-act" data-action="cf-comments">💬 Comments</button></div>'
            + '<div class="cf-comments" data-comments-wrap hidden><div class="cf-commentlist" data-comments-list></div>'
            + '<form class="cf-compose cf-compose--cmt" data-cf-comment-form><input type="text" name="body" placeholder="Write a comment…" maxlength="2000" autocomplete="off" required><button type="submit" class="ly-btn ly-btn--ghost ly-btn--sm">Send</button></form></div>'
            + '</article>';
    }

    function initFeed(root) {
        var GID = root.getAttribute('data-cm-feed');
        var delKind = null;   // 'post' | 'comment'
        var delId = null;

        // Compose a post (text + optional photo via FormData).
        var pform = root.querySelector('[data-cf-post-form]');
        if (pform) {
            var photoInput = pform.querySelector('[data-photo-input]');
            var preview = pform.querySelector('[data-photo-preview]');
            var previewImg = pform.querySelector('[data-photo-img]');
            if (photoInput) {
                photoInput.addEventListener('change', function () {
                    var f = photoInput.files && photoInput.files[0]; if (!f) { return; }
                    if (f.size > 4 * 1024 * 1024) { toast('error', 'Photo must be under 4 MB.'); photoInput.value = ''; return; }
                    previewImg.src = URL.createObjectURL(f); preview.hidden = false;
                });
            }
            pform.addEventListener('click', function (e) {
                if (e.target.closest('[data-action="cf-remove-photo"]')) { photoInput.value = ''; preview.hidden = true; previewImg.removeAttribute('src'); }
            });
            pform.addEventListener('submit', function (e) {
                e.preventDefault();
                var ta = pform.querySelector('.cf-compose__text');
                var body = (ta.value || '').trim();
                var hasPhoto = photoInput && photoInput.files && photoInput.files[0];
                if (!body && !hasPhoto) { toast('error', 'Write something or add a photo.'); return; }
                var btn = pform.querySelector('[data-cf-post-submit]'); btn.disabled = true;
                var fd = new FormData();
                fd.append('group_id', GID); fd.append('body', body);
                if (hasPhoto) { fd.append('image', photoInput.files[0]); }
                fetch('/community/post', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: fd })
                    .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
                    .then(function (res) {
                        btn.disabled = false;
                        if (!res || res.status !== 200) { toast('error', (res && res.msg) || 'Could not post.'); return; }
                        var d = res.data || {};
                        var post = { id: d.id || 0, body: body, image_url: d.image_url || '', likes: 0, comments: 0, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), author: d.author || { name: 'Admin', type: 'admin', initial: 'A', tint: 0 } };
                        var list = root.querySelector('[data-cf-list]');
                        list.insertAdjacentHTML('afterbegin', buildPost(post));
                        var empty = root.querySelector('[data-cf-empty]'); if (empty) { empty.remove(); }
                        ta.value = ''; if (photoInput) { photoInput.value = ''; } if (preview) { preview.hidden = true; }
                        paintTimes(list); toast('success', 'Posted.');
                    })
                    .catch(function () { btn.disabled = false; toast('error', 'Could not post.'); });
            });
        }

        // Delegated clicks (comments toggle / delete).
        root.addEventListener('click', function (e) {
            var act = e.target.closest('[data-action]'); if (!act || !root.contains(act)) { return; }
            var action = act.getAttribute('data-action');
            var card = act.closest('.cf-post');

            if (action === 'cf-comments' && card) {
                var wrap = card.querySelector('[data-comments-wrap]');
                wrap.hidden = !wrap.hidden;
                if (!wrap.hidden && !wrap.getAttribute('data-loaded')) { loadComments(card, wrap); }
                return;
            }
            if (action === 'cf-reply-toggle') {
                var blk = act.closest('[data-comment-block]');
                var rf = blk && blk.querySelector('[data-cf-reply-form]');
                if (rf) { rf.hidden = !rf.hidden; if (!rf.hidden) { var ri = rf.querySelector('input'); if (ri) { ri.focus(); } } }
                return;
            }
            if (action === 'cf-del-post' && card) { delKind = 'post'; delId = card.getAttribute('data-post-id'); U.showModal('cf-del'); return; }
            if (action === 'cf-del-comment') {
                var cm = act.closest('[data-comment-id]');
                if (cm) { delKind = 'comment'; delId = cm.getAttribute('data-comment-id'); U.showModal('cf-del'); }
                return;
            }
            if (action === 'cf-more') {
                var offset = Number(act.getAttribute('data-next-offset')) || 0;
                act.disabled = true; act.textContent = 'Loading…';
                A.getJson('/community/feed?group_id=' + encodeURIComponent(GID) + '&offset=' + offset + '&limit=15').then(function (res) {
                    var data = res && res.data; var posts = (data && data.posts) || [];
                    var list = root.querySelector('[data-cf-list]');
                    list.insertAdjacentHTML('beforeend', posts.map(buildPost).join('')); paintTimes(list);
                    var moreWrap = root.querySelector('[data-cf-more-wrap]');
                    if (data && data.has_more) { act.disabled = false; act.textContent = 'Load more'; act.setAttribute('data-next-offset', String(offset + posts.length)); }
                    else if (moreWrap) { moreWrap.hidden = true; }
                });
                return;
            }
        });

        // Delete confirm modal actions.
        document.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="cf-del-cancel"]')) { U.hideModals(); delKind = null; delId = null; return; }
            if (e.target.closest('[data-action="cf-del-confirm"]')) {
                if (!delId) { return; }
                var url = delKind === 'comment' ? '/community/comment-delete' : '/community/post-delete';
                var payload = delKind === 'comment' ? { comment_id: delId } : { post_id: delId };
                A.post(url, payload).then(function (res) {
                    U.hideModals();
                    if (!A.isSuccess(res)) { toast('error', res.msg || 'Could not delete.'); return; }
                    if (delKind === 'comment') {
                        var cm = root.querySelector('[data-comment-id="' + delId + '"]'); if (cm) { cm.remove(); }
                    } else {
                        var card = root.querySelector('.cf-post[data-post-id="' + delId + '"]'); if (card) { card.remove(); }
                    }
                    toast('success', res.msg || 'Removed.');
                    delKind = null; delId = null;
                });
            }
        });
        // NOTE: held/pending items are moderated on the dedicated Review queue
        // page (/community/review?group_id=…) — the feed's "Pending" button links
        // there. No in-feed moderation popup (per request).

        // Add a comment OR a reply (delegated submit).
        root.addEventListener('submit', function (e) {
            var isReply = false;
            var form = e.target.closest('[data-cf-comment-form]');
            if (!form) { form = e.target.closest('[data-cf-reply-form]'); isReply = !!form; }
            if (!form) { return; }
            e.preventDefault();
            var card = form.closest('.cf-post');
            var input = form.querySelector('input[name="body"]');
            var body = (input.value || '').trim(); if (!body) { return; }
            var block = isReply ? form.closest('[data-comment-block]') : null;
            var payload = { post_id: card.getAttribute('data-post-id'), body: body };
            if (isReply && block) { payload.parent_id = block.getAttribute('data-comment-block'); }
            A.post('/community/comment', payload).then(function (res) {
                if (!A.isSuccess(res)) { toast('error', res.msg || 'Could not comment.'); return; }
                if (isReply && block) {
                    block.querySelector('[data-replies]').insertAdjacentHTML('beforeend', buildBubble(res.data.comment, true));
                    form.hidden = true;
                } else {
                    card.querySelector('[data-comments-list]').insertAdjacentHTML('beforeend', buildBlock(res.data.comment, ''));
                }
                input.value = '';
                var n = card.querySelector('[data-comments-n]'); if (n) { n.textContent = res.data.comments; }
                paintTimes(card);
            });
        });

        function loadComments(card, wrap) {
            var listEl = wrap.querySelector('[data-comments-list]');
            listEl.innerHTML = '<p class="cf-loading">Loading…</p>';
            A.getJson('/community/comments?post_id=' + encodeURIComponent(card.getAttribute('data-post-id'))).then(function (res) {
                var cs = (res && res.data && res.data.comments) || [];
                listEl.innerHTML = cs.length ? renderComments(cs) : '<p class="cf-loading">No comments yet.</p>';
                wrap.setAttribute('data-loaded', '1'); paintTimes(listEl);
            });
        }

        paintTimes(document);
    }
})();
