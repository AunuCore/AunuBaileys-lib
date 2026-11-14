/**
 * AunuBaileys (P9, 2.0.0): internal replacement for the `p-queue`
 * package. Every consumer in this tree used exactly one configuration
 * — `new PQueue({ concurrency: 1 })` plus `.add(task)` (verified by
 * grep: auth-utils key queues and PreKeyManager; no interval, cap,
 * timeout or priority options anywhere) — so the replacement covers
 * that surface faithfully: tasks start in FIFO order, at most
 * `concurrency` run at once, and a task's rejection propagates to the
 * promise returned by `add` without stalling the queue.
 *
 * The concurrency value is sanitised at the boundary (guardrail
 * rule): a non-finite or sub-1 value falls back to 1, the only value
 * any in-tree consumer passes.
 */
export interface SimpleQueueOptions {
    concurrency?: number;
}
export declare class SimpleQueue {
    private readonly concurrency;
    private readonly queue;
    private activeCount;
    private idleWaiters;
    constructor(options?: SimpleQueueOptions);
    /** number of tasks waiting to start */
    get size(): number;
    /** number of tasks currently running */
    get pending(): number;
    add<T>(fn: () => Promise<T> | T): Promise<T>;
    onIdle(): Promise<void>;
    clear(): void;
    private pump;
}
export default SimpleQueue;
//# sourceMappingURL=simple-queue.d.ts.map