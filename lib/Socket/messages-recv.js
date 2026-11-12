import { makeBoundedTTLCache } from '../Utils/bounded-cache.js';
import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import Long from 'long';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from '../Defaults/index.js';
import { WAMessageStatus, WAMessageStubType } from '../Types/index.js';
import { aesDecryptCTR, aesEncryptGCM, cleanMessage, Curve, decodeMediaRetryNode, decodeMessageNode, decryptMessageNode, delay, derivePairingCodeKey, encodeBigEndian, encodeSignedDeviceIdentity, getCallStatusFromNode, getHistoryMsg, getNextPreKeys, getStatusFromReceiptType, hkdf, isBadMacError, isUnrecoverableSessionError, MISSING_KEYS_ERROR_TEXT, NACK_REASONS, NO_MESSAGE_FOUND_ERROR_TEXT, buildCallControlStanza, parseRetryReceiptSession, setBotMessageSecret, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey } from '../Utils/index.js';
import { makeMutex } from '../Utils/make-mutex.js';
import { sentMessageCacheFor } from '../Utils/sent-message-cache.js';
import { createOfflineNodeQueue } from '../Utils/offline-queue.js';
import { areJidsSameUser, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildString, isJidGroup, isJidStatusBroadcast, isJidUser, isLidUser, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { extractGroupMetadata } from './groups.js';
import { makeMessagesSocket } from './messages-send.js';
/** AunuBaileys: classify an <unavailable/> placeholder — 'bot' when a
 * <bot/> child rides along, 'hosted' when the node says so, otherwise
 * the unavailable type attribute (e.g. 'view_once'). */
export const unavailablePlaceholderType = (node) => {
    const unavailableNode = getBinaryNodeChild(node, 'unavailable');
    if (!unavailableNode) {
        return undefined;
    }
    if (getBinaryNodeChild(node, 'bot')) {
        return 'bot';
    }
    if (unavailableNode.attrs?.hosted === 'true') {
        return 'hosted';
    }
    return unavailableNode.attrs?.type;
};
/** AunuBaileys: placeholder types the phone can never resend. */
export const isUnrecoverableUnavailable = (node) => ['bot', 'hosted', 'view_once'].includes(unavailablePlaceholderType(node));
export const makeMessagesRecvSocket = (config) => {
    const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid } = config;
    const sock = makeMessagesSocket(config);
    const { ev, authState, ws, processingMutex, signalRepository, query, upsertMessage, resyncAppState, onUnexpectedError, assertSessions, sendNode, relayMessage, sendReceipt, uploadPreKeys, sendPeerDataOperationMessage, userDevicesCache, aunuLid, fetchPrivacySettings, requestPairingCode } = sock;
    /** AunuBaileys: consecutive decrypt failures per signal address.
     * WhatsApp clients heal a rotten (Bad MAC) session by dropping it and
     * letting the peer re-initiate from the key bundle in our retry receipt;
     * upstream Baileys retries forever against the same stale session. */
    const decryptFailCounts = new Map();
    const DECRYPT_FAIL_SESSION_RESET_LIMIT = 3;
    /** this mutex ensures that each retryRequest will wait for the previous one to finish */
    const retryMutex = makeMutex();
    // AunuBaileys: bounded by default (see bounded-cache.js) — a TTL
    // alone lets these grow without limit inside the window, per socket.
    const msgRetryCache = config.msgRetryCounterCache ||
        makeBoundedTTLCache({ ttlSeconds: DEFAULT_CACHE_TTLS.MSG_RETRY, maxEntries: 1000 });
    const callOfferCache = config.callOfferCache ||
        makeBoundedTTLCache({ ttlSeconds: DEFAULT_CACHE_TTLS.CALL_OFFER, maxEntries: 256 });
    const placeholderResendCache = config.placeholderResendCache ||
        makeBoundedTTLCache({ ttlSeconds: DEFAULT_CACHE_TTLS.MSG_RETRY, maxEntries: 1000 });
    let sendActiveReceipts = false;
    const sendMessageAck = async ({ tag, attrs, content }, errorCode) => {
        const stanza = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.from,
                class: tag
            }
        };
        if (!!errorCode) {
            stanza.attrs.error = errorCode.toString();
        }
        if (!!attrs.participant) {
            stanza.attrs.participant = attrs.participant;
        }
        if (!!attrs.recipient) {
            stanza.attrs.recipient = attrs.recipient;
        }
        if (!!attrs.type &&
            (tag !== 'message' || getBinaryNodeChild({ tag, attrs, content }, 'unavailable') || errorCode !== 0)) {
            stanza.attrs.type = attrs.type;
        }
        if (tag === 'message' && getBinaryNodeChild({ tag, attrs, content }, 'unavailable')) {
            stanza.attrs.from = authState.creds.me.id;
        }
        logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack');
        await sendNode(stanza);
    };
    // AunuBaileys: terima panggilan masuk (node kontrol <accept>) — pasangan
    // rejectCall bawaan; media VOIP-nya sendiri di luar cakupan protokol chat.
    const acceptCall = async (callId, callFrom) => {
        await query(buildCallControlStanza({
            from: authState.creds.me.id,
            to: callFrom,
            action: 'accept',
            callId,
            callCreator: callFrom
        }));
    };
    // AunuBaileys: akhiri panggilan yang sedang berjalan (<terminate>).
    const terminateCall = async (callId, callFrom, reason = 'user-terminated') => {
        await query(buildCallControlStanza({
            from: authState.creds.me.id,
            to: callFrom,
            action: 'terminate',
            callId,
            callCreator: callFrom,
            reason
        }));
    };
    const rejectCall = async (callId, callFrom) => {
        const stanza = {
            tag: 'call',
            attrs: {
                from: authState.creds.me.id,
                to: callFrom
            },
            content: [
                {
                    tag: 'reject',
                    attrs: {
                        'call-id': callId,
                        'call-creator': callFrom,
                        count: '0'
                    },
                    content: undefined
                }
            ]
        };
        await query(stanza);
    };
    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        // AunuBaileys (1.0.71): remainder of HB-6 — an unguarded me.id
        // read here threw inside the retryMutex callback; the throw was
        // caught, but the retry receipt was silently lost. Skip cleanly
        // instead when pairing has not completed yet.
        if (!authState.creds.me?.id) {
            logger.warn({ node }, 'cannot send retry request before pairing completes; skipping');
            return;
        }
        const { fullMessage } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me?.lid || '');
        const { key: msgKey } = fullMessage;
        const msgId = msgKey.id;
        const key = `${msgId}:${msgKey?.participant}`;
        let retryCount = msgRetryCache.get(key) || 0;
        if (retryCount >= maxMsgRetryCount) {
            // AunuBaileys: the counter stays pinned at the cap until
            // the cache expires it — deleting it here reset the resend
            // budget and let a persistent peer loop resends forever, a
            // few at a time.
            logger.debug({ retryCount, msgId }, 'reached retry limit');
            return;
        }
        retryCount += 1;
        msgRetryCache.set(key, retryCount);
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds;
        if (retryCount === 1) {
            // AunuBaileys (1.0.70): requestPlaceholderResend waits 5s
            // for the message to arrive by other means — awaiting it
            // here held the global retryMutex for 5s per first retry,
            // so N failed messages serialised the Nth retry receipt by
            // ~5N seconds. The phone resend is independent of the retry
            // receipt below, so fire it and let the receipt go now.
            requestPlaceholderResend(msgKey).then(
                (msgId) => logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`),
                (err) => logger.debug({ err }, 'sendRetryRequest: placeholder resend failed')
            );
        }
        const deviceIdentity = encodeSignedDeviceIdentity(account, true);
        // AunuBaileys: the receipt is built inside the transaction but
        // SENT only after it commits — the peer must never receive a
        // fresh pre-key whose private half is not yet persisted.
        let receiptToSend;
        let credsUpdate;
        await authState.keys.transaction(async () => {
            const receipt = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            };
            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient;
            }
            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant;
            }
            if (retryCount > 1 || forceIncludeKeys) {
                const { update, preKeys } = await getNextPreKeys(authState, 1);
                const [keyId] = Object.keys(preKeys);
                const key = preKeys[+keyId];
                const content = receipt.content;
                content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                });
                credsUpdate = update;
            }
            receiptToSend = receipt;
        });
        if (credsUpdate) {
            ev.emit('creds.update', credsUpdate);
        }
        await sendNode(receiptToSend);
        logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt');
    };
    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from;
        if (from === S_WHATSAPP_NET) {
            const countChild = getBinaryNodeChild(node, 'count');
            if (!countChild) {
                // AunuBaileys: a malformed encrypt notification must
                // not take the handler down with a TypeError.
                logger.warn({ node }, 'encrypt notification without a count child; ignoring');
                return;
            }
            const count = +countChild.attrs.value;
            const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT;
            logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count');
            if (shouldUploadMorePreKeys) {
                await uploadPreKeys();
            }
        }
        else {
            const identityNode = getBinaryNodeChild(node, 'identity');
            if (identityNode) {
                logger.info({ jid: from }, 'identity changed');
                // AunuBaileys: upstream logged this and did nothing, leaving the
                // OLD session bound to the OLD identity — every later message from
                // that contact then fails against the archived session (Bad MAC
                // class) until the peer happens to send a pre-key message. Drop
                // the stored session now (1.0.14 machinery) so the next exchange
                // re-initiates cleanly against the new identity.
                try {
                    await signalRepository.deleteSession(from);
                    logger.warn({ jid: from }, 'aunu: deleted stored session after identity change; next message re-initiates a fresh session');
                }
                catch (delErr) {
                    logger.debug({ err: delErr }, 'aunu: session delete on identity change failed');
                }
            }
            else {
                logger.info({ node }, 'unknown encrypt notification');
            }
        }
    };
    const handleGroupNotification = (participant, child, msg) => {
        const participantJid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || participant;
        switch (child?.tag) {
            case 'create':
                const metadata = extractGroupMetadata(child);
                msg.messageStubType = WAMessageStubType.GROUP_CREATE;
                msg.messageStubParameters = [metadata.subject];
                msg.key = { participant: metadata.owner };
                ev.emit('chats.upsert', [
                    {
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation
                    }
                ]);
                ev.emit('groups.upsert', [
                    {
                        ...metadata,
                        author: participant
                    }
                ]);
                break;
            case 'ephemeral':
            case 'not_ephemeral':
                msg.message = {
                    protocolMessage: {
                        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                };
                break;
            case 'modify':
                const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
                msg.messageStubParameters = oldNumber || [];
                msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER;
                break;
            case 'promote':
            case 'demote':
            case 'remove':
            case 'add':
            case 'leave':
                const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`;
                msg.messageStubType = WAMessageStubType[stubType];
                const participants = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
                if (participants.length === 1 &&
                    // if recv. "remove" message and sender removed themselves
                    // mark as left
                    areJidsSameUser(participants[0], participant) &&
                    child.tag === 'remove') {
                    msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE;
                }
                msg.messageStubParameters = participants;
                break;
            case 'subject':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT;
                msg.messageStubParameters = [child.attrs.subject];
                break;
            case 'description':
                const description = getBinaryNodeChild(child, 'body')?.content?.toString();
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION;
                msg.messageStubParameters = description ? [description] : undefined;
                break;
            case 'announcement':
            case 'not_announcement':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE;
                msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off'];
                break;
            case 'locked':
            case 'unlocked':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT;
                msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off'];
                break;
            case 'invite':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK;
                msg.messageStubParameters = [child.attrs.code];
                break;
            case 'member_add_mode':
                const addMode = child.content;
                if (addMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE;
                    msg.messageStubParameters = [addMode.toString()];
                }
                break;
            case 'membership_approval_mode':
                const approvalMode = getBinaryNodeChild(child, 'group_join');
                if (approvalMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE;
                    msg.messageStubParameters = [approvalMode.attrs.state];
                }
                break;
            case 'created_membership_requests':
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [participantJid, 'created', child.attrs.request_method];
                break;
            case 'revoked_membership_requests':
                const isDenied = areJidsSameUser(participantJid, participant);
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [participantJid, isDenied ? 'revoked' : 'rejected'];
                break;
        }
    };
    const processNotification = async (node) => {
        const result = {};
        const [child] = getAllBinaryNodeChildren(node);
        // AunuBaileys: every case below works on the child — a
        // childless (malformed) notification has nothing to process.
        if (!child) {
            return result;
        }
        const nodeType = node.attrs.type;
        const from = jidNormalizedUser(node.attrs.from);
        switch (nodeType) {
            case 'privacy_token':
                const tokenList = getBinaryNodeChildren(child, 'token');
                for (const { attrs, content } of tokenList) {
                    const jid = attrs.jid;
                    ev.emit('chats.update', [
                        {
                            id: jid,
                            tcToken: content
                        }
                    ]);
                    logger.debug({ jid }, 'got privacy token update');
                }
                break;
            case 'newsletter':
                await handleNewsletterNotification(node);
                break;
            case 'mex':
                await handleMexNewsletterNotification(node);
                break;
            case 'w:gp2':
                handleGroupNotification(node.attrs.participant, child, result);
                break;
            case 'mediaretry':
                const event = decodeMediaRetryNode(node);
                if (event) {
                    ev.emit('messages.media-update', [event]);
                }
                break;
            case 'encrypt':
                await handleEncryptNotification(node);
                break;
            case 'devices': {
                const devices = getBinaryNodeChildren(child, 'device');
                if (areJidsSameUser(child.attrs.jid, authState.creds.me.id)) {
                    const deviceJids = devices.map(d => d.attrs.jid);
                    logger.info({ deviceJids }, 'got my own devices');
                }
                // AunuBaileys: this notification means a device list
                // CHANGED (device linked or unlinked). Upstream logged
                // its own list and ignored everyone else's, so the send
                // path kept encrypting for the cached device set until
                // the cache TTL (5 min) expired — a newly linked device
                // received nothing meanwhile and a removed device kept
                // getting ciphertext. Drop the cached entry so the next
                // send re-queries USync for the fresh list.
                const changedUser = jidDecode(child.attrs.jid)?.user;
                if (changedUser) {
                    userDevicesCache?.del(changedUser);
                    logger.debug({ changedUser }, 'aunu: device cache invalidated on devices notification');
                }
                break;
            }
            case 'server_sync':
                const update = getBinaryNodeChild(node, 'collection');
                if (update) {
                    const name = update.attrs.name;
                    await resyncAppState([name], false);
                }
                break;
            case 'picture':
                const setPicture = getBinaryNodeChild(node, 'set');
                const delPicture = getBinaryNodeChild(node, 'delete');
                ev.emit('contacts.update', [
                    {
                        id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
                        imgUrl: setPicture ? 'changed' : 'removed'
                    }
                ]);
                if (isJidGroup(from)) {
                    const node = setPicture || delPicture;
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON;
                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id];
                    }
                    result.participant = node?.attrs.author;
                    result.key = {
                        ...(result.key || {}),
                        participant: setPicture?.attrs.author
                    };
                }
                break;
            case 'account_sync':
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration;
                    const timestamp = +child.attrs.t;
                    logger.info({ newDuration }, 'updated account disappearing mode');
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    });
                }
                else if (child.tag === 'blocklist') {
                    const blocklists = getBinaryNodeChildren(child, 'item');
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid];
                        const type = attrs.action === 'block' ? 'add' : 'remove';
                        ev.emit('blocklist.update', { blocklist, type });
                    }
                }
                else if (child.tag === 'privacy') {
                    // AunuBaileys (1.0.71): privacy settings changed on
                    // the primary; the notification carries no values, so
                    // refetch and publish the full set (donor: violetix
                    // lib/Socket/messages-recv.js account_sync case).
                    const settings = await fetchPrivacySettings(true);
                    ev.emit('privacy.update', settings);
                }
                break;
            case 'passkey_prologue_request':
                // AunuBaileys (1.0.71): the account is passkey-gated
                // (Shortcake) — the server will not finish a QR or
                // pairing-code link without a WebAuthn assertion from
                // the owner's own authenticator. There is no headless
                // completion path, so surface it instead of hanging
                // silently (donor messages-recv.js).
                logger.warn({ id: node.attrs.id }, 'WhatsApp requires a passkey (Shortcake) to link this account; QR / pairing code cannot complete without the owner authenticator');
                ev.emit('connection.update', { passkeyRequired: true });
                break;
            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                if (linkCodeCompanionReg?.attrs?.stage === 'refresh_code') {
                    // The server retired the ref behind the code the user
                    // is still looking at. Re-run companion_hello with the
                    // same code so it stays valid; the ref is server-side.
                    const phone = authState.creds.me?.id ? jidDecode(authState.creds.me.id)?.user : undefined;
                    if (linkCodeCompanionReg.attrs.force_manual_refresh === 'true' || !phone || !authState.creds.pairingCode) {
                        logger.warn({ forceManual: linkCodeCompanionReg.attrs.force_manual_refresh }, 'pairing code expired; call requestPairingCode again');
                        ev.emit('connection.update', { pairingCodeExpired: true });
                    }
                    else {
                        try {
                            await requestPairingCode(phone, authState.creds.pairingCode);
                            logger.info('pairing code refreshed with the server; the displayed code is still valid');
                        }
                        catch (err) {
                            logger.warn({ err }, 'failed to refresh pairing code');
                            ev.emit('connection.update', { pairingCodeExpired: true });
                        }
                    }
                    break;
                }
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'));
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped);
                const companionSharedKey = Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey);
                const random = randomBytes(32);
                const linkCodeSalt = randomBytes(32);
                const linkCodePairingExpanded = await hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                });
                const encryptPayload = Buffer.concat([
                    Buffer.from(authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ]);
                const encryptIv = randomBytes(12);
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0));
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted]);
                const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey);
                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random]);
                authState.creds.advSecretKey = (await hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64');
                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: sock.generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                });
                authState.creds.registered = true;
                ev.emit('creds.update', authState.creds);
        }
        if (Object.keys(result).length) {
            return result;
        }
    };
    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data);
        const salt = buffer.slice(0, 32);
        const secretKey = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const iv = buffer.slice(32, 48);
        const payload = buffer.slice(48, 80);
        return aesDecryptCTR(payload, secretKey, iv);
    }
    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Boom('Invalid buffer', { statusCode: 400 });
        }
        return data instanceof Buffer ? data : Buffer.from(data);
    }
    const willSendMessageAgain = (id, participant) => {
        const key = `${id}:${participant}`;
        const retryCount = msgRetryCache.get(key) || 0;
        return retryCount < maxMsgRetryCount;
    };
    const updateSendMessageAgainCount = (id, participant) => {
        const key = `${id}:${participant}`;
        const newValue = (msgRetryCache.get(key) || 0) + 1;
        // AunuBaileys: the counter is KEPT at the cap, never deleted —
        // deleting it reset the resend budget and let a persistent
        // peer loop resends forever, a few at a time (ban/rate-limit
        // bait). Growth is bounded by the cache itself: since 1.0.62
        // the default retry cache has both a TTL and an entry ceiling.
        msgRetryCache.set(key, newValue);
    };
    const sendMessagesAgain = async (key, ids, retryNode, sessionPreInjected = false) => {
        const msgs = await Promise.all(ids.map(async (id) => (await getMessage({ ...key, id })) ?? sentMessageCacheFor(config, (jid) => aunuLid?.getAltJid?.(jid)).get(key.remoteJid, id)));
        const remoteJid = key.remoteJid;
        const participant = key.participant || remoteJid;
        // if it's the primary jid sending the request
        // just re-send the message to everyone
        // prevents the first message decryption failure
        const sendToAll = !jidDecode(participant)?.device;
        if (!sessionPreInjected) {
            await assertSessions([participant], true);
        }
        if (isJidGroup(remoteJid)) {
            await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } });
        }
        logger.debug({ participant, sendToAll }, 'forced new session for retry recp');
        for (const [i, msg] of msgs.entries()) {
            if (msg) {
                updateSendMessageAgainCount(ids[i], participant);
                const msgRelayOpts = { messageId: ids[i] };
                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false;
                }
                else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: retryNode?.attrs?.count ? +retryNode.attrs.count : 0
                    };
                }
                // AunuBaileys (1.0.72): one id's resend failure used
                // to abort the whole batch — the remaining ids in the
                // same retry receipt were never resent this round
                // (HB-61). Log and continue with the rest.
                try {
                    await relayMessage(key.remoteJid, msg, msgRelayOpts);
                }
                catch (err) {
                    logger.warn({ err, jid: key.remoteJid, id: ids[i] }, 'resending one message failed; continuing with the rest of the batch');
                }
            }
            else {
                logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available');
            }
        }
    };
    const handleReceipt = async (node) => {
        const { attrs, content } = node;
        const isLid = (attrs.from || '').includes('lid');
        const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id);
        const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe);
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant
        };
        if (shouldIgnoreJid(remoteJid) && remoteJid !== '@s.whatsapp.net') {
            logger.debug({ remoteJid }, 'ignoring receipt from jid');
            await sendMessageAck(node);
            return;
        }
        const ids = [attrs.id];
        if (Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], 'item');
            ids.push(...items.map(i => i.attrs.id));
        }
        try {
            await Promise.all([
                processingMutex.mutex(async () => {
                    const status = getStatusFromReceiptType(attrs.type);
                    if (typeof status !== 'undefined' &&
                        // basically, we only want to know when a message from us has been delivered to/read by the other person
                        // or another device of ours has read some messages
                        (status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)) {
                        if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp';
                                ev.emit('message-receipt.update', ids.map(id => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })));
                            }
                        }
                        else {
                            // AunuBaileys: DM receipts increasingly arrive
                            // addressed to the peer's LID while consumers
                            // keyed the sent message by its PN JID (or the
                            // reverse), so the status update never matches
                            // their store and the message looks stuck at
                            // "sent". Attach the alternate form as
                            // key.remoteJidAlt when the LID store knows the
                            // pair — purely additive, remoteJid unchanged.
                            const remoteJidAlt = sock.aunuLid?.getAltJid?.(remoteJid);
                            ev.emit('messages.update', ids.map(id => ({
                                key: { ...key, id, ...(remoteJidAlt ? { remoteJidAlt } : {}) },
                                update: { status }
                            })));
                        }
                    }
                    if (attrs.type === 'retry') {
                        // correctly set who is asking for the retry
                        key.participant = key.participant || attrs.from;
                        const retryNode = getBinaryNodeChild(node, 'retry');
                        if (willSendMessageAgain(ids[0], key.participant)) {
                            if (key.fromMe) {
                                try {
                                    logger.debug({ attrs, key }, 'recv retry request');
                                    // AunuBaileys: when the retry receipt carries the
                                    // requester's own key bundle, build the fresh
                                    // session from THAT (authoritative for the exact
                                    // device, no server round trip) and skip the
                                    // force-fetch inside sendMessagesAgain.
                                    let sessionPreInjected = false;
                                    const bundleSession = parseRetryReceiptSession(node);
                                    if (bundleSession && key.participant) {
                                        try {
                                            await signalRepository.injectE2ESession({ jid: key.participant, session: bundleSession });
                                            sessionPreInjected = true;
                                            logger.debug({ participant: key.participant }, 'aunu: injected E2E session from retry receipt bundle');
                                        }
                                        catch (injErr) {
                                            logger.debug({ err: injErr }, 'aunu: retry receipt bundle injection failed; falling back to server fetch');
                                        }
                                    }
                                    await sendMessagesAgain(key, ids, retryNode, sessionPreInjected);
                                }
                                catch (error) {
                                    logger.error({ key, ids, trace: error.stack }, 'error in sending message again');
                                }
                            }
                            else {
                                logger.info({ attrs, key }, 'recv retry for not fromMe message');
                            }
                        }
                        else {
                            logger.info({ attrs, key }, 'will not send message again, as sent too many times');
                        }
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node);
        }
    };
    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from;
        if (shouldIgnoreJid(remoteJid) && remoteJid !== '@s.whatsapp.net') {
            logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification');
            await sendMessageAck(node);
            return;
        }
        try {
            await Promise.all([
                processingMutex.mutex(async () => {
                    const msg = await processNotification(node);
                    if (msg) {
                        const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me.id);
                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        };
                        msg.participant ?? (msg.participant = node.attrs.participant);
                        msg.messageTimestamp = +node.attrs.t;
                        const fullMsg = proto.WebMessageInfo.fromObject(msg);
                        await upsertMessage(fullMsg, 'append');
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node);
        }
    };
    const handleMessage = async (node) => {
        if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== '@s.whatsapp.net') {
            logger.debug({ key: node.attrs.key }, 'ignored message');
            await sendMessageAck(node);
            return;
        }
        const encNode = getBinaryNodeChild(node, 'enc');
        // AunuBaileys (1.0.71): msmsg (Meta AI bot reply) needs the
        // messageSecret of the message we sent to @bot. The in-memory
        // map is lost on restart, so recover it from the message store
        // first (donor messages-recv.js). The old blanket ignore is gone;
        // decryption now runs through the normal path below, and a
        // failure there stays a CIPHERTEXT stub instead of a crash.
        if (encNode?.attrs.type === 'msmsg' && getMessage) {
            const targetId = getBinaryNodeChild(node, 'meta')?.attrs?.target_id;
            if (targetId) {
                try {
                    const targetMsg = await getMessage({ remoteJid: node.attrs.from, id: targetId, fromMe: true });
                    const secret = targetMsg?.messageContextInfo?.messageSecret;
                    if (secret) {
                        setBotMessageSecret(targetId, secret, node.attrs.from);
                    }
                }
                catch (err) {
                    logger.debug({ err, targetId }, 'failed to retrieve message secret for msmsg');
                }
            }
        }
        let response;
        if (getBinaryNodeChild(node, 'unavailable') && !encNode) {
            await sendMessageAck(node);
            const { key } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '').fullMessage;
            // AunuBaileys: bot / hosted / view_once placeholders can never
            // be resent by the phone — don't burn a resend request on
            // them (behaviour learned from @violetix/baileys).
            if (isUnrecoverableUnavailable(node)) {
                logger.debug({ msgId: key.id, unavailableType: unavailablePlaceholderType(node) }, 'unavailable placeholder cannot be resent; skipping resend request');
            }
            else {
                response = await requestPlaceholderResend(key);
            }
            if (response === 'RESOLVED') {
                return;
            }
            logger.debug('received unavailable message, acked and requested resend from phone');
        }
        else {
            if (placeholderResendCache.get(node.attrs.id)) {
                placeholderResendCache.del(node.attrs.id);
            }
        }
        // AunuBaileys (1.0.67): decode used to run outside any try — a
        // malformed stanza threw, was only logged, and was never acked,
        // so the server redelivered the same poison stanza forever.
        // Decode failures now get a NACK (UnhandledError, 500), the
        // pattern upstream v7 uses.
        let decoded;
        try {
            decoded = decryptMessageNode(node, authState.creds.me?.id, authState.creds.me?.lid || '', signalRepository, logger);
        }
        catch (decodeError) {
            logger.error({ error: decodeError, node }, 'error decoding message node; sending NACK');
            await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(() => { });
            return;
        }
        const { fullMessage: msg, category, author, decrypt } = decoded;
        if (response && msg?.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
            msg.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT, response];
        }
        try {
            await Promise.all([
                processingMutex.mutex(async () => {
                    await decrypt();
                    // AunuBaileys (1.0.70): this check used to run BEFORE
                    // decrypt(), when msg.message was still empty — so it
                    // was always false and the LID->PN share-number
                    // feature was dead. It belongs here, after decrypt.
                    if (msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER &&
                        node.attrs.sender_pn) {
                        ev.emit('chats.phoneNumberShare', { lid: node.attrs.from, jid: node.attrs.sender_pn });
                    }
                    // AunuBaileys (1.0.71): a decrypted msmsg reply is
                    // Meta AI text — surface it on its own event as
                    // well as the normal messages.upsert flow.
                    if (encNode?.attrs?.type === 'msmsg' && msg.message) {
                        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                        if (text) {
                            ev.emit('messages.meta-ai', { key: msg.key, text, remoteJid: node.attrs.from });
                        }
                    }
                    // message failed to decrypt
                    if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
                        if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                            return sendMessageAck(node, NACK_REASONS.ParsingError);
                        }
                        retryMutex.mutex(async () => {
                            if (ws.isOpen) {
                                if (getBinaryNodeChild(node, 'unavailable')) {
                                    return;
                                }
                                const encNode = getBinaryNodeChild(node, 'enc');
                                let forceIncludeKeys = !encNode;
                                if (author) {
                                    try {
                                        const isGroupMsg = isJidGroup(msg.key.remoteJid);
                                        const addr = signalRepository.jidToSignalProtocolAddress(author);
                                        const failKey = isGroupMsg ? `sk:${msg.key.remoteJid}:${addr}` : addr;
                                        const fails = (decryptFailCounts.get(failKey) || 0) + 1;
                                        // AunuBaileys (1.0.46): kegagalan lapis sesi — record
                                        // sesi tersimpan tidak dapat mendekripsi pesan ini
                                        // sama sekali (termasuk jurang "Over 2000 messages
                                        // into the future" akibat state sesi yang mundur).
                                        // Jurang itu tidak bisa diisi ulang, jadi menunggu
                                        // 3x hanya membanjiri log; dan di grup, menghapus
                                        // sender key saja tidak menyentuh sesi E2E yang
                                        // rusak. Kelas ini direset SEKETIKA.
                                        const sessionLayerFailure = isUnrecoverableSessionError(msg?.messageStubParameters?.[0]);
                                        let healed = false;
                                        const resetE2ESession = async () => {
                                            await signalRepository.deleteSession(author);
                                            // sesi yang sama bisa tersimpan di bawah bentuk
                                            // alamat alternatifnya (PN <-> LID)
                                            const alt = sock.aunuLid?.getAltJid?.(author);
                                            if (alt && alt !== author) {
                                                await signalRepository.deleteSession(alt);
                                            }
                                        };
                                        if (sessionLayerFailure) {
                                            await resetE2ESession();
                                            if (isGroupMsg) {
                                                await signalRepository.deleteSenderKey(msg.key.remoteJid, author);
                                            }
                                            decryptFailCounts.delete(failKey);
                                            forceIncludeKeys = true;
                                            healed = true;
                                            logger.warn({ author, addr, group: isGroupMsg ? msg.key.remoteJid : undefined }, 'aunu: reset E2E session after an unrecoverable session-layer decrypt failure (stored session cannot decrypt, e.g. regressed state); retry receipt carries fresh keys');
                                        }
                                        else if (fails >= DECRYPT_FAIL_SESSION_RESET_LIMIT) {
                                            if (isGroupMsg) {
                                                // AunuBaileys (1.0.48): Bad MAC adalah error
                                                // lapis whisper/sesi E2E (SessionCipher), dan
                                                // di grup ia juga bisa datang dari lapis
                                                // sender key — menghapus sender key SAJA
                                                // (perilaku 1.0.14) tidak menyentuh sesi E2E
                                                // penulis yang busuk. Bersihkan keduanya.
                                                await resetE2ESession();
                                                await signalRepository.deleteSenderKey(msg.key.remoteJid, author);
                                                logger.warn({ author, group: msg.key.remoteJid }, 'aunu: reset E2E session and deleted stale sender-key record after repeated group decrypt failures; retry receipt carries fresh keys');
                                            }
                                            else {
                                                await resetE2ESession();
                                                logger.warn({ author, addr }, 'aunu: deleted stale E2E session after repeated decrypt failures (Bad MAC self-heal); retry receipt carries fresh keys');
                                            }
                                            decryptFailCounts.delete(failKey);
                                            forceIncludeKeys = true;
                                            healed = true;
                                        }
                                        else {
                                            decryptFailCounts.set(failKey, fails);
                                            // AunuBaileys (1.0.70): cap the
                                            // map — addresses that fail
                                            // once or twice and go quiet
                                            // used to leave an entry for
                                            // the life of the socket.
                                            while (decryptFailCounts.size > 1000) {
                                                decryptFailCounts.delete(decryptFailCounts.keys().next().value);
                                            }
                                        }
                                        // AunuBaileys: structured decrypt-failure event so
                                        // consumers can alert and aggregate on Bad MAC
                                        // floods (B-01) instead of parsing log lines.
                                        ev.emit('messages.decrypt-failure', {
                                            remoteJid: msg.key.remoteJid,
                                            author,
                                            address: addr,
                                            isGroup: isGroupMsg,
                                            failures: fails,
                                            healed,
                                            errorClass: sessionLayerFailure ? 'session' : (isBadMacError(msg?.messageStubParameters?.[0]) ? 'bad-mac' : 'other'),
                                            messageId: node.attrs.id,
                                            timestamp: Date.now()
                                        });
                                    }
                                    catch (healErr) {
                                        logger.debug({ err: healErr }, 'aunu: session self-heal step failed, continuing with normal retry');
                                    }
                                }
                                // AunuBaileys (1.0.72): never ask for a
                                // resend of our OWN undecryptable message
                                // (HB-70, pola luna 8.2.0) — it is an echo
                                // from another of our devices, encrypted
                                // under that device's session; a retry
                                // receipt would ask ourselves to resend to
                                // ourselves.
                                if (!msg.key.fromMe) {
                                    await sendRetryRequest(node, forceIncludeKeys);
                                    if (retryRequestDelayMs) {
                                        await delay(retryRequestDelayMs);
                                    }
                                }
                            }
                            else {
                                logger.debug({ node }, 'connection closed, ignoring retry req');
                            }
                        }).catch(err => onUnexpectedError(err, 'sending retry request'));
                        // AunuBaileys: this mutex call is deliberately fire-and-forget
                        // (it must not block message processing), but until now its
                        // rejection was UNHANDLED — a failed retry request (socket
                        // died mid-flight, pre-key fetch error) crashed the whole
                        // process under Node's default unhandled-rejection policy.
                        // It is now routed to the standard error handler instead.
                        // AunuBaileys (1.0.72): the stub used to end
                        // here — never upserted, so a message that
                        // failed to decrypt left no placeholder in
                        // messages.upsert or the host's store and
                        // vanished silently if the retry also failed
                        // (HB-90; upstream v7 falls through to the
                        // upsert for exactly this reason).
                        cleanMessage(msg, authState.creds.me.id);
                        await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
                    }
                    else {
                        if (author) {
                            try {
                                const addr = signalRepository.jidToSignalProtocolAddress(author);
                                decryptFailCounts.delete(addr);
                                decryptFailCounts.delete(`sk:${msg.key.remoteJid}:${addr}`);
                            }
                            catch { }
                        }
                        // no type in the receipt => message delivered
                        let type = undefined;
                        let participant = msg.key.participant;
                        if (category === 'peer') {
                            // special peer message
                            type = 'peer_msg';
                        }
                        else if (msg.key.fromMe) {
                            // message was sent by us from a different device
                            type = 'sender';
                            // need to specially handle this case
                            if (isJidUser(msg.key.remoteJid)) {
                                participant = author;
                            }
                        }
                        else if (!sendActiveReceipts) {
                            type = 'inactive';
                        }
                        await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
                        // send ack for history message
                        const isAnyHistoryMsg = getHistoryMsg(msg.message);
                        if (isAnyHistoryMsg) {
                            const jid = jidNormalizedUser(msg.key.remoteJid);
                            await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync');
                        }
                    }
                    cleanMessage(msg, authState.creds.me.id);
                    await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
                })
            ]);
        }
        catch (error) {
            logger.error({ error, node }, 'error in handling message');
            // AunuBaileys (1.0.67): never leave a failed stanza unacked
            // (see the decode NACK above); a duplicate ack is harmless.
            await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(() => { });
        }
    };
    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        };
        return sendPeerDataOperationMessage(pdoMessage);
    };
    const requestPlaceholderResend = async (messageKey) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        if (placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'already requested resend');
            return;
        }
        else {
            placeholderResendCache.set(messageKey?.id, true);
        }
        await delay(5000);
        if (!placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'message received while resend requested');
            return 'RESOLVED';
        }
        const pdoMessage = {
            placeholderMessageResendRequest: [
                {
                    messageKey
                }
            ],
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        };
        setTimeout(() => {
            if (placeholderResendCache.get(messageKey?.id)) {
                logger.debug({ messageKey }, 'PDO message without response after 15 seconds. Phone possibly offline');
                placeholderResendCache.del(messageKey?.id);
            }
        }, 15000);
        return sendPeerDataOperationMessage(pdoMessage);
    };
    const handleCall = async (node) => {
        let status;
        const { attrs } = node;
        const [infoChild] = getAllBinaryNodeChildren(node);
        if (!infoChild) {
            // AunuBaileys (1.0.67): ack malformed call nodes instead of
            // throwing before the ack — an unacked stanza is redelivered
            // by the server forever.
            logger.error({ node }, 'missing call info in call node; acking and dropping');
            await sendMessageAck(node).catch(() => { });
            return;
        }
        // AunuBaileys (1.0.71): try/finally around the whole handler
        // body (v7 pattern) — a throwing 'call' listener used to
        // skip the ack below, so the server redelivered the same
        // call stanza forever.
        try {
            const callId = infoChild.attrs['call-id'];
            const from = infoChild.attrs.from || infoChild.attrs['call-creator'];
            status = getCallStatusFromNode(infoChild);
            if (isLidUser(from) && infoChild.tag === 'relaylatency') {
                const verify = callOfferCache.get(callId);
                if (!verify) {
                    status = 'offer';
                    const callLid = {
                        chatId: attrs.from,
                        from,
                        id: callId,
                        date: new Date(+attrs.t * 1000),
                        offline: !!attrs.offline,
                        status
                    };
                    callOfferCache.set(callId, callLid);
                }
            }
            const call = {
                chatId: attrs.from,
                from,
                callerPn: infoChild.attrs['caller_pn'],
                id: callId,
                date: new Date(+attrs.t * 1000),
                offline: !!attrs.offline,
                status
            };
            // AunuBaileys (1.0.71): ours getCallStatusFromNode() maps unknown
            // tags to 'ringing', so these two states are read off the tag,
            // not the status (the donor's mapper differs).
            if (infoChild.tag === 'relaylatency') {
                const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms'];
                const latencyMs = latencyValue ? Number(latencyValue) : undefined;
                if (Number.isFinite(latencyMs)) {
                    call.latencyMs = latencyMs;
                }
            }
            else if (infoChild.tag === 'waiting_room_request') {
                call.peerJid = infoChild.attrs.from || infoChild.attrs['peer-jid'] || infoChild.attrs['user-jid'];
            }
            if (status === 'offer') {
                const videoNode = getBinaryNodeChild(infoChild, 'video');
                const audioNodes = getBinaryNodeChildren(infoChild, 'audio');
                const silenceNode = getBinaryNodeChild(infoChild, 'silence');
                call.isVideo = !!videoNode;
                call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid'];
                call.groupJid = infoChild.attrs['group-jid'];
                // lightweight=1 marks a silent/wave-style group ring, no full ringing UX expected
                call.isLightweight = infoChild.attrs.lightweight === '1';
                if (silenceNode?.attrs?.reason) {
                    call.silenceReason = silenceNode.attrs.reason;
                }
                // wire attrs are 'enc'/'rate' for audio and 'dec' for video, not 'codec';
                // <audio> repeats once per supported sample rate
                if (audioNodes.length) {
                    call.audioCodecs = audioNodes.map((n) => ({ enc: n.attrs.enc, rate: n.attrs.rate ? +n.attrs.rate : undefined }));
                    call.audioCodec = audioNodes[0].attrs.enc;
                }
                if (videoNode?.attrs?.dec) {
                    call.videoCodec = videoNode.attrs.dec;
                }
                callOfferCache.set(call.id, call);
            }
            const existingCall = callOfferCache.get(call.id);
            // use existing call info to populate this event
            if (existingCall) {
                call.isVideo = existingCall.isVideo;
                call.isGroup = existingCall.isGroup;
                call.callerPn = call.callerPn || existingCall.callerPn;
            }
            aunuEnrichCallSignalling(call, infoChild, infoChild.tag);
            // delete data once call has ended
            if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
                callOfferCache.del(call.id);
            }
            ev.emit('call', [call]);
        }
        finally {
            await sendMessageAck(node).catch(() => { });
        }
    };
    /** Tags that carry actual call state; the rest are media/relay signalling we only ack. */
    const AUNU_CALL_STATE_TAGS = new Set([
        'offer',
        'offer_notice',
        'terminate',
        'accept',
        'reject',
        'preaccept',
        'accept_ack',
        'enc-rekey',
        'enc_rekey',
        'peer_state',
        'group_info',
        'video_state',
        'video_state_ack',
        'flow_control',
        'mute_v2',
        'waiting_room_request'
    ]);
    const aunuIsCallEndedStatus = (status) => status === 'reject' ||
        status === 'accept' ||
        status === 'timeout' ||
        status === 'terminate' ||
        status === 'reject_do_not_disturb' ||
        status === 'mic_permission_denied' ||
        status === 'camera_permission_denied' ||
        status === 'remote_busy' ||
        status === 'remote_offline';
    const aunuParseGroupCallRoster = (groupInfoNode) => getBinaryNodeChildren(groupInfoNode, 'user').map((userNode) => ({
        jid: userNode.attrs.jid,
        state: userNode.attrs.state,
        userPn: userNode.attrs.user_pn,
        devices: getBinaryNodeChildren(userNode, 'device').map((d) => ({
            jid: d.attrs.jid,
            platform: d.attrs.platform
        }))
    }));
    /** Fills in the signalling-only fields, given the node the state attrs live on. */
    const aunuEnrichCallSignalling = (call, stateNode, tag) => {
        if (tag === 'peer_state') {
            call.state = getBinaryNodeChild(stateNode, 'peer_state')?.attrs?.state || stateNode.attrs?.state;
        }
        else if (tag === 'group_info') {
            call.payload = stateNode.attrs;
            call.participants = aunuParseGroupCallRoster(stateNode);
        }
        else if (tag === 'video_state') {
            const enabledRaw = getBinaryNodeChild(stateNode, 'video_state')?.attrs?.enabled ?? stateNode.attrs?.enabled;
            call.enabled = enabledRaw === 'true' || enabledRaw === '1';
        }
        else if (tag === 'mute' || tag === 'mute_v2') {
            // mute_v2 IS the tag itself on real traffic — attrs are
            // { call-id, call-creator, mute-state: '0'|'1' }, with no nested <audio> child
            call.muted = stateNode.attrs['mute-state'] === '1';
        }
    };
    /**
     * Some call signalling arrives as a top-level stanza (<offer>,
     * <terminate>, ...) instead of being wrapped in <call>, so it needs
     * its own handler — state attrs live on the node itself.
     */
    const handleAunuStandaloneCallStanza = async (node) => {
        try {
            if (!AUNU_CALL_STATE_TAGS.has(node.tag)) {
                return; // media/relay signalling (transport, video, duration, lobby, ...): ack only
            }
            const { attrs } = node;
            const status = getCallStatusFromNode(node);
            const callId = attrs['call-id'];
            const from = attrs.from || attrs['call-creator'];
            const call = {
                chatId: attrs.from || from,
                from,
                callerPn: attrs['caller_pn'],
                id: callId,
                date: attrs.t ? new Date(+attrs.t * 1000) : new Date(),
                offline: !!attrs.offline,
                status
            };
            if (status === 'offer') {
                const videoNode = getBinaryNodeChild(node, 'video');
                const audioNodes = getBinaryNodeChildren(node, 'audio');
                const silenceNode = getBinaryNodeChild(node, 'silence');
                call.isVideo = !!videoNode;
                call.isGroup = attrs.type === 'group' || !!attrs['group-jid'];
                call.groupJid = attrs['group-jid'];
                call.isLightweight = attrs.lightweight === '1';
                if (silenceNode?.attrs?.reason) {
                    call.silenceReason = silenceNode.attrs.reason;
                }
                if (audioNodes.length) {
                    call.audioCodecs = audioNodes.map((n) => ({ enc: n.attrs.enc, rate: n.attrs.rate ? +n.attrs.rate : undefined }));
                    call.audioCodec = audioNodes[0].attrs.enc;
                }
                if (videoNode?.attrs?.dec) {
                    call.videoCodec = videoNode.attrs.dec;
                }
                if (callId) {
                    await callOfferCache.set(callId, call);
                }
            }
            // AunuBaileys (1.0.71): ours getCallStatusFromNode() maps
            // unknown tags to 'ringing', so waiting-room state is read
            // off the tag, not the status (the donor's mapper differs).
            else if (node.tag === 'waiting_room_request') {
                call.peerJid = attrs.from || attrs['peer-jid'] || attrs['user-jid'];
            }
            const existingCall = callId ? await callOfferCache.get(callId) : undefined;
            if (existingCall) {
                call.isVideo = existingCall.isVideo;
                call.isGroup = existingCall.isGroup;
                call.callerPn = call.callerPn || existingCall.callerPn;
            }
            aunuEnrichCallSignalling(call, node, node.tag);
            if (callId && aunuIsCallEndedStatus(status)) {
                await callOfferCache.del(callId);
            }
            ev.emit('call', [call]);
        }
        catch (error) {
            logger.error({ error, node }, 'error in handling standalone call stanza');
        }
        finally {
            await sendMessageAck(node).catch((ackErr) => logger.error({ ackErr }, 'failed to ack standalone call stanza'));
        }
    };
    const handleBadAck = async ({ attrs }) => {
        const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id };
        // WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
        // // current hypothesis is that if pash is sent in the ack
        // // it means -- the message hasn't reached all devices yet
        // // we'll retry sending the message here
        // if(attrs.phash) {
        // 	logger.info({ attrs }, 'received phash in ack, resending message...')
        // 	const msg = await getMessage(key)
        // 	if(msg) {
        // 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
        // 	} else {
        // 		logger.warn({ attrs }, 'could not send message again, as it was not found')
        // 	}
        // }
        // error in acknowledgement,
        // device could not display the message
        if (attrs.error) {
            logger.warn({ attrs }, 'received error in ack');
            ev.emit('messages.update', [
                {
                    key,
                    update: {
                        status: WAMessageStatus.ERROR,
                        messageStubParameters: [attrs.error]
                    }
                }
            ]);
        }
    };
    /// processes a node with the given function
    /// and adds the task to the existing buffer if we're buffering events
    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer();
        await execTask();
        ev.flush();
        function execTask() {
            return exec(node, false).catch(err => onUnexpectedError(err, identifier));
        }
    };
    const makeOfflineNodeProcessor = () => {
        // AunuBaileys: the drain lives in Utils/offline-queue.js — a
        // throwing node is reported and skipped instead of wedging the
        // whole offline backlog (upstream's loop dropped the remaining
        // nodes and never reset its busy flag).
        const queue = createOfflineNodeQueue({
            onError: onUnexpectedError,
            isOpen: () => ws.isOpen
        });
        queue.register('message', handleMessage);
        queue.register('call', handleCall);
        queue.register('receipt', handleReceipt);
        queue.register('notification', handleNotification);
        return queue;
    };
    const offlineNodeProcessor = makeOfflineNodeProcessor();
    const processNode = (type, node, identifier, exec) => {
        // AunuBaileys: ignoreKey filter — a matching stanza is dropped
        // before any handling (no decryption, no persistence); messages
        // are still acked so the server stops redelivering them.
        if (sock.aunuIgnoreFilter?.shouldDrop(type, node, [authState.creds.me?.id, authState.creds.me?.lid].filter(Boolean))) {
            if (type === 'message') {
                sendMessageAck(node).catch(() => { });
            }
            logger.debug({ type, from: node.attrs.from, id: node.attrs.id }, 'aunu: stanza dropped by ignoreKey');
            return;
        }
        const isOffline = !!node.attrs.offline;
        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node);
        }
        else {
            processNodeWithBuffer(node, identifier, exec);
        }
    };
    // Handles newsletter notifications
    async function handleNewsletterNotification(node) {
        const from = node.attrs.from;
        const child = getAllBinaryNodeChildren(node)[0];
        if (!child) {
            return;
        }
        const author = node.attrs.participant;
        logger.info({ from, child }, 'got newsletter notification');
        switch (child.tag) {
            case 'reaction':
                const reactionUpdate = {
                    id: from,
                    server_id: child.attrs.message_id,
                    reaction: {
                        code: getBinaryNodeChildString(child, 'reaction'),
                        count: 1
                    }
                };
                ev.emit('newsletter.reaction', reactionUpdate);
                break;
            case 'view':
                const viewUpdate = {
                    id: from,
                    server_id: child.attrs.message_id,
                    count: parseInt(child.content?.toString() || '0', 10)
                };
                ev.emit('newsletter.view', viewUpdate);
                break;
            case 'participant':
                const participantUpdate = {
                    id: from,
                    author,
                    user: child.attrs.jid,
                    action: child.attrs.action,
                    new_role: child.attrs.role
                };
                ev.emit('newsletter-participants.update', participantUpdate);
                break;
            case 'update':
                const settingsNode = getBinaryNodeChild(child, 'settings');
                if (settingsNode) {
                    const update = {};
                    const nameNode = getBinaryNodeChild(settingsNode, 'name');
                    if (nameNode?.content)
                        update.name = nameNode.content.toString();
                    const descriptionNode = getBinaryNodeChild(settingsNode, 'description');
                    if (descriptionNode?.content)
                        update.description = descriptionNode.content.toString();
                    ev.emit('newsletter-settings.update', {
                        id: from,
                        update
                    });
                }
                break;
            case 'message':
                const plaintextNode = getBinaryNodeChild(child, 'plaintext');
                if (plaintextNode?.content) {
                    try {
                        const contentBuf = typeof plaintextNode.content === 'string'
                            ? Buffer.from(plaintextNode.content, 'binary')
                            : Buffer.from(plaintextNode.content);
                        const messageProto = proto.Message.decode(contentBuf);
                        const fullMessage = proto.WebMessageInfo.fromObject({
                            key: {
                                remoteJid: from,
                                id: child.attrs.message_id || child.attrs.server_id,
                                fromMe: false
                            },
                            message: messageProto,
                            messageTimestamp: +child.attrs.t
                        });
                        await upsertMessage(fullMessage, 'append');
                        logger.info('Processed plaintext newsletter message');
                    }
                    catch (error) {
                        logger.error({ error }, 'Failed to decode plaintext newsletter message');
                    }
                }
                break;
            default:
                logger.warn({ node }, 'Unknown newsletter notification');
                break;
        }
    }
    // Handles mex newsletter notifications
    async function handleMexNewsletterNotification(node) {
        const mexNode = getBinaryNodeChild(node, 'mex');
        if (!mexNode?.content) {
            logger.warn({ node }, 'Invalid mex newsletter notification');
            return;
        }
        let data;
        try {
            data = JSON.parse(mexNode.content.toString());
        }
        catch (error) {
            logger.error({ err: error, node }, 'Failed to parse mex newsletter notification');
            return;
        }
        // AunuBaileys (1.0.71): MEX push notifications arrive as
        // data.xwa2_notify_* instead of operation/updates.
        const notify = data?.data;
        if (notify?.xwa2_notify_username_on_change?.lid) {
            const payload = notify.xwa2_notify_username_on_change;
            ev.emit('username.update', { lid: payload.lid, username: payload.username || null, type: 'set' });
            return;
        }
        if (notify?.xwa2_notify_username_delete?.lid) {
            const payload = notify.xwa2_notify_username_delete;
            ev.emit('username.update', { lid: payload.lid, username: null, displayName: payload.display_name || null, type: 'delete' });
            return;
        }
        if (notify?.xwa2_notify_lid_change?.old && notify?.xwa2_notify_lid_change?.new) {
            // a user's LID rotated: carry the PN we knew for the old LID
            // over to the new one
            const payload = notify.xwa2_notify_lid_change;
            const oldLid = payload.old;
            const newLid = payload.new;
            const pn = aunuLid?.getPNForLID?.(oldLid);
            if (pn) {
                aunuLid.addPair(pn, newLid, { silent: true });
            }
            ev.emit('lid-mapping.update', { oldLid, newLid, pn: pn || null });
            return;
        }
        const operation = data?.operation;
        const updates = data?.updates;
        if (!updates || !operation) {
            logger.warn({ data }, 'Invalid mex newsletter notification content');
            return;
        }
        logger.info({ operation, updates }, 'got mex newsletter notification');
        switch (operation) {
            case 'NotificationNewsletterUpdate':
                for (const update of updates) {
                    if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
                        ev.emit('newsletter-settings.update', {
                            id: update.jid,
                            update: update.settings
                        });
                    }
                }
                break;
            case 'NotificationNewsletterAdminPromote':
                for (const update of updates) {
                    if (update.jid && update.user) {
                        ev.emit('newsletter-participants.update', {
                            id: update.jid,
                            author: node.attrs.from,
                            user: update.user,
                            new_role: 'ADMIN',
                            action: 'promote'
                        });
                    }
                }
                break;
            case 'NotificationLinkedProfilesUpdates':
                for (const update of updates) {
                    const lid = update?.jid;
                    const addedProfiles = Array.isArray(update?.added_profiles) ? update.added_profiles : [];
                    for (const profile of addedProfiles) {
                        const pn = typeof profile === 'string' ? profile : (profile?.pn ?? profile?.jid ?? null);
                        if (lid && pn) {
                            aunuLid?.addPair?.(pn, lid, { silent: true });
                            ev.emit('lid-mapping.update', { lid, pn });
                        }
                    }
                }
                break;
            default:
                logger.info({ operation, data }, 'Unhandled mex newsletter notification');
                break;
        }
    }
    /**
     * Handles the <status> stanzas the server pushes for newsletter posts.
     * Arrives on the CB:status channel.
     */
    const handleNewsletterStatus = async (node) => {
        const { id, from, server_id, t, is_sender, offline, type, edit } = node.attrs;
        const serverId = server_id ? +server_id : undefined;
        const timestamp = t ? +t : undefined;
        const isSender = is_sender === 'true';
        const offlineIndex = offline !== undefined ? +offline : undefined;
        // optional <meta> child: edit timestamps, interaction type, parent/response ids
        const metaNode = getBinaryNodeChild(node, 'meta');
        const meta = metaNode
            ? {
                ...(metaNode.attrs.msg_edit_t ? { editedAt: +metaNode.attrs.msg_edit_t } : {}),
                ...(metaNode.attrs.original_msg_t ? { originalTimestamp: +metaNode.attrs.original_msg_t } : {}),
                ...(metaNode.attrs.interaction_type ? { interactionType: metaNode.attrs.interaction_type } : {}),
                ...(metaNode.attrs.parent_server_id ? { parentServerId: +metaNode.attrs.parent_server_id } : {}),
                ...(metaNode.attrs.response_server_id ? { responseServerId: +metaNode.attrs.response_server_id } : {})
            }
            : undefined;
        const viewsNode = getBinaryNodeChild(node, 'views_count');
        const viewsCount = viewsNode?.attrs?.count !== undefined ? +viewsNode.attrs.count : undefined;
        const responsesNode = getBinaryNodeChild(node, 'responses_count');
        const responsesCount = responsesNode?.attrs?.count !== undefined ? +responsesNode.attrs.count : undefined;
        const reactionsNode = getBinaryNodeChild(node, 'reactions');
        const reactionCounts = getBinaryNodeChildren(reactionsNode ?? { content: [] }, 'reaction').map(r => ({
            code: r.attrs.code,
            count: +r.attrs.count
        }));
        let content = null;
        let mediaType = undefined;
        if (type === 'reaction') {
            content = { type: 'reaction', code: getBinaryNodeChild(node, 'reaction')?.attrs?.code };
        }
        else if (type === 'text' || type === 'media') {
            const plaintextNode = getBinaryNodeChild(node, 'plaintext');
            if (type === 'media') {
                mediaType = plaintextNode?.attrs?.mediatype;
            }
            if (edit === '7' || edit === '8') {
                content = { type: 'revoke', edit };
            }
            else if (plaintextNode?.content) {
                try {
                    const buf = Buffer.isBuffer(plaintextNode.content)
                        ? plaintextNode.content
                        : Buffer.from(plaintextNode.content);
                    const message = proto.Message.decode(buf).toJSON();
                    content = { type, message, ...(mediaType ? { mediaType } : {}) };
                }
                catch (err) {
                    logger.error({ err }, 'Failed to decode newsletter status plaintext');
                    content = { type, raw: true, ...(mediaType ? { mediaType } : {}) };
                }
            }
        }
        // AunuBaileys (1.0.71): emit BEFORE acking — the ack used to go
        // first without a catch, so a socket that closed in that window
        // (sendNode throws Boom 'Connection Closed') swallowed the
        // status event entirely.
        ev.emit('newsletter.status', {
            id: from,
            messageId: id,
            serverId,
            timestamp,
            isSender,
            ...(offlineIndex !== undefined ? { offlineIndex } : {}),
            ...(meta ? { meta } : {}),
            ...(viewsCount !== undefined ? { viewsCount } : {}),
            ...(responsesCount !== undefined ? { responsesCount } : {}),
            ...(reactionCounts.length ? { reactionCounts } : {}),
            content
        });
        const ackType = type === 'reaction' ? 'reaction' : edit ? 'revoke' : type;
        await sendNode({
            tag: 'ack',
            attrs: { id, to: from, class: 'status', type: ackType || 'text' },
            content: undefined
        }).catch((err) => logger.warn({ err }, 'failed to ack newsletter status'));
    };
    // recv a message
    ws.on('CB:message', (node) => {
        processNode('message', node, 'processing message', handleMessage);
    });
    ws.on('CB:call', async (node) => {
        processNode('call', node, 'handling call', handleCall);
    });
    // Call signalling that arrives top-level instead of wrapped in <call>.
    // Tags not in AUNU_CALL_STATE_TAGS are acked only — without a handler
    // the server redelivers them forever.
    for (const callTag of [
        'offer',
        'offer_notice',
        'terminate',
        'accept',
        'reject',
        'preaccept',
        'accept_ack',
        'enc-rekey',
        'enc_rekey',
        'peer_state',
        'group_info',
        'video_state',
        'video_state_ack',
        'flow_control',
        'transport',
        'video',
        'duration',
        'mute_v2',
        'lobby',
        'heartbeat',
        'relaylatency',
        'link_query',
        'waiting_room_request',
        'group_update'
    ]) {
        ws.on('CB:' + callTag, (node) => {
            handleAunuStandaloneCallStanza(node).catch((error) => onUnexpectedError(error, 'handling standalone call stanza'));
        });
    }
    ws.on('CB:receipt', node => {
        processNode('receipt', node, 'handling receipt', handleReceipt);
    });
    ws.on('CB:notification', async (node) => {
        processNode('notification', node, 'handling notification', handleNotification);
    });
    ws.on('CB:status', async (node) => {
        await handleNewsletterStatus(node).catch(error => onUnexpectedError(error, 'handling newsletter status'));
    });
    ws.on('CB:ack,class:message', (node) => {
        handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'));
    });
    ev.on('call', ([call]) => {
        if (!call) {
            return;
        }
        // missed call + group call notification message generation
        if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
            const msg = {
                key: {
                    remoteJid: call.chatId,
                    id: call.id,
                    fromMe: false
                },
                messageTimestamp: unixTimestampSeconds(call.date)
            };
            if (call.status === 'timeout') {
                if (call.isGroup) {
                    msg.messageStubType = call.isVideo
                        ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
                        : WAMessageStubType.CALL_MISSED_GROUP_VOICE;
                }
                else {
                    msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE;
                }
            }
            else {
                msg.message = { call: { callKey: Buffer.from(call.id) } };
            }
            const protoMsg = proto.WebMessageInfo.fromObject(msg);
            // AunuBaileys: this floated unawaited and uncaught — a
            // rejection here was an unhandledRejection that could kill
            // the host process.
            upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
                .catch(err => onUnexpectedError(err, 'upserting call message'));
        }
    });
    ev.on('connection.update', ({ isOnline }) => {
        if (typeof isOnline !== 'undefined') {
            sendActiveReceipts = isOnline;
            logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`);
        }
    });
    return {
        ...sock,
        sendMessageAck,
        sendRetryRequest,
        rejectCall,
        acceptCall,
        terminateCall,
        fetchMessageHistory,
        requestPlaceholderResend
    };
};
//# sourceMappingURL=messages-recv.js.map