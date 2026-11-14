export class SimpleQueue {
    constructor(options = {}) {
        this.queue = [];
        this.activeCount = 0;
        this.idleWaiters = [];
        const raw = options.concurrency;
        this.concurrency = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    }
    /** number of tasks waiting to start */
    get size() {
        return this.queue.length;
    }
    /** number of tasks currently running */
    get pending() {
        return this.activeCount;
    }
    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.pump();
        });
    }
    onIdle() {
        if (this.queue.length === 0 && this.activeCount === 0) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.idleWaiters.push(resolve);
        });
    }
    clear() {
        // queued tasks are dropped without running; p-queue's clear()
        // leaves their promises pending forever, so mirror the only
        // safe reading of that: reject them instead of leaking a
        // promise no caller can ever observe settle. No in-tree
        // consumer calls clear(), so this never fires in practice.
        const dropped = this.queue.splice(0, this.queue.length);
        for (const task of dropped) {
            task.reject(new Error('queue cleared'));
        }
    }
    pump() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            this.activeCount++;
            (async () => {
                try {
                    task.resolve(await task.fn());
                }
                catch (err) {
                    task.reject(err);
                }
                finally {
                    this.activeCount--;
                    this.pump();
                    if (this.queue.length === 0 && this.activeCount === 0 && this.idleWaiters.length) {
                        const waiters = this.idleWaiters;
                        this.idleWaiters = [];
                        for (const resolve of waiters) {
                            resolve();
                        }
                    }
                }
            })();
        }
    }
}
export default SimpleQueue;
//# sourceMappingURL=simple-queue.js.map