// AunuBaileys 2.3.0 batch regressions — cluster B (signal/session/sender-key):
// HB-338, HB-371 (+ addendum jalur dekripsi + faset 2 Bad MAC 'msg'),
// HB-350 addendum 1-1 + addendum grup, HB-374, HB-375, HB-377, HB-378,
// HB-380, HB-345 addendum, HB-358 cermin + faset ke-3 (konkuren),
// HB-395, HB-94 addendum (+ keyed-state), HB-398, HB-2026-1112-40 #3.
// Each test names the HB item it locks in and fails without its fix.
// Everything runs offline against the built lib/: sockets are pointed
// at a dead local WS URL and transports are fakes, so no test touches WA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import util from 'node:util'
import { createRequire } from 'node:module'
import { lib, makeAuthState, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, waitFor, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { GroupSessionBuilder } from '../lib/Signal/Group/group-session-builder.js'
import { GroupCipher } from '../lib/Signal/Group/group_cipher.js'
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js'
import { SenderKeyDistributionMessage } from '../lib/Signal/Group/sender-key-distribution-message.js'
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { MessageRetryManager, RetryReason } from '../lib/Utils/message-retry-manager.js'
import { makeCacheStore } from '../lib/Utils/internal-cache.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { unpadRandomMax16 } from '../lib/Utils/generics.js'
import * as WAProtoMod from '../WAProto/index.js'

// WAProto was regenerated for 2.3.0 from @wppconnect/wa-proto@
// 2.3000.1055258835 with the upstream export renamed proto ->
// waproto (see release-2.3.0/proto-diff.md). The local alias stays
// `proto` so the assertions below read unchanged.
const proto = WAProtoMod.waproto

const require = createRequire(import.meta.url)
const libsignal = require('libsignal')

// No real connection attempts anywhere in this file: construction
// must never race a dead-port error into end() mid-test.
WebSocketClient.prototype.connect = () => {}

const GROUP = '120363012345678@g.us'
const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_LID = '111222333444555@lid'
const PEER_USER = '628987654321'
const ME_USER = '628123456789'

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
	details: Buffer.from(proto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
	accountSignatureKey: randomBytes(32),
	accountSignature: randomBytes(64)
})

// Multi-file repo over a temp dir; the raw keys object is returned
// so tests can inject store faults/delays underneath the transaction
// wrapper (in-tx reads go through the raw store, so patching the
// wrapper alone would miss them).
const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

// X3DH bundle for injectE2ESession (t0514 recipe).
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

// Peer sender-key material minted against an object-identity store,
// exactly like the run-0231 harness (test 12). senderUser is the
// raw Signal user id (e.g. '628999888777' or '100000123456789_1').
const mintPeerMaterial = async (senderUser, deviceId = 0) => {
	const sender = { id: senderUser, deviceId, toString: () => `${senderUser}.${deviceId}` }
	const name = new SenderKeyName(GROUP, sender)
	const peerDb = new Map()
	const peerStore = {
		loadSenderKey: async n => peerDb.get(n.toString()) || new SenderKeyRecord(),
		storeSenderKey: async (n, r) => {
			peerDb.set(n.toString(), r)
		}
	}
	const skdm = await new GroupSessionBuilder(peerStore).create(name)
	const ciphertext = await new GroupCipher(peerStore, name).encrypt(Buffer.from('peer says hi'))
	return { skdm, ciphertext }
}

// A bundle the INITIATOR can inject, minted from the RECIPIENT's
// own identity + signed prekey, with the prekey stored in the
// recipient's store — otherwise the receiver's initIncoming throws
// 'Invalid PreKey ID' (a bare bundleFor() owns no stored prekey).
const mintIncomingBundle = async (state, preKeyId = 11) => {
	const creds = state.creds
	const pre = Curve.generateKeyPair()
	await state.keys.set({ 'pre-key': { [preKeyId]: { private: pre.private, public: pre.public } } })
	return {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: { keyId: creds.signedPreKey.keyId, publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public), signature: creds.signedPreKey.signature },
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pre.public) }
	}
}

// In-memory keys with a passthrough transaction (t0542 recipe) —
// lets a repo run without the multi-file store, and lets a test
// fault a single key type synchronously inside a call.
const memKeys = fault => {
	const mem = new Map()
	return {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) {
				const v = mem.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		set: async data => {
			for (const [type, rec] of Object.entries(data)) {
				if (fault?.on && type === 'sender-key') throw new Error('SIMULATED-STORE-FAILURE')
				for (const [k, v] of Object.entries(rec)) {
					if (v === null || v === undefined) mem.delete(`${type}:${k}`)
					else mem.set(`${type}:${k}`, v)
				}
			}
		},
		transaction: async work => work(),
		_mem: mem
	}
}

const credsFor = id => ({
	me: { id, lid: '100000000000001@lid' },
	registrationId: 4242,
	signedPreKey: { keyId: 1, keyPair: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) }, signature: Buffer.alloc(64, 3) },
	signedIdentityKey: { public: Buffer.alloc(32, 4), private: Buffer.alloc(32, 5) },
	nextPreKeyId: 1,
	firstUnuploadedPreKeyId: 1
})

const decodeSentFrames = async frames => {
	const nodes = []
	for (const buf of frames) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		nodes.push(await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len)))
	}
	return nodes
}

const retryReceipts = async frames =>
	(await decodeSentFrames(frames)).filter(n => n.tag === 'receipt' && n.attrs.type === 'retry')

// Offline socket with a working send path (t0505 recipe): device
// caches pre-populated so no USync query ever leaves, sessions
// injected for the peer's devices and our own companion, and an
// encryptMessage spy that records the plaintext actually encrypted.
const MARK = ' [PATCHED]'
const makeRetryEnv = async patchHook => {
	const { state } = await makeAuthState()
	state.creds.me = { id: ME, lid: ME_LID }
	state.creds.registered = true
	const userDevicesCache = makeCacheStore({ stdTTL: 300, maxEntries: 1000 })
	// AunuBaileys (2.7.0, HB-489): the device cache is keyed by the
	// normalised JID (user + server), not the bare user — the old
	// bare-user keys missed and every send fell through to a USync
	// query that never answers on this offline socket.
	userDevicesCache.set(PEER, [{ user: PEER_USER, device: 0, server: 's.whatsapp.net' }])
	userDevicesCache.set(ME, [
		{ user: ME_USER, device: 0, server: 's.whatsapp.net' },
		{ user: ME_USER, device: 1, server: 's.whatsapp.net' }
	])
	const frames = []
	const sock = lib.makeWASocket({
		auth: state,
		logger: silentLogger,
		waWebSocketUrl: 'ws://127.0.0.1:9/ws/chat',
		connectTimeoutMs: 800,
		defaultQueryTimeoutMs: 800,
		keepAliveIntervalMs: 3_600_000,
		markOnlineOnConnect: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		generateHighQualityLinkPreview: false,
		banSentinel: false,
		enableRecentMessageCache: true,
		emitOwnEvents: false,
		userDevicesCache,
		patchMessageBeforeSending: patchHook,
		browser: ['aunu-230', 'test', '1']
	})
	fakeOpenTransport(sock, frames)
	// The forced bundle fetch inside sendMessagesAgain
	// (assertSessions(..., true)) always asks the server; offline
	// it can only time out, so no receipt-driven resend could ever
	// be observed. Answer the encrypt IQ at the transport level
	// with an empty bundle list — "no new bundles" — and the
	// resend proceeds on the sessions already injected. The
	// response is delivered on the TAG:<id> channel waitForMessage
	// listens on, exactly as a live server reply would arrive.
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		try {
			const buf = Buffer.from(data)
			let off = 0
			if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
			const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
			decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
				.then(node => {
					if (node?.tag === 'iq' && node.attrs?.xmlns === 'encrypt' && node.attrs?.type === 'get') {
						sock.ws.emit(`TAG:${node.attrs.id}`, {
							tag: 'iq',
							attrs: { type: 'result', id: node.attrs.id },
							content: [{ tag: 'list', attrs: {}, content: [] }]
						})
					}
				})
				.catch(() => {})
		} catch {}
	}
	await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:0@s.whatsapp.net`, session: bundleFor() })
	await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:1@s.whatsapp.net`, session: bundleFor() })
	await sock.signalRepository.injectE2ESession({ jid: `${ME_USER}:1@s.whatsapp.net`, session: bundleFor() })
	const encRecords = []
	const origEncrypt = sock.signalRepository.encryptMessage.bind(sock.signalRepository)
	sock.signalRepository.encryptMessage = async args => {
		const out = await origEncrypt(args)
		try {
			const decoded = proto.Message.decode(unpadRandomMax16(Buffer.from(args.data)))
			const inner = decoded?.deviceSentMessage?.message
			const conv =
				decoded?.extendedTextMessage?.text ??
				decoded?.conversation ??
				inner?.extendedTextMessage?.text ??
				inner?.conversation ??
				null
			encRecords.push({ jid: args.jid, type: out.type, conversation: conv })
		} catch (e) {
			encRecords.push({ jid: args.jid, type: out.type, decodeErr: String(e) })
		}
		return out
	}
	return { sock, state, frames, encRecords, userDevicesCache }
}

const patchHook = counter => async msg => {
	counter.calls++
	if (typeof msg?.extendedTextMessage?.text === 'string') {
		return { ...msg, extendedTextMessage: { ...msg.extendedTextMessage, text: msg.extendedTextMessage.text + MARK } }
	}
	if (typeof msg?.conversation === 'string') return { ...msg, conversation: msg.conversation + MARK }
	return msg
}

const hasMark = r => typeof r.conversation === 'string' && r.conversation.includes(MARK)

const msgStanza = (id, ciphertext) => ({
	tag: 'message',
	attrs: { id, from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: ciphertext }]
})

const receiptStanza = ({ from, participant, id, count, error }) => ({
	tag: 'receipt',
	attrs: { from, ...(participant ? { participant } : {}), id, type: 'retry', t: String(Math.floor(Date.now() / 1000)) },
	content: [
		{
			tag: 'retry',
			attrs: { count: String(count), id, t: String(Math.floor(Date.now() / 1000)), v: '1', ...(error !== undefined ? { error: String(error) } : {}) }
		}
	]
})

// ── HB-338: SessionEntry prototype redaction ──────────────────────

test('HB-338: util.inspect/JSON.stringify of a live SessionEntry expose no key material', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-338-'))
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	const addr = repo.jidToSignalProtocolAddress(PEER)
	const { [addr]: stored } = await state.keys.get('session', [addr])
	assert.ok(stored, 'session record was not stored')
	const record = libsignal.SessionRecord.deserialize(stored)
	const entry = record.getOpenSession()
	assert.ok(entry, 'injected session has no open SessionEntry')
	// The entry genuinely holds key material (serialize proves it —
	// libsignal's serialize() returns a {_sessions, version} object).
	const serialized = record.serialize()
	assert.ok(Object.keys(serialized._sessions).length > 0, 'session serializes empty')
	const inspected = util.inspect(entry)
	const json = JSON.stringify(entry)
	for (const leak of ['rootKey', 'chainKey', 'privKey', 'messageKeys', 'currentRatchet', 'ephemeralKeyPair']) {
		assert.ok(!inspected.includes(leak), `util.inspect leaks ${leak}: ${inspected.slice(0, 200)}`)
		assert.ok(!json.includes(leak), `JSON.stringify leaks ${leak}: ${json.slice(0, 200)}`)
	}
	// The redacted form is the entry's own toString (public base key only).
	assert.equal(json, JSON.stringify(entry.toString()), 'JSON form must be exactly the public toString()')
})

test('HB-338: session operations are unchanged by the redaction (serialize round-trips, pkmsg decrypts)', async () => {
	const dir = tmpDir('aunu-230-338b-')
	const { repo: alice, state: aliceState } = await makeRepo(dir + '-a')
	const { repo: bob } = await makeRepo(dir + '-b')
	await bob.injectE2ESession({ jid: ME, session: await mintIncomingBundle(aliceState) })
	const pk = await bob.encryptMessage({ jid: ME, data: Buffer.from('hello-338') })
	const pt = await alice.decryptMessage({ jid: PEER, type: pk.type, ciphertext: pk.ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'hello-338')
	// A second message over the same session still works (ratchet intact).
	const m2 = await bob.encryptMessage({ jid: ME, data: Buffer.from('hello-338-2') })
	const pt2 = await alice.decryptMessage({ jid: PEER, type: m2.type, ciphertext: m2.ciphertext })
	assert.equal(Buffer.from(pt2).toString(), 'hello-338-2')
})

// ── HB-371 (+ addendum jalur dekripsi) ────────────────────────────

test('HB-371: a transient session-store failure surfaces as itself, never as "No session record"', async () => {
	const { repo, rawKeys } = await makeRepo(tmpDir('aunu-230-371-'))
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	assert.deepEqual((await repo.validateSession(PEER)).exists, true, 'setup session missing')
	const origGet = rawKeys.get.bind(rawKeys)
	rawKeys.get = async (type, ids) => {
		if (type === 'session') throw new Error('SQLITE_BUSY: database is locked (simulated transient read failure)')
		return origGet(type, ids)
	}
	try {
		// Decrypt rejects with the store's own text — it must not be
		// rewritten into a session-error the classifier would eat.
		await assert.rejects(
			repo.decryptMessage({ jid: PEER, type: 'msg', ciphertext: Buffer.alloc(32, 3) }),
			/SQLITE_BUSY/,
			'decrypt must surface the transient store error'
		)
		// validateSession reports the uncertainty instead of "no session".
		assert.deepEqual(await repo.validateSession(PEER), { exists: false, reason: 'validation error' })
		// The read-only probe keeps its old contract.
		assert.equal(await repo.getSessionInfo(PEER), null)
	} finally {
		rawKeys.get = origGet
	}
	// After the fault clears, the healthy session is still there.
	assert.deepEqual((await repo.validateSession(PEER)).exists, true, 'healthy session must survive a transient read failure')
})

test('HB-371: a corrupt stored session deserialises to null (absent), not a throw', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-371b-'))
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	const addr = repo.jidToSignalProtocolAddress(PEER)
	// A record whose bytes cannot deserialise at all (unknown
	// version → libsignal's migrate throws) reads as absent.
	await state.keys.set({ session: { [addr]: { version: 'v99', _sessions: {} } } })
	assert.deepEqual(await repo.validateSession(PEER), { exists: false, reason: 'no session' }, 'undeserialisable record must read as absent')
	// Junk bytes deserialise to an empty record instead (libsignal
	// swallows them in migrate) — still absent, never a throw.
	await state.keys.set({ session: { [addr]: Buffer.from('this is not a session record') } })
	assert.equal((await repo.validateSession(PEER)).exists, false, 'junk-byte record must not validate')
})

// ── HB-350 addendum 1-1 ───────────────────────────────────────────

test('HB-350 addendum 1-1: a failing post-decrypt saveIdentity keeps the plaintext', async () => {
	const { repo: alice } = await makeRepo(tmpDir('aunu-230-350a-'))
	const { repo: bob, state: bobState } = await makeRepo(tmpDir('aunu-230-350b-'))
	await alice.injectE2ESession({ jid: PEER, session: await mintIncomingBundle(bobState) })
	const pk = await alice.encryptMessage({ jid: PEER, data: Buffer.from('hello-350') })
	assert.equal(pk.type, 'pkmsg', 'setup did not produce a pkmsg')
	// Fault only the identity-key write: libsignal never calls
	// saveIdentity itself, so the only set carrying 'identity-key'
	// is the post-decrypt bookkeeping call.
	const wrappedSet = bobState.keys.set.bind(bobState.keys)
	bobState.keys.set = async data => {
		if (data && 'identity-key' in data) throw new Error('SIMULATED-IDENTITY-STORE-FAILURE')
		return wrappedSet(data)
	}
	try {
		const pt = await bob.decryptMessage({ jid: ME, type: pk.type, ciphertext: pk.ciphertext })
		assert.equal(Buffer.from(pt).toString(), 'hello-350', 'plaintext must survive a failing saveIdentity')
	} finally {
		bobState.keys.set = wrappedSet
	}
})

// ── HB-377 + HB-378 ───────────────────────────────────────────────

test('HB-377: deleteSession([PN]) removes the session that lives under the LID wire key', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-230-377-'))
	await repo.lidMapping.storeLIDPNMappings([{ pn: PEER, lid: PEER_LID }])
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	assert.equal((await repo.validateSession(PEER)).exists, true, 'session under PN must exist')
	assert.equal((await repo.validateSession(PEER_LID)).exists, true, 'same session must resolve under LID')
	await repo.deleteSession([PEER])
	assert.deepEqual(await repo.validateSession(PEER), { exists: false, reason: 'no session' })
	assert.deepEqual(await repo.validateSession(PEER_LID), { exists: false, reason: 'no session' }, 'LID-keyed record must be deleted too')
})

test('HB-378: a stored lid-mapping value that is not a digit user id is a miss, not a mapping', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	await keys.set({ 'lid-mapping': { 628999888777: 'garbage!!not-a-lid', '123456789012345_reverse': 'also-garbage!!' } })
	// Cold cache: a fresh store instance, as after a restart.
	const cold = new LIDMappingStore(keys, silentLogger)
	assert.equal(await cold.getLIDForPN('628999888777@s.whatsapp.net'), null, 'garbage forward value must not resolve')
	assert.equal(await cold.getPNForLID('123456789012345@lid'), null, 'garbage reverse value must not resolve')
	// Control: a well-formed digit value still resolves.
	await keys.set({ 'lid-mapping': { 628999888777: '123456789012345', '123456789012345_reverse': '628999888777' } })
	const cold2 = new LIDMappingStore(keys, silentLogger)
	assert.equal(await cold2.getLIDForPN('628999888777@s.whatsapp.net'), '123456789012345@lid')
	assert.equal(await cold2.getPNForLID('123456789012345@lid'), '628999888777:0@s.whatsapp.net')
	mapping.close()
	cold.close()
	cold2.close()
})

// ── HB-380 ────────────────────────────────────────────────────────

test('HB-380: parseRetryErrorCode/isMacError recognise the MAC codes the retry sites now pass', () => {
	const mgr = new MessageRetryManager(silentLogger, 5)
	assert.equal(mgr.parseRetryErrorCode('7'), RetryReason.SignalErrorBadMac)
	assert.equal(mgr.parseRetryErrorCode('4'), RetryReason.SignalErrorInvalidMessage)
	assert.equal(mgr.parseRetryErrorCode(undefined), undefined)
	assert.equal(mgr.parseRetryErrorCode(''), undefined)
	assert.equal(mgr.parseRetryErrorCode('abc'), undefined)
	assert.equal(mgr.isMacError(RetryReason.SignalErrorBadMac), true)
	assert.equal(mgr.isMacError(RetryReason.SignalErrorInvalidMessage), true)
	assert.equal(mgr.isMacError(RetryReason.SignalErrorNoSession), false)
	assert.equal(mgr.isMacError(undefined), false)
})

test('HB-380: a MAC error recreates the session immediately, bypassing the 1-hour throttle', () => {
	const mgr = new MessageRetryManager(silentLogger, 5)
	const first = mgr.shouldRecreateSession(PEER, true, RetryReason.SignalErrorBadMac)
	assert.equal(first.recreate, true, 'first MAC recreate must fire')
	const second = mgr.shouldRecreateSession(PEER, true, RetryReason.SignalErrorBadMac)
	assert.equal(second.recreate, true, 'a MAC error is always immediate, even inside the throttle window')
	const plain = mgr.shouldRecreateSession(PEER, true)
	assert.equal(plain.recreate, false, 'a plain retry inside the window stays throttled')
})

// ── HB-345 addendum ───────────────────────────────────────────────

test('HB-345 addendum: a loaded SenderKeyRecord keeps only the newest MAX_STATES (5) states', () => {
	const mkState = (id, iter) => ({
		senderKeyId: id,
		senderChainKey: { iteration: iter, seed: Buffer.alloc(32, id).toString('base64') },
		senderSigningKey: { public: Buffer.alloc(32, 7).toString('base64'), private: '' },
		senderMessageKeys: []
	})
	const states = Array.from({ length: 10 }, (_, i) => mkState(i, i * 10))
	const rec = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(states), 'utf-8'))
	const kept = rec.serialize()
	assert.equal(kept.length, 5, 'record must be cut to 5 states on load')
	assert.deepEqual(
		kept.map(s => s.senderKeyId),
		[5, 6, 7, 8, 9],
		'the NEWEST five states must survive'
	)
	assert.equal(rec.getSenderKeyState()?.getKeyId(), 9, 'tail state (used by encrypt) must be the newest')
	// Round-trip is stable at the cap.
	const again = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(kept), 'utf-8'))
	assert.equal(again.serialize().length, 5)
})

// ── HB-350 addendum grup ──────────────────────────────────────────

test('HB-350 addendum grup: GroupCipher.decrypt returns the plaintext when the final storeSenderKey throws', async () => {
	const fault = { on: false }
	const senderRepo = makeLibSignalRepository({ creds: credsFor('6281111111111@s.whatsapp.net'), keys: memKeys() }, silentLogger)
	const receiverRepo = makeLibSignalRepository({ creds: credsFor('6282222222222@s.whatsapp.net'), keys: memKeys(fault) }, silentLogger)
	const skdm = await senderRepo.getSenderKeyDistributionMessage({ group: GROUP, meId: '6281111111111@s.whatsapp.net' })
	await receiverRepo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm },
		authorJid: '6281111111111@s.whatsapp.net'
	})
	const freshCipher = async text =>
		(await senderRepo.encryptGroupMessage({ group: GROUP, meId: '6281111111111@s.whatsapp.net', data: Buffer.from(text) })).ciphertext
	const pt0 = await receiverRepo.decryptGroupMessage({ group: GROUP, authorJid: '6281111111111@s.whatsapp.net', msg: await freshCipher('hello group 0') })
	assert.equal(Buffer.from(pt0).toString(), 'hello group 0', 'control decrypt must work')
	fault.on = true
	try {
		const pt1 = await receiverRepo.decryptGroupMessage({ group: GROUP, authorJid: '6281111111111@s.whatsapp.net', msg: await freshCipher('hello group 1') })
		assert.equal(Buffer.from(pt1).toString(), 'hello group 1', 'good plaintext must survive a failing storeSenderKey')
	} finally {
		fault.on = false
	}
	senderRepo.close()
	receiverRepo.close()
})

// ── HB-358 cermin + faset ke-3 (konkuren) ─────────────────────────

test('HB-358 cermin: remapping a LID to a new PN retires the old PN forward entry', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	const PN_A = '6281111111111@s.whatsapp.net'
	const PN_B = '6282222222222@s.whatsapp.net'
	const LID = '123456789012345@lid'
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID }])
	assert.equal(await mapping.getLIDForPN(PN_A), LID)
	await mapping.storeLIDPNMappings([{ pn: PN_B, lid: LID }])
	assert.equal(await mapping.getPNForLID(LID), '6282222222222:0@s.whatsapp.net', 'reverse must point at the new PN')
	assert.equal(await mapping.getLIDForPN(PN_A), null, 'dead PN must stop resolving to the LID')
	assert.equal(keys._mem.get('lid-mapping:6281111111111'), undefined, 'old forward entry must be gone from the store')
	mapping.close()
})

test('HB-358 faset ke-3: two concurrent remaps of one PN leave no stale loser reverse (run-0572)', async () => {
	const store = {}
	const rawKeys = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) if (store[`${type}:${id}`] !== undefined) out[id] = store[`${type}:${id}`]
			return out
		},
		async set(data) {
			for (const type in data) for (const id in data[type]) {
				if (data[type][id] === null) delete store[`${type}:${id}`]
				else store[`${type}:${id}`] = data[type][id]
			}
		}
	}
	const keys = addTransactionCapability(rawKeys, silentLogger)
	const PN = '6281111111111@s.whatsapp.net'
	const L1 = '111111111111111@lid'
	const L2 = '222222222222222@lid'
	const L3 = '333333333333333@lid'
	const userOf = jid => jid.split('@')[0]
	// T1 control (sequential): clean.
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN, lid: L1 }])
	await mapping.storeLIDPNMappings([{ pn: PN, lid: L2 }])
	await mapping.storeLIDPNMappings([{ pn: PN, lid: L3 }])
	assert.equal(store[`lid-mapping:${userOf(L2)}_reverse`], undefined, 'sequential control: loser reverse must be gone')
	// T2 race: reset to L1, then fire both remaps concurrently.
	for (const k of Object.keys(store)) delete store[k]
	const mapping2 = new LIDMappingStore(keys, silentLogger)
	await mapping2.storeLIDPNMappings([{ pn: PN, lid: L1 }])
	await Promise.all([
		mapping2.storeLIDPNMappings([{ pn: PN, lid: L2 }]),
		mapping2.storeLIDPNMappings([{ pn: PN, lid: L3 }])
	])
	const forward = await mapping2.getLIDForPN(PN)
	const winner = forward === L2 ? L2 : L3
	const loser = forward === L2 ? L3 : L2
	assert.equal(store[`lid-mapping:${userOf(loser)}_reverse`], undefined, `race: loser ${loser} reverse must not survive in the store`)
	assert.equal(store[`lid-mapping:${userOf(winner)}_reverse`], '6281111111111', 'race: winner reverse must point at the PN')
	// T2b cold cache: a fresh instance over the same keys must not resolve the loser.
	const mappingCold = new LIDMappingStore(keys, silentLogger)
	assert.equal(await mappingCold.getPNForLID(loser), null, 'race: cold read of the loser LID must be null')
	assert.equal(await mappingCold.getPNForLID(winner), '6281111111111:0@s.whatsapp.net', 'race: cold read of the winner LID must resolve')
	mapping.close()
	mapping2.close()
	mappingCold.close()
})

// ── HB-395 ────────────────────────────────────────────────────────

test('HB-395: migrateSession migrates hosted peers, including device 99', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-395-'))
	await repo.injectE2ESession({ jid: '628999888777@hosted', session: bundleFor() })
	await repo.injectE2ESession({ jid: '628999888777:99@hosted', session: bundleFor() })
	await state.keys.set({ 'device-list': { 628999888777: ['0', '99'] } })
	// The LID target for a hosted peer is @hosted.lid (the ledger
	// harness's T2) — device 99 only exists in the hosted domain,
	// and jidToSignalProtocolAddress rejects ':99@lid'.
	const result = await repo.migrateSession('628999888777@hosted', '100000123456789@hosted.lid')
	assert.equal(result.migrated, 2, `expected 2 migrated sessions, got ${JSON.stringify(result)}`)
	assert.equal((await repo.validateSession('100000123456789@hosted.lid')).exists, true, 'migrated device-0 session must validate under hosted LID')
	assert.equal((await repo.validateSession('100000123456789:99@hosted.lid')).exists, true, 'migrated device-99 session must validate under hosted LID')
	assert.deepEqual(await repo.validateSession('628999888777@hosted'), { exists: false, reason: 'no session' }, 'PN device-0 session must be gone after migration')
	assert.deepEqual(await repo.validateSession('628999888777:99@hosted'), { exists: false, reason: 'no session' }, 'PN device-99 session must be gone after migration')
})

test('HB-395 residue: an unbuildable migration target skips that device instead of aborting the whole migration', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-395r-'))
	await repo.injectE2ESession({ jid: '628999888777@hosted', session: bundleFor() })
	await repo.injectE2ESession({ jid: '628999888777:99@hosted', session: bundleFor() })
	await state.keys.set({ 'device-list': { 628999888777: ['0', '99'] } })
	// Target is a plain @lid: device 99 has no wire address there
	// (jidToSignalProtocolAddress rejects ':99@lid'), so pre-fix the
	// address build threw inside the migration transaction and even
	// the buildable device-0 session never migrated.
	const result = await repo.migrateSession('628999888777@hosted', '100000123456789@lid')
	assert.equal(result.migrated, 1, `expected only the buildable device to migrate, got ${JSON.stringify(result)}`)
	assert.equal(result.total, 1, `unbuildable target must be excluded from the op count, got ${JSON.stringify(result)}`)
	assert.equal((await repo.validateSession('100000123456789@lid')).exists, true, 'device-0 session must validate under the LID')
	assert.deepEqual(await repo.validateSession('628999888777@hosted'), { exists: false, reason: 'no session' }, 'PN device-0 session must be gone after migration')
	assert.equal((await repo.validateSession('628999888777:99@hosted')).exists, true, 'unbuildable device-99 session must be left untouched')
})

// ── HB-94 addendum (tx-key) ───────────────────────────────────────

const establishPair = async (aRes, bRes, alicePn, bobPn) => {
	await bRes.repo.injectE2ESession({ jid: alicePn, session: await mintIncomingBundle(aRes.state) })
	const pk1 = await bRes.repo.encryptMessage({ jid: alicePn, data: Buffer.from('bob-hello') })
	await aRes.repo.decryptMessage({ jid: bobPn, type: pk1.type, ciphertext: pk1.ciphertext })
	const pk2 = await aRes.repo.encryptMessage({ jid: bobPn, data: Buffer.from('alice-hello') })
	await bRes.repo.decryptMessage({ jid: alicePn, type: pk2.type, ciphertext: pk2.ciphertext })
}

test('HB-94: concurrent decrypt-via-LID + encrypt-via-PN on one session lose no ratchet advance', async () => {
	const ALICE_PN = '6281111111111@s.whatsapp.net'
	const ALICE_LID = '100000111111111@lid'
	const BOB_PN = '6282222222222@s.whatsapp.net'
	const alice = await makeRepo(tmpDir('aunu-230-94a-'))
	const bob = await makeRepo(tmpDir('aunu-230-94b-'))
	await bob.repo.lidMapping.storeLIDPNMappings([{ pn: ALICE_PN, lid: ALICE_LID }])
	await establishPair(alice, bob, ALICE_PN, BOB_PN)
	// Widen the race window: every session read/write costs 15ms,
	// so a decrypt and an encrypt fired together overlap unless
	// they share one transaction key. Pre-fix the two spellings
	// keyed different mutexes and the last commit won, losing the
	// other side's chain advance (a reused send counter then
	// fails the peer's decrypt with a Bad MAC); post-fix both
	// spellings serialise on the resolved wire address.
	const delay = ms => new Promise(r => setTimeout(r, ms))
	const origGet = bob.rawKeys.get.bind(bob.rawKeys)
	const origSet = bob.rawKeys.set.bind(bob.rawKeys)
	bob.rawKeys.get = async (type, ids) => {
		if (type === 'session') await delay(15)
		return origGet(type, ids)
	}
	bob.rawKeys.set = async data => {
		if (data.session) await delay(15)
		return origSet(data)
	}
	try {
		for (let i = 0; i < 5; i++) {
			const incoming = await alice.repo.encryptMessage({ jid: BOB_PN, data: Buffer.from(`alice-${i}`) })
			const [pt, reply] = await Promise.all([
				bob.repo.decryptMessage({ jid: ALICE_LID, type: incoming.type, ciphertext: incoming.ciphertext }),
				bob.repo.encryptMessage({ jid: ALICE_PN, data: Buffer.from(`bob-${i}`) })
			])
			assert.equal(Buffer.from(pt).toString(), `alice-${i}`, `round ${i}: LID-spelled decrypt must return its plaintext`)
			const back = await alice.repo.decryptMessage({ jid: BOB_PN, type: reply.type, ciphertext: reply.ciphertext })
			assert.equal(Buffer.from(back).toString(), `bob-${i}`, `round ${i}: PN-spelled encrypt must survive the race (no reused counter)`)
		}
		const fin = await alice.repo.encryptMessage({ jid: BOB_PN, data: Buffer.from('alice-final') })
		const finPt = await bob.repo.decryptMessage({ jid: ALICE_LID, type: fin.type, ciphertext: fin.ciphertext })
		assert.equal(Buffer.from(finPt).toString(), 'alice-final')
		const finBack = await bob.repo.encryptMessage({ jid: ALICE_PN, data: Buffer.from('bob-final') })
		const finBackPt = await alice.repo.decryptMessage({ jid: BOB_PN, type: finBack.type, ciphertext: finBack.ciphertext })
		assert.equal(Buffer.from(finBackPt).toString(), 'bob-final')
	} finally {
		bob.rawKeys.get = origGet
		bob.rawKeys.set = origSet
	}
})

test('HB-94 (control): the same storm with one spelling throughout also passes', async () => {
	const ALICE_PN = '6281111111111@s.whatsapp.net'
	const BOB_PN = '6282222222222@s.whatsapp.net'
	const alice = await makeRepo(tmpDir('aunu-230-94c-'))
	const bob = await makeRepo(tmpDir('aunu-230-94d-'))
	await establishPair(alice, bob, ALICE_PN, BOB_PN)
	const delay = ms => new Promise(r => setTimeout(r, ms))
	const origGet = bob.rawKeys.get.bind(bob.rawKeys)
	const origSet = bob.rawKeys.set.bind(bob.rawKeys)
	bob.rawKeys.get = async (type, ids) => {
		if (type === 'session') await delay(15)
		return origGet(type, ids)
	}
	bob.rawKeys.set = async data => {
		if (data.session) await delay(15)
		return origSet(data)
	}
	try {
		for (let i = 0; i < 5; i++) {
			const incoming = await alice.repo.encryptMessage({ jid: BOB_PN, data: Buffer.from(`alice-${i}`) })
			const [pt, reply] = await Promise.all([
				bob.repo.decryptMessage({ jid: ALICE_PN, type: incoming.type, ciphertext: incoming.ciphertext }),
				bob.repo.encryptMessage({ jid: ALICE_PN, data: Buffer.from(`bob-${i}`) })
			])
			assert.equal(Buffer.from(pt).toString(), `alice-${i}`)
			const back = await alice.repo.decryptMessage({ jid: BOB_PN, type: reply.type, ciphertext: reply.ciphertext })
			assert.equal(Buffer.from(back).toString(), `bob-${i}`)
		}
	} finally {
		bob.rawKeys.get = origGet
		bob.rawKeys.set = origSet
	}
})

// ── HB-94 keyed-state (socket) ────────────────────────────────────

test('HB-94 keyed-state: the recreate throttle is shared across the PN and LID spellings of one peer', async () => {
	const deleteSessionCalls = []
	const { sock } = await makeRetryEnv(undefined)
	const origDelete = sock.signalRepository.deleteSession.bind(sock.signalRepository)
	sock.signalRepository.deleteSession = async jids => {
		deleteSessionCalls.push([...jids])
		return origDelete(jids)
	}
	try {
		await sock.signalRepository.lidMapping.storeLIDPNMappings([{ pn: PEER, lid: PEER_LID }])
		// The mapping moves the wire address: sessions injected
		// before it landed under the PN key and would miss now, so
		// re-establish them under the LID wire key.
		await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:0@s.whatsapp.net`, session: bundleFor() })
		await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:1@s.whatsapp.net`, session: bundleFor() })
		const sent = await sock.sendMessage(PEER, { text: 'hello-94ks' })
		const msgId = sent.key.id
		// Receipt 1, PN spelling, count 2, no MAC code: first recreate fires.
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER, participant: `${PEER_USER}:1@s.whatsapp.net`, id: msgId, count: 2 }))
		assert.equal(await waitFor(() => deleteSessionCalls.length >= 1, 8000), true, 'first receipt must recreate the session')
		await sleep(1500)
		// Re-establish the session so the second receipt has one to validate.
		await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:1@s.whatsapp.net`, session: bundleFor() })
		assert.equal((await sock.signalRepository.validateSession(`${PEER_USER}:1@s.whatsapp.net`)).exists, true)
		// Receipt 2, LID spelling of the SAME peer, count 2, no MAC
		// code: the canonical key is the same, so the 1-hour
		// throttle refuses a second recreation.
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER_LID, participant: '111222333444555:1@lid', id: msgId, count: 2 }))
		await sleep(1500)
		assert.equal(deleteSessionCalls.length, 1, 'the LID-spelled receipt must hit the same throttle entry, not recreate again')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-398 ────────────────────────────────────────────────────────

test('HB-398: our sender-key name in a LID group carries our own device, and a phone SKDM cannot evict it', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-398-'))
	state.creds.me = { id: '628123456789:42@s.whatsapp.net', lid: ME_LID }
	const r1 = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398-1') })
	assert.ok(r1.ciphertext.length > 0, 'first group encrypt produced no ciphertext')
	// The record must live under the device-42 name, not device 0.
	const wire42 = repo.jidToSignalProtocolAddress('100000123456789:42@lid')
	const [idPart, devPart] = wire42.split('.')
	const key42 = `${GROUP}::${idPart}::${devPart}`
	const key0 = `${GROUP}::${idPart}::0`
	const { [key42]: ours } = await state.keys.get('sender-key', [key42])
	assert.ok(ours, `our sender-key record must live under the device-42 name ${key42}`)
	const { [key0]: phoneName } = await state.keys.get('sender-key', [key0])
	assert.ok(!phoneName, 'no record must exist under the device-0 (phone) name')
	assert.equal(await repo.hasSenderKey({ group: GROUP, meId: ME_LID }), true)
	// The phone's own SKDM for the same LID (device 0) arrives and
	// is processed into the SEPARATE device-0 record...
	const { skdm } = await mintPeerMaterial('100000123456789_1', 0)
	await repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm.serialize() },
		authorJid: ME_LID
	})
	// ...and our next encrypt still uses OUR state (pre-fix it threw
	// 'Incorrect private key length: 0' — the phone state had become
	// the tail of our own record).
	const r2 = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398-2') })
	assert.ok(r2.ciphertext.length > 0, 'second encrypt after the phone SKDM must still succeed')
})

// ── HB-398 addendum (legacy poison, t0576 basis) ──────────────────
//
// A record poisoned PRE-2.3.0 (a peer SKDM stored under our own
// name) never heals on its own: decrypt works through the poison
// (chain key + public key suffice), so the decrypt self-heal never
// fires, while every encrypt throws 'Incorrect private key length:
// 0'. The 2.3.0 heal in ensureSenderKeyAndCreateSkdm drops the
// trailing private-less states before create() runs. These tests
// poison the record through the REPO (process a peer SKDM with
// authorJid = our exact own identity, :42 — the device-less LID
// author in the HB-398 test above addresses device 0 instead),
// then prove the next encrypt succeeds AND which key it uses.

test('HB-398 addendum (legacy poison): a poisoned own record heals on the next encrypt, keeping our healthy state', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-398p-'))
	state.creds.me = { id: '628123456789:42@s.whatsapp.net', lid: ME_LID }
	const key42 = `${GROUP}::100000123456789_1::42`
	// Our own healthy state first, as a pre-2.3.0 user would have.
	const first = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398p-0') })
	assert.ok(first.ciphertext.length > 0, 'setup encrypt produced no ciphertext')
	const ownKeyId = SenderKeyRecord.deserialize((await state.keys.get('sender-key', [key42]))[key42]).getSenderKeyState().getKeyId()
	// The legacy poison: a peer SKDM processed under OUR OWN name.
	const { skdm, ciphertext } = await mintPeerMaterial('100000123456789_1', 0)
	await repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm.serialize() },
		authorJid: '100000123456789:42@lid'
	})
	const poisoned = SenderKeyRecord.deserialize((await state.keys.get('sender-key', [key42]))[key42])
	assert.equal(poisoned.serialize().length, 2, 'setup: poison must be appended as the newest state')
	assert.equal(poisoned.getSenderKeyState().getSigningKeyPrivate().length, 0, 'setup: newest state must carry no signing private')
	// t0576 T2: decrypt through the poisoned record still works.
	const pt = await repo.decryptGroupMessage({ group: GROUP, authorJid: '100000123456789:42@lid', msg: ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'peer says hi', 'decrypt through the poisoned record must still work (that is why it never self-healed)')
	// t0576 T3 (fixed): the next encrypt heals instead of throwing.
	const healed = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398p-1') })
	assert.ok(healed.ciphertext.length > 0, 'encrypt with a poisoned own record must succeed after the heal')
	const after = SenderKeyRecord.deserialize((await state.keys.get('sender-key', [key42]))[key42])
	assert.equal(after.serialize().length, 1, 'the poisoned state must be gone, our state kept')
	assert.equal(after.getSenderKeyState().getKeyId(), ownKeyId, 'encrypt must continue on OUR chain (same key id — no rotation, receivers keep decrypting)')
	assert.equal(after.getSenderKeyState().getSigningKeyPrivate().length, 32, 'surviving state must carry its signing private')
	// And the distributed SKDM is ours, not the poison's.
	assert.equal(
		new SenderKeyDistributionMessage(null, null, null, null, healed.senderKeyDistributionMessage).getId(),
		ownKeyId,
		'distributed SKDM must be our own key'
	)
	// A second encrypt stays healthy (the heal is stable, no re-poison).
	const again = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398p-2') })
	assert.ok(again.ciphertext.length > 0, 'second encrypt after the heal must succeed')
})

test('HB-398 addendum (legacy poison): a record with no surviving own state mints a fresh key on encrypt', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-230-398q-'))
	state.creds.me = { id: '628123456789:42@s.whatsapp.net', lid: ME_LID }
	const key42 = `${GROUP}::100000123456789_1::42`
	// No prior own encrypt: the record holds ONLY the poison (our
	// state was evicted pre-2.3.0 by repeated phone SKDMs, or never
	// created) — the heal must mint a fresh key, not throw.
	const { skdm } = await mintPeerMaterial('100000123456789_1', 0)
	await repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm.serialize() },
		authorJid: '100000123456789:42@lid'
	})
	const poisoned = SenderKeyRecord.deserialize((await state.keys.get('sender-key', [key42]))[key42])
	assert.equal(poisoned.serialize().length, 1, 'setup: record must hold only the poison')
	const poisonKeyId = poisoned.getSenderKeyState().getKeyId()
	assert.equal(poisoned.getSenderKeyState().getSigningKeyPrivate().length, 0, 'setup: poison must carry no signing private')
	const out = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID, data: Buffer.from('hello-398q') })
	assert.ok(out.ciphertext.length > 0, 'encrypt with a fully poisoned own record must succeed with a fresh key')
	const healed = SenderKeyRecord.deserialize((await state.keys.get('sender-key', [key42]))[key42])
	assert.equal(healed.serialize().length, 1, 'healed record must hold exactly the fresh state')
	assert.equal(healed.getSenderKeyState().getSigningKeyPrivate().length, 32, 'fresh state must carry a signing private')
	assert.notEqual(healed.getSenderKeyState().getKeyId(), poisonKeyId, 'fresh key must be a new key id, not the poison')
	assert.equal(
		new SenderKeyDistributionMessage(null, null, null, null, out.senderKeyDistributionMessage).getId(),
		healed.getSenderKeyState().getKeyId(),
		'distributed SKDM must be the fresh key'
	)
})

// ── HB-374 (socket) ───────────────────────────────────────────────

test('HB-374: the first retry receipt after a self-heal (count 1) carries <keys>', async () => {
	const deleteSessionCalls = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.decryptMessage = async () => {
				throw new Error('No session record')
			}
			real.decryptGroupMessage = async () => {
				throw new Error('No session record')
			}
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	sock.authState.creds.account = syntheticAccount()
	const sent = []
	fakeOpenTransport(sock, sent)
	const failures = []
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		sock.ws.emit('CB:message', msgStanza('HB0374-T1', Buffer.alloc(32, 3)))
		assert.equal(await waitFor(async () => (await retryReceipts(sent)).length >= 1, 8000), true, 'no retry receipt was sent')
		const receipt = (await retryReceipts(sent))[0]
		const kids = Array.isArray(receipt.content) ? receipt.content : []
		const retry = kids.find(c => c.tag === 'retry')
		assert.equal(retry?.attrs?.count, '1', 'first receipt must be count 1')
		const tags = kids.map(c => c.tag)
		assert.ok(tags.includes('keys'), `count-1 receipt after a self-heal must carry <keys> (got [${tags.join(', ')}])`)
		assert.equal(deleteSessionCalls.length, 1, 'the session must have been reset (healed)')
		assert.equal(failures[0]?.healed, true, 'the failure event must report healed=true')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-371 faset 2 + transient (socket) ───────────────────────────

test("HB-371 faset 2: 'No matching sessions found' with a live session is strike-counted, not reset", async () => {
	const deleteSessionCalls = []
	const failures = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.decryptMessage = async () => {
				throw new Error('No matching sessions found for message')
			}
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		await sock.signalRepository.injectE2ESession({ jid: PEER, session: bundleFor() })
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'setup session missing')
		sock.ws.emit('CB:message', msgStanza('HB0371-F2', Buffer.alloc(32, 3)))
		assert.equal(await waitFor(() => failures.length >= 1, 8000), true, 'no decrypt-failure event was emitted')
		await sleep(400)
		assert.equal(deleteSessionCalls.length, 0, 'a live session must not be reset on the first aggregate error')
		assert.equal(failures[0].healed, false, 'the failure must report healed=false (strike-counted)')
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'the session must survive')
	} finally {
		endQuietly(sock)
	}
})

test('HB-371 faset 2 (control): the same aggregate error with provably no session still resets immediately', async () => {
	const deleteSessionCalls = []
	const failures = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.decryptMessage = async () => {
				throw new Error('No matching sessions found for message')
			}
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		assert.deepEqual(await sock.signalRepository.validateSession(PEER), { exists: false, reason: 'no session' })
		sock.ws.emit('CB:message', msgStanza('HB0371-F2C', Buffer.alloc(32, 3)))
		assert.equal(await waitFor(() => failures.length >= 1, 8000), true, 'no decrypt-failure event was emitted')
		await sleep(400)
		assert.ok(deleteSessionCalls.length >= 1, 'a provably missing session must still reset immediately')
		assert.equal(failures[0].healed, true, 'the failure must report healed=true')
	} finally {
		endQuietly(sock)
	}
})

test('HB-371 (socket): a transient session-read failure does not delete the healthy session', async () => {
	let armThrow = false
	const deleteSessionCalls = []
	const failures = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const rawGet = auth.keys.get.bind(auth.keys)
			auth.keys.get = async (type, ids) => {
				if (armThrow && type === 'session') throw new Error('SQLITE_BUSY: database is locked (simulated transient read failure)')
				return rawGet(type, ids)
			}
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		await sock.signalRepository.injectE2ESession({ jid: PEER, session: bundleFor() })
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'setup session missing')
		armThrow = true
		sock.ws.emit('CB:message', msgStanza('HB0371-T1', Buffer.alloc(32, 3)))
		assert.equal(await waitFor(() => failures.length >= 1, 8000), true, 'no decrypt-failure event was emitted')
		await sleep(400)
		armThrow = false
		assert.equal(deleteSessionCalls.length, 0, 'a transient read failure must not delete the session')
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'the session must survive')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-375 (socket) ───────────────────────────────────────────────

test('HB-375: a retry-receipt resend carries the patched message (via sendMessagesAgain)', async () => {
	const counter = { calls: 0 }
	const { sock, encRecords } = await makeRetryEnv(patchHook(counter))
	try {
		const sent = await sock.sendMessage(PEER, { text: 'hello-375' })
		const msgId = sent.key.id
		assert.ok(msgId, 'first send produced no id')
		// The retry cache holds the PRE-patch message (that is the bug's input).
		const cached = sock.messageRetryManager.getRecentMessage(PEER, msgId)
		assert.ok(cached, 'message was not cached for retry')
		assert.equal(cached.message?.extendedTextMessage?.text, 'hello-375', 'retry cache must hold the original text')
		const before = encRecords.length
		const callsBefore = counter.calls
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER, participant: `${PEER_USER}:1@s.whatsapp.net`, id: msgId, count: 1 }))
		assert.equal(await waitFor(() => encRecords.length > before, 8000), true, 'no resend was encrypted after the retry receipt')
		await sleep(300)
		const resend = encRecords.slice(before)
		assert.ok(resend.length >= 1, 'expected at least one resend encrypt')
		assert.ok(counter.calls > callsBefore, 'the patch hook must run for the resend')
		for (const r of resend) {
			assert.ok(hasMark(r), `resend encrypt to ${r.jid} must carry the patched text (got ${JSON.stringify(r.conversation)})`)
		}
	} finally {
		endQuietly(sock)
	}
})

// ── HB-380 (socket) ───────────────────────────────────────────────

test('HB-380 (socket): a count-1 retry receipt carrying a MAC error recreates the session at once', async () => {
	const deleteSessionCalls = []
	const { sock } = await makeRetryEnv(undefined)
	const origDelete = sock.signalRepository.deleteSession.bind(sock.signalRepository)
	sock.signalRepository.deleteSession = async jids => {
		deleteSessionCalls.push([...jids])
		return origDelete(jids)
	}
	try {
		const sent = await sock.sendMessage(PEER, { text: 'hello-380' })
		const msgId = sent.key.id
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER, participant: `${PEER_USER}:1@s.whatsapp.net`, id: msgId, count: 1, error: 7 }))
		assert.equal(
			await waitFor(() => deleteSessionCalls.length >= 1, 8000),
			true,
			'a MAC-error receipt at count 1 must trigger an immediate session recreation'
		)
		assert.deepEqual(deleteSessionCalls[0], [`${PEER_USER}:1@s.whatsapp.net`])
	} finally {
		endQuietly(sock)
	}
})

// ── HB-2026-1112-40 addendum #3 ───────────────────────────────────

// ── HB-405 (2.5.0) ────────────────────────────────────────────

test('HB-405 (2.5.0): a second peer retry receipt carrying a MAC error inside the throttle window does not recreate the session again — the message is still resent (was: every error="7" receipt deleted the session)', async () => {
	const deleteSessionCalls = []
	const { sock, encRecords } = await makeRetryEnv(undefined)
	const origDelete = sock.signalRepository.deleteSession.bind(sock.signalRepository)
	sock.signalRepository.deleteSession = async jids => {
		deleteSessionCalls.push([...jids])
		return origDelete(jids)
	}
	try {
		const sent1 = await sock.sendMessage(PEER, { text: 'hello-405-a' })
		const sent2 = await sock.sendMessage(PEER, { text: 'hello-405-b' })
		const id1 = sent1.key.id
		const id2 = sent2.key.id
		assert.ok(id1 && id2, 'sends produced no ids')
		// First MAC-error receipt: the session is recreated at once (HB-380).
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER, participant: `${PEER_USER}:1@s.whatsapp.net`, id: id1, count: 1, error: 7 }))
		assert.equal(
			await waitFor(() => deleteSessionCalls.length >= 1, 8000),
			true,
			'first MAC-error receipt must recreate the session'
		)
		// Let the first resend settle (offline it cannot re-establish
		// the session — the bundle fetch answers empty), then restore
		// the session the way a live X3DH fetch would, so the second
		// receipt meets a live session and the throttle gate applies.
		await sleep(1500)
		await sock.signalRepository.injectE2ESession({ jid: `${PEER_USER}:1@s.whatsapp.net`, session: bundleFor() })
		const afterFirst = encRecords.length
		// Second MAC-error receipt, different message id, same peer,
		// inside the window: the message is still resent, but the
		// session must NOT be deleted again.
		sock.ws.emit('CB:receipt', receiptStanza({ from: PEER, participant: `${PEER_USER}:1@s.whatsapp.net`, id: id2, count: 1, error: 7 }))
		// AunuBaileys (2.6.0): the resend budget was 8 s, but the
		// resend lands at ~8.0–8.5 s in this offline env — the
		// path pays one 800 ms USync timeout per LID lookup for
		// the unmapped test peer (the HELD run-1003 class: no
		// negative cache for LID lookups), ~10 of them across
		// the two receipt flows, and the second receipt queues
		// behind the first. The resend DID arrive on the
		// published 2.5.0 lib too (A/B run: same ~8 s, same
		// 1 delete) — the 8 s budget was already marginal there,
		// not a 2.6.0 regression. This test locks the throttle
		// (no second delete) + the eventual resend, not sub-8 s
		// latency, so the budget is 20 s.
		assert.equal(
			await waitFor(() => encRecords.length > afterFirst, 20000),
			true,
			'second receipt must still resend its message'
		)
		await sleep(500)
		assert.equal(deleteSessionCalls.length, 1, 'second MAC-error receipt inside the window must not delete the session again')
	} finally {
		endQuietly(sock)
	}
})

test('HB-2026-1112-40 #3: membership-request stubs use the participant fallback chain and never equate undefined ids', async () => {
	const sock = await makeOfflineSocket()
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	const stubs = []
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages || []) {
			if (m.messageStubType) stubs.push({ type: m.messageStubType, params: m.messageStubParameters })
		}
	})
	const ADMIN_LID = '100000999999999@lid'
	const ADMIN_PN = '628555555555@s.whatsapp.net'
	const REQ_LID = '100000123456789@lid'
	// The socket's initial-buffer session (socket.ts nextTick:
	// "start buffering if logged in") starts once creds.me is
	// set and only ends on CB:ib,,offline, which never arrives
	// offline. While it lasts, processNodeWithBuffer's flush is
	// only a nested release, so a notification stub sits buffered
	// until the session is drained — the first notification in
	// this test lands before the session starts (so it appears),
	// the later ones after it (so they never appear without a
	// drain). Flush on every poll: harmless when nothing is
	// buffered, and it delivers the stub the moment processing
	// has appended it (a flush mid-processing only releases one
	// nesting level; the remaining flushes still run).
	const waitForStub = async n =>
		waitFor(async () => {
			sock.ev.flush()
			return stubs.length >= n
		}, 8000)
	const gp2 = (id, childTag, childAttrs, participantChildAttrs, actorAttrs) => ({
		tag: 'notification',
		attrs: { from: GROUP, type: 'w:gp2', id, t: String(Math.floor(Date.now() / 1000)), ...(actorAttrs || {}) },
		content: [{ tag: childTag, attrs: childAttrs, content: [{ tag: 'participant', attrs: participantChildAttrs }] }]
	})
	try {
		// A: created request, participant carries ONLY a lid — the
		// stub must name the requester, not the acting admin.
		sock.ws.emit(
			'CB:notification',
			gp2('HB1112-A', 'created_membership_requests', { request_method: 'invite' }, { lid: REQ_LID }, { participant: ADMIN_LID, participant_pn: ADMIN_PN })
		)
		assert.equal(await waitForStub(1), true, 'no stub for the created request')
		assert.equal(JSON.parse(stubs[0].params[0]).lid, REQ_LID, 'created-request stub must carry the requester lid')
		assert.equal(stubs[0].params[1], 'created')
		// B: revoked request, double-malformed (no ids anywhere) —
		// AunuBaileys (2.7.0, HB-2026-1112-40 addendum 5): NO stub at
		// all. Pre-2.7.0 this emitted a stub with an empty
		// participant ('rejected', params[0] '{}') — a phantom
		// group.join-request for nobody. The addendum-5 guard in
		// handleGroupNotification deliberately skips the stub when
		// the participant resolves to nothing AND no actor is on
		// the stanza (locked by
		// test/hb40-join-request-phantom.test.mjs); the old
		// 'rejected' expectation asserted the phantom itself, so
		// it is replaced, not weakened: absence is asserted here,
		// and the 'rejected' classification is re-locked below in
		// its surviving form (B2).
		sock.ws.emit('CB:notification', gp2('HB1112-B', 'revoked_membership_requests', {}, {}, {}))
		await sleep(1200)
		sock.ev.flush()
		assert.equal(stubs.length, 1, 'double-malformed revocation must emit no stub (addendum 5 phantom guard)')
		// B2: revoked request, participant carries ONLY a lid, no
		// actor — the participant resolves, so the addendum-5 guard
		// does not fire, and with no actor to match it the
		// revocation is still 'rejected', never 'revoked' (the
		// addendum-3 classification, re-locked here after B's
		// expectation moved to addendum 5).
		sock.ws.emit('CB:notification', gp2('HB1112-B2', 'revoked_membership_requests', {}, { lid: REQ_LID }, {}))
		assert.equal(await waitForStub(2), true, 'no stub for the lid-only revocation without an actor')
		assert.equal(stubs[1].params[1], 'rejected', 'lid-only revocation with no actor must be rejected, not revoked')
		assert.equal(JSON.parse(stubs[1].params[0]).lid, REQ_LID)
		// C: revoked request by the requester themselves — 'revoked'.
		sock.ws.emit(
			'CB:notification',
			gp2('HB1112-C', 'revoked_membership_requests', {}, { lid: REQ_LID }, { participant: REQ_LID, participant_pn: PEER })
		)
		assert.equal(await waitForStub(3), true, 'no stub for the self-revocation')
		assert.equal(stubs[2].params[1], 'revoked', 'self-revocation must stay revoked')
		assert.equal(JSON.parse(stubs[2].params[0]).lid, REQ_LID)
	} finally {
		endQuietly(sock)
	}
})
