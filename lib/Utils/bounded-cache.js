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
    // AunuBaileys (1.0.80, HB-145): NaN/Infinity config defeated
    // both bounds — `size > NaN` is always false (no eviction,
    // ever) and a NaN ttlMs made expiresAt NaN, which never
    // compares <= now, so entries lived forever. Sanitise at the
    // boundary: finite values keep their exact meaning (counts
    // are floored and clamped at 0), non-finite values fall back
    // to the documented defaults (3600 s / 1000 entries).
    const ttlMs = Number.isFinite(ttlSeconds) ? Math.max(1, ttlSeconds * 1000) : 3600 * 1000;
    const limit = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 1000;
    const map = new Map();
    return {
        get(key) {
            const entry = map.get(key);
            if (!entry) {
                return undefined;
            }
            if (entry.expiresAt <= Date.now()) {
                map.delete(key);
                return undefined;
            }
            return entry.value;
        },
        set(key, value) {
            map.set(key, { value, expiresAt: Date.now() + ttlMs });
            // AunuBaileys (1.0.80, HB-226): the old guard broke out
            // when the oldest KEY was `undefined` — but a Map can
            // legitimately HOLD undefined as a key (two in-tree
            // callers can produce one: a call offer without a
            // call-id, a placeholder resend without a message id),
            // and one such entry silently disabled the ceiling
            // until it expired. The iterator's `done` flag is the
            // real "map is empty" signal; deleting an undefined
            // key is perfectly safe.
            while (map.size > limit) {
                const oldest = map.keys().next();
                if (oldest.done) {
                    break;
                }
                map.delete(oldest.value);
            }
        },
        del(key) {
            map.delete(key);
        },
        flushAll() {
            map.clear();
        },
        get size() {
            return map.size;
        }
    };
};
//# sourceMappingURL=bounded-cache.js.map