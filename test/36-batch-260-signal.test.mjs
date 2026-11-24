// AunuBaileys 2.6.0 batch regressions — GROUP C (signal / auth / socket):
// HB-410 (SPK signature never verified at session init), HB-456 (duplicate
// SKDM evicts distinct sender-key states), HB-461 (getUSyncDevices warm-cache
// duplication), HB-464 (waitForConnectionUpdate never settles on an already
// closed socket), HB-467 (requestPairingCode length check throws plain Error),
// HB-424 residu (jidToSignalProtocolAddress raw Error for device :99),
// HB-2026-1112-38 (keys.set multi-file not atomic across files), HB-191
// addendum (requestPairingCode rollback deletes a pre-existing paired me),
// HB-477 (Group F: recoverCreds light gate let strict-invalid creds skip
// the .bak restore — now the shared strict gate decides for both files),
// HB-478 (Group G: importSessionBackup rename phase not atomic + base64
// payloads not validated — now strict base64 + strict creds gate before
// staging, and snapshot/rollback across the rename loop),
// delta useNyxAuthState (opt-in auth state: atomic writes + per-file mutex +
// creds.json.bak last-known-good auto-restore + .corrupt quarantine +
// export/import session backup), plus sapuan: HB-168 addenda (SKDM signing-key
// prefix byte, chain iteration uint32-max), HB-377 addendum (deleteSession
// reverse direction), HB-262 addendum (end() clears pending pairing),
// HB-383 addendum (query() attrs guard), HB-338 addendum site 4
// (removeOldSessions prints SessionEntry key material), HB-2026-1112-42
// addendum follow-up waiter (key-only SUCCESS media-update must fail
// Boom 502, not a raw TypeError), plus sweep addenda (follow-up #1):
// HB-213 addendum (query()/sendNode() plaintext before the Noise
// handshake), HB-133 addendum 2 (getCodeFromWSError drops Boom codes),
// HB-2026-1112-79 addendum (relayMessage retry participant without
// count), HB-334 addendum (export sendReceipt 'sender' without a
// participant).
// Each test names the item it locks in and fails without its fix (verified
// by running this file against lib/ 2.5.0 first — see GROUP-C-REPORT.md).
// Everything runs offline against the built lib/; the HB-191 harness runs
// a local fake WA server with a full Noise XX handshake (test CA).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly, tmpDir, waitFor } from './helpers.mjs'
import { Boom } from '@hapi/boom'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { getCodeFromWSError } from '../lib/Utils/generics.js'
import { makeCacheStore } from '../lib/Utils/internal-cache.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { GroupSessionBuilder } from '../lib/Signal/Group/group-session-builder.js'
import { SenderKeyDistributionMessage } from '../lib/Signal/Group/sender-key-distribution-message.js'
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js'
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js'
import { GroupCipher } from '../lib/Signal/Group/group_cipher.js'
import * as keyhelper from '../lib/Signal/Group/keyhelper.js'
import { decodeBinaryNode, jidEncode } from '../lib/WABinary/index.js'

// No real connection attempts anywhere in this file — EXCEPT the
// HB-191 harness below, which runs a local fake WA server and needs
// a real WebSocket: it restores the original connect for its cases.
const REAL_WS_CONNECT = WebSocketClient.prototype.connect
WebSocketClient.prototype.connect = () => {}

const GROUP = '120363012345678@g.us'
const ME = '628123456789@s.whatsapp.net'
const ME_USER = '628123456789'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_USER = '628987654321'

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

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

// --- HB-410: signed pre-key signature never verified at session init ---

test('HB-410: injectE2ESession accepts a bundle whose SPK signature is valid', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-260-410-'))
	try {
		await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
		const info = await repo.getSessionInfo(PEER)
		assert.ok(info, 'session must exist after injecting a valid bundle')
		assert.equal(info.registrationId, 1234)
		const { ciphertext } = await repo.encryptMessage({ jid: PEER, data: Buffer.from('hello-410') })
		assert.ok(ciphertext.length > 0)
	} finally {
		repo.close()
	}
})

test('HB-410: injectE2ESession rejects a bundle whose SPK was signed by a different identity key', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-260-410-'))
	try {
		// The peer's real identity + SPK, but the signature is made by
		// an ATTACKER identity — the exact bypass libsignal's
		// initOutgoing never catches (curve.verifySignature(..., true)
		// returns true without verifying). The session must NOT be made.
		const identity = Curve.generateKeyPair()
		const attacker = Curve.generateKeyPair()
		const signed = signedKeyPair(identity, 1)
		const forgedSignature = Curve.sign(attacker.private, generateSignalPubKey(signed.keyPair.public))
		const pre = Curve.generateKeyPair()
		const forged = {
			registrationId: 1234,
			identityKey: generateSignalPubKey(identity.public),
			signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: forgedSignature },
			preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
		}
		await assert.rejects(
			repo.injectE2ESession({ jid: PEER, session: forged }),
			err => err?.output?.statusCode === 400 && /signed pre-key/i.test(err.message)
		)
		// No session was created: the forged bundle never landed.
		assert.equal(await repo.getSessionInfo(PEER), null)
		assert.deepEqual(await repo.validateSession(PEER), { exists: false, reason: 'no session' })
	} finally {
		repo.close()
	}
})

test('HB-410: injectE2ESession rejects a bundle with a garbage SPK signature', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-260-410-'))
	try {
		const bundle = bundleFor()
		bundle.signedPreKey.signature = Buffer.alloc(64, 0xab)
		await assert.rejects(
			repo.injectE2ESession({ jid: PEER, session: bundle }),
			err => err?.output?.statusCode === 400
		)
		assert.equal(await repo.getSessionInfo(PEER), null)
	} finally {
		repo.close()
	}
})

// --- HB-456: duplicate SKDM re-delivery evicts distinct sender-key states ---

test('HB-456: re-processing the same SKDM 5x does not evict distinct states', async () => {
	let record = new SenderKeyRecord()
	const store = {
		async loadSenderKey() { return record },
		async storeSenderKey(_n, r) { record = r }
	}
	const name = new SenderKeyName(GROUP, { id: '999', deviceId: 0, toString() { return '999.0' } })
	const builder = new GroupSessionBuilder(store)
	const { randomBytes } = await import('node:crypto')
	const kp3 = keyhelper.generateSenderSigningKey()
	const chain3 = randomBytes(32)
	// One fixed (chain key, signing key) pair per id: a re-delivery
	// is byte-identical by definition, so the replay below must
	// reuse id 5's exact bytes (fresh random bytes per call would
	// be five DIFFERENT SKDMs that merely share a keyId, not
	// duplicates).
	const skdmParts = new Map()
	const skdmFor = id => {
		if (!skdmParts.has(id)) {
			skdmParts.set(id, id === 3
				? { chain: chain3, key: kp3.public }
				: { chain: randomBytes(32), key: keyhelper.generateSenderSigningKey().public })
		}

		const { chain, key } = skdmParts.get(id)
		return new SenderKeyDistributionMessage(id, 0, chain, key)
	}
	for (let id = 1; id <= 5; id++) await builder.process(name, skdmFor(id))
	assert.deepEqual(record.serialize().map(s => s.senderKeyId), [1, 2, 3, 4, 5])
	// A valid wire message under key 3, minted from an own-style record.
	let rec3 = new SenderKeyRecord()
	rec3.setSenderKeyState(3, 0, chain3, kp3)
	const store3 = { async loadSenderKey() { return rec3 }, async storeSenderKey(_n, r) { rec3 = r } }
	const wire3 = await new GroupCipher(store3, name).encrypt(Buffer.from('hello under key 3'))
	assert.equal(Buffer.from(await new GroupCipher(store, name).decrypt(wire3)).toString(), 'hello under key 3')
	// Duplicate re-delivery of SKDM id 5, five times (retry receipts).
	for (let i = 0; i < 5; i++) await builder.process(name, skdmFor(5))
	// Pre-fix the record was [5,5,5,5,5] and the key-3 message was lost.
	assert.deepEqual(record.serialize().map(s => s.senderKeyId), [1, 2, 3, 4, 5])
	// A fresh message under key 3 must still decrypt afterwards.
	// (Decrypting wire3 itself a second time would fail with 'old
	// counter' even on a healthy record — the first decrypt already
	// advanced key 3's chain past iteration 0 — so mint a new one.)
	const wire3b = await new GroupCipher(store3, name).encrypt(Buffer.from('hello again under key 3'))
	assert.equal(Buffer.from(await new GroupCipher(store, name).decrypt(wire3b)).toString(), 'hello again under key 3')
})

test('HB-456: a genuine rotation with a new keyId still adds a state', async () => {
	let record = new SenderKeyRecord()
	const store = {
		async loadSenderKey() { return record },
		async storeSenderKey(_n, r) { record = r }
	}
	const name = new SenderKeyName(GROUP, { id: '999', deviceId: 0, toString() { return '999.0' } })
	const builder = new GroupSessionBuilder(store)
	const { randomBytes } = await import('node:crypto')
	for (let id = 1; id <= 5; id++) {
		await builder.process(name, new SenderKeyDistributionMessage(id, 0, randomBytes(32), keyhelper.generateSenderSigningKey().public))
	}
	// Same keyId as an existing state but a DIFFERENT chain key: a new
	// rotation, not a duplicate — it must be stored (evicting the oldest).
	const newChain = randomBytes(32)
	await builder.process(name, new SenderKeyDistributionMessage(5, 0, newChain, keyhelper.generateSenderSigningKey().public))
	const ids = record.serialize().map(s => s.senderKeyId)
	assert.deepEqual(ids, [2, 3, 4, 5, 5])
})

// --- HB-461: getUSyncDevices warm-cache duplication ---

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

// Answer every outgoing IQ; USync IQs get a fabricated <usync><list>
// result for `usyncUser` (one device 0 + lid). With `echoTwice` the
// same <user> is returned twice, as a server echoing a user would.
const answerAllIQs = (sock, usyncUser, echoTwice = false) => {
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
				const userNode = {
					tag: 'user',
					attrs: { jid: usyncUser.jid },
					content: [
						{
							tag: 'devices',
							attrs: {},
							content: [{
								tag: 'device-list',
								attrs: {},
								content: [{ tag: 'device', attrs: { id: '0', 'key-index': '0' } }]
							}]
						},
						...(usyncUser.lid ? [{ tag: 'lid', attrs: { val: usyncUser.lid } }] : [])
					]
				}
				const users = echoTwice ? [userNode, { ...userNode, content: [...userNode.content] }] : [userNode]
				content = [{
					tag: 'usync',
					attrs: {},
					content: [{ tag: 'list', attrs: {}, content: users }]
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

test('HB-461: getUSyncDevices([ME, ME]) on the warm cache returns each device once', async () => {
	const { sock } = await makeSendSocket()
	try {
		// Two own devices in the cache (the self-DM shape: relayMessage
		// calls getUSyncDevices([senderIdentity, jid]) with identical
		// entries). Pre-fix the warm path returned 4 entries.
		await sock.userDevicesCache.mset([{
			key: ME_USER,
			value: [
				{ user: ME_USER, device: 0, server: 's.whatsapp.net' },
				{ user: ME_USER, device: 1, server: 's.whatsapp.net' }
			]
		}])
		const devices = await sock.getUSyncDevices([ME, ME], true, false)
		assert.equal(devices.length, 2)
		assert.deepEqual(
			devices.map(d => d.jid).sort(),
			[jidEncode(ME_USER, 's.whatsapp.net', 0), jidEncode(ME_USER, 's.whatsapp.net', 1)].sort()
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-461: getUSyncDevices dedupes a server echoing the same user twice (fresh path)', async () => {
	const { sock } = await makeSendSocket()
	try {
		answerAllIQs(sock, { jid: PEER }, true)
		const devices = await sock.getUSyncDevices([PEER, PEER], false, false)
		assert.equal(devices.length, 1)
		assert.equal(devices[0].jid, jidEncode(PEER_USER, 's.whatsapp.net', 0))
	} finally {
		endQuietly(sock)
	}
})

// --- HB-464: waitForConnectionUpdate without timeoutMs on a closed socket ---

test('HB-464: waitForConnectionUpdate rejects at once when the socket already closed', async () => {
	const { makeEventBuffer } = await import('../lib/Utils/event-buffer.js')
	const { bindWaitForConnectionUpdate } = await import('../lib/Utils/generics.js')
	const ev = makeEventBuffer(silentLogger)
	const wait = bindWaitForConnectionUpdate(ev)
	ev.emit('connection.update', {
		connection: 'close',
		lastDisconnect: { error: new Error('test close'), date: new Date() }
	})
	// Pre-fix this never settled without a timeoutMs: the close event
	// had already fired before the wait started. A 500 ms race guard
	// turns the hang into a failure instead of a wedged suite.
	const settled = await Promise.race([
		wait(async () => false).then(
			() => 'resolved',
			err => `rejected:${err?.message || err}`
		),
		sleep(500).then(() => 'TIMEOUT')
	])
	assert.notEqual(settled, 'TIMEOUT', 'wait must settle promptly on an already-closed socket')
	assert.ok(settled.startsWith('rejected:'), `expected a rejection, got ${settled}`)
})

test('HB-464: waitForConnectionUpdate still resolves on a matching future update', async () => {
	const { makeEventBuffer } = await import('../lib/Utils/event-buffer.js')
	const { bindWaitForConnectionUpdate } = await import('../lib/Utils/generics.js')
	const ev = makeEventBuffer(silentLogger)
	const wait = bindWaitForConnectionUpdate(ev)
	const pending = wait(async update => update.connection === 'open', 2000)
	await sleep(50)
	ev.emit('connection.update', { connection: 'open' })
	await pending
})

test('HB-464: waitForConnectionUpdate with a timeout still rejects Timed Out', async () => {
	const { makeEventBuffer } = await import('../lib/Utils/event-buffer.js')
	const { bindWaitForConnectionUpdate } = await import('../lib/Utils/generics.js')
	const ev = makeEventBuffer(silentLogger)
	const wait = bindWaitForConnectionUpdate(ev)
	await assert.rejects(wait(async () => false, 200), /Timed Out/)
})

// --- HB-467: requestPairingCode custom-code length check throws plain Error ---

test('HB-467: requestPairingCode with a short custom code throws Boom 400, not plain Error', async () => {
	const sock = await makeOfflineSocket()
	try {
		await assert.rejects(
			sock.requestPairingCode('6281234567890', 'abc'),
			err => {
				assert.equal(err?.output?.statusCode, 400)
				assert.match(err.message, /exactly 8 chars/)
				return true
			}
		)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-424 residu: converter jidToSignalProtocolAddress raw Error for :99 ---

test('HB-424 residu: jidToSignalProtocolAddress for a :99 device throws Boom 400', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-260-424-'))
	try {
		assert.throws(
			() => repo.jidToSignalProtocolAddress('628123456789:99@s.whatsapp.net'),
			err => err?.output?.statusCode === 400 && /device 99/i.test(err.message)
		)
		// Controls: hosted :99 and device 0 still build an address.
		assert.equal(repo.jidToSignalProtocolAddress('628123456789:99@hosted'), '628123456789_128.99')
		assert.equal(repo.jidToSignalProtocolAddress(PEER), '628987654321.0')
	} finally {
		repo.close()
	}
})

test('HB-424 residu: decryptMessage/encryptMessage for :99 reject with Boom 400', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-260-424-'))
	try {
		await assert.rejects(
			repo.decryptMessage({ jid: '628123456789:99@s.whatsapp.net', type: 'msg', ciphertext: Buffer.alloc(10) }),
			err => err?.output?.statusCode === 400
		)
		await assert.rejects(
			repo.encryptMessage({ jid: '628123456789:99@s.whatsapp.net', data: Buffer.from('x') }),
			err => err?.output?.statusCode === 400
		)
	} finally {
		repo.close()
	}
})

// --- HB-2026-1112-38: keys.set multi-file not atomic across files ---

test('HB-2026-1112-38: a failing multi-file keys.set leaves earlier files untouched', async () => {
	const dir = tmpDir('aunu-260-1112-38-')
	const { state } = await lib.useMultiFileAuthState(dir)
	// Seed a session file with known OLD content.
	const oldSession = Buffer.from(JSON.stringify({ v: 'old' }))
	await state.keys.set({ session: { '111.0': oldSession } })
	const fileA = join(dir, 'session-111.0.json')
	// Capture the exact on-disk bytes: the store writes a Buffer
	// value via BufferJSON, so the file holds the Buffer form, not
	// the raw JSON — the assertion is byte-exact rollback, not a
	// particular serialisation.
	const beforeBytes = await readFile(fileA, 'utf-8')
	assert.ok(beforeBytes.length > 0)
	// A two-file set whose SECOND write cannot land: its file name
	// exceeds the filesystem's 255-byte limit (ENAMETOOLONG at tmp
	// creation). Pre-fix the first file's new content stayed on disk
	// while the whole set rejected — a half-landed commit.
	const longId = `222.${'9'.repeat(300)}`
	await assert.rejects(state.keys.set({
		session: {
			'111.0': Buffer.from(JSON.stringify({ v: 'new' })),
			[longId]: Buffer.from(JSON.stringify({ v: 'new' }))
		}
	}))
	// The earlier file still holds its OLD content, not the new one.
	assert.equal(await readFile(fileA, 'utf-8'), beforeBytes)
	// The failed file never appeared.
	assert.ok(!(await readdir(dir)).some(name => name.includes('222.999')))
})

test('HB-2026-1112-38: a healthy multi-file keys.set still lands every file', async () => {
	const dir = tmpDir('aunu-260-1112-38-')
	const { state } = await lib.useMultiFileAuthState(dir)
	await state.keys.set({
		session: {
			'111.0': Buffer.from(JSON.stringify({ v: 'a' })),
			'222.0': Buffer.from(JSON.stringify({ v: 'b' }))
		},
		'pre-key': { 7: { private: Buffer.alloc(32, 1), public: Buffer.alloc(32, 2) } }
	})
	const got = await state.keys.get('session', ['111.0', '222.0'])
	assert.equal(JSON.parse(got['111.0'].toString()).v, 'a')
	assert.equal(JSON.parse(got['222.0'].toString()).v, 'b')
})

// --- HB-191 addendum: requestPairingCode rollback deletes a pre-existing paired me ---
// Adapted from heartbeat harness t0737-hb191-rollback2.mjs (run-0737):
// a local fake WA server that completes a full Noise XX handshake
// (test CA pinned into WA_CERT_DETAILS) and then rejects the
// companion_hello IQ, driving the query-failure rollback path.

const makeWASocket = lib.makeWASocket
const { makeNoiseHandler } = await import('../lib/Utils/noise-handler.js')
const { hkdf, aesEncryptGCM, aesDecryptGCM } = await import('../lib/Utils/crypto.js')
const { waproto: proto } = await import('../WAProto/index.js')
const { encodeBinaryNode } = await import('../lib/WABinary/encode.js')
const { decodeBinaryNode: decodeNode } = await import('../lib/WABinary/decode.js')
const { NOISE_WA_HEADER, NOISE_MODE, WA_CERT_DETAILS } = await import('../lib/Defaults/index.js')
const { WebSocketServer: WSS0737 } = await import('ws')

const PAIRED_ME = { id: '6281234567890:42@s.whatsapp.net', name: 'Paired', lid: '11111111111111@lid' }

async function runPairingCase(label, port, helloMode, seedPairedMe) {
	const AUTH_DIR = await mkdtemp(join(tmpdir(), 'aunu-0737-auth-'))
	const { state, saveCreds } = await lib.useMultiFileAuthState(AUTH_DIR)
	if (seedPairedMe) {
		state.creds.me = { ...PAIRED_ME }
		state.creds.registered = false
		await saveCreds()
	}

	// TEST SCAFFOLDING ONLY: the client verifies the Noise cert chain
	// against WA_CERT_DETAILS.PUBLIC_KEY, whose private half only
	// WhatsApp holds — point the (mutable) defaults object at a
	// harness-generated test CA so the handshake can complete.
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
	const S = { phase: 'hello', buf: Buffer.alloc(0), introStripped: false, srv: null, se: null, ss: null, salt: null, postEnc: null, postDec: null, writeCtr: 0, readCtr: 0 }
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
	const sendNode = (ws, node) => ws.send(postEncode(encodeBinaryNode(node)))
	const iqResult = (id, content) => ({ tag: 'iq', attrs: { type: 'result', id }, content })

	async function onFrame(ws, payload) {
		if (S.phase === 'hello') {
			const hm = proto.HandshakeMessage.decode(payload)
			const cePub = Buffer.from(hm.clientHello.ephemeral)
			S.se = Curve.generateKeyPair()
			S.ss = Curve.generateKeyPair()
			S.srv = makeNoiseHandler({ keyPair: { public: cePub, private: S.se.private }, NOISE_HEADER: NOISE_WA_HEADER, logger: stub, routingInfo: undefined })
			S.srv.encodeFrame(Buffer.alloc(0))
			S.srv.authenticate(Buffer.from(S.se.public))
			const shared1 = Curve.sharedKey(S.se.private, cePub)
			await S.srv.mixIntoKey(shared1)
			const staticEnc = S.srv.encrypt(Buffer.from(S.ss.public))
			const shared2 = Curve.sharedKey(S.ss.private, cePub)
			await S.srv.mixIntoKey(shared2)
			const interDetails = proto.CertChain.NoiseCertificate.Details.encode({
				serial: 1, issuerSerial: 0, key: Buffer.from(interPair.public)
			}).finish()
			const interSig = Curve.sign(caPair.private, interDetails)
			const leafDetails = proto.CertChain.NoiseCertificate.Details.encode({
				serial: 2, issuerSerial: 1, key: Buffer.from(S.ss.public)
			}).finish()
			const leafSig = Curve.sign(interPair.private, leafDetails)
			const cert = proto.CertChain.encode({
				intermediate: { details: interDetails, signature: Buffer.from(interSig) },
				leaf: { details: leafDetails, signature: Buffer.from(leafSig) }
			}).finish()
			const payloadEnc = S.srv.encrypt(cert)
			ws.send(frame(proto.HandshakeMessage.encode({ serverHello: { ephemeral: Buffer.from(S.se.public), static: staticEnc, payload: payloadEnc } }).finish()))
			const h0 = Buffer.from(NOISE_MODE)
			S.salt = (await hkdf(shared1, 64, { salt: h0, info: '' })).subarray(0, 32)
			S.salt = (await hkdf(shared2, 64, { salt: S.salt, info: '' })).subarray(0, 32)
			S.phase = 'finish'
			return
		}

		if (S.phase === 'finish') {
			const hm = proto.HandshakeMessage.decode(payload)
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
			sendNode(ws, { tag: 'success', attrs: { lid: '6281234567890@lid' } })
			return
		}

		const node = await decodeNode(postDecode(Buffer.from(payload)))
		if (node.tag === 'iq') {
			const isHello =
				node.attrs.xmlns === 'md' &&
				Array.isArray(node.content) &&
				node.content.some(c => c.tag === 'link_code_companion_reg')
			if (isHello && helloMode === 'error') {
				sendNode(ws, { tag: 'iq', attrs: { type: 'error', id: node.attrs.id }, content: [{ tag: 'error', attrs: { code: '401', text: 'device already linked' } }] })
			} else {
				sendNode(ws, iqResult(node.attrs.id))
			}
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

	const wss = new WSS0737({ port, host: '127.0.0.1' })
	let q = Promise.resolve()
	wss.on('connection', ws => {
		ws.on('message', data => {
			q = q.then(() => onBytes(ws, data)).catch(e => console.log('[srv] ERR', e?.message || e))
		})
		ws.on('error', () => {})
	})

	// This harness needs a REAL WebSocket to the local fake server —
	// the file-level stub above would leave the socket unconnected.
	// Restore it for this case only, then re-stub afterwards.
	WebSocketClient.prototype.connect = REAL_WS_CONNECT
	let sock
	try {
		sock = makeWASocket({
		logger: stub,
		auth: state,
		browser: ['AunuBaileys-HB', 'Chrome', '1.0'],
		waWebSocketUrl: `ws://127.0.0.1:${port}`,
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
	const emitted = []
	sock.ev.on('creds.update', creds => {
		emitted.push({ hasMe: !!creds.me, meId: creds.me?.id, hasPairingCode: !!creds.pairingCode, isFull: typeof creds?.registrationId === 'number' })
	})
	sock.ev.on('creds.update', saveCreds)
	const opened = await new Promise(resolve => {
		const t = setTimeout(() => resolve(false), 15000)
		sock.ev.on('connection.update', u => {
			if (u.connection === 'open') {
				clearTimeout(t)
				resolve(true)
			}
		})
	})
	if (!opened) {
		wss.close()
		return { label, pass: false, error: new Error('never opened'), code: null, emitted, emitMark: emitted.length, diskHasMe: false, diskMeId: undefined, meBefore: undefined, meAfter: undefined }
	}

	await sleep(800)
	const meBefore = state.creds.me?.id
	// Mark the emit index where the pairing call starts, so the
	// rollback assertion below can bound itself to the call window.
	const emitMark = emitted.length
	let error = null
	let code = null
	try {
		code = await sock.requestPairingCode('6289876543210')
	} catch (e) {
		error = e
	}

	const meAfter = state.creds.me?.id
	await sleep(600)
	let diskCreds = null
	try {
		diskCreds = JSON.parse(await readFile(join(AUTH_DIR, 'creds.json'), 'utf-8'))
	} catch {}

	try { await sock.end(undefined) } catch {}
	await sleep(200)
	wss.close()
	await sleep(200)
	return { label, meBefore, meAfter, error, code, emitted, emitMark, diskHasMe: !!diskCreds?.me, diskMeId: diskCreds?.me?.id }
	} finally {
		// Re-stub: every other test in this file expects no real connects.
		WebSocketClient.prototype.connect = () => {}
	}
}

test('HB-191 addendum: a failed hello IQ restores the pre-existing paired me', async () => {
	const t1 = await runPairingCase('T1-error-hello', 18792, 'error', true)
	assert.ok(t1.error, 'the call must reject when the server rejects hello')
	assert.match(t1.error?.message || '', /already linked/)
	assert.equal(t1.meBefore, PAIRED_ME.id)
	// Pre-fix the rollback DELETED the pre-existing paired identity
	// (meAfter undefined) and persisted the deletion to creds.json.
	assert.equal(t1.meAfter, PAIRED_ME.id, 'pre-existing paired me must be restored, not deleted')
	// The rollback emit is a FULL creds object carrying the restored
	// me and no pairing code. It is NOT necessarily the LAST emit:
	// partial creds.update emits ({nextPreKeyId},
	// {firstUnuploadedPreKeyId}, …) from the asynchronous pre-key
	// upload flow can land after it — those are by design (the socket
	// merges partials into in-memory creds via Object.assign, and the
	// host's saveCreds persists the whole creds). So assert on the
	// rollback emit itself, bounded to the call window — not on "the
	// last emit of any kind". (Run-1003 adjudication / Group D: the
	// old "last emit" assertion raced the pre-key upload and failed
	// 2/3 in isolation even though the restore itself always worked.)
	const rollbackEmits = t1.emitted.slice(t1.emitMark).filter(e => e.isFull)
	assert.ok(rollbackEmits.length > 0, 'the failed call must emit a full creds.update (the rollback)')
	assert.ok(
		rollbackEmits.some(e => e.meId === PAIRED_ME.id && !e.hasPairingCode),
		'rollback emit must carry the restored me, with the pairing code cleared'
	)
	assert.equal(t1.diskMeId, PAIRED_ME.id, 'the restore must persist to creds.json')
})

test('HB-191 addendum: a failed hello IQ with no pre-existing me still clears the optimistic me', async () => {
	const t = await runPairingCase('T1b-error-hello-no-prev', 18793, 'error', false)
	assert.ok(t.error, 'the call must reject when the server rejects hello')
	assert.equal(t.meBefore, undefined)
	assert.equal(t.meAfter, undefined, 'no pre-existing me: nothing to restore, optimistic me stays cleared')
	assert.equal(t.diskHasMe, false)
})

test('HB-191 addendum: an accepted hello IQ still resolves and overwrites me (control)', async () => {
	const t2 = await runPairingCase('T2-ok-hello-control', 18794, 'ok', true)
	assert.equal(typeof t2.code, 'string')
	assert.equal(t2.code.length, 8)
	assert.equal(t2.error, null)
	assert.equal(t2.meBefore, PAIRED_ME.id)
	assert.equal(t2.meAfter, '6289876543210@s.whatsapp.net')
})

// --- DELTA: useNyxAuthState (opt-in auth state with .bak recovery) ---

test('useNyxAuthState: a corrupt creds.json is restored from creds.json.bak', async () => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await first.saveCreds()
	// A last-known-good backup must exist next to creds.json.
	const bak = JSON.parse(await readFile(join(dir, 'creds.json.bak'), 'utf-8'))
	assert.equal(bak.me.id, ME)
	// Corrupt the live creds file (truncated write / disk garbage).
	await writeFile(join(dir, 'creds.json'), '{corrupt-json-no-close')
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.me?.id, ME, 'me must be restored from .bak, not lost to a fresh pairing')
	assert.equal(second.state.creds.registrationId, first.state.creds.registrationId)
	// The corrupt file is quarantined, not deleted.
	const names = await readdir(dir)
	assert.ok(names.some(n => n.startsWith('creds.json.corrupt')), `expected a .corrupt quarantine file, got ${names}`)
})

test('useNyxAuthState: a missing creds.json is restored from creds.json.bak', async () => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await first.saveCreds()
	await fs.promises.unlink(join(dir, 'creds.json'))
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.me?.id, ME)
})

test('useNyxAuthState: corrupt creds with no backup starts fresh and quarantines', async () => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	await first.saveCreds()
	await fs.promises.unlink(join(dir, 'creds.json.bak')).catch(() => {})
	await writeFile(join(dir, 'creds.json'), 'not json at all {{{')
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.me, undefined, 'no backup: fresh creds, re-pair required')
	const names = await readdir(dir)
	assert.ok(names.some(n => n.startsWith('creds.json.corrupt')))
})

// --- HB-477 (Group F): useNyxAuthState recovery gap — light-valid / strict-invalid ---
// recoverCreds used to decide "valid" with a light shape check (key-pair
// shapes + finite registrationId + advSecretKey string) while the base
// loader rejects the same creds with the strict gate (key-material
// lengths, registered boolean, routingInfo Buffer, me.id JID). Creds in
// that gap were left in place — no quarantine, no .bak restore — and the
// base loader then discarded them for fresh creds: session lost although
// a valid .bak existed, and the failure repeated every boot. Each case
// below must quarantine the bad file AND restore the valid .bak (me
// intact). The .bak itself is held to the same strict gate: a
// strict-invalid backup must NOT be restored.

const nyxGapCase = async (mutate, label) => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const { initAuthCreds } = await import('../lib/Utils/auth-utils.js')
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const { randomBytes } = await import('node:crypto')
	const dir = tmpDir('aunu-260-nyx-477-')
	const good = initAuthCreds()
	good.me = { id: ME, name: 'Nyx', lid: ME_LID }
	const bad = initAuthCreds()
	mutate(bad, randomBytes)
	const ser = c => JSON.stringify(c, BufferJSON.replacer)
	await writeFile(join(dir, 'creds.json'), ser(bad))
	await writeFile(join(dir, 'creds.json.bak'), ser(good))
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.registrationId, good.registrationId, `${label}: the .bak registrationId must win over the strict-invalid file`)
	assert.equal(second.state.creds.me?.id, ME, `${label}: me must be restored intact from .bak`)
	const names = await readdir(dir)
	const quarantine = names.find(n => n.startsWith('creds.json.corrupt'))
	assert.ok(quarantine, `${label}: expected a .corrupt quarantine file, got ${names}`)
	assert.equal(await readFile(join(dir, quarantine), 'utf-8'), ser(bad), `${label}: the quarantine must hold the bad bytes for forensics`)
	assert.equal(await readFile(join(dir, 'creds.json'), 'utf-8'), ser(good), `${label}: creds.json must now hold the .bak bytes`)
}

test('HB-477: a 63-byte signed-pre-key signature quarantines creds.json and restores .bak', async () => {
	await nyxGapCase((bad, randomBytes) => { bad.signedPreKey.signature = randomBytes(63) }, 'signature-63B')
})

test('HB-477: a 31-byte advSecretKey quarantines creds.json and restores .bak', async () => {
	await nyxGapCase((bad, randomBytes) => { bad.advSecretKey = randomBytes(31).toString('base64') }, 'advSecretKey-31B')
})

test("HB-477: a string registered flag ('false') quarantines creds.json and restores .bak", async () => {
	await nyxGapCase(bad => { bad.registered = 'false' }, "registered-'false'")
})

test('HB-477: a strict-invalid .bak is NOT restored — fresh creds, bad file quarantined', async () => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const { initAuthCreds } = await import('../lib/Utils/auth-utils.js')
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const { randomBytes } = await import('node:crypto')
	const dir = tmpDir('aunu-260-nyx-477-')
	const good = initAuthCreds()
	good.me = { id: ME, name: 'Nyx', lid: ME_LID }
	// Both files strict-invalid: creds.json has a 63-byte signature,
	// and the backup has a 31-byte advSecretKey. Neither may be used.
	const badCreds = initAuthCreds()
	badCreds.signedPreKey.signature = randomBytes(63)
	const badBak = initAuthCreds()
	badBak.advSecretKey = randomBytes(31).toString('base64')
	const ser = c => JSON.stringify(c, BufferJSON.replacer)
	await writeFile(join(dir, 'creds.json'), ser(badCreds))
	await writeFile(join(dir, 'creds.json.bak'), ser(badBak))
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.me, undefined, 'no valid backup: fresh creds, re-pair required')
	assert.notEqual(second.state.creds.registrationId, badBak.registrationId, 'the strict-invalid .bak must not be restored')
	const names = await readdir(dir)
	assert.ok(names.some(n => n.startsWith('creds.json.corrupt')), `expected a .corrupt quarantine file, got ${names}`)
})

test('useNyxAuthState: concurrent saves never corrupt creds.json', async () => {
	const { useNyxAuthState } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await Promise.all(Array.from({ length: 10 }, () => first.saveCreds()))
	const onDisk = JSON.parse(await readFile(join(dir, 'creds.json'), 'utf-8'))
	assert.equal(onDisk.me.id, ME)
	assert.equal(typeof onDisk.registrationId, 'number')
})

test('useNyxAuthState: export/import round-trip restores the session', async () => {
	const { useNyxAuthState, exportSessionBackup, importSessionBackup } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await first.saveCreds()
	await first.state.keys.set({ session: { '111.0': Buffer.from(JSON.stringify({ v: 's1' })) } })
	const backup = await exportSessionBackup(dir)
	assert.ok(Buffer.isBuffer(backup) && backup.length > 0)
	// Wipe the folder entirely, then import.
	for (const name of await readdir(dir)) {
		await fs.promises.unlink(join(dir, name))
	}

	await importSessionBackup(dir, backup)
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.me?.id, ME)
	assert.equal(second.state.creds.registrationId, first.state.creds.registrationId)
	const got = await second.state.keys.get('session', ['111.0'])
	assert.equal(JSON.parse(got['111.0'].toString()).v, 's1')
})

test('useNyxAuthState: password-encrypted export round-trips, wrong password rejects', async () => {
	const { useNyxAuthState, exportSessionBackup, importSessionBackup } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-')
	const dir2 = tmpDir('aunu-260-nyx-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await first.saveCreds()
	const backup = await exportSessionBackup(dir, { password: 'correct-horse' })
	assert.ok(!backup.toString('utf-8').includes(ME_USER), 'encrypted backup must not leak the phone number in cleartext')
	await assert.rejects(importSessionBackup(dir2, backup, { password: 'wrong-password' }))
	await importSessionBackup(dir2, backup, { password: 'correct-horse' })
	const second = await useNyxAuthState(dir2)
	assert.equal(second.state.creds.me?.id, ME)
})

// --- HB-478 (Group G): importSessionBackup — rename phase not atomic + base64 not validated ---
// importSessionBackup used to (a) rename staged files into place one by
// one with no snapshot/rollback, so a failure on the Nth rename left a
// mixed-generation folder (files 1..N-1 new, the rest old), and (b)
// accept any string as a base64 payload — Buffer.from(x, 'base64')
// never throws, so garbage silently overwrote a good creds.json. Both
// are locked in below: a failed import must leave the folder exactly as
// it was, and a bundle with a bad payload (or a strict-invalid
// creds.json) must be refused before anything is staged.

const nyxBundle = files => Buffer.from(JSON.stringify({ format: 'aunubaileys-nyx-backup', version: 1, files }), 'utf-8')
const nyxB64 = s => Buffer.from(s, 'utf-8').toString('base64')

test('HB-478 (a): a rename failure mid-import rolls the folder back to the previous generation', async () => {
	const { useNyxAuthState, importSessionBackup } = await import('../lib/Utils/use-nyx-auth-state.js')
	const { initAuthCreds } = await import('../lib/Utils/auth-utils.js')
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const dir = tmpDir('aunu-260-nyx-478-')
	const first = await useNyxAuthState(dir)
	first.state.creds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	await first.saveCreds()
	// The new creds must pass the strict gate, or the import is refused
	// at validation and the rename phase is never exercised.
	const newCreds = initAuthCreds()
	newCreds.me = { id: ME, name: 'Nyx', lid: ME_LID }
	const oldCreds = await readFile(join(dir, 'creds.json'), 'utf-8')
	await writeFile(join(dir, 'session-a.json'), 'OLD-SESSION-A')
	await fs.promises.mkdir(join(dir, 'zzz-blocked.json')) // a DIRECTORY where a file should land
	await assert.rejects(importSessionBackup(dir, nyxBundle({
		'creds.json': nyxB64(JSON.stringify(newCreds, BufferJSON.replacer)),
		'session-a.json': nyxB64('NEW-SESSION-A'),
		'zzz-blocked.json': nyxB64('NEW-BLOCKED')
	})))
	// Nothing landed: the folder is exactly the previous generation.
	assert.equal(await readFile(join(dir, 'creds.json'), 'utf-8'), oldCreds, 'creds.json must roll back to the old bytes')
	assert.equal(await readFile(join(dir, 'session-a.json'), 'utf-8'), 'OLD-SESSION-A', 'session-a.json must roll back to the old bytes')
	assert.ok((await fs.promises.stat(join(dir, 'zzz-blocked.json'))).isDirectory(), 'the blocking directory must survive untouched')
	const names = await readdir(dir)
	assert.ok(!names.some(n => n.includes('.tmp-import-')), `no staged tmp files may leak, got ${names}`)
})

test('HB-478 (b): garbage base64 in one entry rejects the whole bundle and leaves the folder untouched', async () => {
	const { importSessionBackup } = await import('../lib/Utils/use-nyx-auth-state.js')
	const dir = tmpDir('aunu-260-nyx-478-')
	await writeFile(join(dir, 'creds.json'), 'GOOD-CREDS')
	await writeFile(join(dir, 'session-a.json'), 'OLD-SESSION-A')
	await assert.rejects(importSessionBackup(dir, nyxBundle({
		'creds.json': '!!!not-valid-base64!!!',
		'session-a.json': nyxB64('NEW-SESSION-A')
	})))
	assert.equal(await readFile(join(dir, 'creds.json'), 'utf-8'), 'GOOD-CREDS', 'good creds must not be overwritten by decoded garbage')
	assert.equal(await readFile(join(dir, 'session-a.json'), 'utf-8'), 'OLD-SESSION-A', 'a sibling entry must not land when the bundle is refused')
	const names = await readdir(dir)
	assert.ok(!names.some(n => n.includes('.tmp-import-')), `no staged tmp files may leak, got ${names}`)
})

test('HB-478 (b): a base64-valid but strict-invalid creds.json rejects the whole bundle', async () => {
	const { importSessionBackup } = await import('../lib/Utils/use-nyx-auth-state.js')
	const { initAuthCreds } = await import('../lib/Utils/auth-utils.js')
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const { randomBytes } = await import('node:crypto')
	const dir = tmpDir('aunu-260-nyx-478-')
	await writeFile(join(dir, 'creds.json'), 'GOOD-CREDS')
	await writeFile(join(dir, 'session-a.json'), 'OLD-SESSION-A')
	// Canonical base64, but a 63-byte signed-pre-key signature: the
	// base loader would discard it at the next boot, so the import
	// must refuse it now instead of overwriting good creds.
	const badCreds = initAuthCreds()
	badCreds.signedPreKey.signature = randomBytes(63)
	await assert.rejects(importSessionBackup(dir, nyxBundle({
		'creds.json': nyxB64(JSON.stringify(badCreds, BufferJSON.replacer)),
		'session-a.json': nyxB64('NEW-SESSION-A')
	})))
	assert.equal(await readFile(join(dir, 'creds.json'), 'utf-8'), 'GOOD-CREDS')
	assert.equal(await readFile(join(dir, 'session-a.json'), 'utf-8'), 'OLD-SESSION-A')
})

// --- Sapuan: HB-168 addenda (SKDM signing-key prefix, chain iteration cap) ---

test('HB-168 addendum (prefix): a 33-byte SKDM signing key not starting 0x05 is refused', async () => {
	const { randomBytes } = await import('node:crypto')
	let record = new SenderKeyRecord()
	const store = {
		async loadSenderKey() { return record },
		async storeSenderKey(_n, r) { record = r }
	}
	const name = new SenderKeyName(GROUP, { id: '999', deviceId: 0, toString() { return '999.0' } })
	const builder = new GroupSessionBuilder(store)
	const badKey = Buffer.concat([Buffer.from([0x06]), randomBytes(32)])
	await builder.process(name, new SenderKeyDistributionMessage(1, 0, randomBytes(32), badKey))
	assert.equal(record.serialize().length, 0, 'poisoned SKDM must not be stored')
	// Control: 0x05-prefixed 33-byte key and bare 32-byte key both work.
	const goodKey = Buffer.concat([Buffer.from([0x05]), randomBytes(32)])
	await builder.process(name, new SenderKeyDistributionMessage(2, 0, randomBytes(32), goodKey))
	assert.equal(record.serialize().length, 1)
	await builder.process(name, new SenderKeyDistributionMessage(3, 0, randomBytes(32), randomBytes(32)))
	assert.equal(record.serialize().length, 2)
	// Load-time: a poisoned state already on disk is dropped, not loaded.
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const poisoned = [{
		senderKeyId: 9,
		senderChainKey: { iteration: 0, seed: randomBytes(32) },
		senderSigningKey: { public: badKey },
		senderMessageKeys: []
	}]
	const reloaded = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(poisoned, BufferJSON.replacer), 'utf-8'))
	assert.equal(reloaded.serialize().length, 0, 'load-time sanitiser must drop the poisoned state')
})

test('HB-168 addendum (iteration): an SKDM chain iteration above 2^31-1 is refused', async () => {
	const { randomBytes } = await import('node:crypto')
	let record = new SenderKeyRecord()
	const store = {
		async loadSenderKey() { return record },
		async storeSenderKey(_n, r) { record = r }
	}
	const name = new SenderKeyName(GROUP, { id: '999', deviceId: 0, toString() { return '999.0' } })
	const builder = new GroupSessionBuilder(store)
	const key = () => keyhelper.generateSenderSigningKey().public
	await builder.process(name, new SenderKeyDistributionMessage(1, 4294967295, randomBytes(32), key()))
	assert.equal(record.serialize().length, 0, 'uint32-max iteration is a dead end by construction')
	await builder.process(name, new SenderKeyDistributionMessage(2, 2147483648, randomBytes(32), key()))
	assert.equal(record.serialize().length, 0, 'above the int31 cap is refused too')
	await builder.process(name, new SenderKeyDistributionMessage(3, 2147483647, randomBytes(32), key()))
	assert.equal(record.serialize().length, 1, 'exactly at the cap is still plausible and accepted')
	await builder.process(name, new SenderKeyDistributionMessage(4, 0, randomBytes(32), key()))
	assert.equal(record.serialize().length, 2)
	// Load-time: a stored max-iteration state is dropped.
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const poisoned = [{
		senderKeyId: 9,
		senderChainKey: { iteration: 4294967295, seed: randomBytes(32) },
		senderSigningKey: { public: key() },
		senderMessageKeys: []
	}]
	const reloaded = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(poisoned, BufferJSON.replacer), 'utf-8'))
	assert.equal(reloaded.serialize().length, 0)
})

// --- Sapuan: HB-377 addendum (deleteSession reverse direction) ---

test('HB-377 addendum: deleteSession([LID]) removes a PN-keyed session record', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-260-377-'))
	try {
		const PEER_LID = '100000000000002@lid'
		const PEER_LID_USER = '100000000000002'
		const pnKey = repo.jidToSignalProtocolAddress(PEER)
		const lidKey = repo.jidToSignalProtocolAddress(PEER_LID)
		await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
		// Read the RAW store: getSessionInfo resolves PN->LID and
		// would report null even while the PN-keyed record survives,
		// which is exactly the masking that hid this addendum.
		const before = await state.keys.get('session', [pnKey])
		assert.ok(before[pnKey], 'PN-keyed session must exist in the raw store before the delete')
		// Learn the mapping AFTER the session was stored (USync learns
		// it without migrating the record — the addendum's premise).
		await state.keys.set({
			'lid-mapping': {
				[PEER_USER]: PEER_LID_USER,
				[`${PEER_LID_USER}_reverse`]: PEER_USER
			}
		})
		await repo.deleteSession([PEER_LID])
		const after = await state.keys.get('session', [pnKey, lidKey])
		assert.ok(after[pnKey] == null, 'PN-keyed record must be gone after a LID-addressed delete')
		assert.ok(after[lidKey] == null)
	} finally {
		repo.close()
	}
})

test('HB-377 addendum (control): deleteSession([PN]) still removes a LID-keyed record', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-260-377-'))
	try {
		const PEER_LID = '100000000000002@lid'
		const PEER_LID_USER = '100000000000002'
		const lidKey = repo.jidToSignalProtocolAddress(PEER_LID)
		await state.keys.set({
			'lid-mapping': {
				[PEER_USER]: PEER_LID_USER,
				[`${PEER_LID_USER}_reverse`]: PEER_USER
			}
		})
		await repo.injectE2ESession({ jid: PEER_LID, session: bundleFor() })
		const before = await state.keys.get('session', [lidKey])
		assert.ok(before[lidKey], 'LID-keyed session must exist in the raw store before the delete')
		await repo.deleteSession([PEER])
		const after = await state.keys.get('session', [lidKey])
		assert.ok(after[lidKey] == null)
	} finally {
		repo.close()
	}
})

// --- Sapuan lock-in: HB-262 addendum (end() clears pending pairing) ---

test('HB-262 addendum (lock-in): end() clears an uncompleted pairing, never a paired account', async () => {
	const sock = await makeOfflineSocket()
	try {
		sock.authState.creds.me = { id: ME, name: '~' }
		sock.authState.creds.pairingCode = 'ABCDEFGH'
		sock.authState.creds.registered = false
		const emitted = []
		sock.ev.on('creds.update', creds => emitted.push({ hasMe: !!creds.me, hasCode: !!creds.pairingCode }))
		await sock.end(undefined)
		assert.equal(sock.authState.creds.me, undefined)
		assert.equal(sock.authState.creds.pairingCode, undefined)
		assert.ok(emitted.length > 0 && !emitted[emitted.length - 1].hasMe)
	} finally {
		endQuietly(sock)
	}
})

test('HB-262 addendum (lock-in): end() keeps me when pair-success already ran (account set)', async () => {
	const sock = await makeOfflineSocket()
	try {
		sock.authState.creds.me = { id: ME, name: '~' }
		sock.authState.creds.pairingCode = 'ABCDEFGH'
		sock.authState.creds.registered = false
		sock.authState.creds.account = { details: 'paired' }
		await sock.end(undefined)
		assert.equal(sock.authState.creds.me?.id, ME)
	} finally {
		endQuietly(sock)
	}
})

// --- Sapuan lock-in: HB-383 addendum (query() attrs guard) ---

test('HB-383 addendum (lock-in): query() rejects non-object attrs with Boom 400, tolerates null attrs', async () => {
	const sock = await makeOfflineSocket()
	try {
		// String attrs: descriptive Boom 400, never a raw TypeError.
		await assert.rejects(
			sock.query({ tag: 'iq', attrs: 'iq', content: [] }),
			err => err?.output?.statusCode === 400 && /node\.attrs must be an object/.test(err.message)
		)
		// Null attrs: defaulted to {} like encodeBinaryNode tolerates,
		// so the failure is the transport one (Boom 428), not TypeError.
		await assert.rejects(
			sock.query({ tag: 'iq', attrs: null, content: [] }),
			err => err instanceof Error && !(err instanceof TypeError) && /Connection Closed/.test(err.message)
		)
	} finally {
		endQuietly(sock)
	}
})

// --- Sapuan lock-in: HB-338 addendum site 4 (removeOldSessions stdout leak) ---

test('HB-338 addendum site 4 (lock-in): removeOldSessions never prints session key material', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-260-338-'))
	try {
		// 41 session rotations for one peer: 40 closed + 1 open.
		// The next encrypt runs storeRecord -> removeOldSessions(),
		// which console.info()s the oldest closed entry.
		for (let i = 0; i < 41; i++) {
			await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
		}

		let captured = ''
		const origWrite = process.stdout.write.bind(process.stdout)
		process.stdout.write = (chunk, ...rest) => {
			captured += chunk.toString()
			return origWrite(chunk, ...rest)
		}
		try {
			await repo.encryptMessage({ jid: PEER, data: Buffer.from('338-probe') })
		} finally {
			process.stdout.write = origWrite
		}

		assert.ok(captured.includes('Removing old closed session'), 'the removal print must have fired in this probe')
		for (const leaked of ['rootKey', 'privKey', 'chainKey', '_chains', 'ephemeralKeyPair']) {
			assert.ok(!captured.includes(leaked), `stdout must not contain session key material (${leaked})`)
		}
	} finally {
		repo.close()
	}
})

// --- HB-2026-1112-42 addendum, follow-up waiter (Group A2 → Group C) ---
// A2's decodeMediaRetryNode fix made a SUCCESS media-retry notification
// without <encrypt> arrive as a KEY-ONLY messages.media-update event
// (no error, no media). The wait in updateMediaMessage then called
// decryptMediaRetryData(result.media!) with undefined — the function
// destructures its first argument, so a raw TypeError was stored and
// rethrown verbatim to the caller. The guard A2 cited (media.result
// !== SUCCESS + || 404) runs AFTER the decrypt and cannot protect it.

const isBoom36 = (statusCode, message) => err => {
	if (message && !String(err?.message || '').includes(message)) return false
	return err?.isBoom && err?.output?.statusCode === statusCode
}
const boom502_36 = message => isBoom36(502, message)
const withTimeout36 = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

const retryTestMessage36 = mediaKey => ({
	key: { remoteJid: PEER, fromMe: true, id: '3EB035427001' },
	messageTimestamp: 1760000000,
	message: {
		imageMessage: {
			mediaKey,
			mimetype: 'image/jpeg',
			fileSha256: Buffer.alloc(32, 1),
			fileLength: 1234
		}
	}
})

test('HB-2026-1112-42 addendum (waiter): a key-only SUCCESS media-update fails with Boom 502, not a raw TypeError', async () => {
	const { randomBytes } = await import('node:crypto')
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
		const record = []
		fakeOpenTransport(sock, record)
		const mediaKey = randomBytes(32)
		const msg = retryTestMessage36(mediaKey)
		const pending = sock.updateMediaMessage(msg)
		assert.equal(await waitFor(() => record.length > 0, 5000), true, 'the retry request must go out first')
		// Key-only event: the peer claims SUCCESS but sent no media data.
		sock.ev.emit('messages.media-update', [{ key: msg.key }])
		await assert.rejects(() => withTimeout36(pending, 10_000, 'updateMediaMessage'), boom502_36('no media data'))
	} finally {
		endQuietly(sock)
	}
})

test('HB-2026-1112-42 addendum (waiter, control): an error-carrying media-update still rejects with that error', async () => {
	const { randomBytes } = await import('node:crypto')
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
		const record = []
		fakeOpenTransport(sock, record)
		const mediaKey = randomBytes(32)
		const msg = retryTestMessage36(mediaKey)
		const pending = sock.updateMediaMessage(msg)
		assert.equal(await waitFor(() => record.length > 0, 5000), true, 'the retry request must go out first')
		sock.ev.emit('messages.media-update', [{ key: msg.key, error: new Error('peer media failure') }])
		await assert.rejects(() => withTimeout36(pending, 10_000, 'updateMediaMessage'), /peer media failure/)
	} finally {
		endQuietly(sock)
	}
})

// --- Sweep addenda (coordinator follow-up #1) ---
// HB-213 addendum, HB-133 addendum 2, HB-2026-1112-79 addendum,
// HB-334 addendum (export facet). Ledger: run-0738 (HB-213),
// run-0603 (HB-133 add. 2), run-0736 (HB-79 add., HB-334 add.).

const boom400_36 = message => isBoom36(400, message)

// --- HB-213 addendum: query()/sendNode() without a handshake gate ---
// sendRawMessage only checked ws.isOpen; encodeFrame encrypts only
// once the Noise transport exists (after finishInit), so a host
// query() in the ws-open → finishInit window went out as a plaintext
// binary node (run-0738: the ping IQ decoded with decodeBinaryNode).
// The fix FAILS FAST in sendNode for tag 'iq' (Boom 408
// 'Handshake not complete') while a handshake is in flight. Code
// 408 (not 428) preserves HB-340's contract: a query that cannot
// complete rejects as a timeout. Scope is IQ only: the inbound
// pipeline awaits receipt/ack sends before the upsert, so a gate on
// all tags aborts message processing on sockets whose handshake
// never completes (the all-tags variants broke the same 6 test/35
// tests; the await variant also stalled HB-476 Phase 3 past its
// 10 s waitFor — see GROUP-C-REPORT).
// The check is NOT in sendRawMessage: the handshake's own clientHello + clientFinish flow
// through it before finishInit and must not be refused.

test('HB-213 addendum: query() in the ws-open → finishInit window fails fast with Boom 408 (no plaintext IQ)', async () => {
	const dir = tmpDir('aunu-36-hb213-')
	const { state } = await lib.useMultiFileAuthState(dir)
	const sock = lib.makeWASocket({
		auth: state, logger: silentLogger,
		browser: ['HB-Test', 'Chrome', '1.0'],
		markOnlineOnConnect: false, fireInitQueries: false,
		shouldSyncHistoryMessage: () => false,
		connectTimeoutMs: 3000, defaultQueryTimeoutMs: 1500
	})
	try {
		const sent = []
		const fake = { send: (data, cb) => { sent.push(Buffer.from(data)); cb && cb() }, close: () => {} }
		Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
		Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
		let queryError = null
		sock.ws.on('open', () => {
			sock.query({
				tag: 'iq',
				attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' },
				content: [{ tag: 'ping', attrs: {} }]
			}, 200).catch(e => { queryError = e })
		})
		sock.ws.emit('open')
		// The query is refused at once by the gate (black-hole
		// harness: the handshake never comes) — it must never
		// produce a second, plaintext frame. Poll for the rejection
		// instead of a fixed sleep: under CPU contention the timer
		// can fire late, and a fixed sleep flaked.
		assert.equal(await waitFor(() => queryError !== null, 5000), true, 'the refused query must settle 408')
		// frame[0] is the Noise clientHello from validateConnection —
		// the refused query must NOT have produced a second, plaintext frame.
		assert.equal(sent.length, 1, `expected only the clientHello frame, got ${sent.length}`)
		assert.ok(queryError?.isBoom && queryError?.output?.statusCode === 408, `expected Boom 408, got ${queryError}`)
	} finally {
		endQuietly(sock)
	}
})

// --- HB-133 addendum 2: getCodeFromWSError drops Boom status codes ---
// The 1.0.77 fix preserved a Boom's own code; the v7 rebase (2.0.0)
// re-applied only the case-insensitive message half, so Boom 428/403
// fell through to 500 and mapWebSocketError re-wrapped them as 500.

test('HB-133 addendum 2: getCodeFromWSError preserves a Boom status code', () => {
	assert.equal(getCodeFromWSError(new Boom('Connection Closed', { statusCode: 428 })), 428)
	assert.equal(getCodeFromWSError(new Boom('Forbidden', { statusCode: 403 })), 403)
	assert.equal(getCodeFromWSError(new Boom('Timed Out', { statusCode: 408 })), 408)
	assert.equal(getCodeFromWSError(new Error('Timed Out')), 408)
	assert.equal(getCodeFromWSError(new Error('Unexpected server response: 502')), 502)
	assert.equal(getCodeFromWSError(new Error('boom')), 500)
})

// --- HB-2026-1112-79 addendum + HB-334 addendum (export facet) ---
// Shared t0736-style offline socket: a real makeWASocket with a
// stubbed transport (frames recorded, isOpen forced true), a
// pre-seeded device cache and an injected E2E session for the peer,
// so relayMessage reaches its retry branch. NOTE: this harness never
// fires 'open', so validateConnection never starts and the HB-213
// gate (handshakeStarted) stays off — valid sends DO reach the
// recorded frames here, exactly as the t0736 harness proved.

const makeRelaySocket = async () => {
	const dir = tmpDir('aunu-36-relay-')
	const { state } = await lib.useMultiFileAuthState(dir)
	state.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
	state.creds.registered = true
	const userDevicesCache = makeCacheStore({ stdTTL: 300, maxEntries: 1000 })
	userDevicesCache.set(ME_USER, [{ user: ME_USER, device: 0, server: 's.whatsapp.net' }])
	userDevicesCache.set(PEER_USER, [{ user: PEER_USER, device: 0, server: 's.whatsapp.net' }])
	const sock = lib.makeWASocket({
		auth: state, logger: silentLogger,
		browser: ['HB-Test', 'Chrome', '1.0'],
		markOnlineOnConnect: false, fireInitQueries: false,
		shouldSyncHistoryMessage: () => false,
		connectTimeoutMs: 800, defaultQueryTimeoutMs: 300,
		keepAliveIntervalMs: 3_600_000,
		banSentinel: false,
		enableRecentMessageCache: true, emitOwnEvents: false,
		userDevicesCache
	})
	const frames = []
	const fake = { send: (data, cb) => { frames.push(Buffer.from(data)); cb && cb() }, close: () => {} }
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	await sock.signalRepository.injectE2ESession({ jid: PEER, session: bundleFor() })
	return { sock, frames }
}

test('HB-2026-1112-79 addendum: relayMessage with a participant without count rejects Boom 400, not a raw TypeError', async () => {
	const { sock } = await makeRelaySocket()
	try {
		await assert.rejects(
			() => sock.relayMessage(PEER, { conversation: 't1-no-count' }, { messageId: 'T1MSGID00000000001', participant: { jid: PEER } }),
			boom400_36('Invalid retry participant count')
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-2026-1112-79 addendum: relayMessage with count NaN rejects Boom 400 (no count="NaN" on the wire)', async () => {
	const { sock } = await makeRelaySocket()
	try {
		await assert.rejects(
			() => sock.relayMessage(PEER, { conversation: 't2-nan-count' }, { messageId: 'T2MSGID00000000002', participant: { jid: PEER, count: NaN } }),
			boom400_36('Invalid retry participant count: NaN')
		)
	} finally {
		endQuietly(sock)
	}
})

const nodesSince36 = async (frames, fromIdx) => {
	const out = []
	for (const buf of frames.slice(fromIdx)) {
		try {
			const payload = buf[0] === 0x57 && buf[1] === 0x41 ? buf.subarray(7) : buf.subarray(3)
			const node = await decodeBinaryNode(payload)
			if (node) out.push(node)
		} catch {}
	}

	return out
}

test('HB-2026-1112-79 addendum (control): relayMessage with count 1 sends <enc count="1">', async () => {
	const { sock, frames } = await makeRelaySocket()
	try {
		const mark = frames.length
		const msgId = await withTimeout36(
			sock.relayMessage(PEER, { conversation: 't3-count-1' }, { messageId: 'T3MSGID00000000003', participant: { jid: PEER, count: 1 } }),
			10_000, 'relayMessage'
		)
		assert.equal(msgId, 'T3MSGID00000000003')
		const nodes = await nodesSince36(frames, mark)
		const msgNode = nodes.find(n => n.tag === 'message' && n.attrs?.id === 'T3MSGID00000000003')
		assert.ok(msgNode, 'the retry <message> stanza must be sent')
		const enc = (msgNode.content || []).filter(c => typeof c === 'object').find(k => k.tag === 'enc')
		assert.equal(enc?.attrs?.count, '1')
	} finally {
		endQuietly(sock)
	}
})

test('HB-334 addendum (export facet): sendReceipt sender with an undefined participant rejects Boom 400', async () => {
	const { sock } = await makeRelaySocket()
	try {
		await assert.rejects(
			() => sock.sendReceipt(PEER, undefined, ['3EB035427001'], 'sender'),
			boom400_36('missing participant')
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-334 addendum (export facet, control): sendReceipt sender with a participant sends a receipt with `to`', async () => {
	const { sock, frames } = await makeRelaySocket()
	try {
		await withTimeout36(sock.sendReceipt(PEER, ME, ['3EB035427001'], 'sender'), 10_000, 'sendReceipt')
		const nodes = await nodesSince36(frames, 0)
		const receipt = nodes.find(n => n.tag === 'receipt' && n.attrs?.id === '3EB035427001')
		assert.ok(receipt, 'the receipt stanza must be sent')
		assert.equal(receipt.attrs?.to, ME)
		assert.equal(receipt.attrs?.recipient, PEER)
	} finally {
		endQuietly(sock)
	}
})
