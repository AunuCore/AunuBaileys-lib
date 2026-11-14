/** Thresholds are deliberately conservative: real clients never produce these shapes. */
export declare const AUNU_BUG_GUARD_LIMITS: {
    maxTextLength: number;
    maxEncodedBytes: number;
    maxInvisibleChars: number;
    maxInvisibleRun: number;
    maxCombiningRun: number;
    maxControlChars: number;
    maxWrapperDepth: number;
    maxMentions: number;
    maxGroupMentions: number;
    maxNativeFlowButtons: number;
    maxButtonParamsBytes: number;
    maxMessageParamsBytes: number;
    maxListRows: number;
    maxCarouselCards: number;
    maxPollOptions: number;
    maxContacts: number;
    maxAIRichSubmessages: number;
};
/**
 * Pure scan. `message` is a WAMessage (`{ key, message }`) or a proto
 * content object (`{ conversation }`, `{ extendedTextMessage }`, ...),
 * or a send-content object (`{ text }`, `{ image, caption }`, ...).
 * Returns `{ isBug, reasons }`; each reason is `code: detail`.
 */
export declare const detectBugMessage: (message: any, options?: {}) => {
    isBug: boolean;
    reasons: any[];
};
/** Meta AI's phone range (1313555...) — used by the group-add guard. */
export declare const isAunuMetaAIJid: (jid: any) => boolean;
/**
 * Wires the detector to a socket. Options:
 *   logger (default sock.logger), onBug(detail) callback,
 *   dropOutbound (default true — a flagged send is refused with a Boom),
 *   scanInbound (default true), burstWindowMs (default 60000),
 *   burstThreshold (default 2 — second flag inside the window marks a burst),
 *   enableRevoke / enableKick / enableBlock (all default false — the
 *   destructive actions run ONLY when explicitly enabled).
 * Returns `{ detach, detect }`; `detach()` restores `sendMessage` and
 * removes the upsert listener.
 */
export declare const attachAunuBugGuard: (sock: any, options?: {}) => {
    detect: (message: any, options?: {}) => {
        isBug: boolean;
        reasons: any[];
    };
    detach: () => void;
};
//# sourceMappingURL=aunu-bug-guard.d.ts.map