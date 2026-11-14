import type { WAMessageContent } from '../Types/index.js';
export interface SentMessageCache {
    setResolver: (fn: (jid: string) => string | undefined) => void;
    add(remoteJid: string, id: string, message: WAMessageContent): void;
    get(remoteJid: string, id: string): WAMessageContent | undefined;
    readonly size: number;
    clear(): void;
}
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
export declare const makeSentMessageCache: (maxEntries?: number, resolveAlternateJid?: (jid: string) => string | undefined) => SentMessageCache;
/**
 * Returns the per-socket sent-message cache bound to a socket
 * config object. Send and receive layers of the same socket share
 * one config object, so a WeakMap keyed by it gives every socket
 * its own isolated cache without any extra plumbing.
 */
export declare const sentMessageCacheFor: (config: any, resolveAlternateJid?: (jid: string) => string | undefined) => SentMessageCache;
//# sourceMappingURL=sent-message-cache.d.ts.map