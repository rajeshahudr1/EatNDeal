/*
 * ui/dialog.js
 *
 * What:  Custom confirm dialog. Exposes
 *          window.EatNDealUi.confirmDialog({title, message, okLabel, cancelLabel})
 *        which returns a Promise<boolean> — true when the user clicks the
 *        primary action, false when they cancel or dismiss.
 * Why:   Coding-Conventions rule #8 — no native window.confirm(). Every
 *        yes/no decision in the app uses this.
 * Used:  Loaded from views/_layout.ejs. Pages call it as:
 *          var ok = await window.EatNDealUi.confirmDialog({
 *              title: 'Remove item?',
 *              message: 'This will remove the item from your cart.',
 *              okLabel: 'Remove'
 *          });
 */

(function () {
    'use strict';

    var root, titleEl, msgEl, confirmBtn, cancelBtn;
    var pending = null;     // current { resolve } closure

    /**
     * cacheNodes
     *
     * What:  Looks up the dialog DOM nodes once and stores them in module
     *        scope. Called lazily on first confirmDialog call.
     * Why:   Skips repeat querySelector cost on each open.
     * Type:  READ.
     */
    function cacheNodes() {
        if (root) { return; }
        root       = document.getElementById('dialog-root');
        if (!root) { return; }
        titleEl    = root.querySelector('.dialog__title');
        msgEl      = root.querySelector('.dialog__message');
        confirmBtn = root.querySelector('[data-action="confirm-dialog"]');
        cancelBtn  = root.querySelector('[data-action="cancel-dialog"]');

        // Wire one-time listeners. The handlers consult the `pending` closure
        // so they work for any number of subsequent confirmDialog calls.
        confirmBtn.addEventListener('click', function () { resolve(true);  });
        // The backdrop ALSO has data-action="cancel-dialog" — querySelector
        // above gets the first match (.btn--ghost). Wire the second match too.
        var cancels = root.querySelectorAll('[data-action="cancel-dialog"]');
        cancels.forEach(function (el) {
            el.addEventListener('click', function () { resolve(false); });
        });

        // Esc key closes as Cancel.
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && pending) { resolve(false); }
        });
    }

    /**
     * resolve
     *
     * What:  Hides the dialog and resolves the pending promise with `value`.
     * Why:   Single exit path keeps the open/close + promise state in sync.
     *        Blurs any descendant first so the dialog can be safely
     *        aria-hidden without stranding focus on a now-invisible
     *        element (Chrome console warning).
     * Type:  WRITE (DOM + promise).
     * Inputs: value (boolean).
     */
    function resolve(value) {
        if (!pending) { return; }
        var p = pending;
        pending = null;

        // Move focus out of the dialog BEFORE setting aria-hidden=true,
        // otherwise the browser warns about aria-hidden on an ancestor
        // of the focused element.
        var active = document.activeElement;
        if (active && root && root.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }

        root.setAttribute('aria-hidden', 'true');
        root.hidden = true;
        p.resolve(value);
    }

    /**
     * confirmDialog
     *
     * What:  Opens the custom confirm dialog and returns a Promise<boolean>.
     * Why:   Replaces native confirm().
     * Type:  WRITE (DOM).
     * Inputs:
     *   opts.title       — heading text
     *   opts.message     — body copy
     *   opts.okLabel     — primary button label (default "Confirm")
     *   opts.cancelLabel — secondary button label (default "Cancel")
     * Output: Promise<boolean>.
     * Used:   Anywhere a yes/no decision is needed.
     */
    function confirmDialog(opts) {
        opts = opts || {};
        return new Promise(function (resolveOuter) {
            cacheNodes();
            if (!root) {
                // No dialog mounted in the page. Resolve to true so callers
                // that "default-yes" still work. Logged so devs can spot it.
                if (window.console) { window.console.warn('[dialog] #dialog-root missing — auto-confirming'); }
                resolveOuter(true);
                return;
            }

            // If another dialog was somehow still pending, dismiss it first.
            if (pending) { resolve(false); }

            titleEl.textContent   = opts.title       || 'Please confirm';
            msgEl.textContent     = opts.message     || '';
            confirmBtn.textContent = opts.okLabel    || 'Confirm';
            cancelBtn.textContent  = opts.cancelLabel || 'Cancel';

            root.hidden = false;
            root.setAttribute('aria-hidden', 'false');
            // Focus the primary action so keyboard users can hit Enter.
            window.setTimeout(function () { confirmBtn.focus(); }, 0);

            pending = { resolve: resolveOuter };
        });
    }

    window.EatNDealUi = window.EatNDealUi || {};
    window.EatNDealUi.confirmDialog = confirmDialog;
})();
