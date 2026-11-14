/**
 * Build LID -> PN hints from a message key's alt fields
 * (participant/participantAlt, remoteJid/remoteJidAlt).
 */
export declare const buildAunuLidPnHints: (key: any) => Map<any, any>;
/** Merge LID -> PN hints from group participant data (lid/phoneNumber). */
export declare const mergeAunuGroupDataHints: (hints: any, groupData: any, debug: any) => void;
/**
 * Normalise one JID for display: LID -> PN via hints, then via the
 * injected resolver. Non-LIDs pass through untouched; an unmapped LID
 * is returned as-is (never fabricated into a PN).
 * @param {string} jid
 * @param {Map} hints LID -> PN hints
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {function} [debug] trace logger
 */
export declare const normalizeAunuToPnJid: (jid: any, hints: any, resolvePn: any, debug: any) => Promise<any>;
/**
 * Normalize mentions in a message array for sending (LID -> PN).
 * @param {string[]} mentions
 * @param {object} [groupData] { participants: [{ lid, id, phoneNumber }] }
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {object} [logger] pino-style logger for the LID_PN_DEBUG trace
 */
export declare const normalizeAunuMentionedJidsForSend: (mentions: any, groupData: any, resolvePn: any, logger: any) => Promise<any>;
/**
 * Normalize a WebMessageInfo's key JIDs and mentionedJids for display
 * (LID -> PN). Mutates the key / message in place (donor behaviour)
 * and returns the same messageInfo.
 * @param {object} messageInfo WebMessageInfo
 * @param {function} [resolvePn] async (lidJid) => pnJid | undefined
 * @param {object} [logger] pino-style logger for the LID_PN_DEBUG trace
 * @param {object} [groupData] { participants: [{ lid, id, phoneNumber }] }
 */
export declare const normalizeAunuMessageForDisplayJids: (messageInfo: any, resolvePn: any, logger: any, groupData: any) => Promise<any>;
//# sourceMappingURL=aunu-jid-display.d.ts.map