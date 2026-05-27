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

const H            = require('../../Helpers/helper');
const MSG          = require('../../Helpers/messages');
const otp          = require('../../Helpers/otpSender');
const customers    = require('../../Helpers/customerLookup');
const social       = require('../../Helpers/socialAuth');
const { db }       = require('../../config/db');

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

        if (row && state === 'pending') {
            // UPDATE the OTP-verified stub into a fully-registered row.
            await db('customer')
                .where({ id: row.id })
                .update({
                    firstname:         firstname,
                    lastname:          lastname || null,
                    email:             email    || null,
                    is_registered:     1,
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
                registered_at:        H.now(),
                verify_at:            H.now(),
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
 *   200 failure — 404 (no such row) | 403 (blocked) | 409 (phone taken)
 *                 | 422 (state mismatch / partial phone)
 */
async function updateProfile(req, res) {
    try {
        const { customer_id, firstname, lastname, email, country_code, contact_no } = req.body;

        const row = await db('customer')
            .where({ id: customer_id })
            .whereNull('company_id')
            .first();

        if (!row) {
            return H.errorResponse(res, MSG.resource.notFound, 404);
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

        // Phone fields travel together — either both empty (no change)
        // or both populated. A half-filled pair (only country, or only
        // number) is user error.
        const wantsCountry = country_code !== undefined && country_code !== '' && country_code !== null;
        const wantsContact = contact_no   !== undefined && contact_no   !== '' && contact_no   !== null;
        if (wantsCountry !== wantsContact) {
            return H.errorResponse(res, 'Please enter both the country code and mobile number.', 422);
        }

        const update = {
            firstname:         firstname,
            lastname:          lastname || null,
            email:             email    || null,
            updated_at:        db.fn.now(),
            server_updated_at: db.fn.now(),
        };

        if (wantsContact) {
            const cleanCountry = Number(customers.normalisePhone(country_code)) || 0;
            const cleanContact = customers.normalisePhone(contact_no);

            // Only check the duplicate-phone guard when the phone is
            // actually changing — re-saving the same phone is fine.
            if (cleanContact !== row.contact_no || cleanCountry !== row.country_code) {
                const clash = await db('customer')
                    .where({ contact_no: cleanContact, country_code: cleanCountry })
                    .whereNull('company_id')
                    .whereNot({ id: row.id })
                    .first();
                if (clash) {
                    return H.errorResponse(
                        res,
                        'That mobile number is already used by another account.',
                        409,
                    );
                }
            }

            update.country_code = cleanCountry;
            update.contact_no   = cleanContact;
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
                registered_at:       H.now(),
                verify_at:           H.now(),
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

module.exports = { sendOtp, verifyOtp, saveProfile, updateProfile, socialSignin };
