// @ts-nocheck
// AunuBaileys P2b port: faithful TypeScript-tree port of the v6 (1.0.89)
// JavaScript module of the same name — behaviour and HB/version
// annotations preserved verbatim; types are intentionally loose here
// and tighten in a later pass.
/**
 * AunuBaileys (1.0.71): extended message inspection — pure utils.
 *
 * normalizeAunuMessageContentExtended unwraps every FutureProofMessage
 * shell our Message proto actually carries, on top of the shells the
 * base normalizeMessageContent already handles. Only branches whose
 * wrapper field exists in OUR proto are included:
 *  - present: ephemeralMessage, viewOnceMessage,
 *    documentWithCaptionMessage, viewOnceMessageV2,
 *    viewOnceMessageV2Extension, editedMessage, groupMentionedMessage,
 *    botInvokeMessage, lottieStickerMessage, eventCoverImage,
 *    statusMentionMessage, pollCreationOptionImageMessage,
 *    associatedChildMessage, groupStatusMentionMessage,
 *    pollCreationMessageV4, pollCreationMessageV5, statusAddYours,
 *    groupStatusMessage, limitSharingMessage, botTaskMessage,
 *    questionMessage, groupStatusMessageV2, botForwardedMessage,
 *    spoilerMessage.
 *  - deliberately NOT unwrapped: pollCreationMessageV6 — in our proto
 *    it is a typed PollCreationMessage (field 119), not a
 *    FutureProofMessage wrapper, so it is already the terminal content.
 *  - skipped, field absent from our Message proto:
 *    newsletterScheduledMessage, acp2SettingMessage, audioStickerMessage,
 *    groupStatusV3Message, questionReplyMessage,
 *    newsletterAdminProfileMessage, newsletterAdminProfileMessageV2,
 *    newsletterAdminProfileStatusMessage,
 *    botPlatformRegistrationSuccessMessage.
 *  - scheduled-message helpers are skipped too: our WebMessageInfo has
 *    no scheduledMessageMetadata field.
 *
 * The poll-vote aggregator below reuses our own
 * getAggregateVotesInPollMessage (which already normalises, canonicalises
 * voters through the LID store and dedupes them) after extended
 * normalisation, instead of duplicating its vote logic.
 */
import { proto } from '../../WAProto/index.js';
import { jidDecode } from '../WABinary/index.js';
import { getKeyAuthor } from './generics.js';
import { getAggregateVotesInPollMessage, normalizeMessageContent } from './messages.js';
// AunuBaileys (1.0.87, HB-218): every operand is optional-chained,
// exactly like the base getFutureProofMessage in messages.js. A
// wrapper whose `message` field is absent decodes with message ===
// null; the bare derefs used to throw a raw TypeError on the next
// loop iteration of normalizeAunuMessageContentExtended (and in
// getAggregateVotesInPollMessageExtended downstream of it).
const getFutureProofMessageExtended = message => message?.ephemeralMessage ||
    message?.viewOnceMessage ||
    message?.documentWithCaptionMessage ||
    message?.viewOnceMessageV2 ||
    message?.viewOnceMessageV2Extension ||
    message?.editedMessage ||
    message?.groupMentionedMessage ||
    message?.botInvokeMessage ||
    message?.lottieStickerMessage ||
    message?.eventCoverImage ||
    message?.statusMentionMessage ||
    message?.pollCreationOptionImageMessage ||
    message?.associatedChildMessage ||
    message?.groupStatusMentionMessage ||
    message?.pollCreationMessageV4 ||
    message?.pollCreationMessageV5 ||
    message?.statusAddYours ||
    message?.groupStatusMessage ||
    message?.limitSharingMessage ||
    message?.botTaskMessage ||
    message?.questionMessage ||
    message?.groupStatusMessageV2 ||
    message?.botForwardedMessage ||
    message?.spoilerMessage;
/**
 * Extended version of normalizeMessageContent — unwraps every
 * FutureProofMessage shell listed above. Falls back to the base
 * normaliser's result when nothing further unwraps.
 */
export const normalizeAunuMessageContentExtended = content => {
    if (!content) {
        return undefined;
    }
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessageExtended(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
};
/** Extract PaymentInfo from a WebMessageInfo. */
export const getMessagePaymentInfo = msg => msg?.paymentInfo || msg?.quotedPaymentInfo || null;
/** Get comment metadata from a WebMessageInfo. */
export const getMessageCommentMetadata = msg => msg?.commentMetadata || null;
/** Get all message add-ons (reactions, poll updates, pins) from a WebMessageInfo. */
export const getMessageAddOns = msg => msg?.messageAddOns || [];
/**
 * Get the quiz correct answer from a poll creation message, if it is a
 * quiz. V4 is read through its FutureProofMessage shell, which the
 * donor's version missed.
 */
export const getPollCorrectAnswer = pollMsg => {
    const poll = pollMsg?.pollCreationMessage ||
        pollMsg?.pollCreationMessageV2 ||
        pollMsg?.pollCreationMessageV3 ||
        pollMsg?.pollCreationMessageV4?.message?.pollCreationMessage ||
        pollMsg?.pollCreationMessageV5?.message?.pollCreationMessage ||
        pollMsg?.pollCreationMessageV6;
    if (!poll) {
        return null;
    }
    const isQuiz = poll.pollType === proto.Message.PollType?.QUIZ || poll.pollType === 1;
    return isQuiz ? poll.correctAnswer?.optionName || null : null;
};
/**
 * Extended getAggregateVotesInPollMessage — also handles V4/V5/V6 poll
 * messages. Implemented as extended normalisation + our own aggregator,
 * so V5/V6 handling, LID-store voter canonicalisation and per-option
 * voter dedup stay exactly as in getAggregateVotesInPollMessage.
 */
export const getAggregateVotesInPollMessageExtended = ({ message, pollUpdates }, meId, options) => {
    return getAggregateVotesInPollMessage({ message: normalizeAunuMessageContentExtended(message), pollUpdates }, meId, options);
};
/**
 * Aggregate all event responses in an event message.
 * @param {object} params
 * @param {Array} params.eventResponses array of event response updates
 * @param {string} meLid your LID JID
 */
export const getAggregateResponsesInEventMessage = ({ eventResponses }, meLid) => {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = { response: type, responders: [] };
    }
    for (const update of eventResponses || []) {
        const { response } = update.response || {};
        const responseType = proto.Message.EventResponseMessage.EventResponseType[response];
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meLid));
        }
    }
    return Object.values(responseMap);
};
// --- LID / JID helpers ---
// Our WABinary has isLidUser/isJidUser but no hosted-LID / PN variants,
// so the small predicates below are local (endsWith checks, same rule).
const isLidJid = jid => typeof jid === 'string' && jid.endsWith('@lid');
const isHostedLidJid = jid => typeof jid === 'string' && jid.endsWith('@hosted.lid');
const isPnJid = jid => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
const isHostedPnJid = jid => typeof jid === 'string' && jid.endsWith('@hosted');
/** Normalize a bare user id to @s.whatsapp.net. */
export const toJid = id => {
    if (!id) {
        return '';
    }
    if (id.includes('@')) {
        return id;
    }
    return `${id}@s.whatsapp.net`;
};
/**
 * Returns the peer LID JID when the key is LID-primary. Our MessageKey
 * proto only carries remoteJid/fromMe/id/participant, so the lid /
 * participantLid branches only fire on plain-object keys that carry
 * those fields (e.g. hand-built keys); they never throw on plain keys.
 */
export const getSenderLid = message => {
    const k = message.key;
    if (!k) {
        return { jid: '', lid: '' };
    }
    const jid = k.participant || k.remoteJid || '';
    if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
        return { jid, lid: jid };
    }
    if (k.lid && typeof k.lid === 'string') {
        const lid = k.lid.includes('@') ? k.lid : jidDecode ? `${k.lid}@lid` : k.lid;
        return { jid, lid };
    }
    if (k.participantLid && (isLidJid(k.participantLid) || isHostedLidJid(k.participantLid))) {
        return { jid, lid: k.participantLid };
    }
    return { jid, lid: '' };
};
// Re-exported for callers that already import the base normaliser here.
export { normalizeMessageContent };
export { isLidJid, isHostedLidJid, isPnJid, isHostedPnJid };
//# sourceMappingURL=aunu-message-inspect.js.map