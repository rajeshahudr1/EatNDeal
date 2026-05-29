'use strict';

/*
 * Controllers/Customer/AddressController.js
 *
 * What:  The signed-in customer's saved-address book, backing the Zomato-
 *        style location sheet + the "Address info" add/edit screen:
 *
 *          GET  /api/v1/customer/addresses        — list active addresses
 *          POST /api/v1/customer/address/save     — create OR update (upsert)
 *          POST /api/v1/customer/address/delete   — soft delete (status=2)
 *
 *        All three operate on the existing `customer_address` table
 *        (extended by m260529_120000 with label / lat / lng / building
 *        type / instructions / contact / is_default). Everything is scoped
 *        to one customer_id so a customer can never read or mutate another
 *        customer's addresses.
 *
 * Why:   The marketplace needs multiple labelled delivery addresses per
 *        account (Home / Work / ...) with a map pin + delivery notes, like
 *        every food-delivery app. The legacy app only stored a flat list.
 *
 * Auth:  Phase-1 identity model (see AuthController.updateProfile) — the web
 *        layer supplies customer_id from req.session.user.id; the API is not
 *        yet public-facing. When JWT auth lands this switches to req.auth.
 *
 * Used:  api/Routes/index.js under /customer/address*.
 */

const H         = require('../../Helpers/helper');
const MSG       = require('../../Helpers/messages');
const customers = require('../../Helpers/customerLookup');
const D         = require('../../Helpers/distance');
const { db }    = require('../../config/db');

const TABLE        = 'customer_address';
const STATUS_ACTIVE  = 1;
const STATUS_DELETED = 2;

/**
 * loadActiveCustomer
 *
 * What:  Fetches the marketplace customer (company_id IS NULL) by id and
 *        confirms it's allowed to manage addresses. Returns { row } on
 *        success or { error: {msg, status} } for the caller to relay.
 * Type:  READ.
 */
async function loadActiveCustomer(customerId) {
    const row = await db('customer')
        .where({ id: customerId })
        .whereNull('company_id')
        .first();
    if (!row) { return { error: { msg: MSG.resource.notFound, status: 404 } }; }

    const state = customers.classify(row);
    if (state === 'deleted' || state === 'disabled') {
        return { error: { msg: MSG.auth.accountDisabled, status: 403 } };
    }
    if (state === 'banned') {
        return { error: { msg: MSG.auth.accountBanned, status: 403 } };
    }
    return { row };
}

/**
 * mapAddress
 *
 * What:  DB row → API shape (camelCase, coordinates as numbers, distance
 *        from the supplied origin when we have both ends). Pure.
 * Type:  READ.
 */
function mapAddress(r, originLat, originLng) {
    const lat = r.latitude  != null && r.latitude  !== '' ? Number(r.latitude)  : null;
    const lng = r.longitude != null && r.longitude !== '' ? Number(r.longitude) : null;
    return {
        id:                   String(r.id),
        label:                r.label || '',
        address:              r.address || '',
        postCode:             r.post_code || '',
        line1:                r.line1 || '',
        line2:                r.line2 || '',
        postTown:             r.post_town || '',
        latitude:             lat,
        longitude:            lng,
        addressType:          r.address_type || '',
        additionalDetails:    r.additional_details || '',
        dropOffOption:        r.drop_off_option || '',
        deliveryInstructions: r.delivery_instructions || '',
        contactNo:            r.contact_no || '',
        isDefault:            Number(r.is_default) === 1,
        distanceKm:           (originLat != null && originLng != null)
                                  ? D.kmBetween(originLat, originLng, lat, lng)
                                  : null,
    };
}

// Coerce a possibly-empty query/body coordinate to a number or null.
function numOrNull(v) {
    if (v == null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * list
 *
 * What:  Returns the customer's active addresses, default first then newest.
 *        When lat/lng are supplied, each row carries a distanceKm so the
 *        sheet can show the "3 km" labels.
 * Type:  READ.
 *
 * Inputs:  req.query.customer_id (required), req.query.lat?, req.query.lng?
 * Output:  200 envelope, data = { addresses: [...] }
 */
async function list(req, res) {
    try {
        const { customer_id } = req.query;
        const lat = numOrNull(req.query.lat);
        const lng = numOrNull(req.query.lng);

        const { row: cust, error } = await loadActiveCustomer(customer_id);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const rows = await db(TABLE)
            .where({ customer_id, status: STATUS_ACTIVE })
            .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'id', order: 'desc' }]);

        const addresses = rows.map((r) => mapAddress(r, lat, lng));
        void cust;
        return H.successResponse(res, { addresses });
    } catch (err) {
        H.log.error('address.list', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * save
 *
 * What:  Upsert. If `id` is present AND belongs to this customer → UPDATE,
 *        otherwise INSERT a new address. Setting is_default=true clears the
 *        flag on the customer's other rows first (only one default). The
 *        customer's very first address is auto-defaulted.
 * Type:  WRITE.
 *
 * Inputs:  req.body — customer_id (required), id? (update), address (required),
 *          label, post_code, line1, line2, post_town, latitude, longitude,
 *          address_type, additional_details, drop_off_option,
 *          delivery_instructions, contact_no, is_default.
 * Output:  200 envelope, data = { address: {...}, created: bool }
 */
async function save(req, res) {
    try {
        const b = req.body;
        const customerId = b.customer_id;

        const { error } = await loadActiveCustomer(customerId);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        // Build the column set from the validated body. We only write
        // columns the migration added (plus the legacy address/post_code).
        const fields = {
            label:                 b.label || null,
            address:               String(b.address || '').trim(),
            post_code:             b.post_code || null,
            line1:                 b.line1 || null,
            line2:                 b.line2 || null,
            post_town:             b.post_town || null,
            latitude:              numOrNull(b.latitude),
            longitude:             numOrNull(b.longitude),
            address_type:          b.address_type || null,
            additional_details:    b.additional_details || null,
            drop_off_option:       b.drop_off_option || null,
            delivery_instructions: b.delivery_instructions || null,
            contact_no:            b.contact_no || null,
        };

        const wantsDefault = b.is_default === true;

        // Does the customer have any address yet? First one is auto-default.
        const existingCount = await db(TABLE)
            .where({ customer_id: customerId, status: STATUS_ACTIVE })
            .count('* as c')
            .first();
        const isFirst = Number(existingCount.c) === 0;
        const makeDefault = wantsDefault || isFirst;

        let saved;
        let created;

        if (b.id) {
            // UPDATE — only when the row exists AND belongs to this customer.
            const owned = await db(TABLE)
                .where({ id: b.id, customer_id: customerId })
                .whereNot({ status: STATUS_DELETED })
                .first();
            if (!owned) { return H.errorResponse(res, MSG.resource.notFound, 404); }

            if (makeDefault) {
                await db(TABLE).where({ customer_id: customerId }).update({ is_default: 0 });
            }
            await db(TABLE).where({ id: b.id }).update({
                ...fields,
                ...(makeDefault ? { is_default: 1 } : {}),
                updated_by: customerId,
                updated_at: db.fn.now(),
            });
            saved = await db(TABLE).where({ id: b.id }).first();
            created = false;
        } else {
            // INSERT.
            if (makeDefault) {
                await db(TABLE).where({ customer_id: customerId }).update({ is_default: 0 });
            }
            const [inserted] = await db(TABLE)
                .insert({
                    ...fields,
                    customer_id: customerId,
                    status:      STATUS_ACTIVE,
                    is_default:  makeDefault ? 1 : 0,
                    created_by:  customerId,
                    updated_by:  customerId,
                })
                .returning('*');
            saved = inserted;
            created = true;
        }

        return H.successResponse(
            res,
            { address: mapAddress(saved), created },
            created ? MSG.resource.created : MSG.resource.updated,
        );
    } catch (err) {
        H.log.error('address.save', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

/**
 * remove
 *
 * What:  Soft-deletes an address (status=2) it owns. If the deleted row was
 *        the default, the newest remaining address is promoted to default so
 *        the customer always has one selected.
 * Type:  WRITE.
 *
 * Inputs:  req.body — customer_id (required), id (required)
 * Output:  200 envelope, data = { deleted: true }
 */
async function remove(req, res) {
    try {
        const { customer_id, id } = req.body;

        const { error } = await loadActiveCustomer(customer_id);
        if (error) { return H.errorResponse(res, error.msg, error.status); }

        const owned = await db(TABLE)
            .where({ id, customer_id })
            .whereNot({ status: STATUS_DELETED })
            .first();
        if (!owned) { return H.errorResponse(res, MSG.resource.notFound, 404); }

        await db(TABLE).where({ id }).update({
            status:     STATUS_DELETED,
            is_default: 0,
            updated_by: customer_id,
            updated_at: db.fn.now(),
        });

        // Promote a new default if we just removed the default one.
        if (Number(owned.is_default) === 1) {
            const next = await db(TABLE)
                .where({ customer_id, status: STATUS_ACTIVE })
                .orderBy('id', 'desc')
                .first();
            if (next) {
                await db(TABLE).where({ id: next.id }).update({ is_default: 1 });
            }
        }

        return H.successResponse(res, { deleted: true }, MSG.resource.deleted);
    } catch (err) {
        H.log.error('address.remove', err && err.message);
        return H.errorResponse(res, MSG.server.oops, 500);
    }
}

module.exports = { list, save, remove };
