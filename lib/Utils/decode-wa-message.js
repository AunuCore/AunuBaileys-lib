import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { areJidsSameUser, isJidBroadcast, isJidGroup, isJidMetaIa, isJidNewsletter, isJidStatusBroadcast, isJidUser, isLidUser } from '../WABinary/index.js';
import { unpadRandomMax16 } from './generics.js';
export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';
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
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = proto.VerifiedNameCertificate.decode(content);
                        const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
                        fullMessage.verifiedBizName = details.verifiedName;
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
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }
                        let msg = proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer);
                        msg = msg.deviceSentMessage?.message || msg;
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
    /no matching sessions found|no session record|no sessions available/i.test(text);
/**
 * AunuBaileys: true when a decrypt failure text is a MAC verification
 * failure ("Bad MAC") — the stored session/sender-key state and the
 * sender's state disagree about the message authentication code, the
 * classic symptom of a desynchronised ratchet on either side.
 */
export const isBadMacError = (text) => typeof text === 'string' && /bad mac/i.test(text);
//# sourceMappingURL=decode-wa-message.js.map