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
    ttlMs?: number;
    /** LRU ceiling; eviction (never an error) past this many entries */
    maxEntries?: number;
    /** refresh an entry's expiry when it is read (lru-cache parity) */
    updateAgeOnGet?: boolean;
    /** fired when an entry leaves the cache without being overwritten silently */
    dispose?: (value: V, key: string) => void;
}
export declare class InternalCache<V = any> {
    private readonly map;
    private readonly ttlMs?;
    private readonly limit;
    private readonly updateAgeOnGet;
    private readonly dispose?;
    private purgeTimer?;
    constructor(options?: InternalCacheOptions<V>);
    get size(): number;
    get<T = V>(key: string): T | undefined;
    /** peek without the LRU touch or the age refresh (lru-cache `has` parity) */
    has(key: string): boolean;
    set<T = V>(key: string, value: T): this;
    delete(key: string): boolean;
    /** CacheStore spelling of delete */
    del(key: string): boolean;
    clear(): void;
    flushAll(): void;
    /** CacheStore extended surface: bulk read as a record */
    mget<T = V>(keys: string[]): Record<string, T | undefined>;
    mset<T = V>(entries: Array<{
        key: string;
        value: T;
    }>): void;
    mdel(keys: string[]): void;
    keys(): string[];
    /** stop the purge timer (NodeCache `close` parity); entries are kept */
    close(): void;
    private isExpired;
    private purgeExpired;
    private fireDispose;
}
export interface CacheStoreFactoryOptions<V = any> extends Omit<InternalCacheOptions<V>, 'ttlMs'> {
    /** TTL in seconds — the spelling the socket factories used with NodeCache (`stdTTL`) */
    stdTTL?: number;
    ttlSeconds?: number;
    ttlMs?: number;
}
/**
 * Build an InternalCache from the NodeCache-style options the socket
 * factories used (`stdTTL` in seconds). Every factory cache is capped:
 * callers state `maxEntries` explicitly; the class default applies
 * when they do not.
 */
export declare const makeCacheStore: <V = any>(options?: CacheStoreFactoryOptions<V>) => InternalCache<V>;
//# sourceMappingURL=internal-cache.d.ts.map