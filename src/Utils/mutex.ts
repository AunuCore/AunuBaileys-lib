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
export type ReleaseFunction = () => void

export class Mutex {
	private locked = false
	private waiters: Array<(release: ReleaseFunction) => void> = []
	private unlockWaiters: Array<() => void> = []

	isLocked(): boolean {
		return this.locked
	}

	acquire(): Promise<ReleaseFunction> {
		if (!this.locked) {
			this.locked = true
			return Promise.resolve(this.makeRelease())
		}

		return new Promise<ReleaseFunction>(resolve => {
			this.waiters.push(resolve)
		})
	}

	async runExclusive<T>(callback: () => Promise<T> | T): Promise<T> {
		const release = await this.acquire()
		try {
			return await callback()
		} finally {
			release()
		}
	}

	waitForUnlock(): Promise<void> {
		if (!this.locked) {
			return Promise.resolve()
		}

		return new Promise<void>(resolve => {
			this.unlockWaiters.push(resolve)
		})
	}

	private makeRelease(): ReleaseFunction {
		let released = false
		return () => {
			if (released) {
				return
			}

			released = true
			const next = this.waiters.shift()
			if (next) {
				// hand the lock straight over — it stays locked, the
				// next waiter in FIFO order owns it now
				next(this.makeRelease())
			} else {
				this.locked = false
				const waiters = this.unlockWaiters
				this.unlockWaiters = []
				for (const resolve of waiters) {
					resolve()
				}
			}
		}
	}
}
