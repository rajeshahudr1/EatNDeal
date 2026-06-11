'use strict';

/*
 * Helpers/cmsSanitize.js
 *
 * What:  Conservative allowlist sanitiser for the loyalty Review-CMS rich-text
 *        (loyalty_cms_pages.description). Admin-authored HTML is rendered back
 *        to the admin AND to customers (the /earn page), so we allowlist a
 *        small set of formatting tags + safe attributes and strip scripts,
 *        styles, event handlers and dangerous URL schemes. No external dep.
 * Used:  api Admin/LoyaltyController (cms save + get) and Helpers/loyalty
 *        (reviewTypesFor) — one source of truth so both layers agree.
 */

const CMS_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'span', 'div', 'img', 'font', 'pre', 'code', 'hr']);
const CMS_ATTR = {
    a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'],
    font: ['color'], span: ['style'], div: ['style'], p: ['style'], li: ['style'],
};
// Decode HTML entities (numeric + a few named) so a scheme like
// "j&#97;vascript:" can't slip a URL check that only sees the raw text.
const CMS_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/' };
function cmsSafeChar(c) { try { return (c >= 0 && c <= 0x10FFFF) ? String.fromCodePoint(c) : ''; } catch (e) { return ''; } }
function decodeEntities(str) {
    return String(str == null ? '' : str)
        .replace(/&#x([0-9a-f]+);?/gi, (m, h) => cmsSafeChar(parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (m, d) => cmsSafeChar(parseInt(d, 10)))
        .replace(/&(amp|lt|gt|quot|apos|colon|tab|newline|sol);/gi, (m, e) => CMS_ENT[e.toLowerCase()] || m);
}
function sanitizeCmsHtml(html) {
    let s = String(html == null ? '' : html);
    // Remove dangerous elements WITH their content, then comments.
    s = s.replace(/<(script|style|iframe|object|embed|svg|math|form|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/<\/?(script|style|iframe|object|embed|svg|math|form|textarea|input|button|link|meta|base)\b[^>]*>/gi, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // Opening tags: drop non-allowlisted; scrub attributes on the rest.
    s = s.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g, (m, tag, attrs, selfClose) => {
        const t = tag.toLowerCase();
        if (!CMS_TAGS.has(t)) { return ''; }
        const allow = CMS_ATTR[t] || [];
        let out = '';
        String(attrs).replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g, (am, name, val) => {
            const n = name.toLowerCase();
            if (n.indexOf('on') === 0) { return ''; }            // event handlers
            if (allow.indexOf(n) === -1) { return ''; }
            let v = String(val).replace(/^["']|["']$/g, '');
            if (n === 'href' || n === 'src') {
                // Decode + strip control/space, then allow ONLY safe schemes
                // (relative/anchor URLs have no scheme and are allowed).
                const probe = decodeEntities(v).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
                if (/^[a-z][a-z0-9+.\-]*:/.test(probe) && !/^(https?:|mailto:|tel:)/.test(probe)) { return ''; }
            }
            if (n === 'style') {
                const probe = decodeEntities(v).toLowerCase();
                if (/expression|javascript:|vbscript:|url\s*\(|[\\@]|&#/.test(probe)) { return ''; }
            }
            out += ' ' + n + '="' + v.replace(/"/g, '&quot;') + '"';
            return '';
        });
        return '<' + t + out + (selfClose ? ' /' : '') + '>';
    });
    // Closing tags: keep only allowlisted.
    s = s.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g, (m, tag) => (CMS_TAGS.has(tag.toLowerCase()) ? '</' + tag.toLowerCase() + '>' : ''));
    return s.trim().slice(0, 20000);
}

module.exports = { sanitizeCmsHtml };
