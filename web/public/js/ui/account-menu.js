/*
 * ui/account-menu.js
 *
 * What:  Drives the desktop header account dropdown (the name chip in
 *        the top-right that opens a panel with "My profile" + "Log out").
 *
 *        Behaviour:
 *          • Click the trigger → toggles the panel + flips
 *            aria-expanded + adds .is-open on the container.
 *          • Click outside the menu → closes the panel.
 *          • Esc when the panel is open → closes + restores focus to
 *            the trigger.
 *          • A11y: trigger has aria-haspopup="menu" + aria-expanded;
 *            menu items have role="menuitem".
 *
 * Why:   The header has both a "name + caret" CTA and a dropdown
 *        showing My profile / Log out. CSP forbids inline JS, so this
 *        lives in its own external file.
 *
 * Used:  Loaded by views/_layout.ejs via its own <script> tag. No-op on
 *        pages where the menu element isn't rendered (logged-out
 *        visitors).
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    /**
     * findMenu
     *
     * What:  Looks up the menu element marked with [data-account-menu].
     *        Returns null if it isn't on the current page (e.g. the user
     *        is logged out, or the trigger is rendered inside the mobile
     *        drawer which uses its own UI).
     */
    function findMenu() {
        return document.querySelector('[data-account-menu]');
    }

    /**
     * open / close / isOpen
     *
     * What:  Tiny state helpers. Use the .is-open class for CSS hooks
     *        + the `hidden` attribute on the panel so screen readers
     *        skip it when closed.
     */
    function open(menu, trigger, panel) {
        menu.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        panel.hidden = false;
    }

    function close(menu, trigger, panel) {
        menu.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        // Move focus OUT of the panel before flipping `hidden` so Chrome
        // doesn't warn about an aria-hidden ancestor of the focused node.
        var active = document.activeElement;
        if (active && panel.contains(active) && typeof active.blur === 'function') {
            active.blur();
            if (typeof trigger.focus === 'function') {
                trigger.focus({ preventScroll: true });
            }
        }
        panel.hidden = true;
    }

    function isOpen(menu) {
        return menu.classList.contains('is-open');
    }

    /**
     * bind
     *
     * What:  Wires the trigger + outside-click + Esc handlers. Called
     *        once on DOM-ready. Safe to run when the menu isn't present
     *        (returns early).
     */
    function bind() {
        var menu = findMenu();
        if (!menu) { return; }

        var trigger = menu.querySelector('[data-action="toggle-account-menu"]');
        var panel   = menu.querySelector('#account-menu-panel');
        if (!trigger || !panel) { return; }

        // Trigger click: toggle.
        trigger.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (isOpen(menu)) { close(menu, trigger, panel); }
            else              { open(menu, trigger, panel); }
        });

        // Outside-click: any click that isn't inside the menu closes it.
        // Uses bubbling so the trigger's stopPropagation above keeps the
        // trigger click out of this handler.
        document.addEventListener('click', function (ev) {
            if (!isOpen(menu)) { return; }
            if (menu.contains(ev.target)) { return; }
            close(menu, trigger, panel);
        });

        // Esc closes the panel + returns focus to the trigger.
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && isOpen(menu)) {
                close(menu, trigger, panel);
            }
        });

        // If the viewport shrinks to mobile width the desktop header
        // gets hidden — but the menu can still be in the .is-open state.
        // Close it on resize so a rotation back doesn't show a stuck-
        // open panel.
        var mq = window.matchMedia('(max-width: 767px)');
        function onBreakpoint(e) {
            if (e.matches && isOpen(menu)) { close(menu, trigger, panel); }
        }
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', onBreakpoint);
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(onBreakpoint);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
