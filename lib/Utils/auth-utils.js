import NodeCache from '@cacheable/node-cache';
import { AsyncLocalStorage } from 'async_hooks';
import { makeMutex } from './make-mutex.js';
import { randomBytes } from 'crypto';
import { DEFAULT_CACHE_TTLS } from '../Defaults/index.js';
import { Curve, signedKeyPair } from './crypto.js';
import { delay, generateRegistrationId } from './generics.js';
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
            useClones: false,
            deleteOnExpire: true
        });
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    return {
        async get(type, ids) {
            const data = {};
            const idsToFetch = [];
            for (const id of ids) {
                const item = cache.get(getUniqueId(type, id));
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
                        cache.set(getUniqueId(type, id), item);
                    }
                }
            }
            return data;
        },
        async set(data) {
            // AunuBaileys (1.0.70): the cache used to be updated BEFORE
            // the underlying store persisted — a failed persist left the
            // cache claiming an unsaved value. Persist first; the cache
            // only reflects what is actually on disk.
            await store.set(data);
            let keys = 0;
            for (const type in data) {
                for (const id in data[type]) {
                    // AunuBaileys: a null/undefined value is a DELETION. Upstream
                    // cached the null itself, so later gets returned a phantom
                    // present-but-null entry and — worse — kept shadowing a value
                    // re-created in the store until the TTL expired. Evict instead,
                    // so the next get reads the store's authoritative state. This
                    // is what makes deleteSession/deleteSenderKey (1.0.14/1.0.17)
                    // behave correctly through the recommended cacheable wiring.
                    if (data[type][id] === null || typeof data[type][id] === 'undefined') {
                        cache.del(getUniqueId(type, id));
                    }
                    else {
                        cache.set(getUniqueId(type, id), data[type][id]);
                    }
                    keys += 1;
                }
            }
            logger?.trace({ keys }, 'updated cache');
        },
        async clear() {
            cache.flushAll();
            await store.clear?.();
        }
    };
}
/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
    // number of queries made to the DB during the transaction
    // only there for logging purposes
    let dbQueriesInTransaction = 0;
    let transactionCache = {};
    let mutations = {};
    let transactionsInProgress = 0;
    // AunuBaileys: independent transactions are serialized through a
    // mutex; nested calls in the same async flow join the running one
    // (tracked with AsyncLocalStorage). Upstream shared one
    // cache/mutations across ALL concurrent transactions, so two flows
    // could commit each other's half-written session state — a route
    // to permanent Bad MAC / MISSING_KEYS.
    const transactionMutex = makeMutex();
    const transactionContext = new AsyncLocalStorage();
    const runTransaction = async (work) => {
        let result;
        transactionsInProgress += 1;
        if (transactionsInProgress === 1) {
            logger.trace('entering transaction');
        }
        try {
            result = await work();
            // commit if this is the outermost transaction
            if (transactionsInProgress === 1) {
                if (Object.keys(mutations).length) {
                    logger.trace('committing transaction');
                    // retry mechanism to ensure we've some recovery
                    // in case a transaction fails in the first attempt
                    let tries = maxCommitRetries;
                    let committed = false;
                    let lastCommitError;
                    while (tries) {
                        tries -= 1;
                        //eslint-disable-next-line max-depth
                        try {
                            await state.set(mutations);
                            logger.trace({ dbQueriesInTransaction }, 'committed transaction');
                            committed = true;
                            break;
                        }
                        catch (error) {
                            lastCommitError = error;
                            logger.warn(`failed to commit ${Object.keys(mutations).length} mutations, tries left=${tries}`);
                            await delay(delayBetweenTriesMs);
                        }
                    }
                    if (!committed) {
                        // AunuBaileys: a commit that fails through every retry
                        // must NOT be swallowed — the in-memory ratchet has
                        // advanced while the persisted state has not, and
                        // every later message would fail against the stale
                        // record. Throw so the caller learns its state was
                        // never persisted.
                        throw lastCommitError ?? new Error('failed to commit transaction mutations');
                    }
                }
                else {
                    logger.trace('no mutations in transaction');
                }
            }
        }
        finally {
            transactionsInProgress -= 1;
            if (transactionsInProgress === 0) {
                transactionCache = {};
                mutations = {};
                dbQueriesInTransaction = 0;
            }
        }
        return result;
    };
    return {
        get: async (type, ids) => {
            if (isInTransaction()) {
                const dict = transactionCache[type];
                const idsRequiringFetch = dict ? ids.filter(item => typeof dict[item] === 'undefined') : ids;
                // only fetch if there are any items to fetch
                if (idsRequiringFetch.length) {
                    dbQueriesInTransaction += 1;
                    const result = await state.get(type, idsRequiringFetch);
                    transactionCache[type] || (transactionCache[type] = {});
                    Object.assign(transactionCache[type], result);
                }
                return ids.reduce((dict, id) => {
                    const value = transactionCache[type]?.[id];
                    if (value) {
                        dict[id] = value;
                    }
                    return dict;
                }, {});
            }
            else {
                return state.get(type, ids);
            }
        },
        set: data => {
            if (isInTransaction()) {
                logger.trace({ types: Object.keys(data) }, 'caching in transaction');
                for (const key_ in data) {
                    const key = key_;
                    transactionCache[key] = transactionCache[key] || {};
                    Object.assign(transactionCache[key], data[key]);
                    mutations[key] = mutations[key] || {};
                    Object.assign(mutations[key], data[key]);
                }
            }
            else {
                // AunuBaileys (1.0.73, HB-94): a bare set used to write
                // straight through while a transaction was mid-flight,
                // so a migrateSession commit could overwrite a fresher
                // session record stored by an in-flight decrypt (the
                // record's ratchet then regressed by one message).
                // Serialize bare writes through the transaction mutex
                // so they land either fully before or fully after any
                // transaction. Sets issued from inside a transaction
                // never reach this branch (isInTransaction), so there
                // is no re-entrant lock — and the commit path calls
                // the raw state.set directly, never this wrapper.
                return transactionMutex.mutex(() => state.set(data));
            }
        },
        isInTransaction,
        async transaction(work) {
            if (transactionContext.getStore()) {
                return runTransaction(work);
            }
            return transactionMutex.mutex(() => transactionContext.run(true, () => runTransaction(work)));
        }    };
    function isInTransaction() {
        // AunuBaileys: "in transaction" is a property of the current
        // async flow, not of the store — a bystander's reads/writes
        // must not be captured by somebody else's running transaction.
        return !!transactionContext.getStore();
    }
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
        routingInfo: undefined
    };
};
//# sourceMappingURL=auth-utils.js.map