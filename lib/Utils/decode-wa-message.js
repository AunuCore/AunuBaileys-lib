import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidGroup, isJidMetaAI, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser
//	transferDevice
 } from '../WABinary/index.js';
import { unpadRandomMax16 } from './generics.js';
import { decodeDecryptedMsmsgMessage, decryptMsmsgBotMessage } from './meta-ai-msmsg.js';
export const getDecryptionJid = async (sender, repository) => {
    if (isLidUser(sender) || isHostedLidUser(sender)) {
        return sender;
    }
    const mapped = await repository.lidMapping.getLIDForPN(sender);
    return mapped || sender;
};
const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
    // TODO: Handle hosted IDs
    const { senderAlt } = extractAddressingContext(stanza);
    if (senderAlt && isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
        try {
            await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }]);
            await repository.migrateSession(sender, senderAlt);
            logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope');
        }
        catch (error) {
            logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping');
        }
    }
};
export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';
// AunuBaileys (1.0.71, ported P2d): outgoing @bot message id → messageSecret.
// Populated when we send to @bot (or see our own echo / recover it from
// the message store after a restart), consumed when the msmsg response
// from @bot arrives and needs decrypting. Verbatim design from the
// donor's decode-wa-message.js. In-memory only — a restart loses it,
// which is why messages-recv.ts re-seeds it from getMessage() first.
// v7 adaptation: the store keeps v6's exact caps and FIFO eviction; the
// only additions are runtime type guards at this boundary (the v6 JS
// relied on truthiness) — a present value of the wrong type is rejected,
// never coerced.
const MAX_SECRETS_PER_CHAT = 20;
const MAX_RECENT_CHATS = 1000;
const botMessageSecrets = new Map();
const botRecentSecretsByChat = new Map();
const pushRecentChatSecret = (chatJid, id, secretBuf) => {
    if (typeof chatJid !== 'string' || !chatJid || !(secretBuf instanceof Uint8Array)) {
        return;
    }
    const existing = botRecentSecretsByChat.get(chatJid) || [];
    const filtered = existing.filter(item => item.id !== id && !item.secret.equals(secretBuf));
    filtered.unshift({ id, secret: secretBuf });
    if (filtered.length > MAX_SECRETS_PER_CHAT) {
        filtered.length = MAX_SECRETS_PER_CHAT;
    }
    botRecentSecretsByChat.set(chatJid, filtered);
    // AunuBaileys (1.0.73, HB-92): the per-chat list above is capped,
    // but the chat count was not — one entry per @bot chat for the
    // life of the process. Cap the chat count FIFO, like its sibling
    // botMessageSecrets (HB-77, capped at 1000 in 1.0.72).
    while (botRecentSecretsByChat.size > MAX_RECENT_CHATS) {
        botRecentSecretsByChat.delete(botRecentSecretsByChat.keys().next().value);
    }
};
export const setBotMessageSecret = (id, secret, chatJid) => {
    if (typeof id !== 'string' || !id || !secret) {
        return;
    }
    let buf;
    if (Buffer.isBuffer(secret)) {
        buf = secret;
    }
    else if (secret instanceof Uint8Array) {
        buf = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    }
    else if (typeof secret === 'string') {
        buf = Buffer.from(secret, 'base64');
    }
    else {
        return;
    }
    botMessageSecrets.set(id, buf);
    // AunuBaileys (1.0.72): this map used to grow by one entry per sent
    // message for the life of the process (HB-77) — cap it FIFO like
    // its siblings (decryptErrorLogState / decryptFailCounts). Stale
    // secrets are never matched again: lookups are by exact message id,
    // and ids do not repeat.
    while (botMessageSecrets.size > 1000) {
        botMessageSecrets.delete(botMessageSecrets.keys().next().value);
    }
    if (chatJid) {
        pushRecentChatSecret(chatJid, id, buf);
    }
};
// Diagnostic/test accessor (the donor only exports the setter).
export const getBotMessageSecret = (id) => botMessageSecrets.get(id);
// Diagnostic/test accessor for the HB-92 chat-count cap.
export const getBotRecentSecretsChatCount = () => botRecentSecretsByChat.size;
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted';
// Retry configuration for failed decryption
export const DECRYPTION_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    sessionRecordErrors: ['No session record', 'SessionError: No session record']
};
/** NACK reason codes we send to the server (client → server) */
export const NACK_REASONS = {
    SenderReachoutTimelocked: 463,
    ParsingError: 487,
    UnrecognizedStanza: 488,
    UnrecognizedStanzaClass: 489,
    UnrecognizedStanzaType: 490,
    InvalidProtobuf: 491,
    InvalidHostedCompanionStanza: 493,
    MissingMessageSecret: 495,
    SignalErrorOldCounter: 496,
    MessageDeletedOnPeer: 499,
    UnhandledError: 500,
    UnsupportedAdminRevoke: 550,
    UnsupportedLIDGroup: 551,
    DBOperationFailed: 552
};
/**
 * Server-side error codes returned in ack stanzas (server → client) that we
 * currently have dedicated handlers for. Extend as more handlers are added.
 * Distinct from the client-side NackReason enum (WAWebCreateNackFromStanza).
 */
export const SERVER_ERROR_CODES = {
    /**
     * 1:1 message missing privacy token (tctoken). Usually means the account is
     * restricted: WhatsApp blocks starting new chats but preserves existing ones,
     * since established chats already carry a tctoken.
     */
    MessageAccountRestriction: '463',
    /** Stanza validation failure (SMAX_INVALID) — likely stale device session */
    SmaxInvalid: '479'
};
export const extractAddressingContext = (stanza) => {
    let senderAlt;
    let recipientAlt;
    const sender = stanza.attrs.participant || stanza.attrs.from;
    const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn');
    if (addressingMode === 'lid') {
        // Message is LID-addressed: sender is LID, extract corresponding PN
        // without device data
        senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn;
        recipientAlt = stanza.attrs.recipient_pn;
        // with device data
        //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
    }
    else {
        // Message is PN-addressed: sender is PN, extract corresponding LID
        // without device data
        senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid;
        recipientAlt = stanza.attrs.recipient_lid;
        //with device data
        //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
    }
    return {
        addressingMode,
        senderAlt,
        recipientAlt
    };
};
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza, meId, meLid) {
    let msgType;
    let chatId;
    let author;
    let fromMe = false;
    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;
    if (!msgId) {
        throw new Boom('Invalid message stanza: missing id attribute', { data: stanza });
    }
    if (!from) {
        throw new Boom('Invalid message stanza: missing from attribute', { data: stanza });
    }
    const addressingContext = extractAddressingContext(stanza);
    const isMe = (jid) => areJidsSameUser(jid, meId);
    const isMeLid = (jid) => areJidsSameUser(jid, meLid);
    if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
        if (recipient && !isJidMetaAI(recipient)) {
            if (!isMe(from) && !isMeLid(from)) {
                throw new Boom('receipient present, but msg not from me', { data: stanza });
            }
            if (isMe(from) || isMeLid(from)) {
                fromMe = true;
            }
            chatId = recipient;
        }
        else {
            // Peer-routed self stanzas (history sync, app-state sync, etc.) arrive
            // with `from` set to our own device but no `recipient` attribute —
            // still mark as fromMe so self-only protocolMessage handlers run.
            if (isMe(from) || isMeLid(from)) {
                fromMe = true;
            }
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    }
    else if (isJidGroup(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }
        if (isMe(participant) || isMeLid(participant)) {
            fromMe = true;
        }
        msgType = 'group';
        author = participant;
        chatId = from;
    }
    else if (isJidBroadcast(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }
        const isParticipantMe = isMe(participant);
        if (isJidStatusBroadcast(from)) {
            msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
        }
        else {
            msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast';
        }
        fromMe = isParticipantMe;
        chatId = from;
        author = participant;
    }
    else if (isJidMetaAI(from)) {
        // AunuBaileys (1.0.71, ported P2d): @bot responses (Meta AI) arrive
        // from a bare @bot jid — treat them as a 1:1 chat (donor design).
        // Without this branch the v7 decoder threw 'Unknown message type'
        // for every msmsg stanza before decryption could even start.
        msgType = 'chat';
        chatId = from;
        author = from;
    }
    else if (isJidNewsletter(from)) {
        msgType = 'newsletter';
        chatId = from;
        author = from;
        if (isMe(from) || isMeLid(from)) {
            fromMe = true;
        }
    }
    else {
        throw new Boom('Unknown message type', { data: stanza });
    }
    const pushname = stanza?.attrs?.notify;
    const key = {
        remoteJid: chatId,
        remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
        remoteJidUsername: !isJidGroup(chatId)
            ? stanza.attrs.peer_recipient_username || stanza.attrs.recipient_username
            : undefined,
        fromMe,
        id: msgId,
        participant,
        participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
        participantUsername: stanza.attrs.participant ? stanza.attrs.participant_username : undefined,
        addressingMode: addressingContext.addressingMode,
        ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
    };
    const fullMessage = {
        key,
        category: stanza.attrs.category,
        messageTimestamp: +stanza.attrs.t,
        pushName: pushname,
        broadcast: isJidBroadcast(from)
    };
    if (key.fromMe) {
        fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK;
    }
    return {
        fullMessage,
        author,
        sender: msgType === 'chat' ? author : chatId
    };
}
export const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            let decryptables = 0;
            if (Array.isArray(stanza.content)) {
                // AunuBaileys (1.0.71, ported P2d): msmsg replies carry their
                // key material in sibling <meta>/<bot> nodes, so collect
                // those before walking the enc nodes (donor design). Only
                // string attribute values are accepted — a present value of
                // the wrong type is ignored, never coerced.
                let metaTargetId = null;
                let metaTargetSenderJid = null;
                let botEditTargetId = null;
                let botType = null;
                if (stanza.content.some(n => n !== null && typeof n === 'object' && n.attrs?.type === 'msmsg')) {
                    for (const { tag, attrs } of stanza.content) {
                        if (attrs === null || typeof attrs !== 'object') {
                            continue;
                        }
                        if (tag === 'meta' && typeof attrs.target_id === 'string' && attrs.target_id) {
                            metaTargetId = attrs.target_id;
                        }
                        if (tag === 'meta' && typeof attrs.target_sender_jid === 'string' && attrs.target_sender_jid) {
                            metaTargetSenderJid = attrs.target_sender_jid;
                        }
                        if (tag === 'bot' && 'edit_target_id' in attrs && typeof attrs.edit_target_id === 'string') {
                            botEditTargetId = attrs.edit_target_id; // can be '' for the 'first' type
                        }
                        if (tag === 'bot' && typeof attrs.edit === 'string' && attrs.edit) {
                            botType = attrs.edit;
                        }
                    }
                }
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = proto.VerifiedNameCertificate.decode(content);
                        const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
                        fullMessage.verifiedBizName = details.verifiedName;
                    }
                    if (tag === 'unavailable' && attrs.type === 'view_once') {
                        fullMessage.key.isViewOnce = true; // TODO: remove from here and add a STUB TYPE
                    }
                    if (attrs.count && tag === 'enc') {
                        fullMessage.retryCount = Number(attrs.count);
                    }
                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }
                    if (!(content instanceof Uint8Array)) {
                        continue;
                    }
                    decryptables += 1;
                    let msgBuffer;
                    const decryptionJid = await getDecryptionJid(author, repository);
                    if (tag !== 'plaintext') {
                        // TODO: Handle hosted devices
                        await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger);
                    }
                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type;
                        switch (e2eType) {
                            case 'skmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                });
                                break;
                            case 'pkmsg':
                            case 'msg':
                                msgBuffer = await repository.decryptMessage({
                                    jid: decryptionJid,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            case 'msmsg': {
                                // AunuBaileys (1.0.71, ported P2d): botType null =
                                // non-streaming (no <bot> node), 'full' /
                                // 'last' = complete response, 'first' =
                                // streaming partial, intentionally skipped.
                                if (botType !== null && !['full', 'last'].includes(botType)) {
                                    // AunuBaileys (1.0.82, HB-171 addendum): the
                                    // skip used to leave no trace at all — the
                                    // caller took the SUCCESS branch, sent a
                                    // 'delivered' receipt and upserted an empty
                                    // message for content that was never read.
                                    // Leave a CIPHERTEXT stub, like any other
                                    // undecrypted content.
                                    fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                                    fullMessage.messageStubParameters = [`msmsg streaming partial skipped (edit=${botType})`];
                                    break;
                                }
                                const secretIdCandidates = [botEditTargetId, metaTargetId, fullMessage.key?.id].filter((v) => typeof v === 'string' && v.length > 0);
                                const secretCandidates = [];
                                const seenSecrets = new Set();
                                for (const idCandidate of secretIdCandidates) {
                                    const byId = botMessageSecrets.get(idCandidate);
                                    if (!byId) {
                                        continue;
                                    }
                                    const fp = byId.toString('hex');
                                    if (!seenSecrets.has(fp)) {
                                        seenSecrets.add(fp);
                                        secretCandidates.push({ source: `id:${idCandidate}`, secret: byId });
                                    }
                                }
                                for (const item of botRecentSecretsByChat.get(sender) || []) {
                                    if (!item || !(item.secret instanceof Uint8Array)) {
                                        continue;
                                    }
                                    const fp = Buffer.from(item.secret).toString('hex');
                                    if (!seenSecrets.has(fp)) {
                                        seenSecrets.add(fp);
                                        secretCandidates.push({ source: `chat:${item.id}`, secret: Buffer.from(item.secret) });
                                    }
                                    if (secretCandidates.length >= 6) {
                                        break;
                                    }
                                }
                                if (!secretCandidates.length) {
                                    logger.warn({ metaTargetId, botType, secretIdCandidates }, 'msmsg: no candidate messageSecret found, skipping');
                                    // AunuBaileys (1.0.82, HB-171): same
                                    // false-success as the partial skip above —
                                    // without a stub the caller receipts this as
                                    // delivered and stores an empty message. The
                                    // stub is the trace; messages-recv excludes
                                    // the msmsg class from retry/fail counting
                                    // (HB-170).
                                    fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                                    fullMessage.messageStubParameters = ['msmsg: no candidate messageSecret found'];
                                    break;
                                }
                                const msMsg = proto.MessageSecretMessage.decode(content);
                                const helperKey = {
                                    participant: author,
                                    meId: metaTargetSenderJid || (meLid ? `${meLid.split(':')[0]}@lid` : undefined),
                                    meLid,
                                    botEditTargetId,
                                    metaTargetId,
                                    stanzaId: stanza.attrs?.id
                                };
                                let decryptErr;
                                for (const candidate of secretCandidates) {
                                    try {
                                        msgBuffer = await decryptMsmsgBotMessage(candidate.secret, helperKey, msMsg);
                                        logger.debug({ source: candidate.source }, 'msmsg: decrypted with candidate secret');
                                        break;
                                    }
                                    catch (e) {
                                        decryptErr = e;
                                    }
                                }
                                if (!msgBuffer && decryptErr) {
                                    logger.warn({
                                        secretCandidateSources: secretCandidates.map(candidate => candidate.source),
                                        cause: decryptErr instanceof Error ? decryptErr.message : String(decryptErr)
                                    }, 'msmsg: helper decryption failed for all candidate secrets');
                                    throw decryptErr;
                                }
                                break;
                            }
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }
                        if (!msgBuffer) {
                            // AunuBaileys (1.0.71, ported P2d): a skipped
                            // streaming msmsg partial (or a msmsg with no
                            // candidate secret) leaves nothing to decode —
                            // its CIPHERTEXT stub above is the trace.
                            continue;
                        }
                        let msg = e2eType === 'msmsg'
                            ? decodeDecryptedMsmsgMessage(msgBuffer)
                            : proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer);
                        const outerMessageContextInfo = msg.messageContextInfo;
                        msg = msg.deviceSentMessage?.message || msg;
                        // deviceSentMessage.message may omit messageContextInfo (which carries the
                        // messageSecret for @bot) even though the outer wrapper has it — preserve it
                        if (outerMessageContextInfo && !msg.messageContextInfo) {
                            msg.messageContextInfo = outerMessageContextInfo;
                        }
                        if (msg.senderKeyDistributionMessage) {
                            //eslint-disable-next-line max-depth
                            try {
                                await repository.processSenderKeyDistributionMessage({
                                    authorJid: author,
                                    item: msg.senderKeyDistributionMessage
                                });
                            }
                            catch (err) {
                                logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message');
                            }
                        }
                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg);
                        }
                        else {
                            fullMessage.message = msg;
                        }
                    }
                    catch (err) {
                        const errorContext = {
                            key: fullMessage.key,
                            err,
                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,
                            author,
                            isSessionRecordError: isSessionRecordError(err)
                        };
                        logger.error(errorContext, 'failed to decrypt message');
                        fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                        fullMessage.messageStubParameters = [err.message.toString()];
                    }
                }
            }
            // AunuBaileys (ported P2d, v6 behaviour): a stanza can carry
            // several <enc> nodes; when at least one decrypted, the message
            // is real — a CIPHERTEXT stub left behind by a sibling node's
            // failure must not poison it.
            if (fullMessage.message && fullMessage.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
                delete fullMessage.messageStubType;
                delete fullMessage.messageStubParameters;
            }
            // if nothing was found to decrypt
            if (!decryptables && !fullMessage.key?.isViewOnce) {
                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
            }
        }
    };
};
/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error) {
    const errorMessage = error?.message || error?.toString() || '';
    return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern));
}
/**
 * AunuBaileys: true when a decrypt failure text is libsignal's session-layer
 * aggregate — the stored session record(s) could not decrypt the message at
 * all ("No matching sessions found for message", "No session record",
 * "No sessions available"). This class includes the unfillable counter gap
 * ("Over 2000 messages into the future!") thrown when the stored session
 * state has regressed behind the sender's ratchet, e.g. after a backup
 * restore; such a session can never decrypt again and must be reset.
 */
export const isUnrecoverableSessionError = (text) => typeof text === 'string' &&
    /no matching sessions found|no session record|no sessions available|over 2000 messages into the future|chain closed/i.test(text);
/**
 * AunuBaileys: true when a decrypt failure text is a MAC verification
 * failure ("Bad MAC") — the stored session/sender-key state and the
 * sender's state disagree about the message authentication code, the
 * classic symptom of a desynchronised ratchet on either side.
 */
export const isBadMacError = (text) => typeof text === 'string' && /bad mac/i.test(text);
/**
 * AunuBaileys (1.0.78, HB-223): true when a GROUP decrypt failure says
 * nothing about the author's 1-1 E2E session — the sender key simply
 * is not here yet (no record, or no state for that author: they just
 * joined, or our own self-heal deleted it), or the skmsg payload
 * itself is malformed (proto decode error, signature shape). Counting
 * these toward the 3-strike session reset deleted healthy E2E
 * sessions and reported a misleading `healed: true`; the only correct
 * response is the retry receipt, which makes the peer redistribute
 * its sender key. The CIPHERTEXT stub upsert still happens.
 */
export const isSenderKeyUnavailableError = (text) => typeof text === 'string' &&
    (/no session found to decrypt message|no senderkeyrecord found for decryption/i.test(text) ||
        /^invalid signature!?$/i.test(text.trim()) ||
        /invalid wire type|index out of range/i.test(text));
//# sourceMappingURL=decode-wa-message.js.map