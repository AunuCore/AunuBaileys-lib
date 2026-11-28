// Batch 2.9.0 "Last Fix" — Grup B verification lock-ins.
// These items were claimed FIXED in the 2.8.0 tree by older releases;
// this file locks the verified behaviour against regression (the fixes
// predate this file, so the tests pin current behaviour rather than
// demonstrating a red->green transition).
//   HB-94 addendum  — per-address / per-group transaction keying in
//                     libsignal (no joined batch txKey anymore)
//   HB-154          — sendRetryRequest survives an empty getNextPreKeys
//                     result by generating a fresh pre-key pair
//   HB-160 + HB-326 — handleReceipt filters the retry cap PER ID, and
//                     the resend loop is the only place that counts
//   HB-281 facet b  — a receipt without `from` is still acked (the
//                     isLid probe must not deref attrs.from bare)
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { Curve, signedKeyPair, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { encodeBigEndian } from '../lib/Utils/generics.js'
import { makeLibSignalRepository, signalStorage } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, tmpDir, waitFor, sleep, endQuietly } from './helpers.mjs'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const GROUP = '120363011111111@g.us'
const PEER = '628987654321@s.whatsapp.net'
const PEER2 = '628111222333@s.whatsapp.net'
const PEER_DEV = '628987654321:1@s.whatsapp.net'
const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const T = () => String(Math.floor(Date.now() / 1000))

// Trace-level capturing logger (test/30 recipe): sendNode logs every
// sent stanza's XML here, so receipts / resends / acks are classified
// from the plaintext XML instead of the Noise frames.
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

// Decodable ADVDeviceIdentity account (HB-201 addendum 2/4 guards in
// sendRetryRequest reject anything else before a receipt is built).
const syntheticAccount = () => ({
	details: Buffer.from(lib.proto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
	accountSignatureKey: randomBytes(32),
	accountSignature: randomBytes(64)
})

const countStarts = (xml, tag) => xml.filter(x => x.startsWith(`<${tag}`)).length

// ── HB-94 addendum: transaction keying in the Signal repository ─────

const makeRecordingRepo = async () => {
	const { state } = await lib.useMultiFileAuthState(tmpDir('aunu-290-verify-'))
	state.keys = addTransactionCapability(state.keys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 10 })
	const txKeysSeen = []
	const innerTx = state.keys.transaction
	state.keys.transaction = async (work, key) => {
		txKeysSeen.push(key)
		return innerTx(work, key)
	}
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, txKeysSeen }
}

test('HB-94 addendum (lock-in): deleteSession runs one transaction PER resolved address, never a joined batch key', async () => {
	const { repo, txKeysSeen } = await makeRecordingRepo()
	try {
		await repo.injectE2ESession({ jid: PEER, session: {
			registrationId: 1234,
			identityKey: generateSignalPubKey(Curve.generateKeyPair().public),
			signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(Curve.generateKeyPair().public), signature: randomBytes(64) },
			preKey: { keyId: 11, publicKey: generateSignalPubKey(Curve.generateKeyPair().public) }
		} }).catch(() => {})
		txKeysSeen.length = 0
		await repo.deleteSession([PEER, PEER2])
		const deleteTxKeys = txKeysSeen.filter(k => typeof k === 'string')
		assert.ok(deleteTxKeys.length >= 2, `expected >= 2 per-address transactions, saw ${JSON.stringify(txKeysSeen)}`)
		assert.ok(deleteTxKeys.every(k => !k.includes(',')), `no transaction key may be a joined list, saw ${JSON.stringify(deleteTxKeys)}`)
		assert.ok(deleteTxKeys.some(k => k.startsWith('628987654321')), 'one transaction is keyed by the first peer address')
		assert.ok(deleteTxKeys.some(k => k.startsWith('628111222333')), 'one transaction is keyed by the second peer address')
	} finally {
		repo.close()
	}
})

test('HB-94 addendum (lock-in): deleteSenderKey runs inside the per-group transaction', async () => {
	const { repo, txKeysSeen } = await makeRecordingRepo()
	try {
		txKeysSeen.length = 0
		await repo.deleteSenderKey(GROUP, PEER)
		assert.ok(txKeysSeen.includes(GROUP), `deleteSenderKey must transact under the group id, saw ${JSON.stringify(txKeysSeen)}`)
	} finally {
		repo.close()
	}
})

test('HB-94 addendum (lock-in): saveIdentity is wrapped in a transaction keyed by the wire address', async () => {
	const { repo, state, txKeysSeen } = await makeRecordingRepo()
	try {
		const storage = signalStorage(state, repo.lidMapping)
		txKeysSeen.length = 0
		const identity = Curve.generateKeyPair()
		await storage.saveIdentity('628987654321.0', Buffer.from(identity.public))
		assert.ok(
			txKeysSeen.some(k => typeof k === 'string' && k.startsWith('628987654321')),
			`saveIdentity must transact under the wire address, saw ${JSON.stringify(txKeysSeen)}`
		)
		assert.ok(txKeysSeen.every(k => typeof k !== 'string' || !k.includes(',')), 'no joined transaction key')
	} finally {
		repo.close()
	}
})

// ── HB-154: empty getNextPreKeys result must not kill the receipt ───

test('HB-154 (lock-in): a corrupt head pre-key (empty getNextPreKeys) still yields a retry receipt carrying a fresh <keys> bundle', async () => {
	const store = new Map()
	const msgRetryCounterCache = {
		get: async k => store.get(k),
		set: async (k, v) => { store.set(k, v) },
		del: async k => { store.delete(k) }
	}
	const MSG_ID = '3EB015400001'
	// Seed the fallback retry counter at 1 so the first receipt for
	// this id is built with retryCount = 2, which is what enters the
	// <keys> branch of sendRetryRequest.
	store.set(`${MSG_ID}:undefined`, 1)
	const { sock, xml, lines } = await makeSocket({ enableRecentMessageCache: false, msgRetryCounterCache })
	try {
		sock.authState.creds.account = syntheticAccount()
		// Counters claim the head pre-key (id 1) is already generated
		// (available == requested range, so getNextPreKeys generates
		// nothing new) — but the stored entry is corrupt ({}), so the
		// HB-83 shape filter drops it and the result map is EMPTY.
		// That is exactly the HB-154 trigger.
		sock.authState.creds.firstUnuploadedPreKeyId = 1
		sock.authState.creds.nextPreKeyId = 2
		await sock.authState.keys.set({ 'pre-key': { 1: {} } })

		sock.ws.emit('CB:message', {
			tag: 'message',
			attrs: { id: MSG_ID, from: PEER, t: T() },
			content: [{ tag: 'enc', attrs: { type: 'msg', count: '0' }, content: randomBytes(48) }]
		})
		const sent = await waitFor(() => xml.some(x => x.startsWith('<receipt') && x.includes('<keys')), 15_000)
		assert.ok(sent, 'the retry receipt was sent and carries a <keys> bundle despite the empty pre-key map')
		const receipt = xml.find(x => x.startsWith('<receipt') && x.includes('<keys'))
		assert.ok(/<key[\s>]/.test(receipt), 'the bundle carries a pre-key node (the fresh pair from the HB-154 guard)')
		assert.equal(lines.some(l => l.includes('Failed to send retry')), false, 'no retry failure was logged')
		// The fresh pair must be persisted into the head slot, with
		// real key material on both halves.
		const stored = await sock.authState.keys.get('pre-key', ['1'])
		assert.ok(stored['1']?.public?.length > 0 && stored['1']?.private?.length > 0,
			'a fresh key pair with real key material was persisted at the head slot')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-160 + HB-326: per-id retry cap, single counting ──────────────

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

test('HB-160 + HB-326 (lock-in): a capped first id does not starve a fresh second id, and the fresh id is counted exactly once', async () => {
	const store = new Map()
	const msgRetryCounterCache = {
		get: async k => store.get(k),
		set: async (k, v) => { store.set(k, v) },
		del: async k => { store.delete(k) }
	}
	const CAPPED = '3EB01600000A'
	const FRESH = '3EB01600000B'
	// CAPPED already burned its whole budget (default maxMsgRetryCount = 5).
	store.set(`${CAPPED}:${PEER_DEV}`, 5)
	const { sock, xml } = await makeSocket({ msgRetryCounterCache })
	try {
		sock.messageRetryManager.addRecentMessage(GROUP, CAPPED, { conversation: 'capped message' })
		sock.messageRetryManager.addRecentMessage(GROUP, FRESH, { conversation: 'fresh message' })
		const { keysNode, registrationNode } = mintBundleNodes()
		sock.ws.emit('CB:receipt', {
			tag: 'receipt',
			attrs: { id: CAPPED, type: 'retry', from: GROUP, participant: PEER_DEV, t: T() },
			content: [
				{ tag: 'list', attrs: {}, content: [{ tag: 'item', attrs: { id: FRESH } }] },
				{ tag: 'retry', attrs: { count: '1', id: CAPPED, t: T(), v: '1' } },
				keysNode,
				registrationNode
			]
		})
		const resent = await waitFor(() => countStarts(xml, 'message') >= 1, 15_000)
		assert.ok(resent, 'the fresh id was resent even though ids[0] was capped')
		await sleep(500)
		const resends = xml.filter(x => x.startsWith('<message'))
		assert.equal(resends.length, 1, 'exactly one message was resent')
		assert.ok(resends[0].includes(FRESH), 'the resent message is the fresh id')
		assert.ok(!resends[0].includes(CAPPED), 'the capped id was not resent')
		// HB-326: the only increment lives in the sendMessagesAgain
		// loop — one resend of FRESH leaves its counter at exactly 1
		// (a pre-increment in handleReceipt would leave it at 2).
		assert.equal(store.get(`${FRESH}:${PEER_DEV}`), 1, 'the fresh id retry counter is exactly 1 after one resend')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-281 facet b: receipt without `from` must still be acked ──────

test('HB-281 facet b (lock-in): a receipt with no `from` attr is acked instead of dying on the isLid deref', async () => {
	const { sock, xml } = await makeSocket()
	try {
		sock.ws.emit('CB:receipt', {
			tag: 'receipt',
			attrs: { id: '3EB028100001', t: T() },
			content: undefined
		})
		const acked = await waitFor(() => countStarts(xml, 'ack') >= 1, 10_000)
		assert.ok(acked, 'the from-less receipt was acked (handleReceipt reached its finally block)')
	} finally {
		endQuietly(sock)
	}
})
