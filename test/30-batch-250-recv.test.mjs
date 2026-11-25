// Group B — batch 2.5.0: messages-recv / retry / decrypt regressions.
// HB-408, HB-418, HB-420 (+ addenda F1/F2/S1/S2/S3/A1/A2/A3, run-0695), HB-424,
// HB-437 (+ cache-op addendum), HB-442, HB-453, HB-472, HB-201 addendum 2,
// HB-386 faset 2, HB-2026-1112-39, and the CB:status <enc> routing delta.
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
//
// The three spec items (HB-405 + run-0909 C11, HB-425 MAIN, HB-261
// addendum 2) live in files outside Group B's allowlist: their tests
// are skipped-pending-spec and their exact patch specs are in
// ~/workspace/aunubaileys-tools/release-2.5.0/GROUP-B-REPORT.md.
// (HB-439 and the HB-425 run-0724 + chats.lock facets were already
// implemented in this batch's tree by other groups; their tests run.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { Curve, signedKeyPair, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { encodeBigEndian } from '../lib/Utils/generics.js'
import { generateWAMessageFromContent } from '../lib/Utils/messages.js'
import { RetryReason } from '../lib/Utils/message-retry-manager.js'
import { decodeDecompressedBinaryNode } from '../lib/WABinary/decode.js'
import * as binaryConstants from '../lib/WABinary/constants.js'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly } from './helpers.mjs'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const GROUP = '120363011111111@g.us'
const PEER = '628987654321@s.whatsapp.net'
const PEER_DEV = '628987654321:1@s.whatsapp.net'
const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const T = () => String(Math.floor(Date.now() / 1000))

// Trace-level capturing logger: sendNode logs every sent stanza's XML
// here (Socket/socket.ts), so receipts, resends, acks and IQs are
// classified from the plaintext XML instead of the Noise frames.
const makeCapturingLogger = () => {
	const xml = []
	const lines = []
	const logger = {
		level: 'trace',
		child() { return logger },
		trace(o) { if (typeof o?.xml === 'string') xml.push(o.xml) },
		debug(o, m) { lines.push(`debug: ${m || ''} ${JSON.stringify(o ?? '')}`) },
		info(o, m) { lines.push(`info: ${m || ''} ${JSON.stringify(o ?? '')}`) },
		warn(o, m) { lines.push(`warn: ${m || ''} ${JSON.stringify(o ?? '')}`) },
		error(o, m) { lines.push(`error: ${m || ''} ${JSON.stringify(o ?? '')}`) },
		fatal() {}
	}
	return { logger, xml, lines }
}

const makeSocket = async (extra = {}) => {
	const cap = makeCapturingLogger()
	const sock = await makeOfflineSocket({ logger: cap.logger, ...extra })
	sock.authState.creds.me = { id: ME, lid: ME_LID, name: 'T' }
	fakeOpenTransport(sock, [])
	return { sock, ...cap }
}

// A structurally valid account: the signature key/signature are
// random bytes (the receipt only encodes them; the peer verifies,
// the test only checks the shape) — but details must be a DECODABLE
// ADVDeviceIdentity. AunuBaileys (2.7.0, HB-201 addendum 4):
// sendRetryRequest validates decode-ability of
// creds.account.details before building a retry receipt, so random
// bytes here fail the guard and no receipt is sent at all (that
// rejection is locked by
// test/hb201-device-identity-decode.test.mjs). Tests that drive the
// receipt path must set a real account (HB-201 addendum 2, 2.5.0).
const syntheticAccount = () => ({
	details: Buffer.from(lib.proto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
	accountSignatureKey: randomBytes(32),
	accountSignature: randomBytes(64)
})

// Valid X3DH bundle for a receipt <keys> node (test/16 recipe).
const mintBundleNodes = () => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	const keysNode = {
		tag: 'keys',
		attrs: {},
		content: [
			{ tag: 'type', attrs: {}, content: Buffer.from([5]) },
			{ tag: 'identity', attrs: {}, content: Buffer.from(identity.public) },
			{
				tag: 'skey',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: encodeBigEndian(1, 3) },
					{ tag: 'value', attrs: {}, content: Buffer.from(signed.keyPair.public) },
					{ tag: 'signature', attrs: {}, content: Buffer.from(signed.signature) }
				]
			},
			{
				tag: 'key',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: encodeBigEndian(11, 3) },
					{ tag: 'value', attrs: {}, content: Buffer.from(pre.public) }
				]
			}
		]
	}
	const registrationNode = { tag: 'registration', attrs: {}, content: encodeBigEndian(1234, 4) }
	return { keysNode, registrationNode }
}

// A 1:1 session with PEER, minted from the peer's own bundle material
// (t0848 recipe) — enough for decrypt to reach the Bad MAC path.
const injectSession = async (sock, peer = PEER, registrationId = 1234) => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	await sock.signalRepository.injectE2ESession({ jid: peer, session: {
		registrationId, identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) } } })
}

const corruptEncMessage = (id, from, participant) => ({
	tag: 'message',
	attrs: { id, from, t: T(), ...(participant ? { participant } : {}) },
	content: [{ tag: 'enc', attrs: { type: 'msg', count: '0' }, content: randomBytes(48) }]
})

const retryReceipt = (id, from, participant, { withBundle = false, withRegistration = false, registrationId = 1234, count = '1', listIds = [] } = {}) => {
	const content = []
	if (listIds.length) {
		content.push({ tag: 'list', attrs: {}, content: listIds.map(listId => ({ tag: 'item', attrs: { id: listId } })) })
	}

	content.push({ tag: 'retry', attrs: { count, id, t: T(), v: '1' } })
	if (withBundle) {
		const { keysNode, registrationNode } = mintBundleNodes()
		content.push(keysNode)
		if (withRegistration) content.push(registrationNode)
	} else if (withRegistration) {
		content.push({ tag: 'registration', attrs: {}, content: encodeBigEndian(registrationId, 4) })
	}

	return { tag: 'receipt', attrs: { id, type: 'retry', from, participant, t: T() }, content }
}

const retryReceipts = xml => xml.filter(x => x.includes('<retry')).map(x => x.match(/<retry[^>]*>/)?.[0] || '')
const receiptError = xml => retryReceipts(xml).map(r => /error='(\d+)'/.exec(r)?.[1])
const countStarts = (xml, tag) => xml.filter(x => x.startsWith(`<${tag}`)).length
const encryptIqs = xml => xml.filter(x => x.startsWith('<iq') && x.includes("xmlns='encrypt'")).length
const hasAbortLog = lines => lines.some(l => l.includes('error in sending message again'))

// ── HB-408: generateWAMessageFromContent must reject a quote without quotable content ──

const boom400 = err => err?.output?.statusCode === 400

test('HB-408: quoting an SKDM-only message throws Boom 400 (was a silent 0-byte quote)', () => {
	assert.throws(
		() => generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
			quoted: {
				key: { remoteJid: GROUP, fromMe: false, id: '3EB040800001' },
				message: { senderKeyDistributionMessage: { groupId: GROUP, axolotlSenderKeyDistributionMessage: new Uint8Array([1, 2, 3]) } }
			},
			userJid: ME
		}),
		boom400
	)
})

test('HB-408: quoting a messageContextInfo-only message throws Boom 400 (was a silent 0-byte quote)', () => {
	assert.throws(
		() => generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
			quoted: {
				key: { remoteJid: GROUP, fromMe: false, id: '3EB040800002' },
				message: { messageContextInfo: { stanzaId: '3EB040800002', participant: PEER } }
			},
			userJid: ME
		}),
		boom400
	)
})

test('HB-408: quoting a message without content throws Boom 400 (was a raw TypeError)', () => {
	assert.throws(
		() => generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
			quoted: { key: { remoteJid: GROUP, fromMe: false, id: '3EB040800003' }, message: undefined },
			userJid: ME
		}),
		boom400
	)
})

test('HB-408: quoting without a key throws Boom 400 (was a raw TypeError on quoted.key.fromMe)', () => {
	assert.throws(
		() => generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
			quoted: { message: { conversation: 'hi' } },
			userJid: ME
		}),
		boom400
	)
})

test('HB-408: quoting a key without an id throws Boom 400 (was a dangling quote with stanzaId undefined)', () => {
	assert.throws(
		() => generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
			quoted: { key: { remoteJid: GROUP, fromMe: false }, message: { conversation: 'hi' } },
			userJid: ME
		}),
		boom400
	)
})

test('HB-408 control: quoting a real conversation still builds a non-empty quotedMessage', () => {
	const built = generateWAMessageFromContent(GROUP, { extendedTextMessage: { text: 'reply' } }, {
		quoted: {
			key: { remoteJid: GROUP, fromMe: false, id: '3EB040800006' },
			message: { conversation: 'hello quoted' }
		},
		userJid: ME
	})
	const quoted = built.message?.extendedTextMessage?.contextInfo?.quotedMessage
	assert.ok(quoted, 'quotedMessage present')
	assert.equal(quoted.conversation, 'hello quoted')
	assert.equal(built.message.extendedTextMessage.contextInfo.stanzaId, '3EB040800006')
})

// ── HB-420: sendMessagesAgain must not abort the whole batch on a pre-loop throw ──

test('HB-420 S1 + run-0695: garbage participant in a retry receipt still reaches the resend stage (was: whole batch aborted)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420S1001', { conversation: 'hello retry' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420S1001', GROUP, 'garbage-no-at-sign', { withBundle: true, withRegistration: true }))
		// A garbage participant has no device, so the group relay
		// cannot resolve a participant list offline and no resend
		// frame lands — the lock-in is the pre-loop itself: it must
		// complete ('prepared session') instead of aborting.
		const done = await waitFor(
			() => lines.some(l => l.includes('prepared session for retry resend')) || hasAbortLog(lines),
			15_000
		)
		assert.ok(done, 'pre-loop completed or aborted')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
		assert.equal(lines.some(l => l.includes('prepared session for retry resend')), true, 'pre-loop completed')
		// The ack follows only after the resend loop finishes (the
		// relay attempt times out on the group-metadata query offline).
		assert.equal(await waitFor(() => countStarts(xml, 'ack') >= 1, 15_000), true, 'the receipt was acked')
	} finally {
		endQuietly(sock)
	}
})

test('HB-420 S3: a throwing sender-key-memory reset still resends (was: whole batch aborted)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		const rawSet = sock.authState.keys.set.bind(sock.authState.keys)
		sock.authState.keys.set = async data => {
			if (data && Object.prototype.hasOwnProperty.call(data, 'sender-key-memory')) {
				throw new Error('SIMULATED-STORE-FAILURE sender-key-memory')
			}

			return rawSet(data)
		}
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420S3001', { conversation: 'hello retry' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420S3001', GROUP, PEER_DEV, { withBundle: true, withRegistration: true }))
		const done = await waitFor(() => countStarts(xml, 'message') >= 1 || hasAbortLog(lines), 15_000)
		assert.ok(done, 'resend or abort surfaced')
		assert.equal(countStarts(xml, 'message'), 1, 'the message was resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
	} finally {
		endQuietly(sock)
	}
})

test('HB-420 S2: a throwing getSessionInfo in the reg-id / base-key checks still resends (was: whole batch aborted)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		sock.signalRepository.getSessionInfo = async () => { throw new Error('SIMULATED-STORE-FAILURE getSessionInfo') }
		// The relay encrypts with the session below; without it the
		// resend could never land offline, so the fault would be
		// indistinguishable from a pre-loop abort.
		await injectSession(sock, PEER_DEV)
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420S2001', { conversation: 'hello retry' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420S2001', GROUP, PEER_DEV, { withRegistration: true }))
		const done = await waitFor(() => countStarts(xml, 'message') >= 1 || hasAbortLog(lines), 15_000)
		assert.ok(done, 'resend or abort surfaced')
		assert.equal(countStarts(xml, 'message'), 1, 'the message was resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
	} finally {
		endQuietly(sock)
	}
})

test('HB-420 A1/A2: a throwing deleteSession in the reg-id mismatch branch still resends (was: whole batch aborted)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		await injectSession(sock, PEER_DEV, 1234)
		const origDelete = sock.signalRepository.deleteSession.bind(sock.signalRepository)
		sock.signalRepository.deleteSession = async () => { throw new Error('SIMULATED-STORE-FAILURE deleteSession') }
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420A1001', { conversation: 'hello retry' })
		// Stored reg id is 1234; the receipt carries 9999 -> mismatch branch.
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420A1001', GROUP, PEER_DEV, { withRegistration: true, registrationId: 9999 }))
		const done = await waitFor(() => countStarts(xml, 'message') >= 1 || hasAbortLog(lines), 15_000)
		assert.ok(done, 'resend or abort surfaced')
		assert.equal(countStarts(xml, 'message'), 1, 'the message was resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
		void origDelete
	} finally {
		endQuietly(sock)
	}
})

test('HB-420 A3: a throwing force-assert still reaches the resend stage (was: whole batch aborted)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		// No session at all, no bundle: the force-assert fires, its
		// bundle query times out offline, and the throw must be
		// caught. The relay cannot encrypt without a session or a
		// bundle offline, so — like S1 — the lock-in is the
		// pre-loop completing instead of aborting.
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420A3001', { conversation: 'hello retry' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420A3001', GROUP, PEER_DEV))
		const done = await waitFor(
			() => lines.some(l => l.includes('prepared session for retry resend')) || hasAbortLog(lines),
			15_000
		)
		assert.ok(done, 'pre-loop completed or aborted')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
		assert.equal(lines.some(l => l.includes('prepared session for retry resend')), true, 'pre-loop completed')
		assert.equal(await waitFor(() => countStarts(xml, 'ack') >= 1, 15_000), true, 'the receipt was acked')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-420 F1/F2: the msgRetryCounterCache gate must not abort the batch ──

const makeFaultCache = mode => {
	const store = new Map()
	let setCalls = 0
	return {
		get: async key => {
			if (mode === 'get-throws') throw new Error('SIMULATED-CACHE-FAILURE get')
			return store.get(key)
		},
		set: async (key, value) => {
			setCalls++
			if (mode === 'set-throws-2nd' && setCalls === 2) throw new Error('SIMULATED-CACHE-FAILURE set#2')
			store.set(key, value)
		},
		del: async key => { store.delete(key) }
	}
}

test('HB-420 F1: a throwing retry-gate read in the receipt filter still resends both ids (was: 0 resends)', async () => {
	const { sock, xml, lines } = await makeSocket({ msgRetryCounterCache: makeFaultCache('get-throws') })
	try {
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420F100A', { conversation: 'hello retry A' })
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420F100B', { conversation: 'hello retry B' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420F100A', GROUP, PEER_DEV, { withBundle: true, withRegistration: true, listIds: ['3EB0420F100B'] }))
		await waitFor(() => countStarts(xml, 'ack') >= 1, 15_000).catch(() => false)
		await sleep(500)
		assert.equal(countStarts(xml, 'message'), 2, 'both ids were resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
	} finally {
		endQuietly(sock)
	}
})

test('HB-420 F2: a throwing retry-counter write in the resend loop still resends both ids (was: 1 resend)', async () => {
	const { sock, xml, lines } = await makeSocket({ msgRetryCounterCache: makeFaultCache('set-throws-2nd') })
	try {
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420F200A', { conversation: 'hello retry A' })
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB0420F200B', { conversation: 'hello retry B' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB0420F200A', GROUP, PEER_DEV, { withBundle: true, withRegistration: true, listIds: ['3EB0420F200B'] }))
		await waitFor(() => countStarts(xml, 'ack') >= 1, 15_000).catch(() => false)
		await sleep(500)
		assert.equal(countStarts(xml, 'message'), 2, 'both ids were resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-437: handleDevicesNotification must apply every user's delta ──

const devicesNode = (id, tag, devices) => ({
	tag: 'notification',
	attrs: { from: '9999999999@s.whatsapp.net', id, t: '1790000000', type: 'devices' },
	content: [{ tag, attrs: { device_hash: 'abc' }, content: devices.map(jid => ({ tag: 'device', attrs: { jid } })) }]
})

test('HB-437: a throwing deleteSession for user A still applies user B\'s remove (was: B skipped)', async () => {
	const { sock } = await makeSocket()
	try {
		const USER_A = '1111111111'
		const USER_B = '2222222222'
		await sock.userDevicesCache.set(USER_A, [{ user: USER_A, server: 's.whatsapp.net', device: 1 }])
		await sock.userDevicesCache.set(USER_B, [{ user: USER_B, server: 's.whatsapp.net', device: 1 }])
		const rawSet = sock.authState.keys.set.bind(sock.authState.keys)
		sock.authState.keys.set = async data => {
			if (data && typeof data === 'object' && 'session' in data) {
				throw new Error('store boom: session write failed')
			}

			return rawSet(data)
		}
		sock.ws.emit('CB:notification', devicesNode('T0437DEV', 'remove', [`${USER_A}:1@s.whatsapp.net`, `${USER_B}:1@s.whatsapp.net`]))
		// Each deleteSession resolves its transaction key over USync
		// (~800ms timeout offline), so both users take ~2s.
		await sleep(3000)
		assert.equal(await sock.userDevicesCache.get(USER_A), undefined, 'A delta applied')
		assert.equal(await sock.userDevicesCache.get(USER_B), undefined, 'B delta applied')
	} finally {
		endQuietly(sock)
	}
})

test('HB-437 cache-op addendum: a throwing userDevicesCache.get for user A still applies user B\'s add (was: B skipped)', async () => {
	const { sock } = await makeSocket()
	try {
		const USER_A = '1111111111'
		const USER_B = '2222222222'
		await sock.userDevicesCache.set(USER_A, [{ user: USER_A, server: 's.whatsapp.net', device: 1 }])
		await sock.userDevicesCache.set(USER_B, [{ user: USER_B, server: 's.whatsapp.net', device: 1 }])
		const cache = sock.userDevicesCache
		const origGet = cache.get.bind(cache)
		cache.get = async (...args) => {
			if (args[0] === USER_A) throw new Error('cache boom: userDevicesCache.get failed')
			return origGet(...args)
		}
		sock.ws.emit('CB:notification', devicesNode('T0437CACHE', 'add', [`${USER_A}:2@s.whatsapp.net`, `${USER_B}:2@s.whatsapp.net`]))
		await sleep(1500)
		cache.get = origGet
		const b = await sock.userDevicesCache.get(USER_B)
		assert.ok(Array.isArray(b) && b.some(d => d.device === 2), 'B got device 2')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-424: device 99 must never be offered to deleteSession ──

test('HB-424: a devices-remove listing device 99 never passes :99 to deleteSession', async () => {
	const { sock } = await makeSocket()
	try {
		const USER_A = '1111111111'
		const USER_B = '2222222222'
		await sock.userDevicesCache.set(USER_A, [{ user: USER_A, server: 's.whatsapp.net', device: 1 }])
		await sock.userDevicesCache.set(USER_B, [{ user: USER_B, server: 's.whatsapp.net', device: 1 }])
		const offered = []
		const origDelete = sock.signalRepository.deleteSession.bind(sock.signalRepository)
		sock.signalRepository.deleteSession = async jids => {
			offered.push(...jids)
			return origDelete(jids)
		}
		sock.ws.emit('CB:notification', devicesNode('T0424DEV', 'remove', [`${USER_A}:99@s.whatsapp.net`, `${USER_B}:1@s.whatsapp.net`]))
		await sleep(3000)
		assert.equal(offered.some(j => j.includes(':99')), false, 'no :99 JID was offered')
		assert.equal(await sock.userDevicesCache.get(USER_B), undefined, 'B delta still applied')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-442: mex linked-profiles updates must be stored before they are emitted ──

const mexNode = id => ({
	tag: 'notification',
	attrs: { from: 's.whatsapp.net', id, t: '1790000000', type: 'mex' },
	content: [{
		tag: 'update',
		attrs: { op_name: 'NotificationLinkedProfilesUpdates' },
		content: Buffer.from(JSON.stringify({
			data: { xwa2_notify_linked_profiles: { jid: '111111111111@lid', added_profiles: [] } },
			operation: 'NotificationLinkedProfilesUpdates',
			updates: [
				{ jid: '111111111111@lid', added_profiles: [{ pn: '6281111111111@s.whatsapp.net' }] },
				{ jid: '222222222222@lid', added_profiles: [{ pn: '6282222222222@s.whatsapp.net' }] }
			]
		}))
	}]
})

test('HB-442: a throwing store for update #1 still stores and emits update #2 (was: loop aborted, #1 emitted but never persisted)', async () => {
	const { sock } = await makeSocket()
	try {
		const emitted = []
		sock.ev.on('lid-mapping.update', m => emitted.push(m))
		const lm = sock.signalRepository.lidMapping
		const innerKeys = lm.keys
		const origGet = innerKeys.get.bind(innerKeys)
		let getCalls = 0
		innerKeys.get = async (...args) => {
			getCalls++
			if (getCalls === 1) throw new Error('store boom: keys.get(lid-mapping) failed')
			return origGet(...args)
		}
		sock.ws.emit('CB:notification', mexNode('T0442MEX'))
		await sleep(3000)
		innerKeys.get = origGet
		const storedOrNull = async pn => {
			try { return await lm.getLIDForPN(pn) } catch { return null }
		}
		assert.equal(await storedOrNull('6281111111111@s.whatsapp.net'), null, 'mapping #1 not stored')
		assert.equal(await storedOrNull('6282222222222@s.whatsapp.net'), '222222222222@lid', 'mapping #2 stored')
		// The emit path is flushed through the event buffer; when it
		// survives, it must never carry the unpersisted mapping #1.
		if (emitted.length > 0) {
			assert.equal(emitted.some(m => m.pn === '6281111111111@s.whatsapp.net'), false, 'mapping #1 never emitted')
			assert.equal(emitted.some(m => m.pn === '6282222222222@s.whatsapp.net'), true, 'mapping #2 emitted')
		}
	} finally {
		endQuietly(sock)
	}
})

// ── HB-453: the retry receipt must carry the real failure class ──

test('HB-453: a Bad MAC on an existing session sends error=7 (was: literal error=0)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		sock.authState.creds.account = syntheticAccount()
		await injectSession(sock)
		const failEvents = []
		const upserts = []
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ev.on('messages.upsert', ({ messages }) => upserts.push(...messages))
		sock.ws.emit('CB:message', corruptEncMessage('3EB045300001', PEER))
		const done = await waitFor(() => failEvents.length > 0 && retryReceipts(xml).length > 0, 15_000)
		assert.ok(done, 'decrypt-failure fired and the retry receipt was sent')
		// The stub upsert is held by the socket event buffer until a
		// flush (the offline socket never flushes on its own — the
		// t0695 harness flushes manually for the same reason).
		sock.ev.flush?.()
		assert.equal(await waitFor(() => upserts.some(m => m.key?.id === '3EB045300001'), 10_000), true, 'the stub was upserted')
		// libsignal's aggregate text is the only Bad MAC signal the
		// wire gives us on an existing session (the literal 'Bad
		// MAC' never reaches the thrown error) — the session probe
		// must resolve it to 7, not 1.
		const stub = upserts.find(m => m.key?.id === '3EB045300001')
		assert.deepEqual(stub?.messageStubParameters, ['No matching sessions found for message'])
		assert.deepEqual(receiptError(xml), ['7'])
		assert.equal(lines.some(l => l.includes('Failed to send retry')), false, 'receipt sent cleanly')
	} finally {
		endQuietly(sock)
	}
})

test('HB-453: a decrypt failure with no session at all sends error=1 (was: literal error=0)', async () => {
	const { sock, xml } = await makeSocket()
	try {
		sock.authState.creds.account = syntheticAccount()
		const failEvents = []
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ws.emit('CB:message', corruptEncMessage('3EB045300002', PEER))
		const done = await waitFor(() => failEvents.length > 0 && retryReceipts(xml).length > 0, 10_000)
		assert.ok(done, 'decrypt-failure fired and the retry receipt was sent')
		assert.deepEqual(receiptError(xml), ['1'])
	} finally {
		endQuietly(sock)
	}
})

// ── HB-201 addendum 2: sendRetryRequest must validate creds.account ──

test('HB-2026-1112-39: with no retry manager, a second retry is not held up by the first retry\'s 2s placeholder wait (was: retryMutex held ~2s per first retry)', async () => {
	// enableRecentMessageCache: false -> messageRetryManager is null
	// -> sendRetryRequest takes the fallback branch.
	const { sock, xml } = await makeSocket({ enableRecentMessageCache: false })
	try {
		sock.authState.creds.account = syntheticAccount()
		await injectSession(sock)
		// Seed the PN->LID mapping so neither retry burns ~4s on
		// USync LID resolution inside the mutex — the gap between
		// the two receipts must measure the placeholder wait, not
		// the LID lookups. The error class is irrelevant here.
		await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: '100000098765432@lid', pn: PEER }])
		const receiptTimes = []
		const syncReceiptTimes = () => {
			const n = retryReceipts(xml).length
			while (receiptTimes.length < n) receiptTimes.push(Date.now())
		}
		const watch = setInterval(syncReceiptTimes, 10)
		try {
			sock.ws.emit('CB:message', corruptEncMessage('3EB011239001', PEER))
			sock.ws.emit('CB:message', corruptEncMessage('3EB011239002', PEER))
			const done = await waitFor(() => retryReceipts(xml).length >= 2, 20_000)
			assert.ok(done, 'both retry receipts were sent')
			syncReceiptTimes()
			assert.equal(receiptTimes.length, 2, 'both receipt times were captured')
			const gapMs = receiptTimes[1] - receiptTimes[0]
			// Pre-fix the gap is the 2s placeholder delay plus the
			// 250ms retryRequestDelayMs (~2.3s+); post-fix only the
			// 250ms delay plus the send itself remains.
			assert.ok(gapMs < 1500, `second receipt followed the first by ${gapMs}ms (must be < 1500ms)`)
		} finally {
			clearInterval(watch)
		}
	} finally {
		endQuietly(sock)
	}
})

// ── HB-418: a failed PDO send must not poison the placeholder-resend dedupe ──

// The PDO is a `message` stanza to our own JID (category peer). The
// transport hands us Noise-framed bytes, so decode synchronously:
// strip the 3-byte length prefix, then the flags byte the same way
// decompressingIfRequired does for uncompressed nodes. Undecodable
// frames (including the never-compressed-outgoing case) are not PDOs
// — never let a probe throw here.
const decodeFrameSync = data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	const payload = buf.subarray(off + 3, off + 3 + len)
	if (payload[0] !== 0) throw new Error('compressed frame, cannot decode sync')
	return decodeDecompressedBinaryNode(payload.subarray(1), binaryConstants)
}
const isPdoFrame = data => {
	try {
		const node = decodeFrameSync(data)
		return node?.tag === 'message' && node?.attrs?.category === 'peer' && node?.attrs?.to === ME
	} catch {
		return false
	}
}

test('HB-418: a PDO send that throws must not poison the dedupe entry — the next redelivery re-requests the placeholder resend (was: entry kept, second request silently skipped until the 1h TTL)', async () => {
	const { sock, xml } = await makeSocket({ enableRecentMessageCache: false })
	try {
		sock.authState.creds.account = syntheticAccount()
		await injectSession(sock)
		// AunuBaileys (2.7.0, HB-299 addendum + facet 2): a PDO
		// self-send from a phone session (device 0) has no recipient
		// left once the sender device is partitioned out, and now
		// rejects with Boom 400 instead of resolving with an empty
		// stanza (locked by
		// test/hb299-phone-self-send-no-recipients.test.mjs). The PDO
		// below must reach the transport, so this socket is a
		// companion (device 42) asking the phone (device 0), with a
		// session for the phone injected so the PDO can be encrypted
		// (test/23 recipe).
		sock.authState.creds.me = { id: '628123456789:42@s.whatsapp.net', lid: ME_LID, name: 'T' }
		await injectSession(sock, ME)
		await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: '100000098765432@lid', pn: PEER }])
		// Fail exactly the first PDO frame (a transient transport
		// failure, 'Connection Closed'); every other stanza goes
		// out normally.
		const fake = sock.ws.socket
		const origSend = fake.send.bind(fake)
		let pdoAttempts = 0
		let pdoSent = 0
		fake.send = (data, cb) => {
			if (isPdoFrame(data)) {
				pdoAttempts++
				if (pdoAttempts === 1) throw new Error('Connection Closed')
				pdoSent++
			}
			return origSend(data, cb)
		}
		const MSG_ID = '3EB041800001'
		sock.ws.emit('CB:message', corruptEncMessage(MSG_ID, PEER))
		// The first placeholder attempt takes its 2s delay before
		// the PDO reaches the transport and throws; wait for that
		// throw, then let the failure handling (entry delete) settle.
		const firstAttempted = await waitFor(() => pdoAttempts >= 1, 10_000)
		assert.ok(firstAttempted, 'first PDO send was attempted')
		await sleep(500)
		// The peer resends the same undecryptable message; the
		// placeholder resend must be requested again.
		sock.ws.emit('CB:message', corruptEncMessage(MSG_ID, PEER))
		const resent = await waitFor(() => pdoSent >= 1, 15_000)
		assert.ok(resent, 'second PDO send went out after the failed first attempt')
		assert.equal(pdoAttempts, 2, 'exactly two PDO attempts (one failed, one sent)')
		assert.equal(retryReceipts(xml).length, 2, 'both retry receipts went out')
	} finally {
		endQuietly(sock)
	}
})

test('HB-201 addendum 2: a missing creds.account blocks the retry receipt (was: sent with a 0-byte device-identity)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		// No account on purpose: makeAuthState never sets one.
		assert.equal(sock.authState.creds.account, undefined)
		const failEvents = []
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ws.emit('CB:message', corruptEncMessage('3EB020100001', PEER))
		const done = await waitFor(() => failEvents.length > 0, 10_000)
		assert.ok(done, 'decrypt-failure fired (the flow reached the retry step)')
		await sleep(1000)
		assert.equal(retryReceipts(xml).length, 0, 'no retry receipt was sent')
		assert.equal(lines.some(l => l.includes('Failed to send retry')), true, 'the validation throw was reported')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-386 faset 2: creds.update must fire only after the receipt transaction commits ──

test('HB-386 faset 2: a failing sendNode does not emit creds.update (was: emitted inside the transaction, burning a pre-key id)', async () => {
	const { sock } = await makeSocket()
	try {
		sock.authState.creds.account = syntheticAccount()
		await injectSession(sock)
		const emitted = []
		sock.ev.on('creds.update', u => emitted.push(u))
		// Next retry for this id is count 2, so the receipt carries
		// keys and the pre-key update is staged inside the transaction.
		sock.messageRetryManager.incrementRetryCount('3EB038600001')
		const before = sock.authState.creds.nextPreKeyId
		// Fail exactly the first send (the receipt); the ack after it
		// must still go out normally.
		const fake = sock.ws.socket
		const origSend = fake.send.bind(fake)
		let sends = 0
		fake.send = (data, cb) => {
			sends++
			if (sends === 1) throw new Error('transport boom')
			return origSend(data, cb)
		}
		const failEvents = []
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ws.emit('CB:message', corruptEncMessage('3EB038600001', PEER))
		await waitFor(() => failEvents.length > 0, 10_000)
		await sleep(1500)
		assert.equal(emitted.length, 0, 'no creds.update was emitted for the failed receipt')
		assert.equal(sock.authState.creds.nextPreKeyId, before, 'no pre-key id was burned in live creds')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-472: a bundless retry receipt must not force-assert (and close) a healthy session ──

test('HB-472: a bundless retry receipt with a healthy session sends no bundle fetch and still resends (was: force assert closed the session)', async () => {
	const { sock, xml, lines } = await makeSocket()
	try {
		await injectSession(sock, PEER_DEV)
		sock.messageRetryManager.addRecentMessage(GROUP, '3EB047200001', { conversation: 'hello retry' })
		sock.ws.emit('CB:receipt', retryReceipt('3EB047200001', GROUP, PEER_DEV))
		const done = await waitFor(() => countStarts(xml, 'message') >= 1 || hasAbortLog(lines), 15_000)
		assert.ok(done, 'resend or abort surfaced')
		assert.equal(encryptIqs(xml), 0, 'no bundle fetch was sent for the healthy session')
		assert.equal(countStarts(xml, 'message'), 1, 'the message was resent')
		assert.equal(countStarts(xml, 'ack'), 1, 'the receipt was acked')
		assert.equal(hasAbortLog(lines), false, 'no batch-abort error')
	} finally {
		endQuietly(sock)
	}
})

// ── CB:status <enc> routing delta ──

test('CB:status delta: an <enc> status from a group reaches handleMessage (was: swallowed as content:null newsletter status)', async () => {
	const { sock, xml } = await makeSocket()
	try {
		sock.authState.creds.account = syntheticAccount()
		const failEvents = []
		const newsletter = []
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ev.on('newsletter.status', s => newsletter.push(s))
		sock.ws.emit('CB:status', {
			tag: 'status',
			attrs: { from: GROUP, id: '3EB0CB000001', t: T(), participant: PEER },
			content: [{ tag: 'enc', attrs: { type: 'msg', count: '0' }, content: randomBytes(48) }]
		})
		const done = await waitFor(() => failEvents.length > 0 && retryReceipts(xml).length > 0, 15_000)
		assert.ok(done, 'the stanza was handled and the retry receipt was sent')
		assert.equal(failEvents.length, 1, 'decrypt was attempted (handleMessage routing)')
		assert.equal(newsletter.length, 0, 'not treated as a newsletter status')
		assert.equal(retryReceipts(xml).length, 1, 'a retry receipt was sent for it')
	} finally {
		endQuietly(sock)
	}
})

test('CB:status delta control: a plaintext newsletter status still emits newsletter.status', async () => {
	const { sock } = await makeSocket()
	try {
		const newsletter = []
		const failEvents = []
		sock.ev.on('newsletter.status', s => newsletter.push(s))
		sock.ev.on('messages.decrypt-failure', p => failEvents.push(p))
		sock.ws.emit('CB:status', {
			tag: 'status',
			attrs: { from: '120363123456789@newsletter', id: '3EB0CB000002', t: T(), type: 'text' },
			content: []
		})
		const done = await waitFor(() => newsletter.length > 0, 10_000)
		assert.ok(done, 'newsletter.status fired')
		assert.equal(failEvents.length, 0, 'no decrypt attempted')
	} finally {
		endQuietly(sock)
	}
})

// ── Spec items: files outside Group B's allowlist — skipped pending the coordinator's patch ──
// Exact patch specs live in ~/workspace/aunubaileys-tools/release-2.5.0/GROUP-B-REPORT.md.

test('HB-405 (spec, revised — GROUP-B SPEC 1 conflicted with HB-380, see FIX-REPORT): the MAC throttle is NOT in shouldRecreateSession (HB-380: MAC stays immediate); the throttle is the hasRecentSessionRecreate gate consulted only for peer-supplied codes in sendMessagesAgain', async () => {
	const { sock } = await makeSocket()
	try {
		const addr = await sock.signalRepository.jidToSignalProtocolAddress(PEER)
		// No recreate yet: the gate is open.
		assert.equal(sock.messageRetryManager.hasRecentSessionRecreate(addr), false, 'no recreate recorded yet')
		// Our own MAC failure recreates immediately (HB-380) — and
		// a second one right after still does: the manager never
		// throttles MAC.
		const first = sock.messageRetryManager.shouldRecreateSession(addr, true, RetryReason.SignalErrorBadMac)
		assert.equal(first.recreate, true, 'first MAC failure recreates immediately')
		assert.equal(sock.messageRetryManager.hasRecentSessionRecreate(addr), true, 'the recreate is recorded for the peer gate')
		const second = sock.messageRetryManager.shouldRecreateSession(addr, true, RetryReason.SignalErrorBadMac)
		assert.equal(second.recreate, true, 'a MAC error is always immediate, even inside the window (HB-380)')
		// An untouched peer stays open.
		const other = await sock.signalRepository.jidToSignalProtocolAddress('628111222333@s.whatsapp.net')
		assert.equal(sock.messageRetryManager.hasRecentSessionRecreate(other), false, 'another peer is unaffected')
	} finally {
		endQuietly(sock)
	}
})

test('HB-405 C11 (spec): parseRetryErrorCode rejects partial parses like "7abc"', async () => {
	const { sock } = await makeSocket()
	try {
		assert.equal(sock.messageRetryManager.parseRetryErrorCode('7abc'), undefined, '"7abc" is not a clean code')
		assert.equal(sock.messageRetryManager.parseRetryErrorCode('7'), RetryReason.SignalErrorBadMac, '"7" still parses')
	} finally {
		endQuietly(sock)
	}
})

test('HB-425 addenda (already in tree): group-participants.update / group.join-request / chats.lock are buffered with the rest', async () => {
	const { sock } = await makeSocket()
	try {
		const seen = []
		sock.ev.on('group-participants.update', g => seen.push(['group-participants.update', g]))
		sock.ev.on('group.join-request', g => seen.push(['group.join-request', g]))
		sock.ev.on('chats.lock', c => seen.push(['chats.lock', c]))
		sock.ev.buffer()
		sock.ev.emit('group-participants.update', { id: GROUP, author: PEER, participants: [{ id: PEER }], action: 'add' })
		sock.ev.emit('group.join-request', { id: GROUP, author: PEER, participant: PEER, action: 'created', method: 'invite_link' })
		sock.ev.emit('chats.lock', { id: GROUP, locked: true })
		assert.equal(seen.length, 0, 'nothing delivered while buffered')
		sock.ev.flush()
		assert.deepEqual(seen.map(([name]) => name), ['group-participants.update', 'group.join-request', 'chats.lock'], 'all three delivered on flush, in arrival order')
	} finally {
		endQuietly(sock)
	}
})

test('HB-425 MAIN (spec): groups.upsert is buffered with the rest', async () => {
	const { sock } = await makeSocket()
	try {
		const seen = []
		sock.ev.on('groups.upsert', g => seen.push(['groups.upsert', g]))
		sock.ev.buffer()
		sock.ev.emit('groups.upsert', [{ id: GROUP, subject: 'Buffered' }])
		assert.equal(seen.length, 0, 'nothing delivered while buffered')
		sock.ev.flush()
		assert.equal(seen.length, 1, 'delivered on flush')
	} finally {
		endQuietly(sock)
	}
})

test('HB-439 (already in tree): a USync timeout with a warm cache throws Boom 408 instead of sending to cache hits only', async () => {
	const { sock } = await makeSocket()
	try {
		// Warm cache for PEER only; PEER2 is cold, so the USync
		// query must run for it — and never answers offline.
		// AunuBaileys (2.7.0, HB-489): the device cache is keyed by
		// the normalised JID (user + server), not the bare user.
		await sock.userDevicesCache.set('628987654321@s.whatsapp.net', [{ user: '628987654321', server: 's.whatsapp.net', device: 0 }])
		await assert.rejects(
			() => sock.getUSyncDevices([PEER, '628111111111@s.whatsapp.net'], true, false),
			err => err?.output?.statusCode === 408
		)
		// Control: both cached -> no fetch, no throw, both returned.
		await sock.userDevicesCache.set('628111111111@s.whatsapp.net', [{ user: '628111111111', server: 's.whatsapp.net', device: 0 }])
		const devices = await sock.getUSyncDevices([PEER, '628111111111@s.whatsapp.net'], true, false)
		assert.equal(devices.length, 2, 'both cached devices returned')
	} finally {
		endQuietly(sock)
	}
})

test('HB-261 addendum 2 (spec): a failing getCallLink still sends the event, without joinLink', async () => {
	const content = await lib.generateWAMessageContent(
		{ event: { name: 'Test Event', description: 'call link lookup fails', startDate: new Date(), call: true } },
		{
			jid: GROUP,
			userJid: ME,
			getCallLink: async () => { throw new Error('call/link_create IQ failed') }
		}
	)
	assert.ok(content.eventMessage, 'event content built')
	assert.equal(content.eventMessage.joinLink, undefined, 'no bogus joinLink')
})
