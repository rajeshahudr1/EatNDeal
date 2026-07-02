/*
 * pages/partner-form.js
 *
 * What:  Submits the partner / contact LEAD form (views/static/sections/
 *        form.ejs) via AJAX to POST /partner/apply. On success the form is
 *        swapped for a thank-you panel; errors show inline.
 * Used:  extra_js on any static page that has a `type:'form'` section
 *        (Partner with us, Contact us).
 */
(function () {
    'use strict';

    var form = document.querySelector('[data-partner-form]');
    if (!form) { return; }
    var msgEl  = form.querySelector('[data-partner-msg]');
    var btn    = form.querySelector('[data-partner-submit]');
    var doneEl = document.querySelector('[data-partner-done]');

    function showMsg(text) { if (msgEl) { msgEl.textContent = text || ''; msgEl.hidden = !text; } }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        showMsg('');
        var payload = {};
        new FormData(form).forEach(function (v, k) { payload[k] = v; });
        if (!String(payload.name || '').trim()) { showMsg('Please enter your name.'); return; }
        if (!String(payload.email || '').trim() && !String(payload.phone || '').trim()) {
            showMsg('Please add an email or phone so we can reach you.'); return;
        }
        btn.disabled = true; btn.textContent = 'Sending…';
        fetch('/partner/apply', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (r) { return r.json().catch(function () { return { status: 0 }; }); })
            .then(function (env) {
                btn.disabled = false; btn.textContent = 'Send enquiry';
                if (!env || env.status !== 200) { showMsg((env && env.msg) || 'Could not send. Please try again.'); return; }
                form.hidden = true;
                if (doneEl) { doneEl.hidden = false; }
            })
            .catch(function () {
                btn.disabled = false; btn.textContent = 'Send enquiry';
                showMsg('Could not send. Please try again.');
            });
    });
})();
