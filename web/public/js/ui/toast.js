/*
 * ui/toast.js
 *
 * What:  Custom toast notifications. Exposes window.EatNDealUi.showToast(
 *        type, message, opts). Stacks in #toast-stack (rendered once in
 *        views/partials/toast.ejs).
 * Why:   Coding-Conventions rule #8 — no native alert(). All transient
 *        success / error / warning / info messages route through here.
 *        Also auto-pops any server flash messages on DOM-ready.
 * Used:  Loaded from views/_layout.ejs. Any page can call
 *        window.EatNDealUi.showToast('success', 'Saved.').
 */

(function () {
    'use strict';

    var ALLOWED = { success: 1, error: 1, warn: 1, info: 1 };
    var DEFAULT_MS = 4000;
    var stack = null;   // resolved on first call

    /**
     * ensureStack
     *
     * What:  Caches a reference to the #toast-stack <ul>. Created once.
     * Why:   Saves repeat lookups on every showToast call.
     * Type:  READ.
     */
    function ensureStack() {
        if (!stack) { stack = document.getElementById('toast-stack'); }
        return stack;
    }

    /**
     * removeToast
     *
     * What:  Plays the leaving animation, then removes the element.
     * Why:   Smoother visual than a hard remove.
     * Type:  WRITE (DOM).
     * Inputs: li — toast element to remove.
     * Used:   Internal timer + close button click.
     */
    function removeToast(li) {
        if (!li || !li.parentNode) { return; }
        li.classList.add('is-leaving');
        // Wait for the CSS exit animation (180ms) before unmounting.
        window.setTimeout(function () {
            if (li.parentNode) { li.parentNode.removeChild(li); }
        }, 200);
    }

    /**
     * showToast
     *
     * What:  Adds a toast to the stack. Auto-dismisses after opts.ms
     *        (default 4000). Errors stay 6s by default — longer to read.
     * Why:   Friendlier replacement for window.alert().
     * Type:  WRITE (DOM).
     * Inputs:
     *   type    — 'success' | 'error' | 'warn' | 'info' (defaults to 'info')
     *   message — string to display
     *   opts    — { ms: number } (optional)
     * Output: void.
     * Used:   Called from page scripts, API error handlers, server-flash
     *         passthrough below.
     */
    function showToast(type, message, opts) {
        if (!ALLOWED[type]) { type = 'info'; }
        if (!message)       { return; }

        var ul = ensureStack();
        if (!ul) { return; }

        var ms = (opts && opts.ms) || (type === 'error' ? 6000 : DEFAULT_MS);

        // Build the toast LI without inline HTML — keeps us safe from
        // accidental XSS in the message (which may include user input).
        var li = document.createElement('li');
        li.className = 'toast toast--' + type;
        li.setAttribute('role', 'alert');

        var msgEl = document.createElement('span');
        msgEl.className = 'toast__msg';
        msgEl.textContent = String(message);
        li.appendChild(msgEl);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast__close';
        btn.setAttribute('aria-label', 'Dismiss');
        btn.textContent = '×';
        btn.addEventListener('click', function () { removeToast(li); });
        li.appendChild(btn);

        ul.appendChild(li);

        // Auto-dismiss
        window.setTimeout(function () { removeToast(li); }, ms);
    }

    // Expose ───────────────────────────────────────────────────────────
    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.showToast = showToast;

    /**
     * pumpServerFlash
     *
     * What:  Reads #server-flash data-* attributes (populated by EJS layout
     *        when req.flash() produced a message) and surfaces them as
     *        toasts.
     * Why:   Server-side redirects (e.g. login failure) set flash messages.
     *        This bridges them into the same UI as client-side toasts.
     * Type:  WRITE (DOM read + toast write).
     * Inputs: none.
     * Output: void.
     * Used:   DOMContentLoaded listener below.
     */
    function pumpServerFlash() {
        var el = document.getElementById('server-flash');
        if (!el) { return; }
        var s = el.getAttribute('data-flash-success') || '';
        var e = el.getAttribute('data-flash-error')   || '';
        if (s) { showToast('success', s); }
        if (e) { showToast('error',   e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', pumpServerFlash);
    } else {
        pumpServerFlash();
    }
})();
