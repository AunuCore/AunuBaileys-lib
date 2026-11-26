// AunuBaileys 2.5.0 — Kelompok C (messages-send / relay) regression tests.
// Covers HB-416 (+addenda 1/2/3), HB-430 facet 1, HB-433, HB-435, HB-436,
// HB-441, HB-443, HB-448, HB-201 addendum 3, HB-253 addendum, HB-269
// addendum facet 4, plus the two deltas: poll-vote SEND and Kage LID
// addressing helpers. Every test FAILS without its fix (verified by
// re-introducing the old behaviour in lib/ — see GROUP-C-REPORT.md).
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild, getBizBinaryNode, jidEncode } from '../lib/WABinary/index.js'
// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { generateWAMessageContent, encryptPollVote, getMeParticipant, getQuotedParticipant, shouldIncludeBizBinaryNode } from '../lib/Utils/messages.js'
import { decryptPollVote } from '../lib/Utils/process-message.js'
import { sha256, Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { waproto } from '../WAProto/index.js'

const ME = '628123456789@s.whatsapp.net'
const ME_USER = '628123456789'
const ME_LID = '100000000000001@lid'
const ME_LID_USER = '100000000000001'
const PEER = '628987654321@s.whatsapp.net'
const PEER_USER = '628987654321'
const PEER_LID = '100000000000002@lid'
const PEER_LID_USER = '100000000000002'
const EXTRA = '628555000111@s.whatsapp.net'
const GROUP = '120363123456789012@g.us'
const POLL_ID = 'POLL-31-001'

// A bundle built from fresh keys — the same fixture shape test/26 uses
// for injectE2ESession. Good enough for the offline encrypt path.
const bundleFor = () => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
	}
}

const injectSessions = async (sock, jids) => {
	const repo = makeLibSignalRepository(sock.authState, silentLogger)
	for (const jid of jids) {
		await repo.injectE2ESession({ jid, session: bundleFor() })
	}
}

const seedDevices = async (sock, users) => {
	// AunuBaileys (2.7.0, HB-489): the device cache is keyed by the
	// normalised JID (user + server), not the bare user.
	await sock.userDevicesCache.mset(
		users.map(user => ({ key: `${user}@s.whatsapp.net`, value: [{ user, device: 0, server: 's.whatsapp.net' }] }))
	)
}

// Seed a tctoken entry with a CURRENT senderTimestamp so the fire-and-
// forget issuance after a 1:1 send is skipped (shouldSendNewTcToken
// returns false for the current bucket) — keeps the recorded frames
// to exactly the message stanza.
const suppressTcTokenIssuance = async (sock, jid) => {
	await sock.authState.keys.set({ tctoken: { [jid]: { token: Buffer.alloc(0), senderTimestamp: Math.floor(Date.now() / 1000) } } })
}

const makeSendSocket = async (extra = {}) => {
	const sock = await makeOfflineSocket({ shouldSyncHistoryMessage: () => false, ...extra })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	return { sock, frames }
}

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) {
		off = 4
	}

	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

const decodeFrames = async frames => {
	const out = []
	for (const frame of frames) {
		try {
			out.push(await decodeFrame(frame))
		} catch {
			// undecodable frame — ignore
		}
	}

	return out
}

const messageStanzas = async frames => (await decodeFrames(frames)).filter(node => node?.tag === 'message')

// Answer every outgoing IQ: encrypt IQs get an empty device list (so
// assertSessions' bundle fetch finds nothing and moves on); USync IQs
// get a fabricated <usync><list> result for `usyncUser` when one is
// given (devices + lid + status + contact nodes — each query's parser picks the
// protocols it registered, the rest are dropped); everything else gets
// an empty <result/> (so resyncAppState converges and query() resolves
// instead of timing out).
const answerAllIQs = (sock, usyncUser) => {
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data).then(node => {
			if (node?.tag !== 'iq' || !node.attrs?.id) {
				return
			}

			let content = []
			if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'get') {
				content = [{ tag: 'list', attrs: {}, content: [] }]
			} else if (node.attrs.xmlns === 'usync' && usyncUser) {
				const userContent = []
				if (usyncUser.devices !== false) {
					userContent.push({
						tag: 'devices',
						attrs: {},
						content: [{
							tag: 'device-list',
							attrs: {},
							content: [{ tag: 'device', attrs: { id: '0', 'key-index': '0' } }]
						}]
					})
				}

				if (usyncUser.lid) {
					userContent.push({ tag: 'lid', attrs: { val: usyncUser.lid } })
				}

				if (usyncUser.status) {
					userContent.push({ tag: 'status', attrs: {}, content: Buffer.from(usyncUser.status) })
				}

				if (usyncUser.contact) {
					userContent.push({ tag: 'contact', attrs: { type: 'in' } })
				}

				content = [{
					tag: 'usync',
					attrs: {},
					content: [{
						tag: 'list',
						attrs: {},
						content: [{ tag: 'user', attrs: { jid: usyncUser.jid }, content: userContent }]
					}]
				}]
			}

			sock.ws.emit(`TAG:${node.attrs.id}`, {
				tag: 'iq',
				attrs: { type: 'result', id: node.attrs.id },
				content
			})
		}).catch(() => {})
	}
}

// --- HB-416: keys.get('tctoken') throwing must not fail a 1:1 send ---

test('HB-416: DM send succeeds when the tctoken store read throws', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		await seedDevices(sock, [ME_USER, PEER_USER])
		await injectSessions(sock, [PEER, ME])
		const origGet = sock.authState.keys.get.bind(sock.authState.keys)
		sock.authState.keys.get = async (type, ids) => {
			if (type === 'tctoken') {
				throw new Error('tctoken store down (simulated)')
			}

			return origGet(type, ids)
		}
		await sock.sendMessage(PEER, { text: 'hello-416' })
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.equal(stanzas[0].attrs.to, PEER)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-416 addendum 2: keys.get('sender-key-memory') throwing must not fail a group send ---

test('HB-416 addendum 2: group send succeeds when the sender-key-memory read throws', async () => {
	const { sock, frames } = await makeSendSocket({
		cachedGroupMetadata: async () => ({ participants: [{ id: PEER }], addressingMode: 'lid' })
	})
	try {
		await seedDevices(sock, [PEER_USER])
		await injectSessions(sock, [PEER])
		const origGet = sock.authState.keys.get.bind(sock.authState.keys)
		sock.authState.keys.get = async (type, ids) => {
			if (type === 'sender-key-memory') {
				throw new Error('sender-key-memory store down (simulated)')
			}

			return origGet(type, ids)
		}
		await sock.sendMessage(GROUP, { text: 'hello-416-add2' })
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.equal(stanzas[0].attrs.to, GROUP)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-416 addendum 3 (ALREADY-FIXED in 2.4.0): assertSessions degrades when getLIDsForPNs throws ---

test('HB-416 addendum 3 (lock-in): DM send degrades when getLIDsForPNs throws', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		// Two peer devices, a session for device 0 only: device 1 has
		// no session, so assertSessions must fetch — and hits the
		// throwing mapping. (The sender's own device 0 is skipped from
		// the recipient list, so it can never trigger the fetch.)
		await sock.userDevicesCache.mset([
			{ key: ME, value: [{ user: ME_USER, device: 0, server: 's.whatsapp.net' }] },
			{ key: PEER, value: [{ user: PEER_USER, device: 0, server: 's.whatsapp.net' }, { user: PEER_USER, device: 1, server: 's.whatsapp.net' }] }
		])
		await injectSessions(sock, [PEER])
		answerAllIQs(sock)
		sock.signalRepository.lidMapping.getLIDsForPNs = async () => {
			throw new Error('lid-mapping store down (simulated)')
		}
		await suppressTcTokenIssuance(sock, PEER)
		await sock.sendMessage(PEER, { text: 'hello-416-add3' })
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.equal(stanzas[0].attrs.to, PEER)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-430 facet 1: storeLIDPNMappings throwing must not fail getUSyncDevices ---

test('HB-430 facet 1: getUSyncDevices returns devices when storeLIDPNMappings throws', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		// Frame-level USync answer: the device list + LID arrive from
		// the wire, so only the persist step is simulated to throw.
		answerAllIQs(sock, { jid: PEER, lid: PEER_LID })
		sock.signalRepository.lidMapping.storeLIDPNMappings = async () => {
			throw new Error('lid-mapping store down (simulated)')
		}
		const devices = await sock.getUSyncDevices([PEER], false, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
		const nodes = await decodeFrames(frames)
		assert.ok(nodes.some(node => node?.tag === 'iq' && node.attrs?.xmlns === 'usync'), 'expected a USync IQ to be sent')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-439 (sweep): a timed-out USync fetch must not silently return a partial device list ---

test('HB-439 (sweep): getUSyncDevices throws Boom 408 when the USync query times out', async () => {
	const { sock } = await makeSendSocket()
	try {
		// Warm cache for the peer only — EXTRA has no cached devices,
		// so a USync fetch is required and (with no IQ responder) it
		// times out after defaultQueryTimeoutMs.
		await seedDevices(sock, [PEER_USER])
		await assert.rejects(
			sock.getUSyncDevices([PEER, EXTRA], true, false),
			err => err?.output?.statusCode === 408 && /device list incomplete/.test(err.message)
		)
		// Control: an answered USync query still returns devices.
		answerAllIQs(sock, { jid: PEER, lid: PEER_LID })
		const devices = await sock.getUSyncDevices([PEER], false, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
	} finally {
		endQuietly(sock)
	}
})

// --- HB-433: updateMediaMessage wait must be cancelled when the sibling sendNode fails ---

test('HB-433: failed updateMediaMessage rejects fast and leaks no listeners', async () => {
	const { sock } = await makeSendSocket()
	try {
		const rawEv = sock.ev.on('__probe-433__', () => {})
		const baselineMedia = rawEv.listenerCount('messages.media-update')
		const baselineConn = rawEv.listenerCount('connection.update')
		// Closed transport: sendRawMessage throws Boom 'Connection Closed'.
		sock.ws.socket.readyState = 3
		const msg = {
			key: { remoteJid: PEER, fromMe: true, id: 'UMM-433' },
			message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.alloc(32, 7) } }
		}
		const started = Date.now()
		await assert.rejects(sock.updateMediaMessage(msg), /Connection Closed/)
		assert.ok(Date.now() - started < 5000, 'must reject fast, not after the 120s bindWaitForEvent bound')
		await sleep(300)
		assert.equal(rawEv.listenerCount('messages.media-update'), baselineMedia, 'media-update listener leaked')
		assert.equal(rawEv.listenerCount('connection.update'), baselineConn, 'connection.update listener leaked')
		// A second failed call must not accumulate either.
		await assert.rejects(sock.updateMediaMessage({ ...msg, key: { ...msg.key, id: 'UMM-433-b' } }), /Connection Closed/)
		await sleep(300)
		assert.equal(rawEv.listenerCount('messages.media-update'), baselineMedia)
		assert.equal(rawEv.listenerCount('connection.update'), baselineConn)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-435: USync wrappers resolve [] on timeout, not undefined ---

test('HB-435: fetchStatus and fetchDisappearingDuration resolve [] when the USync query times out', async () => {
	const { sock } = await makeSendSocket()
	try {
		// No IQ responder installed: both USync IQs time out after
		// defaultQueryTimeoutMs (800 ms) and resolve undefined.
		assert.deepEqual(await sock.fetchStatus(PEER), [])
		assert.deepEqual(await sock.fetchDisappearingDuration(PEER), [])
		// Control: a real result still passes through.
		answerAllIQs(sock, { jid: PEER, status: 'hi', devices: false })
		const statuses = await sock.fetchStatus(PEER)
		assert.equal(statuses.length, 1)
		assert.equal(statuses[0].id, PEER)
		assert.equal(statuses[0].status.status, 'hi')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-436: star() must star every message, one patch per message ---

test('HB-436: star() with 3 messages sends 3 distinct app-state patches', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		const keyId = Buffer.from('test-app-state-key-id').toString('base64')
		sock.authState.creds.myAppStateKeyId = keyId
		await sock.authState.keys.set({
			'app-state-sync-key': {
				[keyId]: { keyData: Buffer.alloc(32, 9), fingerprint: { rawId: 1, currentIndex: 0 }, timestamp: 123456 }
			}
		})
		answerAllIQs(sock)
		const messages = [
			{ id: 'MSG-436-A', fromMe: true },
			{ id: 'MSG-436-B', fromMe: true },
			{ id: 'MSG-436-C', fromMe: true }
		]
		await sock.star(PEER, messages, true)
		const nodes = await decodeFrames(frames)
		const patchBytes = nodes
			.filter(node => node?.tag === 'iq')
			.map(node => getBinaryNodeChild(getBinaryNodeChild(node, 'sync'), 'collection'))
			.map(collection => getBinaryNodeChild(collection, 'patch'))
			.filter(Boolean)
			.map(patch => Buffer.from(patch.content).toString('base64'))
		assert.equal(patchBytes.length, 3, `expected 3 patch IQs, got ${patchBytes.length}`)
		assert.equal(new Set(patchBytes).size, 3, 'patch payloads must be pairwise distinct')
		// Control: a single message still sends exactly one patch.
		frames.length = 0
		await sock.star(PEER, [messages[0]], false)
		const nodes2 = await decodeFrames(frames)
		const patchCount2 = nodes2
			.filter(node => node?.tag === 'iq')
			.map(node => getBinaryNodeChild(getBinaryNodeChild(node, 'sync'), 'collection'))
			.map(collection => getBinaryNodeChild(collection, 'patch'))
			.filter(Boolean).length
		assert.equal(patchCount2, 1)
	} finally {
		endQuietly(sock)
	}
})

test('HB-436: star() with an empty list still throws Boom 400 (HB-353 preserved)', async () => {
	const { sock } = await makeSendSocket()
	try {
		assert.throws(() => sock.star(PEER, [], true), err => err?.output?.statusCode === 400)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-441: viewOnce variants ---

test('HB-441: viewOnce v2 wraps in viewOnceMessageV2', async () => {
	const m = await generateWAMessageContent({ text: 'hi-441', viewOnce: 'v2' }, {})
	assert.ok(m.viewOnceMessageV2, 'expected viewOnceMessageV2')
	assert.ok(!m.viewOnceMessage, 'must not also wrap v1')
})

test('HB-441: viewOnce { version: 2 } wraps in viewOnceMessageV2', async () => {
	const m = await generateWAMessageContent({ text: 'hi-441', viewOnce: { version: 2 } }, {})
	assert.ok(m.viewOnceMessageV2)
})

test('HB-441: album + viewOnce true is NOT wrapped (util contract)', async () => {
	const m = await generateWAMessageContent({ album: { expectedImageCount: 1 }, viewOnce: true }, {})
	assert.ok(m.albumMessage, 'album must survive')
	assert.ok(!m.viewOnceMessage && !m.viewOnceMessageV2, 'album must not be wrapped without force')
})

test('HB-441: album + viewOnce force wraps v1', async () => {
	const m = await generateWAMessageContent({ album: { expectedImageCount: 1 }, viewOnce: 'force' }, {})
	assert.ok(m.viewOnceMessage, 'expected viewOnceMessage wrapper')
	assert.ok(m.viewOnceMessage.message?.albumMessage, 'album must be inside the wrapper')
})

test('HB-441: pre-wrapped V2 content passes through without Boom 400', async () => {
	const m = await generateWAMessageContent({ viewOnceMessageV2: { message: { conversation: 'hi-441' } } }, {})
	assert.ok(m.viewOnceMessageV2)
	assert.equal(m.viewOnceMessageV2.message.conversation, 'hi-441')
})

test('HB-441: viewOnce true still wraps v1 (HB-381 compatibility)', async () => {
	const m = await generateWAMessageContent({ text: 'hi-441', viewOnce: true }, {})
	assert.ok(m.viewOnceMessage)
	assert.ok(!m.viewOnceMessageV2)
})

// --- HB-448: cachedGroupMetadata throwing must fall back to live groupMetadata ---

test('HB-448: group send falls back to live groupMetadata when the cache throws', async () => {
	const { sock, frames } = await makeSendSocket({
		cachedGroupMetadata: async () => {
			throw new Error('group cache down (simulated)')
		}
	})
	try {
		await assert.rejects(sock.sendMessage(GROUP, { text: 'hello-448' }), err => {
			assert.ok(!/group cache down/.test(err.message), `must not surface the cache error, got: ${err.message}`)
			return true
		})
		const nodes = await decodeFrames(frames)
		assert.ok(nodes.some(node => node?.tag === 'iq'), 'expected a live groupMetadata IQ to be sent')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-201 addendum 3: no 0-byte <device-identity> when creds.account is missing ---

test('HB-201 addendum 3: relayMessage skips <device-identity> when creds.account is missing', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		await seedDevices(sock, [ME_USER, PEER_USER])
		await injectSessions(sock, [PEER, ME])
		await suppressTcTokenIssuance(sock, PEER)
		assert.equal(sock.authState.creds.account, undefined, 'fresh offline creds must have no account')
		await sock.sendMessage(PEER, { text: 'hello-201-add3' })
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.equal(getBinaryNodeChild(stanzas[0], 'device-identity'), undefined, 'no 0-byte device-identity node')
		// Control: with an account present the node IS attached and non-empty.
		sock.authState.creds.account = {
			// AunuBaileys (2.7.0, HB-201 addendum 4): details must be a
			// DECODABLE ADVDeviceIdentity — present-but-garbage details
			// are now treated like a missing account and the node is
			// skipped, so the control encodes a real one.
			details: Buffer.from(waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
			accountSignatureKey: Buffer.from([5, 6, 7, 8]),
			accountSignature: Buffer.from([9, 10, 11, 12])
		}
		frames.length = 0
		await sock.sendMessage(PEER, { text: 'hello-201-add3-control' })
		const stanzas2 = await messageStanzas(frames)
		assert.equal(stanzas2.length, 1)
		const identity = getBinaryNodeChild(stanzas2[0], 'device-identity')
		assert.ok(identity, 'device-identity node must be present with an account')
		assert.ok(Buffer.from(identity.content).length > 0, 'device-identity content must be non-empty')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-253 addendum (ALREADY-FIXED in 2.4.0): empty album is rejected ---

test('HB-253 addendum (lock-in): { album: {} } is rejected with Boom 400', async () => {
	await assert.rejects(generateWAMessageContent({ album: {} }, {}), err => err?.output?.statusCode === 400)
	const m = await generateWAMessageContent({ album: { expectedImageCount: 1 } }, {})
	assert.ok(m.albumMessage)
})

// --- HB-269 addendum facet 4: patch results with unrequested / duplicate recipients are filtered ---

test('HB-269 addendum facet 4: createParticipantNodes drops unrequested and duplicate recipients', async () => {
	const { sock } = await makeSendSocket({
		patchMessageBeforeSending: async () => [
			{ recipientJid: PEER, message: { conversation: 'hi-269' } },
			{ recipientJid: EXTRA, message: { conversation: 'hi-269' } },
			{ recipientJid: PEER, message: { conversation: 'hi-269' } }
		]
	})
	try {
		await injectSessions(sock, [PEER, EXTRA])
		const { nodes } = await sock.createParticipantNodes([PEER], { conversation: 'hi-269' })
		assert.equal(nodes.length, 1, `expected 1 participant node, got ${nodes.length}`)
		assert.equal(nodes[0].attrs.jid, PEER)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-443: 'complete' must emit after a paused RECENT sync ---

const RECENT = waproto.HistorySync.HistorySyncType.RECENT // 3
const HSYNC = waproto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION

const histMsg = (id, progress) => ({
	key: { remoteJid: 'status@broadcast', id, fromMe: true },
	message: { protocolMessage: { type: HSYNC, historySyncNotification: { syncType: RECENT, progress } } },
	messageTimestamp: Math.floor(Date.now() / 1000)
})

// Intercept only the 120s paused timer; everything else uses the real
// clock. Adapted from heartbeat-tmp/run-0789/t0789-history-paused.mjs.
const installPausedTimerIntercept = () => {
	const realSetTimeout = globalThis.setTimeout
	const realClearTimeout = globalThis.clearTimeout
	const pausedTimers = []
	globalThis.setTimeout = (fn, ms, ...args) => {
		if (ms === 120_000) {
			const handle = { __pausedTimer: true, fn, args, fired: false }
			pausedTimers.push(handle)
			return handle
		}

		return realSetTimeout(fn, ms, ...args)
	}
	globalThis.clearTimeout = handle => {
		if (handle && handle.__pausedTimer) {
			handle.fired = true
			return
		}

		return realClearTimeout(handle)
	}
	const firePausedTimers = () => {
		for (const handle of pausedTimers.splice(0)) {
			if (!handle.fired) {
				handle.fired = true
				handle.fn(...handle.args)
			}
		}
	}
	const restore = () => {
		globalThis.setTimeout = realSetTimeout
		globalThis.clearTimeout = realClearTimeout
	}
	return { firePausedTimers, restore }
}

const makeHistorySocket = async () => {
	const sock = await makeOfflineSocket({ shouldSyncHistoryMessage: () => true })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	return { sock, frames }
}

test('HB-443: late progress=100 after a paused RECENT sync still emits complete', async () => {
	const { firePausedTimers, restore } = installPausedTimerIntercept()
	const { sock } = await makeHistorySocket()
	try {
		const statuses = []
		sock.ev.on('messaging-history.status', s => statuses.push({ ...s }))
		await sock.upsertMessage(histMsg('T443-p50', 50), 'notify')
		firePausedTimers()
		await sleep(300)
		assert.equal(statuses.filter(s => s.status === 'paused').length, 1, 'paused must emit exactly once')
		// A second stall must NOT emit 'paused' again.
		await sock.upsertMessage(histMsg('T443-p60', 60), 'notify')
		firePausedTimers()
		await sleep(300)
		assert.equal(statuses.filter(s => s.status === 'paused').length, 1, 'no duplicate paused')
		// The late chunk that reaches progress 100 completes the sync.
		await sock.upsertMessage(histMsg('T443-p100', 100), 'notify')
		await sleep(500)
		assert.ok(statuses.some(s => s.status === 'complete'), `complete must emit after late progress=100, got ${JSON.stringify(statuses)}`)
	} finally {
		restore()
		endQuietly(sock)
	}
})

test('HB-443 control: progress=100 without a stall emits complete and no paused', async () => {
	const { restore } = installPausedTimerIntercept()
	const { sock } = await makeHistorySocket()
	try {
		const statuses = []
		sock.ev.on('messaging-history.status', s => statuses.push({ ...s }))
		await sock.upsertMessage(histMsg('T443C-p50', 50), 'notify')
		await sock.upsertMessage(histMsg('T443C-p100', 100), 'notify')
		await sleep(500)
		assert.ok(statuses.some(s => s.status === 'complete'), `complete must emit, got ${JSON.stringify(statuses)}`)
		assert.equal(statuses.filter(s => s.status === 'paused').length, 0, 'no paused without a stall')
	} finally {
		restore()
		endQuietly(sock)
	}
})

// --- Delta: poll-vote SEND ---

const VOTE = {
	pollCreationMessageKey: { remoteJid: PEER, fromMe: true, id: POLL_ID },
	pollEncKey: Buffer.from('31'.repeat(32), 'hex'),
	selectedOptions: ['Yes', 'No'],
	pollCreatorJid: ME,
	voterJid: ME
}

test('poll-vote: encryptPollVote round-trips through decryptPollVote', async () => {
	const { encPayload, encIv } = encryptPollVote({
		pollMsgId: POLL_ID,
		pollCreatorJid: VOTE.pollCreatorJid,
		pollEncKey: VOTE.pollEncKey,
		voterJid: VOTE.voterJid,
		selectedOptions: VOTE.selectedOptions
	})
	assert.ok(encPayload.length > 0)
	assert.equal(encIv.length, 12)
	const decoded = decryptPollVote(
		{ encPayload, encIv },
		{ pollEncKey: VOTE.pollEncKey, pollCreatorJid: VOTE.pollCreatorJid, pollMsgId: POLL_ID, voterJid: VOTE.voterJid }
	)
	assert.deepEqual(
		decoded.selectedOptions.map(option => Buffer.from(option)),
		VOTE.selectedOptions.map(option => sha256(Buffer.from(option)))
	)
})

test('poll-vote: generateWAMessageContent builds pollUpdateMessage', async () => {
	const m = await generateWAMessageContent({ pollVote: VOTE }, {})
	assert.ok(m.pollUpdateMessage, 'expected pollUpdateMessage')
	assert.equal(m.pollUpdateMessage.pollCreationMessageKey.id, POLL_ID)
	assert.ok(m.pollUpdateMessage.vote.encPayload.length > 0)
	assert.ok(m.pollUpdateMessage.vote.encIv.length > 0)
	assert.ok(m.pollUpdateMessage.senderTimestampMs > 0)
})

test('poll-vote: generateWAMessageContent rejects invalid votes with Boom 400', async () => {
	const cases = [
		['missing creation key id', { ...VOTE, pollCreationMessageKey: { remoteJid: PEER, fromMe: true, id: '' } }],
		['empty pollEncKey', { ...VOTE, pollEncKey: Buffer.alloc(0) }],
		['selectedOptions not an array', { ...VOTE, selectedOptions: 'Yes' }],
		['selectedOptions with a non-string', { ...VOTE, selectedOptions: ['Yes', 42] }],
		['voter with a device suffix', { ...VOTE, voterJid: '628123456789:12@s.whatsapp.net' }],
		['creator on a different server', { ...VOTE, pollCreatorJid: ME_LID }],
		['creator and voter on different servers', { ...VOTE, pollCreatorJid: ME_LID, voterJid: ME }]
	]
	for (const [label, vote] of cases) {
		await assert.rejects(
			generateWAMessageContent({ pollVote: vote }, {}),
			err => err?.output?.statusCode === 400 && /pollVote/.test(err.message),
			label
		)
	}
})

test('poll-vote: sendPollVote relays with the <meta polltype=vote> node', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		await seedDevices(sock, [ME_USER, PEER_USER])
		await injectSessions(sock, [PEER, ME])
		await suppressTcTokenIssuance(sock, PEER)
		await sock.sendPollVote(PEER, VOTE)
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.equal(stanzas[0].attrs.to, PEER)
		const meta = getBinaryNodeChild(stanzas[0], 'meta')
		assert.ok(meta, 'expected a <meta> node on the relay stanza')
		assert.equal(meta.attrs.polltype, 'vote')
		assert.equal(meta.attrs.content_type, 'add_on')
	} finally {
		endQuietly(sock)
	}
})

// --- Delta: Kage LID addressing helpers ---

test('Kage: getMeParticipant resolves self via me.lid in a LID context', () => {
	// Only a LID-addressed destination selects the LID identity; a PN
	// DM or a group keeps the PN identity (kage lid-addressing.js).
	assert.equal(getMeParticipant(PEER_LID, ME, ME_LID), ME_LID)
	assert.equal(getMeParticipant(PEER, ME, ME_LID), ME)
	assert.equal(getMeParticipant(GROUP, ME, ME_LID), ME)
	assert.equal(getMeParticipant(PEER_LID, ME, undefined), ME)
	assert.equal(getMeParticipant(PEER_LID, ME), ME)
})

test('Kage: getQuotedParticipant resolves the quoted participant', () => {
	const quotedLidDm = { key: { remoteJid: PEER_LID, fromMe: true, id: 'Q1' } }
	assert.equal(getQuotedParticipant(quotedLidDm, PEER_LID, ME, ME_LID), ME_LID)
	const quotedGroup = { key: { remoteJid: GROUP, fromMe: true, id: 'Q2' } }
	assert.equal(getQuotedParticipant(quotedGroup, GROUP, ME, ME_LID), ME)
	const quotedDm = { key: { remoteJid: PEER, fromMe: true, id: 'Q3' } }
	assert.equal(getQuotedParticipant(quotedDm, PEER, ME, ME_LID), ME)
	const quotedOther = { key: { remoteJid: GROUP, fromMe: false, id: 'Q3' }, participant: PEER }
	assert.equal(getQuotedParticipant(quotedOther, GROUP, ME, ME_LID), PEER)
	const quotedParticipantInKey = { key: { remoteJid: GROUP, fromMe: false, id: 'Q4', participant: PEER } }
	assert.equal(getQuotedParticipant(quotedParticipantInKey, GROUP, ME, ME_LID), PEER)
	assert.equal(getQuotedParticipant(undefined, GROUP, ME, ME_LID), undefined)
	assert.equal(getQuotedParticipant(null, GROUP, ME, ME_LID), undefined)
})

// --- Coordinator: HB-435 facet onWhatsApp (2.5.0) ---

test('HB-435 (coordinator): onWhatsApp returns [] — never undefined — when the USync query times out', async () => {
	const { sock } = await makeSendSocket()
	try {
		// No IQ responder: the USync query times out after
		// defaultQueryTimeoutMs, query() resolves undefined, and
		// onWhatsApp must still resolve to an empty list (pre-fix
		// it fell off the end and returned undefined).
		const result = await sock.onWhatsApp(PEER)
		assert.deepEqual(result, [])
		// Control: an answered USync query with a <contact type=in>
		// node still reports the number as existing.
		answerAllIQs(sock, { jid: PEER, contact: true, devices: false })
		const found = await sock.onWhatsApp(PEER)
		assert.deepEqual(found, [{ jid: PEER, exists: true }])
	} finally {
		endQuietly(sock)
	}
})

// --- Coordinator: HB-475 (2.5.0) — a throwing userDevicesCache must not abort the send ---

test('HB-475: throwing userDevicesCache.mget falls back to the USync fetch', async () => {
	// mget throws (host backend down); set/mset stay healthy so this
	// test locks the READ guard only. Pre-fix the mget throw escaped
	// getUSyncDevices and no USync IQ was ever sent.
	const cache = {
		mget: async () => { throw new Error('devices cache down (simulated)') },
		get: async () => undefined,
		set: async () => {},
		mset: async () => {}
	}
	const { sock } = await makeSendSocket({ userDevicesCache: cache })
	try {
		answerAllIQs(sock, { jid: PEER, lid: PEER_LID })
		const devices = await sock.getUSyncDevices([PEER], true, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
	} finally {
		endQuietly(sock)
	}
})

// --- HB-500: interactive / a2ui branches restored (2.7.1) ---
// The v7 port lost the whole interactive send surface: the
// generateWAMessageContent branches, the a2ui post-processing, the
// interactiveAsTemplate wrap, the button-icon helper, and the
// relay's <biz> companion node. These tests call the REAL
// generateWAMessageContent / sendMessage / relayMessage — the
// 2.7.0 offline tarball probe missed the regression precisely
// because it stubbed sendMessage.

test('HB-500: { interactive } builds an interactiveMessage with nativeFlowMessage', async () => {
	const m = await generateWAMessageContent(
		{
			interactive: {
				header: { title: 'Judul', hasMediaAttachment: false },
				body: { text: 'Isi kartu' },
				footer: { text: 'Kaki' },
				buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'ya' }) }]
			}
		},
		{}
	)
	assert.ok(m.interactiveMessage, 'expected interactiveMessage')
	assert.equal(m.interactiveMessage.body.text, 'Isi kartu')
	assert.equal(m.interactiveMessage.footer.text, 'Kaki')
	assert.equal(m.interactiveMessage.nativeFlowMessage.buttons.length, 1)
	assert.equal(m.interactiveMessage.nativeFlowMessage.messageParamsJson, '')
	assert.equal(m.messageContextInfo.deviceListMetadataVersion, 2)
})

test('HB-500: interactive text/footerText shorthands fill body/footer', async () => {
	const m = await generateWAMessageContent({ interactive: { text: 'Isi', footerText: 'Kaki' } }, {})
	assert.equal(m.interactiveMessage.body.text, 'Isi')
	assert.equal(m.interactiveMessage.footer.text, 'Kaki')
})

test('HB-500: interactive carousel builds a carouselMessage', async () => {
	const m = await generateWAMessageContent(
		{
			interactive: {
				carousel: [
					{
						title: 'Kartu 1',
						body: 'Isi kartu',
						buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Pilih","id":"p1"}' }]
					}
				]
			}
		},
		{}
	)
	assert.ok(m.interactiveMessage.carouselMessage, 'expected carouselMessage')
	assert.equal(m.interactiveMessage.carouselMessage.messageVersion, 1)
	assert.equal(m.interactiveMessage.carouselMessage.cards[0].header.title, 'Kartu 1')
	assert.ok(!m.interactiveMessage.nativeFlowMessage, 'carousel form must not also set nativeFlowMessage')
})

test('HB-500: button icon is upper-cased into buttonParamsJson', async () => {
	const m = await generateWAMessageContent(
		{
			interactive: {
				body: { text: 'x' },
				buttons: [
					{ name: 'cta_url', buttonParamsJson: '{"display_text":"Buka","url":"https://example.com"}', icon: 'web' }
				]
			}
		},
		{}
	)
	const params = JSON.parse(m.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson)
	assert.equal(params.icon, 'WEB')
	assert.equal(params.display_text, 'Buka')
})

test('HB-500: { interactive: null } is rejected with Boom 400', async () => {
	await assert.rejects(generateWAMessageContent({ interactive: null }, {}), err => err?.output?.statusCode === 400)
})

test('HB-500: { a2ui } builds an interactiveMessage with a bloksWidget', async () => {
	const payload = { uuid: 'u-1', data: '{"version":"v1"}', type: 'im_a2ui' }
	const m = await generateWAMessageContent({ a2ui: payload, text: 'Halo' }, {})
	assert.ok(m.interactiveMessage, 'expected interactiveMessage')
	assert.equal(m.interactiveMessage.bloksWidget.data, payload.data)
	assert.equal(m.interactiveMessage.nativeFlowMessage.messageParamsJson, '')
	assert.equal(m.interactiveMessage.body.text, 'Halo')
	assert.equal(m.interactiveMessage.header.hasMediaAttachment, false)
	assert.equal(m.messageContextInfo.deviceListMetadataVersion, 2)
})

test('HB-500: { a2ui, singleScreen } drops the surrounding bubble', async () => {
	const payload = { uuid: 'u-2', data: '{"version":"v1"}', type: 'im_a2ui' }
	const m = await generateWAMessageContent({ a2ui: payload, singleScreen: true }, {})
	assert.ok(m.interactiveMessage.bloksWidget)
	assert.equal(m.interactiveMessage.header, undefined)
	assert.equal(m.interactiveMessage.body, undefined)
	assert.equal(m.interactiveMessage.footer, undefined)
})

test('HB-500: { a2ui: null } is rejected with Boom 400', async () => {
	await assert.rejects(generateWAMessageContent({ a2ui: null }, {}), err => err?.output?.statusCode === 400)
})

test('HB-500: interactiveAsTemplate wraps the interactiveMessage', async () => {
	const m = await generateWAMessageContent(
		{ interactive: { body: { text: 'Isi' } }, interactiveAsTemplate: true, templateId: 'tpl-1' },
		{}
	)
	assert.ok(m.templateMessage, 'expected templateMessage')
	assert.equal(m.templateMessage.templateId, 'tpl-1')
	assert.equal(m.templateMessage.interactiveMessageTemplate.body.text, 'Isi')
	assert.equal(m.messageContextInfo.deviceListMetadataVersion, 2)
})

test('HB-500: interactiveAsTemplate without an interactive message is Boom 400', async () => {
	await assert.rejects(
		generateWAMessageContent({ text: 'x', interactiveAsTemplate: true }, {}),
		err => err?.output?.statusCode === 400
	)
})

test('HB-500: shouldIncludeBizBinaryNode / getBizBinaryNode cover the biz classes', () => {
	assert.equal(shouldIncludeBizBinaryNode({ interactiveMessage: { nativeFlowMessage: {} } }), true)
	assert.equal(shouldIncludeBizBinaryNode({ listMessage: {} }), true)
	assert.equal(shouldIncludeBizBinaryNode({ templateMessage: {} }), true)
	assert.equal(shouldIncludeBizBinaryNode({ buttonsMessage: {} }), true)
	assert.equal(shouldIncludeBizBinaryNode({ conversation: 'x' }), false)

	const mixed = getBizBinaryNode({
		interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'quick_reply' }] } }
	})
	assert.equal(mixed.tag, 'biz')
	assert.ok(
		mixed.content.some(node => node.tag === 'interactive'),
		'expected the mixed native-flow child'
	)
	assert.ok(
		mixed.content.some(node => node.tag === 'quality_control'),
		'expected the quality_control child'
	)

	const flow = getBizBinaryNode({ interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'mpm' }] } } })
	const flowChild = flow.content.find(node => node.tag === 'interactive')
	assert.equal(flowChild.content[0].attrs.name, 'mpm')

	const list = getBizBinaryNode({ listMessage: {} })
	assert.equal(list.content[0].tag, 'list')

	const plain = getBizBinaryNode({ conversation: 'x' })
	assert.equal(plain.content.length, 1)
	assert.equal(plain.content[0].tag, 'quality_control')
})

test('HB-500: an interactive sendMessage stanza carries the <biz> node (text control does not)', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		await seedDevices(sock, [ME_USER, PEER_USER])
		await injectSessions(sock, [PEER, ME])
		await suppressTcTokenIssuance(sock, PEER)
		await sock.sendMessage(PEER, {
			interactive: {
				body: { text: 'Isi kartu' },
				buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'ya' }) }]
			}
		})
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.ok(getBinaryNodeChild(stanzas[0], 'biz'), 'interactive stanza must carry a <biz> node')

		frames.length = 0
		await sock.sendMessage(PEER, { text: 'kontrol-500' })
		const control = await messageStanzas(frames)
		assert.equal(control.length, 1)
		assert.equal(getBinaryNodeChild(control[0], 'biz'), undefined, 'plain text must not carry a <biz> node')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-502: relayMessage messageSecret parity (2.7.1) ---

test('HB-502: relayMessage stamps a messageSecret on a hand-built proto that lacks one', async () => {
	const { sock, frames } = await makeSendSocket()
	try {
		await seedDevices(sock, [ME_USER, PEER_USER])
		await injectSessions(sock, [PEER, ME])
		await suppressTcTokenIssuance(sock, PEER)
		const proto = {
			interactiveMessage: {
				body: { text: 'Kartu tangan' },
				nativeFlowMessage: {
					buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'ya' }) }],
					messageParamsJson: ''
				}
			},
			messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }
		}
		await sock.relayMessage(PEER, proto, {})
		assert.ok(proto.messageContextInfo.messageSecret, 'relay must stamp messageSecret')
		assert.equal(proto.messageContextInfo.messageSecret.length, 32)
		const stanzas = await messageStanzas(frames)
		assert.equal(stanzas.length, 1)
		assert.ok(getBinaryNodeChild(stanzas[0], 'biz'), 'hand-relayed interactive stanza must carry a <biz> node')

		// An existing secret is never overwritten.
		const existing = Buffer.alloc(32, 9)
		const proto2 = { conversation: 'teks', messageContextInfo: { messageSecret: existing } }
		await sock.relayMessage(PEER, proto2, {})
		assert.equal(proto2.messageContextInfo.messageSecret, existing)
	} finally {
		endQuietly(sock)
	}
})

test('HB-475: throwing userDevicesCache.get (no mget) falls back to the USync fetch', async () => {
	// Same read guard, single-get fallback path (cache without mget).
	const cache = {
		get: async () => { throw new Error('devices cache down (simulated)') },
		set: async () => {}
	}
	const { sock } = await makeSendSocket({ userDevicesCache: cache })
	try {
		answerAllIQs(sock, { jid: PEER, lid: PEER_LID })
		const devices = await sock.getUSyncDevices([PEER], true, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
	} finally {
		endQuietly(sock)
	}
})

test('HB-475: throwing userDevicesCache.mset does not fail the fetch (write is best-effort)', async () => {
	// mget misses, USync answers, the device list is in hand — a
	// throwing mset must not reject the fetch. Pre-fix the mset
	// throw escaped out of the devicesMutex block.
	const cache = {
		mget: async () => ({}),
		get: async () => undefined,
		set: async () => {},
		mset: async () => { throw new Error('devices cache down (simulated)') }
	}
	const { sock } = await makeSendSocket({ userDevicesCache: cache })
	try {
		answerAllIQs(sock, { jid: PEER, lid: PEER_LID })
		const devices = await sock.getUSyncDevices([PEER], true, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
	} finally {
		endQuietly(sock)
	}
})
