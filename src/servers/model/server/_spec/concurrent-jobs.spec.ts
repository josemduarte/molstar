/**
 * Regression test for ModelServer queue concurrency issues.
 *
 * Before the fix, the web dispatcher's trigger was
 *
 *     if (JobManager.size === 1) processNextJob();   // api-web.ts
 *
 * and `processNextJob` removed a job from the queue *before* awaiting
 * `resolveJob`. A request that arrived during the await would re-trigger
 * the dispatcher and a second worker would proceed in parallel, defeating
 * the queue's single-worker assumption and inflating peak memory.
 *
 * The fix moves the single-worker invariant into `createJobRunner` via an
 * `isProcessing` flag. This test pins that invariant against the real
 * implementation in ../job-runner.ts.
 */

import { createJobRunner } from '../job-runner';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (cond()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timeout'));
            setImmediate(tick);
        };
        tick();
    });
}

describe('job-runner', () => {
    it('serializes concurrent kicks: at most one processOne in flight', async () => {
        const queue: number[] = [];
        const gates: ReturnType<typeof deferred>[] = [];
        const started: number[] = [];
        let inFlight = 0;
        let peakInFlight = 0;

        const runner = createJobRunner(
            () => queue.length > 0,
            async () => {
                const id = queue.shift()!;
                started.push(id);
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                try {
                    await gates[id].promise;
                } finally {
                    inFlight--;
                }
            }
        );

        // Two jobs arrive in the same tick (this is the production trigger).
        queue.push(0); gates.push(deferred());
        runner.kick();
        queue.push(1); gates.push(deferred());
        runner.kick();

        // Job 1 must wait. Only job 0 may be in flight.
        await waitUntil(() => started.length === 1);
        expect(started).toEqual([0]);
        expect(peakInFlight).toBe(1);
        expect(runner.isProcessing()).toBe(true);

        // Release job 0 → runner should pick up job 1.
        gates[0].resolve();
        await waitUntil(() => started.length === 2);
        expect(started).toEqual([0, 1]);
        expect(peakInFlight).toBe(1);

        // Release job 1; runner goes idle.
        gates[1].resolve();
        await waitUntil(() => !runner.isProcessing());
        expect(inFlight).toBe(0);
    });

    it('idle kicks are no-ops', async () => {
        const runner = createJobRunner(() => false, async () => { throw new Error('should not run'); });
        runner.kick();
        runner.kick();
        await new Promise(r => setImmediate(r));
        expect(runner.isProcessing()).toBe(false);
    });

    it('an in-flight rejection does not strand the runner', async () => {
        const queue: string[] = ['a', 'b'];
        const seen: string[] = [];
        const runner = createJobRunner(
            () => queue.length > 0,
            async () => {
                const id = queue.shift()!;
                seen.push(id);
                if (id === 'a') throw new Error('boom');
            }
        );

        // processOne for 'a' rejects; createJobRunner does not catch — the caller
        // is expected to handle errors inside processOne. Verify that the unhandled
        // rejection still releases isProcessing so 'b' can run on the next kick.
        runner.kick();
        await waitUntil(() => seen.length === 1).catch(() => { /* ok */ });

        // Wait a tick for the rejection to settle.
        await new Promise(r => setImmediate(r));
        expect(runner.isProcessing()).toBe(false);

        runner.kick();
        await waitUntil(() => seen.length === 2);
        expect(seen).toEqual(['a', 'b']);
    });
});
