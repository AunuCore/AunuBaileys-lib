// Group A — batch 2.8.0 HIGH items:
// HB-503 (end()/destroy() discarding receipted buffered messages),
// HB-2026-1113-223 addendum ke-10 (receipt-failure window loses the
// decrypted plaintext; redelivery became a MISSING_KEYS stub although
// the plaintext sat in the recent-message cache),
// HB-2026-1113-223 addendum ke-11 (decryptedMessageIds keyed by the
// bare message id — a valid message from another chat/sender reusing
// the id was acked-and-dropped),
// HB-388 addendum 1 (history-sync download failure swallowed: the
// notification id entered the dedup set, blocking in-process retry,
// and RECENT 'complete' fired despite the failed chunk).
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { deflateSync } from 'node:zlib'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import processMessage from '../lib/Utils/process-message.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { decodeDecompressedBinaryNode } from '../lib/WABinary/decode.js'
import * as binaryConstants from '../lib/WABinary/constants.js'
import { waproto } from '../WAProto/index.js'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly, tmpDir, silentLogger } from './helpers.mjs'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_LID = '111222333444555@lid'
const PEER2 = '628111222333@s.whatsapp.net'
const T = () => String(Math.floor(Date.now() / 1000))

// ── shared encrypted-harness (test/39 t1007 pattern) ────────────────
const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state }
}

const mintIncomingBundle = async (state, preKeyId = 11) => {
	const creds = state.creds
	const pre = Curve.generateKeyPair()
	await state.keys.set({ 'pre-key': { [preKeyId]: { private: pre.private, public: pre.public } } })
	return {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: {
			keyId: creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
			signature: creds.signedPreKey.signature
		},
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pre.public) }
	}
}

const encMsg = text => {
	const raw = Buffer.from(waproto.Message.encode({ conversation: text }).finish())
	const pad = 16 - (raw.length % 16)
	return Buffer.concat([raw, Buffer.alloc(pad, pad)])
}

const stanza = (id, enc, from = PEER) => ({
	tag: 'message',
	attrs: { id, from, t: T(), type: 'text' },
	content: [{ tag: 'enc', attrs: { type: enc.type }, content: enc.ciphertext }]
})

const decodeFrameSync = data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	const payload = buf.subarray(off + 3, off + 3 + len)
	if (payload[0] !== 0) throw new Error('compressed frame')
	return decodeDecompressedBinaryNode(payload.subarray(1), binaryConstants)
}

const parseFrames = async sent => {
	const receipts = new Set()
	const acks = new Set()
	const ackFrames = []
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		try {
			const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
			if (node.tag === 'receipt') receipts.add(node.attrs.id)
			if (node.tag === 'ack') {
				acks.add(node.attrs.id)
				ackFrames.push({ id: node.attrs.id, error: node.attrs.error })
			}
		} catch { /* partial/non-node frame */ }
	}
	return { receipts, acks, ackFrames }
}

const buildSocket = async tag => {
	let sockAuth
	const sent = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			sockAuth = auth
			return makeLibSignalRepository(auth, logger, pnFromLIDUSync)
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	await sock.signalRepository.lidMapping.storeLIDPNMappings([
		{ lid: ME_LID, pn: ME },
		{ lid: PEER_LID, pn: PEER }
	])
	const fake = fakeOpenTransport(sock, sent)
	sock.ev.flush()
	const upserts = []
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages || []) upserts.push(m)
	})
	const peer = await makeRepo(tmpDir(`aunu-40a-${tag}-peer-`))
	await peer.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(sockAuth, 11) })
	return { sock, peer, sent, fake, upserts, sockAuth }
}

// Establish a plain whisper session with PEER (setup pkmsg + reply).
const establishSession = async c => {
	const pk = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('setup') })
	c.sock.ws.emit('CB:message', stanza('SETUP-1', pk))
	const ok = await waitFor(async () => (await parseFrames(c.sent)).receipts.has('SETUP-1'), 8000)
	assert.equal(ok, true, 'setup pkmsg must be receipted')
	const reply = await c.sock.signalRepository.encryptMessage({ jid: PEER, data: encMsg('reply') })
	await c.peer.repo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })
}

// ── HB-503 ───────────────────────────────────────────────────────────
const bufferedMsg = id => ({
	key: { remoteJid: PEER, fromMe: false, id },
	message: { conversation: `buffered-${id}` },
	messageTimestamp: 1760000000
})

test('HB-503 control: flush() delivers buffered messages.upsert', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('messages.upsert', ({ messages }) => seen.push(...messages))
	ev.buffer()
	ev.emit('messages.upsert', { messages: [bufferedMsg('CTL-1')], type: 'notify' })
	ev.flush()
	await sleep(20)
	assert.equal(seen.length, 1)
	assert.equal(seen[0].message.conversation, 'buffered-CTL-1')
	ev.destroy()
})

test('HB-503: destroy() during buffering delivers the pending upsert instead of discarding it', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('messages.upsert', ({ messages }) => seen.push(...messages))
	ev.buffer()
	ev.emit('messages.upsert', { messages: [bufferedMsg('LOST-1')], type: 'notify' })
	// socket end() path: destroy without a prior flush — pre-fix the
	// receipted message was dropped with the buffer.
	ev.destroy()
	await sleep(20)
	assert.equal(seen.length, 1, 'the buffered message must reach listeners on destroy (pre-fix: 0)')
	assert.equal(seen[0].key.id, 'LOST-1')
	assert.equal(seen[0].message.conversation, 'buffered-LOST-1')
})

test('HB-503: destroy() during NESTED buffering still delivers the pending upsert', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('messages.upsert', ({ messages }) => seen.push(...messages))
	ev.buffer()
	ev.buffer()
	ev.emit('messages.upsert', { messages: [bufferedMsg('LOST-2')], type: 'append' })
	ev.destroy()
	await sleep(20)
	assert.equal(seen.length, 1, 'a nested session must not swallow the flush on destroy (pre-fix: 0)')
	assert.equal(seen[0].key.id, 'LOST-2')
})

test('HB-503 control: destroy() while not buffering emits nothing spurious', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('messages.upsert', ({ messages }) => seen.push(...messages))
	ev.destroy()
	await sleep(20)
	assert.equal(seen.length, 0)
})

// ── HB-2026-1113-223 addendum ke-10 ──────────────────────────────────
test('HB-223 ke-10 control: a pkmsg with a healthy transport upserts its plaintext once', async t => {
	const c = await buildSocket('ke10ctl')
	t.after(() => endQuietly(c.sock))
	const pk = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('plain-one') })
	assert.equal(pk.type, 'pkmsg')
	c.sock.ws.emit('CB:message', stanza('KE10-CTL', pk))
	const ok = await waitFor(() => c.upserts.some(m => m.key?.id === 'KE10-CTL'), 8000)
	assert.equal(ok, true)
	const got = c.upserts.filter(m => m.key?.id === 'KE10-CTL')
	assert.equal(got.length, 1)
	assert.equal(got[0].message?.conversation, 'plain-one')
})

test('HB-223 ke-10: receipt failure then redelivery upserts the cached plaintext, not a MISSING_KEYS stub', async t => {
	const c = await buildSocket('ke10')
	t.after(() => endQuietly(c.sock))
	const pk = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('secret-one') })
	assert.equal(pk.type, 'pkmsg')
	// Arm a one-shot transport failure on this stanza's delivery
	// receipt — decrypt succeeds (plaintext cached, Signal key
	// consumed), the receipt throws, the upsert never runs.
	let failArmed = true
	const origSend = c.fake.send.bind(c.fake)
	c.fake.send = (data, cb) => {
		if (failArmed) {
			let node = null
			try { node = decodeFrameSync(data) } catch {}
			if (node?.tag === 'receipt' && node?.attrs?.id === 'KE10-1') {
				failArmed = false
				throw new Error('SIMULATED-TRANSPORT-FAILURE')
			}
		}
		return origSend(data, cb)
	}
	c.sock.ws.emit('CB:message', stanza('KE10-1', pk))
	await sleep(1200)
	assert.equal(c.upserts.filter(m => m.key?.id === 'KE10-1').length, 0, 'the failed delivery upserts nothing')
	assert.equal(
		c.sock.messageRetryManager?.getRecentMessage(PEER, 'KE10-1')?.message?.conversation,
		'secret-one',
		'setup sanity: the decrypted plaintext is in the recent-message cache'
	)
	// Redelivery: re-decrypt fails on the consumed key (MISSING_KEYS).
	c.sock.ws.emit('CB:message', stanza('KE10-1', pk))
	const ok = await waitFor(() => c.upserts.some(m => m.key?.id === 'KE10-1'), 8000)
	assert.equal(ok, true, 'the redelivery must upsert (pre-fix: only a stub)')
	await sleep(300)
	const got = c.upserts.filter(m => m.key?.id === 'KE10-1')
	assert.equal(got.length, 1)
	assert.equal(got[0].message?.conversation, 'secret-one', 'the recovered upsert carries the plaintext (pre-fix: stub, no conversation)')
	assert.equal(got[0].messageStubType, undefined, 'the recovered upsert is not a stub')
	const frames = await parseFrames(c.sent)
	const redeliveryAcks = frames.ackFrames.filter(a => a.id === 'KE10-1')
	assert.ok(redeliveryAcks.some(a => a.error === undefined), 'the recovered delivery is plain-acked')
	assert.ok(!redeliveryAcks.some(a => a.error === '487'), 'no 487 NACK for a recovered delivery')
})

// ── HB-2026-1113-223 addendum ke-11 ──────────────────────────────────
test('HB-223 ke-11: the same message id from a different sender is decrypted and upserted, not acked-and-dropped', async t => {
	const c = await buildSocket('ke11')
	t.after(() => endQuietly(c.sock))
	await establishSession(c)
	// Sender A delivers id SHARED-ID.
	const mA = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('from-peer-a') })
	c.sock.ws.emit('CB:message', stanza('SHARED-ID', mA, PEER))
	assert.equal(await waitFor(() => c.upserts.some(m => m.key?.id === 'SHARED-ID' && m.key?.remoteJid === PEER), 8000), true)
	// Sender B (independent identity/session) reuses the same id.
	const peer2 = await makeRepo(tmpDir('aunu-40a-ke11-peer2-'))
	await peer2.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(c.sockAuth, 12) })
	const mB = await peer2.repo.encryptMessage({ jid: ME, data: encMsg('from-peer-b') })
	c.sock.ws.emit('CB:message', stanza('SHARED-ID', mB, PEER2))
	const okB = await waitFor(() => c.upserts.some(m => m.key?.id === 'SHARED-ID' && m.key?.remoteJid === PEER2), 8000)
	assert.equal(okB, true, "sender B's message must be upserted (pre-fix: bare-id dedup acked-and-dropped it)")
	const gotB = c.upserts.filter(m => m.key?.id === 'SHARED-ID' && m.key?.remoteJid === PEER2)
	assert.equal(gotB.length, 1)
	assert.equal(gotB[0].message?.conversation, 'from-peer-b')
	// Control: a genuine redelivery of sender A's stanza is still
	// deduped (plain ack, no second upsert).
	const before = c.upserts.filter(m => m.key?.id === 'SHARED-ID' && m.key?.remoteJid === PEER).length
	c.sock.ws.emit('CB:message', stanza('SHARED-ID', mA, PEER))
	assert.equal(await waitFor(async () => (await parseFrames(c.sent)).acks.has('SHARED-ID'), 8000), true, 'the true redelivery is acked')
	await sleep(400)
	assert.equal(c.upserts.filter(m => m.key?.id === 'SHARED-ID' && m.key?.remoteJid === PEER).length, before, 'the true redelivery must not upsert twice')
})

// ── HB-388 addendum 1 ────────────────────────────────────────────────
const histCtx = (creds, events) => {
	const ev = new EventEmitter()
	ev.on('creds.update', data => {
		events.push(['creds.update', data])
		Object.assign(creds, data)
	})
	ev.on('messaging-history.set', data => events.push(['messaging-history.set', data]))
	return {
		shouldProcessHistoryMsg: true,
		placeholderResendCache: { get: async () => undefined, del: async () => {} },
		ev,
		creds,
		signalRepository: {
			lidMapping: {
				storeLIDPNMappings: async () => {},
				getLIDForPN: async () => undefined,
				getPNForLID: async () => undefined
			}
		},
		keyStore: { transaction: async fn => fn(), set: async () => {}, get: async () => ({}) },
		logger: silentLogger,
		options: {},
		getMessage: async () => undefined
	}
}

const histMsg = (id, inlinePayload) => ({
	key: { remoteJid: '123@s.whatsapp.net', fromMe: true, id },
	messageTimestamp: 1760000000,
	message: {
		protocolMessage: {
			type: waproto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: {
				syncType: waproto.HistorySync.HistorySyncType.RECENT,
				chunkOrder: 0,
				...(inlinePayload !== undefined ? { initialHistBootstrapInlinePayload: inlinePayload } : {})
			}
		}
	}
})

const validHistPayload = () =>
	deflateSync(Buffer.from(waproto.HistorySync.encode({ syncType: waproto.HistorySync.HistorySyncType.RECENT }).finish()))

test('HB-388 add.1: processMessage reports a failed history download instead of swallowing it', async () => {
	const creds = { me: { id: ME }, processedHistoryMessages: [], accountSettings: {} }
	const events = []
	const result = await processMessage(histMsg('HISTFAIL-280', Buffer.from('this-is-not-zlib-data')), histCtx(creds, events))
	assert.equal(result?.historySyncDownloadFailed, true, 'the failure must surface in the result (pre-fix: swallowed, undefined result)')
	assert.equal(creds.processedHistoryMessages.length, 0, 'the chunk stays unmarked (HB-388 behaviour preserved)')
	assert.equal(events.some(([t]) => t === 'messaging-history.set'), false)
})

test('HB-388 add.1 control: processMessage reports success for a valid history payload', async () => {
	const creds = { me: { id: ME }, processedHistoryMessages: [], accountSettings: {} }
	const events = []
	const result = await processMessage(histMsg('HISTOK-280', validHistPayload()), histCtx(creds, events))
	assert.equal(result?.historySyncDownloadFailed, false)
	assert.equal(creds.processedHistoryMessages.length, 1)
	assert.equal(events.some(([t]) => t === 'messaging-history.set'), true)
})

const histChunkMsg = (id, payload, progress) => ({
	key: { remoteJid: ME, fromMe: true, id },
	messageTimestamp: 1760000000,
	message: {
		protocolMessage: {
			type: waproto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: {
				syncType: waproto.HistorySync.HistorySyncType.RECENT,
				chunkOrder: 0,
				progress,
				initialHistBootstrapInlinePayload: payload
			}
		}
	}
})

const buildHistorySocket = async t => {
	const sock = await makeOfflineSocket({ fireInitQueries: false, shouldSyncHistoryMessage: () => true })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	const statuses = []
	sock.ev.on('messaging-history.status', s => statuses.push(s))
	return { sock, statuses }
}

test('HB-388 add.1: a failed chunk rejects upsertMessage and RECENT progress 100 does not emit complete', async t => {
	const { sock, statuses } = await buildHistorySocket(t)
	await assert.rejects(
		sock.upsertMessage(histChunkMsg('CHUNK-FAIL-280', Buffer.from('this-is-not-zlib-data'), 50), 'notify'),
		/history sync download failed/,
		'the failed download must surface out of upsertMessage (pre-fix: resolved, id marked decrypted upstream)'
	)
	await sock.upsertMessage(histChunkMsg('CHUNK-100-280', validHistPayload(), 100), 'notify')
	await sleep(300)
	assert.equal(
		statuses.some(s => s.status === 'complete'),
		false,
		"no 'complete' status while a chunk failed (pre-fix: complete emitted at progress 100)"
	)
})

test('HB-388 add.1 control: with no failed chunk, RECENT progress 100 emits complete', async t => {
	const { sock, statuses } = await buildHistorySocket(t)
	await sock.upsertMessage(histChunkMsg('CHUNK-OK-280', validHistPayload(), 100), 'notify')
	await sleep(300)
	assert.equal(statuses.some(s => s.status === 'complete' && s.explicit === true), true)
})
