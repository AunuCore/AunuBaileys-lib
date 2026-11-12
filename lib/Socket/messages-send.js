import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { BIZ_BOT_SUPPORT_PAYLOAD, DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, delay, extractDeviceJids, generateMessageIDV2, buildCallOfferContent, buildGroupCallCancelStanza, buildGroupCallStanza, createCallKey, newCallId, generateWAMessage, generateWAMessageFromContent, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, hashImagePollOption, normalizeMessageContent, parseAndInjectE2ESessions, prepareWAMessageMedia, unixTimestampSeconds, shouldIncludeBizBinaryNode, setBotMessageSecret } from '../Utils/index.js';
import { sentMessageCacheFor } from '../Utils/sent-message-cache.js';
import { getUrlInfo } from '../Utils/link-preview.js';
import { areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, getBizBinaryNode, isJidGroup, isJidNewsletter, isJidUser, isLidUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { makeGroupsSocket } from './groups.js';
import { makeNewsletterSocket } from './newsletter.js';
// AunuBaileys (1.0.71): uploads one image per poll option and returns
// the hashed options for the parent poll alongside the prepared media
// the children will carry.
const prepareImagePollOptions = async (imagePoll, genOptions) => {
    if (!Array.isArray(imagePoll.options) || !imagePoll.options.length) {
        throw new Boom('Invalid imagePoll options', { statusCode: 400 });
    }
    const optionMedia = [];
    const options = [];
    for (const option of imagePoll.options) {
        if (!option?.image) {
            throw new Boom('every imagePoll option needs an image', { statusCode: 400 });
        }
        const media = await prepareWAMessageMedia({ image: option.image }, genOptions);
        optionMedia.push(media);
        options.push({
            optionName: option.name,
            optionHash: hashImagePollOption(option.name, media.imageMessage?.fileSha256)
        });
    }
    return { optionMedia, options };
};
export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: axiosOptions, patchMessageBeforeSending, cachedGroupMetadata } = config;
    const sock = makeNewsletterSocket(makeGroupsSocket(config));
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, ws, waitForSocketOpen } = sock;
    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
            useClones: false
        });
    let mediaConn;
    const refreshMediaConn = async (forceGet = false) => {
        // AunuBaileys (1.0.68): a cached mediaConn promise that rejected
        // used to re-throw here forever, wedging ALL media uploads until
        // restart. A rejected cache is discarded so the refresh below
        // can run again.
        let media;
        try {
            media = await mediaConn;
        }
        catch {
            media = undefined;
            mediaConn = undefined;
        }
        if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: S_WHATSAPP_NET
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
                const node = {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            })().catch(err => {
                // AunuBaileys (1.0.68): a failed fetch must not poison
                // the cache — clear it so the next caller retries.
                mediaConn = undefined;
                throw err;
            });
        }
        return mediaConn;
    };
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds || messageIds.length === 0) {
            throw new Boom('missing ids in receipt');
        }
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = unixTimestampSeconds().toString();
        }
        if (type === 'sender' && isJidUser(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            logger.debug('not using cache for devices');
        }
        const toFetch = [];
        jids = Array.from(new Set(jids));
        for (let jid of jids) {
            const user = jidDecode(jid)?.user;
            // AunuBaileys (1.0.68): a JID without '@' decodes to no
            // user, and NodeCache.get(undefined) throws — skip it
            // instead of failing the whole device lookup.
            if (!user) {
                logger.warn({ jid }, 'skipping malformed JID in device lookup');
                continue;
            }
            jid = jidNormalizedUser(jid);
            if (useCache) {
                const devices = userDevicesCache.get(user);
                if (devices) {
                    deviceResults.push(...devices);
                    logger.trace({ user }, 'using cache for devices');
                }
                else {
                    toFetch.push(jid);
                }
            }
            else {
                toFetch.push(jid);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const query = new USyncQuery().withContext('message').withDeviceProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid));
        }
        const result = await sock.executeUSyncQuery(query);
        if (result) {
            const extracted = extractDeviceJids(result?.list, authState.creds.me?.id, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
                deviceResults.push(item);
            }
            for (const key in deviceMap) {
                userDevicesCache.set(key, deviceMap[key]);
            }
        }
        return deviceResults;
    };
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = jids;
        }
        else {
            const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid));
            const sessions = await authState.keys.get('session', addrs);
            for (const jid of jids) {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid }
                        }))
                    }
                ]
            });
            await parseAndInjectE2ESessions(result, signalRepository, logger);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        //TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = jidNormalizedUser(authState.creds.me.id);
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force'
            }
        });
        return msgId;
    };
    const createParticipantNodes = async (jids, message, extraAttrs) => {
        let patched = await patchMessageBeforeSending(message, jids);
        if (!Array.isArray(patched)) {
            patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched];
        }
        let shouldIncludeDeviceIdentity = false;
        const nodes = await Promise.all(patched.map(async (patchedMessageWithJid) => {
            // AunuBaileys (1.0.68): one recipient's failure used to kill
            // the whole send (group of 100 failed for 1 bad device).
            // Isolate per recipient; only fail when NOTHING succeeded.
            try {
            const { recipientJid: jid, ...patchedMessage } = patchedMessageWithJid;
            if (!jid) {
                return {};
            }
            const bytes = encodeWAMessage(patchedMessage);
            let encResult;
            try {
                encResult = await signalRepository.encryptMessage({ jid, data: bytes });
            }
            catch (encErr) {
                // AunuBaileys: a corrupt/rotten stored session makes EVERY send to
                // this JID fail at encrypt time, forever. Heal it the Signal way:
                // drop the session, fetch a fresh bundle, encrypt once more.
                if (!/session/i.test(String(encErr?.message || encErr))) {
                    throw encErr;
                }
                logger.warn({ jid, err: encErr?.message }, 'aunu: encrypt failed on a stale session; refreshing the session and retrying once');
                await signalRepository.deleteSession(jid);
                await assertSessions([jid], true);
                encResult = await signalRepository.encryptMessage({ jid, data: bytes });
            }
            const { type, ciphertext } = encResult;
            if (type === 'pkmsg') {
                shouldIncludeDeviceIdentity = true;
            }
            const node = {
                tag: 'to',
                attrs: { jid },
                content: [
                    {
                        tag: 'enc',
                        attrs: {
                            v: '2',
                            type,
                            ...(extraAttrs || {})
                        },
                        content: ciphertext
                    }
                ]
            };
            return node;
            }
            catch (err) {
                logger.warn({ jid: patchedMessageWithJid?.recipientJid, err: err?.message }, 'aunu: encryption failed for one recipient; skipping them');
                return null;
            }
        }));
        const filteredNodes = nodes.filter(Boolean);
        if (patched.length && !filteredNodes.length) {
            throw new Boom('All encryptions failed', { statusCode: 500 });
        }
        return { nodes: filteredNodes, shouldIncludeDeviceIdentity };
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, addBizAttributes, statusJidList, statusPrivacy }) => {
        if (!ws.isOpen) {
            // AunuBaileys: a send attempted during a reconnect window used to die
            // instantly with Boom 428 from the first internal query — the message
            // was simply lost unless the consumer retried. Now the send waits for
            // the transport to reopen, bounded by connectTimeoutMs; a connection
            // that closes for good still fails fast via waitForSocketOpen itself.
            const waitMs = config.connectTimeoutMs ?? 60000;
            await Promise.race([
                waitForSocketOpen(),
                delay(waitMs).then(() => {
                    throw new Boom(`Timed out waiting ${waitMs}ms for the connection to open before sending`, { statusCode: 408 }); // 408 = DisconnectReason.timedOut
                })
            ]);
        }
        // AunuBaileys (1.0.68): fail with a clear Boom instead of a raw
        // TypeError when sending before pairing completes or with a
        // malformed destination JID.
        const meId = authState.creds.me?.id;
        if (!meId) {
            throw new Boom('Not authenticated');
        }
        let shouldIncludeDeviceIdentity = false;
        const decodedJid = jidDecode(jid);
        if (!decodedJid) {
            throw new Boom(`Invalid JID: ${jid}`, { statusCode: 400 });
        }
        const { user, server } = decodedJid;
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isBroadcast = server === 'broadcast';
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        msgId = msgId || generateMessageIDV2(sock.user?.id);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus && !isBroadcast;
        const participants = [];
        // AunuBaileys (1.0.71): a broadcast list keeps its own JID as
        // the sender-key group — it is not re-encoded like a chat JID.
        // AunuBaileys (1.0.71): preserve the 'interop' server — the old
        // fallback rewrote interop destinations to s.whatsapp.net.
        const destinationJid = isStatus ? statusJid : isBroadcast ? jid : jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : server === 'interop' ? 'interop' : 's.whatsapp.net');
        const binaryNodeContent = [];
        // AunuBaileys (protocol behaviour learned from @violetix/baileys):
        // status audience privacy rides as a <meta> node in the stanza.
        if (isStatus && statusPrivacy && !additionalAttributes?.edit) {
            binaryNodeContent.push({
                tag: 'meta',
                attrs: { status_setting: statusPrivacy, session_scope: 'status' }
            });
        }
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo
        };
        const extraAttrs = {};
        if (participant) {
            // when the retry request is not for a group
            // only send to the specific device that asked for a retry
            // otherwise the message is sent out to every device that should be a recipient
            if (!isGroup && !isStatus && !isBroadcast) {
                additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
            }
            const decodedParticipant = jidDecode(participant.jid);
            if (!decodedParticipant) {
                throw new Boom(`Invalid participant JID in relayMessage: ${participant.jid}`, { statusCode: 400 });
            }
            const { user, device } = decodedParticipant;
            devices.push({ user, device });
        }
        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(message);
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType;
            }
            if (isNewsletter) {
                // Patch message if needed, then encode as plaintext
                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message;
                const bytes = encodeNewsletterMessage(patched);
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: {},
                    content: bytes
                });
                const stanza = {
                    tag: 'message',
                    attrs: {
                        to: jid,
                        id: msgId,
                        // AunuBaileys (1.0.72): media posts to a channel
                        // were stamped type 'text' — getMessageType only
                        // distinguishes polls, and this early-returning
                        // stanza never receives the mediatype attr that
                        // regular chats use. The channel server
                        // discriminates posts by this attribute, so
                        // media arrived broken while sendMessage
                        // resolved successfully (auditor B6, mechanism
                        // as it exists in this tree). getMediaType is
                        // already computed above in this function.
                        type: getMediaType(message) || getMessageType(message),
                        ...(additionalAttributes || {})
                    },
                    content: binaryNodeContent
                };
                logger.debug({ msgId }, `sending newsletter message to ${jid}`);
                await sendNode(stanza);
                sentMessageCacheFor(config).add(jid, msgId, message);
                return;
            }
            if (normalizeMessageContent(message)?.pinInChatMessage) {
                extraAttrs['decrypt-fail'] = 'hide';
            }
            if (isGroup || isStatus || isBroadcast) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined;
                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        else if (!isStatus && !isBroadcast) {
                            groupData = await groupMetadata(jid);
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid]);
                            return result[jid] || {};
                        }
                        return {};
                    })()
                ]);
                if (!participant) {
                    const participantsList = groupData && !isStatus && !isBroadcast && Array.isArray(groupData.participants) ? groupData.participants.map(p => p.id).filter(Boolean) : [];
                    if ((isStatus || isBroadcast) && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    if (!isStatus && !isBroadcast) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: groupData?.addressingMode || 'pn'
                        };
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new Boom('Per-jid patching is not supported in groups');
                }
                const bytes = encodeWAMessage(patched);
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId
                });
                const senderKeyJids = [];
                // ensure a connection is established with every device
                for (const { user, device } of devices) {
                    const jid = jidEncode(user, groupData?.addressingMode === 'lid' ? 'lid' : 's.whatsapp.net', device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                    }
                }
                // if there are some participants with whom the session has not been established
                // if there are, we re-send the senderkey
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs);
                    // AunuBaileys (1.0.72): only devices that actually
                    // received a node are marked as holding the sender
                    // key (HB-71, pola luna 8.2.0). The map used to be
                    // marked optimistically BEFORE encryption, so a
                    // device whose encryption failed was never offered
                    // the sender key again and could not decrypt the
                    // group's messages from this sender.
                    const deliveredJids = new Set(result.nodes.map(n => n.attrs?.jid).filter(Boolean));
                    for (const deliveredJid of senderKeyJids) {
                        if (deliveredJids.has(deliveredJid)) {
                            senderKeyMap[deliveredJid] = true;
                        }
                    }
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg' },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else {
                const meUser = jidDecode(meId)?.user;
                if (!meUser) {
                    throw new Boom('Invalid own JID', { statusCode: 400 });
                }
                if (!participant) {
                    devices.push({ user });
                    if (user !== meUser) {
                        devices.push({ user: meUser });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                        devices.push(...additionalDevices);
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    // AunuBaileys (1.0.68): me.lid is a plain
                    // '<digits>@lid' JID with no ':device' suffix, so
                    // splitting on ':' produced '<digits>@lid@lid'.
                    // Decode it properly like every other fork does.
                    const meLidUser = jidDecode(authState.creds.me?.lid)?.user;
                    const jid = jidEncode(isMe && isLid && meLidUser ? meLidUser : user, isLid ? 'lid' : 's.whatsapp.net', device);
                    if (isMe) {
                        meJids.push(jid);
                    }
                    else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                await assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0];
                    if (peerNode) {
                        binaryNodeContent.push(peerNode); // push only enc
                    }
                }
                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    });
                }
            }
            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    type: getMessageType(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            };
            // if the participant to send to is explicitly specified (generally retry recp)
            // ensure the message is only sent to that person
            // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
            if (participant) {
                if (isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if (areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                ;
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: encodeSignedDeviceIdentity(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (additionalNodes && additionalNodes.length > 0) {
                ;
                stanza.content.push(...additionalNodes);
            }
            // AunuBaileys: biz binary node (dari @itsliaaa/baileys) — otomatis untuk pesan
            // buttons/list/template/native-flow, atau dipaksa opsi secureMetaServiceLabel
            const alreadyHasBizNode = !addBizAttributes &&
                !!additionalNodes?.some(node => node.tag === 'biz');
            if ((!alreadyHasBizNode && shouldIncludeBizBinaryNode(message)) || addBizAttributes) {
                stanza.content.push(getBizBinaryNode(message));
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
        });
        sentMessageCacheFor(config).add(jid, msgId, message);
        // AunuBaileys (1.0.71): register the messageSecret at send time
        // so an msmsg reply can be decrypted even if it arrives before
        // our own message echo comes back (donor messages-send.js).
        if (message.messageContextInfo?.messageSecret) {
            setBotMessageSecret(msgId, message.messageContextInfo.messageSecret, jid);
        }
        return msgId;
    };
    const getMessageType = (message) => {
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
            return 'poll';
        }
        return 'text';
    };
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image';
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video';
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio';
        }
        else if (message.contactMessage) {
            return 'vcard';
        }
        else if (message.documentMessage) {
            return 'document';
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array';
        }
        else if (message.liveLocationMessage) {
            return 'livelocation';
        }
        else if (message.stickerMessage) {
            return 'sticker';
        }
        else if (message.listMessage) {
            return 'list';
        }
        else if (message.listResponseMessage) {
            return 'list_response';
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response';
        }
        else if (message.orderMessage) {
            return 'order';
        }
        else if (message.productMessage) {
            return 'product';
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response';
        }
        else if (message.groupInviteMessage) {
            return 'url';
        }
    };
    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    };
    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');
    // AunuBaileys: mulai panggilan suara/video 1:1 — susun <offer> dengan
    // amplop callKey terenkripsi per perangkat tujuan (destination), sama
    // seperti jalur fan-out relayMessage. Mengembalikan { id, to }.
    const offerCall = async (toJid, isVideo = false) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const callId = newCallId();
        const offerContent = buildCallOfferContent(isVideo);
        const devices = (await getUSyncDevices([toJid], true, false)).map(({ user, device }) => jidEncode(user, 's.whatsapp.net', device));
        await assertSessions(devices, true);
        const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(devices, {
            call: { callKey: createCallKey() }
        }, { count: '0' });
        offerContent.push({ tag: 'destination', attrs: {}, content: destinations });
        if (shouldIncludeDeviceIdentity) {
            offerContent.push({
                tag: 'device-identity',
                attrs: {},
                content: encodeSignedDeviceIdentity(authState.creds.account, true)
            });
        }
        const stanza = {
            tag: 'call',
            attrs: {
                id: generateMessageIDV2(authState.creds.me?.id),
                to: toJid
            },
            content: [
                {
                    tag: 'offer',
                    attrs: {
                        'call-id': callId,
                        'call-creator': authState.creds.me.id
                    },
                    content: offerContent
                }
            ]
        };
        await query(stanza);
        return { id: callId, to: toJid };
    };
    // AunuBaileys: mulai panggilan grup — <offer type="group"> ke JID grup,
    // destination dienkripsi untuk perangkat para peserta yang di-ring.
    const groupCall = async (groupJid, participants = [], isVideo = false) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const callId = newCallId();
        const offerContent = buildCallOfferContent(isVideo);
        const devices = (await getUSyncDevices(participants, true, false)).map(({ user, device }) => jidEncode(user, 's.whatsapp.net', device));
        await assertSessions(devices, true);
        const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(devices, {
            call: { callKey: createCallKey() }
        }, { count: '0' });
        offerContent.push({ tag: 'destination', attrs: {}, content: destinations });
        if (shouldIncludeDeviceIdentity) {
            offerContent.push({
                tag: 'device-identity',
                attrs: {},
                content: encodeSignedDeviceIdentity(authState.creds.account, true)
            });
        }
        const stanza = buildGroupCallStanza({
            id: generateMessageIDV2(authState.creds.me?.id),
            to: groupJid,
            callId,
            callCreator: authState.creds.me.id,
            offerContent
        });
        await query(stanza);
        return { id: callId, to: groupJid };
    };
    // AunuBaileys: batalkan/akhiri panggilan grup yang dimulai groupCall.
    const cancelGroupCall = async (groupJid, callId) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const stanza = buildGroupCallCancelStanza({
            from: authState.creds.me.id,
            to: groupJid,
            callId,
            callCreator: authState.creds.me.id
        });
        await query(stanza);
        return { id: callId, to: groupJid };
    };
    // AunuBaileys (1.0.71): exclusive group message — sends into a
    // group addressed to ONE member only: the stanza goes out as
    // `to=<group> participant=<member>`, so the server routes it to that
    // member's devices and no other member receives anything. Reuses the
    // retry-resend path — per-device pkmsg/msg instead of the group
    // sender key, which is what makes the targeting possible (a `skmsg`
    // stanza is fanned out to the whole group by the server).
    // `exclusive: true` reads the author of the quoted message (that is
    // why a quote is required); pass a JID string to address someone
    // else. One stanza per device of the recipient, all sharing the
    // message id, because a group `participant` attribute addresses a
    // device, not an account.
    const resolveAunuExclusiveTarget = (sendOptions) => {
        if (typeof sendOptions.exclusive === 'string') {
            return sendOptions.exclusive;
        }
        const quoted = sendOptions.quoted;
        return quoted?.key?.participant || quoted?.participant || undefined;
    };
    const relayAunuExclusive = async (jid, message, sendOptions, relayOpts) => {
        if (!isJidGroup(jid)) {
            throw new Boom('exclusive messages are only supported in groups', { statusCode: 400 });
        }
        const target = resolveAunuExclusiveTarget(sendOptions);
        if (!target) {
            throw new Boom('exclusive requires a quoted message to pick the recipient, or an explicit jid', { statusCode: 400 });
        }
        const targetUser = jidNormalizedUser(target);
        if (!targetUser) {
            throw new Boom(`exclusive target is not a valid JID: ${target}`, { statusCode: 400 });
        }
        const devices = await getUSyncDevices([targetUser], relayOpts.useUserDevicesCache !== false, false);
        const deviceJids = devices.map(({ user, device }) => jidEncode(user, 's.whatsapp.net', device)).filter(Boolean);
        // No device list means the member is unknown to usync; addressing
        // the bare jid still reaches their primary device rather than
        // failing the send outright.
        const targets = deviceJids.length ? deviceJids : [targetUser];
        logger.debug({ jid, target: targetUser, devices: targets.length }, 'sending exclusive group message');
        for (const deviceJid of targets) {
            await relayMessage(jid, message, {
                ...relayOpts,
                participant: { jid: deviceJid, count: 0 }
            });
        }
        return targets;
    };
    // AunuBaileys (1.0.71): named so the wrappers below can call the
    // socket's own sendMessage — the `sock` closure variable is the
    // inner (newsletter/groups) socket, which has no sendMessage.
    const out = {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        offerCall,
        groupCall,
        cancelGroupCall,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        fetchPrivacySettings,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        // AunuBaileys: exposed so the notification layer can invalidate a
        // user's entry when the server pushes a device-list change
        // (upstream kept the cache private to this closure, so nothing
        // could ever invalidate it before its TTL expired).
        userDevicesCache,
        updateMediaMessage: async (message) => {
            const content = assertMediaContent(message.message);
            const mediaKey = content.mediaKey;
            // AunuBaileys (1.0.71): remainder of HB-22 — this read sat
            // ahead of relayMessage's guard and threw a raw TypeError
            // when called before pairing completed.
            const meId = authState.creds.me?.id;
            if (!meId) {
                throw new Boom('Not authenticated');
            }
            const node = await encryptMediaRetryRequest(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                // AunuBaileys (1.0.68): the wait used to be unbounded —
                // a peer that never sends media-update hung the caller
                // forever. 120s is generous for a phone re-upload.
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id);
                                if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = proto.MediaRetryNotification.ResultType[media.result];
                                    throw new Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                    });
                                }
                                content.directPath = media.directPath;
                                content.url = getUrlFromDirectPath(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                }, 120_000)
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);
            return message;
        },
        sendMessage: async (jid, content, options = {}) => {
            // AunuBaileys (1.0.71): remainder of HB-22 — same guard as
            // relayMessage, applied at the public entry point.
            const userJid = authState.creds.me?.id;
            if (!userJid) {
                throw new Boom('Not authenticated');
            }
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean'
                    ? disappearingMessagesInChat
                        ? WA_DEFAULT_EPHEMERAL
                        : 0
                    : disappearingMessagesInChat;
                await groupToggleEphemeral(jid, value);
            }
            else {
                // AunuBaileys (1.0.71): an image poll uploads one image
                // per option before the parent is built — the parent only
                // carries each option's hash, and the hash covers the
                // uploaded media's fileSha256. The images follow as
                // children once the parent has a key.
                let imagePollOptionMedia;
                let sendContent = content;
                if ('imagePoll' in content && content.imagePoll) {
                    const prepared = await prepareImagePollOptions(content.imagePoll, {
                        logger,
                        upload: (fp, opts) => waUploadToServer(fp, { ...opts, newsletter: isJidNewsletter(jid) }),
                        mediaCache: config.mediaCache,
                        options: config.options,
                        ...options
                    });
                    imagePollOptionMedia = prepared.optionMedia;
                    sendContent = { ...content, imagePoll: { ...content.imagePoll, options: prepared.options } };
                }
                const fullMsg = await generateWAMessage(jid, sendContent, {
                    logger,
                    userJid,
                    getUrlInfo: text => getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...(axiosOptions || {})
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    //TODO: CACHE
                    getProfilePicUrl: sock.profilePictureUrl,
                    upload: (fp, opts) => waUploadToServer(fp, { ...opts, newsletter: isJidNewsletter(jid) }),
                    mediaCache: config.mediaCache,
                    options: config.options,
                    messageId: generateMessageIDV2(sock.user?.id),
                    ...options
                });
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isPollMessage = ('poll' in content && !!content.poll) || !!imagePollOptionMedia;
                const isAiMsg = 'ai' in content && !!content.ai;
                const isNeedBizAttrs = 'secureMetaServiceLabel' in content && !!content.secureMetaServiceLabel;
                const additionalAttributes = {};
                const additionalNodes = [];
                // required for delete
                if (isDeleteMsg) {
                    // if the chat is a group, and I am not the author, then delete the message as an admin
                    if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                }
                else if (isEditMsg) {
                    additionalAttributes.edit = '1';
                }
                else if (isPinMsg) {
                    additionalAttributes.edit = '2';
                }
                else if (isPollMessage) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            polltype: 'creation'
                        }
                    });
                }
                // AunuBaileys: label AI (dari @itsliaaa/baileys) — hanya chat pribadi
                else if (isAiMsg) {
                    if (!(isJidUser(jid) || isLidUser(jid))) {
                        throw new Boom('AI icon on message are only allowed in private chat', { statusCode: 400 });
                    }
                    if (fullMsg.message.messageContextInfo) {
                        fullMsg.message.messageContextInfo.supportPayload = BIZ_BOT_SUPPORT_PAYLOAD;
                    }
                    additionalNodes.push({
                        tag: 'bot',
                        attrs: { biz_bot: '1' },
                        content: undefined
                    });
                    // AunuBaileys (1.0.72): the ai flag used to be
                    // deleted from the CALLER's content object here —
                    // reusing the same object for a second send silently
                    // lost the AI label (HB-63). The flag is already
                    // consumed above; the caller's object stays intact.
                }
                if ('cachedGroupMetadata' in options) {
                    console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.');
                }
                // AunuBaileys (1.0.72) CRITICAL: this wrapper was
                // declared (message, opts) but called (jid, message,
                // opts) below — in 1.0.71 every sendMessage relayed the
                // JID string as the message (proto-encoding a string
                // yields ZERO bytes without throwing) and the message
                // object as the relay options, so an EMPTY message went
                // out under a fresh id while the caller received a
                // correct-looking result.
                const relay = (jid, message, opts) => options.exclusive
                    ? relayAunuExclusive(jid, message, options, opts)
                    : relayMessage(jid, message, opts);
                await relay(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    statusPrivacy: options.statusPrivacy,
                    additionalNodes,
                    addBizAttributes: isNeedBizAttrs
                });
                // AunuBaileys (1.0.71): the option images follow the parent,
                // each pointing back at it via messageAssociation.
                if (imagePollOptionMedia?.length) {
                    for (const media of imagePollOptionMedia) {
                        const optionMsg = generateWAMessageFromContent(jid, {
                            pollCreationOptionImageMessage: { message: media },
                            messageContextInfo: {
                                messageAssociation: {
                                    parentMessageKey: fullMsg.key,
                                    associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL
                                }
                            }
                        }, {
                            userJid,
                            messageId: generateMessageIDV2(sock.user?.id)
                        });
                        await relay(jid, optionMsg.message, {
                            messageId: optionMsg.key.id,
                            useCachedGroupMetadata: options.useCachedGroupMetadata,
                            additionalAttributes,
                            additionalNodes: []
                        });
                    }
                }
                // AunuBaileys: kirim isi album sebagai pesan terasosiasi (dari @itsliaaa/baileys)
                if ('album' in content) {
                    const { delayMs = 1500 } = options;
                    for (const albumMedia of content.album) {
                        const albumMsg = await generateWAMessage(jid, albumMedia, {
                            logger,
                            userJid,
                            upload: (fp, opts) => waUploadToServer(fp, { ...opts, newsletter: isJidNewsletter(jid) }),
                            mediaCache: config.mediaCache,
                            options: config.options,
                            ...options,
                            messageId: generateMessageIDV2(sock.user?.id)
                        });
                        const normalized = normalizeMessageContent(albumMsg.message);
                        if (!normalized || !('imageMessage' in normalized || 'videoMessage' in normalized)) {
                            throw new Boom('Invalid message type for album', { statusCode: 400 });
                        }
                        albumMsg.message.messageContextInfo = albumMsg.message.messageContextInfo || {};
                        albumMsg.message.messageContextInfo.messageAssociation = {
                            parentMessageKey: fullMsg.key,
                            associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM
                        };
                        await relay(jid, albumMsg.message, {
                            messageId: albumMsg.key.id,
                            useCachedGroupMetadata: options.useCachedGroupMetadata,
                            statusJidList: options.statusJidList,
                            statusPrivacy: options.statusPrivacy,
                    statusPrivacy: options.statusPrivacy,
                            additionalAttributes,
                            additionalNodes
                        });
                        await delay(delayMs);
                    }
                }
                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        // AunuBaileys: catch the floated mutex promise —
                        // a rejection here was an unhandledRejection.
                        processingMutex.mutex(() => upsertMessage(fullMsg, 'append'))
                            .catch(err => logger.error({ err }, 'failed to upsert own message'));
                    });
                }
                return fullMsg;
            }
        },
        // AunuBaileys (1.0.71): base poll wrapper (shape follows
        // @shanks-dev/baileys 0.1.2 prototype-helpers sendPoll).
        sendPoll: async (jid, name, values, options = {}) => {
            const { selectableCount = 1, ...sendOptions } = options;
            return out.sendMessage(jid, { poll: { name, values, selectableCount } }, sendOptions);
        },
        // AunuBaileys (1.0.71): quiz poll — thin wrapper over the
        // existing pollType === 1 + correctAnswer content path.
        sendQuiz: async (jid, name, values, correctAnswer, options = {}) => {
            const { selectableCount = 1, ...sendOptions } = options;
            return out.sendMessage(jid, { poll: { name, values, selectableCount, pollType: 1, correctAnswer } }, sendOptions);
        },
        // AunuBaileys (1.0.71): poll with the theme-A fields — hideVoter
        // -> hideParticipantName, canAddOption -> allowAddOption, and an
        // end time (endDate as a Date, or endTime in epoch seconds).
        // NOTE: the endTime unit is unconfirmed upstream (shanks' own
        // caveat); we accept seconds and convert to the Date our poll
        // branch already reads, so there is exactly one unit in play.
        sendPollPlus: async (jid, name, values, options = {}) => {
            const { selectableCount = 1, endDate, endTime, hideVoter, canAddOption, ...sendOptions } = options;
            const poll = { name, values, selectableCount };
            if (typeof hideVoter !== 'undefined') {
                poll.hideVoter = hideVoter;
            }
            if (typeof canAddOption !== 'undefined') {
                poll.canAddOption = canAddOption;
            }
            if (endDate) {
                poll.endDate = endDate instanceof Date ? endDate : new Date(endDate);
            }
            else if (typeof endTime === 'number') {
                poll.endDate = new Date(endTime > 1e11 ? endTime : endTime * 1000);
            }
            return out.sendMessage(jid, { poll }, sendOptions);
        },
        // AunuBaileys (1.0.71): send an event (see the 'event' branch
        // in generateWAMessageContent).
        sendEvent: async (jid, event, options = {}) => {
            return out.sendMessage(jid, { event }, options);
        },
        // AunuBaileys (1.0.71): RSVP to an event — response is
        // 'going' | 'not_going' | 'maybe', plus an optional
        // extraGuestCount. NOT IMPLEMENTED as a plain send: proto
        // 6.7.24 has no Message.eventResponseMessage field, so RSVPs
        // travel as encEventResponseMessage (field 76), encrypted with
        // the event creation key. This delegates to the 'eventResponse'
        // content branch, which throws a clear Boom 501 instead of
        // silently dropping the reply.
        sendEventResponse: async (jid, response, options = {}) => {
            const { extraGuestCount, ...sendOptions } = options;
            return out.sendMessage(jid, { eventResponse: { response, extraGuestCount } }, sendOptions);
        }
    };
    return out;
};
//# sourceMappingURL=messages-send.js.map