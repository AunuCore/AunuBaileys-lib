export class Mutex {
    constructor() {
        this.locked = false;
        this.waiters = [];
        this.unlockWaiters = [];
    }
    isLocked() {
        return this.locked;
    }
    acquire() {
        if (!this.locked) {
            this.locked = true;
            return Promise.resolve(this.makeRelease());
        }
        return new Promise(resolve => {
            this.waiters.push(resolve);
        });
    }
    async runExclusive(callback) {
        const release = await this.acquire();
        try {
            return await callback();
        }
        finally {
            release();
        }
    }
    waitForUnlock() {
        if (!this.locked) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.unlockWaiters.push(resolve);
        });
    }
    makeRelease() {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            const next = this.waiters.shift();
            if (next) {
                // hand the lock straight over — it stays locked, the
                // next waiter in FIFO order owns it now
                next(this.makeRelease());
            }
            else {
                this.locked = false;
                const waiters = this.unlockWaiters;
                this.unlockWaiters = [];
                for (const resolve of waiters) {
                    resolve();
                }
            }
        };
    }
}
//# sourceMappingURL=mutex.js.map