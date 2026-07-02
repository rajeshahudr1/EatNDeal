'use strict';

/*
 * Helpers/aiModeration.js — OpenAI-backed moderation for community posts/comments.
 *
 * Two server-side checks (the key never leaves the api):
 *   1. SAFETY    — OpenAI Moderation API (text + image): hate / harassment /
 *      sexual / violence / self-harm / illicit. Charity/sensitive groups apply
 *      a stricter score threshold on top of the model's own flag.
 *   2. RELEVANCE — a small chat model decides if the post fits the group's
 *      purpose (name + description + tags + ai_rules); vision-aware when an image
 *      is attached.
 *
 * moderate() combines them per the group's `moderation` mode and returns a
 * verdict the controller writes to moderation_status. FAIL-SAFE: any error,
 * timeout, or missing key → 'pending' (a human reviews it) — never a crash,
 * never a silent auto-approve.
 *
 * All tunables (key, models, timeout, threshold) come from config/community.js.
 */

const CC = require('../config/community');

function openaiFetch(path, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CC.AI.TIMEOUT_MS);
    return fetch(CC.AI.BASE_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CC.AI.KEY },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
    }).then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) { throw new Error('OpenAI ' + path + ' failed (' + res.status + ')'); }
        return json;
    }).finally(() => clearTimeout(timer));
}

// SAFETY — OpenAI Moderation API. → { flagged, categories:[...], maxScore }.
async function checkSafety(text, imageUrl) {
    const input = [];
    if (text)     { input.push({ type: 'text', text: String(text).slice(0, 4000) }); }
    if (imageUrl) { input.push({ type: 'image_url', image_url: { url: imageUrl } }); }
    if (!input.length) { return { flagged: false, categories: [], maxScore: 0 }; }
    const data = await openaiFetch('/moderations', { model: CC.AI.MODERATION_MODEL, input });
    const r = (data.results && data.results[0]) || {};
    const cats = Object.keys(r.categories || {}).filter((k) => r.categories[k]);
    const scores = r.category_scores || {};
    const maxScore = Object.keys(scores).reduce((m, k) => Math.max(m, Number(scores[k]) || 0), 0);
    return { flagged: !!r.flagged, categories: cats, maxScore };
}

// RELEVANCE — does the post belong in this group? → { relevant, reason }.
async function checkRelevance(text, imageUrl, group) {
    const purpose = [
        'Group name: ' + (group.name || ''),
        group.description ? ('Purpose: ' + group.description) : '',
        group.tags ? ('Allowed topics/tags: ' + group.tags) : '',
        group.ai_rules ? ('Extra rules: ' + group.ai_rules) : '',
    ].filter(Boolean).join('\n');
    const sys = 'You moderate posts for a community group. Decide if the post is ON-TOPIC for the group AND appropriate. '
        + 'Reply ONLY as JSON: {"relevant": true|false, "reason": "<short reason>"}.\n' + purpose;
    const userContent = [{ type: 'text', text: 'Post: ' + (text || '(no text)') }];
    if (imageUrl) { userContent.push({ type: 'image_url', image_url: { url: imageUrl } }); }
    const data = await openaiFetch('/chat/completions', {
        model: CC.AI.MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 120,
    });
    const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let out = {};
    try { out = JSON.parse(txt || '{}'); } catch (e) { out = {}; }
    // Default to relevant only if the model explicitly said so.
    return { relevant: out.relevant === true, reason: String(out.reason || '').slice(0, 400) };
}

/**
 * moderate({ group, body, imageUrl }) → { status, reason }.
 *
 * group.moderation: 'open' → always approved; 'manual' → always pending;
 * 'ai' (default) → safety + relevance, both must pass. Fail-safe to pending.
 */
async function moderate({ group, body, imageUrl }) {
    const APPROVED = CC.STATUS.APPROVED;
    const PENDING  = CC.STATUS.PENDING;
    const g = group || {};
    const mode = g.moderation || CC.MODERATION.AI;

    if (mode === CC.MODERATION.OPEN)   { return { status: APPROVED, reason: '' }; }
    if (mode === CC.MODERATION.MANUAL) { return { status: PENDING,  reason: 'Manual review' }; }

    // mode 'ai' — needs a key; without one, hold for a human (never auto-approve).
    if (!CC.enabled()) { return { status: PENDING, reason: 'AI not configured' }; }

    try {
        const sensitive = Number(g.is_sensitive) === 1;
        // OpenAI must be able to fetch the image — only pass absolute URLs
        // (a local/relative path is unreachable; we moderate the text alone).
        const img = /^https?:\/\//i.test(imageUrl || '') ? imageUrl : null;
        const safety = await checkSafety(body, img);
        if (safety.flagged || (sensitive && safety.maxScore > CC.AI.SENSITIVE_THRESHOLD)) {
            const why = safety.categories.slice(0, 4).join(', ') || 'unsafe content';
            return { status: PENDING, reason: 'Flagged: ' + why };
        }
        const rel = await checkRelevance(body, img, g);
        if (!rel.relevant) { return { status: PENDING, reason: rel.reason || 'Off-topic for this group' }; }
        return { status: APPROVED, reason: '' };
    } catch (err) {
        return { status: PENDING, reason: 'Review needed (AI unavailable)' };
    }
}

module.exports = { moderate, checkSafety, checkRelevance };
