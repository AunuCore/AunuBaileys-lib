import type { WAMessage } from '../Types/index.js';
export interface LIDStoreOptions {
    /** Maximum PN<->LID pairs kept; least-recently-used pairs are evicted. Default 5000. */
    maxEntries?: number;
    /** Fired when a genuinely NEW or changed PN<->LID pair is learned. */
    onPairLearned?: (pair: {
        pn: string;
        lid: string;
    }) => void;
    logger?: {
        warn?: (obj: any, msg?: string) => void;
    };
}
type LearnableKey = {
    senderPn?: string;
    senderLid?: string;
    participantPn?: string;
    participantLid?: string;
    remoteJid?: string;
    fromMe?: boolean;
    [key: string]: any;
};
export interface LIDStore {
    /** Store one PN/LID pair. Returns false when either JID is not a user PN JID / LID JID. */
    addPair(pnJid: string, lidJid: string, opts?: {
        silent?: boolean;
    }): boolean;
    /** Learn pairs from a message key (senderPn/senderLid, participantPn/participantLid). Returns pairs learned. */
    learnFromKey(key: LearnableKey | undefined | null): number;
    /** Learn pairs from one message. Returns pairs learned. */
    learnFromMessage(msg: WAMessage | undefined | null): number;
    /** Learn pairs from a `messages.upsert` payload. Returns pairs learned. */
    learnFromUpsert(upsert: {
        messages?: WAMessage[];
    } | undefined | null): number;
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
 * AunuBaileys LID identity store.
 *
 * WhatsApp is migrating identities from phone-number JIDs
 * (`<number>@s.whatsapp.net`) to LIDs (`<id>@lid`). Incoming message
 * stanzas already carry both forms (`sender_pn`/`sender_lid`,
 * `participant_pn`/`participant_lid`), so this store learns the
 * PN <-> LID pairs from live traffic and answers bidirectional
 * lookups locally — no server round-trip, no extra IQ queries.
 *
 * The socket attaches an auto-learning instance as `sock.aunuLid`.
 * A standalone store can also be created with `makeLIDStore()` and
 * fed manually via `learnFromMessage` / `addPair`.
 */
export declare const makeLIDStore: (options?: LIDStoreOptions) => LIDStore;
export {};
//# sourceMappingURL=lid-store.d.ts.map