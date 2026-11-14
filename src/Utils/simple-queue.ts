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
	concurrency?: number
}

type QueuedTask<T> = {
	fn: () => Promise<T> | T
	resolve: (value: T) => void
	reject: (err: unknown) => void
}

export class SimpleQueue {
	private readonly concurrency: number
	private readonly queue: Array<QueuedTask<any>> = []
	private activeCount = 0
	private idleWaiters: Array<() => void> = []

	constructor(options: SimpleQueueOptions = {}) {
		const raw = options.concurrency
		this.concurrency = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
	}

	/** number of tasks waiting to start */
	get size(): number {
		return this.queue.length
	}

	/** number of tasks currently running */
	get pending(): number {
		return this.activeCount
	}

	add<T>(fn: () => Promise<T> | T): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({ fn, resolve, reject })
			this.pump()
		})
	}

	onIdle(): Promise<void> {
		if (this.queue.length === 0 && this.activeCount === 0) {
			return Promise.resolve()
		}

		return new Promise<void>(resolve => {
			this.idleWaiters.push(resolve)
		})
	}

	clear(): void {
		// queued tasks are dropped without running; p-queue's clear()
		// leaves their promises pending forever, so mirror the only
		// safe reading of that: reject them instead of leaking a
		// promise no caller can ever observe settle. No in-tree
		// consumer calls clear(), so this never fires in practice.
		const dropped = this.queue.splice(0, this.queue.length)
		for (const task of dropped) {
			task.reject(new Error('queue cleared'))
		}
	}

	private pump(): void {
		while (this.activeCount < this.concurrency && this.queue.length > 0) {
			const task = this.queue.shift()!
			this.activeCount++
			;(async () => {
				try {
					task.resolve(await task.fn())
				} catch (err) {
					task.reject(err)
				} finally {
					this.activeCount--
					this.pump()
					if (this.queue.length === 0 && this.activeCount === 0 && this.idleWaiters.length) {
						const waiters = this.idleWaiters
						this.idleWaiters = []
						for (const resolve of waiters) {
							resolve()
						}
					}
				}
			})()
		}
	}
}

export default SimpleQueue
