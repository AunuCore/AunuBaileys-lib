/**
 * AunuBaileys (P9, 2.0.0): internal replacement for the `async-mutex`
 * package — the tree only ever used `Mutex` (`acquire`, `runExclusive`,
 * `isLocked`), so the replacement covers exactly that surface.
 *
 * Semantics match the package: waiters are served strictly FIFO, the
 * lock is handed directly to the next waiter on release (it never
 * appears unlocked in between), `runExclusive` releases on throw, and
 * a release function is idempotent — calling it twice must not hand
 * the lock to two waiters.
 */
export type ReleaseFunction = () => void;
export declare class Mutex {
    private locked;
    private waiters;
    private unlockWaiters;
    isLocked(): boolean;
    acquire(): Promise<ReleaseFunction>;
    runExclusive<T>(callback: () => Promise<T> | T): Promise<T>;
    waitForUnlock(): Promise<void>;
    private makeRelease;
}
//# sourceMappingURL=mutex.d.ts.map