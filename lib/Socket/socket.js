import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import { promisify } from 'util';
import { proto } from '../../WAProto/index.js';
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER } from '../Defaults/index.js';
import { DisconnectReason } from '../Types/index.js'
import { executeWMexQuery } from './mex.js';
import { makeLIDStore } from '../Utils/lid-store.js';
import { createIgnoreFilter } from '../Utils/ignore-filter.js';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getErrorCodeFromStreamError, getNextPreKeysNode, getPlatformId, makeEventBuffer, makeNoiseHandler, promiseTimeout } from '../Utils/index.js';
import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren, jidEncode, S_WHATSAPP_NET } from '../WABinary/index.js';
import { WebSocketClient } from './Client/index.js';
/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */
/**
 * AunuBaileys (behaviour learned from @violetix/baileys): name the
 * disconnect reason in the error message itself — hosts that forward
 * only error.message otherwise cannot tell a dead session
 * (401 loggedOut) from a transient blip (503) and reconnect both.
 * Mutates and returns the error; a no-op for anything else.
 */
export const nameDisconnectReason = (error) => {
    if (error && typeof error.statusCode === 'number' && typeof error.message === 'string' && !error.message.includes('[')) {
        const reasonName = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === error.statusCode);
        if (reasonName) {
            error.message = `${error.message} [${error.statusCode} ${reasonName}]`;
        }
    }
    return error;
};
export const makeSocket = (config) => {
    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;
    if (printQRInTerminal) {
        console.warn('⚠️ The printQRInTerminal option has been deprecated. You will no longer receive QR codes in the terminal automatically. Please listen to the connection.update event yourself and handle the QR your way. You can remove this message by removing this opttion. This message will be removed in a future version.');
    }
    const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl;
    if (config.mobile || url.protocol === 'tcp:') {
        throw new Boom('Mobile API is not supported anymore', { statusCode: DisconnectReason.loggedOut });
    }
    if (url.protocol === 'wss' && authState?.creds?.routingInfo) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }
    const ws = new WebSocketClient(url, config);
    // AunuBaileys (1.0.70): connect() is async — an invalid transport
    // option (bad handshakeTimeout/agent) rejected its promise with no
    // catcher, crashing the process. Route it to end() instead.
    ws.connect().catch(err => {
        logger.error({ err }, 'failed to open websocket');
        end(err);
    });
    const ev = makeEventBuffer(logger);
    /** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
    const ephemeralKeyPair = Curve.generateKeyPair();
    /** WA noise protocol wrapper */
    const noise = makeNoiseHandler({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: NOISE_WA_HEADER,
        logger,
        routingInfo: authState?.creds?.routingInfo
    });
    const { creds } = authState;
    // add transaction capability
    const keys = addTransactionCapability(authState.keys, logger, transactionOpts);
    const signalRepository = makeSignalRepository({ creds, keys });
    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    let lastDisconnectError;
    const uqTagId = generateMdTagPrefix();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = promisify(ws.send);
    /** send a raw buffer */
    const sendRawMessage = async (data) => {
        if (!ws.isOpen) {
            throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed });
        }
        const bytes = noise.encodeFrame(data);
        await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        });
    };
    /** send a binary node */
    const sendNode = (frame) => {
        if (logger.level === 'trace') {
            logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' });
        }
        const buff = encodeBinaryNode(frame);
        return sendRawMessage(buff);
    };
    /** log & process any unexpected errors */
    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `unexpected error in '${msg}'`);
    };
    /** await the next incoming message */
    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new Boom('Connection Closed', {
                statusCode: DisconnectReason.connectionClosed
            });
        }
        let onOpen;
        let onClose;
        const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
        if (sendMsg) {
            sendRawMessage(sendMsg).catch(onClose);
        }
        return result;
    };
    /**
     * Wait for a message with a certain tag to be received
     * @param msgId the message tag to await
     * @param timeoutMs timeout after which the promise will reject
     */
    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv;
        let onErr;
        try {
            const result = await promiseTimeout(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => {
                    reject(err || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed }));
                };
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr); // if the socket closes, you'll never receive the message
                // AunuBaileys: this was ws.off() — the error listener was
                // never attached, so a socket error left every query
                // hanging until its timeout instead of failing fast.
                ws.on('error', onErr);
            });
            return result;
        }
        finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr); // if the socket closes, you'll never receive the message
            ws.off('error', onErr);
        }
    };
    /** send a query, and wait for its response. auto-generates message ID if not provided */
    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }
        const msgId = node.attrs.id;
        const [result] = await Promise.all([waitForMessage(msgId, timeoutMs), sendNode(node)]);
        if ('tag' in result) {
            assertNodeErrorFree(result);
        }
        return result;
    };
    /** connection handshake */
    const validateConnection = async () => {
        let helloMsg = {
            clientHello: { ephemeral: ephemeralKeyPair.public }
        };
        helloMsg = proto.HandshakeMessage.fromObject(helloMsg);
        logger.info({ browser, helloMsg }, 'connected to WA');
        const init = proto.HandshakeMessage.encode(helloMsg).finish();
        const result = await awaitNextMessage(init);
        const handshake = proto.HandshakeMessage.decode(result);
        logger.trace({ handshake }, 'handshake recv from WA');
        const keyEnc = await noise.processHandshake(handshake, creds.noiseKey);
        let node;
        if (!creds.me) {
            node = generateRegistrationNode(creds, config);
            logger.info({ node }, 'not logged in, attempting registration...');
        }
        else {
            node = generateLoginNode(creds.me.id, config);
            logger.info({ node }, 'logging in...');
        }
        const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish());
        await sendRawMessage(proto.HandshakeMessage.encode({
            clientFinish: {
                static: keyEnc,
                payload: payloadEnc
            }
        }).finish());
        noise.finishInit();
        startKeepAliveRequest();
    };
    const getAvailablePreKeysOnServer = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                xmlns: 'encrypt',
                type: 'get',
                to: S_WHATSAPP_NET
            },
            content: [{ tag: 'count', attrs: {} }]
        });
        const countChild = getBinaryNodeChild(result, 'count');
        // AunuBaileys (1.0.70): the twin guard in handleEncryptNotification
        // landed in 1.0.66; this one was missed. A count-less response
        // used to throw here, breaking login completion every reconnect.
        // 0 means "unknown" — the caller then uploads fresh pre-keys.
        if (!countChild?.attrs?.value) {
            logger.warn({ result }, 'pre-key count response has no count child; assuming 0');
            return 0;
        }
        return +countChild.attrs.value;
    };
    /** generates and uploads a set of pre-keys to the server */
    const uploadPreKeys = async (count = INITIAL_PREKEY_COUNT) => {
        logger.info({ count }, 'uploading pre-keys');
        // AunuBaileys: generate + COMMIT the keys first, and only then
        // tell the server. This used to send the IQ from inside the
        // transaction, so a crash between the send and the commit left
        // the server holding pre-key IDs whose private halves were
        // never persisted ("key used already or never filled").
        const { update, node } = await keys.transaction(async () => await getNextPreKeysNode({ creds, keys }, count));
        // AunuBaileys: timeout upload pre-keys agar koneksi tidak menggantung (dari MichelleBot/baileys)
        await promiseTimeout(30000, async (resolve, reject) => {
            try {
                resolve(await query(node));
            }
            catch (error) {
                reject(error);
            }
        });
        ev.emit('creds.update', update);
        logger.info({ count }, 'uploaded pre-keys');
    };
    const uploadPreKeysToServerIfRequired = async () => {
        const preKeyCount = await getAvailablePreKeysOnServer();
        logger.info(`${preKeyCount} pre-keys found on server`);
        if (preKeyCount <= MIN_PREKEY_COUNT) {
            await uploadPreKeys();
        }
    };
    const onMessageReceived = (data) => {
        // AunuBaileys (1.0.67): decodeFrame is async — a malformed frame
        // (bad GCM tag, truncated binary node) or a throwing frame
        // listener must not become an unhandled rejection that kills
        // the process; route failures to onUnexpectedError instead.
        Promise.resolve(noise.decodeFrame(data, frame => {
            // reset ping timeout
            lastDateRecv = new Date();
            let anyTriggered = false;
            anyTriggered = ws.emit('frame', frame);
            // if it's a binary node
            if (!(frame instanceof Uint8Array)) {
                const msgId = frame.attrs.id;
                if (logger.level === 'trace') {
                    logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' });
                }
                /* Check if this is a response to a message we sent */
                anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered;
                /* Check if this is a response to a message we are expecting */
                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : '';
                for (const key of Object.keys(l1)) {
                    anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered;
                }
                anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered;
                anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered;
                if (!anyTriggered && logger.level === 'debug') {
                    logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv');
                }
            }
        })).catch(err => onUnexpectedError(err, 'onMessageReceived'));
    };
    // AunuBaileys: socket end handlers (pola v7) + fetch Mex (dari @itsliaaa/baileys)
    const socketEndHandlers = [];
    const registerSocketEndHandler = (handler) => {
        socketEndHandlers.push(handler);
    };
    const end = (error) => {
        if (closed) {
            logger.trace({ trace: error?.stack }, 'connection already closed');
            return;
        }
        closed = true;
        nameDisconnectReason(error);
        lastDisconnectError = error;
        logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed');
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners('close');
        ws.removeAllListeners('open');
        ws.removeAllListeners('message');
        if (!ws.isClosed && !ws.isClosing) {
            try {
                ws.close();
            }
            catch { }
        }
        ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {
                error,
                date: new Date()
            }
        });
        for (const handler of socketEndHandlers) {
            try {
                handler();
            }
            catch { }
        }
        ev.removeAllListeners('connection.update');
        ev.destroy?.();
    };
    const waitForSocketOpen = async () => {
        if (ws.isOpen) {
            return;
        }
        if (ws.isClosed || ws.isClosing) {
            throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed });
        }
        let onOpen;
        let onClose;
        await new Promise((resolve, reject) => {
            onOpen = () => resolve(undefined);
            onClose = mapWebSocketError(reject);
            ws.on('open', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('open', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
    };
    const keepAliveTick = () => {
        if (!lastDateRecv) {
            lastDateRecv = new Date();
        }
        const diff = Date.now() - lastDateRecv.getTime();
        /*
            check if it's been a suspicious amount of time since the server responded with our last seen
            it could be that the network is down
        */
        // AunuBaileys: tolerate up to two missed keep-alive intervals
        // before declaring the connection lost. Upstream ended it after
        // a single unanswered ping (> interval + 5s): on a quiet
        // connection the ping response is the only inbound traffic, so
        // one lost pong killed a healthy connection and forced a full
        // reconnect (with its pairing and message-loss windows). Two
        // consecutive misses still end it; genuinely dead connections
        // are detected ~one interval later than before.
        if (diff > 2 * keepAliveIntervalMs + 5000) {
            end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }));
        }
        else if (ws.isOpen) {
            // if its all good, send a keep alive request
            query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    to: S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:p'
                },
                content: [{ tag: 'ping', attrs: {} }]
            }).catch(err => {
                logger.error({ trace: err.stack }, 'error in sending keep alive');
            });
        }
        else {
            logger.warn('keep alive called when WS not open');
        }
    };
    const startKeepAliveRequest = () => {
        // AunuBaileys (behaviour learned from @violetix/baileys): stagger
        // the first ping by a random offset — sockets sharing one process
        // otherwise all ping in the same tick.
        const staggerMs = Math.floor(Math.random() * Math.max(1, keepAliveIntervalMs));
        keepAliveReq = setTimeout(() => {
            keepAliveTick();
            keepAliveReq = setInterval(keepAliveTick, keepAliveIntervalMs);
        }, staggerMs);
    };
    /** i have no idea why this exists. pls enlighten me */
    const sendPassiveIq = (tag) => query({
        tag: 'iq',
        attrs: {
            to: S_WHATSAPP_NET,
            xmlns: 'passive',
            type: 'set'
        },
        content: [{ tag, attrs: {} }]
    });
    /** logout & invalidate connection */
    const logout = async (msg) => {
        // AunuBaileys (1.0.70): the remove-companion-device IQ used to
        // be able to throw before end() ran, leaving the socket open
        // and the session valid after a "logout".
        try {
        const jid = authState.creds.me?.id;
        if (jid) {
            await sendNode({
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    type: 'set',
                    id: generateMessageTag(),
                    xmlns: 'md'
                },
                content: [
                    {
                        tag: 'remove-companion-device',
                        attrs: {
                            jid,
                            reason: 'user_initiated'
                        }
                    }
                ]
            });
        }
        }
        finally {
            end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }));
        }
    };
    let pairingCodeRequestInFlight = false;
    const PAIRING_READY_TIMEOUT_MS = 30000;
    const describeLastDisconnect = () => {
        if (!lastDisconnectError) {
            return 'no disconnect recorded yet';
        }
        const code = lastDisconnectError?.data?.statusCode ?? lastDisconnectError?.output?.statusCode;
        return `${code ? `status ${code} — ` : ''}${lastDisconnectError?.message || String(lastDisconnectError)}`;
    };
    // AunuBaileys: pairing must not fire its IQ into a socket that is not
    // open yet (upstream throws a bare 428 'Connection Closed'). Wait for
    // the transport to open, fail fast when the connection dies meanwhile,
    // and always surface WHY via the last disconnect reason.
    const waitForPairingReady = async () => {
        if (ws.isOpen) {
            return;
        }
        if (closed || ws.isClosed || ws.isClosing) {
            throw new Boom(`requestPairingCode: connection is already closed (last disconnect: ${describeLastDisconnect()})`, { statusCode: DisconnectReason.connectionClosed });
        }
        let onUpdate;
        const closedWhileWaiting = new Promise((_, reject) => {
            onUpdate = (update) => {
                if (update.connection === 'close') {
                    reject(new Boom(`requestPairingCode: connection closed while waiting for the socket to open (last disconnect: ${describeLastDisconnect()})`, { statusCode: DisconnectReason.connectionClosed }));
                }
            };
            ev.on('connection.update', onUpdate);
        });
        let timer;
        const timedOut = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Boom(`requestPairingCode: socket did not open within ${PAIRING_READY_TIMEOUT_MS / 1000}s (last disconnect: ${describeLastDisconnect()})`, { statusCode: DisconnectReason.timedOut }));
            }, PAIRING_READY_TIMEOUT_MS);
        });
        try {
            await Promise.race([
                waitForSocketOpen().catch(() => {
                    throw new Boom(`requestPairingCode: connection closed while waiting for the socket to open (last disconnect: ${describeLastDisconnect()})`, { statusCode: DisconnectReason.connectionClosed });
                }),
                closedWhileWaiting,
                timedOut
            ]);
        }
        finally {
            clearTimeout(timer);
            if (onUpdate) {
                try {
                    ev.off('connection.update', onUpdate);
                }
                catch { }
            }
        }
    };
    const requestPairingCode = async (phoneNumber, customPairingCode) => {
        if (authState.creds.registered) {
            throw new Error('requestPairingCode: this session is already registered — pairing codes are only for new logins');
        }
        if (pairingCodeRequestInFlight) {
            throw new Error('requestPairingCode: a pairing code request is already in flight — wait for it to finish instead of firing another one (double requests invalidate the first code)');
        }
        const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5));
        if (customPairingCode && customPairingCode?.length !== 8) {
            throw new Error('Custom pairing code must be exactly 8 chars');
        }
        pairingCodeRequestInFlight = true;
        try {
        await waitForPairingReady();
        authState.creds.pairingCode = pairingCode;
        authState.creds.me = {
            id: jidEncode(phoneNumber, 's.whatsapp.net'),
            name: '~'
        };
        ev.emit('creds.update', authState.creds);
        await sendNode({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                id: generateMessageTag(),
                xmlns: 'md'
            },
            content: [
                {
                    tag: 'link_code_companion_reg',
                    attrs: {
                        jid: authState.creds.me.id,
                        stage: 'companion_hello',
                        should_show_push_notification: 'true'
                    },
                    content: [
                        {
                            tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                            attrs: {},
                            content: await generatePairingKey()
                        },
                        {
                            tag: 'companion_server_auth_key_pub',
                            attrs: {},
                            content: authState.creds.noiseKey.public
                        },
                        {
                            tag: 'companion_platform_id',
                            attrs: {},
                            content: getPlatformId(browser[1])
                        },
                        {
                            tag: 'companion_platform_display',
                            attrs: {},
                            content: `${browser[1]} (${browser[0]})`
                        },
                        {
                            tag: 'link_code_pairing_nonce',
                            attrs: {},
                            content: '0'
                        }
                    ]
                }
            ]
        });
        return authState.creds.pairingCode;
        }
        catch (err) {
            // AunuBaileys: the optimistic creds.me / pairingCode written
            // above must not survive a failed request — a persisted
            // fake `me` on an unregistered session sends the next boot
            // into 401 login loops.
            if (!authState.creds.registered) {
                delete authState.creds.me;
                delete authState.creds.pairingCode;
                ev.emit('creds.update', authState.creds);
            }
            const msg = err?.message || '';
            const isClosedErr = err?.output?.statusCode === DisconnectReason.connectionClosed || /connection closed/i.test(msg);
            if (isClosedErr && !msg.startsWith('requestPairingCode')) {
                throw new Boom(`requestPairingCode failed: connection closed before the pairing request could be delivered (last disconnect: ${describeLastDisconnect()}). Original error: ${msg}`, { statusCode: DisconnectReason.connectionClosed });
            }
            throw err;
        }
        finally {
            pairingCodeRequestInFlight = false;
        }
    };
    async function generatePairingKey() {
        const salt = randomBytes(32);
        const randomIv = randomBytes(16);
        const key = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv);
        return Buffer.concat([salt, randomIv, ciphered]);
    }
    const sendWAMBuffer = (wamBuffer) => {
        return query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                id: generateMessageTag(),
                xmlns: 'w:stats'
            },
            content: [
                {
                    tag: 'add',
                    attrs: {},
                    content: wamBuffer
                }
            ]
        });
    };
    ws.on('message', onMessageReceived);
    ws.on('open', async () => {
        try {
            await validateConnection();
        }
        catch (err) {
            logger.error({ err }, 'error in validating connection');
            end(err);
        }
    });
    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })));
    // the server terminated the connection
    ws.on('CB:xmlstreamend', () => end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed })));
    // QR gen
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        // AunuBaileys: an async stanza handler's rejection is nobody's
        // catch — guard it like pair-success below, or a failed pairing
        // IQ takes the whole process down as an unhandled rejection.
        try {
        const iq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'result',
                id: stanza.attrs.id
            }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const advB64 = creds.advSecretKey;
        let qrMs = qrTimeout || 60000; // time to let a QR live
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            const refNode = refNodes.shift();
            if (!refNode) {
                end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));
                return;
            }
            // AunuBaileys (1.0.70): a ref node without content is a
            // legal encoding, but toString() on undefined threw — and
            // the recursive call sits outside any try, so the 2nd+ QR
            // cycle crashed the process. Skip and schedule the next QR.
            if (refNode.content == null) {
                logger.warn('pair-device ref node has no content; skipping this QR cycle');
                qrTimer = setTimeout(genPairQR, qrMs);
                return;
            }
            const ref = refNode.content.toString('utf-8');
            const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
            ev.emit('connection.update', { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000; // shorter subsequent qrs
        };
        genPairQR();
        }
        catch (error) {
            logger.info({ trace: error.stack }, 'error in pair-device');
            end(error);
        }
    });
    // device paired for the first time
    // if device pairs successfully, the server asks to restart the connection
    ws.on('CB:iq,,pair-success', async (stanza) => {
        logger.debug('pair success recv');
        try {
            const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds);
            logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, 'pairing configured successfully, expect to restart the connection...');
            ev.emit('creds.update', updatedCreds);
            ev.emit('connection.update', { isNewLogin: true, qr: undefined });
            await sendNode(reply);
        }
        catch (error) {
            logger.info({ trace: error.stack }, 'error in pairing');
            end(error);
        }
    });
    // login complete
    ws.on('CB:success', async (node) => {
        // AunuBaileys: guard the login-completion handler — a failed
        // pre-key upload or passive IQ here was an unhandled rejection
        // (or worse, a silently half-open connection). Ending with the
        // error lets the host's reconnect logic retry the handshake.
        try {
            await uploadPreKeysToServerIfRequired();
            await sendPassiveIq('active');
            logger.info('opened connection to WA');
            clearTimeout(qrTimer); // will never happen in all likelyhood -- but just in case WA sends success on first try
            ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } });
            ev.emit('connection.update', { connection: 'open' });
        }
        catch (error) {
            logger.error({ error }, 'error completing login');
            end(error);
        }
    });
    ws.on('CB:stream:error', (node) => {
        logger.error({ node }, 'stream errored out');
        const { reason, statusCode } = getErrorCodeFromStreamError(node);
        end(new Boom(`Stream Errored (${reason})`, { statusCode, data: node }));
    });
    // stream fail, possible logout
    ws.on('CB:failure', (node) => {
        const reason = +(node.attrs.reason || 500);
        end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }));
    });
    ws.on('CB:ib,,downgrade_webclient', () => {
        end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }));
    });
    ws.on('CB:ib,,offline_preview', (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        // AunuBaileys (1.0.70): a floating sendNode here could reject
        // unhandled if the socket closed in the meantime.
        sendNode({
            tag: 'ib',
            attrs: {},
            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
        }).catch(err => logger.warn({ err }, 'failed to request offline batch'));
        // NOTE: the full offline drain (repeat until a short batch)
        // lands in 1.0.71 with the farm batch, not here.
    });
    ws.on('CB:ib,,edge_routing', (node) => {
        const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing');
        const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info');
        if (routingInfo?.content) {
            authState.creds.routingInfo = Buffer.from(routingInfo?.content);
            ev.emit('creds.update', authState.creds);
        }
    });
    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id) {
            // start buffering important events
            // if we're logged in
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });
    // called when all offline notifs are handled
    ws.on('CB:ib,,offline', (node) => {
        const child = getBinaryNodeChild(node, 'offline');
        const offlineNotifs = +(child?.attrs.count || 0);
        logger.info(`handled ${offlineNotifs} offline messages/notifications`);
        if (didStartBuffer) {
            ev.flush();
            logger.trace('flushed events for initial buffer');
        }
        ev.emit('connection.update', { receivedPendingNotifications: true });
    });
    // update credentials when required
    ev.on('creds.update', update => {
        const name = update.me?.name;
        // if name has just been received
        if (creds.me?.name !== name) {
            logger.debug({ name }, 'updated pushName');
            sendNode({
                tag: 'presence',
                attrs: { name: name }
            }).catch(err => {
                logger.warn({ trace: err.stack }, 'error in sending presence update on name change');
            });
        }
        Object.assign(creds, update);
    });
    const fetchAccountReachoutTimelock = async () => {
        const queryResult = await executeWMexQuery({}, QueryIds.REACHOUT_TIMELOCK, XWAPaths.xwa2_fetch_account_reachout_timelock, query, generateMessageTag);
        const result = {
            isActive: !!queryResult?.is_active,
            timeEnforcementEnds: queryResult?.time_enforcement_ends && queryResult?.time_enforcement_ends !== '0'
                ? new Date(parseInt(queryResult.time_enforcement_ends, 10) * 1000)
                : undefined,
            enforcementType: queryResult?.enforcement_type ?? 'DEFAULT'
        };
        ev.emit('connection.update', { reachoutTimeLock: result });
        return result;
    };
    const fetchNewChatMessageCap = async () => {
        return executeWMexQuery({ input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } }, QueryIds.MESSAGE_CAPPING_INFO, XWAPaths.xwa2_message_capping_info, query, generateMessageTag);
    };
    const aunuIgnoreFilter = createIgnoreFilter();
    return {
        type: 'md',
        ws,
        ev,
        authState: { creds, keys },
        // AunuBaileys: the LID identity store is created HERE, in the base
        // layer, so the same instance propagates through every layer's
        // { ...sock } spread to the final socket — inner layers (receipt
        // handling, presence, polls) read the store the public
        // sock.aunuLid learns into, not a private copy.
        aunuLid: makeLIDStore(),
        // AunuBaileys: the ignoreKey registry, created here for the same
        // reason as aunuLid — one instance for every layer.
        aunuIgnoreFilter,
        ignoreKey: aunuIgnoreFilter.add,
        clearIgnoredKeys: aunuIgnoreFilter.clear,
        signalRepository,
        get user() {
            return authState.creds.me;
        },
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout,
        end,
        registerSocketEndHandler,
        fetchAccountReachoutTimelock,
        fetchNewChatMessageCap,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        /** Waits for the connection to WA to reach a state */
        waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
        sendWAMBuffer
    };
};
/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler) {
    return (error) => {
        handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }));
    };
}
//# sourceMappingURL=socket.js.map