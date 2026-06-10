/*
 * pages/account.js
 *
 * What:  Light enhancement for the My Profile + Change Password pages:
 *          • password show / hide toggles
 *          • client-side "passwords match" check before submit
 *        Both forms work without JS (plain POST + server validation); this is
 *        the progressive layer.
 * Used:  extra_js for auth/profile + auth/change-password.
 */
(function () {
    'use strict';

    // Numeric-only inputs (contact number, PIN) — strip anything that isn't a
    // digit as the user types, matching the legacy personal-details field.
    document.addEventListener('input', function (ev) {
        var el = ev.target;
        if (!el || !el.hasAttribute || !el.hasAttribute('data-digits')) { return; }
        var clean = el.value.replace(/[^0-9]/g, '');
        if (clean !== el.value) { el.value = clean; }
    });

    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) { return; }
        var toggle = t.closest('[data-action="toggle-pw"]');
        if (!toggle) { return; }
        ev.preventDefault();
        var input = document.getElementById(toggle.getAttribute('data-target'));
        if (!input) { return; }
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
        toggle.classList.toggle('is-on', show);
    });

    document.addEventListener('DOMContentLoaded', function () {
        var form = document.getElementById('change-password-form');
        if (!form) { return; }
        form.addEventListener('submit', function (ev) {
            var npw = form.querySelector('[name="new_password"]');
            var cpw = form.querySelector('[name="confirm_password"]');
            var err = form.querySelector('[data-pw-error]');
            if (npw && cpw && npw.value !== cpw.value) {
                ev.preventDefault();
                if (err) { err.textContent = 'The passwords don’t match.'; err.hidden = false; }
                cpw.focus();
            }
        });
    });
})();
