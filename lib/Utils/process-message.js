import { Boom } from '@hapi/boom';
import { waproto } from '../../WAProto/index.js';
import { WAMessageStubType } from '../Types/index.js';
import { getContentType, normalizeMessageContent } from '../Utils/messages.js';
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidStatusBroadcast, isLidUser, jidDecode, jidEncode, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, hmacSign } from './crypto.js';
import { getKeyAuthor, toNumber } from './generics.js';
import { downloadAndProcessHistorySyncNotification } from './history.js';
import { buildMergedTcTokenIndexWrite, resolveTcTokenJid } from './tc-token-utils.js';
const REAL_MSG_STUB_TYPES = new Set([
    WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
    WAMessageStubType.CALL_MISSED_GROUP_VOICE,
    WAMessageStubType.CALL_MISSED_VIDEO,
    WAMessageStubType.CALL_MISSED_VOICE
]);
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD]);
// Exported for the HB-416 addendum 1 regression test (and any host
// that wants to replay history-sync tcTokens without driving the
// full notification download path).
export async function storeTcTokensFromHistorySync(chats, signalRepository, keyStore, logger) {
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
    const candidates = [];
    for (const chat of chats) {
        const ts = chat.tcTokenTimestamp ? toNumber(chat.tcTokenTimestamp) : 0;
        if (chat.tcToken?.length && ts > 0) {
            const jid = jidNormalizedUser(chat.id);
            const storageJid = await resolveTcTokenJid(jid, getLIDForPN);
            candidates.push({
                storageJid,
                token: Buffer.from(chat.tcToken),
                ts,
                senderTs: chat.tcTokenSenderTimestamp ? toNumber(chat.tcTokenSenderTimestamp) : undefined
            });
        }
    }
    if (!candidates.length) {
        return;
    }
    const jids = candidates.map(c => c.storageJid);
    // AunuBaileys (2.5.0, HB-416 addendum 1): a throwing tctoken
    // read used to abort the whole history-sync chunk — the throw
    // escaped this function into the notification handler. A
    // failed read only means the timestamp dedup cannot run —
    // write the tokens as-is and continue to the emit below.
    let existing = {};
    try {
        existing = await keyStore.get('tctoken', jids);
    }
    catch (err) {
        logger?.warn({ err }, 'failed to read existing tctokens from history sync; storing tokens without dedup');
    }
    const entries = {};
    for (const c of candidates) {
        const existingEntry = existing[c.storageJid];
        const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0;
        if (existingTs > 0 && existingTs >= c.ts) {
            continue;
        }
        entries[c.storageJid] = {
            ...existingEntry,
            token: c.token,
            timestamp: String(c.ts),
            ...(c.senderTs !== undefined ? { senderTimestamp: c.senderTs } : {})
        };
    }
    if (Object.keys(entries).length) {
        logger?.debug({ count: Object.keys(entries).length }, 'storing tctokens from history sync');
        try {
            // Include updated __index so cross-session pruning picks these JIDs up.
            const indexWrite = await buildMergedTcTokenIndexWrite(keyStore, Object.keys(entries));
            await keyStore.set({ tctoken: { ...entries, ...indexWrite } });
        }
        catch (err) {
            logger?.warn({ err }, 'failed to store tctokens from history sync');
        }
    }
}
/** Cleans a received message to further processing */
export const cleanMessage = (message, meId, meLid) => {
    // ensure remoteJid and participant doesn't have device or agent in it
    if (isHostedPnUser(message.key.remoteJid) || isHostedLidUser(message.key.remoteJid)) {
        message.key.remoteJid = jidEncode(jidDecode(message.key?.remoteJid)?.user, isHostedPnUser(message.key.remoteJid) ? 's.whatsapp.net' : 'lid');
    }
    else {
        message.key.remoteJid = jidNormalizedUser(message.key.remoteJid);
    }
    if (isHostedPnUser(message.key.participant) || isHostedLidUser(message.key.participant)) {
        message.key.participant = jidEncode(jidDecode(message.key.participant)?.user, isHostedPnUser(message.key.participant) ? 's.whatsapp.net' : 'lid');
    }
    else {
        message.key.participant = jidNormalizedUser(message.key.participant);
    }
    const content = normalizeMessageContent(message.message);
    // if the message has a reaction, ensure fromMe & remoteJid are from our perspective
    if (content?.reactionMessage) {
        normaliseKey(content.reactionMessage.key);
    }
    if (content?.pollUpdateMessage) {
        normaliseKey(content.pollUpdateMessage.pollCreationMessageKey);
    }
    function normaliseKey(msgKey) {
        // AunuBaileys (2.2.0, HB-2026-1112-57 addendum): the v6
        // guard was lost in the v7 rebase — a reaction / poll update
        // whose proto key is absent (or null after decode) threw a
        // raw TypeError here and the message was never upserted.
        if (!msgKey) {
            return;
        }
        // if the reaction is from another user
        // we've to correctly map the key to this user's perspective
        if (!message.key.fromMe) {
            // if the sender believed the message being reacted to is not from them
            // we've to correct the key to be from them, or some other participant
            msgKey.fromMe = !msgKey.fromMe
                ? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) ||
                    areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid)
                : // if the message being reacted to, was from them
                    // fromMe automatically becomes false
                    false;
            // set the remoteJid to being the same as the chat the message came from
            // TODO: investigate inconsistencies
            msgKey.remoteJid = message.key.remoteJid;
            // set participant of the message
            msgKey.participant = msgKey.participant || message.key.participant;
        }
    }
};
// TODO: target:audit AUDIT THIS FUNCTION AGAIN
export const isRealMessage = (message) => {
    const normalizedContent = normalizeMessageContent(message.message);
    const hasSomeContent = !!getContentType(normalizedContent);
    return ((!!normalizedContent ||
        REAL_MSG_STUB_TYPES.has(message.messageStubType) ||
        REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) &&
        hasSomeContent &&
        !normalizedContent?.protocolMessage &&
        !normalizedContent?.reactionMessage &&
        !normalizedContent?.pollUpdateMessage);
};
export const shouldIncrementChatUnread = (message) => !message.key.fromMe && !message.messageStubType;
/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
export const getChatId = ({ remoteJid, participant, fromMe }) => {
    if (!remoteJid) {
        throw new Boom('Cannot derive chat id: message key is missing remoteJid', {
            data: { remoteJid, participant, fromMe }
        });
    }
    if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
        if (!participant) {
            throw new Boom('Cannot derive chat id: broadcast message key is missing participant', {
                data: { remoteJid, fromMe }
            });
        }
        return participant;
    }
    return remoteJid;
};
/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
export function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
    const sign = Buffer.concat([
        toBinary(pollMsgId),
        toBinary(pollCreatorJid),
        toBinary(voterJid),
        toBinary('Poll Vote'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${pollMsgId}\u0000${voterJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    return waproto.Message.PollVoteMessage.decode(decrypted);
    function toBinary(txt) {
        return Buffer.from(txt);
    }
}
/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
export function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
    const sign = Buffer.concat([
        toBinary(eventMsgId),
        toBinary(eventCreatorJid),
        toBinary(responderJid),
        toBinary('Event Response'),
        new Uint8Array([1])
    ]);
    const key0 = hmacSign(eventEncKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const aad = toBinary(`${eventMsgId}\u0000${responderJid}`);
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
    return waproto.Message.EventResponseMessage.decode(decrypted);
    function toBinary(txt) {
        return Buffer.from(txt);
    }
}
const processMessage = async (message, { shouldProcessHistoryMsg, historySyncSink, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }) => {
    // AunuBaileys (1.0.79, HB-131, re-applied P3): me is undefined
    // until pairing completes \u2014 a bare deref crashed history sync
    // for unpaired states; the comparisons below tolerate undefined.
    // AunuBaileys (2.8.0, HB-388 addendum 1): set when a history-sync
    // download/process attempt fails — returned to the caller (chats
    // upsertMessage) so the failure is not swallowed: the caller
    // keeps the chunk retryable and does not complete the sync.
    let historySyncDownloadFailed = false;
    const meId = creds.me?.id ?? '';
    // AunuBaileys (2.3.0, HB-391): own LID is needed alongside the PN id to recognise self in LID-addressed groups.
    const meLid = creds.me?.lid ?? '';
    const { accountSettings } = creds;
    const chat = { id: jidNormalizedUser(getChatId(message.key)) };
    const isRealMsg = isRealMessage(message);
    if (isRealMsg) {
        chat.messages = [{ message }];
        chat.conversationTimestamp = toNumber(message.messageTimestamp);
        // only increment unread count if not CIPHERTEXT and from another person
        if (shouldIncrementChatUnread(message)) {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
    }
    const content = normalizeMessageContent(message.message);
    // unarchive chat if it's a real message, or someone reacted to our message
    // and we've the unarchive chats setting on
    if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
        chat.archived = false;
        chat.readOnly = false;
    }
    const protocolMsg = content?.protocolMessage;
    if (protocolMsg) {
        // Mirror whatsmeow's `handleProtocolMessage` guard, but applied only to
        // the protocol message types that originate from our own device — an
        // attacker could otherwise spoof any of these to manipulate local state.
        //
        // Self-only types (drop if `!fromMe`):
        //   - HISTORY_SYNC_NOTIFICATION                 (our phone driving history sync)
        //   - APP_STATE_SYNC_KEY_SHARE                  (key share between our devices)
        //   - LID_MIGRATION_MAPPING_SYNC                (server-initiated via our phone)
        //   - PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE (response from our phone to our PDO request)
        //
        // Cross-user types (must NOT be dropped — legitimately arrive from others):
        //   - REVOKE
        //   - MESSAGE_EDIT
        //   - EPHEMERAL_SETTING
        //   - GROUP_MEMBER_LABEL_CHANGE
        //
        // See https://github.com/tulir/whatsmeow/blob/8d3700152a/message.go#L842-L845
        // for the reference architecture — whatsmeow's `handleProtocolMessage`
        // only contains self-only types because edits are unwrapped from
        // `EditedMessage` BEFORE this dispatch and revokes aren't routed here.
        const SELF_ONLY_TYPES = new Set([
            waproto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
            waproto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
            waproto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
            waproto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
        ]);
        if (protocolMsg.type !== null &&
            protocolMsg.type !== undefined &&
            SELF_ONLY_TYPES.has(protocolMsg.type) &&
            !message.key.fromMe) {
            logger?.warn({ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid }, 'dropping spoofed self-only protocolMessage from non-self origin');
            return { historySyncDownloadFailed };
        }
        switch (protocolMsg.type) {
            case waproto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
                const histNotification = protocolMsg.historySyncNotification;
                const process = shouldProcessHistoryMsg;
                const isLatest = !creds.processedHistoryMessages?.length;
                logger?.info({
                    histNotification,
                    process,
                    id: message.key.id,
                    isLatest
                }, 'got history notification');
                if (process) {
                    // AunuBaileys (2.3.0, HB-388): download and process FIRST, mark processed only after success — the old order emitted the processedHistoryMessages mark before downloadAndProcessHistorySyncNotification, so a failed inflate/download lost the chunk silently (receipt already sent, no redelivery) while creds already claimed it processed. A download failure is now logged and swallowed instead of rejecting upsertMessage, leaving the chunk unmarked for a later sync.
                    let data;
                    // A notification with neither an inline payload nor a
                    // directPath carries no chunk to download — it is a
                    // progress-only signal, so there is no download that
                    // could fail (HB-443 status fixtures rely on this).
                    const hasDownloadablePayload = !!histNotification.initialHistBootstrapInlinePayload || !!histNotification.directPath;
                    try {
                        if (hasDownloadablePayload) {
                            data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger, historySyncSink);
                        }
                    }
                    catch (err) {
                        // AunuBaileys (2.8.0, HB-388 addendum 1): the
                        // failure is still not rethrown here (the chunk
                        // stays unmarked, per HB-388), but it is no
                        // longer swallowed silently — it is reported
                        // in the return value so upsertMessage can
                        // refuse the dedup mark and the 'complete'
                        // status for this chunk.
                        historySyncDownloadFailed = true;
                        logger?.warn({ err, msgId: message.key.id }, 'failed to download/process history sync notification — chunk not marked processed');
                    }
                    if (data) {
                        if (data.lidPnMappings?.length) {
                            logger?.debug({ count: data.lidPnMappings.length }, 'processing LID-PN mappings from history sync');
                            await signalRepository.lidMapping
                                .storeLIDPNMappings(data.lidPnMappings)
                                .catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'));
                        }
                        await storeTcTokensFromHistorySync(data.chats, signalRepository, keyStore, logger);
                        // TODO: investigate
                        if (histNotification.syncType !== waproto.HistorySync.HistorySyncType.ON_DEMAND) {
                            // AunuBaileys (HB-259, re-applied P3): every bare
                            // 'creds.update' emit is guarded \u2014 the event is not
                            // bufferable, so a throwing host listener (e.g. saveCreds)
                            // used to reject the surrounding stanza handler and lose
                            // the work that followed the emit. Log and continue.
                            try {
                                ev.emit('creds.update', {
                                    // AunuBaileys (2.1.0, HB-306): v6 capped this list at 50 — restore the cap so a long history sync cannot grow creds without bound.
                                    processedHistoryMessages: [
                                        ...(creds.processedHistoryMessages || []).slice(-49),
                                        { key: message.key, messageTimestamp: message.messageTimestamp }
                                    ]
                                });
                            }
                            catch (err) { }
                        }
                        ev.emit('messaging-history.set', {
                            ...data,
                            isLatest: histNotification.syncType !== waproto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
                            chunkOrder: histNotification.chunkOrder,
                            peerDataRequestSessionId: histNotification.peerDataRequestSessionId
                        });
                    }
                }
                break;
            case waproto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
                // AunuBaileys (2.9.0, L1): appStateSyncKeyShare is an
                // optional proto field — a self-only share message
                // without it derefed through the old non-null assertion
                // and killed message processing with a raw TypeError.
                // Absent share/keys now lands in the 0-keys path below.
                const keys = protocolMsg.appStateSyncKeyShare?.keys;
                if (keys?.length) {
                    let newAppStateSyncKeyId = '';
                    // AunuBaileys (2.6.0, HB-454 facet B): the whole
                    // transaction used to be a bare await — a transient
                    // host-store failure rejected the protocol case and
                    // aborted the stanza handler, losing the share. Log
                    // and continue; the next key share re-injects the keys.
                    // newAppStateSyncKeyId stays '' on failure, so the
                    // adoption below is skipped automatically.
                    try {
                        await keyStore.transaction(async () => {
                            const newKeys = [];
                            for (const { keyData, keyId } of keys) {
                                // AunuBaileys (1.0.88, HB-135 + keyData facet,
                                // re-applied P3b): an entry whose keyId message
                                // is absent decodes as keyId: null — the bare
                                // Buffer.from(keyId.keyId) below threw, and
                                // every key AFTER the bad entry in the same
                                // share was never injected. Worse, an entry
                                // with a keyId but NO keyData stored null AND
                                // was adopted as myAppStateKeyId, so
                                // getAppStateSyncKey returned null downstream
                                // and the collection stopped syncing. Skip a
                                // malformed entry per-item; the rest of the
                                // share still injects.
                                const rawKeyId = keyId?.keyId;
                                if (!rawKeyId || !rawKeyId.length || !keyData?.keyData || !keyData.keyData.length) {
                                    logger?.warn({ keyId: keyId ?? null }, 'aunu: skipping a malformed app-state sync key in the share (missing keyId or keyData); the remaining keys still inject');
                                    continue;
                                }
                                const strKeyId = Buffer.from(rawKeyId).toString('base64');
                                newKeys.push(strKeyId);
                                await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } });
                                newAppStateSyncKeyId = strKeyId;
                            }
                            logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys');
                        }, meId);
                    }
                    catch (err) {
                        logger?.warn({ err }, 'failed to inject app state sync keys — the share may be re-sent; continuing');
                    }
                    // AunuBaileys (1.0.88, HB-135, re-applied P3b): adopt a
                    // new myAppStateKeyId only when a valid key was
                    // actually injected — an all-malformed share used to
                    // emit the empty initial value here.
                    if (newAppStateSyncKeyId) {
                        try {
                            ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId });
                        }
                        catch (err) {
                            logger?.error({ err }, 'error in creds.update listener — continuing');
                        }
                    }
                }
                else {
                    logger?.info({ protocolMsg }, 'recv app state sync with 0 keys');
                }
                break;
            case waproto.Message.ProtocolMessage.Type.REVOKE:
                // AunuBaileys (2.1.0, HB-311): a REVOKE without a key used to throw here — skip the emit instead.
                if (!protocolMsg.key?.id) {
                    logger?.warn({ protocolMsg }, 'recv REVOKE without a message key — skipping');
                    break;
                }
                ev.emit('messages.update', [
                    {
                        key: {
                            ...message.key,
                            id: protocolMsg.key.id
                        },
                        update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key }
                    }
                ]);
                break;
            case waproto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
                Object.assign(chat, {
                    ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
                    ephemeralExpiration: protocolMsg.ephemeralExpiration || null
                });
                break;
            case waproto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
                const response = protocolMsg.peerDataOperationRequestResponseMessage;
                if (response) {
                    // TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
                    const peerDataOperationResult = response.peerDataOperationResult || [];
                    for (const result of peerDataOperationResult) {
                        const retryResponse = result?.placeholderMessageResendResponse;
                        //eslint-disable-next-line max-depth
                        if (!retryResponse?.webMessageInfoBytes) {
                            continue;
                        }
                        //eslint-disable-next-line max-depth
                        try {
                            const webMessageInfo = waproto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes);
                            const msgId = webMessageInfo.key?.id;
                            // Retrieve cached original message data (preserves LID details,
                            // timestamps, etc. that the phone may omit in its PDO response)
                            const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined;
                            //eslint-disable-next-line max-depth
                            if (msgId) {
                                await placeholderResendCache?.del(msgId);
                            }
                            let finalMsg;
                            //eslint-disable-next-line max-depth
                            if (cachedData && typeof cachedData === 'object') {
                                // Apply decoded message content onto cached metadata (preserves LID etc.)
                                cachedData.message = webMessageInfo.message;
                                //eslint-disable-next-line max-depth
                                if (webMessageInfo.messageTimestamp) {
                                    cachedData.messageTimestamp = webMessageInfo.messageTimestamp;
                                }
                                finalMsg = cachedData;
                            }
                            else {
                                finalMsg = webMessageInfo;
                            }
                            logger?.debug({ msgId, requestId: response.stanzaId }, 'received placeholder resend');
                            ev.emit('messages.upsert', {
                                messages: [finalMsg],
                                type: 'notify',
                                requestId: response.stanzaId
                            });
                        }
                        catch (err) {
                            logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response');
                        }
                    }
                }
                break;
            case waproto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
                ev.emit('messages.update', [
                    {
                        // flip the sender / fromMe properties because they're in the perspective of the sender
                        key: { ...message.key, id: protocolMsg.key?.id },
                        update: {
                            message: {
                                editedMessage: {
                                    message: protocolMsg.editedMessage
                                }
                            },
                            messageTimestamp: protocolMsg.timestampMs
                                ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
                                : message.messageTimestamp
                        }
                    }
                ]);
                break;
            case waproto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE:
                const labelAssociationMsg = protocolMsg.memberLabel;
                if (labelAssociationMsg?.label) {
                    ev.emit('group.member-tag.update', {
                        groupId: chat.id,
                        label: labelAssociationMsg.label,
                        participant: message.key.participant,
                        participantAlt: message.key.participantAlt,
                        messageTimestamp: Number(message.messageTimestamp)
                    });
                }
                break;
            case waproto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
                // AunuBaileys (2.9.0, L1): the sync message and its
                // encoded payload are optional proto fields — a
                // self-only sync message without them fed `undefined`
                // into decode() and killed message processing with a
                // raw TypeError. Skip the handler silently; the server
                // re-sends the sync with the next migration event.
                const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload;
                if (!encodedPayload?.length) {
                    logger?.debug('skipping LID migration mapping sync without an encoded payload');
                    break;
                }
                const { pnToLidMappings, chatDbMigrationTimestamp } = waproto.LIDMigrationMappingSyncPayload.decode(encodedPayload);
                logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp');
                const pairs = [];
                for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
                    const lid = latestLid || assignedLid;
                    pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` });
                }
                // AunuBaileys (2.6.0, HB-454 facet A): the store write
                // used to be a bare await — a transient host-store
                // failure rejected the whole protocol case and aborted
                // the stanza handler, and a failing migrateSession for
                // one pair aborted the pairs after it. Mirror the
                // HISTORY_SYNC_NOTIFICATION pattern above: log and
                // continue; the server re-sends the sync on the next
                // migration event.
                await signalRepository.lidMapping.storeLIDPNMappings(pairs).catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from LID migration sync'));
                if (pairs.length) {
                    for (const { pn, lid } of pairs) {
                        try {
                            await signalRepository.migrateSession(pn, lid);
                        }
                        catch (err) {
                            logger?.warn({ err, pn, lid }, 'failed to migrate session for a LID mapping pair — continuing with the next pair');
                        }
                    }
                }
        }
    }
    else if (content?.reactionMessage) {
        const reaction = {
            ...content.reactionMessage,
            key: message.key
        };
        // AunuBaileys (1.0.86, HB-187, re-applied P3b): reactionMessage.key is
        // an optional proto field — a reaction without it was emitted with
        // key === undefined and detonated downstream (the event-buffer append
        // and the in-memory store both deref key.remoteJid) with a raw
        // TypeError, after the delivery receipt had already been sent. The
        // reaction has no target message; do not emit it at all.
        if (content.reactionMessage.key) {
            ev.emit('messages.reaction', [
                {
                    reaction,
                    key: content.reactionMessage.key
                }
            ]);
        }
    }
    else if (content?.encEventResponseMessage) {
        const encEventResponse = content.encEventResponseMessage;
        const creationMsgKey = encEventResponse.eventCreationMessageKey;
        // we need to fetch the event creation message to get the event enc key
        // AunuBaileys (2.6.0, HB-107 addendum): a throwing host
        // getMessage here used to reject the whole processMessage —
        // AFTER the delivery receipt was already sent, so the server
        // never redelivered and the event response (RSVP) was lost
        // silently. Treat a throw like "creation message not found"
        // (the else branch below): warn and skip the decrypt,
        // mirroring the per-id HB-107 guard on the receive path.
        let eventMsg;
        try {
            eventMsg = await getMessage(creationMsgKey);
        }
        catch (err) {
            logger?.warn({ err, creationMsgKey }, 'event response: failed to fetch creation message, cannot decrypt response');
        }
        if (eventMsg) {
            try {
                const meIdNormalised = jidNormalizedUser(meId);
                // all jids need to be PN
                const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid;
                const eventCreatorPn = isLidUser(eventCreatorKey)
                    ? await signalRepository.lidMapping.getPNForLID(eventCreatorKey)
                    : eventCreatorKey;
                const eventCreatorJid = getKeyAuthor({ remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn }, meIdNormalised);
                const responderJid = getKeyAuthor(message.key, meIdNormalised);
                // AunuBaileys (2.9.0, HB-2026-1113-223 addendum
                // ke-12, sibling site): host stores may return the
                // full WAMessage — the secret lives under
                // .message.messageContextInfo there, not at the top
                // level. Unwrap like sendMessagesAgain does; a plain
                // IMessage has no top-level `message` field, so the
                // fallback is a no-op for unwrapped stores.
                const eventContent = eventMsg?.message ?? eventMsg;
                const eventEncKey = eventContent?.messageContextInfo?.messageSecret;
                if (!eventEncKey) {
                    logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption');
                }
                else {
                    const responseMsg = decryptEventResponse(encEventResponse, {
                        eventEncKey,
                        eventCreatorJid,
                        eventMsgId: creationMsgKey.id,
                        responderJid
                    });
                    const eventResponse = {
                        eventResponseMessageKey: message.key,
                        senderTimestampMs: responseMsg.timestampMs,
                        response: responseMsg
                    };
                    ev.emit('messages.update', [
                        {
                            key: creationMsgKey,
                            update: {
                                eventResponses: [eventResponse]
                            }
                        }
                    ]);
                }
            }
            catch (err) {
                logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response');
            }
        }
        else {
            logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response');
        }
    }
    else if (message.messageStubType) {
        const jid = message.key?.remoteJid;
        //let actor = whatsappID (message.participant)
        let participants;
        const emitParticipantsUpdate = (action) => ev.emit('group-participants.update', {
            id: jid,
            author: message.key.participant,
            authorPn: message.key.participantAlt,
            authorUsername: message.key.participantUsername,
            participants,
            action
        });
        const emitGroupUpdate = (update) => {
            ev.emit('groups.update', [
                {
                    id: jid,
                    ...update,
                    author: message.key.participant ?? undefined,
                    authorPn: message.key.participantAlt,
                    authorUsername: message.key.participantUsername
                }
            ]);
        };
        const emitGroupRequestJoin = (participant, action, method) => {
            ev.emit('group.join-request', {
                id: jid,
                author: message.key.participant,
                authorPn: message.key.participantAlt,
                authorUsername: message.key.participantUsername,
                participant: participant.lid,
                participantPn: participant.pn,
                action,
                method: method
            });
        };
        // AunuBaileys (2.3.0, HB-391): compare me.lid against the participant's id/lid as well as me.id against phoneNumber/id — a lid-only stanza carries no phone_number, so self add/remove/leave in a LID group was never recognised and chat.readOnly stayed wrong. Guard both sides of every comparison so areJidsSameUser(undefined, undefined) === true cannot false-positive on a malformed entry.
        const participantsIncludesMe = () => participants.find(p => !!p &&
            ((!!meId && !!p.phoneNumber && areJidsSameUser(meId, p.phoneNumber)) ||
                (!!meId && !!p.id && areJidsSameUser(meId, p.id)) ||
                (!!meLid && !!p.id && areJidsSameUser(meLid, p.id)) ||
                (!!meLid && !!p.lid && areJidsSameUser(meLid, p.lid))));
        // AunuBaileys (2.2.0, HB-320 addendum): the tolerant parse
        // HB-320 gave CHANGE_NUMBER, shared by every sibling case
        // below — they kept a bare JSON.parse, so one non-JSON stub
        // parameter (e.g. JSON.stringify(undefined) from an
        // invite-accept producer) threw SyntaxError inside
        // processMessage and the upsert was rejected.
        const parseStubParticipants = () => message.messageStubParameters.map((a) => {
            if (typeof a !== 'string') {
                return a;
            }
            try {
                return JSON.parse(a);
            }
            catch {
                return a;
            }
        }) || [];
        switch (message.messageStubType) {
            case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
                // AunuBaileys (2.1.0, HB-320): the producer stores the old/new numbers here as RAW JID strings, so a bare JSON.parse threw on every 'modify' event. Parse when the entry is JSON, else use it raw.
                participants = parseStubParticipants();
                emitParticipantsUpdate('modify');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
            case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                participants = parseStubParticipants();
                emitParticipantsUpdate('remove');
                // mark the chat read only if you left the group
                if (participantsIncludesMe()) {
                    chat.readOnly = true;
                }
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_ADD:
            case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
            case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                participants = parseStubParticipants();
                if (participantsIncludesMe()) {
                    chat.readOnly = false;
                }
                emitParticipantsUpdate('add');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
                participants = parseStubParticipants();
                emitParticipantsUpdate('demote');
                break;
            case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
                participants = parseStubParticipants();
                emitParticipantsUpdate('promote');
                break;
            case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                const announceValue = message.messageStubParameters?.[0];
                // AunuBaileys (2.4.0, HB-411 addendum): a parameter-less
                // stub carries no value at all — coercing the missing
                // parameter to `false` flipped a stored `true` the stub
                // never mentioned. Skip the update when it is absent.
                if (announceValue !== undefined) {
                    emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' });
                }
                break;
            case WAMessageStubType.GROUP_CHANGE_RESTRICT:
                const restrictValue = message.messageStubParameters?.[0];
                if (restrictValue !== undefined) {
                    emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' });
                }
                break;
            case WAMessageStubType.GROUP_CHANGE_SUBJECT:
                const name = message.messageStubParameters?.[0];
                chat.name = name;
                // AunuBaileys (2.4.0, HB-411 addendum 5): the sibling
                // owner/time fields belong to the same change — leaving
                // them out kept the PREVIOUS owner and timestamp in the
                // store next to the new subject.
                emitGroupUpdate({
                    subject: name,
                    subjectOwner: message.key.participant ?? undefined,
                    subjectOwnerPn: message.key.participantAlt,
                    subjectOwnerUsername: message.key.participantUsername,
                    subjectTime: toNumber(message.messageTimestamp)
                });
                break;
            case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
                const description = message.messageStubParameters?.[0];
                chat.description = description;
                emitGroupUpdate({
                    desc: description,
                    descOwner: message.key.participant ?? undefined,
                    descOwnerPn: message.key.participantAlt,
                    descOwnerUsername: message.key.participantUsername,
                    descTime: toNumber(message.messageTimestamp)
                });
                break;
            case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
                const code = message.messageStubParameters?.[0];
                emitGroupUpdate({ inviteCode: code });
                break;
            case WAMessageStubType.GROUP_MEMBER_ADD_MODE:
                const memberAddValue = message.messageStubParameters?.[0];
                if (memberAddValue !== undefined) {
                    emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' });
                }
                break;
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
                const approvalMode = message.messageStubParameters?.[0];
                if (approvalMode !== undefined) {
                    emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' });
                }
                break;
            case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: // TODO: Add other events
                // AunuBaileys (2.1.0, sweep): JSON.parse(undefined) throws —
                // a history-sync message of this stub type without parameters
                // used to kill the whole message. Skip it per-message.
                const rawParticipant = message.messageStubParameters?.[0];
                if (typeof rawParticipant !== 'string') {
                    logger?.warn('skipping join-approval-request event without a participant parameter');
                    break;
                }
                let participant;
                try {
                    participant = JSON.parse(rawParticipant);
                }
                catch {
                    logger?.warn('skipping join-approval-request event with an unparseable participant parameter');
                    break;
                }
                // AunuBaileys (2.7.0, HB-2026-1112-40 addendum 5,
                // consumer side): a stub whose participant carries
                // neither lid nor pn and whose key names no actor is a
                // phantom (e.g. from a double-malformed notification
                // replayed via history sync) — never emit a
                // group.join-request for nobody.
                // AunuBaileys (2.8.0, HB-320 addendum): JSON.parse('null')
                // succeeds and yields null — the optional-chain guard
                // below passed when an actor was present, and
                // emitGroupRequestJoin then derefed participant.lid on
                // null. A null participant is no participant at all.
                if (!participant || (!participant?.lid && !participant?.pn && !message.key.participant && !message.key.participantAlt)) {
                    logger?.warn('skipping join-approval-request event with no participant and no actor');
                    break;
                }
                const action = message.messageStubParameters?.[1];
                const method = message.messageStubParameters?.[2];
                emitGroupRequestJoin(participant, action, method);
                break;
        }
    } /*  else if(content?.pollUpdateMessage) {
        const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey!
        // we need to fetch the poll creation message to get the poll enc key
        // TODO: make standalone, remove getMessage reference
        // TODO: Remove entirely
        const pollMsg = await getMessage(creationMsgKey)
        if(pollMsg) {
            const meIdNormalised = jidNormalizedUser(meId)
            const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised)
            const voterJid = getKeyAuthor(message.key, meIdNormalised)
            const pollEncKey = pollMsg.messageContextInfo?.messageSecret!

            try {
                const voteMsg = decryptPollVote(
                    content.pollUpdateMessage.vote!,
                    {
                        pollEncKey,
                        pollCreatorJid,
                        pollMsgId: creationMsgKey.id!,
                        voterJid,
                    }
                )
                ev.emit('messages.update', [
                    {
                        key: creationMsgKey,
                        update: {
                            pollUpdates: [
                                {
                                    pollUpdateMessageKey: message.key,
                                    vote: voteMsg,
                                    senderTimestampMs: (content.pollUpdateMessage.senderTimestampMs! as Long).toNumber(),
                                }
                            ]
                        }
                    }
                ])
            } catch(err) {
                logger?.warn(
                    { err, creationMsgKey },
                    'failed to decrypt poll vote'
                )
            }
        } else {
            logger?.warn(
                { creationMsgKey },
                'poll creation message not found, cannot decrypt update'
            )
        }
        } */
    if (Object.keys(chat).length > 1) {
        ev.emit('chats.update', [chat]);
    }
    return { historySyncDownloadFailed };
};
export default processMessage;
//# sourceMappingURL=process-message.js.map