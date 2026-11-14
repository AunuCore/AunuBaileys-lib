/**
 * AunuBaileys sent-message cache for retry receipts.
 *
 * When a peer cannot decrypt a message we sent, WhatsApp asks for a
 * resend via a retry receipt. Upstream Baileys can only answer when
 * the app supplied a `getMessage` store; with the default
 * `getMessage: async () => undefined` every retry dies with
 * "message not available" and the peer never receives the message
 * (the classic "read but never delivered / stuck unreadable" bug).
 *
 * This cache keeps the last N relayed message contents per socket
 * (whatsmeow-style, default 256) so `sendMessagesAgain` can fall
 * back to it when the app's own `getMessage` has nothing. The app's
 * store always wins; this is only a fallback. Set
 * `sentMessagesCacheSize: 0` in the socket config to disable.
 */
export const makeSentMessageCache = (maxEntries = 256, resolveAlternateJid) => {
    // AunuBaileys (1.0.80, HB-145): a NaN cap (host config from an
    // unset env var — sentMessageCacheFor's typeof check passes NaN
    // straight through) made `cache.size > NaN` false forever, so
    // the cache grew without bound; Infinity did the same.
    // Sanitise at the boundary: finite values are floored and
    // clamped at 0 (0 keeps its documented meaning — the cache is
    // disabled), non-finite values fall back to the default 256.
    const limit = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 256;
    const cache = new Map();
    const keyOf = (remoteJid, id) => `${remoteJid}:${id}`;
    let altResolver = typeof resolveAlternateJid === 'function' ? resolveAlternateJid : undefined;
    return {
        // AunuBaileys (1.0.72): the send side stores under the JID the
        // message was sent to; a retry receipt can address the same
        // chat by its OTHER identifier (PN <-> LID — the server picks
        // the chat's addressing mode). A resolver (the socket's LID
        // store) lets a miss retry under the alternate JID.
        setResolver: (fn) => {
            if (typeof fn === 'function') {
                altResolver = fn;
            }
        },
        add: (remoteJid, id, message) => {
            if (!remoteJid || !id || !message || limit <= 0) {
                return;
            }
            const key = keyOf(remoteJid, id);
            cache.delete(key);
            cache.set(key, message);
            while (cache.size > limit) {
                cache.delete(cache.keys().next().value);
            }
        },
        get: (remoteJid, id) => {
            if (!remoteJid || !id) {
                return undefined;
            }
            const direct = cache.get(keyOf(remoteJid, id));
            if (direct || !altResolver) {
                return direct;
            }
            let alt;
            try {
                alt = altResolver(remoteJid);
            }
            catch {
                return undefined;
            }
            return alt && alt !== remoteJid ? cache.get(keyOf(alt, id)) : undefined;
        },
        get size() {
            return cache.size;
        },
        clear: () => cache.clear()
    };
};
const cachesByConfig = new WeakMap();
/**
 * Returns the per-socket sent-message cache bound to a socket
 * config object. Send and receive layers of the same socket share
 * one config object, so a WeakMap keyed by it gives every socket
 * its own isolated cache without any extra plumbing.
 */
export const sentMessageCacheFor = (config, resolveAlternateJid) => {
    let cache = cachesByConfig.get(config);
    if (!cache) {
        const size = typeof config?.sentMessagesCacheSize === 'number' ? config.sentMessagesCacheSize : 256;
        cache = makeSentMessageCache(size, resolveAlternateJid);
        cachesByConfig.set(config, cache);
    }
    else if (resolveAlternateJid) {
        cache.setResolver(resolveAlternateJid);
    }
    return cache;
};
