'use strict';

/**
 * Validators/auth.js
 *
 * What:  Server-side validation for the admin auth forms. Dual-side
 *        validation per Coding-Conventions — the login.js page script
 *        validates in the browser for instant feedback, and this re-checks
 *        on the server because client checks can be bypassed.
 * Type:  READ (pure functions, no side effects).
 * Used:  Controllers/AuthController.doLogin.
 */

// Pragmatic email shape — not RFC-perfect, just enough to reject obvious
// typos before we spend a round-trip on the api.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * validateLogin
 *
 * What:  Checks the email + password from the login form.
 * Inputs: body — { email, password } from req.body.
 * Output: { ok: true, value: { email, password } }
 *         | { ok: false, errors: { email?, password? }, message }
 */
function validateLogin(body) {
    const errors = {};
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');

    if (!email) {
        errors.email = 'Email is required.';
    } else if (!EMAIL_RE.test(email)) {
        errors.email = 'Enter a valid email address.';
    }

    if (!password) {
        errors.password = 'Password is required.';
    } else if (password.length < 6) {
        errors.password = 'Password must be at least 6 characters.';
    }

    if (Object.keys(errors).length) {
        return { ok: false, errors, message: 'Please fix the highlighted fields.' };
    }
    return { ok: true, value: { email, password } };
}

module.exports = { validateLogin };
