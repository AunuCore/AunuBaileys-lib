import type { WAMessage } from '../Types/index.js';
export interface LIDStoreOptions {
    /** Maximum PN<->LID pairs kept; least-recently-used pairs are evicted. Default 5000. */
    maxEntries?: number;
}
export interface LIDStore {
    /** Store one PN/LID pair. Returns false when either JID is not a user PN JID / LID JID. */
    addPair(pnJid: string, lidJid: string): boolean;
    /** Learn pairs from a message key (senderPn/senderLid, participantPn/participantLid). Returns pairs learned. */
    learnFromKey(key: Record<string, unknown> | undefined): number;
    /** Learn pairs from one message. Returns pairs learned. */
    learnFromMessage(msg: WAMessage | undefined): number;
    /** Learn pairs from a `messages.upsert` payload. Returns pairs learned. */
    learnFromUpsert(upsert: { messages?: WAMessage[] }): number;
    getLIDForPN(pnJid: string): string | undefined;
    getPNForLID(lidJid: string): string | undefined;
    /** The alternate identity form of a known JID (PN for a known LID, LID for a known PN); undefined when unknown or not a user JID. */
    getAltJid(jid: string): string | undefined;
    hasPN(pnJid: string): boolean;
    hasLID(lidJid: string): boolean;
    deletePair(jid: string): boolean;
    clear(): void;
    readonly size: number;
    toJSON(): Record<string, string>;
    saveToFile(path: string): void;
    /** Returns the number of pairs loaded; 0 when the file is missing or invalid. */
    loadFromFile(path: string): number;
}
/**
 * Create a bidirectional PN <-> LID identity store that learns from
 * live message traffic. Sockets expose an auto-learning instance as
 * `sock.aunuLid`.
 */
export declare const makeLIDStore: (options?: LIDStoreOptions) => LIDStore;
