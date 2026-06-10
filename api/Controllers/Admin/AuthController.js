'use strict';

/*
 * Controllers/Admin/AuthController.js
 *
 * What:  Auth endpoints for the ADMIN console (admin/ layer, port 4503):
 *
 *          POST /api/v1/admin/auth/login           — email + password sign-in
 *          POST /api/v1/admin/auth/forgot-password — issue a reset token
 *          POST /api/v1/admin/auth/reset-password  — set a new password
 *
 *        Two kinds of account can sign in, against the EXISTING live tables
 *        (no new tables — port-the-logic rule):
 *
 *          • SUPER ADMIN / staff — the legacy Yii `user` table. role 6 is the
 *            super admin (AssignmentList::SUPER_ADMIN). Active = status 10,
 *            is_deleted != 'Y'. Password in `password_hash`.
 *          • COMPANY (restaurant owner) — the `company` table. Active =
 *            is_active 1, deleted_at IS NULL. Password in `password`.
 *
 *        Passwords are bcrypt (Yii's generatePasswordHash → PHP `$2y$`).
 *        bcryptjs verifies `$2a$`/`$2b$`; the bytes are identical so we just
 *        normalise the version tag before comparing. New hashes we write use
 *        bcryptjs (`$2b$`), which PHP password_verify() also accepts.
 *
 * Why:   The new admin panel must authenticate the SAME credentials staff +
 *        companies already use in the legacy backend, so nothing is migrated.
 *
 * Used:  api/Routes/index.js under /admin/auth/*. Called by the admin layer's
 *        Controllers/AuthController.doLogin (admin/, port 4503).
 *
 * Change log:
 *   2026-06-09 — initial; login + forgot-password + reset-password.
 */

const crypto      = require('node:crypto');
const bcrypt      = require('bcryptjs');
const jwt         = require('../../Helpers/jwt');
const H           = require('../../Helpers/helper');
const { db }      = require('../../config/db');

// Reset tokens stay valid for 1 hour — matches Yii's default
// `passwordResetTokenExpire` (3600s).
const RESET_TOKEN_EXPIRE_SEC = 3600;

// Super-admin role id in the legacy `user` table (AssignmentList::SUPER_ADMIN).
const ROLE_SUPER_ADMIN = 6;
// Yii "active" status in the `user` table (Yii convention: 10 = active).
const USER_STATUS_ACTIVE = 10;

/**
 * compatHash — normalise a PHP `$2y$` bcrypt hash to `$2a$` so bcryptjs can
 * verify it. The hash bytes are otherwise identical; only the version tag
 * differs, and bcrypt ignores it during verification.
 */
function compatHash(hash) {
    return String(hash || '').replace(/^\$2y\$/, '$2a$');
}

/**
 * verifyPassword — bcrypt-compare a plaintext password against a stored hash.
 * Returns false (never throws) on any malformed-hash error.
 */
async function verifyPassword(plain, stored) {
    if (!stored) { return false; }
    try {
        return await bcrypt.compare(String(plain), compatHash(stored));
    } catch {
        return false;
    }
}

/**
 * makeResetToken — build a Yii-style reset token: "<random>_<unixSeconds>".
 * The trailing timestamp lets resetPassword cheaply check expiry without a
 * separate column.
 */
function makeResetToken() {
    return crypto.randomBytes(32).toString('hex') + '_' + Math.floor(Date.now() / 1000);
}

/**
 * resetTokenExpired — true if the token's timestamp suffix is older than the
 * expiry window (or the token is malformed).
 */
function resetTokenExpired(token) {
    const parts = String(token || '').split('_');
    const ts = parseInt(parts[parts.length - 1], 10);
    if (!ts) { return true; }
    return (Math.floor(Date.now() / 1000) - ts) > RESET_TOKEN_EXPIRE_SEC;
}

/**
 * login
 *
 * What:  Authenticates an admin (super admin / staff) or a company against the
 *        live tables, then mints a JWT and returns a small profile.
 * Type:  READ (no writes).
 * Output: { token, admin: { id, name, email, role, company_id } }
 *         role is one of: 'super_admin' | 'admin' | 'company'.
 */
async function login(req, res) {
    try {
        const { email, password } = req.body;   // validated + lowercased

        // ── 1) Staff / admin — the `user` table ──
        // The legacy login matches by USERNAME or email, and there can be
        // DUPLICATE rows for one email (e.g. an old inactive row + the live
        // one). Yii's findByUsername() filters status=ACTIVE in the query, so
        // it always lands on the live row. We mirror that: match email-or-
        // username, drop deleted rows, and order ACTIVE rows first, then pick
        // the row whose password verifies. A plain .first() could otherwise
        // grab an inactive duplicate and wrongly reject the login.
        const candidates = await db('user')
            .where((b) => {
                b.whereRaw('LOWER(email) = ?', [email]).orWhereRaw('LOWER(username) = ?', [email]);
            })
            .whereRaw("COALESCE(is_deleted, 'N') <> 'Y'")
            .select('id', 'username', 'email', 'firstname', 'lastname', 'status', 'role', 'company_id', 'password_hash')
            .orderByRaw('CASE WHEN status = ' + USER_STATUS_ACTIVE + ' THEN 0 ELSE 1 END')
            .orderBy('id', 'desc');

        if (candidates.length) {
            let activeMatch = null;
            let inactiveMatch = null;
            for (const r of candidates) {
                // eslint-disable-next-line no-await-in-loop
                if (await verifyPassword(password, r.password_hash)) {
                    if (Number(r.status) === USER_STATUS_ACTIVE) { activeMatch = r; break; }
                    if (!inactiveMatch) { inactiveMatch = r; }
                }
            }

            if (activeMatch) {
                const u = activeMatch;
                // Role: 6 = global super admin; tied to a company (company_id>0)
                // = company login (companies sign in through `user`); else admin.
                let role = 'admin';
                if (Number(u.role) === ROLE_SUPER_ADMIN) { role = 'super_admin'; }
                else if (Number(u.company_id) > 0)       { role = 'company'; }
                const token = jwt.sign({ sub: String(u.id), kind: 'admin', src: 'user', role, company_id: Number(u.company_id) || 0 });
                return H.successResponse(res, {
                    token,
                    admin: {
                        id:         Number(u.id),
                        name:       [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username || u.email,
                        email:      u.email || u.username,
                        role,
                        company_id: Number(u.company_id) || 0,
                    },
                }, 'Signed in');
            }
            if (inactiveMatch) {
                return H.errorResponse(res, 'Your account is inactive. Please contact a super admin.', 401, { code: 'account_inactive' });
            }
            // The email/username exists but the password is wrong.
            return H.errorResponse(res, 'Invalid email or password.', 401, { code: 'bad_credentials' });
        }

        // ── 2) Company owner — the `company` table ──
        const c = await db('company').whereRaw('LOWER(email) = ?', [email]).first();
        if (c) {
            if (c.deleted_at != null) {
                return H.errorResponse(res, 'This account has been removed.', 401, { code: 'account_removed' });
            }
            if (Number(c.is_active) !== 1) {
                return H.errorResponse(res, 'Your company account is not active yet. Please contact support.', 401, { code: 'account_inactive' });
            }
            if (!(await verifyPassword(password, c.password))) {
                return H.errorResponse(res, 'Invalid email or password.', 401, { code: 'bad_credentials' });
            }
            const token = jwt.sign({ sub: String(c.id), kind: 'admin', src: 'company', role: 'company', company_id: Number(c.id) });
            return H.successResponse(res, {
                token,
                admin: {
                    id:         Number(c.id),
                    name:       c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
                    email:      c.email,
                    role:       'company',
                    company_id: Number(c.id),
                },
            }, 'Signed in');
        }

        // ── 3) No match — same message as a wrong password (no enumeration) ──
        return H.errorResponse(res, 'Invalid email or password.', 401, { code: 'bad_credentials' });
    } catch (err) {
        console.error('[admin.auth.login]', err && err.message);
        return H.errorResponse(res, 'Something went wrong. Please try again.', 500);
    }
}

/**
 * forgotPassword
 *
 * What:  Issues a reset token for the matching user/company and stores it in
 *        their password_reset_token column. Always returns the SAME generic
 *        message (anti-enumeration). No mailer is wired yet, so in non-prod we
 *        also return the token so the flow can be tested end-to-end; in prod
 *        the token would only ever be delivered by email.
 * Type:  WRITE (password_reset_token).
 */
async function forgotPassword(req, res) {
    try {
        const { email } = req.body;
        const token = makeResetToken();
        let matched = false;

        const u = await db('user').whereRaw('LOWER(email) = ?', [email]).first();
        if (u && String(u.is_deleted || 'N').toUpperCase() !== 'Y') {
            await db('user').where({ id: u.id }).update({ password_reset_token: token });
            matched = true;
        } else {
            const c = await db('company').whereRaw('LOWER(email) = ?', [email]).first();
            if (c && c.deleted_at == null) {
                await db('company').where({ id: c.id }).update({ password_reset_token: token });
                matched = true;
            }
        }

        const data = { sent: true };
        const isProd = (process.env.APP_ENV || 'development') === 'production';
        if (!isProd && matched) {
            // Testing aid ONLY (no email infra). Never returned in production.
            data.dev_token = token;
        }
        return H.successResponse(res, data, 'If that email is registered, a password reset link has been sent.');
    } catch (err) {
        console.error('[admin.auth.forgotPassword]', err && err.message);
        return H.errorResponse(res, 'Something went wrong. Please try again.', 500);
    }
}

/**
 * resetPassword
 *
 * What:  Validates a reset token (format + expiry), then sets a new bcrypt
 *        password hash and clears the token.
 * Type:  WRITE (password_hash / password + password_reset_token).
 */
async function resetPassword(req, res) {
    try {
        const { token, password } = req.body;

        if (resetTokenExpired(token)) {
            return H.errorResponse(res, 'This reset link has expired. Please request a new one.', 422, { code: 'token_expired' });
        }

        const hash = await bcrypt.hash(String(password), 10);

        const u = await db('user').where({ password_reset_token: token }).first();
        if (u) {
            await db('user').where({ id: u.id }).update({ password_hash: hash, password_reset_token: null });
            return H.successResponse(res, { reset: true }, 'Your password has been reset. You can now sign in.');
        }

        const c = await db('company').where({ password_reset_token: token }).first();
        if (c) {
            await db('company').where({ id: c.id }).update({ password: hash, password_reset_token: null });
            return H.successResponse(res, { reset: true }, 'Your password has been reset. You can now sign in.');
        }

        return H.errorResponse(res, 'This reset link is invalid or has already been used.', 422, { code: 'token_invalid' });
    } catch (err) {
        console.error('[admin.auth.resetPassword]', err && err.message);
        return H.errorResponse(res, 'Something went wrong. Please try again.', 500);
    }
}

/**
 * hashPassword — bcrypt-hash a new password, stored Yii-style ($2y$) so the
 * legacy PHP backend reads it identically. cost 12 (strong, fast enough).
 */
async function hashPassword(plain) {
    const h = await bcrypt.hash(String(plain), 12);
    return h.replace(/^\$2[ab]\$/, '$2y$');
}

// Resolve the signed-in admin's account table + id from the JWT. `src` is
// stamped at login ('user' for staff/super-admin, 'company' for a company-
// table login); fall back to 'user' for older tokens.
function accountRef(req) {
    const u = (req && req.user) || {};
    return { src: u.src === 'company' ? 'company' : 'user', id: Number(u.sub), role: u.role };
}

/**
 * me — GET /api/v1/admin/auth/me
 * The signed-in admin's editable profile (name parts + email), from whichever
 * table they authenticated against.
 */
async function me(req, res) {
    try {
        const { src, id, role } = accountRef(req);
        if (src === 'company') {
            // Company login — the company table carries name/email + a contact
            // number (mobile) and PIN (no address columns on company).
            const c = await db('company').where('id', id)
                .select('id', 'business_name', 'first_name', 'last_name', 'email', 'mobile', 'pin').first();
            if (!c) { return H.errorResponse(res, 'Account not found.', 404); }
            return H.successResponse(res, { profile: {
                id: Number(c.id), src, role,
                business_name: c.business_name || '',
                first_name: c.first_name || '', last_name: c.last_name || '',
                email: c.email || '',
                mobile: c.mobile || '',
                pin: c.pin || '',
            } });
        }
        // User / staff login — the user table carries the full personal-details
        // set (contact number, address, postcode, city, PIN).
        const u = await db('user').where('id', id)
            .select('id', 'firstname', 'lastname', 'email', 'username',
                    'contact_no', 'address_1', 'address_2', 'postcode', 'city', 'pin').first();
        if (!u) { return H.errorResponse(res, 'Account not found.', 404); }
        return H.successResponse(res, { profile: {
            id: Number(u.id), src, role,
            first_name: u.firstname || '', last_name: u.lastname || '',
            email: u.email || u.username || '',
            contact_no: u.contact_no || '',
            address_1: u.address_1 || '', address_2: u.address_2 || '',
            postcode: u.postcode || '', city: u.city || '',
            pin: u.pin || '',
        } });
    } catch (err) {
        console.error('[admin.auth.me]', err && err.message);
        return H.errorResponse(res, 'Could not load your profile.', 500);
    }
}

/**
 * updateProfile — POST /api/v1/admin/auth/profile
 * Updates the signed-in admin's name parts + email (and business_name for a
 * company login). Rejects an email already used by another account.
 */
async function updateProfile(req, res) {
    try {
        const { src, id } = accountRef(req);
        const companyId = Number(req.user && req.user.company_id) || 0;
        const b = req.body;
        const email = String(b.email || '').trim().toLowerCase();
        const table = src === 'company' ? 'company' : 'user';
        const pin = String(b.pin || '').trim();   // blank = keep the current PIN

        // Email must be unique within the same account table.
        const dupe = await db(table)
            .whereRaw('LOWER(email) = ?', [email])
            .andWhere('id', '!=', id)
            .first();
        if (dupe) { return H.errorResponse(res, 'That email is already in use.', 409, { code: 'email_taken' }); }

        if (src === 'company') {
            // Company login → company.{name,email,mobile,pin}. (No address cols.)
            const patch = {
                business_name: String(b.business_name || '').trim() || null,
                first_name:    String(b.first_name || '').trim() || null,
                last_name:     String(b.last_name || '').trim() || null,
                email,
                mobile:        String(b.mobile || '').trim() || null,
                updated_at:    db.fn.now(),
                updated_by:    id,
            };
            if (pin) { patch.pin = pin; }
            await db('company').where('id', id).update(patch);
        } else {
            // User / staff login → the full personal-details set. Contact number
            // and PIN are unique within the company (mirrors the legacy
            // personal-details checks), ignoring deleted rows + this account.
            const contactNo = String(b.contact_no || '').trim();
            if (contactNo) {
                const clash = await db('user')
                    .where({ company_id: companyId, contact_no: contactNo })
                    .andWhere('id', '!=', id)
                    .whereRaw("COALESCE(is_deleted, 'N') <> 'Y'")
                    .first();
                if (clash) { return H.errorResponse(res, 'Contact number already exists.', 409, { code: 'contact_taken' }); }
            }
            if (pin) {
                const clash = await db('user')
                    .where({ company_id: companyId, pin })
                    .andWhere('id', '!=', id)
                    .whereRaw("COALESCE(is_deleted, 'N') <> 'Y'")
                    .first();
                if (clash) { return H.errorResponse(res, 'PIN already exists.', 409, { code: 'pin_taken' }); }
            }
            const patch = {
                firstname:  String(b.first_name || '').trim() || null,
                lastname:   String(b.last_name || '').trim() || null,
                email,
                username:   email,   // legacy keeps user.username in step with email
                contact_no: contactNo || null,
                address_1:  String(b.address_1 || '').trim() || null,
                address_2:  String(b.address_2 || '').trim() || null,
                postcode:   String(b.postcode || '').trim() || null,
                city:       String(b.city || '').trim() || null,
                updated_at: db.fn.now(),
                updated_by: id,
            };
            if (pin) { patch.pin = pin; }
            await db('user').where('id', id).update(patch);
        }
        return H.successResponse(res, { saved: true }, 'Profile updated.');
    } catch (err) {
        console.error('[admin.auth.updateProfile]', err && err.message);
        return H.errorResponse(res, 'Could not update your profile.', 500);
    }
}

/**
 * changePassword — POST /api/v1/admin/auth/change-password
 * Verifies the current password, then stores a new bcrypt hash in the right
 * column (user.password_hash or company.password).
 */
async function changePassword(req, res) {
    try {
        const { src, id } = accountRef(req);
        const b = req.body;
        const table = src === 'company' ? 'company' : 'user';
        const pwCol = src === 'company' ? 'password' : 'password_hash';

        const row = await db(table).where('id', id).first();
        if (!row) { return H.errorResponse(res, 'Account not found.', 404); }

        if (!(await verifyPassword(b.current_password, row[pwCol]))) {
            return H.errorResponse(res, 'Your current password is incorrect.', 400, { code: 'bad_current' });
        }

        const newHash = await hashPassword(b.new_password);
        await db(table).where('id', id).update({ [pwCol]: newHash });
        return H.successResponse(res, { changed: true }, 'Password changed.');
    } catch (err) {
        console.error('[admin.auth.changePassword]', err && err.message);
        return H.errorResponse(res, 'Could not change your password.', 500);
    }
}

module.exports = { login, forgotPassword, resetPassword, me, updateProfile, changePassword };
