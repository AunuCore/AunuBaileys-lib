import { Boom } from '@hapi/boom'
import { AsyncLocalStorage } from 'async_hooks'
import { randomBytes } from 'crypto'
import { DEFAULT_CACHE_TTLS } from '../Defaults'
import type {
	AuthenticationCreds,
	CacheStore,
	SignalDataSet,
	SignalDataTypeMap,
	SignalKeyStore,
	SignalKeyStoreWithTransaction,
	TransactionCapabilityOptions
} from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { makeCacheStore } from './internal-cache'
import { Mutex } from './mutex'
import { SimpleQueue } from './simple-queue'
import { delay, generateRegistrationId } from './generics'
import type { ILogger } from './logger'
import { PreKeyManager } from './pre-key-manager'

/**
 * Transaction context stored in AsyncLocalStorage
 */
interface TransactionContext {
	cache: SignalDataSet
	mutations: SignalDataSet
	dbQueries: number
	// AunuBaileys (2.5.0, HB-473 addendum, run-0990): the store
	// values work() FIRST saw per key (null = read and absent) —
	// the pre-commit snapshot for floating retries is built from
	// this where possible, so it costs no extra I/O.
	readSet: SignalDataSet
}

/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(
	store: SignalKeyStore,
	logger?: ILogger,
	_cache?: CacheStore
): SignalKeyStore & { close(): void } {
	const cache =
		_cache ||
		makeCacheStore<SignalDataTypeMap[keyof SignalDataTypeMap]>({
			stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
			// AunuBaileys (1.0.84, HB-199, re-applied P3b; closed in full
			// by the P9 internal cache): a TTL bounds an entry's AGE, not
			// the entry COUNT — a burst of distinct sender addresses
			// inside the 5-minute window grew this cache without limit.
			// Cap the number of entries as well. The internal cache
			// EVICTS at the cap instead of throwing, so the cap can
			// never break a session operation; the cacheSet wrapper
			// below stays as a guard for caller-supplied caches whose
			// set() may still throw at their own cap.
			maxEntries: 1000
		})

	// Mutex for protecting cache operations
	const cacheMutex = new Mutex()

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}

	// AunuBaileys (1.0.84, HB-199, re-applied P3b): see the cap note
	// above — a full cache must degrade to 'not cached', never to a throw
	// escaping into get()/set(). The built-in cache evicts and cannot
	// throw here; this wrapper still guards caller-supplied caches.
	async function cacheSet(key: string, value: SignalDataTypeMap[keyof SignalDataTypeMap]) {
		try {
			await cache.set(key, value)
		} catch {
			// cache is at its key cap; the store stays authoritative
		}
	}

	return {
		async get(type, ids) {
			return cacheMutex.runExclusive(async () => {
				const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
				const idsToFetch: string[] = []

				for (const id of ids) {
					const item = (await cache.get<SignalDataTypeMap[typeof type]>(getUniqueId(type, id))) as any
					if (typeof item !== 'undefined') {
						data[id] = item
					} else {
						idsToFetch.push(id)
					}
				}

				if (idsToFetch.length) {
					logger?.trace({ items: idsToFetch.length }, 'loading from store')
					const fetched = await store.get(type, idsToFetch)
					for (const id of idsToFetch) {
						const item = fetched[id]
						if (item) {
							data[id] = item
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
await cacheSet(getUniqueId(type, id), item as SignalDataTypeMap[keyof SignalDataTypeMap])
						}
					}
				}

				return data
			})
		},
		async set(data) {
			return cacheMutex.runExclusive(async () => {
				// AunuBaileys (2.1.0, HB-295, donor v6): persist FIRST, then cache — the old order let a failed persist leave the cache claiming unsaved values (up to the 5-minute TTL).
				try {
					await store.set(data)
				} catch (err) {
					// AunuBaileys (2.2.0, HB-295 addendum): a PARTIAL
					// persist (some types written, then a throw) left
					// the cache serving the pre-set values for ALL
					// types — including ones the store had already
					// replaced — breaking the invariant below. Which
					// types landed is unknowable here, so evict every
					// touched key: the next get() re-reads the store
					// and the cache again reflects only what is on
					// disk.
					for (const type in data) {
						for (const id in data[type as keyof SignalDataTypeMap]) {
							try {
								await cache.del(getUniqueId(type, id))
							} catch {
								// eviction is best-effort — the persist error being rethrown is the one that matters
							}
						}
					}

					throw err
				}
				let keys = 0
				for (const type in data) {
					for (const id in data[type as keyof SignalDataTypeMap]) {
await cacheSet(getUniqueId(type, id), data[type as keyof SignalDataTypeMap]![id]!)
						keys += 1
					}
				}

				logger?.trace({ keys }, 'updated cache')
			})
		},
		async clear() {
			await cache.flushAll()
			await store.clear?.()
		},
		// AunuBaileys (2.6.0, HB-346 addendum 1): the wrapper used
		// to expose no close — its InternalCache runs a 60 s purge
		// timer that clear() never touched, so one timer leaked per
		// wrapper for the life of the process. close() stops the
		// timer (entries are kept; get() still enforces expiry on
		// read, so a closed wrapper stays correct, just without
		// autopurge). The socket calls this from end() via the
		// transaction wrapper below.
		close() {
			cache.close?.()
		}
	}
}

/**
 * Adds DB-like transaction capability to the SignalKeyStore
 * Uses AsyncLocalStorage for automatic context management
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (
	state: SignalKeyStore,
	logger: ILogger,
	{ maxCommitRetries, delayBetweenTriesMs }: Partial<TransactionCapabilityOptions> = {}
): SignalKeyStoreWithTransaction & { disposeTransactionStorage: () => void; close?: () => void } => {
	// AunuBaileys (2.1.0, HB-104 addendum + HB-333, donor v6 1.0.89): sanitise the retry budget at the boundary — a NaN/0/negative maxCommitRetries (classically Number('') from env) made commitWithRetry run ZERO attempts and silently drop the transaction's mutations, and Infinity wedged the transaction mutex forever on a failing store. Retries clamp to 1..10; a non-finite or negative delay falls back to the default.
	const commitRetries =
		typeof maxCommitRetries === 'number' && Number.isFinite(maxCommitRetries)
			? Math.min(10, Math.max(1, Math.floor(maxCommitRetries)))
			: 10
	const commitDelayMs =
		typeof delayBetweenTriesMs === 'number' && Number.isFinite(delayBetweenTriesMs) && delayBetweenTriesMs >= 0
			? delayBetweenTriesMs
			: 3000
	const txStorage = new AsyncLocalStorage<TransactionContext>()
	// AunuBaileys (2.3.0, HB-401): set by disposeTransactionStorage()
	// so the release below runs at most once per store.
	let txStorageDisposed = false

	// Queues for concurrency control (keyed by signal data type - bounded set)
	const keyQueues = new Map<string, SimpleQueue>()

	// Transaction mutexes with reference counting for cleanup
	const txMutexes = new Map<string, Mutex>()
	const txMutexRefCounts = new Map<string, number>()

	// Pre-key manager for specialized operations
	const preKeyManager = new PreKeyManager(state, logger)

	// AunuBaileys (1.0.73, HB-94, re-applied P3b): write
	// serialisation between bare sets, transaction commits and
	// in-flight transactions. v6 held ONE transaction mutex and
	// routed bare writes through it, so a bare set landed either
	// fully before or fully after any transaction; v7's keyed
	// transactions dropped that guarantee — a bare set (or a
	// commit) could write straight through while another
	// transaction was mid-flight, so a migrateSession commit could
	// overwrite a fresher session record stored by an in-flight
	// decrypt (the record's ratchet then regressed by one
	// message). Bare sets now wait until no transaction is in
	// flight, and all writes to the underlying store (bare sets
	// and commits alike) pass through the single writeMutex so
	// they can never interleave. Sets issued from inside a
	// transaction never reach the bare branch (they join the
	// transaction context), so there is no re-entrant lock.
	let activeTransactions = 0
	let txIdleWaiters: (() => void)[] = []
	const writeMutex = new Mutex()

	const notifyTxIdle = () => {
		if (activeTransactions === 0 && txIdleWaiters.length) {
			const waiters = txIdleWaiters
			txIdleWaiters = []
			for (const resolve of waiters) {
				resolve()
			}
		}
	}

	const waitForNoActiveTransactions = async () => {
		while (activeTransactions > 0) {
			await new Promise<void>(resolve => {
				txIdleWaiters.push(resolve)
			})
		}
	}

	/**
	 * Get or create a queue for a specific key type
	 */
	function getQueue(key: string): SimpleQueue {
		if (!keyQueues.has(key)) {
			keyQueues.set(key, new SimpleQueue({ concurrency: 1 }))
		}

		return keyQueues.get(key)!
	}

	/**
	 * Get or create a transaction mutex
	 */
	function getTxMutex(key: string): Mutex {
		if (!txMutexes.has(key)) {
			txMutexes.set(key, new Mutex())
			txMutexRefCounts.set(key, 0)
		}

		return txMutexes.get(key)!
	}

	/**
	 * Acquire a reference to a transaction mutex
	 */
	function acquireTxMutexRef(key: string): void {
		const count = txMutexRefCounts.get(key) ?? 0
		txMutexRefCounts.set(key, count + 1)
	}

	/**
	 * Release a reference to a transaction mutex and cleanup if no longer needed
	 */
	function releaseTxMutexRef(key: string): void {
		const count = (txMutexRefCounts.get(key) ?? 1) - 1
		txMutexRefCounts.set(key, count)

		// Cleanup if no more references and mutex is not locked
		if (count <= 0) {
			const mutex = txMutexes.get(key)
			if (mutex && !mutex.isLocked()) {
				txMutexes.delete(key)
				txMutexRefCounts.delete(key)
			}
		}
	}

	/**
	 * Check if currently in a transaction
	 */
	function isInTransaction(): boolean {
		return !!txStorage.getStore()
	}

	// AunuBaileys (2.4.0, HB-438): a commit error that can never succeed
	// on a retry (permission / read-only fs / invalid argument / full
	// disk, a validation TypeError/RangeError/SyntaxError, or a Boom
	// 4xx other than 408/429) must fail fast — retrying it the full
	// budget froze every bare keys.set() behind the transaction for
	// ~27 s (10 x 3000 ms) per failed transaction. Anything else is
	// treated as transient and keeps the retry behaviour.
	const PERMANENT_COMMIT_CODES = new Set([
		'EACCES',
		'EPERM',
		'EROFS',
		'EINVAL',
		'ENOTDIR',
		'EISDIR',
		'ENOSPC',
		'EFBIG',
		'EDQUOT',
		'ENAMETOOLONG'
	])
	const isPermanentCommitError = (error: unknown): boolean => {
		if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
			return true
		}

		if (!error || typeof error !== 'object') {
			return false
		}

		const code = (error as { code?: unknown }).code
		if (typeof code === 'string' && PERMANENT_COMMIT_CODES.has(code)) {
			return true
		}

		const statusCode =
			(error as { output?: { statusCode?: unknown } }).output?.statusCode ??
			(error as { statusCode?: unknown }).statusCode
		return (
			typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429
		)
	}

	/**
	 * Canonical string form of a stored value, for equality
	 * checks only. Object keys are sorted (a value re-read from
	 * the store must compare equal to the in-memory value even
	 * when key order differs); binary values compare by bytes.
	 * Throws on cyclic values — callers treat that as
	 * "different" (the safe direction: abort the retry, never
	 * overwrite).
	 */
	const canonicaliseValue = (value: unknown, seen: Set<object>): string => {
		if (value === undefined) return 'u'
		// AunuBaileys (2.8.0, HB-493): null and undefined are both
		// "absent" markers — the transaction read-set records null,
		// the pre-commit snapshot leaves the key absent (undefined),
		// and the multi-file store returns null for a missing file.
		// Distinguishing them made the freshness check report a
		// read-absent-then-write transaction as stale on an
		// unchanged store.
		if (value === null) return 'u'
		if (typeof value === 'boolean') return value ? 't' : 'f'
		if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : `num:${value}`
		if (typeof value === 'bigint') return `big:${value.toString()}`
		if (typeof value === 'string') return `str:${JSON.stringify(value)}`
		if (value instanceof Uint8Array) return `bin:${Buffer.from(value).toString('base64')}`
		if (value instanceof Date) return `date:${value.getTime()}`
		if (Array.isArray(value)) {
			if (seen.has(value)) throw new Error('cyclic value in stored data')
			seen.add(value)
			try {
				return `arr:[${value.map(item => canonicaliseValue(item, seen)).join(',')}]`
			} finally {
				seen.delete(value)
			}
		}

		if (typeof value === 'object') {
			if (seen.has(value)) throw new Error('cyclic value in stored data')
			seen.add(value)
			try {
				const keys = Object.keys(value).sort()
				return `obj:{${keys
					.map(key => `${JSON.stringify(key)}:${canonicaliseValue((value as Record<string, unknown>)[key], seen)}`)
					.join(',')}}`
			} finally {
				seen.delete(value)
			}
		}

		return `other:${String(value)}`
	}

	const valuesEqual = (a: unknown, b: unknown): boolean => {
		try {
			return canonicaliseValue(a, new Set()) === canonicaliseValue(b, new Set())
		} catch {
			return false
		}
	}

	/**
	 * Snapshot the store values a transaction's mutations were
	 * computed from, taken AFTER work() and BEFORE the first
	 * commit attempt (a failed attempt may have partially
	 * written, which would contaminate the snapshot with our own
	 * values). Keys work() read come from the transaction's
	 * read-set (free — no extra I/O); blind-written keys are
	 * read from the store under the write mutex, so the snapshot
	 * is a consistent cut no commit or bare set can land inside.
	 * Absent keys stay absent from the snapshot.
	 */
	async function buildPreCommitSnapshot(mutations: SignalDataSet, readSet: SignalDataSet): Promise<SignalDataSet> {
		const snapshot: SignalDataSet = {}
		const toFetch: { [type: string]: string[] } = {}
		for (const type_ of Object.keys(mutations)) {
			const type = type_ as keyof SignalDataTypeMap
			const ids = Object.keys(mutations[type]!)
			snapshot[type] = ({} as any)
			for (const id of ids) {
				const read = readSet[type]?.[id]
				if (read === undefined) {
					// Blind-written key: work() never read it.
					;(toFetch[type_] ??= []).push(id)
				} else if (read !== null) {
					snapshot[type]![id] = read
				}
				// read === null means work() read the key and it
				// was absent — leave it absent in the snapshot.
			}
		}

		if (Object.keys(toFetch).length > 0) {
			await writeMutex.runExclusive(async () => {
				for (const type_ of Object.keys(toFetch)) {
					const type = type_ as keyof SignalDataTypeMap
					const fetched = await state.get(type, toFetch[type_]!)
					Object.assign(snapshot[type]!, fetched)
				}
			})
		}

		return snapshot
	}

	/**
	 * One floating retry attempt. The freshness re-read and the
	 * write run atomically under the write mutex, so no other
	 * commit or bare set can land between the check and the
	 * write (a gap there would reopen the same stale-overwrite
	 * hole one transaction later). A key is fresh when its
	 * current value matches EITHER its pre-commit value (nobody
	 * touched it) OR the value we are about to write (our own
	 * partial write from the failed attempt — rewriting it is
	 * idempotent). Anything else means a fresher foreign commit
	 * moved the key: the attempt is 'stale' and the caller must
	 * abort the retry instead of overwriting it.
	 */
	async function attemptFloatingCommit(
		mutations: SignalDataSet,
		preCommit: SignalDataSet
	): Promise<{ status: 'committed' } | { status: 'stale'; keys: string[] }> {
		return writeMutex.runExclusive(async () => {
			const staleKeys: string[] = []
			for (const type_ of Object.keys(mutations)) {
				const type = type_ as keyof SignalDataTypeMap
				const ids = Object.keys(mutations[type]!)
				if (ids.length === 0) continue
				const current = await state.get(type, ids)
				for (const id of ids) {
					const cur = current[id]
					const pre = preCommit[type]?.[id]
					const wantRaw = mutations[type]![id]
					const want = wantRaw === null ? undefined : wantRaw
					if (!valuesEqual(cur, pre) && !valuesEqual(cur, want)) {
						staleKeys.push(`${type_}:${id}`)
					}
				}
			}

			if (staleKeys.length > 0) {
				return { status: 'stale', keys: staleKeys }
			}

			await state.set(mutations)
			return { status: 'committed' }
		})
	}

	/**
	 * One commit attempt. HB-94 (re-applied P3b): commits pass
	 * through the shared write mutex — see the note at writeMutex.
	 * The retry policy lives in transaction() below.
	 */
	async function attemptCommit(mutations: SignalDataSet): Promise<void> {
		await writeMutex.runExclusive(async () => {
			await state.set(mutations)
		})
		logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction')
	}

	return {
		get: async (type, ids) => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct read without exclusive lock for concurrency
				return state.get(type, ids)
			}

			// In transaction - check cache first
			const cached = ctx.cache[type] || {}
			const missing = ids.filter(id => !(id in cached))

			if (missing.length > 0) {
				ctx.dbQueries++
				logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction')

				// AunuBaileys (2.4.0, HB-429): the read path uses a
				// namespaced mutex key (`get:<type>`), separate from
				// transaction keys (`tx:<key>` below) — one shared map
				// used to let a transaction whose key equals a signal
				// data type name ('session', 'pre-key', ...) deadlock
				// forever on its own non-reentrant mutex when work()
				// called get() for that same type.
				const fetched = await getTxMutex(`get:${type}`).runExclusive(() => state.get(type, missing))

				// Update cache
				ctx.cache[type] = ctx.cache[type] || ({} as any)
				Object.assign(ctx.cache[type]!, fetched)

				// AunuBaileys (2.5.0, HB-473 addendum, run-0990):
				// record the store values work() FIRST saw for
				// these keys — including absence (null) — so a
				// floating commit retry can tell a fresher foreign
				// commit apart from our own partial write. Only
				// first-seen values are recorded: a later set()
				// in this transaction overwrites the cache with
				// our own new value, which must never pose as the
				// pre-commit value.
				ctx.readSet[type] = ctx.readSet[type] || ({} as any)
				const readSetDict = ctx.readSet[type]!
				for (const id of missing) {
					if (!(id in readSetDict)) {
						const value = fetched[id]
						readSetDict[id] = value === undefined || value === null ? null : value
					}
				}
			}

			// Return requested ids from cache
			const result: { [key: string]: any } = {}
			for (const id of ids) {
				const value = ctx.cache[type]?.[id]
				if (value !== undefined && value !== null) {
					result[id] = value
				}
			}

			return result
		},

		set: async data => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct write with queue protection
				const writeBare = async () => {
					const types = Object.keys(data)

					// Process pre-keys with validation
					for (const type_ of types) {
						const type = type_ as keyof SignalDataTypeMap
						if (type === 'pre-key') {
							await preKeyManager.validateDeletions(data, type)
						}
					}

					// Write all data in parallel
					await Promise.all(
						types.map(type =>
							getQueue(type).add(async () => {
								const typeData = { [type]: data[type as keyof SignalDataTypeMap] } as SignalDataSet
								await state.set(typeData)
							})
						)
					)
				}

				// HB-94 (re-applied P3b): land this write in a gap
				// with no transaction in flight, under the shared
				// write mutex — fully before or fully after any
				// transaction, never interleaved with one. If a
				// transaction starts in the gap between the wait
				// and the mutex, step aside and wait again.
				for (;;) {
					await waitForNoActiveTransactions()
					const wrote = await writeMutex.runExclusive(async () => {
						if (activeTransactions > 0) {
							return false
						}

						await writeBare()
						return true
					})
					if (wrote) {
						break
					}
				}

				return
			}

			// In transaction - update cache and mutations
			logger.trace({ types: Object.keys(data) }, 'caching in transaction')

			for (const key_ in data) {
				const key = key_ as keyof SignalDataTypeMap

				// Ensure structures exist
				ctx.cache[key] = ctx.cache[key] || ({} as any)
				ctx.mutations[key] = ctx.mutations[key] || ({} as any)

				// Special handling for pre-keys
				if (key === 'pre-key') {
					await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
				} else {
					// Normal key types
					Object.assign(ctx.cache[key]!, data[key])
					Object.assign(ctx.mutations[key]!, data[key])
				}
			}
		},

		isInTransaction,

		// AunuBaileys (2.3.0, HB-401, pola upstream PR #2911):
		// an AsyncLocalStorage that has been enabled by run() stays
		// in Node's process-wide list of enabled storages, taxing
		// EVERY async resource created afterwards — and this store
		// is created per socket, so a long-lived multi-session host
		// accumulated one permanent entry per socket ever opened.
		// Nothing ever released it. disable() exits the storage's
		// contexts and drops it from that list. The socket calls
		// this from end(), when the store's lifecycle is over: the
		// storage is per-addTransactionCapability-call, so a
		// reconnect (a fresh wrapper around the same auth state)
		// gets a fresh storage and is unaffected; a transaction
		// still in flight at teardown commits from its own context
		// object, not via getStore(), so its commit still lands;
		// and disable() is idempotent here via the flag (a stray
		// later run() would simply re-enable the storage and keep
		// working, never corrupt).
		disposeTransactionStorage: () => {
			if (txStorageDisposed) {
				return
			}

			txStorageDisposed = true
			txStorage.disable()
		},

		// AunuBaileys (2.6.0, HB-346 addendum 1): forward close to
		// the wrapped store, so a cacheable wrapper's purge timer
		// (see makeCacheableSignalKeyStore above) is reachable —
		// and stopped on socket end — through this per-socket
		// wrapper. A plain store has no close; the call is a no-op
		// for it. Closing only stops the timer: entries are kept
		// and get() still enforces expiry on read.
		close: () => {
			;(state as SignalKeyStore & { close?: () => void }).close?.()
		},

		transaction: async (work, key) => {
			const existing = txStorage.getStore()

			// Nested transaction - reuse existing context
			if (existing) {
				logger.trace('reusing existing transaction context')
				// AunuBaileys (1.0.79, HB-236, re-applied P3b): a nested frame SHARES
				// this context's cache/mutations — snapshot both on entry. If the
				// nested work throws, restore the snapshot before the error
				// propagates: without it, an outer frame that catches the throw
				// would commit the inner frame's partial writes as if nothing had
				// failed — the only 'rollback' was a throw escaping the OUTERMOST
				// frame.
				const snapshot = {
					cache: Object.fromEntries(Object.entries(existing.cache).map(([type, dict]) => [type, { ...(dict as object) }])),
					mutations: Object.fromEntries(Object.entries(existing.mutations).map(([type, dict]) => [type, { ...(dict as object) }]))
				}
				try {
					return await work()
				} catch (error) {
					existing.cache = snapshot.cache as typeof existing.cache
					existing.mutations = snapshot.mutations as typeof existing.mutations
					throw error
				}
			}

			// New transaction - acquire mutex and create context
			// AunuBaileys (2.4.0, HB-429): transaction mutexes live in
			// the `tx:` namespace, disjoint from the `get:` read
			// namespace above — see the note there.
			const mutexKey = `tx:${key}`
			const mutex = getTxMutex(mutexKey)
			acquireTxMutexRef(mutexKey)
			// HB-94 (re-applied P3b): bare sets wait on this
			// counter — see the note at writeMutex.
			activeTransactions += 1

			let outcome: { result: Awaited<ReturnType<typeof work>>; mutations: SignalDataSet; dbQueries: number }
			// AunuBaileys (2.4.0, HB-473 × HB-94 addendum run-0590):
			// the FIRST commit attempt runs while the per-key mutex
			// is still held, exactly as before HB-473 — a competing
			// same-key transaction whose work() READS the store
			// (e.g. a group decrypt loading a sender key) must not
			// observe pre-commit state and commit its stale copy
			// back over this transaction's write; that interleave
			// is what resurrected deleted sender keys in run-0590.
			// Only a FAILED first attempt floats: the mutex is
			// released for the inter-try delays (HB-473's liveness
			// fix — same-key transactions are no longer stalled
			// for the whole retry budget on a failing store) and
			// re-acquired around each later attempt, which is the
			// second candidate the HB-473 entry itself records.
			// HB-438's permanent-error classification applies at
			// every attempt.
			let commitError: unknown
			let committed = false
			// AunuBaileys (2.5.0, HB-473 addendum, run-0990): the
			// pre-commit snapshot, taken before the first attempt
			// (see below) — the floating retry checks freshness
			// against it.
			let preCommit: SignalDataSet | undefined
			try {
				try {
					const releaseMutex = await mutex.acquire()
					try {
						const ctx: TransactionContext = {
							cache: {},
							mutations: {},
							dbQueries: 0,
							readSet: {}
						}

						logger.trace('entering transaction')

						let result: Awaited<ReturnType<typeof work>>
						try {
							result = await txStorage.run(ctx, work)
						} catch (error) {
							logger.error({ error }, 'transaction failed, rolling back')
							throw error
						}

						outcome = { result, mutations: ctx.mutations, dbQueries: ctx.dbQueries }

						if (Object.keys(ctx.mutations).length === 0) {
							logger.trace('no mutations in transaction')
							committed = true
						} else {
							logger.trace('committing transaction')
							// AunuBaileys (2.5.0, HB-473 addendum,
							// run-0990): snapshot what the mutations
							// were computed from BEFORE the first
							// attempt — a failed attempt may have
							// partially written, and the snapshot is
							// what the floating retry checks
							// freshness against.
							preCommit = await buildPreCommitSnapshot(ctx.mutations, ctx.readSet)
							try {
								await attemptCommit(ctx.mutations)
								committed = true
							} catch (error) {
								if (isPermanentCommitError(error) || commitRetries <= 1) {
									throw error
								}

								commitError = error
							}
						}
					} finally {
						releaseMutex()
					}
				} finally {
					// HB-94 (re-applied P3b): see activeTransactions.
					activeTransactions -= 1
					notifyTxIdle()
				}

				if (!committed) {
					// Floating retries: the per-key mutex is free
					// between attempts (other transactions for this
					// key can work) and re-acquired per attempt, so
					// each actual write still serialises against
					// same-key work. The mutex refcount is held for
					// the whole loop (released in the outer finally),
					// so re-acquiring always lands on this same Mutex
					// instance.
					// AunuBaileys (2.5.0, HB-473 addendum, run-0990):
					// each floating attempt first checks the
					// mutations are still fresh against the
					// pre-commit snapshot — a fresher foreign commit
					// for the same keys aborts the retry instead of
					// being overwritten with stale data. The abort
					// throws the ORIGINAL commit error: the caller
					// sees a failed transaction (recoverable via
					// retry receipt), never a silent regression.
					// Holding the mutex for the whole loop is NOT
					// an alternative — that revives HB-473.
					let lastError = commitError
					let staleKeys: string[] | undefined
					for (let attempt = 1; attempt < commitRetries; attempt++) {
						logger.warn(`failed to commit mutations, retries left=${commitRetries - attempt}`)
						await delay(commitDelayMs)
						const releaseRetry = await mutex.acquire()
						try {
							// preCommit is set whenever the floating
							// loop runs: the loop is only entered
							// with non-empty mutations whose first
							// attempt failed, and the snapshot is
							// taken before that attempt.
							const result = await attemptFloatingCommit(outcome.mutations, preCommit!)
							if (result.status === 'stale') {
								staleKeys = result.keys
								break
							}

							committed = true
						} catch (error) {
							lastError = error
							if (isPermanentCommitError(error)) {
								throw error
							}
						} finally {
							releaseRetry()
						}

						if (committed) {
							break
						}
					}

					if (staleKeys) {
						logger.warn({ staleKeys }, 'floating commit retry aborted: store changed since this transaction read it')
					}

					if (!committed) {
						logger.warn('failed to commit mutations, retries left=0')
						throw lastError
					}
				}
			} finally {
				releaseTxMutexRef(mutexKey)
			}

			logger.trace({ dbQueries: outcome.dbQueries }, 'transaction completed')

			return outcome.result
		}
	}
}

/**
 * Returns the authenticated user's JID, or throws a Boom-401 if creds are not yet authenticated.
 * Use this anywhere we'd otherwise reach for `creds.me!.id` to fail fast with a descriptive error.
 */
export const assertMeId = (creds: AuthenticationCreds): string => {
	const id = creds.me?.id
	if (!id) {
		throw new Boom('Cannot proceed: socket is not authenticated yet (creds.me.id is missing)', { statusCode: 401 })
	}

	return id
}

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined,
		additionalData: undefined
	}
}
