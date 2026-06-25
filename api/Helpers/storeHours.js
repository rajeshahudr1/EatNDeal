'use strict';

/*
 * Helpers/storeHours.js
 *
 * What:  THE single source of truth for a branch's open/closed state and
 *        opening-hours label — ported to match the legacy POS exactly
 *        (common/components/ServiceAvailability + Commonquery::
 *        restricAddCartService + the Branch close-flags).
 *
 *        The marketplace previously read branch.start_time / end_time (a
 *        stale single daily window). The REAL hours live in
 *        store_business_hours (one row per branch+day_of_week) →
 *        store_business_hour_shifts (per service: is_open, open_time,
 *        close_time). service_type_id: 2 = Take Away, 3 = Delivery
 *        (1 = In-store, excluded from web ordering).
 *
 *        Closure precedence (first match wins), mirroring legacy:
 *          1. branch.closed = 1                    → permanently closed
 *          2. closed_until = 1 + reopen in future  → closed until <date/time>
 *          3. closed_for = 1 + closed_for_time fut → closed temporarily
 *          4. holiday today (store_holiday_details)→ closed (or special hours)
 *          5. per-service show_*_option = 0 (+tab) → that service closed
 *          6. today's shift window (is_open + time)→ open / pre-order / closed
 *
 * Type:  READ (DB + clock).
 */

const { db } = require('../config/db');

const SERVICE = { TAKEAWAY: 2, DELIVERY: 3 };

// ── Small time helpers (local clock, to match legacy date()) ─────────
function clockMin(t) {                       // "HH:MM[:SS]" → minutes-of-day
    if (!t) { return null; }
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) { return null; }
    return (parseInt(m[1], 10) % 24) * 60 + parseInt(m[2], 10);
}
// Store timezone (UK). Open/closed, hours, "today" and the shift day are ALL
// evaluated in this zone — NOT the server's OS timezone — so the verdict is
// identical whether the api runs locally (e.g. IST) or on the live server
// (UTC). Without this, the same restaurant shows "Open" on a UK/IST machine
// but "Closed" on a UTC server (the `new Date()` clock differs). Override with
// STORE_TZ if the brand ever operates outside the UK.
const STORE_TZ = process.env.STORE_TZ || 'Europe/London';
const _DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
// Current date/time parts in STORE_TZ, independent of the server clock.
function nowParts() {
    const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: STORE_TZ, hour12: false, weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
    const v = (t) => { const f = p.find((x) => x.type === t); return f ? f.value : ''; };
    return {
        hour: Number(v('hour')) % 24, minute: Number(v('minute')) || 0,
        dow: _DOW[v('weekday')] || 1, ymd: `${v('year')}-${v('month')}-${v('day')}`,
    };
}
function nowMinutes() { const t = nowParts(); return t.hour * 60 + t.minute; }
function isoDow()     { return nowParts().dow; }           // 1=Mon..7=Sun (UK)
function todayYmd()   { return nowParts().ymd; }           // YYYY-MM-DD (UK)
function ymd(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function fmt12(min) {                         // minutes → "h:mm AM/PM"
    if (min == null) { return null; }
    const h = Math.floor(min / 60) % 24, m = ((min % 60) + 60) % 60;
    const ap = h < 12 ? 'AM' : 'PM';
    let h12 = h % 12; if (h12 === 0) { h12 = 12; }
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// ── A service's state from today's shifts ────────────────────────────
// 'open'  — now within an is_open shift   → ASAP orders
// 'preorder' — an is_open shift is later today (now before it)
// 'closed' — no usable shift
function serviceState(shifts, serviceId, nowMin) {
    const list = shifts.filter(s => Number(s.service_type_id) === serviceId && Number(s.is_open) === 1);
    let nextOpen = null;
    for (const s of list) {
        const o = clockMin(s.open_time), c = clockMin(s.close_time);
        if (o == null || c == null) { continue; }
        const within = c > o ? (nowMin >= o && nowMin < c)    // same-day
                             : (nowMin >= o || nowMin < c);   // crosses midnight
        if (within) { return { status: 'open', window: { open: o, close: c } }; }
        if (o > nowMin && (nextOpen == null || o < nextOpen.open)) { nextOpen = { open: o, close: c }; }
    }
    if (nextOpen) { return { status: 'preorder', window: nextOpen }; }
    return { status: 'closed', window: null };
}

// Today's overall window label (earliest open – latest close among open
// shifts; overnight close rolls past midnight).
function dayWindowLabel(shifts) {
    let minOpen = null, maxClose = null;
    for (const s of shifts) {
        if (Number(s.is_open) !== 1) { continue; }
        const o = clockMin(s.open_time), c = clockMin(s.close_time);
        if (o == null || c == null) { continue; }
        const cc = c <= o ? c + 1440 : c;     // overnight → next day
        if (minOpen == null || o < minOpen) { minOpen = o; }
        if (maxClose == null || cc > maxClose) { maxClose = cc; }
    }
    if (minOpen == null) { return null; }
    return fmt12(minOpen) + ' – ' + fmt12(maxClose);
}

// ── A blanket closure (branch flags + holiday) → verdict or null ─────
function reopenTimestamp(datePart, timePart) {
    if (!datePart) { return null; }
    const d = ymd(new Date(Date.parse(datePart)));
    const t = (timePart && String(timePart).match(/(\d{1,2}):(\d{2})/)) ? String(timePart).slice(0, 5) : '00:00';
    const ts = Date.parse(d + 'T' + t);
    return Number.isFinite(ts) ? ts : null;
}
function branchName(branch) { return (branch && (branch.name || branch.branch_name)) ? String(branch.name || branch.branch_name) : ''; }
function defaultMsg(branch) {
    return (branchName(branch) || 'The restaurant') + ' is currently closed for online orders.';
}
function fillMsg(branch, reopenMs) {
    const tpl = branch && branch.clossed_text;
    if (!tpl) {
        const when = reopenMs ? (' We reopen ' + new Date(reopenMs).toLocaleString()) : '';
        return defaultMsg(branch) + when;
    }
    const dt = reopenMs ? new Date(reopenMs) : null;
    const pad = (x) => String(x).padStart(2, '0');
    const date = dt ? `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}` : '';
    const time = dt ? `${pad(dt.getHours())}:${pad(dt.getMinutes())}` : '';
    const day  = dt ? dt.toLocaleDateString('en-GB', { weekday: 'long' }) : '';
    return String(tpl)
        .replace(/\{branch_name\}/g, branchName(branch))
        .replace(/\{date\}/g, date)
        .replace(/\{time\}/g, time)
        .replace(/\{day\}/g, day)
        .replace(/\{contact_number\}/g, branch.contact_number || '');
}

function branchClosure(branch, holidayToday) {
    const now = Date.now();
    // 1. Permanent.
    if (Number(branch.closed) === 1) {
        return { reason: 'permanent', message: defaultMsg(branch), reopenAt: null };
    }
    // 2. Closed until a date/time.
    if (Number(branch.closed_until) === 1 && branch.closed_reopen_date) {
        const reopen = reopenTimestamp(branch.closed_reopen_date, branch.clossed_repoen_time);
        if (reopen == null || reopen > now) {
            return { reason: 'until', message: fillMsg(branch, reopen), reopenAt: reopen ? new Date(reopen).toISOString() : null };
        }
    }
    // 3. Closed for a duration.
    if (Number(branch.closed_for) === 1 && branch.closed_for_time) {
        const until = Date.parse(branch.closed_for_time);
        if (Number.isFinite(until) && until > now) {
            return { reason: 'temporary', message: fillMsg(branch, until), reopenAt: new Date(until).toISOString() };
        }
    }
    // 4. Holiday today (whole-day close; special-hours handled by the caller).
    if (holidayToday && Number(holidayToday.is_special_hour) !== 1) {
        const why = holidayToday.reason ? String(holidayToday.reason) : null;
        return { reason: 'holiday', message: why ? (defaultMsg(branch) + ' (' + why + ')') : defaultMsg(branch), reopenAt: null };
    }
    return null;
}

// Per-service "show option" gate (admin turned delivery/pickup off).
function optionClosed(branch, kind) {
    const opt = kind === 'delivery' ? Number(branch.show_delivery_option) : Number(branch.show_pickup_option);
    if (opt !== 0) { return false; }                       // option is ON
    const tab  = kind === 'delivery' ? Number(branch.show_delivery_option_tab) : Number(branch.show_pickup_option_tab);
    const util = kind === 'delivery' ? branch.delivery_closed_util_date : branch.pickup_closed_util_date;
    if (tab === 2) {                                        // closed UNTIL a date
        const t = Date.parse(util);
        return Number.isFinite(t) ? t > Date.now() : true;
    }
    return true;                                           // tab 1 (today) / 3 (permanent)
}

/**
 * compute — pure: branch row + today's shifts + today's holiday → verdict.
 *
 * Output: {
 *   isOpen, status: 'open'|'preorder'|'closed',
 *   services: { delivery:{status,window}, takeaway:{status,window} },
 *   hours, closedReason, message, reopenAt
 * }
 */
function compute(branch, shifts, holidayToday, configured) {
    const nowMin = nowMinutes();

    // Holiday "special hours" replaces today's window for every service.
    let eff = shifts;
    if (holidayToday && Number(holidayToday.is_special_hour) === 1) {
        eff = [
            { service_type_id: SERVICE.TAKEAWAY, is_open: 1, open_time: holidayToday.from_time, close_time: holidayToday.to_time },
            { service_type_id: SERVICE.DELIVERY, is_open: 1, open_time: holidayToday.from_time, close_time: holidayToday.to_time },
        ];
    }
    const hours = dayWindowLabel(eff);

    const closure = branchClosure(branch, holidayToday);
    if (closure) {
        return {
            isOpen: false, status: 'closed',
            services: { delivery: { status: 'closed', window: null }, takeaway: { status: 'closed', window: null } },
            hours, closedReason: closure.reason, message: closure.message, reopenAt: closure.reopenAt,
        };
    }

    // No store_business_hours configured for this branch at all → do NOT
    // mark it closed (most branches have no hours set). Fall back to the
    // legacy single window (start_time/end_time); if that's empty too,
    // assume OPEN — "unknown" must not read as "closed".
    if (configured === false) {
        const o = clockMin(branch.start_time), c = clockMin(branch.end_time);
        if (o != null && c != null && o !== c) {
            const within = c > o ? (nowMin >= o && nowMin < c) : (nowMin >= o || nowMin < c);
            const st = within ? 'open' : 'closed';
            return {
                isOpen: within, status: st,
                services: { delivery: { status: st, window: null }, takeaway: { status: st, window: null } },
                hours: fmt12(o) + ' – ' + fmt12(c > o ? c : c + 1440),
                closedReason: within ? null : 'hours', message: null, reopenAt: null,
            };
        }
        return {
            isOpen: true, status: 'open',
            services: { delivery: { status: 'open', window: null }, takeaway: { status: 'open', window: null } },
            hours: null, closedReason: null, message: null, reopenAt: null,
        };
    }

    const delivery = optionClosed(branch, 'delivery') ? { status: 'closed', window: null } : serviceState(eff, SERVICE.DELIVERY, nowMin);
    const takeaway = optionClosed(branch, 'pickup')   ? { status: 'closed', window: null } : serviceState(eff, SERVICE.TAKEAWAY, nowMin);

    const anyOpen = delivery.status === 'open' || takeaway.status === 'open';
    const anyPre  = delivery.status === 'preorder' || takeaway.status === 'preorder';
    const status  = anyOpen ? 'open' : (anyPre ? 'preorder' : 'closed');

    // Next opening time (for a "Opens at X" hint when not open now).
    let reopenAt = null;
    if (!anyOpen) {
        const wins = [delivery.window, takeaway.window].filter(w => w && Number.isFinite(w.open));
        if (wins.length) { reopenAt = fmt12(Math.min(...wins.map(w => w.open))); }
    }

    return {
        isOpen: anyOpen, status,
        services: { delivery, takeaway },
        hours,
        closedReason: status === 'closed' ? 'hours' : null,
        message: null,
        reopenAt,                                          // "5:00 PM" string when pre-order/closed-by-hours
    };
}

// ── DB loaders ───────────────────────────────────────────────────────
async function loadHolidayToday(companyId, branchId) {
    try {
        const today = todayYmd();   // UK date — server-timezone-independent
        return await db('store_holiday_details')
            .where({ company_id: companyId, branch_id: branchId, status: 1 })
            .andWhere('from_date', '<=', today)
            .andWhere('to_date', '>=', today)
            .first() || null;
    } catch (e) { return null; }
}
async function loadShiftsToday(companyId, branchId) {
    try {
        return await db('store_business_hours as h')
            .innerJoin('store_business_hour_shifts as s', 's.business_hour_id', 'h.id')
            .where({ 'h.company_id': companyId, 'h.branch_id': branchId, 'h.day_of_week': isoDow() })
            .whereIn('s.service_type_id', [SERVICE.TAKEAWAY, SERVICE.DELIVERY])
            .select('s.service_type_id', 's.is_open', 's.open_time', 's.close_time');
    } catch (e) { return []; }
}

/**
 * availabilityForBranch — one branch row (needs id/branch_id + company_id +
 * the close-flag columns). Does the holiday + shift reads, returns compute().
 */
async function availabilityForBranch(branch) {
    if (!branch) { return null; }
    const companyId = branch.company_id;
    const branchId  = branch.branch_id || branch.id;
    if (!companyId || !branchId) { return null; }
    const [holiday, shifts, cfgRow] = await Promise.all([
        loadHolidayToday(companyId, branchId),
        loadShiftsToday(companyId, branchId),
        db('store_business_hours').where({ branch_id: branchId }).first('id').catch(() => null),
    ]);
    return compute(branch, shifts, holiday, !!cfgRow);
}

/**
 * availabilityForBranches — BATCH (for list pages). Returns a
 * Map<branchId, verdict>. One shift query + one holiday query for all.
 */
async function availabilityForBranches(branches) {
    const out = new Map();
    const rows = (branches || []).filter(Boolean);
    if (!rows.length) { return out; }
    const branchIds = rows.map(b => b.branch_id || b.id);
    const dow = isoDow();
    const today = todayYmd();   // UK date — server-timezone-independent

    let shiftRows = [], holidayRows = [];
    try {
        shiftRows = await db('store_business_hours as h')
            .innerJoin('store_business_hour_shifts as s', 's.business_hour_id', 'h.id')
            .where('h.day_of_week', dow)
            .whereIn('h.branch_id', branchIds)
            .whereIn('s.service_type_id', [SERVICE.TAKEAWAY, SERVICE.DELIVERY])
            .select('h.branch_id', 's.service_type_id', 's.is_open', 's.open_time', 's.close_time');
    } catch (e) { shiftRows = []; }
    try {
        holidayRows = await db('store_holiday_details')
            .whereIn('branch_id', branchIds).where('status', 1)
            .andWhere('from_date', '<=', today).andWhere('to_date', '>=', today)
            .select('branch_id', 'is_special_hour', 'from_time', 'to_time', 'reason');
    } catch (e) { holidayRows = []; }

    // Which of these branches have ANY store_business_hours configured.
    let configuredRows = [];
    try {
        configuredRows = await db('store_business_hours').whereIn('branch_id', branchIds).distinct('branch_id');
    } catch (e) { configuredRows = []; }
    const configuredSet = new Set(configuredRows.map(r => String(r.branch_id)));

    const shiftsBy = new Map(), holidayBy = new Map();
    for (const s of shiftRows) {
        const k = String(s.branch_id);
        if (!shiftsBy.has(k)) { shiftsBy.set(k, []); }
        shiftsBy.get(k).push(s);
    }
    for (const h of holidayRows) { holidayBy.set(String(h.branch_id), h); }

    for (const b of rows) {
        const k = String(b.branch_id || b.id);
        out.set(k, compute(b, shiftsBy.get(k) || [], holidayBy.get(k) || null, configuredSet.has(k)));
    }
    return out;
}

// ── Pre-order slots ──────────────────────────────────────────────────
// 15-minute selectable times within today's open shift(s) for a service,
// future-only (now + lead), respecting closures/holidays. Mirrors the
// legacy Branch pre-order slot generator (15 * 60 stepping).
const SLOT_STEP = 15;        // minutes
const SLOT_LEAD = 15;        // earliest = now + 15 min

function pad2(n) { return String(n).padStart(2, '0'); }

function buildSlots(branch, shifts, holidayToday, serveType, opts) {
    const lead = (opts && Number.isFinite(opts.leadMin)) ? opts.leadMin : SLOT_LEAD;
    const svcId = Number(serveType) === SERVICE.TAKEAWAY ? SERVICE.TAKEAWAY : SERVICE.DELIVERY;

    // Per-service option turned off → no slots.
    if (optionClosed(branch, svcId === SERVICE.DELIVERY ? 'delivery' : 'pickup')) { return []; }

    // Blanket closure: permanent/holiday → none; temp/until → start at reopen
    // (only if it reopens TODAY).
    let startFloor = nowMinutes() + lead;
    const closure = branchClosure(branch, holidayToday);
    if (closure) {
        if (closure.reason === 'permanent' || closure.reason === 'holiday') { return []; }
        if (closure.reopenAt) {
            const r = new Date(closure.reopenAt);
            if (ymd(r) !== ymd(new Date())) { return []; }
            startFloor = Math.max(startFloor, r.getHours() * 60 + r.getMinutes());
        }
    }

    // Holiday "special hours" replaces today's window.
    let eff = shifts;
    if (holidayToday && Number(holidayToday.is_special_hour) === 1) {
        eff = [{ service_type_id: svcId, is_open: 1, open_time: holidayToday.from_time, close_time: holidayToday.to_time }];
    }

    const list = eff.filter(s => Number(s.service_type_id) === svcId && Number(s.is_open) === 1);
    const out = [];
    const seen = new Set();
    const base = new Date();
    for (const s of list) {
        let o = clockMin(s.open_time), c = clockMin(s.close_time);
        if (o == null || c == null) { continue; }
        if (c <= o) { c += 1440; }                          // overnight
        let t = Math.max(o, Math.ceil(startFloor / SLOT_STEP) * SLOT_STEP);
        for (; t < c; t += SLOT_STEP) {                     // < close (no slot AT close)
            const dayOff = Math.floor(t / 1440);
            const mod = t - dayOff * 1440;
            const key = dayOff + ':' + mod;
            if (seen.has(key)) { continue; }
            seen.add(key);
            const d = new Date(base); d.setDate(d.getDate() + dayOff);
            out.push({
                sort:  t,
                value: ymd(d) + 'T' + pad2(Math.floor(mod / 60)) + ':' + pad2(mod % 60),
                label: fmt12(mod) + (dayOff ? ' (next day)' : ''),
            });
        }
    }
    out.sort((a, b) => a.sort - b.sort);
    return out.map(s => ({ value: s.value, label: s.label }));
}

/**
 * slotsForBranch — today's valid pre-order slots for a branch + mode.
 * serveType: 2 = pickup/take-away, 3 = delivery. Returns [{value,label}].
 */
async function slotsForBranch(branch, serveType, opts) {
    if (!branch) { return []; }
    const companyId = branch.company_id;
    const branchId  = branch.branch_id || branch.id;
    if (!companyId || !branchId) { return []; }
    const [holiday, shifts] = await Promise.all([
        loadHolidayToday(companyId, branchId),
        loadShiftsToday(companyId, branchId),
    ]);
    return buildSlots(branch, shifts, holiday, serveType, opts);
}

// ── Multi-day pre-order schedule (Uber-style date chips) ─────────────
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // getDay()
const MONTH_SHORT   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * buildSlotsForDate — 15-min slots for ONE calendar date + service, using
 * that date's shifts/holiday. Same-calendar-day only (no overnight roll-over,
 * so each Uber chip shows times that belong to its own date). For today the
 * floor is now+lead; future dates start at the window open. Honours the
 * branch closure flags relative to the target date. Returns [{value,label}].
 */
function buildSlotsForDate(branch, shifts, holiday, serveType, targetDate, isToday, leadMin) {
    const lead = Number.isFinite(leadMin) ? leadMin : SLOT_LEAD;
    const svcId = Number(serveType) === SERVICE.TAKEAWAY ? SERVICE.TAKEAWAY : SERVICE.DELIVERY;
    if (optionClosed(branch, svcId === SERVICE.DELIVERY ? 'delivery' : 'pickup')) { return []; }
    if (Number(branch.closed) === 1) { return []; }                              // permanently closed
    if (holiday && Number(holiday.is_special_hour) !== 1) { return []; }         // whole-day holiday

    const tYmd = ymd(targetDate);
    let startFloor = isToday ? (nowMinutes() + lead) : 0;

    // closed_until / closed_for relative to THIS date.
    let reopenMs = null;
    if (Number(branch.closed_until) === 1 && branch.closed_reopen_date) {
        reopenMs = reopenTimestamp(branch.closed_reopen_date, branch.clossed_repoen_time);
    } else if (Number(branch.closed_for) === 1 && branch.closed_for_time) {
        const t = Date.parse(branch.closed_for_time); reopenMs = Number.isFinite(t) ? t : null;
    }
    if (reopenMs && reopenMs > Date.now()) {
        const r = new Date(reopenMs);
        const rYmd = ymd(r);
        if (rYmd > tYmd) { return []; }                                          // reopens after this date
        if (rYmd === tYmd) { startFloor = Math.max(startFloor, r.getHours() * 60 + r.getMinutes()); }
    }

    // Holiday "special hours" replaces the day's window.
    let eff = shifts;
    if (holiday && Number(holiday.is_special_hour) === 1) {
        eff = [{ service_type_id: svcId, is_open: 1, open_time: holiday.from_time, close_time: holiday.to_time }];
    }

    const list = eff.filter(s => Number(s.service_type_id) === svcId && Number(s.is_open) === 1);
    const out = [];
    const seen = new Set();
    for (const s of list) {
        let o = clockMin(s.open_time), c = clockMin(s.close_time);
        if (o == null || c == null) { continue; }
        if (c <= o) { c = 1440; }                              // overnight → cap at end of this calendar day
        let t = Math.max(o, Math.ceil(startFloor / SLOT_STEP) * SLOT_STEP);
        for (; t < c; t += SLOT_STEP) {                        // < close (no slot AT close)
            if (seen.has(t)) { continue; }
            seen.add(t);
            out.push({ sort: t, value: tYmd + 'T' + pad2(Math.floor(t / 60)) + ':' + pad2(t % 60), label: fmt12(t) });
        }
    }
    out.sort((a, b) => a.sort - b.sort);
    return out.map(s => ({ value: s.value, label: s.label }));
}

async function loadShiftsAllDays(companyId, branchId) {
    try {
        return await db('store_business_hours as h')
            .innerJoin('store_business_hour_shifts as s', 's.business_hour_id', 'h.id')
            .where({ 'h.company_id': companyId, 'h.branch_id': branchId })
            .whereIn('s.service_type_id', [SERVICE.TAKEAWAY, SERVICE.DELIVERY])
            .select('h.day_of_week', 's.service_type_id', 's.is_open', 's.open_time', 's.close_time');
    } catch (e) { return []; }
}
async function loadHolidaysRange(companyId, branchId, fromYmd, toYmd) {
    try {
        return await db('store_holiday_details')
            .where({ company_id: companyId, branch_id: branchId, status: 1 })
            .andWhere('from_date', '<=', toYmd)
            .andWhere('to_date', '>=', fromYmd)
            .select('from_date', 'to_date', 'is_special_hour', 'from_time', 'to_time', 'reason');
    } catch (e) { return []; }
}

/**
 * scheduleDaysForBranch — the next `days` (default 7) calendar days for the
 * Uber-style pre-order picker. Each entry is one date with its own 15-min
 * slots from that day's store_business_hours. Days with no usable shift have
 * `slots: []` (the chip renders disabled). serveType: 2 pickup / 3 delivery.
 * Returns [{ date, isToday, top, sub, slots:[{value,label}] }].
 */
async function scheduleDaysForBranch(branch, serveType, opts) {
    if (!branch) { return []; }
    const companyId = branch.company_id;
    const branchId  = branch.branch_id || branch.id;
    if (!companyId || !branchId) { return []; }
    const days = (opts && Number.isFinite(opts.days)) ? opts.days : 7;
    const lead = (opts && Number.isFinite(opts.leadMin)) ? opts.leadMin : SLOT_LEAD;

    const first = new Date(); first.setHours(0, 0, 0, 0);
    const last  = new Date(first); last.setDate(last.getDate() + days - 1);

    const [allShifts, holidays] = await Promise.all([
        loadShiftsAllDays(companyId, branchId),
        loadHolidaysRange(companyId, branchId, ymd(first), ymd(last)),
    ]);
    const shiftsByDow = {};
    allShifts.forEach((s) => { const k = Number(s.day_of_week); (shiftsByDow[k] = shiftsByDow[k] || []).push(s); });

    const out = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(first); d.setDate(d.getDate() + i);
        const dow = d.getDay() === 0 ? 7 : d.getDay();
        const dYmd = ymd(d);
        const holiday = holidays.find(h => String(h.from_date).slice(0, 10) <= dYmd && String(h.to_date).slice(0, 10) >= dYmd) || null;
        const slots = buildSlotsForDate(branch, shiftsByDow[dow] || [], holiday, serveType, d, i === 0, lead);
        out.push({
            date:    dYmd,
            isToday: i === 0,
            top:     i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : WEEKDAY_SHORT[d.getDay()]),
            sub:     d.getDate() + ' ' + MONTH_SHORT[d.getMonth()],
            slots,
        });
    }
    return out;
}

/**
 * isSchedulable — is a chosen pre-order value ('YYYY-MM-DDTHH:MM' or Date)
 * one of today's valid slots for this branch + mode? Used to reject
 * free-typed times that fall outside real opening hours.
 */
async function isSchedulable(branch, serveType, when) {
    if (!branch || !when) { return false; }
    const slots = await slotsForBranch(branch, serveType);
    if (!slots.length) { return false; }
    const target = (when instanceof Date)
        ? ymd(when) + 'T' + pad2(when.getHours()) + ':' + pad2(when.getMinutes())
        : String(when).slice(0, 16);
    return slots.some(s => s.value === target);
}

// ── Weekly opening-hours table (Restaurant Info popup) ───────────────
const WEEKDAY_ISO_SHORT = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const WEEKDAY_ISO_FULL  = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

// One service's window label for a day's shifts ("9:00 AM – 11:00 PM"),
// earliest open–latest close among its open shifts; null when closed.
function serviceWindowLabel(shifts, serviceId) {
    let minOpen = null, maxClose = null;
    for (const s of shifts) {
        if (Number(s.service_type_id) !== serviceId || Number(s.is_open) !== 1) { continue; }
        const o = clockMin(s.open_time), c = clockMin(s.close_time);
        if (o == null || c == null) { continue; }
        const cc = c <= o ? c + 1440 : c;                  // overnight rolls past midnight
        if (minOpen == null || o < minOpen) { minOpen = o; }
        if (maxClose == null || cc > maxClose) { maxClose = cc; }
    }
    if (minOpen == null) { return null; }
    return fmt12(minOpen) + ' – ' + fmt12(maxClose);
}

/**
 * weekHoursForBranch — the full Mon→Sun opening-hours table for the
 * Restaurant Info popup. One row per ISO weekday with the pickup + delivery
 * windows (or null when closed that day) and which row is today.
 * Returns [] when the branch has no store_business_hours configured.
 */
async function weekHoursForBranch(branch) {
    if (!branch) { return []; }
    const companyId = branch.company_id;
    const branchId  = branch.branch_id || branch.id;
    if (!companyId || !branchId) { return []; }
    const allShifts = await loadShiftsAllDays(companyId, branchId);
    if (!allShifts.length) { return []; }
    const byDow = {};
    allShifts.forEach((s) => { const k = Number(s.day_of_week); (byDow[k] = byDow[k] || []).push(s); });
    const todayDow = isoDow();
    const out = [];
    for (let dow = 1; dow <= 7; dow++) {
        const sh = byDow[dow] || [];
        out.push({
            dow,
            day:      WEEKDAY_ISO_FULL[dow],
            short:    WEEKDAY_ISO_SHORT[dow],
            isToday:  dow === todayDow,
            pickup:   serviceWindowLabel(sh, SERVICE.TAKEAWAY),
            delivery: serviceWindowLabel(sh, SERVICE.DELIVERY),
        });
    }
    return out;
}

module.exports = {
    SERVICE,
    availabilityForBranch,
    availabilityForBranches,
    slotsForBranch,
    scheduleDaysForBranch,
    weekHoursForBranch,
    isSchedulable,
    compute,                 // exported for tests
    buildSlots,              // exported for tests
    buildSlotsForDate,       // exported for tests
};
