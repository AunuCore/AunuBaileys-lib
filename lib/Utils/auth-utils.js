import { Boom } from '@hapi/boom';
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import { DEFAULT_CACHE_TTLS } from '../Defaults/index.js';
import { Curve, signedKeyPair } from './crypto.js';
import { makeCacheStore } from './internal-cache.js';
import { Mutex } from './mutex.js';
import { SimpleQueue } from './simple-queue.js';
import { delay, generateRegistrationId } from './generics.js';
import { PreKeyManager } from './pre-key-manager.js';
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache ||
        makeCacheStore({
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
        });
    // Mutex for protecting cache operations
    const cacheMutex = new Mutex();
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    // AunuBaileys (1.0.84, HB-199, re-applied P3b): see the cap note
    // above — a full cache must degrade to 'not cached', never to a throw
    // escaping into get()/set(). The built-in cache evicts and cannot
    // throw here; this wrapper still guards caller-supplied caches.
    async function cacheSet(key, value) {
        try {
            await cache.set(key, value);
        }
        catch {
            // cache is at its key cap; the store stays authoritative
        }
    }
    return {
        async get(type, ids) {
            return cacheMutex.runExclusive(async () => {
                const data = {};
                const idsToFetch = [];
                for (const id of ids) {
                    const item = (await cache.get(getUniqueId(type, id)));
                    if (typeof item !== 'undefined') {
                        data[id] = item;
                    }
                    else {
                        idsToFetch.push(id);
                    }
                }
                if (idsToFetch.length) {
                    logger?.trace({ items: idsToFetch.length }, 'loading from store');
                    const fetched = await store.get(type, idsToFetch);
                    for (const id of idsToFetch) {
                        const item = fetched[id];
                        if (item) {
                            data[id] = item;
                            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                            await cacheSet(getUniqueId(type, id), item);
                        }
                    }
                }
                return data;
            });
        },
        async set(data) {
            return cacheMutex.runExclusive(async () => {
                // AunuBaileys (2.1.0, HB-295, donor v6): persist FIRST, then cache — the old order let a failed persist leave the cache claiming unsaved values (up to the 5-minute TTL).
                try {
                    await store.set(data);
                }
                catch (err) {
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
                        for (const id in data[type]) {
                            try {
                                await cache.del(getUniqueId(type, id));
                            }
                            catch {
                                // eviction is best-effort — the persist error being rethrown is the one that matters
                            }
                        }
                    }
                    throw err;
                }
                let keys = 0;
                for (const type in data) {
                    for (const id in data[type]) {
                        await cacheSet(getUniqueId(type, id), data[type][id]);
                        keys += 1;
                    }
                }
                logger?.trace({ keys }, 'updated cache');
            });
        },
        async clear() {
            await cache.flushAll();
            await store.clear?.();
        }
    };
}
/**
 * Adds DB-like transaction capability to the SignalKeyStore
 * Uses AsyncLocalStorage for automatic context management
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs } = {}) => {
    // AunuBaileys (2.1.0, HB-104 addendum + HB-333, donor v6 1.0.89): sanitise the retry budget at the boundary — a NaN/0/negative maxCommitRetries (classically Number('') from env) made commitWithRetry run ZERO attempts and silently drop the transaction's mutations, and Infinity wedged the transaction mutex forever on a failing store. Retries clamp to 1..10; a non-finite or negative delay falls back to the default.
    const commitRetries = typeof maxCommitRetries === 'number' && Number.isFinite(maxCommitRetries)
        ? Math.min(10, Math.max(1, Math.floor(maxCommitRetries)))
        : 10;
    const commitDelayMs = typeof delayBetweenTriesMs === 'number' && Number.isFinite(delayBetweenTriesMs) && delayBetweenTriesMs >= 0
        ? delayBetweenTriesMs
        : 3000;
    const txStorage = new AsyncLocalStorage();
    // AunuBaileys (2.3.0, HB-401): set by disposeTransactionStorage()
    // so the release below runs at most once per store.
    let txStorageDisposed = false;
    // Queues for concurrency control (keyed by signal data type - bounded set)
    const keyQueues = new Map();
    // Transaction mutexes with reference counting for cleanup
    const txMutexes = new Map();
    const txMutexRefCounts = new Map();
    // Pre-key manager for specialized operations
    const preKeyManager = new PreKeyManager(state, logger);
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
    let activeTransactions = 0;
    let txIdleWaiters = [];
    const writeMutex = new Mutex();
    const notifyTxIdle = () => {
        if (activeTransactions === 0 && txIdleWaiters.length) {
            const waiters = txIdleWaiters;
            txIdleWaiters = [];
            for (const resolve of waiters) {
                resolve();
            }
        }
    };
    const waitForNoActiveTransactions = async () => {
        while (activeTransactions > 0) {
            await new Promise(resolve => {
                txIdleWaiters.push(resolve);
            });
        }
    };
    /**
     * Get or create a queue for a specific key type
     */
    function getQueue(key) {
        if (!keyQueues.has(key)) {
            keyQueues.set(key, new SimpleQueue({ concurrency: 1 }));
        }
        return keyQueues.get(key);
    }
    /**
     * Get or create a transaction mutex
     */
    function getTxMutex(key) {
        if (!txMutexes.has(key)) {
            txMutexes.set(key, new Mutex());
            txMutexRefCounts.set(key, 0);
        }
        return txMutexes.get(key);
    }
    /**
     * Acquire a reference to a transaction mutex
     */
    function acquireTxMutexRef(key) {
        const count = txMutexRefCounts.get(key) ?? 0;
        txMutexRefCounts.set(key, count + 1);
    }
    /**
     * Release a reference to a transaction mutex and cleanup if no longer needed
     */
    function releaseTxMutexRef(key) {
        const count = (txMutexRefCounts.get(key) ?? 1) - 1;
        txMutexRefCounts.set(key, count);
        // Cleanup if no more references and mutex is not locked
        if (count <= 0) {
            const mutex = txMutexes.get(key);
            if (mutex && !mutex.isLocked()) {
                txMutexes.delete(key);
                txMutexRefCounts.delete(key);
            }
        }
    }
    /**
     * Check if currently in a transaction
     */
    function isInTransaction() {
        return !!txStorage.getStore();
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
    ]);
    const isPermanentCommitError = (error) => {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
            return true;
        }
        if (!error || typeof error !== 'object') {
            return false;
        }
        const code = error.code;
        if (typeof code === 'string' && PERMANENT_COMMIT_CODES.has(code)) {
            return true;
        }
        const statusCode = error.output?.statusCode ??
            error.statusCode;
        return (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429);
    };
    /**
     * One commit attempt. HB-94 (re-applied P3b): commits pass
     * through the shared write mutex — see the note at writeMutex.
     * The retry policy lives in transaction() below.
     */
    async function attemptCommit(mutations) {
        await writeMutex.runExclusive(async () => {
            await state.set(mutations);
        });
        logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction');
    }
    return {
        get: async (type, ids) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                // No transaction - direct read without exclusive lock for concurrency
                return state.get(type, ids);
            }
            // In transaction - check cache first
            const cached = ctx.cache[type] || {};
            const missing = ids.filter(id => !(id in cached));
            if (missing.length > 0) {
                ctx.dbQueries++;
                logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction');
                // AunuBaileys (2.4.0, HB-429): the read path uses a
                // namespaced mutex key (`get:<type>`), separate from
                // transaction keys (`tx:<key>` below) — one shared map
                // used to let a transaction whose key equals a signal
                // data type name ('session', 'pre-key', ...) deadlock
                // forever on its own non-reentrant mutex when work()
                // called get() for that same type.
                const fetched = await getTxMutex(`get:${type}`).runExclusive(() => state.get(type, missing));
                // Update cache
                ctx.cache[type] = ctx.cache[type] || {};
                Object.assign(ctx.cache[type], fetched);
            }
            // Return requested ids from cache
            const result = {};
            for (const id of ids) {
                const value = ctx.cache[type]?.[id];
                if (value !== undefined && value !== null) {
                    result[id] = value;
                }
            }
            return result;
        },
        set: async (data) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                // No transaction - direct write with queue protection
                const writeBare = async () => {
                    const types = Object.keys(data);
                    // Process pre-keys with validation
                    for (const type_ of types) {
                        const type = type_;
                        if (type === 'pre-key') {
                            await preKeyManager.validateDeletions(data, type);
                        }
                    }
                    // Write all data in parallel
                    await Promise.all(types.map(type => getQueue(type).add(async () => {
                        const typeData = { [type]: data[type] };
                        await state.set(typeData);
                    })));
                };
                // HB-94 (re-applied P3b): land this write in a gap
                // with no transaction in flight, under the shared
                // write mutex — fully before or fully after any
                // transaction, never interleaved with one. If a
                // transaction starts in the gap between the wait
                // and the mutex, step aside and wait again.
                for (;;) {
                    await waitForNoActiveTransactions();
                    const wrote = await writeMutex.runExclusive(async () => {
                        if (activeTransactions > 0) {
                            return false;
                        }
                        await writeBare();
                        return true;
                    });
                    if (wrote) {
                        break;
                    }
                }
                return;
            }
            // In transaction - update cache and mutations
            logger.trace({ types: Object.keys(data) }, 'caching in transaction');
            for (const key_ in data) {
                const key = key_;
                // Ensure structures exist
                ctx.cache[key] = ctx.cache[key] || {};
                ctx.mutations[key] = ctx.mutations[key] || {};
                // Special handling for pre-keys
                if (key === 'pre-key') {
                    await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true);
                }
                else {
                    // Normal key types
                    Object.assign(ctx.cache[key], data[key]);
                    Object.assign(ctx.mutations[key], data[key]);
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
                return;
            }
            txStorageDisposed = true;
            txStorage.disable();
        },
        transaction: async (work, key) => {
            const existing = txStorage.getStore();
            // Nested transaction - reuse existing context
            if (existing) {
                logger.trace('reusing existing transaction context');
                // AunuBaileys (1.0.79, HB-236, re-applied P3b): a nested frame SHARES
                // this context's cache/mutations — snapshot both on entry. If the
                // nested work throws, restore the snapshot before the error
                // propagates: without it, an outer frame that catches the throw
                // would commit the inner frame's partial writes as if nothing had
                // failed — the only 'rollback' was a throw escaping the OUTERMOST
                // frame.
                const snapshot = {
                    cache: Object.fromEntries(Object.entries(existing.cache).map(([type, dict]) => [type, { ...dict }])),
                    mutations: Object.fromEntries(Object.entries(existing.mutations).map(([type, dict]) => [type, { ...dict }]))
                };
                try {
                    return await work();
                }
                catch (error) {
                    existing.cache = snapshot.cache;
                    existing.mutations = snapshot.mutations;
                    throw error;
                }
            }
            // New transaction - acquire mutex and create context
            // AunuBaileys (2.4.0, HB-429): transaction mutexes live in
            // the `tx:` namespace, disjoint from the `get:` read
            // namespace above — see the note there.
            const mutexKey = `tx:${key}`;
            const mutex = getTxMutex(mutexKey);
            acquireTxMutexRef(mutexKey);
            // HB-94 (re-applied P3b): bare sets wait on this
            // counter — see the note at writeMutex.
            activeTransactions += 1;
            let outcome;
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
            let commitError;
            let committed = false;
            try {
                try {
                    const releaseMutex = await mutex.acquire();
                    try {
                        const ctx = {
                            cache: {},
                            mutations: {},
                            dbQueries: 0
                        };
                        logger.trace('entering transaction');
                        let result;
                        try {
                            result = await txStorage.run(ctx, work);
                        }
                        catch (error) {
                            logger.error({ error }, 'transaction failed, rolling back');
                            throw error;
                        }
                        outcome = { result, mutations: ctx.mutations, dbQueries: ctx.dbQueries };
                        if (Object.keys(ctx.mutations).length === 0) {
                            logger.trace('no mutations in transaction');
                            committed = true;
                        }
                        else {
                            logger.trace('committing transaction');
                            try {
                                await attemptCommit(ctx.mutations);
                                committed = true;
                            }
                            catch (error) {
                                if (isPermanentCommitError(error) || commitRetries <= 1) {
                                    throw error;
                                }
                                commitError = error;
                            }
                        }
                    }
                    finally {
                        releaseMutex();
                    }
                }
                finally {
                    // HB-94 (re-applied P3b): see activeTransactions.
                    activeTransactions -= 1;
                    notifyTxIdle();
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
                    let lastError = commitError;
                    for (let attempt = 1; attempt < commitRetries; attempt++) {
                        logger.warn(`failed to commit mutations, retries left=${commitRetries - attempt}`);
                        await delay(commitDelayMs);
                        const releaseRetry = await mutex.acquire();
                        try {
                            await attemptCommit(outcome.mutations);
                            committed = true;
                        }
                        catch (error) {
                            lastError = error;
                            if (isPermanentCommitError(error)) {
                                throw error;
                            }
                        }
                        finally {
                            releaseRetry();
                        }
                        if (committed) {
                            break;
                        }
                    }
                    if (!committed) {
                        logger.warn('failed to commit mutations, retries left=0');
                        throw lastError;
                    }
                }
            }
            finally {
                releaseTxMutexRef(mutexKey);
            }
            logger.trace({ dbQueries: outcome.dbQueries }, 'transaction completed');
            return outcome.result;
        }
    };
};
/**
 * Returns the authenticated user's JID, or throws a Boom-401 if creds are not yet authenticated.
 * Use this anywhere we'd otherwise reach for `creds.me!.id` to fail fast with a descriptive error.
 */
export const assertMeId = (creds) => {
    const id = creds.me?.id;
    if (!id) {
        throw new Boom('Cannot proceed: socket is not authenticated yet (creds.me.id is missing)', { statusCode: 401 });
    }
    return id;
};
export const initAuthCreds = () => {
    const identityKey = Curve.generateKeyPair();
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
    };
};
//# sourceMappingURL=auth-utils.js.map