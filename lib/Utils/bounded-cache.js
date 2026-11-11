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
export const makeBoundedTTLCache = ({ ttlSeconds = 3600, maxEntries = 1000 } = {}) => {
    const ttlMs = Math.max(1, ttlSeconds * 1000);
    const map = new Map();
    return {
        get(key) {
            const entry = map.get(key);
            if (!entry)
                return undefined;
            if (entry.expiresAt <= Date.now()) {
                map.delete(key);
                return undefined;
            }
            return entry.value;
        },
        set(key, value) {
            map.set(key, { value, expiresAt: Date.now() + ttlMs });
            while (map.size > maxEntries) {
                const oldest = map.keys().next().value;
                if (oldest === undefined)
                    break;
                map.delete(oldest);
            }
        },
        del(key) {
            map.delete(key);
        },
        get size() {
            return map.size;
        }
    };
};
