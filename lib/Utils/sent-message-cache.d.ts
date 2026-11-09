import type { WAMessageContent } from '../Types/index.js';
export interface SentMessageCache {
    add(remoteJid: string, id: string, message: WAMessageContent): void;
    get(remoteJid: string, id: string): WAMessageContent | undefined;
    readonly size: number;
    clear(): void;
}
/**
 * Create a bounded FIFO cache of recently relayed message contents,
 * used to answer retry receipts when the app's `getMessage` store
 * has no copy. Default capacity 256.
 */
export declare const makeSentMessageCache: (maxEntries?: number) => SentMessageCache;
/** Returns the per-socket cache bound to a socket config object (internal plumbing, also handy in tests). */
export declare const sentMessageCacheFor: (config: object) => SentMessageCache;
