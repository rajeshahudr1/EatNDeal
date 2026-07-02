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
        var statusBanner = '';
        if (p.rejected) {
            statusBanner = '<div class="cpost__status cpost__status--rejected"><strong>🚫 Rejected.</strong> Only you can see this.'
                + (p.ai_reason ? ' <span>Reason: ' + esc(p.ai_reason) + '</span>' : '') + '</div>';
        } else if (p.pending) {
            statusBanner = '<div class="cpost__status cpost__status--pending"><strong>⏳ Pending review.</strong> Only you can see this until a moderator approves it.'
                + (p.ai_reason ? ' <span>(' + esc(p.ai_reason) + ')</span>' : '') + '</div>';
        }
        var composer = canPost
            ? '<form class="ccompose ccompose--comment" data-comment-form><input type="text" class="ccompose__input" name="body" placeholder="Write a comment…" maxlength="2000" autocomplete="off" required><button type="submit" class="ccompose__send" aria-label="Send comment"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></form>'
            : '<p class="cpost__signin"><a href="/signin">Sign in</a> to comment.</p>';
        return '<article class="cpost' + (p.pending ? ' cpost--pending' : (p.rejected ? ' cpost--rejected' : '')) + '" data-post-id="' + p.id + '" data-liked="' + (liked ? '1' : '0') + '">'
            + '<header class="cpost__head"><span class="cavatar cavatar--t' + (p.author.tint || 0) + '" aria-hidden="true">' + esc(p.author.initial) + '</span>'
            + '<span class="cpost__meta"><span class="cpost__author">' + esc(p.author.name)
            + (p.author.type === 'admin' ? '<span class="cpost__tag">Restaurant</span>' : '')
            + '</span><time class="cpost__time" data-time="' + esc(p.created_at) + '">' + timeAgo(p.created_at) + '</time></span>' + delBtn + '</header>'
            + statusBanner + bodyHtml + media
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

        // Auto-grow the composer textarea (Facebook-style) up to a max height.
        var taEl = postForm.querySelector('.ccompose__text');
        function autoGrowTa() {
            if (!taEl) { return; }
            taEl.style.height = 'auto';
            taEl.style.height = Math.min(taEl.scrollHeight, 140) + 'px';
        }
        if (taEl) { taEl.addEventListener('input', autoGrowTa); }
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
                    // Held for review → it won't appear in the feed until a
                    // moderator approves it (even for the author). Just confirm.
                    if (env.data && env.data.pending) {
                        ta.value = ''; ta.style.height = ''; if (photoInput) { photoInput.value = ''; }
                        var pvp = postForm.querySelector('[data-photo-preview]'); if (pvp) { pvp.hidden = true; }
                        toast('success', env.msg || 'Sent for review — it will appear once approved.');
                        return;
                    }
                    // Approved → show it immediately.
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
        // My posts modal — status tabs carry no data-action, handle them first.
        var mtab = e.target.closest && e.target.closest('[data-myposts-tab]');
        if (mtab && root.contains(mtab)) { myPostsTab(mtab.getAttribute('data-myposts-tab')); return; }

        var act = e.target.closest && e.target.closest('[data-action]');
        if (!act || !root.contains(act)) { return; }
        var action = act.getAttribute('data-action');
        var card = act.closest('.cpost');

        if (action === 'open-myposts') { openMyPosts(); return; }
        if (action === 'close-myposts') { closeMyPosts(); return; }
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
            // Held for review → clear the box, don't show it until approved.
            if (env.data.pending) { input.value = ''; toast('success', env.msg || 'Sent for review.'); return; }
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

    // ── My posts modal — the author tracks their OWN submissions by status.
    //    The public feed shows only approved posts, so this is where they see
    //    what's pending review or was rejected (with the AI's reason). ──
    var myModal = document.querySelector('[data-myposts-modal]');
    var myList  = myModal && myModal.querySelector('[data-myposts-list]');
    var myEmpty = myModal && myModal.querySelector('[data-myposts-empty]');
    var myStatus = 'pending';

    function openMyPosts() {
        if (!myModal) { return; }
        myModal.hidden = false;
        document.body.classList.add('cmine-open');
        myPostsTab('pending');
    }
    function closeMyPosts() {
        if (!myModal) { return; }
        myModal.hidden = true;
        document.body.classList.remove('cmine-open');
    }
    function myPostsTab(status) {
        if (!myModal) { return; }
        myStatus = status;
        myModal.querySelectorAll('[data-myposts-tab]').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-myposts-tab') === status); });
        loadMyPosts();
    }
    function setMyCounts(counts) {
        if (!counts || !myModal) { return; }
        myModal.querySelectorAll('[data-myposts-cnt]').forEach(function (el) { el.textContent = Number(counts[el.getAttribute('data-myposts-cnt')]) || 0; });
        var badge = document.querySelector('[data-myposts-badge]');
        if (badge) { var p = Number(counts.pending) || 0; badge.textContent = p; badge.hidden = p === 0; }
    }
    function myPostCard(p) {
        var img = p.image_url ? '<div class="cmine-card__img"><img src="' + esc(p.image_url) + '" alt=""></div>' : '';
        var tag;
        if (p.moderation_status === 'pending')       { tag = '<span class="cmine-card__tag cmine-card__tag--pending">⏳ Pending review</span>'; }
        else if (p.moderation_status === 'rejected') { tag = '<span class="cmine-card__tag cmine-card__tag--rejected">🚫 Rejected</span>'; }
        else                                         { tag = '<span class="cmine-card__tag cmine-card__tag--approved">✅ Live</span>'; }
        var reason = p.ai_reason ? '<p class="cmine-card__reason">🤖 ' + esc(p.ai_reason) + '</p>' : '';
        return '<div class="cmine-card">'
            + '<div class="cmine-card__top">' + tag + '<span class="cmine-card__time">' + esc(timeAgo(p.created_at)) + '</span></div>'
            + (p.body ? '<p class="cmine-card__body">' + esc(p.body) + '</p>' : '') + img + reason + '</div>';
    }
    function loadMyPosts() {
        if (!myList) { return; }
        myList.innerHTML = '<p class="cmine-modal__loading">Loading…</p>';
        if (myEmpty) { myEmpty.hidden = true; }
        fetch('/community/my-posts?group_id=' + encodeURIComponent(GROUP_ID) + '&status=' + myStatus, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (env) {
                if (env.status === 401) { closeMyPosts(); bounceToSignin(); return; }
                var d = env.data || {};
                setMyCounts(d.counts);
                var posts = d.posts || [];
                myList.innerHTML = posts.map(myPostCard).join('');
                if (myEmpty) { myEmpty.hidden = posts.length > 0; }
            })
            .catch(function () { myList.innerHTML = ''; toast('error', 'Could not load your posts.'); });
    }
    // Close on Escape for accessibility.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && myModal && !myModal.hidden) { closeMyPosts(); } });

    // ── Search this group's posts (client-side, tokenized) ───────────
    //    Each query WORD is matched anywhere in a post (body + author) — not
    //    the exact phrase. Posts with MORE matching words rank higher; posts
    //    with zero matches are hidden while a search is active. Clearing the
    //    box restores the exact order the feed had when the search began.
    (function initPostSearch() {
        var listEl = root.querySelector('[data-feed-list]');
        var inputs = Array.prototype.slice.call(root.querySelectorAll('[data-community-search]'));
        if (!listEl || !inputs.length) { return; }
        var clears = Array.prototype.slice.call(root.querySelectorAll('[data-community-search-clear]'));
        var active = false, snapshot = null, order = null, emptyEl = null, deb = null;

        function allPosts() { return Array.prototype.slice.call(listEl.querySelectorAll('.cpost')); }
        function searchText(p) {
            var body = (p.querySelector('.cpost__body') || {}).textContent || '';
            var who  = (p.querySelector('.cpost__author') || {}).textContent || '';
            return (body + ' ' + who).toLowerCase();
        }
        function ensureEmpty() {
            if (!emptyEl) {
                emptyEl = document.createElement('div');
                emptyEl.className = 'cfeed__empty cfeed__empty--search';
                emptyEl.innerHTML = '<span class="cfeed__empty-ic" aria-hidden="true">🔍</span><p>No posts match your search.</p>';
                listEl.parentNode.insertBefore(emptyEl, listEl.nextSibling);
            }
            return emptyEl;
        }
        function moreWrap() { return root.querySelector('[data-more-wrap]'); }

        function restore() {
            // Re-append in the order captured when the search started (skip any
            // node that was removed meanwhile, e.g. deleted).
            (snapshot || allPosts()).forEach(function (p) { if (p.parentNode === listEl) { p.hidden = false; listEl.appendChild(p); } });
            allPosts().forEach(function (p) { p.hidden = false; });
            ensureEmpty().classList.remove('is-on');
            clears.forEach(function (b) { b.hidden = true; });
            var mw = moreWrap();
            if (mw && mw.getAttribute('data-search-hid') != null) { mw.hidden = mw.getAttribute('data-search-hid') === '1'; mw.removeAttribute('data-search-hid'); }
            snapshot = null; order = null; active = false;
        }

        function apply(q) {
            var tokens = String(q || '').toLowerCase().split(/\s+/).filter(function (t) { return t.length >= 1; });
            if (!tokens.length) { if (active) { restore(); } return; }

            if (!active) {
                // Snapshot the current order (for a faithful restore + stable
                // tie-breaking) and hide load-more (search ranks what's loaded).
                snapshot = allPosts();
                order = new Map(); snapshot.forEach(function (p, i) { order.set(p, i); });
                var mw0 = moreWrap();
                if (mw0 && mw0.getAttribute('data-search-hid') == null) { mw0.setAttribute('data-search-hid', mw0.hidden ? '1' : '0'); }
                active = true;
            }
            var mw = moreWrap(); if (mw) { mw.hidden = true; }
            clears.forEach(function (b) { b.hidden = false; });

            var matches = [];
            allPosts().forEach(function (p) {
                var text = searchText(p), m = 0;
                tokens.forEach(function (t) { if (text.indexOf(t) !== -1) { m += 1; } });
                if (m > 0) { matches.push({ p: p, m: m }); p.hidden = false; } else { p.hidden = true; }
            });
            // More matched words first; ties keep the original (newest-first) order.
            matches.sort(function (a, b) { return b.m - a.m || ((order.get(a.p) || 0) - (order.get(b.p) || 0)); });
            matches.forEach(function (x) { listEl.appendChild(x.p); });
            ensureEmpty().classList.toggle('is-on', matches.length === 0);
        }

        function onInput(e) {
            var val = e.target.value;
            inputs.forEach(function (inp) { if (inp !== e.target) { inp.value = val; } });
            clearTimeout(deb);
            deb = setTimeout(function () { apply(val); }, 160);
        }
        inputs.forEach(function (inp) { inp.addEventListener('input', onInput); });
        clears.forEach(function (b) {
            b.addEventListener('click', function () { inputs.forEach(function (inp) { inp.value = ''; }); restore(); if (inputs[0]) { inputs[0].focus(); } });
        });
    })();

    // First paint of relative times on the SSR posts.
    paintTimes(document);
})();
