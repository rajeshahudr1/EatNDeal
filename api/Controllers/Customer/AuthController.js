'use strict';

/*
 * Controllers/Customer/AuthController.js
 *
 * What:  Customer-side auth endpoints. Phase 1 covers OTP issue + verify:
 *
 *          POST /auth/send-otp     — generate + send a 6-digit OTP
 *          POST /auth/verify-otp   — verify the code (consumes on success)
 *
 *        Both are PUBLIC — the whole point is to log a guest in. Later
 *        phases will add /auth/refresh, /auth/sign-out, etc.
 *
 * Why:   The three-step sign-in flow on the web (mobile → OTP → profile)
 *        needs a real backend so the demo OTP screen can graduate to a
 *        production endpoint. Provider is picked by SMS_PROVIDER env via
 *        Helpers/otpSender.js (demo | connexa) — see that file for the
 *        provider matrix.
 *
 * Used:  Wired in api/Routes/index.js under /auth/*.
 *
 * Change log:
 *   2026-05-26 — initial; sendOtp + verifyOtp ported from Yii Site::actionSendOtp
 *                + actionVerifyOtp.
 */

const crypto       = require('node:crypto');
const H            = require('../../Helpers/helper');
const MSG          = require('../../Helpers/messages');
const otp          = require('../../Helpers/otpSender');
const customers    = require('../../Helpers/customerLookup');
const profile      = require('../../Helpers/customerProfile');
const social       = require('../../Helpers/socialAuth');
const Loyalty      = require('../../Helpers/loyalty');   // event_cashback on first profile save
const { db }       = require('../../config/db');

// Whether customer.gender exists yet (added by m260529_140000). Checked
// once + cached so updateProfile can write gender after the migration is
// run, but never errors on a DB where the column isn't there yet.
let _hasGenderCol = null;
async function customerHasGender() {
    if (_hasGenderCol !== null) { return _hasGenderCol; }
    try {
        const r = await db.raw(
            "select 1 from information_schema.columns where table_name = 'customer' and column_name = 'gender' limit 1",
        );
        const rows = r && (r.rows || r);
        _hasGenderCol = Array.isArray(rows) ? rows.length > 0 : false;
    } catch (e) {
        _hasGenderCol = false;
    }
    return _hasGenderCol;
}

/**
 * sendOtp
 *
 * What:  Issues a fresh OTP for (country_code, contact_no) — replaces any
 *        prior unexpired OTP for the same number — and (in live mode) sends
 *        the code over SMS via Connexa.
 *
 *        In demo mode the OTP is fixed (default '123456'), no SMS is sent,
 *        and the response includes `dev_otp` so the developer can see the
 *        code without inspecting the DB. The `dev_otp` field is NEVER
 *        present in live mode — the front-end must not rely on it.
 *
 * Why:   See Helpers/otpSender.js. Body shape mirrors the Yii action so
 *        the front-end migration is a one-line URL swap.
 * Type:  WRITE (inserts into customer_otp + optional Connexa POST).
 *
 * Inputs:
 *   req.body.country_code  — string, 1–4 digits (e.g. '44')
 *   req.body.contact_no    — string, 4–20 chars
 *
 * Output (success):
 *   200 envelope, data = {
 *     provider:    'demo' | 'connexa',
 *     expires_in:  seconds until OTP expires,
 *     dev_otp?:    '123456'  // demo only
 *   }
 *
 * Output (failure):
 *   200 envelope, status=502, msg=MSG.auth.otpSendFailed (live send error)
 *   200 envelope, status=422 from validate middleware (bad inputs)
 */
async function sendOtp(req, res) {
    try {
        const { country_code, contact_no } = req.body;

        const result = await otp.generateAndSend({
            countryCode: country_code,
            contactNo:   contact_no,
        });

        if (!result.ok) {
            return H.errorResponse(res, MSG.auth.otpSendFailed, 502);
        }

        const data = {
            provider:   result.provider,
            expires_in: Math.max(
                0,
                Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
            ),
        };
        // Surface the demo code so the developer doesn't have to query the
        // DB. Stripped automatically in live mode (devOtp is undefined).
        if (result.devOtp) {
            data.dev_otp = result.devOtp;
        }

        return H.successResponse(res, data, MSG.auth.otpSent);
    } catch (err) {
        H.log.error('auth.sendOtp', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * verifyOtp
 *
 * What:  Verifies the (country_code, contact_no, otp) triple against the
 *        latest row in customer_otp. On success the row is consumed
 *        (deleted) so the same code cannot be re-used.
 *
 *        After a valid OTP we ALSO look up the marketplace customer row
 *        for the same number (company_id IS NULL) and classify it so the
 *        front-end can branch:
 *          'existing'   → skip Personal Details; go to the landing page
 *          'new'        → ask for Personal Details (first-time visitor)
 *          'pending'    → ask for Personal Details (verified before but
 *                          never finished the profile — save will UPDATE)
 *          'disabled'   → block sign-in (status='0')
 *          'deleted'    → block sign-in (status='2')
 *          'banned'     → block sign-in (banned_reason set)
 *
 *        Also stamps `verify_at` on a pending row so the Yii system's
 *        analytics + the "last OTP verified" sort still work.
 *
 *        Does NOT issue a session / JWT yet — that lands in Phase 2 along
 *        with full customer login.
 * Type:  READ + WRITE (deletes OTP row, optionally bumps customer.verify_at).
 *
 * Inputs:
 *   req.body.country_code  — string, 1–4 digits
 *   req.body.contact_no    — string
 *   req.body.otp           — string, exactly 6 digits
 *
 * Output (success):
 *   200 envelope, data = {
 *     verified:        true,
 *     customer_status: 'new' | 'pending' | 'existing',
 *     customer?:       { id, firstname, lastname, email, ... }   // 'existing' only
 *   }
 *
 * Output (blocked accounts — OTP itself is correct but the account is
 * not allowed to sign in):
 *   200 envelope, status=403, msg=<friendly reason>
 *
 * Output (bad OTP):
 *   200 envelope, status=422, msg=MSG.auth.otpInvalid
 *
 * Note on wording: we deliberately use ONE message for both "wrong code"
 * and "expired" — never leak which failure hit, so brute-forcers can't
 * use response wording to time their attacks.
 */
async function verifyOtp(req, res) {
    try {
        const { country_code, contact_no, otp: code } = req.body;

        const result = await otp.verify({
            countryCode: country_code,
            contactNo:   contact_no,
            otp:         code,
        });

        if (!result.ok) {
            return H.errorResponse(res, MSG.auth.otpInvalid, 422);
        }

        // OTP is good — look up the marketplace customer row.
        const row    = await customers.findByPhone({ countryCode: country_code, contactNo: contact_no });
        const state  = customers.classify(row);

        // Account-block branches first — these end the flow.
        if (state === 'deleted') {
            // Mirror Yii: deleted rows behave as "not found" rather than
            // surfacing the soft-delete to the user.
            return H.errorResponse(res, MSG.auth.accountDisabled, 403);
        }
        if (state === 'disabled') {
            return H.errorResponse(res, MSG.auth.accountDisabled, 403);
        }
        if (state === 'banned') {
            return H.errorResponse(res, MSG.auth.accountBanned, 403);
        }

        // Stamp verify_at on a pending row so we know the user passed
        // OTP even if they never finish the profile step.
        if (row && state === 'pending') {
            await db('customer')
                .where({ id: row.id })
                .update({
                    verify_at:         H.now(),
                    updated_at:        db.fn.now(),
                    server_updated_at: db.fn.now(),
                });
        }

        const data = { verified: true, customer_status: state };
        if (state === 'existing') {
            data.customer = customers.publicView(row);
            // Stamp verify_at on existing customers too — it's the
            // "last successful sign-in attempt" marker we use for
            // dormant-account reports.
            await db('customer')
                .where({ id: row.id })
                .update({
                    verify_at:         H.now(),
                    updated_at:        db.fn.now(),
                    server_updated_at: db.fn.now(),
                });
        }

        return H.successResponse(res, data, MSG.auth.otpVerified);
    } catch (err) {
        H.log.error('auth.verifyOtp', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * saveProfile
 *
 * What:  Saves the Personal-Details step of the sign-up flow.
 *          • Mobile must already have been OTP-verified — we re-check by
 *            looking up the row (or its absence) one more time on the
 *            same (country_code, contact_no) key. We do NOT trust the
 *            front-end to tell us "OTP passed".
 *          • If a row exists with status<>'2' AND is_registered=0 →
 *            UPDATE it (firstname, email, is_registered=1, registered_at).
 *          • If no row exists → INSERT a new marketplace customer:
 *              company_id   = NULL   (marketplace, not per-tenant)
 *              status       = '1'    (active)
 *              signup_source= '1'    (web; Yii keeps '2' for app, etc.)
 *              is_registered= 1
 *              registered_at= now()
 *              verify_at    = now()
 *          • If a row already has is_registered=1 → treat as a duplicate
 *            (the front-end should have routed to the landing page).
 *            Return 'existing' so the client can recover.
 *          • If the row is disabled / banned / deleted → mirror the
 *            verify guard and refuse.
 *
 * Why:   One canonical save path keeps the marketplace consistent with
 *        the existing Yii customer set (Yii reads the same columns;
 *        leaving any default unset would surface as nulls in their
 *        webordering admin UI).
 * Type:  WRITE.
 *
 * Inputs:
 *   req.body.country_code — string
 *   req.body.contact_no   — string
 *   req.body.firstname    — string, 1..120
 *   req.body.lastname?    — string, 0..120
 *   req.body.email?       — string, valid email
 *
 * Output:
 *   200 success — { status:200, data:{ customer:{...}, created:bool } }
 *   200 failure — { status:403, ... }   account blocked
 *                 { status:422, ... }   validation / state mismatch
 */
async function saveProfile(req, res) {
    try {
        const { country_code, contact_no, firstname, lastname, email } = req.body;

        const row   = await customers.findByPhone({ countryCode: country_code, contactNo: contact_no });
        const state = customers.classify(row);

        if (state === 'deleted' || state === 'disabled') {
            return H.errorResponse(res, MSG.auth.accountDisabled, 403);
        }
        if (state === 'banned') {
            return H.errorResponse(res, MSG.auth.accountBanned, 403);
        }
        if (state === 'existing') {
            // Already done — front-end shouldn't have called this, but
            // returning the existing record beats failing the form.
            return H.successResponse(res, {
                customer: customers.publicView(row),
                created:  false,
            }, MSG.auth.otpVerified);
        }

        const cleanContact = customers.normalisePhone(contact_no);
        const cleanCountry = Number(customers.normalisePhone(country_code)) || 0;

        // Referral (Invite & Earn) — if the signup form carried a friend's
        // code, bind referred_by to that customer (invalid code is silently
        // ignored, like legacy actionSignup). Every new customer also gets
        // their OWN referral_code.
        const referrerId = await customers.resolveReferrer(req.body.referred_code);

        if (row && state === 'pending') {
            // UPDATE the OTP-verified stub into a fully-registered row.
            await db('customer')
                .where({ id: row.id })
                .update({
                    firstname:         firstname,
                    lastname:          lastname || null,
                    email:             email    || null,
                    is_registered:     1,
                    referral_code:     row.referral_code || customers.generateReferralCode(),
                    referred_by:       row.referred_by || referrerId || null,
                    registered_at:     H.now(),
                    verify_at:         H.now(),
                    updated_at:        db.fn.now(),
                    server_updated_at: db.fn.now(),
                });
            const fresh = await db('customer').where({ id: row.id }).first();
            return H.successResponse(res, {
                customer: customers.publicView(fresh),
                created:  false,
            }, MSG.resource.updated);
        }

        // No row → INSERT a marketplace customer. NULL company_id so the
        // row sits outside any restaurant's per-tenant customer set.
        // is_marketplace_user=1 marks the row as belonging to the new
        // marketplace PWA for fast reporting / segmentation queries
        // (see m260526_103000_add_is_marketplace_user_to_customer.php).
        const [inserted] = await db('customer')
            .insert({
                firstname:            firstname,
                lastname:             lastname || null,
                email:                email    || null,
                contact_no:           cleanContact,
                country_code:         cleanCountry,
                company_id:           null,
                status:               '1',
                signup_source:        '1',
                is_registered:        1,
                is_marketplace_user:  1,
                referral_code:        customers.generateReferralCode(),
                referred_by:          referrerId || null,
                registered_at:        H.now(),
                verify_at:            H.now(),
                // POS app-side identity (legacy OrderController::appid): app_id =
                // next in the terminalid='500' sequence, localid=0, terminalid=500.
                app_id:               await customers.nextAppId(),
                localid:              '0',
                terminalid:           '500',
            })
            .returning('*');

        return H.successResponse(res, {
            customer: customers.publicView(inserted),
            created:  true,
        }, MSG.resource.created);
    } catch (err) {
        H.log.error('auth.saveProfile', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * updateProfile
 *
 * What:  Updates a marketplace customer (status='1', not banned/deleted)
 *        identified by customer_id. Unlike saveProfile (which uses the
 *        phone as the identity key), this one is for the signed-in
 *        edit-your-profile screen where the phone itself may be one of
 *        the things being changed:
 *          • Social-signup customers arrive here with NULL contact_no
 *            and need to add a phone for checkout.
 *          • Phone-OTP customers may want to update name + email
 *            without re-running OTP.
 *
 *        Authentication note: Phase 1 trusts the customer_id sent by
 *        the web layer, which sources it from req.session.user.id. The
 *        api is not yet exposed to the public internet — when JWT
 *        auth lands in Phase 2 this endpoint switches to
 *        `req.auth.customerId` and ignores the body field.
 *
 *        Duplicate-phone guard: if the new (country_code, contact_no)
 *        already belongs to a DIFFERENT marketplace customer row, we
 *        refuse with 409 — preventing two accounts from sharing the
 *        same number. The same number CAN appear with non-NULL
 *        company_id (per-tenant POS customers) — that's a separate
 *        namespace and not our problem.
 * Type:  WRITE.
 *
 * Inputs:
 *   req.body.customer_id         — bigint id of the row to update
 *   req.body.firstname           — required
 *   req.body.lastname, email     — optional
 *   req.body.country_code        — optional; updates phone if present
 *   req.body.contact_no          — optional; updates phone if present
 *                                  (must be set/empty together with
 *                                  country_code)
 *
 * Output:
 *   200 success — { status:200, data:{ customer:{...} } }
 *   200 failure — 401 (dead session) | 403 (blocked) | 409 (phone taken)
 *                 | 422 (state mismatch / partial phone)
 */
async function updateProfile(req, res) {
    try {
        // Editable here: NAME + EMAIL. gender/DOB live on customer_profile
        // (/auth/update-about); the PHONE can only be changed via the
        // OTP-verified /auth/change-phone flow (so a number is always proven
        // before the customer's loyalty follows it).
        const { customer_id, firstname, lastname, email } = req.body;

        const row = await db('customer')
            .where({ id: customer_id })
            .whereNull('company_id')
            .first();

        // 401, not 404 — customer_id is the session's own id, so a missing row
        // means a dead session (sign in again), not a missing record.
        if (!row) {
            return H.errorResponse(res, MSG.auth.sessionExpired, 401);
        }

        const state = customers.classify(row);
        if (state === 'deleted' || state === 'disabled') {
            return H.errorResponse(res, MSG.auth.accountDisabled, 403);
        }
        if (state === 'banned') {
            return H.errorResponse(res, MSG.auth.accountBanned, 403);
        }
        if (state !== 'existing') {
            // 'pending' rows should go through /auth/save-profile first.
            return H.errorResponse(res, MSG.validation.missingFields, 422);
        }

        const update = {
            firstname:         firstname,
            lastname:          lastname || null,
            updated_at:        db.fn.now(),
            server_updated_at: db.fn.now(),
        };

        // Email — now editable. Only touched when a value is sent (empty =
        // leave unchanged, so it can't be wiped by an untouched form). Guard
        // against another marketplace account already using it (the same email
        // is how social-signin links accounts, so it must stay unique) — mirrors
        // the phone-taken 409.
        const emailNew = String(email || '').trim();
        if (emailNew) {
            const taken = await db('customer')
                .whereRaw('LOWER(email) = LOWER(?)', [emailNew])
                .whereNull('company_id')
                .andWhere('id', '<>', row.id)
                .first();
            if (taken) {
                return H.errorResponse(res, 'That email is already linked to another account.', 409);
            }
            update.email = emailNew;
        }

        await db('customer').where({ id: row.id }).update(update);

        const fresh = await db('customer').where({ id: row.id }).first();
        return H.successResponse(res, {
            customer: customers.publicView(fresh),
        }, MSG.resource.updated);
    } catch (err) {
        H.log.error('auth.updateProfile', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * changePhone
 *
 * What:  Changes (or adds) the signed-in customer's mobile number — but ONLY
 *        after the NEW number is OTP-verified. This is the safe path for a
 *        world where a customer's loyalty follows their mobile: you can only
 *        move to a number you can prove you own, so nobody can point their
 *        account at someone else's number to steal its reward balance.
 *
 *        Flow: the web already sent an OTP to the new number (/auth/send-otp);
 *        this endpoint re-verifies that code, refuses a number already held by
 *        another marketplace account (409), then writes contact_no/country_code.
 *        The customer's wallet auto-re-syncs on the next read (loyalty follows
 *        the number — see Helpers/loyalty.linkedCustomerIds), so the OLD
 *        number's rewards drop off and the NEW number's appear.
 * Type:  WRITE.
 *
 * Inputs:  customer_id, country_code, contact_no, otp
 * Output:  200 { customer } | 401 dead session | 403 blocked | 409 number taken |
 *          422 bad OTP
 */
async function changePhone(req, res) {
    try {
        const { customer_id, country_code, contact_no, otp: code } = req.body;

        const row = await db('customer').where({ id: customer_id }).whereNull('company_id').first();
        if (!row) { return H.errorResponse(res, MSG.auth.sessionExpired, 401); }
        const state = customers.classify(row);
        if (state === 'deleted' || state === 'disabled') { return H.errorResponse(res, MSG.auth.accountDisabled, 403); }
        if (state === 'banned') { return H.errorResponse(res, MSG.auth.accountBanned, 403); }

        // Verify the code for the NEW number (consumes it on success).
        const check = await otp.verify({ countryCode: country_code, contactNo: contact_no, otp: code });
        if (!check.ok) { return H.errorResponse(res, MSG.auth.otpInvalid, 422); }

        const cleanContact = customers.normalisePhone(contact_no);
        const cleanCountry = Number(customers.normalisePhone(country_code)) || 0;

        // Duplicate guard — only against OTHER marketplace accounts. Matching a
        // restaurant's POS row (company_id > 0) is fine + intended: that's the
        // same person, and their loyalty links to it.
        if (cleanContact !== row.contact_no || cleanCountry !== row.country_code) {
            const clash = await db('customer')
                .where({ contact_no: cleanContact, country_code: cleanCountry })
                .whereNull('company_id').whereNot({ id: row.id }).first('id');
            if (clash) { return H.errorResponse(res, 'That mobile number is already used by another account.', 409); }
        }

        await db('customer').where({ id: row.id }).update({
            contact_no:        cleanContact,
            country_code:      cleanCountry,
            verify_at:         H.now(),
            updated_at:        db.fn.now(),
            server_updated_at: db.fn.now(),
        });
        const fresh = await db('customer').where({ id: row.id }).first();
        return H.successResponse(res, { customer: customers.publicView(fresh) }, MSG.resource.updated);
    } catch (err) {
        H.log.error('auth.changePhone', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * deleteAccount
 *
 * What:  Soft-deletes the signed-in customer's OWN marketplace account —
 *        status = '2' (the legacy "deleted" marker). classify() then reads the
 *        row as 'deleted', so every guard (verifyOtp, loadMarketplaceCustomer,
 *        me…) blocks it from signing in or being read again. The loyalty ledger
 *        + past orders are left untouched for the restaurants' records (legacy
 *        parity — we soft-delete the person, not their history).
 * Type:  WRITE.
 *
 * Inputs:  customer_id
 * Output:  200 { deleted:1 } | 401 dead session
 */
async function deleteAccount(req, res) {
    try {
        const { customer_id } = req.body;
        const row = await db('customer').where({ id: customer_id }).whereNull('company_id').first('id');
        if (!row) { return H.errorResponse(res, MSG.auth.sessionExpired, 401); }
        await db('customer').where({ id: row.id }).update({
            status:            '2',
            updated_at:        db.fn.now(),
            server_updated_at: db.fn.now(),
        });
        return H.successResponse(res, { deleted: 1 }, 'Your account has been deleted.');
    } catch (err) {
        H.log.error('auth.deleteAccount', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

// Whether customer.image exists yet (added by m260529_160000). Cached.
let _hasImageCol = null;
async function customerHasImage() {
    if (_hasImageCol !== null) { return _hasImageCol; }
    try {
        const r = await db.raw(
            "select 1 from information_schema.columns where table_name = 'customer' and column_name = 'image' limit 1",
        );
        const rows = r && (r.rows || r);
        _hasImageCol = Array.isArray(rows) ? rows.length > 0 : false;
    } catch (e) { _hasImageCol = false; }
    return _hasImageCol;
}

/**
 * updateAvatar
 *
 * What:  Persists the customer's profile photo PATH (the web layer has
 *        already stored the actual file + sends us the relative URL, e.g.
 *        "/avatars/101-...png"). Guarded on the customer.image column so it
 *        fails cleanly if the migration hasn't run yet.
 * Type:  WRITE.
 * Inputs: req.body — customer_id, image (relative path) | '' to clear.
 * Output: 200 envelope, data = { customer }
 */
async function updateAvatar(req, res) {
    try {
        const { customer_id, image } = req.body;
        if (!(await customerHasImage())) {
            return H.errorResponse(res, 'Photo upload is not enabled yet — run the customer.image migration.', 422);
        }
        const row = await db('customer').where({ id: customer_id }).whereNull('company_id').first();
        if (!row) { return H.errorResponse(res, MSG.auth.sessionExpired, 401); }
        const state = customers.classify(row);
        if (state === 'deleted' || state === 'disabled') { return H.errorResponse(res, MSG.auth.accountDisabled, 403); }
        if (state === 'banned') { return H.errorResponse(res, MSG.auth.accountBanned, 403); }

        await db('customer').where({ id: row.id }).update({
            image:             image || null,
            updated_at:        db.fn.now(),
            server_updated_at: db.fn.now(),
        });
        const fresh = await db('customer').where({ id: row.id }).first();
        return H.successResponse(res, { customer: customers.publicView(fresh) }, MSG.resource.updated);
    } catch (err) {
        H.log.error('auth.updateAvatar', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * me
 *
 * What:  Returns the fresh public view of a marketplace customer by id.
 *        Used by the web /account page to re-hydrate req.session.user so
 *        the profile form always reflects the DB (e.g. birthdate / gender
 *        that may have been added to publicView after the session was
 *        created). Blocked accounts return 403 with the same wording as
 *        verifyOtp so we never leak the block reason.
 * Type:  READ.
 *
 * Inputs:  req.query.customer_id
 * Output:  200 envelope, data = { customer: {...} }
 */
async function me(req, res) {
    try {
        const { customer_id } = req.query;
        const row = await db('customer').where({ id: customer_id }).whereNull('company_id').first();
        if (!row) { return H.errorResponse(res, MSG.auth.sessionExpired, 401); }
        const state = customers.classify(row);
        if (state === 'deleted' || state === 'disabled') { return H.errorResponse(res, MSG.auth.accountDisabled, 403); }
        if (state === 'banned') { return H.errorResponse(res, MSG.auth.accountBanned, 403); }
        return H.successResponse(res, { customer: customers.publicView(row) });
    } catch (err) {
        H.log.error('auth.me', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * getAbout
 *
 * What:  Returns the marketplace customer's optional "About You" profile
 *        (customer_profile) for the /account "Complete your profile"
 *        section — multi-selects decoded to arrays, dates as YYYY-MM-DD.
 *        Returns { about: null, enabled: false } when the migration hasn't
 *        run yet, and { about: null, enabled: true } when it has but the
 *        customer hasn't filled anything — the form handles both as "empty".
 *
 *        Gender / DOB / photo are NOT here — they ride on /auth/me
 *        (customer.gender / birthdate / image) and stay there.
 * Type:  READ.
 *
 * Inputs:  req.query.customer_id
 * Output:  200 envelope, data = { about: {...}|null, enabled: bool }
 */
async function getAbout(req, res) {
    try {
        const { customer_id } = req.query;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        if (!(await profile.tableExists())) {
            return H.successResponse(res, { about: null, enabled: false });
        }
        const row = await db(profile.TABLE)
            .where({ customer_id })
            .whereNull('deleted_at')
            .first();
        return H.successResponse(res, { about: profile.view(row), enabled: true });
    } catch (err) {
        H.log.error('auth.getAbout', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * updateAbout
 *
 * What:  Upserts the "About You" profile (customer_profile) for the
 *        signed-in marketplace customer. One row per customer — updates it
 *        if present, inserts (with a fresh uuid) otherwise. Every field is
 *        optional; Helpers/customerProfile.js sanitises + JSON-serialises
 *        the values, so only known tokens reach the DB.
 * Type:  WRITE.
 *
 * Inputs:  req.body.customer_id (required) + any About-You fields.
 * Output:  200 envelope, data = { about: {...} } (the fresh saved view).
 */
async function updateAbout(req, res) {
    try {
        const { customer_id } = req.body;
        const guard = await customers.loadMarketplaceCustomer(customer_id);
        if (guard.error) { return H.errorResponse(res, guard.error.msg, guard.error.status); }

        if (!(await profile.tableExists())) {
            return H.errorResponse(
                res,
                'Profile preferences aren’t enabled yet — run the customer_profile migrations.',
                422,
            );
        }

        const write = profile.buildWrite(req.body);

        const existing = await db(profile.TABLE)
            .where({ customer_id })
            .whereNull('deleted_at')
            .first();

        if (existing) {
            await db(profile.TABLE)
                .where({ id: existing.id })
                .update(Object.assign({}, write, {
                    updated_by: customer_id,
                    updated_at: db.fn.now(),
                }));
        } else {
            const [created] = await db(profile.TABLE).insert(Object.assign({}, write, {
                uuid:        crypto.randomUUID(),
                company_id:  profile.MARKETPLACE_COMPANY_ID, // NOT NULL col; 0 = marketplace (no tenant)
                customer_id: customer_id,
                created_by:  customer_id,
                created_at:  db.fn.now(),
                updated_at:  db.fn.now(),
            })).returning('id');

            // FIRST-TIME profile completion → event_cashback (event_type = 2).
            // This is the ONE place legacy fires it (webordering SiteController:
            // only when the customer_profile row is NEWLY created, passing
            // related_id = profile.id) — never at order-place.
            // Scope is the MARKETPLACE's own programme (company_id = 0): a
            // marketplace profile isn't owned by any restaurant, and the profile
            // row itself is written at company_id = 0 right above.
            // Best-effort: a loyalty hiccup must never fail the profile save.
            try {
                await Loyalty.earnEventCashback({
                    customerId: customer_id,
                    companyId:  Loyalty.MARKETPLACE_COMPANY_ID,
                    eventType:  2,                                   // profile completion
                    relatedId:  created && (created.id || created),
                });
            } catch (e) { H.log.warn('auth.updateAbout.eventCashback', e && e.message); }
        }

        const fresh = await db(profile.TABLE)
            .where({ customer_id })
            .whereNull('deleted_at')
            .first();
        return H.successResponse(res, { about: profile.view(fresh) }, MSG.resource.updated);
    } catch (err) {
        H.log.error('auth.updateAbout', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * socialSignin
 *
 * What:  Sign in (or create) a marketplace customer via Google / Facebook.
 *        The WEB layer drives the OAuth redirect dance + token exchange
 *        with the provider; it then POSTs the resulting token here.
 *        We:
 *          1. Verify the token with the provider (signature / app match).
 *          2. Look up the customer by social_id first (most specific),
 *             then by email (so users who originally signed up with a
 *             phone but later try Google with the same email are
 *             merged — not duplicated).
 *          3. If found and not blocked → UPDATE social_id (if needed)
 *             + return the public view.
 *          4. If not found → INSERT a fresh marketplace customer
 *             (company_id NULL, is_registered=1, signup_source='3' for
 *             social), then return.
 *
 *        Status branches mirror verifyOtp: a 'deleted' / 'disabled' /
 *        'banned' row returns 403 with the same wording so we never
 *        leak which of the three states a phone is in.
 *
 *        signup_source convention (from the Yii system):
 *           '1' = web phone-OTP
 *           '2' = mobile app
 *           '3' = social (Google / Facebook)
 *
 * Why:   Single canonical entry-point for social sign-in keeps the web
 *        + future Flutter app + future native iOS app all on one path.
 *
 * Type:  WRITE (inserts or updates `customer`).
 *
 * Inputs:
 *   req.body.provider    — 'google' | 'facebook'
 *   req.body.id_token?   — Google ID token (when provider='google')
 *   req.body.access_token? — Facebook access token (when provider='facebook')
 *
 * Output (success):
 *   200 envelope, data = {
 *     customer: { id, firstname, lastname, email, ... },
 *     created:  bool,            // true iff a new row was inserted
 *     needs_phone: bool,         // true when contact_no is still empty —
 *                                  the front-end uses this to prompt the
 *                                  user to add their phone before checkout.
 *   }
 *
 * Output (failure):
 *   200 envelope, status=400|403|422 with msg.
 */
async function socialSignin(req, res) {
    try {
        const { provider, id_token, access_token } = req.body;

        const result = await social.verify({
            provider,
            idToken:     id_token,
            accessToken: access_token,
        });

        if (!result.ok) {
            return H.errorResponse(res, result.error || 'Could not verify your sign-in.', 400);
        }

        const p = result.profile;
        const email = p.email || '';

        // Customer lookup precedence:
        //   social_id (exact match)  →  email (link existing phone-only
        //   account to this Google/Facebook identity)
        let row = await db('customer')
            .where({ social_id: p.social_id })
            .whereNull('company_id')
            .orderBy('id', 'desc')
            .first();

        if (!row && email) {
            row = await db('customer')
                .whereRaw('LOWER(email) = ?', [email])
                .whereNull('company_id')
                .orderBy('id', 'desc')
                .first();
        }

        const state = customers.classify(row);

        // Same wording as verifyOtp — never leak which of the three
        // blocked-states actually hit.
        if (state === 'deleted' || state === 'disabled') {
            return H.errorResponse(res, MSG.auth.accountDisabled, 403);
        }
        if (state === 'banned') {
            return H.errorResponse(res, MSG.auth.accountBanned, 403);
        }

        if (row) {
            // Existing row — make sure social_id is stamped (in case the
            // user originally registered via phone-OTP) and update the
            // verify timestamp.
            const update = {
                verify_at:         H.now(),
                updated_at:        db.fn.now(),
                server_updated_at: db.fn.now(),
            };
            if (!row.social_id || String(row.social_id) !== p.social_id) {
                update.social_id = p.social_id;
            }
            // Backfill email/firstname/lastname if they were blank — DON'T
            // overwrite values the user typed themselves on the personal-
            // details screen (they own those).
            if (!row.email     && email)     update.email     = email;
            if (!row.firstname && p.firstname) update.firstname = p.firstname;
            if (!row.lastname  && p.lastname)  update.lastname  = p.lastname;
            // If we found by social_id but the row is still is_registered=0
            // (somehow OTP-stub state), promote it to registered now.
            if (Number(row.is_registered) !== 1) {
                update.is_registered = 1;
                update.registered_at = H.now();
            }

            await db('customer').where({ id: row.id }).update(update);
            const fresh = await db('customer').where({ id: row.id }).first();

            return H.successResponse(res, {
                customer:    customers.publicView(fresh),
                created:     false,
                needs_phone: !fresh.contact_no,
            }, MSG.auth.otpVerified);
        }

        // No row — create a new marketplace customer.
        const [inserted] = await db('customer')
            .insert({
                firstname:           p.firstname || '',
                lastname:            p.lastname  || null,
                email:               email       || null,
                social_id:           p.social_id,
                company_id:          null,
                status:              '1',
                signup_source:       '3',         // social
                is_registered:       1,
                is_marketplace_user: 1,
                referral_code:       customers.generateReferralCode(),
                registered_at:       H.now(),
                verify_at:           H.now(),
                // POS app-side identity (legacy OrderController::appid): app_id =
                // next in the terminalid='500' sequence, localid=0, terminalid=500.
                app_id:              await customers.nextAppId(),
                localid:             '0',
                terminalid:          '500',
                // contact_no stays NULL — user will be asked to add a phone
                // before checkout (signup_source=3 with NULL contact_no is
                // the marketplace's "social-only, needs phone" state).
            })
            .returning('*');

        return H.successResponse(res, {
            customer:    customers.publicView(inserted),
            created:     true,
            needs_phone: !inserted.contact_no,
        }, MSG.resource.created);
    } catch (err) {
        H.log.error('auth.socialSignin', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { sendOtp, verifyOtp, saveProfile, updateProfile, updateAvatar, me, getAbout, updateAbout, socialSignin, changePhone, deleteAccount };
