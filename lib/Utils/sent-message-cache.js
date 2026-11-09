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
export const makeSentMessageCache = (maxEntries = 256) => {
    const cache = new Map();
    const keyOf = (remoteJid, id) => `${remoteJid}:${id}`;
    return {
        add: (remoteJid, id, message) => {
            if (!remoteJid || !id || !message || maxEntries <= 0) {
                return;
            }
            const key = keyOf(remoteJid, id);
            cache.delete(key);
            cache.set(key, message);
            while (cache.size > maxEntries) {
                cache.delete(cache.keys().next().value);
            }
        },
        get: (remoteJid, id) => {
            if (!remoteJid || !id) {
                return undefined;
            }
            return cache.get(keyOf(remoteJid, id));
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
export const sentMessageCacheFor = (config) => {
    let cache = cachesByConfig.get(config);
    if (!cache) {
        const size = typeof config?.sentMessagesCacheSize === 'number' ? config.sentMessagesCacheSize : 256;
        cache = makeSentMessageCache(size);
        cachesByConfig.set(config, cache);
    }
    return cache;
};
