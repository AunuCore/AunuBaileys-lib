/**
 * AunuBaileys: the inbound stanza ignore filter behind
 * sock.ignoreKey() — behaviour learned from the @violetix/baileys
 * dissection. Matching stanzas are dropped BEFORE any handler runs:
 * no decryption, no persistence, no event. Messages are still acked
 * by the caller so the server stops redelivering them.
 *
 * A rule is either a predicate `(info) => boolean` or an object with
 * any of { category, remoteJid, participant, id, fromMe } — every
 * given field must match. `participant` matches ANY of the stanza's
 * participant forms (PN, LID, and the alt attributes), so a rule
 * written against a phone-number JID still catches the same person
 * arriving under their LID. Traffic in the 'peer' category
 * (own-device sync, app-state key shares) is NEVER dropped: an
 * over-broad rule must not be able to filter away a key share.
 */
export declare const stanzaInfo: (category: any, node: any, ownIds?: never[]) => {
    category: any;
    remoteJid: any;
    participant: any;
    participants: any[];
    id: any;
    fromMe: boolean;
    node: any;
};
export declare const createIgnoreFilter: () => {
    /** Register a rule; returns the function that removes it. */
    add: (rule: any) => () => void;
    clear: () => void;
    readonly size: number;
    shouldDrop: (category: any, node: any, ownIds: any) => boolean;
};
//# sourceMappingURL=ignore-filter.d.ts.map