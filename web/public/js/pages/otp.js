/*
 * pages/otp.js
 *
 * What:  Drives the OTP verification screen (Step 2 of the auth flow).
 *         • Six digit boxes — auto-advance focus on every keystroke,
 *           reverse-focus on Backspace from an empty box, paste a
 *           6-digit code to fill all at once.
 *         • Countdown timer — "Resend code in 0:45" ticks down to 0:00,
 *           then becomes a clickable "Resend code" link.
 *         • Form submit — demo mode just navigates to Step 3
 *           (/signin?step=profile). Real Verify-OTP wiring lands when
 *           the api endpoint ships.
 * Used:  Loaded only on the OTP screen (AuthController sets
 *        extra_js: '/js/pages/otp.js' when step=otp).
 *
 * Change log:
 *   2026-05-26 — initial.
 */

(function () {
    'use strict';

    var form, boxes, countdownEl, submitBtn, hiddenOtp;
    var COUNTDOWN_SECONDS = 45;     // mockup says 0:45
    var countdownTimer    = null;

    /**
     * cacheRefs
     *
     * What:  Resolves + stores DOM refs the page interacts with. Called
     *        once on DOM-ready. If the OTP form isn't on the page (i.e.
     *        the script loaded on the wrong page) every binding below
     *        becomes a no-op via the !form guard.
     */
    function cacheRefs() {
        form        = document.getElementById('otp-form');
        boxes       = form ? form.querySelectorAll('.otp-box') : [];
        countdownEl = document.getElementById('otp-countdown');
        submitBtn   = form ? form.querySelector('.otp-submit') : null;
        hiddenOtp   = document.getElementById('otp-value');
    }

    /**
     * collectOtp
     *
     * What:  Joins the six box values into a single string and writes it
     *        into the hidden #otp-value field so the server gets one
     *        `otp` POST field instead of six.
     * Why:   Keeps the server payload simple (Joi schema expects exactly
     *        one `otp` field of length 6).
     */
    function collectOtp() {
        if (!hiddenOtp) { return ''; }
        var joined = '';
        for (var i = 0; i < boxes.length; i++) {
            joined += (boxes[i].value || '').replace(/\D/g, '');
        }
        hiddenOtp.value = joined;
        return joined;
    }

    // ── OTP boxes: keystroke, backspace, paste ─────────────────────

    /**
     * onBoxInput
     *
     * What:  Handles every keystroke in a digit box. Strips non-digit
     *        chars and, if the box now has a digit, moves focus to the
     *        next box. When all 6 boxes are filled it auto-submits the
     *        form so the user doesn't have to tap Verify.
     */
    function onBoxInput(ev) {
        var box = ev.target;
        // Strip non-digits — paranoid even though inputmode=numeric.
        var clean = (box.value || '').replace(/\D/g, '');
        // Only keep the LAST digit typed (max-length 1 already enforces
        // this, but typing fast on Android can occasionally double-fire).
        box.value = clean.slice(-1);

        if (box.value) {
            var idx  = parseInt(box.getAttribute('data-otp-index'), 10);
            var next = boxes[idx + 1];
            if (next) {
                next.focus();
                next.select();
            } else {
                // Last box just filled — auto-submit for nicer UX.
                submitForm();
            }
        }
    }

    /**
     * onBoxKeydown
     *
     * What:  Backspace on an empty box moves focus to the previous box
     *        (and clears its value). Left / Right arrows navigate
     *        without typing.
     */
    function onBoxKeydown(ev) {
        var box = ev.target;
        var idx = parseInt(box.getAttribute('data-otp-index'), 10);

        if (ev.key === 'Backspace' && !box.value && idx > 0) {
            ev.preventDefault();
            var prev = boxes[idx - 1];
            if (prev) {
                prev.value = '';
                prev.focus();
            }
            return;
        }
        if (ev.key === 'ArrowLeft' && idx > 0) {
            ev.preventDefault();
            boxes[idx - 1].focus();
            boxes[idx - 1].select();
            return;
        }
        if (ev.key === 'ArrowRight' && idx < boxes.length - 1) {
            ev.preventDefault();
            boxes[idx + 1].focus();
            boxes[idx + 1].select();
        }
    }

    /**
     * onBoxPaste
     *
     * What:  Pasting a 6-digit code spreads the digits across all six
     *        boxes. Triggered by Ctrl-V on desktop and by the iOS
     *        "from messages" suggestion.
     */
    function onBoxPaste(ev) {
        var text = (ev.clipboardData && ev.clipboardData.getData('text')) || '';
        var digits = text.replace(/\D/g, '').slice(0, boxes.length);
        if (!digits) { return; }
        ev.preventDefault();
        for (var i = 0; i < boxes.length; i++) {
            boxes[i].value = digits[i] || '';
        }
        // Focus the first empty box (or last if fully filled), then
        // submit when full.
        var filled = digits.length;
        var target = boxes[Math.min(filled, boxes.length - 1)];
        if (target) { target.focus(); target.select(); }
        if (filled === boxes.length) { submitForm(); }
    }

    // ── Countdown ──────────────────────────────────────────────────

    /**
     * startCountdown
     *
     * What:  Ticks the "Resend code in M:SS" label down to 0:00, then
     *        swaps it to a tappable "Resend code" link that restarts
     *        the timer.
     */
    function startCountdown() {
        if (!countdownEl) { return; }
        var remaining = COUNTDOWN_SECONDS;
        renderCountdown(remaining);
        if (countdownTimer) { window.clearInterval(countdownTimer); }
        countdownTimer = window.setInterval(function () {
            remaining -= 1;
            if (remaining <= 0) {
                window.clearInterval(countdownTimer);
                countdownTimer = null;
                renderResendLink();
                return;
            }
            renderCountdown(remaining);
        }, 1000);
    }

    /**
     * renderCountdown
     *
     * What:  Formats seconds as M:SS and stuffs it into the countdown
     *        element. Pure presentation — no event binding.
     */
    function renderCountdown(seconds) {
        var m = Math.floor(seconds / 60);
        var s = seconds % 60;
        countdownEl.textContent = m + ':' + (s < 10 ? '0' + s : s);
    }

    /**
     * renderResendLink
     *
     * What:  Replaces the countdown text with a tappable "Resend code"
     *        button that restarts the timer + clears the input boxes.
     *        In the real flow this also re-POSTs to /api/v1/customer/
     *        send-otp; for the demo we just restart the countdown.
     */
    function renderResendLink() {
        if (!countdownEl) { return; }
        countdownEl.textContent = '';
        var btn = document.createElement('button');
        btn.type         = 'button';
        btn.className    = 'otp-timer__resend';
        btn.textContent  = 'Resend code';
        btn.addEventListener('click', function () {
            // Clear all the boxes then restart the timer + toast a hint.
            for (var i = 0; i < boxes.length; i++) { boxes[i].value = ''; }
            if (boxes[0]) { boxes[0].focus(); }
            startCountdown();
            if (window.EatNDealUi && window.EatNDealUi.showToast) {
                window.EatNDealUi.showToast('info', 'A new code has been sent.');
            }
        });
        countdownEl.appendChild(btn);
    }

    // ── Submit ─────────────────────────────────────────────────────

    /**
     * submitForm
     *
     * What:  Joins the six boxes into the hidden `otp` field and submits
     *        the form to POST /signin/verify. The server validates,
     *        calls /api/v1/auth/verify-otp, and redirects to either the
     *        landing page (existing customer) or /signin?step=profile
     *        (new / pending). Phone number is already in the server
     *        session — we don't need to send it back here.
     */
    function submitForm() {
        if (!form) { return; }
        var code = collectOtp();
        if (code.length !== boxes.length) { return; }   // not full yet
        form.submit();
    }

    /**
     * onSubmit
     *
     * What:  Form-level submit handler — refuses to submit when the boxes
     *        aren't fully filled, otherwise lets the browser POST.
     */
    function onSubmit(ev) {
        var code = collectOtp();
        if (code.length !== boxes.length) {
            ev.preventDefault();
            // Focus the first empty box for the user to fix.
            for (var i = 0; i < boxes.length; i++) {
                if (!boxes[i].value) { boxes[i].focus(); break; }
            }
            return;
        }
        // Let the browser submit to /signin/verify.
    }

    // ── Wire up ────────────────────────────────────────────────────

    function onReady() {
        cacheRefs();
        if (!form) { return; }

        boxes.forEach(function (box) {
            box.addEventListener('input',   onBoxInput);
            box.addEventListener('keydown', onBoxKeydown);
            box.addEventListener('paste',   onBoxPaste);
            // Selecting the contents on focus makes a single-tap edit
            // intuitive — tapping a filled box highlights so the next
            // keystroke replaces.
            box.addEventListener('focus', function () { box.select(); });
        });

        form.addEventListener('submit', onSubmit);

        // Auto-focus the first box after a brief delay so any page
        // transition / animation has settled.
        if (boxes[0]) {
            window.setTimeout(function () { boxes[0].focus(); }, 100);
        }

        startCountdown();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
