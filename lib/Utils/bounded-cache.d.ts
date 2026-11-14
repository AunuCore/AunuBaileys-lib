/**
 * AunuBaileys: a bounded TTL cache for per-socket retry/offer state.
 *
 * Behaviour learned from the @violetix/baileys dissection: caches
 * with a TTL but no size bound grow without limit inside the TTL
 * window under load (one exists per socket, so a fleet multiplies
 * it), and a read must never refresh an entry's expiry — a message
 * stuck in a retry loop would otherwise keep its own counter alive
 * forever, defeating the TTL entirely.
 *
 * Oldest entries are evicted first when the ceiling is reached.
 * Reads never extend an entry's life. The surface is the get/set/del
 * the receive path uses.
 */
export declare const makeBoundedTTLCache: ({ ttlSeconds, maxEntries }?: {
    ttlSeconds?: number;
    maxEntries?: number;
}) => {
    get(key: any): any;
    set(key: any, value: any): void;
    del(key: any): void;
    flushAll(): void;
    readonly size: number;
};
//# sourceMappingURL=bounded-cache.d.ts.map