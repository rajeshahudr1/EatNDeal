/*
 * pages/profile.js
 *
 * What:  Drives the Personal Details screen (Step 3 of the auth flow).
 *         • Diet chips (Veg / Non-veg) — single-select toggle. Updating
 *           the chip also updates the hidden #diet-value input.
 *         • Show-me filter chips (Veg dishes / Pure Veg) — single-
 *           select; hidden when diet=non-veg (only relevant for veg).
 *         • Form submit — demo navigates to the home page (or the
 *           `next` URL forwarded from earlier steps).
 * Used:  Loaded only on the profile screen (AuthController sets
 *        extra_js: '/js/pages/profile.js' when step=profile).
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    var form, dietHidden, showMeHidden, showMeField;
    var dietChips, filterChips;

    function cacheRefs() {
        form         = document.getElementById('profile-form');
        dietHidden   = document.getElementById('diet-value');
        showMeHidden = document.getElementById('show-me-value');
        showMeField  = document.getElementById('show-me-field');
        dietChips    = form ? form.querySelectorAll('[data-action="select-diet"]')   : [];
        filterChips  = form ? form.querySelectorAll('[data-action="select-filter"]') : [];
    }

    /**
     * selectInGroup
     *
     * What:  Visually selects ONE button inside a NodeList of chips and
     *        deselects the others. Returns the value of the picked
     *        chip so the caller can write it to the hidden field.
     * Why:   Single-select toggle group, used twice on this page.
     */
    function selectInGroup(group, picked) {
        var value = picked.getAttribute('data-value') || '';
        group.forEach(function (el) {
            if (el === picked) { el.classList.add('is-selected'); }
            else               { el.classList.remove('is-selected'); }
        });
        return value;
    }

    /**
     * onDietClick
     *
     * What:  Click handler for the Veg / Non-veg chips. Updates the
     *        selection, writes to the hidden form field, and hides the
     *        "Show me" filter row when Non-veg is picked (the filter
     *        only makes sense for veg users — they choose between
     *        all-restaurants vs pure-veg-only).
     */
    function onDietClick(ev) {
        var chip = ev.currentTarget;
        var value = selectInGroup(dietChips, chip);
        if (dietHidden) { dietHidden.value = value; }

        // Hide the Show-me filter on non-veg (it's a veg-only filter).
        if (showMeField) {
            showMeField.hidden = (value === 'non-veg');
        }
    }

    /**
     * onFilterClick
     *
     * What:  Click handler for the Show-me chips. Updates the
     *        selection and writes to the hidden form field.
     */
    function onFilterClick(ev) {
        var chip = ev.currentTarget;
        var value = selectInGroup(filterChips, chip);
        if (showMeHidden) { showMeHidden.value = value; }
    }

    /**
     * onSubmit
     *
     * What:  Client-side guard before the real POST to /signin/save-profile.
     *        The phone number isn't in this form — it's in the server
     *        session (req.session.pendingAuth). All we send up is the
     *        name + email + diet selections; the controller calls
     *        /api/v1/auth/save-profile and redirects to `next` on success.
     */
    function onSubmit(ev) {
        if (!form) { return; }
        var nameInput = document.getElementById('profile-name');
        if (nameInput && !nameInput.value.trim()) {
            ev.preventDefault();
            nameInput.focus();
            return;
        }
        // Let the browser submit to /signin/save-profile.
    }

    function onReady() {
        cacheRefs();
        if (!form) { return; }

        dietChips.forEach(function (c)  { c.addEventListener('click', onDietClick); });
        filterChips.forEach(function (c) { c.addEventListener('click', onFilterClick); });
        form.addEventListener('submit', onSubmit);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
