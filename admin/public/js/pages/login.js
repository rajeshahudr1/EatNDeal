/*
 * pages/login.js
 *
 * What:  Progressive enhancement for the admin login form. The form works
 *        without JS (plain POST + server flash); this adds:
 *          • password show / hide toggle
 *          • inline, client-side validation (mirrors Validators/auth.js)
 *          • a submit spinner so a double-tap can't double-post
 *          • a "Forgot password?" hint (no self-service reset yet)
 * Why:   Dual-side validation + custom popups per the coding conventions.
 * Used:  Loaded via extra_js from Controllers/AuthController.loginPage.
 */
(function () {
    'use strict';

    var EMAIL_RE = window.AdminUi.EMAIL_PATTERN;

    function $(sel, ctx) { return (ctx || document).querySelector(sel); }

    function setError(field, msg) {
        var wrap = document.querySelector('[data-field="' + field + '"]');
        var err  = document.querySelector('[data-error="' + field + '"]');
        if (wrap) { wrap.classList.toggle('has-error', !!msg); }
        if (err) {
            err.textContent = msg || '';
            err.hidden = !msg;
        }
    }

    function validate(form) {
        var email = String((form.email && form.email.value) || '').trim();
        var pass  = String((form.password && form.password.value) || '');
        var ok = true;

        if (!email)               { setError('email', 'Email is required.'); ok = false; }
        else if (!EMAIL_RE.test(email)) { setError('email', 'Enter a valid email address.'); ok = false; }
        else                      { setError('email', ''); }

        if (!pass)                { setError('password', 'Password is required.'); ok = false; }
        else if (pass.length < 6) { setError('password', 'Password must be at least 6 characters.'); ok = false; }
        else                      { setError('password', ''); }

        return ok;
    }

    document.addEventListener('DOMContentLoaded', function () {
        var form = document.getElementById('adlogin-form');
        if (!form) { return; }

        // Clear a field's error as the user fixes it.
        ['email', 'password'].forEach(function (name) {
            if (form[name]) {
                form[name].addEventListener('input', function () { setError(name, ''); });
            }
        });

        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) { return; }

            // Password show / hide.
            var toggle = t.closest('[data-action="toggle-password"]');
            if (toggle) {
                ev.preventDefault();
                var input = $('#adlogin-password');
                var eye   = $('.adform__eye', toggle);
                var eyeOff = $('.adform__eye-off', toggle);
                if (!input) { return; }
                var show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
                toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
                if (eye)    { eye.hidden = show; }
                if (eyeOff) { eyeOff.hidden = !show; }
                return;
            }

            // Forgot password — no self-service reset yet.
            if (t.closest('[data-action="forgot"]')) {
                ev.preventDefault();
                if (window.AdminUi && window.AdminUi.showToast) {
                    window.AdminUi.showToast('info', 'Contact your system administrator to reset your password.');
                }
                return;
            }
        });

        // Validate on submit; show spinner; let the POST through if valid.
        form.addEventListener('submit', function (ev) {
            if (!validate(form)) {
                ev.preventDefault();
                return;
            }
            var btn = $('[data-action="submit-login"]', form);
            if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
            // Re-enable after a beat as a safety net if navigation is blocked.
            window.setTimeout(function () {
                if (btn) { btn.classList.remove('is-loading'); btn.disabled = false; }
            }, 8000);
        });
    });
})();
