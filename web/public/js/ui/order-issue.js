/*
 * /js/ui/order-issue.js
 *
 * What:  "Report an issue with your order" modal on the order-detail page.
 *        A single note → POST /order/:id/report-issue (→ epos_complaints).
 *        After submit, polls /order/:id/issue-response every 5s for the
 *        restaurant's reply (mirrors legacy webordering). Self-guards: no-op
 *        on every page that has no [data-issue-modal].
 */
(function () {
    'use strict';

    var modal = document.querySelector('[data-issue-modal]');
    if (!modal) { return; }                       // only the order-detail page

    var orderId   = modal.getAttribute('data-order-id');
    var textEl    = modal.querySelector('[data-issue-text]');
    var errEl     = modal.querySelector('[data-issue-err]');
    var replyEl   = modal.querySelector('[data-issue-reply]');
    var actionsEl = modal.querySelector('.issue-modal__actions');
    var submitBtn = modal.querySelector('[data-action="submit-issue"]');
    var pollTimer = null;

    var toast = (window.EatNDealDom && window.EatNDealDom.showToastSafe) || function (type, msg) { if (window.EatNDealUi && window.EatNDealUi.showToast) { window.EatNDealUi.showToast(type, msg); } };
    function open()  { modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); if (textEl) { textEl.focus(); } }
    function close() { modal.hidden = true;  modal.setAttribute('aria-hidden', 'true'); }
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }
    function clearErr()   { if (errEl) { errEl.hidden = true; } }

    function submit() {
        clearErr();
        var notes = (textEl && textEl.value || '').trim();
        if (!notes) { showErr('Please describe the problem with your order before submitting.'); return; }
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

        fetch('/order/' + encodeURIComponent(orderId) + '/report-issue', {
            method:      'POST',
            credentials: 'same-origin',
            headers:     { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:        JSON.stringify({ notes: notes }),
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).then(function (env) {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
            if (env && env.status === 401) {
                window.location.href = '/signin?next=' + encodeURIComponent('/order/' + orderId);
                return;
            }
            if (env && env.status === 200) {
                if (textEl)    { textEl.hidden = true; }
                if (actionsEl) { actionsEl.hidden = true; }
                if (replyEl) {
                    replyEl.hidden = false;
                    replyEl.className = 'issue-modal__reply is-success';
                    replyEl.textContent = (env.msg) || 'Your order issue has been submitted.';
                }
                toast('success', 'Issue reported.');
                startPoll();
            } else {
                showErr((env && env.msg) || 'Couldn\'t submit. Please try again.');
            }
        }).catch(function () {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
            showErr('Couldn\'t submit — please check your connection and try again.');
        });
    }

    function startPoll() {
        if (pollTimer) { return; }
        pollTimer = window.setInterval(checkReply, 5000);
    }
    function checkReply() {
        fetch('/order/' + encodeURIComponent(orderId) + '/issue-response', { credentials: 'same-origin' })
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .then(function (env) {
                if (env && env.status === 200 && env.data && env.data.response) {
                    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
                    if (replyEl) {
                        replyEl.hidden = false;
                        replyEl.className = 'issue-modal__reply is-reply';
                        var safe = String(env.data.response).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        replyEl.innerHTML = '<strong>The restaurant replied:</strong><br>' + safe;
                    }
                }
            }).catch(function () { /* keep polling */ });
    }

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (t.closest('[data-action="open-issue"]'))   { ev.preventDefault(); open();   return; }
        if (t.closest('[data-action="close-issue"]'))  { ev.preventDefault(); close();  return; }
        if (t.closest('[data-action="submit-issue"]')) { ev.preventDefault(); submit(); return; }
    });
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && !modal.hidden) { close(); }
    });
})();
