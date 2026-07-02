'use strict';

/**
 * Controllers/StaticPageController.js
 *
 * What:   Renders every "static" marketing / informational page —
 *         About, Help, Terms, Privacy, Contact, Partner, Ride, Business,
 *         Careers. Each route ends up here; the slug picks the right
 *         content from web/data/staticPages.js.
 * Why:    DRY — one controller + one view + one CSS file for 9 pages.
 *         Editors update copy by touching staticPages.js, not the
 *         markup. Adding a new static page in future = one new entry
 *         in staticPages.js + one new line in web/index.js.
 * Type:   READ (no DB, no API call).
 * Inputs: req, res.
 * Output: rendered HTML (views/static/page.ejs inside views/_layout.ejs).
 * Used:   web/index.js wires each slug to its matching action below.
 *
 * Change log:
 *   2026-05-25 — initial.
 */

const PAGES = require('../data/staticPages');
const { callApi } = require('../Helpers/apiClient');

/**
 * renderPage (private factory)
 *
 * What:   Returns an Express handler that renders the static page for
 *         the given slug.
 * Why:    Same rendering logic for all 9 pages; just the slug changes.
 *         Returning a CLOSURE so each exported handler captures its
 *         own slug at module-load time (no per-request lookup needed).
 * Type:   READ (factory + handler).
 * Inputs: slug (string) — must exist as a key in staticPages.js.
 * Output: function (req, res) — Express route handler.
 * Used:   Inside this module only; the named handlers below are
 *         instances of this factory.
 */
function renderPage(slug) {
    const page = PAGES[slug];
    return function (req, res, next) {
        if (!page) {
            // Defensive — should never fire if the slug list below is in
            // sync with staticPages.js. Pass to the 404 handler.
            return next();
        }
        const hasForm = (page.sections || []).some((s) => s && s.type === 'form');
        res.render('static/page', {
            page_title:       page.title,
            _layoutFile:      '../_layout',
            active_nav:       page.slug,           // header underlines the matching nav link
            page:             page,                // { title, lede, sections }
            // Lead-form pages get the submit script; the rest stay JS-free.
            extra_js:         hasForm ? '/js/pages/partner-form.js' : undefined,
            // Static pages are focused-flow — hide the promo strip so the
            // header stays clean. (legal pages especially.)
            show_promo_strip: false,
        });
    };
}

// POST /partner/apply — relay the lead form to the api (which emails it).
async function partnerApply(req, res) {
    let apiRes;
    try { apiRes = await callApi(req, 'POST', '/api/v1/partner/lead', req.body || {}); }
    catch (e) { apiRes = { body: { status: 0, show: true, msg: 'Could not reach the server. Please try again.' } }; }
    return res.status(200).json((apiRes && apiRes.body) || { status: 0, show: true, msg: 'Something went wrong.' });
}

module.exports = {
    partnerApply,
    about:    renderPage('about'),
    help:     renderPage('help'),
    terms:    renderPage('terms'),
    privacy:  renderPage('privacy'),
    contact:  renderPage('contact'),
    partner:  renderPage('partner'),
    ride:     renderPage('ride'),
    business: renderPage('business'),
    careers:  renderPage('careers'),
};
