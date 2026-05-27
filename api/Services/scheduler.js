'use strict';

/**
 * Services/scheduler.js
 *
 * What:   Tiny wrapper around node-cron that lets us register named jobs at
 *         boot and start / stop them all together. Jobs stay REGISTERED even
 *         when the scheduler is off, so manual one-shot invocations (e.g.
 *         scripts/run-job.js) still work — only the cron firing is gated.
 * Why:    EatNDeal has a few scheduled jobs (settlement runs, coupon expiry,
 *         scheduled-order release, dashboard cache). We want one place to
 *         register them, one env flag (SCHEDULER_ENABLED) to start them,
 *         and a clean stop() for graceful shutdown.
 * Type:   READ + WRITE (jobs may write to DB; the scheduler itself just
 *         orchestrates).
 * Inputs: per function (documented below).
 * Output: per function (documented below).
 * Used:   api/index.js at boot — register('name', cronExpr, handler), then
 *         scheduler.start() (if SCHEDULER_ENABLED is truthy).
 *
 * Change log:
 *   2026-05-25 — initial; ported from IOT reference (Services/scheduler.js).
 */

const cron = require('node-cron');
const H    = require('../Helpers/helper');

// In-process registry. Each entry: { name, expression, handler, task, running }.
// `task` is the node-cron handle; `running` flips true while the handler is
// mid-execution so we can skip a tick that overlaps a still-running job.
const jobs = new Map();

let started = false;

/**
 * register
 *
 * What:   Register a named cron job. Doesn't start it — call start() to fire.
 * Why:    Keeps the boot-time job list declarative + visible at the top of
 *         api/index.js. Re-registering a name throws (catches typos).
 * Type:   WRITE (mutates the in-process registry).
 * Inputs: name       (string)   — unique label; used in logs + telemetry
 *         expression (string)   — node-cron expression (5- or 6-field)
 *         handler    (function) — async () => void; runs every fire
 * Output: void.
 * Used:   api/index.js boot.
 */
function register(name, expression, handler) {
    if (typeof name !== 'string' || !name) {
        throw new TypeError('scheduler.register: name must be a non-empty string');
    }
    if (!cron.validate(expression)) {
        throw new TypeError(`scheduler.register: invalid cron expression "${expression}"`);
    }
    if (typeof handler !== 'function') {
        throw new TypeError('scheduler.register: handler must be a function');
    }
    if (jobs.has(name)) {
        throw new Error(`scheduler.register: job "${name}" already registered`);
    }

    jobs.set(name, {
        name,
        expression,
        handler,
        task:    null,
        running: false,
    });
}

/**
 * start
 *
 * What:   Schedules every registered job with node-cron. Each tick runs the
 *         handler in a try/catch so a thrown error in one job doesn't take
 *         the whole scheduler down.
 * Why:    See file header. Called from api/index.js only when the env flag
 *         SCHEDULER_ENABLED is on.
 * Type:   WRITE (creates node-cron tasks).
 * Inputs: none.
 * Output: void.
 * Used:   api/index.js boot, gated by SCHEDULER_ENABLED.
 */
function start() {
    if (started) {
        H.log.warn('scheduler.start', 'already started; ignoring');
        return;
    }
    for (const entry of jobs.values()) {
        // Skip a tick if the previous run hasn't finished — prevents pile-ups
        // when a job takes longer than its interval. Logging the skip helps
        // ops realise the job is bottlenecked.
        entry.task = cron.schedule(entry.expression, async () => {
            if (entry.running) {
                H.log.warn('scheduler.skip', `${entry.name} still running; skipping tick`);
                return;
            }
            entry.running = true;
            const startedAtMs = Date.now();
            try {
                await entry.handler();
            } catch (err) {
                H.log.error('scheduler.error', `${entry.name} threw`, {
                    message: err && err.message,
                    stack:   err && err.stack,
                });
            } finally {
                const ms = Date.now() - startedAtMs;
                H.log.debug('scheduler.done', `${entry.name} (${ms} ms)`);
                entry.running = false;
            }
        });
    }
    started = true;
    H.log.info('scheduler.start', `started ${jobs.size} job(s)`);
}

/**
 * stop
 *
 * What:   Stops every running cron task. Waits for in-flight handlers to
 *         finish before resolving (best-effort 5-second cap).
 * Why:    Called from the graceful-shutdown path in api/index.js so no new
 *         job fires while DB pools are draining.
 * Type:   WRITE (destroys node-cron tasks).
 * Inputs: none.
 * Output: Promise<void>.
 * Used:   Graceful shutdown in api/index.js.
 */
async function stop() {
    if (!started) return;
    for (const entry of jobs.values()) {
        if (entry.task) {
            try {
                entry.task.stop();
            } catch (err) {
                H.log.error('scheduler.stop', `failed to stop ${entry.name}`, {
                    message: err && err.message,
                });
            }
            entry.task = null;
        }
    }
    // Best-effort wait for in-flight handlers. Cap at 5 seconds so we never
    // block shutdown indefinitely.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const anyRunning = [...jobs.values()].some((j) => j.running);
        if (!anyRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    started = false;
    H.log.info('scheduler.stop', 'stopped');
}

/**
 * _state
 *
 * What:   Internal inspection of registry state — count + per-job running flag.
 * Why:    Used by api/index.js boot log + tests. Underscore prefix because
 *         it's not part of the stable surface.
 * Type:   READ.
 * Inputs: none.
 * Output: { jobCount, started, jobs: [{ name, expression, running }] }.
 */
function _state() {
    return {
        jobCount: jobs.size,
        started,
        jobs: [...jobs.values()].map((j) => ({
            name:       j.name,
            expression: j.expression,
            running:    j.running,
        })),
    };
}

module.exports = { register, start, stop, _state };
