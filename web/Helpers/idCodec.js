'use strict';

/*
 * Helpers/idCodec.js
 *
 * What:  Opaque, reversible tokens for numeric ids that appear in public
 *        URLs (user request 28 Jul 2026 — /community/g/5 must not expose
 *        the raw DB id). AES-128-ECB over "<prefix>:<id>", base64url out:
 *        deterministic (the same id always makes the same token, so links
 *        stay stable/bookmarkable) and unguessable without the secret.
 *        The PREFIX is checked on decode so a token minted for one kind
 *        of id can't be replayed as another kind.
 * Why:   The api keeps using plain numeric ids internally — only the web
 *        layer encodes on the way OUT (links) and decodes on the way IN
 *        (route params / proxied group_id fields).
 * Type:  READ (pure — no DB).
 * Used:  Controllers/CommunityController (group ids).
 */

const crypto = require('crypto');

// Derived once from the session secret (or its own env override) — no new
// mandatory env key. Changing the secret only breaks OLD links, nothing else.
const SECRET = process.env.ID_CODEC_SECRET || process.env.SESSION_SECRET || 'eatndeal-id-codec';
const KEY = crypto.createHash('sha256').update(String(SECRET)).digest().subarray(0, 16);

/**
 * encodeId — numeric id → opaque token (e.g. 5 → "8f2K…"). '' for bad input.
 */
function encodeId(prefix, id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) { return ''; }
    const cipher = crypto.createCipheriv('aes-128-ecb', KEY, null);
    return Buffer.concat([cipher.update(prefix + ':' + n, 'utf8'), cipher.final()]).toString('base64url');
}

/**
 * decodeId — token → numeric id, or 0 when the token is invalid / wrong
 * prefix. A PLAIN numeric string is rejected too — raw ids are no longer
 * accepted from the outside once the encoded links ship.
 */
function decodeId(prefix, token) {
    const t = String(token || '').trim();
    if (!t || /[^A-Za-z0-9_-]/.test(t)) { return 0; }
    try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', KEY, null);
        const plain = Buffer.concat([decipher.update(t, 'base64url'), decipher.final()]).toString('utf8');
        const m = plain.match(new RegExp('^' + prefix + ':([0-9]{1,12})$'));
        return m ? Number(m[1]) : 0;
    } catch (e) {
        return 0;
    }
}

module.exports = { encodeId, decodeId };
