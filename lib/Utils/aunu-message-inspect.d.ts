import { normalizeMessageContent } from './messages.js';
/**
 * Extended version of normalizeMessageContent — unwraps every
 * FutureProofMessage shell listed above. Falls back to the base
 * normaliser's result when nothing further unwraps.
 */
export declare const normalizeAunuMessageContentExtended: (content: any) => any;
/** Extract PaymentInfo from a WebMessageInfo. */
export declare const getMessagePaymentInfo: (msg: any) => any;
/** Get comment metadata from a WebMessageInfo. */
export declare const getMessageCommentMetadata: (msg: any) => any;
/** Get all message add-ons (reactions, poll updates, pins) from a WebMessageInfo. */
export declare const getMessageAddOns: (msg: any) => any;
/**
 * Get the quiz correct answer from a poll creation message, if it is a
 * quiz. V4 is read through its FutureProofMessage shell, which the
 * donor's version missed.
 */
export declare const getPollCorrectAnswer: (pollMsg: any) => any;
/**
 * Extended getAggregateVotesInPollMessage — also handles V4/V5/V6 poll
 * messages. Implemented as extended normalisation + our own aggregator,
 * so V5/V6 handling, LID-store voter canonicalisation and per-option
 * voter dedup stay exactly as in getAggregateVotesInPollMessage.
 */
export declare const getAggregateVotesInPollMessageExtended: ({ message, pollUpdates }: {
    message: any;
    pollUpdates: any;
}, meId: any, options: any) => unknown[];
/**
 * Aggregate all event responses in an event message.
 * @param {object} params
 * @param {Array} params.eventResponses array of event response updates
 * @param {string} meLid your LID JID
 */
export declare const getAggregateResponsesInEventMessage: ({ eventResponses }: {
    eventResponses: any;
}, meLid: any) => unknown[];
declare const isLidJid: (jid: any) => boolean;
declare const isHostedLidJid: (jid: any) => boolean;
declare const isPnJid: (jid: any) => boolean;
declare const isHostedPnJid: (jid: any) => boolean;
/** Normalize a bare user id to @s.whatsapp.net. */
export declare const toJid: (id: any) => any;
/**
 * Returns the peer LID JID when the key is LID-primary. Our MessageKey
 * proto only carries remoteJid/fromMe/id/participant, so the lid /
 * participantLid branches only fire on plain-object keys that carry
 * those fields (e.g. hand-built keys); they never throw on plain keys.
 */
export declare const getSenderLid: (message: any) => {
    jid: any;
    lid: any;
};
export { normalizeMessageContent };
export { isLidJid, isHostedLidJid, isPnJid, isHostedPnJid };
//# sourceMappingURL=aunu-message-inspect.d.ts.map