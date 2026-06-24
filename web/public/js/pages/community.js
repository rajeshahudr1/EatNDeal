/*
 * pages/community.js
 *
 * What:  Drives a COMMUNITY group feed (views/community/group.ejs):
 *          • composer  — text + one photo → POST /community/post (FormData)
 *          • like      — POST /community/like (optimistic toggle)
 *          • comments  — lazy-load + add via /community/comments + /community/comment
 *          • load-more — append the next page from /community/feed
 *          • share     — native share sheet / copy-link
 *        Newly built cards mirror partials/community-post.ejs exactly, so the
 *        two must change together.
 * Why:   Signed-out visitors can READ everything; any write bounces to
 *        /signin (the web returns a 401 envelope for guests).
 * Used:  extra_js for community/group.ejs.
 */
(function () {
    'use strict';

    var root = document.querySelector('[data-community-group]');
    if (!root) { return; }
    var GROUP_ID = root.getAttribute('data-community-group');
    var CAN_POST = root.getAttribute('data-can-post') === '1';
    var MY_ID = root.getAttribute('data-me-id') || '0';
    function confirmAsk(opts) {
        if (window.EatNDealUi && window.EatNDealUi.confirmDialog) { return window.EatNDealUi.confirmDialog(opts); }
        return Promise.resolve(true);
    }

    var EF = window.EatNDealFormat || {};
    var esc = EF.esc || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
    var fmtDate = EF.fmtDate || function (d) { var x = new Date(d); return isNaN(x.getTime()) ? '' : x.toLocaleDateString(); };
    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (t, m) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(t, m); } };

    // Bare 'YYYY-MM-DD HH:MM:SS' from the api is UTC (server stamps toISOString);
    // assume UTC when no zone is present so "2h ago" is right across timezones.
    function parseTs(s) {
        s = String(s || ''); if (!s) { return null; }
        var iso = s.indexOf('T') >= 0 ? s : s.replace(' ', 'T');
        if (!/[zZ]|[+\-]\d\d:?\d\d$/.test(iso)) { iso += 'Z'; }
        var d = new Date(iso); return isNaN(d.getTime()) ? null : d;
    }
    function timeAgo(s) {
        var d = parseTs(s); if (!d) { return ''; }
        var sec = Math.floor((Date.now() - d.getTime()) / 1000);
        if (sec < 45) { return 'just now'; }
        if (sec < 3600) { return Math.floor(sec / 60) + 'm'; }
        if (sec < 86400) { return Math.floor(sec / 3600) + 'h'; }
        if (sec < 604800) { return Math.floor(sec / 86400) + 'd'; }
        return fmtDate(s);
    }
    function paintTimes(scope) {
        (scope || document).querySelectorAll('.cpost__time[data-time], .ccomment__time[data-time]').forEach(function (t) {
            if (t.getAttribute('data-painted')) { return; }
            var rel = timeAgo(t.getAttribute('data-time'));
            if (rel) { t.textContent = rel; t.setAttribute('data-painted', '1'); }
        });
    }

    function bounceToSignin() {
        var here = window.location.pathname + window.location.search;
        window.location.href = '/signin?next=' + encodeURIComponent(here);
    }
    function postJson(url, body) {
        return fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return { status: 0 }; }); });
    }

    // ── Builders (keep in sync with partials/community-post.ejs) ──────
    var SEND_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    // One comment bubble (a top-level comment OR a reply). Own ones get a 🗑.
    function buildBubble(c, isReply) {
        var mine = c.author.type === 'customer' && String(c.author.id) === MY_ID;
        var del = mine ? '<button type="button" class="ccomment__del" data-action="delete-comment" title="Delete" aria-label="Delete your comment">🗑</button>' : '';
        return '<div class="ccomment' + (isReply ? ' ccomment--reply' : '') + '" data-comment-id="' + c.id + '">'
            + '<span class="cavatar cavatar--sm cavatar--t' + (c.author.tint || 0) + '" aria-hidden="true">' + esc(c.author.initial) + '</span>'
            + '<div class="ccomment__bubble"><span class="ccomment__author">' + esc(c.author.name)
            + (c.author.type === 'admin' ? '<span class="cpost__tag">Restaurant</span>' : '')
            + '</span><span class="ccomment__text">' + esc(c.body) + '</span>'
            + '<time class="ccomment__time" data-time="' + esc(c.created_at) + '">' + timeAgo(c.created_at) + '</time></div>' + del + '</div>';
    }
    // A top-level comment + its replies + (signed-in) a Reply toggle/composer.
    function buildBlock(c, repliesHtml) {
        var replyUi = CAN_POST
            ? '<button type="button" class="ccomment__reply" data-action="reply-toggle">Reply</button>'
              + '<form class="ccompose ccompose--reply" data-reply-form hidden><input type="text" class="ccompose__input" name="body" placeholder="Write a reply…" maxlength="2000" autocomplete="off" required><button type="submit" class="ccompose__send" aria-label="Send reply">' + SEND_SVG + '</button></form>'
            : '';
        return '<div class="ccomment-block" data-comment-block="' + c.id + '">'
            + buildBubble(c, false)
            + '<div class="ccomment-replies" data-replies>' + (repliesHtml || '') + '</div>'
            + replyUi + '</div>';
    }
    // Group a flat comment list into top-level blocks with nested replies.
    function renderComments(comments) {
        var byParent = {};
        comments.forEach(function (c) { if (c.parent_id) { (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c); } });
        return comments.filter(function (c) { return !c.parent_id; }).map(function (c) {
            var replies = (byParent[c.id] || []).map(function (r) { return buildBubble(r, true); }).join('');
            return buildBlock(c, replies);
        }).join('');
    }
    function buildPost(p, canPost) {
        var liked = !!p.liked;
        var mine = canPost && p.author.type === 'customer' && String(p.author.id) === MY_ID;
        var delBtn = mine ? '<button type="button" class="cpost__del" data-action="delete-post" title="Delete" aria-label="Delete your post">🗑</button>' : '';
        var media = p.image_url ? '<div class="cpost__media"><img src="' + esc(p.image_url) + '" alt="" loading="lazy"></div>' : '';
        var bodyHtml = p.body ? '<p class="cpost__body">' + esc(p.body) + '</p>' : '';
        var statsHidden = (p.likes || p.comments) ? '' : ' hidden';
        var composer = canPost
            ? '<form class="ccompose ccompose--comment" data-comment-form><input type="text" class="ccompose__input" name="body" placeholder="Write a comment…" maxlength="2000" autocomplete="off" required><button type="submit" class="ccompose__send" aria-label="Send comment"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></form>'
            : '<p class="cpost__signin"><a href="/signin">Sign in</a> to comment.</p>';
        return '<article class="cpost" data-post-id="' + p.id + '" data-liked="' + (liked ? '1' : '0') + '">'
            + '<header class="cpost__head"><span class="cavatar cavatar--t' + (p.author.tint || 0) + '" aria-hidden="true">' + esc(p.author.initial) + '</span>'
            + '<span class="cpost__meta"><span class="cpost__author">' + esc(p.author.name)
            + (p.author.type === 'admin' ? '<span class="cpost__tag">Restaurant</span>' : '')
            + '</span><time class="cpost__time" data-time="' + esc(p.created_at) + '">' + timeAgo(p.created_at) + '</time></span>' + delBtn + '</header>'
            + bodyHtml + media
            + '<div class="cpost__stats"' + statsHidden + '><span class="cpost__stat" data-likes-line><span data-likes-n>' + (p.likes || 0) + '</span> like' + (Number(p.likes) === 1 ? '' : 's') + '</span>'
            + '<span class="cpost__stat" data-comments-line><span data-comments-n>' + (p.comments || 0) + '</span> comment' + (Number(p.comments) === 1 ? '' : 's') + '</span></div>'
            + '<div class="cpost__actions"><button type="button" class="cact ' + (liked ? 'is-on' : '') + '" data-action="like" aria-pressed="' + (liked ? 'true' : 'false') + '"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg><span>Like</span></button>'
            + '<button type="button" class="cact" data-action="comments"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-4-1L3 20l1.1-4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg><span>Comment</span></button>'
            + '<button type="button" class="cact" data-action="share"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg><span>Share</span></button></div>'
            + '<div class="cpost__comments" data-comments-wrap hidden><div class="cpost__commentlist" data-comments-list></div>' + composer + '</div>'
            + '</article>';
    }

    // ── Composer: photo preview ──────────────────────────────────────
    var postForm = root.querySelector('[data-post-form]');
    if (postForm) {
        var photoInput = postForm.querySelector('[data-photo-input]');
        var preview = postForm.querySelector('[data-photo-preview]');
        var previewImg = postForm.querySelector('[data-photo-img]');
        photoInput && photoInput.addEventListener('change', function () {
            var f = photoInput.files && photoInput.files[0];
            if (!f) { return; }
            if (f.size > 4 * 1024 * 1024) { toast('error', 'Photo must be under 4 MB.'); photoInput.value = ''; return; }
            previewImg.src = URL.createObjectURL(f);
            preview.hidden = false;
        });
        postForm.addEventListener('click', function (e) {
            if (e.target.closest('[data-action="remove-photo"]')) {
                photoInput.value = ''; preview.hidden = true; previewImg.removeAttribute('src');
            }
        });
        postForm.addEventListener('submit', function (e) {
            e.preventDefault();
            if (!CAN_POST) { bounceToSignin(); return; }
            var ta = postForm.querySelector('.ccompose__text');
            var text = (ta.value || '').trim();
            var hasPhoto = photoInput && photoInput.files && photoInput.files[0];
            if (!text && !hasPhoto) { toast('error', 'Write something or add a photo.'); return; }
            var btn = postForm.querySelector('[data-post-submit]');
            btn.disabled = true; btn.textContent = 'Posting…';

            var fd = new FormData();
            fd.append('group_id', GROUP_ID);
            fd.append('body', text);
            if (hasPhoto) { fd.append('image', photoInput.files[0]); }

            fetch('/community/post', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: fd })
                .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
                .then(function (env) {
                    btn.disabled = false; btn.textContent = 'Post';
                    if (env.status === 401) { bounceToSignin(); return; }
                    if (env.status !== 200) { toast('error', env.msg || 'Could not post.'); return; }
                    // Build the new card optimistically from what we submitted
                    // (identity comes from the data-me-* attrs on the root).
                    var post = {
                        id: (env.data && env.data.id) || 0, body: text,
                        image_url: hasPhoto ? URL.createObjectURL(photoInput.files[0]) : '',
                        likes: 0, comments: 0, liked: false,
                        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                        author: {
                            name: root.getAttribute('data-me-name') || 'You', type: 'customer',
                            initial: root.getAttribute('data-me-initial') || 'Y',
                            tint: Number(root.getAttribute('data-me-tint')) || 0,
                        },
                    };
                    var list = root.querySelector('[data-feed-list]');
                    list.insertAdjacentHTML('afterbegin', buildPost(post, true));
                    var empty = root.querySelector('[data-feed-empty]'); if (empty) { empty.remove(); }
                    ta.value = ''; if (photoInput) { photoInput.value = ''; }
                    var prev = postForm.querySelector('[data-photo-preview]'); if (prev) { prev.hidden = true; }
                    paintTimes(list);
                    toast('success', 'Posted.');
                })
                .catch(function () { btn.disabled = false; btn.textContent = 'Post'; toast('error', 'Could not post.'); });
        });
    }

    // ── Delegated actions on posts (like / comments / share) ─────────
    root.addEventListener('click', function (e) {
        var act = e.target.closest && e.target.closest('[data-action]');
        if (!act || !root.contains(act)) { return; }
        var action = act.getAttribute('data-action');
        var card = act.closest('.cpost');

        if (action === 'share-group') { sharePost(null); return; }

        if (action === 'like' && card) {
            if (!CAN_POST) { bounceToSignin(); return; }
            var pid = card.getAttribute('data-post-id');
            act.disabled = true;
            postJson('/community/like', { post_id: pid }).then(function (env) {
                act.disabled = false;
                if (env.status === 401) { bounceToSignin(); return; }
                if (env.status !== 200 || !env.data) { toast('error', env.msg || 'Could not like.'); return; }
                var liked = !!env.data.liked;
                act.classList.toggle('is-on', liked);
                act.setAttribute('aria-pressed', liked ? 'true' : 'false');
                card.setAttribute('data-liked', liked ? '1' : '0');
                var stats = card.querySelector('.cpost__stats');
                var n = card.querySelector('[data-likes-n]');
                if (n) { n.textContent = env.data.likes; n.parentNode.childNodes[1].textContent = ' like' + (Number(env.data.likes) === 1 ? '' : 's'); }
                refreshStatsVisibility(card, stats);
            }).catch(function () { act.disabled = false; toast('error', 'Could not like.'); });
            return;
        }

        if (action === 'comments' && card) {
            var wrap = card.querySelector('[data-comments-wrap]');
            if (!wrap) { return; }
            wrap.hidden = !wrap.hidden;
            if (!wrap.hidden && !wrap.getAttribute('data-loaded')) {
                loadComments(card, wrap);
            }
            return;
        }

        if (action === 'reply-toggle') {
            if (!CAN_POST) { bounceToSignin(); return; }
            var blk = act.closest('[data-comment-block]');
            var rf = blk && blk.querySelector('[data-reply-form]');
            if (rf) { rf.hidden = !rf.hidden; if (!rf.hidden) { var ri = rf.querySelector('input'); if (ri) { ri.focus(); } } }
            return;
        }

        if (action === 'share' && card) {
            sharePost(card);
            return;
        }

        if (action === 'delete-post' && card) {
            confirmAsk({ title: 'Delete post?', message: 'This permanently removes your post.', okLabel: 'Delete', cancelLabel: 'Cancel' }).then(function (ok) {
                if (!ok) { return; }
                postJson('/community/post-delete', { post_id: card.getAttribute('data-post-id') }).then(function (env) {
                    if (env.status === 401) { bounceToSignin(); return; }
                    if (env.status !== 200) { toast('error', env.msg || 'Could not delete.'); return; }
                    card.remove(); toast('success', 'Post deleted.');
                });
            });
            return;
        }

        if (action === 'delete-comment') {
            var cmt = act.closest('[data-comment-id]');
            if (!cmt || !card) { return; }
            confirmAsk({ title: 'Delete comment?', message: 'This permanently removes your comment.', okLabel: 'Delete', cancelLabel: 'Cancel' }).then(function (ok) {
                if (!ok) { return; }
                postJson('/community/comment-delete', { comment_id: cmt.getAttribute('data-comment-id') }).then(function (env) {
                    if (env.status === 401) { bounceToSignin(); return; }
                    if (env.status !== 200) { toast('error', env.msg || 'Could not delete.'); return; }
                    cmt.remove();
                    var n = card.querySelector('[data-comments-n]'); if (n && env.data) { n.textContent = env.data.comments; }
                    toast('success', 'Comment deleted.');
                });
            });
            return;
        }
    });

    // ── Add comment (delegated submit) ───────────────────────────────
    root.addEventListener('submit', function (e) {
        var isReply = false;
        var form = e.target.closest && e.target.closest('[data-comment-form]');
        if (!form) { form = e.target.closest && e.target.closest('[data-reply-form]'); isReply = !!form; }
        if (!form) { return; }
        e.preventDefault();
        if (!CAN_POST) { bounceToSignin(); return; }
        var card = form.closest('.cpost');
        var input = form.querySelector('input[name="body"]');
        var body = (input.value || '').trim();
        if (!body) { return; }
        var block = isReply ? form.closest('[data-comment-block]') : null;
        var payload = { post_id: card.getAttribute('data-post-id'), body: body };
        if (isReply && block) { payload.parent_id = block.getAttribute('data-comment-block'); }
        var send = form.querySelector('.ccompose__send'); if (send) { send.disabled = true; }
        postJson('/community/comment', payload).then(function (env) {
            if (send) { send.disabled = false; }
            if (env.status === 401) { bounceToSignin(); return; }
            if (env.status !== 200 || !env.data) { toast('error', env.msg || 'Could not comment.'); return; }
            if (isReply && block) {
                block.querySelector('[data-replies]').insertAdjacentHTML('beforeend', buildBubble(env.data.comment, true));
                form.hidden = true;
            } else {
                card.querySelector('[data-comments-list]').insertAdjacentHTML('beforeend', buildBlock(env.data.comment, ''));
            }
            input.value = '';
            var n = card.querySelector('[data-comments-n]');
            if (n) { n.textContent = env.data.comments; n.parentNode.childNodes[1].textContent = ' comment' + (Number(env.data.comments) === 1 ? '' : 's'); }
            refreshStatsVisibility(card, card.querySelector('.cpost__stats'));
            paintTimes(card);
        }).catch(function () { if (send) { send.disabled = false; } toast('error', 'Could not comment.'); });
    });

    function refreshStatsVisibility(card, stats) {
        if (!stats) { return; }
        var likes = Number((card.querySelector('[data-likes-n]') || {}).textContent) || 0;
        var comments = Number((card.querySelector('[data-comments-n]') || {}).textContent) || 0;
        stats.hidden = !(likes || comments);
    }

    function loadComments(card, wrap) {
        var listEl = wrap.querySelector('[data-comments-list]');
        listEl.innerHTML = '<p class="cpost__loading">Loading…</p>';
        fetch('/community/comments?post_id=' + encodeURIComponent(card.getAttribute('data-post-id')), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (env) {
                var cs = (env && env.data && env.data.comments) || [];
                listEl.innerHTML = cs.length ? renderComments(cs) : '<p class="cpost__loading">No comments yet.</p>';
                wrap.setAttribute('data-loaded', '1');
                paintTimes(listEl);
            })
            .catch(function () { listEl.innerHTML = '<p class="cpost__loading">Could not load comments.</p>'; });
    }

    function sharePost(card) {
        var url = window.location.origin + '/community/g/' + GROUP_ID;
        var title = (document.querySelector('.cgroup-bar__name') || {}).textContent || 'Community';
        if (navigator.share) {
            navigator.share({ title: title, text: 'Check out this post on ' + title, url: url }).catch(function () {});
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { toast('success', 'Link copied.'); }).catch(function () { toast('error', 'Could not copy link.'); });
        } else {
            toast('info', url);
        }
    }

    // ── Load more ────────────────────────────────────────────────────
    root.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('[data-action="load-more"]');
        if (!btn) { return; }
        var offset = Number(btn.getAttribute('data-next-offset')) || 0;
        btn.disabled = true; btn.textContent = 'Loading…';
        fetch('/community/feed?group_id=' + encodeURIComponent(GROUP_ID) + '&offset=' + offset + '&limit=15', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (env) {
                var data = env && env.data;
                var posts = (data && data.posts) || [];
                var list = root.querySelector('[data-feed-list]');
                list.insertAdjacentHTML('beforeend', posts.map(function (p) { return buildPost(p, CAN_POST); }).join(''));
                paintTimes(list);
                var moreWrap = root.querySelector('[data-more-wrap]');
                if (data && data.has_more) {
                    btn.disabled = false; btn.textContent = 'Load more posts';
                    btn.setAttribute('data-next-offset', String(offset + posts.length));
                } else if (moreWrap) {
                    moreWrap.hidden = true;
                }
            })
            .catch(function () { btn.disabled = false; btn.textContent = 'Load more posts'; });
    });

    // First paint of relative times on the SSR posts.
    paintTimes(document);
})();
