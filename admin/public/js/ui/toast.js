/*
 * ui/toast.js
 *
 * What:  Tiny toast helper. Exposes window.AdminUi.showToast(type, msg)
 *        and, on DOM-ready, pops any server flash carried in #server-flash
 *        (the EJS layout writes flash_success / flash_error there).
 * Why:   Replaces native alert() (Conventions rule #8) with a consistent,
 *        non-blocking message surface used across the admin console.
 * Used:  Loaded on every page from views/_layout.ejs.
 */
(function () {
    'use strict';

    var ICONS = { success: '✓', error: '!', info: 'i' };

    function showToast(type, msg, ttl) {
        type = (type === 'success' || type === 'error' || type === 'info') ? type : 'info';
        if (!msg) { return; }
        var stack = document.getElementById('toast-stack');
        if (!stack) { return; }

        var el = document.createElement('div');
        el.className = 'toast toast--' + type;

        var icon = document.createElement('span');
        icon.className = 'toast__icon';
        icon.textContent = ICONS[type];

        var text = document.createElement('span');
        text.className = 'toast__msg';
        text.textContent = msg;

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast__close';
        close.setAttribute('aria-label', 'Dismiss');
        close.innerHTML = '&times;';

        el.appendChild(icon);
        el.appendChild(text);
        el.appendChild(close);
        stack.appendChild(el);

        // Animate in on the next frame.
        requestAnimationFrame(function () { el.classList.add('is-in'); });

        var timer = null;
        function dismiss() {
            if (timer) { window.clearTimeout(timer); timer = null; }
            el.classList.remove('is-in');
            window.setTimeout(function () { if (el.parentNode) { el.parentNode.removeChild(el); } }, 220);
        }
        close.addEventListener('click', dismiss);
        timer = window.setTimeout(dismiss, ttl || 4200);
    }

    window.AdminUi = window.AdminUi || {};
    window.AdminUi.showToast = showToast;

    // Pop server flash on load.
    document.addEventListener('DOMContentLoaded', function () {
        var flash = document.getElementById('server-flash');
        if (!flash) { return; }
        var ok  = flash.getAttribute('data-flash-success');
        var err = flash.getAttribute('data-flash-error');
        if (ok)  { showToast('success', ok); }
        if (err) { showToast('error', err); }
    });
})();
