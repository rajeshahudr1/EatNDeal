'use strict';

/**
 * Middlewares/requestId.js
 *
 * What:   Generates a unique request ID (UUID v4) for every incoming HTTP
 *         request, attaches it to `req.requestId`, and mirrors it back to
 *         the client in the `X-Request-Id` response header.
 * Why:    Lets the client quote an ID when reporting an issue; lets ops grep
 *         a single request across distributed logs (downstream middlewares
 *         + the dev logger include `req.requestId` in their output).
 * Type:   READ (annotates the request; no DB).
 * Inputs: none (Express req/res passed by the framework).
 * Output: side-effect — sets req.requestId and res header X-Request-Id.
 * Used:   Mounted early in api/index.js, BEFORE the dev logger and BEFORE
 *         any route handler.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const { randomUUID } = require('node:crypto');

/**
 * requestId
 *
 * What:   Express middleware — generates / forwards an X-Request-Id.
 * Why:    See file header.
 * Type:   READ.
 * Inputs: req, res, next.
 * Output: calls next() after setting req.requestId + response header.
 * Used:   app.use(requestId) at the top of the middleware chain.
 */
function requestId(req, res, next) {
    // If an upstream load balancer / API gateway already set X-Request-Id we
    // honour it (lets ops trace across multiple hops). Otherwise mint a new
    // UUID v4. We don't trust caller-supplied values blindly — only accept
    // if it looks like a UUID-or-short-hex; reject anything weird.
    const incoming = req.headers['x-request-id'];
    const looksOk  = typeof incoming === 'string'
        && incoming.length > 0
        && incoming.length <= 64
        && /^[A-Za-z0-9_-]+$/.test(incoming);
    req.requestId  = looksOk ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

module.exports = { requestId };
