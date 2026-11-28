// AunuBaileys 2.9.0 "Last Fix" — Group B1 (messages-recv + signal):
// - HB-2026-1113-223 addendum ke-12: host getMessage may return a full
//   WAMessage ({ key, message, ... }); the resend path forwarded it as
//   an IMessage, so relayMessage encrypted an EMPTY message and the
//   retry budget burned. Unwrap once at the sendMessagesAgain choke
//   point + the two sibling .messageContextInfo.messageSecret sites
//   (process-message.ts event response, messages-recv.ts msmsg).
// - HB-2026-1112-80 addendum: signedPreKey.keyId guards only checked
//   `typeof undefined` — 'abc'/NaN/1.5 slipped through to
//   encodeBigEndian, which silently coerced them (0 / truncated) into
//   the pre-key upload node and the retry receipt. Both guards now
//   also require a finite integer, mirroring the registrationId guard.
// - HB-410: DISPOSITION — already implemented in 2.6.0
//   (src/Signal/libsignal.ts injectE2ESession verifies the SPK
//   signature with the tree's own Curve.verify BEFORE initOutgoing,
//   Boom 400, and fail-closes on a MISSING signature too — stricter
//   than this batch's conservative candidate, which asked for Boom
//   401 and for signature-less bundles to keep the old behaviour).
//   The tests below lock the shipped behaviour; changing it to the
//   candidate would regress test/36-batch-260-signal.test.mjs.
// Every test fails without its fix (verified by temporary revert).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, waitFor, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { waproto } from '../WAProto/index.js'
import { Curve, generateSignalPubKey, signedKeyPair, aesEncryptGCM, hmacSign } from '../lib/Utils/crypto.js'
import { encodeBigEndian, getKeyAuthor } from '../lib/Utils/generics.js'
import { getNextPreKeysNode } from '../lib/Utils/signal.js'
import processMessage from '../lib/Utils/process-message.js'
import { getBotMessageSecret } from '../lib/Utils/decode-wa-message.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'
const GROUP = '120363123456789012@g.us'
const T = () => String(Math.floor(Date.now() / 1000))

// ── HB-2026-1113-223 addendum ke-12: sendMessagesAgain unwrap ──────

// Retry-receipt harness (HB-326 recipe): the receipt carries a valid
// E2E bundle for the peer, and patchMessageBeforeSending captures the
// exact message object sendMessagesAgain hands toward relayMessage.
const resendHarness = async (t, getMessage) => {
	const store = new Map()
	const msgRetryCounterCache = {
		get: async k => store.get(k),
		set: async (k, v) => { store.set(k, v) },
		del: async k => { store.delete(k) }
	}
	const patched = []
	const sock = await makeOfflineSocket({
		msgRetryCounterCache,
		getMessage,
		patchMessageBeforeSending: async msg => {
			// Snapshot: the relay mutates the object after the hook
			// (adds messageContextInfo), which is not what this test
			// measures — it measures the shape AT the choke point.
			patched.push(structuredClone(msg))
			return msg
		}
	})
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	sock.authState.creds.me = { id: ME, name: '~' }

	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const preKey = Curve.generateKeyPair()
	const uint = (n, len) => {
		const b = Buffer.alloc(len)
		b.writeUIntBE(n, 0, len)
		return b
	}
	const msgId = 'B1290MSG1'
	const receipt = {
		tag: 'receipt',
		attrs: { id: msgId, from: PEER, participant: PEER, type: 'retry', t: '1700000000' },
		content: [
			{ tag: 'retry', attrs: { count: '1', id: msgId, v: '2' } },
			{ tag: 'registration', attrs: {}, content: uint(12345, 4) },
			{
				tag: 'keys',
				attrs: {},
				content: [
					{ tag: 'type', attrs: {}, content: Buffer.from([5]) },
					{ tag: 'identity', attrs: {}, content: identity.public },
					{
						tag: 'skey',
						attrs: {},
						content: [
							{ tag: 'id', attrs: {}, content: uint(1, 3) },
							{ tag: 'value', attrs: {}, content: signed.keyPair.public },
							{ tag: 'signature', attrs: {}, content: signed.signature }
						]
					},
					{
						tag: 'key',
						attrs: {},
						content: [
							{ tag: 'id', attrs: {}, content: uint(2, 3) },
							{ tag: 'value', attrs: {}, content: preKey.public }
						]
					}
				]
			}
		]
	}
	sock.ws.emit('CB:receipt', receipt)
	return { sock, patched, msgId }
}

test('HB-2026-1113-223 add12: a full WAMessage from getMessage is unwrapped before the resend relay', async t => {
	const fullWAMessage = {
		key: { remoteJid: PEER, fromMe: true, id: 'B1290MSG1' },
		message: { conversation: 'resend me' },
		messageTimestamp: 1700000000
	}
	const { patched } = await resendHarness(t, async () => fullWAMessage)
	const seen = await waitFor(() => patched.length > 0, 10000)
	assert.ok(seen, 'the resend never reached the patch/relay stage')
	// Without the unwrap this is the whole { key, message, ... }
	// wrapper — relayMessage would encrypt zero IMessage fields.
	assert.deepEqual(patched[0], { conversation: 'resend me' })
})

test('HB-2026-1113-223 add12 (control): a plain IMessage from getMessage resends unchanged', async t => {
	const { patched } = await resendHarness(t, async () => ({ conversation: 'resend me' }))
	const seen = await waitFor(() => patched.length > 0, 10000)
	assert.ok(seen, 'the resend never reached the patch/relay stage')
	assert.deepEqual(patched[0], { conversation: 'resend me' })
})

// ── HB-2026-1113-223 addendum ke-12, sibling: process-message ──────

const eventResponseCtx = (events, getMessage) => {
	const ev = new EventEmitter()
	ev.on('messages.update', e => events.push(e))
	return {
		ev,
		creds: { me: { id: ME, lid: '100000000000001@lid' }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {},
		keyStore: {},
		options: {},
		getMessage,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
}

// Build a genuinely encrypted event response for `secret`, inverting
// decryptEventResponse's exact key derivation.
const encryptedEventResponse = secret => {
	const creationKey = { remoteJid: GROUP, fromMe: false, id: 'B1-EVENT-0', participant: PEER }
	const responseKey = { remoteJid: GROUP, fromMe: false, id: 'B1-EVENT-1', participant: PEER }
	const eventCreatorJid = getKeyAuthor({ remoteJid: PEER, fromMe: false }, ME)
	const responderJid = getKeyAuthor(responseKey, ME)
	const sign = Buffer.concat([
		Buffer.from(creationKey.id),
		Buffer.from(eventCreatorJid),
		Buffer.from(responderJid),
		Buffer.from('Event Response'),
		new Uint8Array([1])
	])
	const key0 = hmacSign(secret, new Uint8Array(32), 'sha256')
	const encKey = hmacSign(sign, key0, 'sha256')
	const aad = Buffer.from(`${creationKey.id}\u0000${responderJid}`)
	const iv = randomBytes(12)
	const plain = waproto.Message.EventResponseMessage.encode({ timestampMs: 1760000000 }).finish()
	const encPayload = aesEncryptGCM(plain, encKey, iv, aad)
	const message = {
		key: responseKey,
		messageTimestamp: 1760000000,
		message: {
			encEventResponseMessage: {
				eventCreationMessageKey: creationKey,
				encPayload,
				encIv: iv
			}
		}
	}
	return message
}

test('HB-2026-1113-223 add12 sibling: event response decrypts when getMessage returns a full WAMessage', async () => {
	const secret = randomBytes(32)
	const events = []
	const getMessage = async () => ({
		key: { remoteJid: GROUP, fromMe: false, id: 'B1-EVENT-0', participant: PEER },
		message: { messageContextInfo: { messageSecret: secret } },
		messageTimestamp: 1760000000
	})
	await processMessage(encryptedEventResponse(secret), eventResponseCtx(events, getMessage))
	assert.equal(events.length, 1, 'the event response must be emitted once the secret is recovered')
	const [update] = events[0]
	assert.equal(update.update.eventResponses.length, 1)
	assert.equal(Number(update.update.eventResponses[0].senderTimestampMs), 1760000000)
})

test('HB-2026-1113-223 add12 sibling (control): event response decrypts when getMessage returns a plain IMessage', async () => {
	const secret = randomBytes(32)
	const events = []
	const getMessage = async () => ({ messageContextInfo: { messageSecret: secret } })
	await processMessage(encryptedEventResponse(secret), eventResponseCtx(events, getMessage))
	assert.equal(events.length, 1, 'the event response must be emitted for an unwrapped store result')
})

// ── HB-2026-1113-223 addendum ke-12, sibling: msmsg secret ─────────

test('HB-2026-1113-223 add12 sibling: msmsg secret is recovered when getMessage returns a full WAMessage', async t => {
	const secret = randomBytes(32)
	const sock = await makeOfflineSocket({
		getMessage: async () => ({
			key: { remoteJid: PEER, fromMe: true, id: 'B1-TARGET-1' },
			message: { messageContextInfo: { messageSecret: secret } },
			messageTimestamp: 1700000000
		})
	})
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	sock.authState.creds.me = { id: ME }
	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'B1-MSMSG-1', from: PEER, t: T(), type: 'text' },
		content: [
			{ tag: 'enc', attrs: { type: 'msmsg', v: '2' }, content: Buffer.from([9, 9, 9]) },
			{ tag: 'meta', attrs: { target_id: 'B1-TARGET-1' } }
		]
	})
	const ok = await waitFor(() => {
		const s = getBotMessageSecret('B1-TARGET-1')
		return !!s && Buffer.from(s).equals(secret)
	}, 8000)
	assert.ok(ok, 'the msmsg messageSecret was not recovered from the full WAMessage store result')
})

// ── HB-2026-1112-80 addendum: keyId finite/integer guards ──────────

const authStateWithKeyId = keyId => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 5)
	return {
		creds: {
			registrationId: 1234,
			signedIdentityKey: identity,
			signedPreKey: { keyPair: signed.keyPair, signature: signed.signature, keyId },
			nextPreKeyId: 1,
			firstUnuploadedPreKeyId: 1,
			accountSettings: {},
			me: { id: ME }
		},
		keys: { get: async () => ({}), set: async () => {}, clear: async () => {} }
	}
}

for (const bad of ['abc', NaN, 1.5]) {
	test(`HB-2026-1112-80 add: getNextPreKeysNode rejects signedPreKey.keyId ${String(bad)} like a missing one`, async () => {
		await assert.rejects(
			getNextPreKeysNode(authStateWithKeyId(bad), 1),
			/signedPreKey are missing or incomplete/
		)
	})
}

test('HB-2026-1112-80 add (control): getNextPreKeysNode with keyId 5 publishes id 5 unchanged', async () => {
	const { node } = await getNextPreKeysNode(authStateWithKeyId(5), 1)
	const skey = node.content.find(n => n.tag === 'skey')
	assert.ok(skey, 'the node must carry the signed pre-key')
	const idNode = skey.content.find(n => n.tag === 'id')
	assert.deepEqual(Buffer.from(idNode.content), Buffer.from(encodeBigEndian(5, 3)))
})

const decodeSentFrames = async sent => {
	const nodes = []
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		nodes.push(await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len)))
	}
	return nodes
}

const retryRequestSocket = async (t, keyId) => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	sock.authState.creds.account = {
		details: Buffer.from(
			waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
		),
		accountSignatureKey: randomBytes(32),
		accountSignature: randomBytes(64)
	}
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 5)
	sock.authState.creds.signedIdentityKey = identity
	sock.authState.creds.signedPreKey = { keyPair: signed.keyPair, signature: signed.signature, keyId }
	const sent = []
	fakeOpenTransport(sock, sent)
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	return { sock, sent }
}

const plaintextStanza = id => ({
	tag: 'message',
	attrs: { id, from: PEER, t: T(), type: 'text' },
	content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ conversation: 'hi' }).finish() }]
})

for (const bad of ['abc', NaN, 1.5]) {
	test(`HB-2026-1112-80 add: sendRetryRequest rejects signedPreKey.keyId ${String(bad)} like a missing one`, async t => {
		const { sock } = await retryRequestSocket(t, bad)
		await assert.rejects(
			sock.sendRetryRequest(plaintextStanza('B1-RR-BAD'), true),
			/signedPreKey are missing or incomplete/
		)
	})
}

test('HB-2026-1112-80 add (control): sendRetryRequest with keyId 5 sends a retry receipt carrying id 5', async t => {
	const { sock, sent } = await retryRequestSocket(t, 5)
	await sock.sendRetryRequest(plaintextStanza('B1-RR-OK'), true)
	const nodes = await decodeSentFrames(sent)
	const receipt = nodes.find(n => n.tag === 'receipt' && n.attrs.type === 'retry')
	assert.ok(receipt, 'a retry receipt must be sent for valid creds')
	const keys = receipt.content.find(n => n.tag === 'keys')
	assert.ok(keys, 'forceIncludeKeys must embed the key bundle')
	const skey = keys.content.find(n => n.tag === 'skey')
	const idNode = skey.content.find(n => n.tag === 'id')
	assert.deepEqual(Buffer.from(idNode.content), Buffer.from(encodeBigEndian(5, 3)))
})

// ── HB-2026-1112-80 addendum run-1407: fractional registrationId ───
// The two publishing guards still used Number.isFinite, so a
// fractional registrationId (1234.5) slipped through and
// encodeBigEndian truncated it silently to 1234 (bitwise 255 & r).
// Both now require an integer, mirroring the keyId fix above.

const authStateWithRegId = regId => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 5)
	return {
		creds: {
			registrationId: regId,
			signedIdentityKey: identity,
			signedPreKey: { keyPair: signed.keyPair, signature: signed.signature, keyId: 5 },
			nextPreKeyId: 1,
			firstUnuploadedPreKeyId: 1,
			accountSettings: {},
			me: { id: ME }
		},
		keys: { get: async () => ({}), set: async () => {}, clear: async () => {} }
	}
}

test('HB-2026-1112-80 add run-1407: getNextPreKeysNode rejects fractional registrationId 1234.5', async () => {
	await assert.rejects(
		getNextPreKeysNode(authStateWithRegId(1234.5), 1),
		/registrationId is missing or invalid/
	)
})

test('HB-2026-1112-80 add run-1407 (control): getNextPreKeysNode with integer registrationId 1234 publishes it unchanged', async () => {
	const { node } = await getNextPreKeysNode(authStateWithRegId(1234), 1)
	const reg = node.content.find(n => n.tag === 'registration')
	assert.ok(reg, 'the node must carry the registration id')
	assert.deepEqual(Buffer.from(reg.content), Buffer.from(encodeBigEndian(1234, 4)))
})

test('HB-2026-1112-80 add run-1407: sendRetryRequest rejects fractional registrationId 1234.5', async t => {
	const { sock } = await retryRequestSocket(t, 5)
	sock.authState.creds.registrationId = 1234.5
	await assert.rejects(
		sock.sendRetryRequest(plaintextStanza('B1-RR-REGID-BAD'), true),
		/registrationId is missing or invalid/
	)
})

test('HB-2026-1112-80 add run-1407 (control): sendRetryRequest with integer registrationId 1234 sends the retry receipt', async t => {
	const { sock, sent } = await retryRequestSocket(t, 5)
	sock.authState.creds.registrationId = 1234
	await sock.sendRetryRequest(plaintextStanza('B1-RR-REGID-OK'), true)
	const nodes = await decodeSentFrames(sent)
	const receipt = nodes.find(n => n.tag === 'receipt' && n.attrs.type === 'retry')
	assert.ok(receipt, 'a retry receipt must be sent for valid creds')
})

// ── HB-410: already shipped in 2.6.0 — lock the behaviour ──────────

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	state.keys = addTransactionCapability(state.keys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo }
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

test('HB-410 (shipped 2.6.0): a bundle with a corrupted SPK signature is rejected and no session is created', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-290-410-'))
	try {
		const bundle = bundleFor()
		const sig = Buffer.from(bundle.signedPreKey.signature)
		sig[0] ^= 0xff
		bundle.signedPreKey.signature = sig
		await assert.rejects(
			repo.injectE2ESession({ jid: PEER, session: bundle }),
			err => err?.isBoom && err?.output?.statusCode === 400 && /signed pre-key/i.test(err.message)
		)
		assert.equal(await repo.getSessionInfo(PEER), null, 'initOutgoing must not run for a bad signature')
	} finally {
		repo.close()
	}
})

test('HB-410 (shipped 2.6.0, control): a validly signed bundle injects a session', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-290-410-'))
	try {
		await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
		const info = await repo.getSessionInfo(PEER)
		assert.ok(info, 'a valid bundle must inject')
		assert.equal(info.registrationId, 1234)
	} finally {
		repo.close()
	}
})

test('HB-410 (shipped 2.6.0): a bundle without a signature is rejected (fail-closed, stricter than the 2.9.0 candidate)', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-290-410-'))
	try {
		const bundle = bundleFor()
		delete bundle.signedPreKey.signature
		await assert.rejects(
			repo.injectE2ESession({ jid: PEER, session: bundle }),
			err => err?.isBoom && err?.output?.statusCode === 400
		)
		assert.equal(await repo.getSessionInfo(PEER), null)
	} finally {
		repo.close()
	}
})
