import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { URL } from 'url'
import { promisify } from 'util'
import { waproto } from '../../WAProto/index.js'
import {
	DEF_CALLBACK_PREFIX,
	DEF_TAG_PREFIX,
	INITIAL_PREKEY_COUNT,
	MIN_PREKEY_COUNT,
	NOISE_WA_HEADER,
	PROCESSABLE_HISTORY_TYPES,
	TimeMs,
	UPLOAD_TIMEOUT
} from '../Defaults'
import {
	type LIDMapping,
	type NewChatMessageCapInfo,
	QueryIds,
	ReachoutTimelockEnforcementType,
	type ReachoutTimelockState,
	type SocketConfig,
	type WAVersion
} from '../Types'
import { DisconnectReason, XWAPaths } from '../Types'
import {
	addTransactionCapability,
	aesEncryptCTR,
	bindWaitForConnectionUpdate,
	buildPairingQRData,
	bytesToCrockford,
	configureSuccessfulPairing,
	Curve,
	derivePairingCodeKey,
	fetchLatestWaWebVersion,
	generateLoginNode,
	generateMdTagPrefix,
	generateRegistrationNode,
	getCodeFromWSError,
	getCompanionPlatformId,
	getErrorCodeFromStreamError,
	getNextPreKeysNode,
	keyMaterialToBuffer,
	makeEventBuffer,
	makeNoiseHandler,
	promiseTimeout,
	resolveBanSentinelOption,
	signedKeyPair,
	xmppSignedPreKey
} from '../Utils'
import {
	assertNodeErrorFree,
	type BinaryNode,
	binaryNodeToString,
	encodeBinaryNode,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isLidUser,
	jidDecode,
	jidEncode,
	S_WHATSAPP_NET
} from '../WABinary'
import { BinaryInfo } from '../WAM/BinaryInfo.js'
import { createIgnoreFilter } from '../Utils/ignore-filter'
import { makeLIDStore } from '../Utils/lid-store'
import { USyncQuery, USyncUser } from '../WAUSync/'
import { WebSocketClient } from './Client'
import { executeWMexQuery } from './mex.js'

/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */

/**
 * AunuBaileys (P2f, donor v6 1.0.71): resolve the version a socket
 * connects with — a version the server already rejected as too old
 * (405) is replaced by the fetched latest one
 * (`latestVersionOverride`). v7's `config.version` is a static tuple
 * only (no resolver form), so resolution is just override-or-config.
 */
export const resolveSocketVersion = (config: SocketConfig, latestOverride?: WAVersion): WAVersion =>
	latestOverride ?? config.version

/**
 * Version fetched after the server rejected the configured one with
 * 405 (clientTooOld). Process-wide on purpose (v6 parity): a
 * per-socket override cannot work in this structure — the rejected
 * socket is ended and discarded, its `validateConnection` never runs
 * again, and the host's reconnect builds a NEW socket, so only
 * module-level state survives into the connection that must heal.
 * Caveat: the override is shared by every socket created afterwards
 * in the same process and wins over their static `config.version`,
 * even a deliberately different one; a later 405 refreshes it.
 */
let latestVersionOverride: WAVersion | undefined

/**
 * Upper bound for the latest-version fetch after a 405. The fetch
 * must never wedge the socket: when it loses this race (or fails),
 * the socket still ends with the original 405 (see
 * `handleClientTooOld`).
 */
const CLIENT_TOO_OLD_FETCH_TIMEOUT_MS = 10_000

export const makeSocket = (config: SocketConfig) => {
	const {
		waWebSocketUrl,
		connectTimeoutMs,
		logger,
		keepAliveIntervalMs,
		browser,
		auth: authState,
		printQRInTerminal,
		defaultQueryTimeoutMs,
		transactionOpts,
		qrTimeout,
		makeSignalRepository
	} = config

	const publicWAMBuffer = new BinaryInfo()

	let serverTimeOffsetMs = 0

	const uqTagId = generateMdTagPrefix()
	const generateMessageTag = () => `${uqTagId}${epoch++}`

	if (printQRInTerminal) {
		logger.warn(
			{},
			'⚠️ The printQRInTerminal option has been deprecated. You will no longer receive QR codes in the terminal automatically. Please listen to the connection.update event yourself and handle the QR your way. You can remove this message by removing this opttion. This message will be removed in a future version.'
		)
	}

	if ((browser?.[1] ?? 'Chrome').toLocaleLowerCase().includes('android')) {
		logger.warn(
			'⚠️ Using the Android browser is experimental and may lead to unexpected behavior. Use at your own risk.'
		)
	}

	// AunuBaileys (2.7.0, HB-485 addendum facet 1): the host
	// callback runs synchronously here, at construction — a throw
	// used to break makeWASocket before any socket existed. Treat
	// a throw as false for that sync type, like the other
	// shouldSyncHistoryMessage gates (HB-485/HB-486).
	const syncDisabled =
		PROCESSABLE_HISTORY_TYPES.map(syncType => {
			try {
				return config.shouldSyncHistoryMessage({ syncType })
			} catch {
				return false
			}
		}).filter(x => x === false).length === PROCESSABLE_HISTORY_TYPES.length
	if (syncDisabled) {
		logger.warn(
			'⚠️ DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILIY AND SESSION ERRORS'
		)
	}

	const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl

	if (config.mobile || url.protocol === 'tcp:') {
		throw new Boom('Mobile API is not supported anymore', { statusCode: DisconnectReason.loggedOut })
	}

	if (url.protocol === 'wss' && authState?.creds?.routingInfo) {
		url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'))
	}

	/** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
	const ephemeralKeyPair = Curve.generateKeyPair()
	/** WA noise protocol wrapper */
	const noise = makeNoiseHandler({
		keyPair: ephemeralKeyPair,
		NOISE_HEADER: NOISE_WA_HEADER,
		logger,
		routingInfo: authState?.creds?.routingInfo
	})

	// AunuBaileys (P5, 2.0.0): BanSentinel — resolved from config
	// (default ON; `banSentinel: false` resolves to undefined and this
	// whole block is inert, with no guard file read or written). The
	// gate runs HERE, before the WebSocket is even created: while a
	// persisted cooldown is active, makeSocket throws Boom 503 and no
	// connection attempt (initial connect or host reconnect, both of
	// which construct a socket) reaches the network — pairing flows
	// are unaffected whenever no guard is active, because
	// assertCanConnect() passes silently then.
	const banSentinel = resolveBanSentinelOption(config.banSentinel, logger)
	banSentinel?.assertCanConnect()

	const ws = new WebSocketClient(url, config)

	ws.connect()

	const sendPromise = promisify(ws.send)
	/** send a raw buffer */
	const sendRawMessage = async (data: Uint8Array | Buffer) => {
		if (!ws.isOpen) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		const bytes = noise.encodeFrame(data)
		// AunuBaileys (HB-280, P4): the send() fix in the client
		// covers a socket that is ALREADY null, but a send whose
		// socket is closed mid-flight can still stall — the wire
		// callback is never invoked while end() is waiting on the
		// close handshake. Register this send in the same fail-fast
		// set as the waiters (HB-276): end() rejects it at once
		// with 428 'Connection Closed' instead of letting it linger
		// until connectTimeoutMs with a misleading 408.
		let onSocketEnd: ((err: Error) => void) | undefined
		try {
			await promiseTimeout<void>(connectTimeoutMs, async (resolve, reject) => {
				onSocketEnd = (err: Error) => reject(err)
				pendingSocketWaiters.add(onSocketEnd)
				try {
					await sendPromise.call(ws, bytes)
					resolve()
				} catch (error) {
					reject(error)
				}
			})
		} finally {
			if (onSocketEnd) {
				pendingSocketWaiters.delete(onSocketEnd)
			}
		}
	}

	/** send a binary node */
	const sendNode = async (frame: BinaryNode) => {
		if (logger.level === 'trace') {
			logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' })
		}

		// AunuBaileys (2.6.0, HB-213 addendum): refuse IQ stanzas
		// while the Noise handshake is in flight — before
		// finishInit() the Noise transport is not set up yet, so
		// encodeFrame would pass the node out as PLAINTEXT (a host
		// query() in the ws-open → finishInit window proved this:
		// the ping IQ decoded as a plain binary node, run-0738).
		// FAIL-FAST with Boom 408, not await and not 428:
		// - Await (ledger candidate) was tried: on a socket whose
		// handshake never completes, every held 'iq' stalls for
		// its full query timeout, and the cumulative stall pushed
		// HB-476 Phase 3 past its 10 s waitFor (gate-on failed
		// 5/5 runs, gate-off passed 2/2) — the decrypt path's
		// USync lookups never complete there, only stall.
		// - Fail-fast 428 was tried: it broke HB-340, whose
		// contract requires a set IQ that cannot complete to
		// reject 408. Code 408 is used because, observably, a
		// gated query ends exactly like a timed-out one: the
		// stanza was never sent and no response will come; the
		// host retries after the connection opens. The stanza is
		// never sent, so no plaintext ever leaves.
		// SCOPE IS IQ ONLY, deliberately: the inbound pipeline
		// awaits receipt/ack sends before the upsert
		// (messages-recv.ts sendReceipt / sendMessageAck via
		// sendNode), so a gate on ALL tags aborts message
		// processing on any socket whose handshake never completes
		// — the all-tags variants (await AND fail-fast) both broke
		// the same 6 test/35 tests. The check runs ONLY while a
		// handshake is in flight (handshakeStarted, set at the top
		// of validateConnection, until handshakeDone): a socket
		// that never started one — offline/test sockets with a
		// stubbed transport — keeps the old immediate-send
		// behaviour. RESIDUAL (documented, coordinator decision):
		// a direct sendNode() with a non-IQ tag in the window
		// still goes out plaintext; closing that needs the inbound
		// pipeline's receipt/ack sends hardened (messages-recv.ts)
		// or the test/35 harness changed — both outside Group C
		// scope. And the check lives HERE, not in sendRawMessage:
		// the handshake's own clientHello (via awaitNextMessage)
		// and clientFinish (in validateConnection) flow through
		// sendRawMessage BEFORE finishInit and must not be refused.
		if (!ws.isOpen) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		if (handshakeStarted && !handshakeDone && frame.tag === 'iq') {
			throw new Boom('Handshake not complete', { statusCode: DisconnectReason.timedOut })
		}

		const buff = encodeBinaryNode(frame)
		return sendRawMessage(buff)
	}

	/**
	 * Wait for a message with a certain tag to be received
	 * @param msgId the message tag to await
	 * @param timeoutMs timeout after which the promise will reject
	 */
	const waitForMessage = async <T>(msgId: string, timeoutMs = defaultQueryTimeoutMs) => {
		let onRecv: ((data: T) => void) | undefined
		let onErr: ((err: Error) => void) | undefined
		try {
			const result = await promiseTimeout<T>(timeoutMs, (resolve, reject) => {
				onRecv = data => {
					resolve(data)
				}

				onErr = err => {
					reject(
						err ||
							new Boom('Connection Closed', {
								statusCode: DisconnectReason.connectionClosed
							})
					)
				}

				ws.on(`TAG:${msgId}`, onRecv)
				ws.on('close', onErr)
				ws.on('error', onErr)
				// HB-276: end() fail-fasts this waiter directly — its
				// ws 'close' listener is stripped by end() before the
				// close event fires.
				pendingSocketWaiters.add(onErr)

				return () => reject(new Boom('Query Cancelled'))
			})
			return result
		} catch (error) {
			// Catch timeout and return undefined instead of throwing
			if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
				logger?.warn?.({ msgId }, 'timed out waiting for message')
				return undefined
			}

			throw error
		} finally {
			if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
			if (onErr) {
				ws.off('close', onErr)
				ws.off('error', onErr)
				pendingSocketWaiters.delete(onErr)
			}
		}
	}

	/** send a query, and wait for its response. auto-generates message ID if not provided */
	const query = async (node: BinaryNode, timeoutMs?: number) => {
		// AunuBaileys (2.3.0, HB-383 + addendum): a host-built node
		// without `attrs` (or with null attrs) died here as a bare
		// TypeError before anything was sent — encodeBinaryNode
		// already tolerates a missing attrs (`attrs || {}`), so
		// default it the same way. A non-object attrs (string,
		// number, array) can never become a valid attribute map —
		// assigning `.id` onto it throws a strict-mode TypeError —
		// so reject it descriptively as a Boom 400 instead.
		if (!node || typeof node !== 'object') {
			throw new Boom('query: node must be a binary node object', { statusCode: 400 })
		}

		if (node.attrs === null || typeof node.attrs === 'undefined') {
			node.attrs = {}
		} else if (typeof node.attrs !== 'object' || Array.isArray(node.attrs)) {
			throw new Boom('query: node.attrs must be an object', { statusCode: 400 })
		}

		if (!node.attrs.id) {
			node.attrs.id = generateMessageTag()
		}

		const msgId = node.attrs.id

		const result = await promiseTimeout<any>(timeoutMs, async (resolve, reject) => {
			const result = waitForMessage(msgId, timeoutMs).catch(reject)
			// AunuBaileys (1.0.88, HB-123, re-applied P3b): sendNode
			// encodes SYNCHRONOUSLY — when encodeBinaryNode throws (a
			// malformed node from any caller), the throw escaped this
			// async executor as an unhandled rejection and the query
			// only settled when its own timeout fired, reporting
			// 'Timed Out' instead of the real encode error. Reject
			// with the real error; the wait promise already carries a
			// handler (.catch(reject) above), so nothing is left
			// unhandled and its listeners clean up in its finally.
			try {
				await sendNode(node)
				resolve(await result)
			} catch (err) {
				reject(err)
			}
		})

		// AunuBaileys (2.2.0, HB-340): waitForMessage converts a
		// timeout into `undefined`, and callers of a `type: 'set'` IQ
		// almost universally treat the awaited result as proof the
		// write landed — settings writes resolved as saved, and the
		// pairing companion_hello timeout let the optimistic fake
		// `me` be persisted (the HB-340 pairing addendum), sending
		// the next boot into a 401 loop. A set that timed out FAILED:
		// throw the timeout so the caller's error path runs. `get`
		// IQs keep the undefined contract — their callers were
		// audited and guard for it (HB-336 era).
		if (result === undefined && node.attrs.type === 'set') {
			throw new Boom(`Timed out waiting for the response to set IQ ${msgId}`, {
				statusCode: DisconnectReason.timedOut
			})
		}

		if (result && 'tag' in result) {
			assertNodeErrorFree(result)
		}

		return result
	}

	// Validate current key-bundle on server; on failure, trigger pre-key upload and rethrow
	const digestKeyBundle = async (): Promise<void> => {
		const res = await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
			content: [{ tag: 'digest', attrs: {} }]
		})
		// AunuBaileys (2.2.0, HB-340 addendum, digest facet): a
		// timeout resolves undefined and used to fall into the
		// no-digest branch below — a spurious uploadPreKeys() plus
		// a misleading 'no digest node' error for what was really
		// a transient timeout.
		if (!res) {
			throw new Boom('Timed out waiting for the key-bundle digest', { statusCode: DisconnectReason.timedOut })
		}

		const digestNode = getBinaryNodeChild(res, 'digest')
		if (!digestNode) {
			await uploadPreKeys()
			// AunuBaileys (2.5.0, HB-455): a Boom, not a plain Error —
			// the digest reply came back without its <digest> child,
			// i.e. the server answered the wrong shape (502-class
			// upstream failure); callers branch on statusCode, and a
			// plain Error hid that.
			throw new Boom('encrypt/get digest returned no digest node', { statusCode: 502 })
		}
	}

	// Rotate our signed pre-key on server; on failure, run digest as fallback and rethrow
	const rotateSignedPreKey = async (): Promise<void> => {
		// AunuBaileys (2.8.0, HB-494): guard partial creds from a
		// custom auth state descriptively (HB-80/HB-102 style)
		// instead of a raw TypeError on keyId / private.
		if (
			!creds.signedPreKey ||
			typeof creds.signedPreKey.keyId !== 'number' ||
			!Number.isFinite(creds.signedPreKey.keyId) ||
			!creds.signedIdentityKey?.private ||
			!creds.signedIdentityKey?.public
		) {
			throw new Boom(
				'AunuBaileys: creds.signedPreKey / creds.signedIdentityKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again',
				{ statusCode: 500 }
			)
		}

		const newId = (creds.signedPreKey.keyId || 0) + 1
		const skey = await signedKeyPair(creds.signedIdentityKey, newId)
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
			content: [
				{
					tag: 'rotate',
					attrs: {},
					content: [xmppSignedPreKey(skey)]
				}
			]
		})
		// Persist new signed pre-key in creds
		// AunuBaileys (HB-259, re-applied P3): every bare
		// 'creds.update' emit is guarded \u2014 the event is not
		// bufferable, so a throwing host listener (e.g. saveCreds)
		// used to reject the surrounding stanza handler and lose
		// the work that followed the emit. Log and continue.
		try {
			ev.emit('creds.update', { signedPreKey: skey })
		} catch (err) {
			logger.error({ err }, 'error in creds.update listener \u2014 continuing')
		}
	}

	const executeUSyncQuery = async (usyncQuery: USyncQuery) => {
		if (usyncQuery.protocols.length === 0) {
			throw new Boom('USyncQuery must have at least one protocol')
		}

		// todo: validate users, throw WARNING on no valid users
		// variable below has only validated users
		const validUsers = usyncQuery.users

		const userNodes = validUsers.map(user => {
			return {
				tag: 'user',
				attrs: {
					jid: !user.phone ? user.id : undefined
				},
				content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
			} as BinaryNode
		})

		const listNode: BinaryNode = {
			tag: 'list',
			attrs: {},
			content: userNodes
		}

		const queryNode: BinaryNode = {
			tag: 'query',
			attrs: {},
			content: usyncQuery.protocols.map(a => a.getQueryElement())
		}
		const iq = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync'
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						context: usyncQuery.context,
						mode: usyncQuery.mode,
						sid: generateMessageTag(),
						last: 'true',
						index: '0'
					},
					content: [queryNode, listNode]
				}
			]
		}

		const result = await query(iq)

		return usyncQuery.parseUSyncQueryResult(result)
	}

	const onWhatsApp = async (...phoneNumber: string[]) => {
		let usyncQuery = new USyncQuery()

		let contactEnabled = false
		for (const jid of phoneNumber) {
			// AunuBaileys (2.8.0, HB-505 facet 4): a non-string entry is
			// not a LID (the predicate now answers false), so it would
			// fall into the else branch and die on jid.replace — skip it.
			if (typeof jid !== 'string') {
				continue
			}

			if (isLidUser(jid)) {
				logger?.warn('LIDs are not supported with onWhatsApp')
				continue
			} else {
				if (!contactEnabled) {
					contactEnabled = true
					usyncQuery = usyncQuery.withContactProtocol()
				}

				const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
				usyncQuery.withUser(new USyncUser().withPhone(phone))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact as boolean }))
		}

		// AunuBaileys (2.5.0, HB-435 facet onWhatsApp): a timed-out
		// query resolves undefined — callers got undefined instead
		// of an empty list. Parity with pnFromLIDUSync below.
		return []
	}

	const pnFromLIDUSync = async (jids: string[]): Promise<LIDMapping[] | undefined> => {
		const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background')

		for (const jid of jids) {
			if (isLidUser(jid)) {
				logger?.warn('LID user found in LID fetch call')
				continue
			} else {
				usyncQuery.withUser(new USyncUser().withId(jid))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.lid).map(({ lid, id }) => ({ pn: id, lid: lid as string }))
		}

		return []
	}

	const ev = makeEventBuffer(logger)

	const { creds } = authState
	// add transaction capability
	const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
	const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)

	let lastDateRecv: Date
	let epoch = 1
	let keepAliveReq: NodeJS.Timeout
	let qrTimer: NodeJS.Timeout
	let closed = false
	// AunuBaileys (2.8.0, HB-191 addendum faset 2): the `me` that
	// existed BEFORE requestPairingCode's optimistic overwrite,
	// snapshotted per-socket at pairing start. end()'s pending-
	// pairing rollback restores it instead of deleting `me`
	// outright — on a server drop the requestPairingCode catch
	// runs only after end() has destroyed the event buffer, so
	// its restore emit never reaches the host's saveCreds and the
	// disk kept the deletion while memory kept the identity.
	let pairingPrevMe: typeof authState.creds.me
	let pairingPrevMeSet = false
	// AunuBaileys (1.0.77, HB-213, re-applied P3): resolved when the
	// Noise handshake completes (finishInit in validateConnection),
	// so requestPairingCode can wait for an encrypted channel.
	let resolveHandshakeComplete: () => void = () => {}
	const handshakeComplete = new Promise<void>(resolve => {
		resolveHandshakeComplete = resolve
	})
	// AunuBaileys (2.6.0, HB-213 addendum): set synchronously when
	// validateConnection starts, so sendNode can tell a handshake
	// that is IN FLIGHT (refuse the stanza) from a socket that never
	// started one — an offline/test socket with a stubbed transport
	// never fires 'open', so gating it would break the offline
	// stanza tests. Paired with handshakeDone below.
	let handshakeStarted = false
	// AunuBaileys (2.6.0, HB-213 addendum): set next to
	// resolveHandshakeComplete() once finishInit() has run.
	let handshakeDone = false

	const socketEndHandlers: Array<(error: Error | undefined) => void | Promise<void>> = []

	// AunuBaileys (HB-276, P4): reject callbacks of every pending
	// socket waiter (waitForMessage / awaitNextMessage /
	// waitForSocketOpen). They used to be reachable ONLY through the
	// ws 'close'/'error' events — but end() removes ALL ws listeners
	// before ws.close() runs, so when the socket ended from a
	// non-close path (watchdog, CB:failure, logout, manual end) the
	// 'close' event fired into an empty listener set and each waiter
	// lingered until its own timeout, rejecting with a misleading
	// 408 'Timed Out' instead of 428 'Connection Closed'. end()
	// fail-fasts everything registered here, before the listeners
	// are stripped.
	const pendingSocketWaiters = new Set<(err: Error) => void>()

	/** log & process any unexpected errors */
	const onUnexpectedError = (err: Error | Boom, msg: string) => {
		logger.error({ err }, `unexpected error in '${msg}'`)
	}

	/** await the next incoming message */
	const awaitNextMessage = async <T>(sendMsg?: Uint8Array) => {
		if (!ws.isOpen) {
			throw new Boom('Connection Closed', {
				statusCode: DisconnectReason.connectionClosed
			})
		}

		let onOpen: (data: T) => void
		let onClose: (err: Error) => void

		const result = promiseTimeout<T>(connectTimeoutMs, (resolve, reject) => {
			onOpen = resolve
			onClose = mapWebSocketError(reject)
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
			// HB-276: same end() fail-fast registration as
			// waitForMessage — without it a handshake wait outlived
			// the socket until connectTimeoutMs.
			pendingSocketWaiters.add(onClose)
		}).finally(() => {
			ws.off('frame', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
			pendingSocketWaiters.delete(onClose)
		})

		if (sendMsg) {
			sendRawMessage(sendMsg).catch(onClose!)
		}

		return result
	}

	/** connection handshake */
	const validateConnection = async () => {
		// AunuBaileys (2.6.0, HB-213 addendum): the Noise handshake
		// is now in flight — sendNode refuses IQ stanzas until it
		// completes (see the gate there).
		handshakeStarted = true
		let helloMsg: waproto.IHandshakeMessage = {
			clientHello: { ephemeral: ephemeralKeyPair.public }
		}
		helloMsg = waproto.HandshakeMessage.fromObject(helloMsg)

		logger.info({ browser, helloMsg }, 'connected to WA')

		const init = waproto.HandshakeMessage.encode(helloMsg).finish()

		const result = await awaitNextMessage<Uint8Array>(init)
		// AunuBaileys (2.7.0, HB-238 addendum 2): the first frame is
		// plaintext (pre-handshake), so any middlebox that passes
		// the WS upgrade can send garbage bytes here — the decode
		// used to throw a raw protobuf RangeError.
		let handshake: waproto.HandshakeMessage
		try {
			handshake = waproto.HandshakeMessage.decode(result)
		} catch {
			throw new Boom(
				'AunuBaileys: the server handshake is malformed — the first frame is not a valid handshake message (the connection may have been intercepted); reconnecting will retry',
				{ statusCode: 400 }
			)
		}

		logger.trace({ handshake }, 'handshake recv from WA')

		const keyEnc = noise.processHandshake(handshake, creds.noiseKey)

		// AunuBaileys (P2f, donor v6 1.0.71): resolve any 405-accepted
		// override BEFORE building the login/registration node — both
		// node builders read config.version for the user agent / build
		// hash, so they must see the resolved array.
		const resolvedVersion = resolveSocketVersion(config, latestVersionOverride)
		const connectConfig: SocketConfig = resolvedVersion === config.version ? config : { ...config, version: resolvedVersion }

		let node: waproto.IClientPayload
		if (!creds.me) {
			node = generateRegistrationNode(creds, connectConfig)
			logger.info({ node }, 'not logged in, attempting registration...')
		} else {
			node = generateLoginNode(creds.me.id, connectConfig)
			logger.info({ node }, 'logging in...')
		}

		const payloadEnc = noise.encrypt(waproto.ClientPayload.encode(node).finish())
		await sendRawMessage(
			waproto.HandshakeMessage.encode({
				clientFinish: {
					static: keyEnc,
					payload: payloadEnc
				}
			}).finish()
		)
		await noise.finishInit()
		// AunuBaileys (1.0.77, HB-213, re-applied P3): the Noise
		// handshake is complete \u2014 pairing requests may proceed.
		resolveHandshakeComplete()
		// AunuBaileys (2.6.0, HB-213 addendum): the encrypted
		// channel is up — sendNode may carry stanzas again.
		handshakeDone = true
		startKeepAliveRequest()
	}

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
		})
		// AunuBaileys (2.2.0, HB-284 facet b / HB-340 login
		// addendum): a TIMEOUT resolves undefined — the HB-284
		// sanitisation below read that as count 0 and the caller
		// uploaded a fresh 812-key initial batch on every transient
		// timeout. A timeout is not a malformed response: throw,
		// and the caller's catch skips this round (the server
		// drives re-uploads via PreKeyLow notifications).
		if (!result) {
			throw new Boom('Timed out waiting for the pre-key count response', {
				statusCode: DisconnectReason.timedOut
			})
		}

		const countChild = getBinaryNodeChild(result, 'count')
		// AunuBaileys (HB-284, donor v6 HB-47): a count-less or
		// value-less response used to surface NaN / throw here, and the
		// caller swallowed it — the pre-key upload was silently skipped.
		// Sanitise at the boundary: only a finite, non-negative count is
		// trusted; anything else reads as 0 ("unknown"), which makes the
		// caller upload a fresh initial batch.
		const rawCount = Number(countChild?.attrs?.value)
		if (!Number.isFinite(rawCount) || rawCount < 0) {
			logger.warn({ result }, 'pre-key count response is malformed; assuming 0')
			return 0
		}

		return rawCount
	}

	// WAWeb has no time throttle here; the server drives uploads via PreKeyLow notifications.
	let uploadPreKeysPromise: Promise<void> | null = null

	/** generates and uploads a set of pre-keys to the server */
	const uploadPreKeys = async (count = MIN_PREKEY_COUNT) => {
		// AunuBaileys (2.2.0, HB-140 addendum): a host-supplied count
		// flows into the synchronous key-generation loop in
		// generateOrGetPreKeys — Infinity froze the process outright
		// (the 30s race below cannot fire while the event loop is
		// blocked) and NaN persisted a poisoned nextPreKeyId via
		// creds.update. Sanitise at this boundary: a finite positive
		// integer, else the default count.
		if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
			count = MIN_PREKEY_COUNT
		} else {
			count = Math.floor(count)
		}

		if (uploadPreKeysPromise) {
			logger.debug('Pre-key upload already in progress, waiting for completion')
			await uploadPreKeysPromise
			return
		}

		const uploadLogic = async (retryCount: number): Promise<void> => {
			logger.info({ count, retryCount }, 'uploading pre-keys')

			// AunuBaileys (2.3.0, HB-386): only `nextPreKeyId` may
			// advance inside the transaction — it is the collision
			// guard for key generation. `firstUnuploadedPreKeyId`
			// is the advertisement pointer (getNextPreKeys only
			// ever offers [firstUnuploaded, +count)), and advancing
			// it before the upload was even attempted orphaned the
			// whole batch on failure: every retry generated a FRESH
			// batch and the failed one stayed on disk forever,
			// never offered again. Defer it until the server has
			// accepted the node — a retry then re-reads and
			// re-offers the SAME stored batch instead of minting a
			// new one.
			let pendingFirstUnuploadedPreKeyId: number | undefined
			// Generate and save pre-keys atomically (prevents ID collisions on retry)
			const node = await keys.transaction(async () => {
				logger.debug({ requestedCount: count }, 'generating pre-keys with requested count')
				const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
				pendingFirstUnuploadedPreKeyId = update.firstUnuploadedPreKeyId
				if (typeof update.nextPreKeyId === 'number') {
					try {
						ev.emit('creds.update', { nextPreKeyId: update.nextPreKeyId })
					} catch (err) {
						logger.error({ err }, 'error in creds.update listener \u2014 continuing')
					}
				}
				return node
			}, creds?.me?.id || 'upload-pre-keys')

			// Upload to server (outside transaction, can fail without affecting local keys)
			try {
				await query(node)
				// AunuBaileys (2.3.0, HB-386): the upload landed —
				// only now may the advertisement pointer move past
				// this batch.
				if (typeof pendingFirstUnuploadedPreKeyId === 'number') {
					try {
						ev.emit('creds.update', { firstUnuploadedPreKeyId: pendingFirstUnuploadedPreKeyId })
					} catch (err) {
						logger.error({ err }, 'error in creds.update listener \u2014 continuing')
					}
				}

				logger.info({ count }, 'uploaded pre-keys successfully')
			} catch (uploadError) {
				logger.error({ uploadError: (uploadError as Error).toString(), count }, 'Failed to upload pre-keys to server')

				// Recurse into uploadLogic; calling uploadPreKeys would await its own in-flight promise.
				// AunuBaileys (2.3.0, HB-386 addendum): end() must stop
				// the retry loop — a dead socket minting further
				// batches in the background only burns key ids and
				// writes files nobody will ever upload.
				if (retryCount < 3 && !closed) {
					const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
					logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
					await new Promise(resolve => setTimeout(resolve, backoffDelay))
					if (closed) {
						throw uploadError
					}

					return uploadLogic(retryCount + 1)
				}

				throw uploadError
			}
		}

		// AunuBaileys (2.2.0, HB-347 + HB-348): the timeout races only
		// the AWAIT, never the in-flight guard — the guard lives until
		// the upload logic itself settles, so a timed-out caller cannot
		// open the gate to a second, concurrent upload while the first
		// is still running. The timer handle is cleared the moment the
		// race settles, so a finished upload cannot hold the process
		// open for the rest of the timeout window.
		const logicPromise = uploadLogic(0)
		uploadPreKeysPromise = logicPromise

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				logicPromise,
				new Promise<void>((_, reject) => {
					timeoutHandle = setTimeout(() => reject(new Boom('Pre-key upload timeout', { statusCode: 408 })), UPLOAD_TIMEOUT)
				})
			])
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle)
			}

			const releaseGuard = () => {
				if (uploadPreKeysPromise === logicPromise) {
					uploadPreKeysPromise = null
				}
			}

			logicPromise.then(releaseGuard, releaseGuard)
		}
	}

	const verifyCurrentPreKeyExists = async () => {
		const currentPreKeyId = creds.nextPreKeyId - 1
		if (currentPreKeyId <= 0) {
			return { exists: false, currentPreKeyId: 0 }
		}

		const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
		const exists = !!preKeys[currentPreKeyId.toString()]

		return { exists, currentPreKeyId }
	}

	const uploadPreKeysToServerIfRequired = async () => {
		try {
			let count = 0
			const preKeyCount = await getAvailablePreKeysOnServer()
			if (preKeyCount === 0) count = INITIAL_PREKEY_COUNT
			else count = MIN_PREKEY_COUNT
			const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()

			logger.info(`${preKeyCount} pre-keys found on server`)
			logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)

			const lowServerCount = preKeyCount <= count
			const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0

			const shouldUpload = lowServerCount || missingCurrentPreKey

			if (shouldUpload) {
				const reasons = []
				if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
				if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing from storage`)

				logger.info(`Uploading PreKeys due to: ${reasons.join(', ')}`)
				await uploadPreKeys(count)
			} else {
				logger.info(`PreKey validation passed - Server: ${preKeyCount}, Current prekey ${currentPreKeyId} exists`)
			}
		} catch (error) {
			logger.error({ error }, 'Failed to check/upload pre-keys during initialization')
			// Don't throw - allow connection to continue even if pre-key check fails
		}
	}

	// AunuBaileys (1.0.77, HB-156, re-applied P3b): decodeFrame
	// invocations must never overlap — the noise handler slices ONE
	// shared inBytes buffer, so two concurrent calls interleave and
	// deliver stanzas out of wire order (a receipt processed before
	// the message it acks; app-state patches applied out of order).
	// Every WS message is chained through a single queue; a failed
	// frame is routed to onUnexpectedError and never poisons the
	// chain for the frames behind it.
	let frameDecodeChain: Promise<void> = Promise.resolve()
	const onMessageReceived = (data: Buffer) => {
		frameDecodeChain = frameDecodeChain
			.then(() => decodeFrameSerialised(data))
			.catch((err: Error & { isFrameFatal?: boolean }) => {
				// AunuBaileys (1.0.77, HB-185, re-applied P3b): a frame-layer
				// failure marked frame-fatal (oversize header, HB-91) leaves
				// the noise stream unrecoverable — the header is never
				// consumed, so every later decode re-reads it and the stream
				// wedges until the keep-alive watchdog fires (~65s). P3b-1
				// set the flag in the noise handler; this is its consumer:
				// end the connection so the host reconnects at once.
				if (err?.isFrameFatal) {
					void end(err)
				} else {
					onUnexpectedError(err, 'decoding frame')
				}
			})
	}

	// AunuBaileys (HB-268, P4): dispatch ONE ws event with per-listener
	// isolation, the HB-264 pattern applied to the `ws` emitter. A raw
	// ws.emit stops at the first listener that throws — every later
	// emit for the same stanza never ran, so a throwing host 'frame'
	// listener (or internal handler) silently ate the stanza: the
	// pending query behind a TAG:<id> waiter hung until its timeout
	// and a missed CB:success/CB:failure stalled login until the
	// keep-alive watchdog fired. rawListeners returns the
	// once-wrappers themselves, so once semantics are preserved, and
	// the return value keeps emit's contract (true when at least one
	// listener was registered).
	const emitWsIsolated = (event: string, frame: unknown): boolean => {
		const listeners = ws.rawListeners(event)
		if (!listeners.length) {
			return false
		}

		for (const listener of listeners) {
			try {
				const result = (listener as (arg: unknown) => unknown).call(ws, frame)
				// AunuBaileys (2.5.0, HB-268 addendum): the sync guard
				// above never caught an ASYNC listener's rejection —
				// it floated out of this dispatcher as an
				// unhandledRejection and killed the process. Same
				// .catch as the HB-264 ev forwarder in event-buffer:
				// dispatch is fire-and-forget by design.
				if (result && typeof (result as { catch?: unknown }).catch === 'function') {
					;(result as Promise<unknown>).catch(err =>
						logger.error({ err, event }, 'error in async ws listener — dispatch continues')
					)
				}
			} catch (err) {
				logger.error({ err, event }, 'error in ws listener — dispatch continues')
			}
		}

		return true
	}

	const decodeFrameSerialised = async (data: Buffer) => {
		// AunuBaileys (HB-119, re-applied P3): mark inbound on the RAW
		// frame, before decoding \u2014 a corrupt/oversize frame that
		// fails to decode still proves the peer is alive; the pre-fix
		// code only stamped inside the decode callback, so a stream
		// of bad frames looked like a dead connection to the
		// watchdog and forced spurious reconnects.
		lastDateRecv = new Date()
		await noise.decodeFrame(data, frame => {
			// reset ping timeout
			lastDateRecv = new Date()

			let anyTriggered = false

			anyTriggered = emitWsIsolated('frame', frame)
			// if it's a binary node
			if (!(frame instanceof Uint8Array)) {
				const msgId = frame.attrs.id

				if (logger.level === 'trace') {
					logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' })
				}

				/* Check if this is a response to a message we sent */
				anyTriggered = emitWsIsolated(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
				/* Check if this is a response to a message we are expecting */
				const l0 = frame.tag
				const l1 = frame.attrs || {}
				const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''

				for (const key of Object.keys(l1)) {
					anyTriggered = emitWsIsolated(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
					anyTriggered = emitWsIsolated(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
					anyTriggered = emitWsIsolated(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
				}

				anyTriggered = emitWsIsolated(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
				anyTriggered = emitWsIsolated(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered

				if (!anyTriggered && logger.level === 'debug') {
					logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
				}
			}
		})
	}

	const end = async (error: Error | undefined) => {
		if (closed) {
			logger.trace({ trace: error?.stack }, 'connection already closed')
			return
		}

		closed = true
		logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')

		// AunuBaileys (P5): BanSentinel observer — end() is the single
		// choke point every disconnect funnels through (stream:error,
		// failure, ws close/error, unexpected-response, keep-alive
		// loss, logout), carrying exactly the lastDisconnect error the
		// host will see in connection.update. Feed its status code +
		// message: 401/403/440 or a ban keyword trips the guard at
		// once, anything else counts toward the burst window. A clean
		// end (no error) is not a failure and is not fed. The sentinel
		// never throws from its observer API; this try/catch is the
		// guardrail belt-and-braces so the observer can never break
		// the teardown it watches.
		if (banSentinel && error) {
			try {
				const code = (error as Boom).output?.statusCode ?? (error as { statusCode?: number }).statusCode
				banSentinel.noteDisconnect(typeof code === 'number' && Number.isFinite(code) ? code : undefined, error.message)
			} catch (err) {
				logger.error({ err }, 'error in ban sentinel disconnect observer — continuing')
			}
		}

		clearInterval(keepAliveReq)
		clearTimeout(qrTimer)

		// AunuBaileys (2.5.0, HB-262 addendum): a pairing code was
		// requested but the socket closed before the code was ever
		// entered — the optimistic `me` + `pairingCode` from
		// requestPairingCode are still in creds, and the host's
		// saveCreds already persisted them. The next boot then takes
		// the login path on an unregistered identity and loops on
		// 401. Roll the pending pairing back here (mirror the HB-191
		// rollback and lordeagle 3.0.0): delete the optimistic me and
		// the code, and emit creds.update so the host persists the
		// clean state. Only when the pairing never completed: a
		// `creds.account` means pair-success already ran and the
		// identity is real (companion_finish just has not run yet),
		// and a registered session is never touched. `pairingJid`
		// does not exist in this tree — `pairingCode` alone is the
		// pending-pairing signal.
		if (!authState.creds.registered && authState.creds.pairingCode && !authState.creds.account) {
			// AunuBaileys (2.8.0, HB-191 addendum faset 2): restore
			// the pre-pairing `me` snapshotted by requestPairingCode
			// instead of deleting it — mirroring the 2.6.0 catch
			// rollback. That catch cannot be relied on here: on a
			// server drop it settles after ev.destroy() below, so
			// its creds.update emit is lost and the host persists
			// this delete while memory later regains the identity.
			// Delete only when there was no `me` to restore.
			if (pairingPrevMeSet && pairingPrevMe) {
				authState.creds.me = pairingPrevMe
			} else {
				delete authState.creds.me
			}

			pairingPrevMe = undefined
			pairingPrevMeSet = false
			delete authState.creds.pairingCode
			try {
				ev.emit('creds.update', authState.creds)
			} catch (err) {
				logger.error({ err }, 'error in creds.update listener — continuing')
			}
		}

		// AunuBaileys (HB-276, P4): fail-fast every pending waiter
		// BEFORE the ws listeners are stripped below — after the
		// strip, the real 'close' event reaches nobody and the
		// waiters would linger until their own timeouts with a
		// misleading 408. Rejecting a promise never throws, but stay
		// defensive: one bad waiter must not abort end().
		if (pendingSocketWaiters.size) {
			const closedError = new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
			for (const waiter of [...pendingSocketWaiters]) {
				try {
					waiter(closedError)
				} catch (err) {
					logger.error({ err }, 'error in pending socket waiter during end')
				}
			}

			pendingSocketWaiters.clear()
		}

		ws.removeAllListeners('close')
		ws.removeAllListeners('open')
		ws.removeAllListeners('message')

		// AunuBaileys (2.3.0, HB-376): `makeSignalRepository` is a
		// public config option — a host repository whose close()
		// throws (or returns a rejecting promise) is ordinary host
		// code, and this was the ONLY unguarded step in end(): a
		// sync throw aborted the teardown before the transport
		// closed and before the close update was emitted (and every
		// end() call site is `void end(...)`, so it surfaced as an
		// unhandled rejection), while an async rejection floated
		// unhandled. Log and continue, like every other step here.
		try {
			void Promise.resolve(signalRepository.close?.()).catch((err: unknown) => {
				logger.error({ err }, 'error in signal repository close \u2014 continuing')
			})
		} catch (err) {
			logger.error({ err }, 'error in signal repository close \u2014 continuing')
		}

		// AunuBaileys (2.3.0, HB-401): end() is this socket's
		// lifecycle end — release its transaction AsyncLocalStorage
		// (see disposeTransactionStorage in auth-utils). The wrapper
		// is per-socket, so this cannot affect a reconnect's fresh
		// wrapper; guarded like the close above so a failure here
		// can never abort the teardown either.
		try {
			keys.disposeTransactionStorage?.()
		} catch (err) {
			logger.error({ err }, 'error disposing transaction storage \u2014 continuing')
		}

		// AunuBaileys (2.6.0, HB-346 addendum 1): stop the signal
		// key-store cache's purge timer, if the host's store is a
		// cacheable wrapper (forwarded through the transaction
		// wrapper above). A plain store has no close; the call is a
		// no-op for it. Closing only stops the timer — entries are
		// kept and get() still enforces expiry on read — so a host
		// reusing the same auth state for a reconnect stays correct,
		// just without autopurge on that wrapper afterwards.
		try {
			keys.close?.()
		} catch (err) {
			logger.error({ err }, 'error closing signal key store \u2014 continuing')
		}

		if (!ws.isClosed && !ws.isClosing) {
			try {
				await ws.close()
			} catch {}
		}

		for (const handler of socketEndHandlers) {
			// AunuBaileys (2.8.0, HB-496): race each handler with a
			// bounded timeout (same 5s cap as ws.close above) — a
			// host handler that never settles must not hang the
			// teardown or block the close emit / ev.destroy below.
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				await Promise.race([
					Promise.resolve()
						.then(() => handler(error))
						.catch(err => {
							logger.error({ err }, 'error in socket end handler')
						}),
					new Promise<void>(resolve => {
						timer = setTimeout(() => {
							logger.warn({}, 'socket end handler timed out — continuing teardown')
							resolve()
						}, 5_000)
					})
				])
			} catch (err) {
				logger.error({ err }, 'error in socket end handler')
			} finally {
				if (timer) {
					clearTimeout(timer)
				}
			}
		}

		ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: {
				error,
				date: new Date()
			}
		})
		ev.removeAllListeners('connection.update')
		ev.destroy()
	}

	const waitForSocketOpen = async () => {
		if (ws.isOpen) {
			return
		}

		if (ws.isClosed || ws.isClosing) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		let onOpen: () => void
		let onClose: (err: Error) => void
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = mapWebSocketError(reject)
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
			// HB-276: this waiter has NO timeout of its own — without
			// the end() fail-fast it could hang past the socket's end
			// forever once end() stripped its ws listeners.
			pendingSocketWaiters.add(onClose)
		}).finally(() => {
			ws.off('open', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
			pendingSocketWaiters.delete(onClose)
		})
	}

	const startKeepAliveRequest = () =>
		(keepAliveReq = setInterval(() => {
			if (!lastDateRecv) {
				lastDateRecv = new Date()
			}

			const diff = Date.now() - lastDateRecv.getTime()
			/*
				check if it's been a suspicious amount of time since the server responded with our last seen
				it could be that the network is down
			*/
			if (diff > keepAliveIntervalMs + 5000) {
				void end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
			} else if (ws.isOpen) {
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
					logger.error({ trace: err.stack }, 'error in sending keep alive')
				})
			} else {
				logger.warn('keep alive called when WS not open')
			}
		}, keepAliveIntervalMs))
	/** i have no idea why this exists. pls enlighten me */
	const sendPassiveIq = (tag: 'passive' | 'active') =>
		query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'passive',
				type: 'set'
			},
			content: [{ tag, attrs: {} }]
		})

	/** logout & invalidate connection */
	const logout = async (msg?: string) => {
		// AunuBaileys (2.1.0, HB-300, donor v6): end() must run even when the remove-companion-device IQ throws — otherwise the socket stays open and the session stays valid.
		try {
			const jid = authState.creds.me?.id
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
				})
			}
		} finally {
			void end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
		}
	}

	let pairingCodeRequestInFlight = false

	const requestPairingCode = async (phoneNumber: string, customPairingCode?: string): Promise<string> => {
		// AunuBaileys (2.1.0, HB-319, donor v6 1.0.89): pairing codes are only for new logins, and a second concurrent request invalidates the first code — reject both up front.
		if (authState.creds.registered) {
			throw new Boom('requestPairingCode: this session is already registered — pairing codes are only for new logins', { statusCode: 400 })
		}
		if (pairingCodeRequestInFlight) {
			throw new Boom('requestPairingCode: a pairing code request is already in flight — wait for it to finish instead of firing another one (double requests invalidate the first code)', { statusCode: 409 })
		}
		// AunuBaileys (2.2.0, HB-342): the custom-code length check is
		// cheap and dependency-free — it used to sit AFTER the 30s
		// handshake race below, so a malformed code was only rejected
		// once the handshake completed or timed out.
		// AunuBaileys (2.6.0, HB-467): the neighbouring guards
		// in this function throw Boom 400/409/428 — a plain
		// Error here was unclassifiable for callers that
		// branch on status codes.
		// AunuBaileys (2.6.0, HB-467 ordering): the check sits
		// BEFORE the closed-socket guard below — argument
		// validation must not be masked by connection state, so
		// a malformed code is Boom 400 even on an ended socket
		// (a valid code still fails fast with 428 there).
		if (customPairingCode && customPairingCode.length !== 8) {
			throw new Boom('Custom pairing code must be exactly 8 chars', { statusCode: 400 })
		}
		// AunuBaileys (2.2.0, HB-213 addendum): on an already-ended
		// socket the handshake race below can never settle — the
		// close signal was emitted before any listener existed — so
		// the call used to burn the full 30s and then fail with a
		// misleading 408. Fail instantly with 428 like every other
		// post-close operation.
		if (closed || ws.isClosed) {
			throw new Boom('Connection Closed', { statusCode: 428 })
		}
		pairingCodeRequestInFlight = true
		try {
		// AunuBaileys (1.0.77, HB-213, re-applied P3): the pairing IQ
		// must not leave before the Noise handshake completes \u2014
		// encodeFrame encrypts only once the handshake is finished,
		// so an early IQ travels as a plaintext binary node and a
		// strict server kills the connection over it while
		// requestPairingCode still resolves with the code. Wait for
		// the handshake, bounded by a timeout and by closure.
		{
			let onClose: ((update: any) => void) | undefined
			let timer: NodeJS.Timeout | undefined
			try {
				await Promise.race([
					handshakeComplete,
					new Promise<never>((_, reject) => {
						onClose = (update: any) => {
							if (update.connection === 'close') {
								reject(
									new Boom('requestPairingCode: connection closed while waiting for the handshake to complete', {
										statusCode: DisconnectReason.connectionClosed
									})
								)
							}
						}

						ev.on('connection.update', onClose)
					}),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							reject(
								new Boom('requestPairingCode: handshake did not complete within 30s', {
									statusCode: DisconnectReason.timedOut
								})
							)
						}, 30_000)
					})
				])
			} finally {
				if (timer) {
					clearTimeout(timer)
				}

				if (onClose) {
					ev.off('connection.update', onClose)
				}
			}
		}

		const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))

		// AunuBaileys (2.6.0, HB-191 addendum): snapshot the
		// pre-existing me BEFORE the optimistic overwrite below.
		// A real paired identity can exist with registered ===
		// false — the window between pair-success and
		// companion_finish, which persists across restarts since
		// pair-success writes me — and the catch below used to
		// delete it unconditionally on ANY query failure, so a
		// re-pair attempt against a rejecting server destroyed
		// the paired identity and the next boot took the
		// registration path. The snapshot is a reference: me is
		// replaced wholesale, never mutated in place.
		const prevMe = authState.creds.me
		// AunuBaileys (2.8.0, HB-191 addendum faset 2): mirror the
		// snapshot into the per-socket slot so end() can restore it
		// if the socket dies while this request is still pending
		// (the catch below may settle after the event buffer is
		// destroyed — see the slot declaration).
		pairingPrevMe = prevMe
		pairingPrevMeSet = true

		authState.creds.pairingCode = pairingCode

		authState.creds.me = {
			id: jidEncode(phoneNumber, 's.whatsapp.net'),
			name: '~'
		}
		// AunuBaileys (1.0.88, HB-262, re-applied P3b): deliberately NO
		// creds.update emit yet. The HB-191 fix rolls the optimistic me back
		// on an in-process rejection, but the built-in saver writes ATOMICALLY
		// the moment the emit fires — a process death (kill, OOM, deploy
		// restart) in the window between the emit and the IQ below persisted
		// the fake `me` to disk, and the next boot took the LOGIN path into a
		// 401 loggedOut loop that only wiping the auth state could end. The
		// emit happens after the IQ succeeds (below); the hello flow reads
		// me/pairingCode from MEMORY, never from disk.
		// AunuBaileys (1.0.77, HB-191, re-applied P3b): query(), not sendNode()
		// — the companion_hello result must be awaited and error-checked.
		// sendNode resolved when the bytes hit the wire, so a server rejection
		// left the optimistic creds.me/pairingCode persisted and sent the next
		// boot into a 401 loop; a rejection now lands in the catch below,
		// which rolls the creds back.
		try {
			await query({
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
							// AunuBaileys (HB-157, re-applied P3b): publish
							// the key BYTES, not the base64 text of a
							// string-stored key.
							content: keyMaterialToBuffer(authState.creds.noiseKey.public) as Buffer
						},
						{
							tag: 'companion_platform_id',
							attrs: {},
							content: getCompanionPlatformId(browser)
						},
						{
							tag: 'companion_platform_display',
							attrs: {},
							content: `${browser?.[1] || 'Chrome'} (${browser?.[0] || 'Chrome'})`
						},
						{
							tag: 'link_code_pairing_nonce',
							attrs: {},
							content: '0'
						}
					]
				}
			]
		})
		// AunuBaileys (1.0.88, HB-262, re-applied P3b): the server accepted the
		// pairing request — only NOW may the optimistic me / pairingCode be
		// persisted (see the note at the assignment above).
		try {
			ev.emit('creds.update', authState.creds)
		} catch (err) {
			logger.error({ err }, 'error in creds.update listener \u2014 continuing')
		}

		return authState.creds.pairingCode
		} catch (err) {
			// AunuBaileys (HB-191, re-applied P3b): the optimistic creds.me /
			// pairingCode written above must not survive a failed request — a
			// persisted fake `me` on an unregistered session sends the next boot
			// into 401 login loops. Roll back in memory and persist the rollback.
			if (!authState.creds.registered) {
				// AunuBaileys (2.6.0, HB-191 addendum): restore the
				// PRE-EXISTING paired me instead of deleting it —
				// delete me only when there was none to restore.
				// pairingCode is ALWAYS deleted: the old code may
				// already have been invalidated by the new hello,
				// so restoring it would resurrect a dead code.
				if (prevMe) {
					authState.creds.me = prevMe
				} else {
					delete authState.creds.me
				}

				delete authState.creds.pairingCode
				try {
					ev.emit('creds.update', authState.creds)
				} catch (emitErr) {
					logger.error({ err: emitErr }, 'error in creds.update listener \u2014 continuing')
				}
			}

			throw err
		}
		} finally {
			pairingCodeRequestInFlight = false
		}
	}

	async function generatePairingKey() {
		// AunuBaileys (2.8.0, HB-494 addendum): guard a missing
		// pairing ephemeral pair descriptively instead of a raw
		// TypeError, and (facet 2) normalise string key material
		// with keyMaterialToBuffer like neighbouring sites — a
		// base64 string encrypted as UTF-8 text is 44 bytes, not
		// the 32-byte public key, and pairing fails deterministically.
		if (!authState.creds.pairingEphemeralKeyPair?.public) {
			throw new Boom(
				'AunuBaileys: creds.pairingEphemeralKeyPair is missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again',
				{ statusCode: 500 }
			)
		}

		const salt = randomBytes(32)
		const randomIv = randomBytes(16)
		const key = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const ciphered = aesEncryptCTR(keyMaterialToBuffer(authState.creds.pairingEphemeralKeyPair.public) as Buffer, key, randomIv)
		return Buffer.concat([salt, randomIv, ciphered])
	}

	const sendWAMBuffer = (wamBuffer: Buffer) => {
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
					attrs: { t: Math.round(Date.now() / 1000) + '' },
					content: wamBuffer
				}
			]
		})
	}

	ws.on('message', onMessageReceived)

	ws.on('open', async () => {
		try {
			await validateConnection()
		} catch (err: any) {
			logger.error({ err }, 'error in validating connection')
			void end(err)
		}
	})
ws.on('error', mapWebSocketError(end))
	// AunuBaileys (1.0.77, HB-189, re-applied P3b): the ws client forwards
	// 'unexpected-response', which suppresses ws's own handshake abort —
	// without a listener here a non-101 response (403/502, ISP intercept
	// page) wedges the socket in 'connecting' forever: no open, no error,
	// no close, and the host never reconnects.
	ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
		const code = res?.statusCode
		const statusCode = typeof code === 'number' && Number.isFinite(code) && code >= 400 && code <= 599 ? code : 500
		void end(new Boom(`Unexpected server response: ${code}`, { statusCode }))
	})
	ws.on('close', () => void end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })))
	// the server terminated the connection
	ws.on(
		'CB:xmlstreamend',
		() => void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed }))
	)
	// QR gen
	// AunuBaileys (1.0.77, HB-243, re-applied P3b): true while a pair-device
	// QR chain is cycling — a duplicate pair-device IQ must not start a
	// second chain on the shared qrTimer slot.
	let qrChainActive = false
	// AunuBaileys (2.5.0, HB-2026-1114-243 addendum): the running
	// chain's ref queue lives here, not inside the handler — a
	// duplicate pair-device IQ appends its refs to this queue (see
	// below) instead of having them dropped by the HB-243 guard, so
	// a server retry cannot exhaust the chain mid-pairing.
	let qrRefNodes: BinaryNode[] = []
	ws.on('CB:iq,type:set,pair-device', async (stanza: BinaryNode) => {
		// AunuBaileys (adjunct HB-243, P4): an async stanza handler's
		// rejection is nobody's catch — v6 wrapped this handler in
		// try/catch (log + end), the v7 port dropped the wrapper, so
		// a failed pairing IQ (sendNode throw, bad key material in
		// the QR build) became an unhandled rejection that could
		// take the process down mid-pairing. Mirror pair-success
		// below: guard the whole body, log, and end the socket.
		try {
			const iq: BinaryNode = {
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'result',
					id: stanza.attrs.id!
				}
			}
			await sendNode(iq)

		const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device')
		const newRefNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
		// AunuBaileys (1.0.77, HB-243, re-applied P3b): a duplicate pair-device
		// IQ (server retry) must not start a parallel QR chain — both chains
		// share the single qrTimer slot, so the orphaned first chain keeps
		// cycling after login and its ref exhaustion ends the healthy,
		// freshly logged-in connection.
		// AunuBaileys (2.5.0, HB-2026-1114-243 addendum): the old guard
		// returned early and DISCARDED the retry's fresh refs, so the
		// running chain still exhausted and killed the socket. Append
		// the new refs to the running queue instead (deduped by
		// content); the single chain keeps cycling on them.
		if (qrChainActive) {
			const known = new Set(qrRefNodes.map(r => (r.content as Buffer | undefined)?.toString('utf-8')))
			for (const refNode of newRefNodes) {
				const key = (refNode.content as Buffer | undefined)?.toString('utf-8')
				if (!known.has(key)) {
					known.add(key)
					qrRefNodes.push(refNode)
				}
			}
			logger.info(`appended ${newRefNodes.length} refs from a duplicate pair-device IQ to the running QR chain`)
			return
		}

		qrChainActive = true
		qrRefNodes = [...newRefNodes]
		// AunuBaileys (2.6.0, HB-2026-1112-80 addendum, faset QR):
		// fail descriptively here instead of emitting a dead QR —
		// buildPairingQRData joins the five segments with ',', so a
		// missing advSecretKey becomes an EMPTY segment and the QR
		// can never scan, yet it was emitted with no diagnostic
		// until the refs ran out and the socket ended on a
		// misleading 408. Same family as configureSuccessfulPairing
		// (HB-80), which throws descriptively on the same partial
		// creds. The handler's catch below ends the socket with
		// this error.
		if (
			typeof creds.advSecretKey !== 'string' ||
			!creds.advSecretKey ||
			!creds.noiseKey?.public ||
			!creds.signedIdentityKey?.public
		) {
			throw new Boom(
				'AunuBaileys: creds.advSecretKey / creds.noiseKey / creds.signedIdentityKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again',
				{ statusCode: 500 }
			)
		}

		// AunuBaileys (HB-157, re-applied P3b): Buffer.from(string)
		// encodes the base64 TEXT as UTF-8; decode string key
		// material as base64 first (house rule).
		const noiseKeyB64 = (keyMaterialToBuffer(creds.noiseKey.public) as Buffer).toString('base64')
		const identityKeyB64 = (keyMaterialToBuffer(creds.signedIdentityKey.public) as Buffer).toString('base64')
		const advB64 = creds.advSecretKey

		let qrMs = qrTimeout || 60_000 // time to let a QR live
		const genPairQR = () => {
			if (!ws.isOpen) {
				qrChainActive = false
				qrRefNodes = []
				return
			}

			const refNode = qrRefNodes.shift()
			if (!refNode) {
				qrChainActive = false
				qrRefNodes = []
				void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }))
				return
			}

			// AunuBaileys (1.0.70, ported with the adjunct HB-243
			// wrapper in P4): a ref node without content is a legal
			// encoding, but toString() on undefined threw — and the
			// recursive call sits in a timer, outside the handler's
			// try — so the 2nd+ QR cycle crashed the process. Skip
			// and schedule the next QR.
			if (refNode.content == null) {
				logger.warn('pair-device ref node has no content; skipping this QR cycle')
				qrTimer = setTimeout(genPairQR, qrMs)
				return
			}

			const ref = (refNode.content as Buffer).toString('utf-8')
			const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser)

			ev.emit('connection.update', { qr })

			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = qrTimeout || 20_000 // shorter subsequent qrs
		}

			genPairQR()
		} catch (error) {
			logger.info({ trace: (error as Error).stack }, 'error in pair-device')
			void end(error as Error)
		}
	})
	// device paired for the first time
	// if device pairs successfully, the server asks to restart the connection
	ws.on('CB:iq,,pair-success', async (stanza: BinaryNode) => {
		logger.debug('pair success recv')
		// AunuBaileys (2.5.0, HB-428 facet 2): a pair-success stanza
		// already queued when the host calls end() must not emit
		// creds.update / isNewLogin into the torn-down socket.
		if (closed) {
			return
		}
		try {
			updateServerTimeOffset(stanza)
			const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)

			// AunuBaileys (2.3.0, HB-389): pairing just succeeded —
			// the QR chain has nothing left to do. It used to keep
			// cycling on the shared qrTimer (only end() and
			// CB:success cleared it), emitting QRs for an already
			// paired session and, when the refs ran out before a
			// delayed <success> arrived, killing the healthy fresh
			// login with 'QR refs attempts ended'. Stop the chain
			// here, and reset the flag so a later pair-device IQ on
			// this socket is not ignored as a duplicate.
			clearTimeout(qrTimer)
			qrChainActive = false
			qrRefNodes = []

			logger.info(
				{ me: updatedCreds.me, platform: updatedCreds.platform },
				'pairing configured successfully, expect to restart the connection...'
			)

			// AunuBaileys (2.6.0, HB-479): the creds.update /
			// isNewLogin emits below must wait until the
			// pair-device-sign reply has actually gone out. They
			// used to fire BEFORE sendNode(reply), so a transport
			// failure in that window left the paired identity
			// persisted - the internal creds.update listener
			// assigns it into creds and the host's saveCreds
			// writes it to disk - although the server may never
			// have seen the reply. The next boot then took the
			// login path with an unregistered identity and looped
			// on 401/loggedOut until re-pair. Emit only after the
			// reply succeeds (mirror HB-262 in
			// requestPairingCode); on failure the catch below ends
			// the socket with nothing persisted. configureSuccessfulPairing
			// returns a fresh update object and never mutates
			// creds itself, so withholding the emit also keeps the
			// in-memory creds un-paired.
			await sendNode(reply)

			try {
				ev.emit('creds.update', updatedCreds)
			} catch (err) {
				logger.error({ err }, 'error in creds.update listener \u2014 continuing')
			}
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })

			void sendUnifiedSession()
		} catch (error: any) {
			logger.info({ trace: error.stack }, 'error in pairing')
			void end(error)
		}
	})
	// login complete
	ws.on('CB:success', async (node: BinaryNode) => {
		updateServerTimeOffset(node)
		// AunuBaileys (2.5.0, HB-419): the QR timer used to be
		// cleared AFTER three housekeeping awaits — a pending timer
		// fired inside that window and emitted a QR for an already
		// authenticated session. Clear it (and the chain flag) at
		// once, before anything awaits.
		clearTimeout(qrTimer) // will never happen in all likelyhood -- but just in case WA sends success on first try
		// AunuBaileys (2.3.0, HB-389): reset the chain flag alongside
		// the timer — a stale `qrChainActive` made every later
		// pair-device IQ on this socket a silently ignored
		// 'duplicate', so a re-pairing request never produced a QR.
		qrChainActive = false
		qrRefNodes = []
		// AunuBaileys (2.5.0, HB-428): end() may have landed while
		// the success stanza was in flight — nothing below may emit
		// into a torn-down socket. end() suspends at `await
		// ws.close()` with the listeners still attached, so the
		// housekeeping window used to deliver a phantom 'open'
		// after the host had already torn down.
		if (closed) {
			return
		}

		logger.info('opened connection to WA')

		try {
			// AunuBaileys (2.1.0, HB-315): a CB:success without a lid attr used to wipe a known me.lid to undefined — and persist the loss.
			// AunuBaileys (2.3.0, HB-315 addendum): with `creds.me`
			// itself undefined (a partial creds restore), the spread
			// produced a partial `{ lid }` / `{}` me that was then
			// PERSISTED — the next boot took the login path on a
			// truthy me with no id and looped on Boom 400. A success
			// stanza carries no identity of its own, so when there
			// is no complete me to update there is nothing to emit.
			if (authState.creds.me?.id) {
				ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid ?? authState.creds.me.lid } })
			}
		} catch (err) {
			logger.error({ err }, 'error in creds.update listener \u2014 continuing')
		}

		// AunuBaileys (2.5.0, HB-422): 'open' used to wait on the
		// housekeeping IQs below (~2x defaultQueryTimeoutMs when the
		// server does not answer them). Emit it BEFORE the
		// housekeeping — the connection is open, and the housekeeping
		// is best-effort work that must never delay (or, via HB-428,
		// outlive) the open signal.
		ev.emit('connection.update', { connection: 'open' })
		void sendUnifiedSession()

		try {
			await uploadPreKeysToServerIfRequired()
			await sendPassiveIq('active')

			// After successful login, validate our key-bundle against server
			try {
				await digestKeyBundle()
			} catch (e) {
				logger.warn({ e }, 'failed to run digest after login')
			}
		} catch (err) {
			logger.warn({ err }, 'failed to send initial passive iq')
		}

		if (node.attrs.lid && authState.creds.me?.id) {
			const myLID = node.attrs.lid
			process.nextTick(async () => {
				// AunuBaileys (2.5.0, HB-428): same closed guard as
				// above — the socket may have ended while the
				// housekeeping awaits were in flight.
				if (closed) {
					return
				}
				try {
					const myPN = authState.creds.me!.id

					// Store our own LID-PN mapping
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])

					// Create device list for our own user (needed for bulk migration)
					const { user, device } = jidDecode(myPN)!
					// AunuBaileys (2.2.0, HB-369): this used to OVERWRITE
					// the stored list with only the current device — the
					// companion devices' sessions then never migrated
					// PN→LID, because migrateSession's only source is
					// this list. Union with what is already stored.
					const existingDeviceList = await authState.keys.get('device-list', [user])
					// AunuBaileys (2.3.0, HB-317 addendum): second read
					// site of the stored device-list — migrateSession
					// got the HB-317 Array.isArray guard, this one did
					// not: a stored string was spread into a persisted
					// char array (or passed includes() silently), and
					// a stored number threw, skipping the union and
					// the migration. A non-array value is corrupt
					// state: start from an empty list.
					const storedDevices = existingDeviceList[user]
					const knownDevices: string[] = Array.isArray(storedDevices) ? storedDevices : []
					const currentDevice = device?.toString() || '0'
					await authState.keys.set({
						'device-list': {
							[user]: knownDevices.includes(currentDevice) ? knownDevices : [...knownDevices, currentDevice]
						}
					})

					// migrate our own session
					await signalRepository.migrateSession(myPN, myLID)

					logger.info({ myPN, myLID }, 'Own LID session created successfully')
				} catch (error) {
					logger.error({ error, lid: myLID }, 'Failed to create own LID session')
				}
			})
		}
	})

	// AunuBaileys (P2f, donor v6 1.0.71): 405 clientTooOld — fetch the
	// live WA Web build so the next connection in this process uses
	// it, and signal the host BEFORE end() tears the connection down.
	// Never throws: a failed or timed-out fetch only logs, leaves the
	// override untouched (no ratchet state advances before its commit
	// succeeds), and the caller still ends with the original 405.
	const handleClientTooOld = async (): Promise<void> => {
		try {
			const latest: { version: WAVersion; isLatest: boolean; error?: unknown } = await promiseTimeout(
				CLIENT_TOO_OLD_FETCH_TIMEOUT_MS,
				(resolve, reject) => {
					fetchLatestWaWebVersion({}).then(resolve, reject)
				}
			)
			if (latest.isLatest) {
				latestVersionOverride = latest.version
				logger.warn(
					{ rejected: config.version, latest: latest.version },
					'server rejected the client version as too old (405); the next connection uses the latest WA Web version'
				)
				// AunuBaileys (2.5.0, HB-428 facet 3): the fetch may
				// land during a concurrent host end() — end() suspends
				// at `await ws.close()` with the listeners still
				// attached, so this emit used to reach the host after
				// teardown. The override assignment above stays: it
				// helps the NEXT socket in this process, by design.
				if (closed) {
					return
				}
				// Guarded like the creds.update emits (HB-259 pattern):
				// a throwing host listener must not lose the end()
				// that follows.
				try {
					ev.emit('connection.update', { clientTooOld: true, latestVersion: latest.version })
				} catch (err) {
					logger.error({ err }, 'error in connection.update listener — continuing')
				}
			} else {
				logger.warn(
					{ err: (latest.error as { message?: string } | undefined)?.message ?? latest.error },
					'server rejected the client version as too old (405) and the latest version could not be fetched; pass a current `version`'
				)
			}
		} catch (err) {
			logger.warn({ err }, 'failed to fetch the latest WA Web version after a 405')
		}
	}

	ws.on('CB:stream:error', async (node: BinaryNode) => {
		const [reasonNode] = getAllBinaryNodeChildren(node)
		logger.error({ reasonNode, fullErrorNode: node }, 'stream errored out')

		const { reason, statusCode } = getErrorCodeFromStreamError(node)

		// AunuBaileys (P5): BanSentinel observer for the error stream —
		// dangerous stream codes (incl. 429/500/503) trip the guard
		// here; end() below still receives the generic disconnect feed.
		if (banSentinel) {
			try {
				banSentinel.noteStreamError(statusCode)
			} catch (err) {
				logger.error({ err }, 'error in ban sentinel stream-error observer — continuing')
			}
		}

		if (statusCode === 405) {
			// AunuBaileys (HB-148, donor v6 1.0.77): awaited like the
			// CB:failure path — firing it void let end() tear the
			// connection.update listeners down before the version
			// fetch landed, so the clientTooOld signal never reached
			// the host and a 405 looked like any other disconnect.
			await handleClientTooOld()
		}

		void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }))
	})
	// stream fail, possible logout
	ws.on('CB:failure', async (node: BinaryNode) => {
		// AunuBaileys (1.0.77, HB-42/HB-64, re-applied P3): a
		// non-numeric or out-of-range reason made `new Boom` throw
		// inside this handler \u2014 sanitise to the 400\u2013599 range.
		const rawReason = +(node.attrs.reason || 500)
		const reason = Number.isInteger(rawReason) && rawReason >= 400 && rawReason <= 599 ? rawReason : 500
		if (reason === 405) {
			// awaited so the clientTooOld signal lands before end()
			await handleClientTooOld()
		}

		void end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})

	ws.on('CB:ib,,downgrade_webclient', () => {
		void end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
	})

	ws.on('CB:ib,,offline_preview', async (node: BinaryNode) => {
		logger.info('offline preview received', JSON.stringify(node))
		// AunuBaileys (HB-283, donor v6 HB-7): sendNode rejects when the
		// socket closes in the window after this stanza arrives; left
		// unguarded that rejection is unhandled and crashes the process.
		try {
			await sendNode({
				tag: 'ib',
				attrs: {},
				content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
			})
		} catch (err) {
			logger.error({ err }, 'failed to request offline batch after offline preview')
		}
	})

	ws.on('CB:ib,,edge_routing', (node: BinaryNode) => {
		// AunuBaileys (2.5.0, HB-428 facet 2): a stanza already
		// queued when the host calls end() must not emit creds.update
		// into the torn-down socket.
		if (closed) {
			return
		}
		const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing')
		const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info')
		if (routingInfo?.content) {
			authState.creds.routingInfo = Buffer.from(routingInfo?.content as Uint8Array)
			try {
				ev.emit('creds.update', authState.creds)
			} catch (err) {
				logger.error({ err }, 'error in creds.update listener \u2014 continuing')
			}
		}
	})

	let didStartBuffer = false
	process.nextTick(() => {
		// AunuBaileys (2.5.0, HB-413): a same-tick end() lands
		// before this callback drains — without the guard it
		// emitted 'connecting' after the host had torn down.
		if (closed) {
			return
		}
		if (creds.me?.id) {
			// start buffering important events
			// if we're logged in
			ev.buffer()
			didStartBuffer = true
		}

		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})

	// called when all offline notifs are handled
	ws.on('CB:ib,,offline', (node: BinaryNode) => {
		// AunuBaileys (2.5.0, HB-428 facet 2): a stanza already
		// queued when the host calls end() must not emit (or flush
		// buffered events) into the torn-down socket.
		if (closed) {
			return
		}
		const child = getBinaryNodeChild(node, 'offline')
		const offlineNotifs = +(child?.attrs.count || 0)

		logger.info(`handled ${offlineNotifs} offline messages/notifications`)
		if (didStartBuffer) {
			ev.flush()
			logger.trace('flushed events for initial buffer')
		}

		ev.emit('connection.update', { receivedPendingNotifications: true })
	})

	// update credentials when required
	ev.on('creds.update', update => {
		const name = update.me?.name
		// AunuBaileys (1.0.72, HB-72, re-applied P3b): partial creds
		// updates without me.name used to send an attribute-less
		// <presence/> — the server reads that as 'available',
		// marking the account online and suppressing phone push
		// notifications.
		// if name has just been received
		if (typeof name === 'string' && name.length > 0 && creds.me?.name !== name) {
			logger.debug({ name }, 'updated pushName')
			sendNode({
				tag: 'presence',
				attrs: { name: name! }
			}).catch(err => {
				logger.warn({ trace: err.stack }, 'error in sending presence update on name change')
			})
		}

		Object.assign(creds, update)
	})

	const updateServerTimeOffset = ({ attrs }: BinaryNode) => {
		const tValue = attrs?.t
		if (!tValue) {
			return
		}

		const parsed = Number(tValue)
		if (Number.isNaN(parsed) || parsed <= 0) {
			return
		}

		const localMs = Date.now()
		serverTimeOffsetMs = parsed * 1000 - localMs
		logger.debug({ offset: serverTimeOffsetMs }, 'calculated server time offset')
	}

	const getUnifiedSessionId = () => {
		const offsetMs = 3 * TimeMs.Day
		const now = Date.now() + serverTimeOffsetMs
		const id = (now + offsetMs) % TimeMs.Week
		return id.toString()
	}

	const sendUnifiedSession = async () => {
		if (!ws.isOpen) {
			return
		}

		const node = {
			tag: 'ib',
			attrs: {},
			content: [
				{
					tag: 'unified_session',
					attrs: {
						id: getUnifiedSessionId()
					}
				}
			]
		}

		try {
			await sendNode(node)
		} catch (error) {
			logger.debug({ error }, 'failed to send unified_session telemetry')
		}
	}

	const registerSocketEndHandler = (handler: (error: Error | undefined) => void | Promise<void>) => {
		socketEndHandlers.push(handler)
	}

	/**
	 * Fetches your account's standing when it comes to restrictions.
	 * @returns Returns the state of the restrictions.
	 */
	const fetchAccountReachoutTimelock = async () => {
		const queryResult = await executeWMexQuery<{
			is_active?: boolean
			time_enforcement_ends?: string
			enforcement_type: ReachoutTimelockEnforcementType
		}>({}, QueryIds.REACHOUT_TIMELOCK, XWAPaths.xwa2_fetch_account_reachout_timelock, query, generateMessageTag)
		const result: ReachoutTimelockState = {
			isActive: !!queryResult?.is_active,
			timeEnforcementEnds:
				queryResult?.time_enforcement_ends && queryResult?.time_enforcement_ends !== '0'
					? new Date(parseInt(queryResult.time_enforcement_ends, 10) * 1000)
					: undefined,
			enforcementType: queryResult?.enforcement_type ?? ReachoutTimelockEnforcementType.DEFAULT
		}
		ev.emit('connection.update', { reachoutTimeLock: result })
		return result
	}

	/**
	 * Fetches your account's new chat limits.
	 * @returns Returns the quota and the usage.
	 */
	const aunuIgnoreFilter = createIgnoreFilter()
	const fetchNewChatMessageCap = async () => {
		return executeWMexQuery<NewChatMessageCapInfo>(
			{ input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } },
			QueryIds.MESSAGE_CAPPING_INFO,
			XWAPaths.xwa2_message_capping_info,
			query,
			generateMessageTag
		)
	}

	return {
		type: 'md' as 'md',
		ws,
		ev,
		authState: { creds, keys },
		// AunuBaileys: the LID identity store is created HERE, in the base
		// layer, so the same instance propagates through every layer's
		// { ...sock } spread to the final socket — inner layers (receipt
		// handling, presence, polls) read the store the public
		// sock.aunuLid learns into, not a private copy.
		// AunuBaileys (1.0.71): when live traffic teaches the store a
		// new PN<->LID pair, publish it so hosts can keep their own
		// identity maps in sync (donor event name: violetix
		// 'lid-mapping.update').
		aunuLid: makeLIDStore({
			onPairLearned: ({ pn, lid }) => ev.emit('lid-mapping.update', { lid, pn })
		}),
		// AunuBaileys: the ignoreKey registry, created here for the same
		// reason as aunuLid — one instance for every layer.
		aunuIgnoreFilter,
		// AunuBaileys (P5): the BanSentinel guarding this socket, exposed
		// as `sock.aunuBanSentinel` (the one exposure pattern; when the
		// host wraps the socket with wrapAntiBan, the same instance is
		// also reachable as `sock.aunuAntiBan.banSentinel`). Absent
		// entirely when disabled via `banSentinel: false`.
		...(banSentinel ? { aunuBanSentinel: banSentinel } : {}),
		ignoreKey: aunuIgnoreFilter.add,
		clearIgnoredKeys: aunuIgnoreFilter.clear,
		signalRepository,
		get user() {
			return authState.creds.me
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
		onUnexpectedError,
		uploadPreKeys,
		uploadPreKeysToServerIfRequired,
		digestKeyBundle,
		rotateSignedPreKey,
		requestPairingCode,
		updateServerTimeOffset,
		sendUnifiedSession,
		wamBuffer: publicWAMBuffer,
		/** Waits for the connection to WA to reach a state */
		waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
		sendWAMBuffer,
		executeUSyncQuery,
		onWhatsApp,
		fetchAccountReachoutTimelock,
		fetchNewChatMessageCap
	}
}

/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler: (err: Error) => void) {
	return (error: Error) => {
		handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))
	}
}
