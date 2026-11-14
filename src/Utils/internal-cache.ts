/**
 * AunuBaileys (P9, 2.0.0): the tree's single internal cache, replacing
 * both `@cacheable/node-cache` and `lru-cache`.
 *
 * One class covers both former surfaces:
 * - the CacheStore surface the socket factories use — synchronous
 *   `get`/`set`/`del`/`flushAll`/`close`, plus the extended
 *   `mget`/`mset`/`mdel` the device-list path probes for;
 * - the LRU surface the signal/retry code used — `get`/`set`/`has`/
 *   `delete`/`clear`, per-entry TTL, optional age refresh on get, and
 *   an optional dispose hook fired on eviction, expiry and delete.
 *
 * HB-199 law, now structural instead of wrapped per call site: every
 * cache in the tree is size-capped (a finite default applies when a
 * caller does not state one) and `set()` NEVER throws at the cap —
 * the least-recently-used entry is evicted. There is no maxKeys-style
 * error left to swallow.
 *
 * Numeric config is sanitised at this boundary (guardrail rule): a
 * non-finite or negative TTL disables expiry rather than producing
 * NaN expiry stamps that never fire, and a non-finite cap falls back
 * to the bounded default instead of disabling eviction.
 *
 * `src/Utils/bounded-cache.ts` deliberately stays separate: its one
 * consumer (the placeholder-resend cache, HB-231) relies on reads
 * NEVER extending an entry's life, which is the opposite of this
 * class's LRU touch-on-get — merging the two would change that site's
 * semantics.
 */

export interface InternalCacheOptions<V> {
	/** per-entry time to live in milliseconds; absent = no expiry */
	ttlMs?: number
	/** LRU ceiling; eviction (never an error) past this many entries */
	maxEntries?: number
	/** refresh an entry's expiry when it is read (lru-cache parity) */
	updateAgeOnGet?: boolean
	/** fired when an entry leaves the cache without being overwritten silently */
	dispose?: (value: V, key: string) => void
}

const DEFAULT_MAX_ENTRIES = 10_000

interface CacheEntry<V> {
	value: V
	expiresAt?: number
}

export class InternalCache<V = any> {
	private readonly map = new Map<string, CacheEntry<V>>()
	private readonly ttlMs?: number
	private readonly limit: number
	private readonly updateAgeOnGet: boolean
	private readonly dispose?: (value: V, key: string) => void
	private purgeTimer?: ReturnType<typeof setInterval>

	constructor(options: InternalCacheOptions<V> = {}) {
		this.ttlMs =
			typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs > 0
				? options.ttlMs
				: undefined
		this.limit =
			typeof options.maxEntries === 'number' && Number.isFinite(options.maxEntries)
				? Math.max(0, Math.floor(options.maxEntries))
				: DEFAULT_MAX_ENTRIES
		this.updateAgeOnGet = !!options.updateAgeOnGet
		this.dispose = options.dispose

		if (this.ttlMs !== undefined) {
			// ttlAutopurge parity: expired entries are collected even
			// if nothing reads them again. The timer is unref'd so a
			// cache never keeps a process (or a test) alive.
			const interval = Math.min(this.ttlMs, 60_000)
			this.purgeTimer = setInterval(() => this.purgeExpired(), interval)
			this.purgeTimer.unref?.()
		}
	}

	get size(): number {
		return this.map.size
	}

	get<T = V>(key: string): T | undefined {
		const entry = this.map.get(key)
		if (!entry) {
			return undefined
		}

		if (this.isExpired(entry)) {
			this.delete(key)
			return undefined
		}

		if (this.updateAgeOnGet && this.ttlMs !== undefined) {
			entry.expiresAt = Date.now() + this.ttlMs
		}

		// LRU touch: re-insert so this entry is evicted last
		this.map.delete(key)
		this.map.set(key, entry)
		return entry.value as unknown as T
	}

	/** peek without the LRU touch or the age refresh (lru-cache `has` parity) */
	has(key: string): boolean {
		const entry = this.map.get(key)
		if (!entry) {
			return false
		}

		if (this.isExpired(entry)) {
			this.delete(key)
			return false
		}

		return true
	}

	set<T = V>(key: string, value: T): this {
		// HB-199: a cache write must never throw — least of all at the
		// size cap, where the correct move is to evict, not to error.
		try {
			const existing = this.map.get(key)
			if (existing) {
				this.map.delete(key)
				this.fireDispose(existing.value, key)
			}

			this.map.set(key, {
				value: value as unknown as V,
				expiresAt: this.ttlMs !== undefined ? Date.now() + this.ttlMs : undefined
			})

			while (this.map.size > this.limit) {
				const oldest = this.map.keys().next()
				if (oldest.done) {
					break
				}

				// the iterator's done flag is the real empty signal —
				// a Map can legitimately hold `undefined`-adjacent keys
				// in other implementations; here keys are strings, but
				// keep the HB-226 lesson anyway
				const oldestKey = oldest.value as string
				const evicted = this.map.get(oldestKey)
				this.map.delete(oldestKey)
				if (evicted) {
					this.fireDispose(evicted.value, oldestKey)
				}
			}
		} catch {
			// the cache is an optimisation over an authoritative store;
			// a failed write degrades to 'not cached', never to a throw
		}

		return this
	}

	delete(key: string): boolean {
		const entry = this.map.get(key)
		if (!entry) {
			return false
		}

		this.map.delete(key)
		this.fireDispose(entry.value, key)
		return true
	}

	/** CacheStore spelling of delete */
	del(key: string): boolean {
		return this.delete(key)
	}

	clear(): void {
		for (const [key, entry] of this.map) {
			this.fireDispose(entry.value, key)
		}

		this.map.clear()
	}

	flushAll(): void {
		this.clear()
	}

	/** CacheStore extended surface: bulk read as a record */
	mget<T = V>(keys: string[]): Record<string, T | undefined> {
		const out: Record<string, T | undefined> = {}
		for (const key of keys) {
			out[key] = this.get<T>(key)
		}

		return out
	}

	mset<T = V>(entries: Array<{ key: string; value: T }>): void {
		for (const { key, value } of entries) {
			this.set(key, value)
		}
	}

	mdel(keys: string[]): void {
		for (const key of keys) {
			this.delete(key)
		}
	}

	keys(): string[] {
		return [...this.map.keys()]
	}

	/** stop the purge timer (NodeCache `close` parity); entries are kept */
	close(): void {
		if (this.purgeTimer) {
			clearInterval(this.purgeTimer)
			this.purgeTimer = undefined
		}
	}

	private isExpired(entry: CacheEntry<V>): boolean {
		return entry.expiresAt !== undefined && entry.expiresAt <= Date.now()
	}

	private purgeExpired(): void {
		for (const [key, entry] of this.map) {
			if (this.isExpired(entry)) {
				this.map.delete(key)
				this.fireDispose(entry.value, key)
			}
		}
	}

	private fireDispose(value: V, key: string): void {
		if (!this.dispose) {
			return
		}

		try {
			this.dispose(value, key)
		} catch {
			// a dispose hook must never break the cache operation that
			// triggered it (HB-199 spirit: cache internals do not throw)
		}
	}
}

export interface CacheStoreFactoryOptions<V = any> extends Omit<InternalCacheOptions<V>, 'ttlMs'> {
	/** TTL in seconds — the spelling the socket factories used with NodeCache (`stdTTL`) */
	stdTTL?: number
	ttlSeconds?: number
	ttlMs?: number
}

/**
 * Build an InternalCache from the NodeCache-style options the socket
 * factories used (`stdTTL` in seconds). Every factory cache is capped:
 * callers state `maxEntries` explicitly; the class default applies
 * when they do not.
 */
export const makeCacheStore = <V = any>(options: CacheStoreFactoryOptions<V> = {}): InternalCache<V> => {
	const ttlSeconds = options.ttlSeconds ?? options.stdTTL
	const ttlMs = options.ttlMs ?? (typeof ttlSeconds === 'number' ? ttlSeconds * 1000 : undefined)
	return new InternalCache<V>({
		ttlMs,
		maxEntries: options.maxEntries,
		updateAgeOnGet: options.updateAgeOnGet,
		dispose: options.dispose
	})
}
