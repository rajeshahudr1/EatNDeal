/*
 * pages/delete-account.js — the public account-deletion request page.
 *
 * Client checks (email format / at least one field), then POSTs to the
 * web proxy (/delete-account/request). While the server validates, the
 * submit button shows its loader; a valid account swaps the form for the
 * "in review — deleted within 7 days" panel. Nothing is written anywhere
 * — the api endpoint only verifies the details.
 */
(function () {
    'use strict';

    var form = document.querySelector('[data-del-form]');
    if (!form) { return; }
    var wrap    = document.querySelector('[data-del-form-wrap]');
    var done    = document.querySelector('[data-del-done]');
    var errEl   = document.querySelector('[data-del-error]');
    var btn     = document.querySelector('[data-del-submit]');
    var label   = btn ? btn.querySelector('.delacct__btn-label') : null;
    var loader  = btn ? btn.querySelector('.delacct__btn-loader') : null;

    function setBusy(on) {
        if (btn)    { btn.disabled = on; }
        if (label)  { label.hidden = on; }
        if (loader) { loader.hidden = !on; }
    }
    function showError(msg) {
        if (!errEl) { return; }
        errEl.textContent = msg;
        errEl.hidden = !msg;
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        showError('');

        // One box: an "@" makes it an email, otherwise it's a mobile number
        // — validated as whichever it is.
        var value = String((form.querySelector('[name="identity"]') || {}).value || '').trim();
        if (!value) { showError('Enter your email or mobile number.'); return; }
        var isEmail = value.indexOf('@') !== -1;
        var email = '', phone = '';
        if (isEmail) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { showError('Enter a valid email address.'); return; }
            email = value;
        } else {
            if (!/^\+?[0-9 ]{7,15}$/.test(value)) { showError('Enter a valid mobile number.'); return; }
            phone = value;
        }

        setBusy(true);
        fetch('/delete-account/request', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: email, contact_no: phone }),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (env) {
              setBusy(false);
              if (!env) { showError('Could not reach the server. Please try again.'); return; }
              if (env.status !== 200) { showError(env.msg || 'Could not verify those details.'); return; }
              if (wrap) { wrap.hidden = true; }
              if (done) { done.hidden = false; }
          })
          .catch(function () {
              setBusy(false);
              showError('Could not reach the server. Please try again.');
          });
    });
}());
