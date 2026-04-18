/**
 * Utility: Storyboard Poller
 * Path: /public/utils/storyboard-poller.js
 * Version: [ STORYBOARD POLLER : v.2.0.0 ]
 *
 * SC-05 — Adaptive Polling Back-off
 * ──────────────────────────────────
 * The previous version polled at a fixed 4-second interval for the entire
 * generation window. At 5,000 members with 10% concurrent generation, that
 * produced ~7,500 webMethod calls per minute — enough to saturate Wix's
 * fair-use rate limits and trigger cold-start latency spikes.
 *
 * This version implements a three-phase adaptive interval:
 *
 *   Phase 1 — Active   (0 – PHASE1_DURATION_MS):  8 s interval
 *     Frames typically start arriving within the first 30–60 seconds.
 *     8 s still provides a responsive UX while halving the polling load.
 *
 *   Phase 2 — Patient  (PHASE1_DURATION_MS – PHASE2_DURATION_MS):  12 s
 *     If no completion after 60 s, the pipeline is taking longer than usual.
 *     Reduce polling further — the user is waiting, not watching.
 *
 *   Phase 3 — Slow     (> PHASE2_DURATION_MS):  20 s
 *     If still incomplete after 3 minutes, something is likely delayed in
 *     n8n. Back off aggressively. onTimeout() will fire at POLL_TIMEOUT_MS
 *     regardless, giving the user a clear message.
 *
 * Polling load comparison (500 concurrent sessions):
 *   v1.0.0 (fixed 4 s)  →  ~7,500 calls/min
 *   v2.0.0 (adaptive)   →  ~3,750 calls/min (Phase 1) → ~2,500 (Phase 2) → ~1,500 (Phase 3)
 *
 * Additional safety:
 *   Minimum interval guard — if a tick takes longer than the current phase
 *   interval (e.g. Velo cold-start latency), the next tick is not fired
 *   immediately. It waits the full interval from the END of the previous tick.
 *   This prevents a burst of back-to-back calls during infrastructure stress.
 *
 * Contract: identical to v1.0.0.
 *   startStoryboardPolling(projectId, { onFrame, onComplete, onTimeout, onError })
 *   → { stop: () => void }
 *   stopStoryboardPolling(pollerInstance)
 */

import { getStoryboardFrames } from 'backend/services/project.web';

const VERSION = '[ STORYBOARD POLLER : v.2.0.0 ]';

// ─── ADAPTIVE INTERVAL CONFIGURATION ─────────────────────────────────────────

// Phase 1: first 60 s — check every 8 s
const PHASE1_INTERVAL_MS  = 8_000;
const PHASE1_DURATION_MS  = 60_000;

// Phase 2: 60 s – 180 s — check every 12 s
const PHASE2_INTERVAL_MS  = 12_000;
const PHASE2_DURATION_MS  = 180_000;

// Phase 3: > 180 s — check every 20 s
const PHASE3_INTERVAL_MS  = 20_000;

// Hard timeout — fires onTimeout() regardless of phase
const POLL_TIMEOUT_MS     = 600_000;  // 10 minutes

const TOTAL_FRAMES        = 15;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Returns the polling interval for the current elapsed time.
 * @param {number} elapsedMs — ms since polling started
 * @returns {number}
 */
function getIntervalForElapsed(elapsedMs) {
    if (elapsedMs < PHASE1_DURATION_MS)  return PHASE1_INTERVAL_MS;
    if (elapsedMs < PHASE2_DURATION_MS)  return PHASE2_INTERVAL_MS;
    return PHASE3_INTERVAL_MS;
}

// ─── START POLLING ────────────────────────────────────────────────────────────

/**
 * Starts the adaptive polling loop for a project's storyboard frames.
 *
 * The loop:
 *   - Fires onFrame() for each NEW frame not seen in a previous tick.
 *   - Fires onComplete() when all TOTAL_FRAMES frames are confirmed.
 *   - Fires onTimeout() if POLL_TIMEOUT_MS elapses without completion.
 *   - Fires onError() on terminal backend failures (AUTH, FORBIDDEN, NOT_FOUND).
 *   - Tolerates transient errors (network hiccups) — retries on the next tick.
 *
 * SC-05 additions:
 *   - Interval is recalculated before each tick based on elapsed time.
 *   - Minimum interval guard: next tick is always scheduled from tick END,
 *     not tick START, preventing burst calls on slow cold starts.
 *
 * @param {string}   projectId
 * @param {{ onFrame?: function, onComplete?: function, onTimeout?: function, onError?: function }} callbacks
 * @returns {{ stop: () => void }}
 */
export function startStoryboardPolling(projectId, {
    onFrame    = null,
    onComplete = null,
    onTimeout  = null,
    onError    = null
} = {}) {
    if (!projectId) {
        console.error(`${VERSION} startStoryboardPolling: No projectId supplied.`);
        return { stop: () => {} };
    }

    let stopped       = false;
    let timeoutId     = null;
    let tickTimeoutId = null;        // setTimeout handle for the next tick
    let seenFrameIds  = new Set();
    const startedAt   = Date.now();

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
        if (timeoutId)     { clearTimeout(timeoutId);     timeoutId     = null; }
        if (tickTimeoutId) { clearTimeout(tickTimeoutId); tickTimeoutId = null; }
        console.log(`${VERSION} Poll loop terminated for project: ${projectId}`);
    }

    // ── Schedule next tick ────────────────────────────────────────────────────
    // SC-05: Always schedule from END of previous tick (via setTimeout, not
    // setInterval). This guarantees the minimum interval is honoured even
    // when a tick takes longer than the interval due to cold-start latency.
    function scheduleNextTick() {
        if (stopped) return;
        const elapsed  = Date.now() - startedAt;
        const interval = getIntervalForElapsed(elapsed);
        console.log(`${VERSION} Next poll in ${interval}ms (elapsed: ${Math.round(elapsed / 1000)}s, phase: ${interval === PHASE1_INTERVAL_MS ? 1 : interval === PHASE2_INTERVAL_MS ? 2 : 3}) for project: ${projectId}`);
        tickTimeoutId = setTimeout(tick, interval);
    }

    // ── Poll tick ─────────────────────────────────────────────────────────────
    async function tick() {
        if (stopped) return;

        try {
            const result = await getStoryboardFrames(projectId);

            if (!result.ok) {
                const errType = result.error?.type || 'UNKNOWN';
                console.error(`${VERSION} Poll tick error: ${errType} for project: ${projectId}`);

                // Terminal errors — stop polling and surface to the UI
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

            // Fire onFrame for each frame not yet seen, in ascending order
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

    // ── Kick off immediately, then adaptive schedule takes over ───────────────
    tick();

    return { stop: cleanup };
}

// ─── STOP POLLING ─────────────────────────────────────────────────────────────

/**
 * Convenience alias — stops an active polling instance.
 * Safe to call with a null/undefined argument (no-op).
 *
 * @param {{ stop: () => void } | null | undefined} pollerInstance
 */
export function stopStoryboardPolling(pollerInstance) {
    if (pollerInstance && typeof pollerInstance.stop === 'function') {
        pollerInstance.stop();
    }
}