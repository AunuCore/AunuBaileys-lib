import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { areJidsSameUser, isJidBroadcast, isJidGroup, isJidMetaIa, isJidNewsletter, isJidStatusBroadcast, isJidUser, isLidUser } from '../WABinary/index.js';
import { unpadRandomMax16 } from './generics.js';
import { decodeDecryptedMsmsgMessage, decryptMsmsgBotMessage } from './meta-ai-msmsg.js';
export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';
// AunuBaileys (1.0.71): outgoing @bot message id → messageSecret.
// Populated when we send to @bot (or see our own echo / recover it from
// the message store after a restart), consumed when the msmsg response
// from @bot arrives and needs decrypting. Verbatim design from the
// donor's decode-wa-message.js. In-memory only — a restart loses it,
// which is why messages-recv.js re-seeds it from getMessage() first.
const MAX_SECRETS_PER_CHAT = 20;
const MAX_RECENT_CHATS = 1000;
const botMessageSecrets = new Map();
const botRecentSecretsByChat = new Map();
const pushRecentChatSecret = (chatJid, id, secretBuf) => {
    if (!chatJid || !secretBuf) {
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
    if (!id || !secret) {
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
export const NACK_REASONS = {
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
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza, meId, meLid) {
    let msgType;
    let chatId;
    let author;
    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;
    const isMe = (jid) => areJidsSameUser(jid, meId);
    const isMeLid = (jid) => areJidsSameUser(jid, meLid);
    if (isJidUser(from) || isLidUser(from)) {
        if (recipient && !isJidMetaIa(recipient)) {
            if (!isMe(from) && !isMeLid(from)) {
                throw new Boom('receipient present, but msg not from me', { data: stanza });
            }
            chatId = recipient;
        }
        else {
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    }
    else if (isJidGroup(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
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
        chatId = from;
        author = participant;
    }
    else if (isJidMetaIa(from)) {
        // AunuBaileys (1.0.71): @bot responses (Meta AI) arrive from a
        // bare @bot jid — treat them as a 1:1 chat (donor design).
        msgType = 'chat';
        chatId = from;
        author = from;
    }
    else if (isJidNewsletter(from)) {
        msgType = 'newsletter';
        chatId = from;
        author = from;
    }
    else {
        throw new Boom('Unknown message type', { data: stanza });
    }
    // Check the sender against both our PN and LID identities — picking only
    // one based on `from`'s format misses peer-routed self stanzas (history
    // sync, app-state sync, etc.) when `from` and our stored identity are in
    // different formats, leaving fromMe wrongly false.
    const senderJid = (stanza.attrs.participant || stanza.attrs.from);
    const fromMe = isMe(senderJid) || isMeLid(senderJid);
    const pushname = stanza?.attrs?.notify;
    const key = {
        remoteJid: chatId,
        fromMe,
        id: msgId,
        senderLid: stanza?.attrs?.sender_lid,
        senderPn: stanza?.attrs?.sender_pn,
        participant,
        participantPn: stanza?.attrs?.participant_pn,
        participantLid: stanza?.attrs?.participant_lid,
        ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
    };
    const fullMessage = {
        key,
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
// AunuBaileys: per-address throttle for the per-message decrypt error log.
// One rotten session can fail hundreds of messages in minutes (B-01: every
// failure from a single LID address flooded the logs at ERROR level); the
// first failure per address logs immediately, then at most one line per
// minute, carrying how many failures were suppressed in between. Nothing
// about the failure handling itself changes — only the log volume.
const DECRYPT_ERROR_LOG_INTERVAL_MS = 60_000;
const decryptErrorLogState = new Map();
const logDecryptErrorThrottled = (logger, address, key, err) => {
    const now = Date.now();
    const state = decryptErrorLogState.get(address) || { lastLoggedAt: 0, suppressed: 0 };
    if (now - state.lastLoggedAt >= DECRYPT_ERROR_LOG_INTERVAL_MS) {
        logger.error({ key, err, suppressedFailures: state.suppressed }, 'failed to decrypt message');
        decryptErrorLogState.set(address, { lastLoggedAt: now, suppressed: 0 });
    }
    else {
        decryptErrorLogState.set(address, { ...state, suppressed: state.suppressed + 1 });
    }
    // AunuBaileys (1.0.70): cap the map — one small entry per address
    // that ever failed decryption, for the life of the process, is
    // unbounded growth in disguise.
    while (decryptErrorLogState.size > 1000) {
        decryptErrorLogState.delete(decryptErrorLogState.keys().next().value);
    }
};

export const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            let decryptables = 0;
            if (Array.isArray(stanza.content)) {
                // AunuBaileys (1.0.71): msmsg replies carry their key
                // material in sibling <meta>/<bot> nodes, so collect
                // those before walking the enc nodes (donor design).
                let metaTargetId = null;
                let metaTargetSenderJid = null;
                let botEditTargetId = null;
                let botType = null;
                if (stanza.content.some(n => n?.attrs?.type === 'msmsg')) {
                    for (const { tag, attrs } of stanza.content) {
                        if (tag === 'meta' && attrs?.target_id) {
                            metaTargetId = attrs.target_id;
                        }
                        if (tag === 'meta' && attrs?.target_sender_jid) {
                            metaTargetSenderJid = attrs.target_sender_jid;
                        }
                        if (tag === 'bot' && attrs && 'edit_target_id' in attrs) {
                            botEditTargetId = attrs.edit_target_id; // can be '' for the 'first' type
                        }
                        if (tag === 'bot' && attrs?.edit) {
                            botType = attrs.edit;
                        }
                    }
                }
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        // AunuBaileys (1.0.67): a malformed certificate
                        // (missing details / truncated bytes) must not
                        // kill decryption of the actual message — skip
                        // the certificate and carry on.
                        try {
                            const cert = proto.VerifiedNameCertificate.decode(content);
                            const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
                            fullMessage.verifiedBizName = details.verifiedName;
                        }
                        catch { }
                    }
                    if (tag === 'unavailable' && attrs.type === 'view_once') {
                        fullMessage.key.isViewOnce = true;
                    }
                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }
                    if (!(content instanceof Uint8Array)) {
                        continue;
                    }
                    decryptables += 1;
                    let msgBuffer;
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
                                const user = isJidUser(sender) ? sender : author;
                                msgBuffer = await repository.decryptMessage({
                                    jid: user,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            case 'msmsg': {
                                // AunuBaileys (1.0.71): botType null =
                                // non-streaming (no <bot> node), 'full' /
                                // 'last' = complete response, 'first' =
                                // streaming partial, intentionally skipped.
                                if (botType !== null && !['full', 'last'].includes(botType)) {
                                    break;
                                }
                                const secretIdCandidates = [botEditTargetId, metaTargetId, fullMessage.key?.id].filter(Boolean);
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
                                    const fp = item.secret.toString('hex');
                                    if (!seenSecrets.has(fp)) {
                                        seenSecrets.add(fp);
                                        secretCandidates.push({ source: `chat:${item.id}`, secret: item.secret });
                                    }
                                    if (secretCandidates.length >= 6) {
                                        break;
                                    }
                                }
                                if (!secretCandidates.length) {
                                    logger.warn({ metaTargetId, botType, secretIdCandidates }, 'msmsg: no candidate messageSecret found, skipping');
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
                                        cause: decryptErr?.message
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
                            // AunuBaileys (1.0.71): a skipped streaming
                            // msmsg partial leaves nothing to decode.
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
                                logDecryptErrorThrottled(logger, author, fullMessage.key, err);
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
                        logDecryptErrorThrottled(logger, author, fullMessage.key, err);
                        fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                        fullMessage.messageStubParameters = [err.message];
                    }
                }
            }
            // AunuBaileys: a stanza can carry several <enc> nodes;
            // when at least one decrypted, the message is real — a
            // CIPHERTEXT stub left behind by a sibling node's failure
            // must not poison it (consumers would treat a delivered
            // message as undelivered and fire retry receipts for
            // content already in hand).
            if (fullMessage.message && fullMessage.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
                delete fullMessage.messageStubType;
                delete fullMessage.messageStubParameters;
            }
            // if nothing was found to decrypt
            if (!decryptables) {
                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
            }
        }
    };
};
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