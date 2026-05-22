/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 */

/**
 * Single-worker job dispatcher.
 *
 * Wraps an async `processOne` step in an `isProcessing` mutex so that
 * concurrent `kick()` invocations cannot start a second worker while the
 * first is still awaiting. When the in-flight step completes, the runner
 * re-enters via `setImmediate` as long as `hasNext()` reports more work.
 *
 * Background: the previous dispatcher used
 *     if (JobManager.size === 1) processNextJob();
 * which only checks the queue, not whether a worker is already running.
 * Because `processNextJob` removed a job from the queue before its `await`,
 * a request arriving during the await would re-trigger the dispatcher and
 * the two workers would proceed in parallel. See #1816.
 */
export interface JobRunner {
    /** Signal that work is available. Safe to call from anywhere; concurrent calls are coalesced. */
    kick(): void;
    /** True iff a `processOne` invocation is currently in flight. */
    isProcessing(): boolean;
}

export function createJobRunner(hasNext: () => boolean, processOne: () => Promise<void>): JobRunner {
    let isProcessing = false;

    async function loop() {
        if (isProcessing) return;
        if (!hasNext()) return;
        isProcessing = true;
        try {
            await processOne();
        } catch (e) {
            // processOne is expected to handle its own errors. Catching here is
            // defensive: a stray rejection must not strand the runner with
            // isProcessing=true and freeze the queue.
            // eslint-disable-next-line no-console
            console.error('[job-runner] processOne rejected:', e);
        } finally {
            isProcessing = false;
            if (hasNext()) setImmediate(loop);
        }
    }

    return {
        kick: loop,
        isProcessing: () => isProcessing,
    };
}
