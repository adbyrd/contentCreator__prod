/**
 * Utility: Storyboard Poller
 * Path: /public/utils/storyboard-poller.js
 * Version: [ STORYBOARD POLLER : v.2.0.0 ]
 *
 * SC-05 — Adaptive Polling Back-off
 * ──────────────────────────────────
 * The previous version polled at a fixed 4-second interval for the entire
 * generation window. At scale, a fixed interval produces excessive webMethod
 * calls during infrastructure stress and n8n cold-start windows.
 *
 * This version implements a three-phase adaptive interval:
 *
 *   Phase 1 — Active  (0 – 60 s):    8 s interval
 *     Frames typically start arriving within the first 30–60 seconds.
 *     8 s provides a responsive UX while halving the polling load.
 *
 *   Phase 2 — Patient (60 s – 180 s): 12 s interval
 *     If no completion after 60 s, the pipeline is taking longer than usual.
 *     Reduce further — the user is waiting, not watching.
 *
 *   Phase 3 — Slow    (> 180 s):      20 s interval
 *     Back off aggressively. onTimeout() fires at POLL_TIMEOUT_MS regardless.
 *
 * Minimum interval guard:
 *   Next tick is always scheduled from the END of the previous tick
 *   (via setTimeout, not setInterval). This prevents burst calls if a
 *   tick takes longer than the current phase interval (e.g. cold-start latency).
 *
 * Exports:
 *   startStoryboardPolling(projectId, { onFrame, onComplete, onTimeout, onError })
 *     → { stop: () => void }
 *   stopStoryboardPolling(pollerInstance)
 *
 * Contract: backward compatible with v.1.0.0 call sites.
 */

import { getStoryboardFrames } from 'backend/services/project.web';

const VERSION = '[ STORYBOARD POLLER : v.2.0.0 ]';

// ─── ADAPTIVE INTERVAL CONFIGURATION ─────────────────────────────────────────

// Phase 1: 0 – 60 s — check every 8 s
const PHASE1_INTERVAL_MS = 8_000;
const PHASE1_DURATION_MS = 60_000;

// Phase 2: 60 s – 180 s — check every 12 s
const PHASE2_INTERVAL_MS = 12_000;
const PHASE2_DURATION_MS = 180_000;

// Phase 3: > 180 s — check every 20 s
const PHASE3_INTERVAL_MS = 20_000;

// Hard timeout — fires onTimeout() regardless of phase
const POLL_TIMEOUT_MS    = 600_000;   // 10 minutes

const TOTAL_FRAMES       = 15;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Returns the polling interval for the current elapsed time.
 * @param {number} elapsedMs — ms since polling started
 * @returns {number}
 */
function getIntervalForElapsed(elapsedMs) {
    if (elapsedMs < PHASE1_DURATION_MS) return PHASE1_INTERVAL_MS;
    if (elapsedMs < PHASE2_DURATION_MS) return PHASE2_INTERVAL_MS;
    return PHASE3_INTERVAL_MS;
}

// ─── START POLLING ────────────────────────────────────────────────────────────

/**
 * Starts the adaptive polling loop for a project's storyboard frames.
 *
 * The loop:
 *   - Fires onFrame(frame, frames) for each NEW frame not seen in a prior tick.
 *   - Fires onComplete(frames) when all TOTAL_FRAMES frames are confirmed.
 *   - Fires onTimeout() if POLL_TIMEOUT_MS elapses without completion.
 *   - Fires onError(error) on terminal backend failures (AUTH_REQUIRED, FORBIDDEN, NOT_FOUND).
 *   - Tolerates transient errors (network hiccups) — retries on the next tick.
 *
 * SC-05: Interval is recalculated before each tick based on elapsed time.
 * Next tick is always scheduled from tick END to prevent burst calls.
 *
 * @param {string} projectId
 * @param {{ onFrame?: function, onComplete?: function, onTimeout?: function, onError?: function }} callbacks
 * @returns {{ stop: () => void }}
 */
export function startStoryboardPolling(projectId, {
    onFrame    = null,
    onComplete = null,
    onTimeout  = null,
    onError    = null,
} = {}) {
    if (!projectId) {
        console.error(`${VERSION} startStoryboardPolling: No projectId supplied.`);
        return { stop: () => {} };
    }

    let stopped     = false;
    let timeoutId   = null;
    let tickId      = null;   // setTimeout handle for the next scheduled tick
    const seenFrameIds = new Set();
    const startedAt    = Date.now();

    console.log(`${VERSION} Polling started for project: ${projectId}`);

    // ── Hard timeout guard ────────────────────────────────────────────────────

    timeoutId = setTimeout(() => {
        if (stopped) return;
        console.warn(`${VERSION} Polling timed out after ${POLL_TIMEOUT_MS / 1000}s for project: ${projectId}`);
        cleanup();
        if (typeof onTimeout === 'function') onTimeout();
    }, POLL_TIMEOUT_MS);

    // ── Cleanup ───────────────────────────────────────────────────────────────

    function cleanup() {
        stopped = true;
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        if (tickId)    { clearTimeout(tickId);    tickId    = null; }
        console.log(`${VERSION} Poll loop terminated for project: ${projectId}`);
    }

    // ── Schedule next tick ────────────────────────────────────────────────────
    // Always scheduled from END of previous tick (setTimeout, not setInterval).
    // This guarantees the minimum interval is honoured even when a tick takes
    // longer than the interval due to cold-start latency.

    function scheduleNextTick() {
        if (stopped) return;
        const elapsed  = Date.now() - startedAt;
        const interval = getIntervalForElapsed(elapsed);
        const phase    = interval === PHASE1_INTERVAL_MS ? 1
                       : interval === PHASE2_INTERVAL_MS ? 2
                       : 3;
        console.log(`${VERSION} Next poll in ${interval}ms (elapsed: ${Math.round(elapsed / 1000)}s, phase: ${phase}) for project: ${projectId}`);
        tickId = setTimeout(tick, interval);
    }

    // ── Poll tick ─────────────────────────────────────────────────────────────

    async function tick() {
        if (stopped) return;

        try {
            const result = await getStoryboardFrames(projectId);

            if (!result.ok) {
                const errType = result.error || 'UNKNOWN';
                console.error(`${VERSION} Poll tick error: ${errType} for project: ${projectId}`);

                // Terminal errors — stop the loop and surface to the UI
                if (['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND'].includes(errType)) {
                    cleanup();
                    if (typeof onError === 'function') onError(result.error);
                    return;
                }

                // Transient errors — tolerate and retry on the next tick
                scheduleNextTick();
                return;
            }

            const { frames = [], projectStatus, frameCount } = result;

            // Fire onFrame for each newly-seen frame, in ascending index order
            for (const frame of frames) {
                if (!seenFrameIds.has(frame._id)) {
                    seenFrameIds.add(frame._id);
                    console.log(`${VERSION} New frame: index ${frame.frameIndex} | project: ${projectId}`);
                    if (typeof onFrame === 'function') onFrame(frame, frames);
                }
            }

            // Check for completion
            const isDone = projectStatus === 'complete' || frameCount >= TOTAL_FRAMES;

            if (isDone) {
                console.log(`${VERSION} All frames received for project: ${projectId}. Stopping poll.`);
                cleanup();
                if (typeof onComplete === 'function') onComplete(frames);
                return;
            }

        } catch (err) {
            // Unexpected JS-level error — log and continue to next tick
            console.error(`${VERSION} Unexpected polling error:`, err);
        }

        scheduleNextTick();
    }

    // ── Kick off immediately; adaptive schedule takes over from tick end ───────
    tick();

    return { stop: cleanup };
}

// ─── STOP POLLING ─────────────────────────────────────────────────────────────

/**
 * Convenience alias — stops an active polling instance.
 * Safe to call with a null or undefined argument (no-op).
 *
 * @param {{ stop: () => void } | null | undefined} pollerInstance
 */
export function stopStoryboardPolling(pollerInstance) {
    if (pollerInstance && typeof pollerInstance.stop === 'function') {
        pollerInstance.stop();
    }
}