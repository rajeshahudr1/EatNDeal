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
    function buildComment(c) {
        return '<div class="cf-comment" data-comment-id="' + c.id + '">'
            + '<span class="cavatar cavatar--sm cavatar--t' + (c.author.tint || 0) + '" aria-hidden="true">' + esc(c.author.initial) + '</span>'
            + '<div class="cf-comment__bubble"><span class="cf-comment__author">' + esc(c.author.name) + '</span><span class="cf-comment__text">' + esc(c.body) + '</span>'
            + '<time class="cf-comment__time" data-time="' + esc(c.created_at) + '">' + timeAgo(c.created_at) + '</time></div>'
            + '<button type="button" class="cf-del cf-del--sm" data-action="cf-del-comment" title="Delete comment">🗑</button></div>';
    }
    function buildPost(p) {
        var media = p.image_url ? '<div class="cf-post__media"><img src="' + esc(p.image_url) + '" alt="" loading="lazy"></div>' : '';
        var body = p.body ? '<p class="cf-post__body">' + esc(p.body) + '</p>' : '';
        return '<article class="cf-post" data-post-id="' + p.id + '">'
            + '<header class="cf-post__head"><span class="cavatar cavatar--t' + (p.author.tint || 0) + '" aria-hidden="true">' + esc(p.author.initial) + '</span>'
            + '<span class="cf-post__meta"><span class="cf-post__author">' + esc(p.author.name) + (p.author.type === 'admin' ? '<span class="cm-tag cm-tag--restaurant">Admin</span>' : '') + '</span>'
            + '<time class="cf-post__time" data-time="' + esc(p.created_at) + '">' + timeAgo(p.created_at) + '</time></span>'
            + '<button type="button" class="cf-del" data-action="cf-del-post" title="Delete post">🗑</button></header>'
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

        // Compose a post.
        var pform = root.querySelector('[data-cf-post-form]');
        if (pform) {
            pform.addEventListener('submit', function (e) {
                e.preventDefault();
                var ta = pform.querySelector('.cf-compose__text');
                var body = (ta.value || '').trim();
                if (!body) { toast('error', 'Write something to post.'); return; }
                var btn = pform.querySelector('[data-cf-post-submit]'); btn.disabled = true;
                A.post('/community/post', { group_id: GID, body: body }).then(function (res) {
                    btn.disabled = false;
                    if (!A.isSuccess(res)) { toast('error', res.msg || 'Could not post.'); return; }
                    var d = res.data || {};
                    var post = { id: d.id || 0, body: body, image_url: '', likes: 0, comments: 0, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), author: d.author || { name: 'Admin', type: 'admin', initial: 'A', tint: 0 } };
                    var list = root.querySelector('[data-cf-list]');
                    list.insertAdjacentHTML('afterbegin', buildPost(post));
                    var empty = root.querySelector('[data-cf-empty]'); if (empty) { empty.remove(); }
                    ta.value = ''; paintTimes(list); toast('success', 'Posted.');
                });
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

        // Add a comment (delegated submit).
        root.addEventListener('submit', function (e) {
            var form = e.target.closest('[data-cf-comment-form]'); if (!form) { return; }
            e.preventDefault();
            var card = form.closest('.cf-post');
            var input = form.querySelector('input[name="body"]');
            var body = (input.value || '').trim(); if (!body) { return; }
            A.post('/community/comment', { post_id: card.getAttribute('data-post-id'), body: body }).then(function (res) {
                if (!A.isSuccess(res)) { toast('error', res.msg || 'Could not comment.'); return; }
                var listEl = card.querySelector('[data-comments-list]');
                listEl.insertAdjacentHTML('beforeend', buildComment(res.data.comment));
                input.value = '';
                var n = card.querySelector('[data-comments-n]'); if (n) { n.textContent = res.data.comments; }
                paintTimes(listEl);
            });
        });

        function loadComments(card, wrap) {
            var listEl = wrap.querySelector('[data-comments-list]');
            listEl.innerHTML = '<p class="cf-loading">Loading…</p>';
            A.getJson('/community/comments?post_id=' + encodeURIComponent(card.getAttribute('data-post-id'))).then(function (res) {
                var cs = (res && res.data && res.data.comments) || [];
                listEl.innerHTML = cs.length ? cs.map(buildComment).join('') : '<p class="cf-loading">No comments yet.</p>';
                wrap.setAttribute('data-loaded', '1'); paintTimes(listEl);
            });
        }

        paintTimes(document);
    }
})();
