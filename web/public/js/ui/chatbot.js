/*
 * ui/chatbot.js — the floating help-chatbot widget (partials/chatbot.ejs).
 *
 * Opens/closes the panel, sends the typed message (or a tapped quick-reply
 * chip) to POST /chatbot/ask, and renders the bot reply + follow-up chips.
 * Answers personalise for the signed-in customer (server injects customer_id).
 */
(function () {
    'use strict';

    var root = document.querySelector('[data-chatbot]');
    if (!root) { return; }
    var panel   = root.querySelector('[data-chatbot-panel]');
    var body    = root.querySelector('[data-chatbot-body]');
    var chipsEl = root.querySelector('[data-chatbot-chips]');
    var form    = root.querySelector('[data-chatbot-form]');
    var input   = root.querySelector('[data-chatbot-input]');
    var DEFAULT_CHIPS = ['Where is my order?', 'Restaurants near me', 'Offers for me', 'My loyalty points', 'What can you do?'];
    var opened = false, busy = false;

    function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }
    // Render **bold** + newlines; everything else escaped (no HTML injection).
    function fmt(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }

    function addMsg(text, who) {
        var el = document.createElement('div');
        el.className = 'chatbot__msg chatbot__msg--' + who;
        el.innerHTML = fmt(text);
        body.appendChild(el);
        body.scrollTop = body.scrollHeight;
        return el;
    }
    function renderChips(chips) {
        chipsEl.innerHTML = (chips || []).map(function (c) {
            return '<button type="button" class="chatbot__chip" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
        }).join('');
    }
    // A one-tap action the bot can offer (currently: reorder). Renders a
    // button under the reply that fires the SAME /order/:id/reorder flow the
    // order page uses, then redirects to /cart (mirrors app.js bindReorder).
    function renderAction(action) {
        if (!action || action.kind !== 'reorder' || !action.orderId) { return; }
        var wrap = document.createElement('div');
        wrap.className = 'chatbot__action';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chatbot__action-btn';
        var orig = action.label || 'Reorder';
        btn.textContent = orig;
        btn.addEventListener('click', function () {
            if (btn.disabled) { return; }
            btn.disabled = true;
            btn.textContent = '…';
            fetch('/order/' + encodeURIComponent(action.orderId) + '/reorder', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: '{}',
            })
                .then(function (r) { return r.json().catch(function () { return null; }); })
                .then(function (env) {
                    if (env && env.status === 401) { window.location.href = '/signin?next=' + encodeURIComponent('/cart'); return; }
                    if (!env || env.status !== 200) {
                        btn.disabled = false; btn.textContent = orig;
                        addMsg((env && env.msg) || 'Could not reorder — try from Orders.', 'bot');
                        return;
                    }
                    try { sessionStorage.setItem('reorder.msg', env.msg || ''); } catch (e) { /* ignore */ }
                    window.location.href = '/cart';
                })
                .catch(function () { btn.disabled = false; btn.textContent = orig; addMsg('Could not reorder. Please try again.', 'bot'); });
        });
        wrap.appendChild(btn);
        body.appendChild(wrap);
        body.scrollTop = body.scrollHeight;
    }
    function send(text) {
        text = String(text || '').trim();
        if (!text || busy) { return; }
        busy = true;
        addMsg(text, 'user');
        input.value = '';
        var typing = addMsg('•••', 'bot');
        typing.classList.add('chatbot__msg--typing');
        fetch('/chatbot/ask', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ message: text }),
        })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (env) {
                typing.remove();
                var d = env && env.data;
                addMsg((d && d.reply) || (env && env.msg) || 'Sorry, please try again.', 'bot');
                if (d && d.action) { renderAction(d.action); }
                renderChips((d && d.chips) || DEFAULT_CHIPS);
            })
            .catch(function () { typing.remove(); addMsg('Could not reach the assistant. Please try again.', 'bot'); })
            .then(function () { busy = false; });
    }
    function toggle() {
        opened = !opened;
        panel.hidden = !opened;
        root.classList.toggle('is-open', opened);
        // Lock the page behind the (mobile) full-screen chat so it can't scroll
        // through; CSS gates the lock to phones.
        document.body.classList.toggle('is-chat-open', opened);
        if (opened) {
            if (!chipsEl.children.length) { renderChips(DEFAULT_CHIPS); }
            input.focus();
        }
    }

    root.addEventListener('click', function (e) {
        if (e.target.closest('[data-action="chatbot-toggle"]')) { toggle(); return; }
        var chip = e.target.closest('[data-chip]');
        if (chip) { send(chip.getAttribute('data-chip')); }
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });

    // Mobile entry point — the floating FAB is hidden on phones (it overlapped
    // filters / the sidebar), so the chat opens from the "Help & Chat" row in
    // the profile drawer instead. Close the drawer first (its close button runs
    // the app.js teardown), then open the panel. Delegated so it works whenever
    // the drawer is rendered.
    document.addEventListener('click', function (e) {
        var launch = e.target.closest && e.target.closest('[data-action="open-chat-from-menu"]');
        if (!launch) { return; }
        e.preventDefault();
        var drawerClose = document.querySelector('#mobile-drawer [data-action="close-mobile-menu"]');
        if (drawerClose) { drawerClose.click(); }
        if (!opened) { toggle(); }
    });
})();
