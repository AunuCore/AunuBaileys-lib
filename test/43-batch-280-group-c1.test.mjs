// AunuBaileys 2.8.0 batch regressions — GROUP C part 1:
// HB-141 addendum 1 (decodeSyncdMutations index deref outside try),
// HB-191 addendum faset 2 (end() pairing rollback deletes a
// pre-existing me instead of restoring the snapshot), HB-208
// addendum (toProductNode null price/isHidden), HB-253 addenda
// (empty interactive / poll / text manufactured), HB-325 addenda
// (raw TypeErrors from non-string host input in
// generateWAMessageContent / generateWAMessageFromContent),
// HB-334 addendum faset 2 (sendReceipt else-branch without `to`),
// HB-410 addendum faset 4 (injectE2ESession NaN/float SPK keyId),
// HB-405 addendum (retry-receipt deletes bypass the throttle),
// HB-482 addendum (getMediaKeys data-URL regex case-sensitive).
// Each test names the HB item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Crypto from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly, tmpDir } from './helpers.mjs'
import { waproto } from '../WAProto/index.js'
import { decodeSyncdMutations, newLTHashState } from '../lib/Utils/chat-utils.js'
import { aesEncrypt, hmacSign, Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { expandAppStateKeys } from 'whatsapp-rust-bridge'
import { toProductNode } from '../lib/Utils/business.js'
import { generateWAMessageContent, generateWAMessageFromContent } from '../lib/Utils/messages.js'
import { getMediaKeys } from '../lib/Utils/messages-media.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { MessageRetryManager } from '../lib/Utils/message-retry-manager.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

// Capture the REAL connect before stubbing — the HB-191 harness
// below runs a local fake WA server and needs a real WebSocket.
const REAL_WS_CONNECT = WebSocketClient.prototype.connect
WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'

const boom400 = part => err =>
	!!err && err.output?.statusCode === 400 && (part === undefined || String(err.message).includes(part))

// --- HB-141 addendum 1: decodeSyncdMutations per-record isolation ---

const MY_KEY_ID = Buffer.from(Crypto.randomBytes(16)).toString('base64')
const APP_STATE_KEY = {
	keyData: Crypto.randomBytes(32),
	fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
	timestamp: Date.now()
}
const getAppStateSyncKey = async keyId => (keyId === MY_KEY_ID ? APP_STATE_KEY : null)

const buildRecord = indexBytes => {
	const keys = expandAppStateKeys(APP_STATE_KEY.keyData)
	const syncActionBytes = waproto.SyncActionData.encode({ index: indexBytes }).finish()
	const encContent = aesEncrypt(syncActionBytes, keys.valueEncryptionKey)
	const keyIdBytes = Buffer.from(MY_KEY_ID, 'base64')
	// value MAC is not consulted with validateMacs=false; any 32 bytes do
	const mac = Crypto.randomBytes(32)
	return {
		keyId: { id: keyIdBytes },
		value: { blob: Buffer.concat([encContent, mac]) },
		index: { blob: hmacSign(indexBytes, keys.indexKey) }
	}
}

const goodIndex = ['conversation', 'jid-good', 'archive']
const goodIndexBytes = Buffer.from(JSON.stringify(goodIndex))

test('HB-141 addendum 1: a record without an index blob is skipped (validateMacs off), the good record still applies', async () => {
	const noIndex = buildRecord(goodIndexBytes)
	delete noIndex.index
	const good = buildRecord(goodIndexBytes)
	const seen = []
	const result = await decodeSyncdMutations(
		[noIndex, good], newLTHashState(), getAppStateSyncKey, m => seen.push(m.index), false
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on a record without an index blob')
	assert.deepEqual(seen, [goodIndex])
})

test('HB-141 addendum 1: a record without a value blob is skipped, the good record still applies', async () => {
	const noValue = buildRecord(goodIndexBytes)
	delete noValue.value
	const good = buildRecord(goodIndexBytes)
	const seen = []
	const result = await decodeSyncdMutations(
		[noValue, good], newLTHashState(), getAppStateSyncKey, m => seen.push(m.index), false
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on a record without a value blob')
	assert.deepEqual(seen, [goodIndex])
})

// --- HB-208 addendum: toProductNode null price / isHidden ---

test('HB-208 addendum: toProductNode treats a null price and null isHidden like undefined', () => {
	const node = toProductNode('123456', { name: 'Thing', price: null, currency: 'IDR', isHidden: null })
	assert.ok(node, 'no node produced')
	assert.ok(!node.content.some(n => n.tag === 'price'), 'a price node was emitted for a null price')
	assert.equal(node.attrs.is_hidden, undefined, 'is_hidden attr was emitted for a null isHidden')
	const control = toProductNode('123456', { name: 'Thing', price: 1000, currency: 'IDR', isHidden: true })
	assert.ok(control.content.some(n => n.tag === 'price'), 'control: price node missing')
	assert.equal(control.attrs.is_hidden, 'true', 'control: is_hidden missing')
})

// --- HB-253 addenda: empty interactive / poll / text ---

test('HB-253 addendum (a): { interactive: {} } is rejected with Boom 400', async () => {
	await assert.rejects(() => generateWAMessageContent({ interactive: {} }, {}), boom400('interactive requires'))
})

test('HB-253 addendum (b): { poll: { values: [] } } is rejected with Boom 400', async () => {
	await assert.rejects(
		() => generateWAMessageContent({ poll: { name: 'P?', values: [] } }, {}),
		boom400('at least one value')
	)
})

test('HB-253 addendum (c): { text: "" } is rejected with Boom 400', async () => {
	await assert.rejects(() => generateWAMessageContent({ text: '' }, {}), boom400('must not be empty'))
	const control = await generateWAMessageContent({ text: 'hi' }, {})
	assert.equal(control.extendedTextMessage.text, 'hi', 'control: plain text must still build')
})

// --- HB-325 addenda: non-string host input must be Boom 400 ---

test('HB-325 addendum (a): a non-string text is rejected with Boom 400, not a raw TypeError', async () => {
	await assert.rejects(() => generateWAMessageContent({ text: 42 }, {}), boom400('text must be a string'))
})

test('HB-325 addendum (b): a non-array contacts list is rejected with Boom 400', async () => {
	await assert.rejects(
		() => generateWAMessageContent({ contacts: { displayName: 'X', contacts: 'not-an-array' } }, {}),
		boom400('contacts.contacts must be an array')
	)
	await assert.rejects(() => generateWAMessageContent({ contacts: 'nope' }, {}), boom400('contacts.contacts'))
})

test('HB-325 addendum (c): a non-widget a2ui value is rejected with Boom 400, not a raw TypeError', async () => {
	await assert.rejects(() => generateWAMessageContent({ a2ui: { nope: 1 } }, {}), boom400('a2ui must be'))
	const payload = { uuid: 'u-c1', data: '{"version":"v1"}', type: 'im_a2ui' }
	const control = await generateWAMessageContent({ a2ui: payload, singleScreen: true }, {})
	assert.ok(control.interactiveMessage.bloksWidget, 'control: a valid widget payload must still build')
})

test('HB-325 addendum (d)+(g): poll with a non-string value element or non-string name is rejected with Boom 400', async () => {
	await assert.rejects(
		() => generateWAMessageContent({ poll: { name: 'P?', values: ['a', 42] } }, {}),
		boom400('poll values must be strings')
	)
	await assert.rejects(
		() => generateWAMessageContent({ poll: { name: 42, values: ['a'] } }, {}),
		boom400('poll.name must be a string')
	)
	const control = await generateWAMessageContent({ poll: { name: 'P?', values: ['a', 'b'] } }, {})
	assert.ok(control.pollCreationMessage, 'control: a valid poll must still build')
})

test('HB-325 addendum (e): interactive with non-array buttons/carousel or a null button entry is rejected with Boom 400', async () => {
	await assert.rejects(
		() => generateWAMessageContent({ interactive: { text: 'x', buttons: 'nope' } }, {}),
		boom400('buttons must be an array')
	)
	await assert.rejects(
		() => generateWAMessageContent({ interactive: { text: 'x', buttons: [null] } }, {}),
		boom400('entries must be objects')
	)
	await assert.rejects(
		() => generateWAMessageContent({ interactive: { text: 'x', carousel: 'nope' } }, {}),
		boom400('carousel must be an array')
	)
	await assert.rejects(
		() => generateWAMessageContent({ interactive: { carousel: [{ title: 'K', body: 'B', buttons: [null] }] } }, {}),
		boom400('entries must be objects')
	)
})

test('HB-325 addendum (f): a non-string mentions element is rejected with Boom 400', async () => {
	await assert.rejects(
		() => generateWAMessageContent({ text: 'hi', mentions: [PEER, 42] }, {}),
		boom400('mentions must be an array')
	)
	const control = await generateWAMessageContent({ text: 'hi', mentions: [PEER] }, {})
	assert.deepEqual(control.extendedTextMessage.contextInfo.mentionedJid, [PEER], 'control: valid mentions must still apply')
})

test('HB-325 addendum (h): a quoted key with a non-string id or remoteJid is rejected with Boom 400', async () => {
	const content = { extendedTextMessage: { text: 'hi' } }
	// generateWAMessageFromContent is synchronous — assert.throws
	assert.throws(
		() =>
			generateWAMessageFromContent(PEER, content, {
				quoted: { key: { id: 123, remoteJid: PEER }, message: { conversation: 'x' } },
				userJid: ME
			}),
		boom400('non-string key id')
	)
	assert.throws(
		() =>
			generateWAMessageFromContent(PEER, content, {
				quoted: { key: { id: 'ABC123', remoteJid: 123 }, message: { conversation: 'x' } },
				userJid: ME
			}),
		boom400('non-string key remoteJid')
	)
	const control = generateWAMessageFromContent(PEER, content, {
		quoted: { key: { id: 'ABC123', remoteJid: PEER }, message: { conversation: 'x' } },
		userJid: ME
	})
	assert.equal(control.message.extendedTextMessage.contextInfo.stanzaId, 'ABC123', 'control: a valid quote must still build')
})

// --- HB-334 addendum faset 2: sendReceipt else-branch without `to` ---

test('HB-334 addendum faset 2: sendReceipt with an undefined jid (non-sender type) rejects Boom 400', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	try {
		await assert.rejects(() => sock.sendReceipt(undefined, undefined, ['3EB0C1334F2'], 'read'), boom400('missing jid'))
		await sock.sendReceipt(PEER, undefined, ['3EB0C1334F2'], 'read')
	} finally {
		endQuietly(sock)
	}
})

// --- HB-410 addendum faset 4: injectE2ESession SPK keyId integer ---

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state }
}

const bundleFor = spkKeyId => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: spkKeyId, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
	}
}

test('HB-410 addendum faset 4: injectE2ESession rejects a NaN or float signedPreKey.keyId with Boom 400', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-c1-410-'))
	try {
		await assert.rejects(() => repo.injectE2ESession({ jid: PEER, session: bundleFor(NaN) }), boom400())
		await assert.rejects(() => repo.injectE2ESession({ jid: PEER, session: bundleFor(1.5) }), boom400())
		assert.equal(await repo.getSessionInfo(PEER), null, 'no phantom session may be stored for a bad keyId')
		await repo.injectE2ESession({ jid: PEER, session: bundleFor(1) })
		assert.ok(await repo.getSessionInfo(PEER), 'control: an integer keyId must still inject')
	} finally {
		repo.close()
	}
})

// --- HB-405 addendum: throttle accounting for out-of-band deletes ---

test('HB-405 addendum: noteSessionRecreate feeds the throttle consulted by the retry-receipt branches', () => {
	const mgr = new MessageRetryManager(silentLogger, 5)
	try {
		assert.equal(mgr.hasRecentSessionRecreate(PEER), false, 'no recreation recorded yet')
		assert.equal(typeof mgr.noteSessionRecreate, 'function', 'the manager must expose the recording hook')
		mgr.noteSessionRecreate(PEER)
		assert.equal(
			mgr.hasRecentSessionRecreate(PEER),
			true,
			'a delete recorded via noteSessionRecreate must trip hasRecentSessionRecreate (the reg-id / base-key branches consult it)'
		)
	} finally {
		mgr.close()
	}
})

// --- HB-482 addendum: getMediaKeys data-URL prefix case ---

test('HB-482 addendum: getMediaKeys strips an uppercase DATA:...;BASE64, prefix like the lowercase form', async () => {
	const raw = Buffer.from('aunu-hb482-case-seed-material')
	const b64 = raw.toString('base64')
	const lower = await getMediaKeys(`data:image/png;base64,${b64}`, 'image')
	const upper = await getMediaKeys(`DATA:IMAGE/PNG;BASE64,${b64}`, 'image')
	assert.deepEqual(Buffer.from(upper.iv), Buffer.from(lower.iv), 'uppercase prefix must derive identical keys')
	assert.deepEqual(Buffer.from(upper.cipherKey), Buffer.from(lower.cipherKey))
})

// --- HB-191 addendum faset 2: end() rollback must restore prevMe ---
// Adapted from the test/36 HB-191 harness (local fake WA server, full
// Noise XX handshake, test CA). Here the server DROPS the connection
// when the companion_hello IQ arrives and never answers it: end()
// runs its pending-pairing rollback while the pairing query is still
// pending, and the requestPairingCode settle path only runs after
// ev.destroy() — so only end()'s own emit can persist the outcome.
// Pre-fix end() DELETED creds.me: creds.json lost the pre-existing
// paired identity while memory later regained it.

const { makeNoiseHandler } = await import('../lib/Utils/noise-handler.js')
const { hkdf, aesEncryptGCM, aesDecryptGCM } = await import('../lib/Utils/crypto.js')
const { encodeBinaryNode } = await import('../lib/WABinary/encode.js')
const { decodeBinaryNode: decodeNode191 } = await import('../lib/WABinary/decode.js')
const { NOISE_WA_HEADER, NOISE_MODE, WA_CERT_DETAILS } = await import('../lib/Defaults/index.js')
const { WebSocketServer: WSS191 } = await import('ws')

const PAIRED_ME = { id: '6281234567890:42@s.whatsapp.net', name: 'Paired', lid: '11111111111111@lid' }

test('HB-191 addendum faset 2: a server drop mid-pairing restores the pre-existing me on disk, not a delete', async () => {
	const AUTH_DIR = await mkdtemp(join(tmpdir(), 'aunu-c1-191-'))
	const { state, saveCreds } = await lib.useMultiFileAuthState(AUTH_DIR)
	state.creds.me = { ...PAIRED_ME }
	state.creds.registered = false
	await saveCreds()

	const caPair = Curve.generateKeyPair()
	WA_CERT_DETAILS.PUBLIC_KEY = Buffer.from(caPair.public)
	const interPair = Curve.generateKeyPair()

	const stub = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return stub }, level: 'info' }
	const frame = payload => {
		const out = Buffer.alloc(3 + payload.length)
		out.writeUInt8(payload.length >> 16, 0)
		out.writeUInt16BE(payload.length & 65535, 1)
		payload.copy(out, 3)
		return out
	}
	const genIV = ctr => {
		const iv = Buffer.alloc(12)
		iv.writeUInt32BE(ctr, 8)
		return iv
	}
	const S = { phase: 'hello', buf: Buffer.alloc(0), introStripped: false, srv: null, salt: null, postEnc: null, postDec: null, writeCtr: 0, readCtr: 0 }
	const postEncode = plain => {
		const ct = aesEncryptGCM(plain, S.postEnc, genIV(S.writeCtr), Buffer.alloc(0))
		S.writeCtr += 1
		return frame(ct)
	}
	const postDecode = ct => {
		const pt = aesDecryptGCM(ct, S.postDec, genIV(S.readCtr), Buffer.alloc(0))
		S.readCtr += 1
		return pt
	}
	const sendNode191 = (ws, node) => ws.send(postEncode(encodeBinaryNode(node)))

	async function onFrame(ws, payload) {
		if (S.phase === 'hello') {
			const hm = waproto.HandshakeMessage.decode(payload)
			const cePub = Buffer.from(hm.clientHello.ephemeral)
			const se = Curve.generateKeyPair()
			const ss = Curve.generateKeyPair()
			S.srv = makeNoiseHandler({ keyPair: { public: cePub, private: se.private }, NOISE_HEADER: NOISE_WA_HEADER, logger: stub, routingInfo: undefined })
			S.srv.encodeFrame(Buffer.alloc(0))
			S.srv.authenticate(Buffer.from(se.public))
			const shared1 = Curve.sharedKey(se.private, cePub)
			await S.srv.mixIntoKey(shared1)
			const staticEnc = S.srv.encrypt(Buffer.from(ss.public))
			const shared2 = Curve.sharedKey(ss.private, cePub)
			await S.srv.mixIntoKey(shared2)
			const interDetails = waproto.CertChain.NoiseCertificate.Details.encode({
				serial: 1, issuerSerial: 0, key: Buffer.from(interPair.public)
			}).finish()
			const interSig = Curve.sign(caPair.private, interDetails)
			const leafDetails = waproto.CertChain.NoiseCertificate.Details.encode({
				serial: 2, issuerSerial: 1, key: Buffer.from(ss.public)
			}).finish()
			const leafSig = Curve.sign(interPair.private, leafDetails)
			const cert = waproto.CertChain.encode({
				intermediate: { details: interDetails, signature: Buffer.from(interSig) },
				leaf: { details: leafDetails, signature: Buffer.from(leafSig) }
			}).finish()
			const payloadEnc = S.srv.encrypt(cert)
			ws.send(frame(waproto.HandshakeMessage.encode({ serverHello: { ephemeral: Buffer.from(se.public), static: staticEnc, payload: payloadEnc } }).finish()))
			const h0 = Buffer.from(NOISE_MODE)
			S.salt = (await hkdf(shared1, 64, { salt: h0, info: '' })).subarray(0, 32)
			S.salt = (await hkdf(shared2, 64, { salt: S.salt, info: '' })).subarray(0, 32)
			S.se = se
			S.ss = ss
			S.phase = 'finish'
			return
		}

		if (S.phase === 'finish') {
			const hm = waproto.HandshakeMessage.decode(payload)
			const cf = hm.clientFinish
			const noiseKeyPub = S.srv.decrypt(Buffer.from(cf.static))
			const shared3 = Curve.sharedKey(S.se.private, noiseKeyPub)
			await S.srv.mixIntoKey(shared3)
			S.srv.decrypt(Buffer.from(cf.payload))
			S.salt = (await hkdf(shared3, 64, { salt: S.salt, info: '' })).subarray(0, 32)
			const fin = await hkdf(Buffer.alloc(0), 64, { salt: S.salt, info: '' })
			S.postDec = Buffer.from(fin.subarray(0, 32))
			S.postEnc = Buffer.from(fin.subarray(32, 64))
			S.writeCtr = 0
			S.readCtr = 0
			S.phase = 'open'
			sendNode191(ws, { tag: 'success', attrs: { lid: '6281234567890@lid' } })
			return
		}

		const node = await decodeNode191(postDecode(Buffer.from(payload)))
		if (node.tag === 'iq') {
			const isHello =
				node.attrs.xmlns === 'md' &&
				Array.isArray(node.content) &&
				node.content.some(c => c.tag === 'link_code_companion_reg')
			if (isHello) {
				// server drop: kill the transport, never answer the IQ
				ws.terminate()
				return
			}

			sendNode191(ws, { tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: undefined })
		}
	}

	async function onBytes(ws, data) {
		S.buf = Buffer.concat([S.buf, Buffer.from(data)])
		if (!S.introStripped) {
			if (S.buf.length < 4) return
			S.buf = S.buf.subarray(4)
			S.introStripped = true
		}

		while (S.buf.length >= 3) {
			const size = (S.buf.readUInt8(0) << 16) | S.buf.readUInt16BE(1)
			if (S.buf.length < 3 + size) return
			const payload = S.buf.subarray(3, 3 + size)
			S.buf = S.buf.subarray(3 + size)
			await onFrame(ws, payload)
		}
	}

	const wss = new WSS191({ port: 18851, host: '127.0.0.1' })
	let q = Promise.resolve()
	wss.on('connection', ws => {
		ws.on('message', data => {
			q = q.then(() => onBytes(ws, data)).catch(() => {})
		})
		ws.on('error', () => {})
	})

	WebSocketClient.prototype.connect = REAL_WS_CONNECT
	let sock
	try {
		sock = lib.makeWASocket({
			logger: stub,
			auth: state,
			browser: ['AunuBaileys-HB', 'Chrome', '1.0'],
			waWebSocketUrl: 'ws://127.0.0.1:18851',
			connectTimeoutMs: 10000,
			defaultQueryTimeoutMs: 5000,
			keepAliveIntervalMs: 25000,
			printQRInTerminal: false,
			markOnlineOnConnect: false,
			syncFullHistory: false,
			fireInitQueries: false,
			emitOwnEvents: false,
			banSentinel: false
		})
		// Record a snapshot of the in-memory creds at EVERY
		// creds.update after construction: the regression is a save
		// that persists the LOSS of the identity (meId undefined),
		// even if a later save restores it — a process death in
		// between boots from the deleted state.
		const saves = []
		sock.ev.on('creds.update', async () => {
			saves.push({ meId: state.creds.me?.id, hasCode: !!state.creds.pairingCode })
			await saveCreds()
		})
		const opened = await new Promise(resolve => {
			const t = setTimeout(() => resolve(false), 15000)
			sock.ev.on('connection.update', u => {
				if (u.connection === 'open') {
					clearTimeout(t)
					resolve(true)
				}
			})
		})
		assert.ok(opened, 'the fake-server socket must open')
		await sleep(800)
		assert.equal(state.creds.me?.id, PAIRED_ME.id, 'seeded paired me must be in place before pairing')

		const saveMark = saves.length
		const pairingPromise = sock.requestPairingCode('6289876543210')
		pairingPromise.catch(() => {})
		// the drop kills the socket; the pending query only settles
		// on its 5s timeout, long after end() destroyed the buffer
		await Promise.race([pairingPromise.catch(() => {}), sleep(9000)])
		await sleep(800)

		const postPairingSaves = saves.slice(saveMark)
		assert.ok(postPairingSaves.length > 0, 'the rollback must emit at least one creds.update')
		assert.ok(
			postPairingSaves.every(s => typeof s.meId === 'string'),
			`no save after the pairing started may persist a missing me (got ${JSON.stringify(postPairingSaves)}) — pre-fix end() deleted me and persisted the deletion`
		)
		assert.equal(state.creds.me?.id, PAIRED_ME.id, 'memory must hold the restored paired me')
		let diskCreds = null
		try {
			diskCreds = JSON.parse(await readFile(join(AUTH_DIR, 'creds.json'), 'utf-8'))
		} catch {}
		assert.equal(
			diskCreds?.me?.id,
			PAIRED_ME.id,
			'creds.json must hold the restored paired me — pre-fix end() persisted its deletion and the late restore emit was lost in the destroyed buffer'
		)
		assert.equal(diskCreds?.pairingCode, undefined, 'the pending pairing code must not persist')
	} finally {
		WebSocketClient.prototype.connect = () => {}
		try { await sock?.end(undefined) } catch {}
		wss.close()
	}
})
