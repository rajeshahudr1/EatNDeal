/*
 * pages/auth-extra.js
 *
 * What:  Progressive enhancement shared by the Forgot-password and
 *        Reset-password screens:
 *          • password show / hide toggle (uses data-target, falls back to the
 *            nearest password input)
 *          • Forgot form  → email validation + submit spinner
 *          • Reset form   → password length + confirm-match + submit spinner
 *        Both forms work without JS (plain POST + server flash); this only
 *        adds inline feedback.
 * Why:   Dual-side validation + custom feedback per the coding conventions.
 * Used:  extra_js for auth/forgot.ejs + auth/reset.ejs.
 */
(function () {
    'use strict';

    var EMAIL_RE = window.AdminUi.EMAIL_PATTERN;

    function setError(field, msg) {
        var wrap = document.querySelector('[data-field="' + field + '"]');
        var err  = document.querySelector('[data-error="' + field + '"]');
        if (wrap) { wrap.classList.toggle('has-error', !!msg); }
        if (err)  { err.textContent = msg || ''; err.hidden = !msg; }
    }

    function startSpinner(form, action) {
        var btn = form.querySelector('[data-action="' + action + '"]');
        if (btn) {
            btn.classList.add('is-loading');
            btn.disabled = true;
            window.setTimeout(function () { btn.classList.remove('is-loading'); btn.disabled = false; }, 8000);
        }
    }

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }
        var toggle = t.closest('[data-action="toggle-password"]');
        if (!toggle) { return; }
        ev.preventDefault();

        // Resolve the target input: data-target id, else the password input
        // inside the same field wrapper.
        var input = null;
        var targetId = toggle.getAttribute('data-target');
        if (targetId) { input = document.getElementById(targetId); }
        if (!input) {
            var field = toggle.closest('.adform__field');
            input = field ? field.querySelector('input') : null;
        }
        if (!input) { return; }

        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
        toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        var eye    = toggle.querySelector('.adform__eye');
        var eyeOff = toggle.querySelector('.adform__eye-off');
        if (eye)    { eye.hidden = show; }
        if (eyeOff) { eyeOff.hidden = !show; }
    });

    document.addEventListener('DOMContentLoaded', function () {
        // ── Forgot form (email only) ──
        var forgot = document.getElementById('adforgot-form');
        if (forgot) {
            if (forgot.email) {
                forgot.email.addEventListener('input', function () { setError('email', ''); });
            }
            forgot.addEventListener('submit', function (ev) {
                var email = String((forgot.email && forgot.email.value) || '').trim();
                if (!email)                 { setError('email', 'Email is required.'); ev.preventDefault(); return; }
                if (!EMAIL_RE.test(email))  { setError('email', 'Enter a valid email address.'); ev.preventDefault(); return; }
                startSpinner(forgot, 'submit-login');
            });
        }

        // ── Reset form (password + confirm) ──
        var reset = document.getElementById('adreset-form');
        if (reset) {
            ['password', 'confirm'].forEach(function (n) {
                if (reset[n]) { reset[n].addEventListener('input', function () { setError(n, ''); }); }
            });
            reset.addEventListener('submit', function (ev) {
                var pass = String((reset.password && reset.password.value) || '');
                var conf = String((reset.confirm && reset.confirm.value) || '');
                var ok = true;
                if (!pass)               { setError('password', 'Enter a new password.'); ok = false; }
                else if (pass.length < 6){ setError('password', 'Password must be at least 6 characters.'); ok = false; }
                else                     { setError('password', ''); }
                if (conf !== pass)       { setError('confirm', 'Passwords do not match.'); ok = false; }
                else                     { setError('confirm', ''); }
                if (!ok) { ev.preventDefault(); return; }
                startSpinner(reset, 'submit-reset');
            });
        }
    });
})();
