// Group E — batch 2.6.0 leftovers (sapu bersih addenda) + follow-up
// run 1006–1011. Each test names the item it locks and fails without
// its fix (verified by reverting the fix in lib/ — see GROUP-E-REPORT).
// Everything runs offline against the built lib/.
//
// Items: HB-468, HB-349 addendum faset 2, HB-404 addendum, HB-282 faset
// (e), HB-346 addendum 1, HB-2026-1113-223 addendum ke-8, HB-420
// addendum F4, HB-2026-1112-80 addendum faset QR, HB-411 addendum 7.
// HB-282 faset (a)/(b)/(c)/(d)/(f) are ALREADY-FIXED — verified against
// the code, no test here (see GROUP-E-REPORT for the evidence).
import { register } from 'node:module'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// HB-468: register the jimp-only-host hooks BEFORE any test body runs
// (they intercept the dynamic imports inside getImageProcessingLibrary
// at call time, so the lib modules below may be imported statically).
register('./39-jimp-hooks.mjs', import.meta.url)

import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, makeCacheableSignalKeyStore } from '../lib/Utils/auth-utils.js'
import { makeBoundedTTLCache } from '../lib/Utils/bounded-cache.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { extractGroupMetadata } from '../lib/Socket/groups.js'
import { extractImageThumb, generateProfilePicture } from '../lib/Utils/messages-media.js'
import processMessage from '../lib/Utils/process-message.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { waproto } from '../WAProto/index.js'
import makeInMemoryStore from '../lib/Store/make-in-memory-store.js'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly, tmpDir, silentLogger } from './helpers.mjs'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_LID = '111222333444555@lid'
const GROUP = '120363123456789012@g.us'
// 1x1 transparent PNG (readImageDimensions reads 1x1; the pixel guard passes).
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// ── HB-468 ───────────────────────────────────────────────────────────
// extractImageThumb's jimp branch was dead: the guard read
// `typeof lib.jimp?.Jimp === 'object'` while jimp exports Jimp as a
// function. With sharp/@napi-rs/image blocked and jimp stubbed (hooks
// above), the branch must be taken; pre-fix it falls through to the
// bogus 'No image processing library available' Boom.
test('HB-468: extractImageThumb uses jimp when it is the only backend', async () => {
	const thumb = await extractImageThumb(PNG_1X1, 32)
	assert.equal(thumb.buffer[0], 0xff)
	assert.equal(thumb.buffer[1], 0xd8)
	assert.deepEqual(thumb.original, { width: 64, height: 48 })
})

test('HB-468 (control): generateProfilePicture already takes the jimp branch', async () => {
	// The sibling's guard was already === 'function' — this passes
	// with and without the HB-468 fix, proving the stub is a faithful
	// jimp stand-in rather than the reason the test above fails.
	const out = await generateProfilePicture(PNG_1X1)
	assert.equal(out.img[0], 0xff)
	assert.equal(out.img[1], 0xd8)
})

// ── HB-349 addendum faset 2 ──────────────────────────────────────────
// ALREADY-FIXED in 2.2.0 (the 8 s watchdog no longer deletes the
// placeholderResendCache entry); these tests lock that behaviour.
// The cache is injected via SocketConfig so the test shares the exact
// object the socket's requestPlaceholderResend and the PDO handler use.
const PDO_MSG_ID = 'HB349-8S-1'
const PDO_REMOTE = '120363012345678@g.us'
const PDO_AUTHOR = '628111222333@s.whatsapp.net'
const PDO_AUTHOR_LID = '123456789012345@lid'

const pdoMsgData = () => ({
	key: { remoteJid: PDO_REMOTE, fromMe: false, id: PDO_MSG_ID, participant: PDO_AUTHOR, participantAlt: PDO_AUTHOR_LID },
	messageTimestamp: 1763400000,
	pushName: 'Alice',
	participant: PDO_AUTHOR,
	verifiedBizName: 'Alice Biz'
})

const pdoResponseMessage = () => {
	const wmiBytes = waproto.WebMessageInfo.encode({
		key: { remoteJid: PDO_REMOTE, fromMe: false, id: PDO_MSG_ID, participant: PDO_AUTHOR },
		message: { conversation: 'hello from phone' },
		messageTimestamp: 1763400000
	}).finish()
	return {
		key: { remoteJid: ME, fromMe: true, id: 'PDO-RESP-1' },
		message: {
			protocolMessage: {
				type: waproto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
				peerDataOperationRequestResponseMessage: {
					stanzaId: 'ST-1',
					peerDataOperationResult: [{ placeholderMessageResendResponse: { webMessageInfoBytes: wmiBytes } }]
				}
			}
		},
		messageTimestamp: 1763400001
	}
}

const runPdoWithCache = async cache => {
	const upserts = []
	const ev = { emit: (n, d) => { if (n === 'messages.upsert') upserts.push(d) }, on() {}, off() {}, buffer() {}, flush() {} }
	const ctx = {
		shouldProcessHistoryMsg: false,
		placeholderResendCache: cache,
		ev,
		creds: { me: { id: ME }, accountSettings: {} },
		signalRepository: {},
		keyStore: {},
		logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {}, child() { return this } },
		options: {},
		getMessage: async () => undefined
	}
	await processMessage(pdoResponseMessage(), ctx)
	return upserts[0]?.messages?.[0]
}

test('HB-349 faset 2: cache entry survives the 8 s watchdog, late PDO keeps metadata', async () => {
	const cache = makeBoundedTTLCache({ ttlSeconds: 3600, maxEntries: 1000 })
	const sock = await makeOfflineSocket({ placeholderResendCache: cache })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	const reqId = await sock.requestPlaceholderResend(pdoMsgData().key, pdoMsgData())
	assert.equal(typeof reqId, 'string')
	assert.notEqual(await cache.get(PDO_MSG_ID), undefined, 'entry must be present right after the request')
	// The watchdog fires 8 s after the PDO send; wait past it.
	await sleep(9000)
	assert.notEqual(await cache.get(PDO_MSG_ID), undefined, 'the 8 s watchdog must NOT delete the entry (its TTL is 1 h)')
	const m = await runPdoWithCache(cache)
	assert.equal(m?.pushName, 'Alice')
	assert.equal(m?.key?.participantAlt, PDO_AUTHOR_LID)
	assert.equal(m?.verifiedBizName, 'Alice Biz')
	assert.equal(m?.message?.conversation, 'hello from phone')
	endQuietly(sock)
})

test('HB-349 faset 2 (control): PDO response before 8 s keeps metadata', async () => {
	const cache = makeBoundedTTLCache({ ttlSeconds: 3600, maxEntries: 1000 })
	const sock = await makeOfflineSocket({ placeholderResendCache: cache })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	await sock.requestPlaceholderResend(pdoMsgData().key, pdoMsgData())
	const m = await runPdoWithCache(cache)
	assert.equal(m?.pushName, 'Alice')
	assert.equal(m?.key?.participantAlt, PDO_AUTHOR_LID)
	assert.equal(m?.verifiedBizName, 'Alice Biz')
	endQuietly(sock)
})

// ── HB-404 addendum ──────────────────────────────────────────────────
// ALREADY-FIXED in 2.6.0 by another marathon group: the pre-delete
// drop now happens at flush time, and chats.update cancels a pending
// delete only when the update is actually applied. These tests lock the
// t0635 harness expectations (T0–T5) against the built event buffer.
// NOTE: chats.delete takes an ARRAY of ids — a bare string would be
// iterated character by character into chatDeletes.
const CHAT = '120363012345678@g.us'
const M1 = 'HB404-M1'
const M2 = 'HB404-M2'

const bufferCase = async ops => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = makeInMemoryStore({ logger: silentLogger })
	const seen = []
	for (const e of ['chats.delete', 'chats.update', 'chats.upsert', 'messages.upsert', 'messages.update']) {
		ev.on(e, d => seen.push([e, d]))
	}
	store.bind(ev)
	ev.buffer()
	ops(ev)
	ev.flush()
	const dels = seen.filter(([e]) => e === 'chats.delete').flatMap(([, d]) => d)
	const ups = seen.filter(([e]) => e === 'messages.upsert').flatMap(([, d]) => d.messages.map(m => m.key.id))
	return { store, dels, ups }
}

const msg = (id, text) => ({
	key: { remoteJid: CHAT, fromMe: false, id, participant: '628000000001@s.whatsapp.net' },
	message: { conversation: text },
	messageTimestamp: 1700000000
})
const chatUpdate = (id, unread, condition) => ({
	id,
	unreadCount: unread,
	...(condition !== undefined ? { conditional: condition } : {})
})

test('HB-404 addendum T0: [M1, delete] -> delete delivered, M1 dropped', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
		ev.emit('chats.delete', [CHAT])
	})
	assert.equal(dels.includes(CHAT), true, 'the delete must be delivered')
	assert.equal(ups.includes(M1), false, 'M1 predates the surviving delete and must be dropped')
	assert.equal(store.messages[CHAT]?.get(M1), undefined)
})

test('HB-404 addendum T1: [M1, delete, update applied] -> delete cancelled, M1 kept', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
		ev.emit('chats.delete', [CHAT])
		ev.emit('chats.update', [chatUpdate(CHAT, 5)])
		ev.emit('messages.upsert', { messages: [msg(M2, 'second')], type: 'notify' })
	})
	assert.equal(dels.includes(CHAT), false, 'an applied update must cancel the delete')
	assert.equal(ups.includes(M1), true, 'M1 must survive — the delete was cancelled')
	assert.equal(ups.includes(M2), true)
	assert.notEqual(store.messages[CHAT]?.get(M1), undefined)
	assert.notEqual(store.messages[CHAT]?.get(M2), undefined)
})

test('HB-404 addendum T2: [M1, delete, update invalid (cond false)] -> delete delivered, M1 dropped', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
		ev.emit('chats.delete', [CHAT])
		ev.emit('chats.update', [chatUpdate(CHAT, 99, () => false)])
	})
	assert.equal(dels.includes(CHAT), true, 'an invalid update must NOT cancel the delete')
	assert.equal(ups.includes(M1), false)
	assert.equal(store.messages[CHAT]?.get(M1), undefined)
})

test('HB-404 addendum T3: [M1, delete, upsert] -> delete cancelled, M1 kept', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
		ev.emit('chats.delete', [CHAT])
		ev.emit('chats.upsert', [{ id: CHAT, name: 'Group X' }])
	})
	assert.equal(dels.includes(CHAT), false, 'an upsert (chat exists) must cancel the delete')
	assert.equal(ups.includes(M1), true)
	assert.notEqual(store.messages[CHAT]?.get(M1), undefined)
})

test('HB-404 addendum T5: [M1, delete, update pending (cond undefined)] -> delete delivered, M1 dropped', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
		ev.emit('chats.delete', [CHAT])
		ev.emit('chats.update', [chatUpdate(CHAT, 7, () => undefined)])
	})
	assert.equal(dels.includes(CHAT), true, 'a pending update must NOT cancel the delete')
	assert.equal(ups.includes(M1), false)
	assert.equal(store.messages[CHAT]?.get(M1), undefined)
})

test('HB-404 addendum T4: [delete, M1] -> both delivered (no message pre-dates the delete)', async () => {
	const { store, dels, ups } = await bufferCase(ev => {
		ev.emit('chats.delete', [CHAT])
		ev.emit('messages.upsert', { messages: [msg(M1, 'first')], type: 'notify' })
	})
	assert.equal(dels.includes(CHAT), true)
	assert.equal(ups.includes(M1), true)
	assert.notEqual(store.messages[CHAT]?.get(M1), undefined)
})

// ── HB-282 faset (e) ─────────────────────────────────────────────────
// ALREADY-FIXED in 2.1.0: extractGroupMetadata no longer reads
// attrs.jid! — a participant without jid falls back to phone_number
// (normalised PN JID) or lid.
const groupResult = participants => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [{
		tag: 'group',
		attrs: { id: '120363000000000000', creation: '1700000000', s_t: '1700000000', subject: 'Test Group' },
		content: participants.map(attrs => ({ tag: 'participant', attrs, content: [] }))
	}]
})

test('HB-282(e): participant with phone_number only -> id is the normalised PN JID', () => {
	const meta = extractGroupMetadata(groupResult([{ phone_number: '6281234567890' }]))
	assert.equal(meta.participants[0].id, '6281234567890@s.whatsapp.net')
})

test('HB-282(e): participant with lid only -> id is the lid', () => {
	const meta = extractGroupMetadata(groupResult([{ lid: '123456789012345@lid' }]))
	assert.equal(meta.participants[0].id, '123456789012345@lid')
})

test('HB-282(e) (control): participant with jid -> id is the jid', () => {
	const meta = extractGroupMetadata(groupResult([{ jid: '6281234567890@s.whatsapp.net' }]))
	assert.equal(meta.participants[0].id, '6281234567890@s.whatsapp.net')
})

// ── HB-346 addendum 1 ────────────────────────────────────────────────
// makeCacheableSignalKeyStore had no close path: one unref'd 60 s purge
// timer leaked per wrapper. The wrapper now forwards close() to its
// cache, and socket end() calls it. Patching the timers AFTER import
// (patching before import breaks ESM resolution).
const plainStore = () => {
	const m = new Map()
	return {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) if (m.has(`${type}.${id}`)) out[id] = m.get(`${type}.${id}`)
			return out
		},
		set: async data => {
			for (const t in data) for (const id in data[t]) m.set(`${t}.${id}`, data[t][id])
		},
		clear: async () => { m.clear() }
	}
}

test('HB-346 add.1: close() stops the wrapper purge timer; clear() does not', async () => {
	const origSetInterval = globalThis.setInterval
	const origClearInterval = globalThis.clearInterval
	let created = 0
	let cleared = 0
	globalThis.setInterval = (...args) => { created++; return origSetInterval(...args) }
	globalThis.clearInterval = (...args) => { cleared++; return origClearInterval(...args) }
	try {
		const beforeCreated = created
		const beforeCleared = cleared
		const wrappers = [1, 2, 3].map(() => makeCacheableSignalKeyStore(plainStore(), lib.logger))
		assert.equal(created - beforeCreated, 3, 'one purge timer per wrapper')
		for (const w of wrappers) await w.clear()
		assert.equal(cleared - beforeCleared, 0, 'clear() must NOT stop the purge timer (the wrapper is reusable)')
		for (const w of wrappers) w.close()
		assert.equal(cleared - beforeCleared, 3, 'close() must stop every wrapper timer')
	} finally {
		globalThis.setInterval = origSetInterval
		globalThis.clearInterval = origClearInterval
	}
})

test('HB-346 add.1: close() is idempotent and the store stays usable after it', async () => {
	const w = makeCacheableSignalKeyStore(plainStore(), lib.logger)
	w.close()
	w.close()
	await w.set({ session: { abc: new Uint8Array([1, 2, 3]) } })
	assert.deepEqual(await w.get('session', ['abc']), { abc: new Uint8Array([1, 2, 3]) })
	w.close()
})

// ── HB-2026-1113-223 addendum ke-8 ───────────────────────────────────
// handleMessage used to add the id to decryptedMessageIds immediately
// after decrypt(), before the receipt and the upsert; a receipt-send
// throw left acked=true so the redelivery was acked-and-dropped — the
// decrypted message was lost silently. The add now happens only after
// a successful upsert, so a failed delivery is reprocessed on
// redelivery: the (consumed) key cannot decrypt again, and the host
// sees a visible CIPHERTEXT stub instead of silence.
// Setup below is the t1007 harness pattern verbatim: a real libsignal
// session between two test repos, frames recorded from the fake transport.
const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
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

const stanza = (id, enc) => ({
	tag: 'message',
	attrs: { id, from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
	content: [{ tag: 'enc', attrs: { type: enc.type }, content: enc.ciphertext }]
})

// Decode every recorded frame; return the set of ids the socket
// receipted (plain delivery receipts), retry-receipted and acked
// (plain 'ack' stanzas).
const parseFrames = async sent => {
	const receipts = new Set()
	const retryReceipts = new Set()
	const acks = new Set()
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		try {
			const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
			const kids = Array.isArray(node.content) ? node.content : []
			if (node.tag === 'receipt' && kids.some(c => c.tag === 'retry')) retryReceipts.add(node.attrs.id)
			else if (node.tag === 'receipt') receipts.add(node.attrs.id)
			if (node.tag === 'ack') acks.add(node.attrs.id)
		} catch {
			// a partial/non-node frame in the record — not a receipt/ack
		}
	}
	return { receipts, retryReceipts, acks }
}

// Build one full case: a ME socket + a PEER repo with a live session.
const build223Case = async tag => {
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
	// The socket opens an outer buffering session on its next tick that
	// only ends when the connection goes online — an offline harness
	// never gets there, so flush once here (what going online does).
	sock.ev.flush()
	const upserts = []
	const failures = []
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages || []) upserts.push(m)
	})
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	const peer = await makeRepo(tmpDir(`aunu-39-${tag}-peer-`))
	await peer.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(sockAuth, 11) })
	// Setup pkmsg + socket-side reply, so the peer's session is a plain
	// whisper session afterwards.
	const pk = await peer.repo.encryptMessage({ jid: ME, data: encMsg(`setup-${tag}`) })
	sock.ws.emit('CB:message', stanza(`${tag}-SETUP`, pk))
	const setupOk = await waitFor(async () => (await parseFrames(sent)).receipts.has(`${tag}-SETUP`), 8000)
	const reply = await sock.signalRepository.encryptMessage({ jid: PEER, data: encMsg(`reply-${tag}`) })
	await peer.repo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })
	return { sock, peer, sent, fake, upserts, failures, setupOk }
}

const upsertOf = (upserts, id) => upserts.filter(m => m.key?.id === id)

test('HB-223 ke-8 (control): delivery upserts once, redelivery is deduped', async () => {
	const c = await build223Case('CTRL')
	assert.equal(c.setupOk, true, 'setup pkmsg must decrypt through the socket')
	const m1 = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('real-ctrl') })
	c.sock.ws.emit('CB:message', stanza('CTRL-1', m1))
	assert.equal(await waitFor(async () => (await parseFrames(c.sent)).receipts.has('CTRL-1'), 8000), true, 'control delivery must get a delivery receipt')
	await sleep(400)
	assert.equal(upsertOf(c.upserts, 'CTRL-1').length, 1)
	assert.equal(upsertOf(c.upserts, 'CTRL-1')[0].message?.conversation, 'real-ctrl')
	assert.equal(c.failures.length, 0, 'no decrypt failure on the control delivery')
	c.sock.ws.emit('CB:message', stanza('CTRL-1', m1))
	assert.equal(await waitFor(async () => (await parseFrames(c.sent)).acks.has('CTRL-1'), 8000), true, 'control redelivery must be acked (dedup path)')
	await sleep(400)
	assert.equal(upsertOf(c.upserts, 'CTRL-1').length, 1, 'control redelivery must NOT upsert again')
	endQuietly(c.sock)
})

test('HB-223 ke-8: receipt failure on delivery, redelivery surfaces a CIPHERTEXT stub', async () => {
	const f = await build223Case('FAULT')
	assert.equal(f.setupOk, true, 'setup pkmsg must decrypt through the socket')
	const m1 = await f.peer.repo.encryptMessage({ jid: ME, data: encMsg('real-fault') })
	// Arm the one-shot transport failure: the NEXT send (the delivery
	// receipt for this stanza) throws, exactly like sendRawMessage
	// throwing Boom 'Connection Closed' on a closing socket.
	let failNextSend = false
	const origSend = f.fake.send.bind(f.fake)
	f.fake.send = (data, cb) => {
		if (failNextSend) {
			failNextSend = false
			throw new Error('SIMULATED-TRANSPORT-FAILURE')
		}
		return origSend(data, cb)
	}
	failNextSend = true
	f.sock.ws.emit('CB:message', stanza('FAULT-1', m1))
	await sleep(800)
	const frames1 = await parseFrames(f.sent)
	assert.equal(frames1.receipts.has('FAULT-1'), false, 'failed delivery must send NO receipt frame')
	assert.equal(frames1.acks.has('FAULT-1'), false, 'failed delivery must send NO ack frame')
	assert.equal(f.failures.length, 0, 'no decrypt failure on the first delivery (decrypt SUCCEEDED)')
	assert.equal(upsertOf(f.upserts, 'FAULT-1').length, 0, 'failed delivery upserts NOTHING')
	// The server redelivers (no ack ever went out); the transport is
	// healthy again now — the dedup alone decides what happens.
	f.sock.ws.emit('CB:message', stanza('FAULT-1', m1))
	assert.equal(await waitFor(async () => (await parseFrames(f.sent)).acks.has('FAULT-1'), 8000), true, 'redelivery must be acked')
	await sleep(400)
	const redelivered = upsertOf(f.upserts, 'FAULT-1')
	assert.equal(redelivered.length, 1, 'redelivery must be reprocessed (pre-fix: acked-and-dropped, 0 upserts)')
	assert.equal(redelivered[0].messageStubType, waproto.WebMessageInfo.StubType.CIPHERTEXT, 'the reprocessed message must surface as a CIPHERTEXT stub')
	assert.deepEqual(redelivered[0].messageStubParameters, ['No matching sessions found for message'])
	assert.equal(redelivered[0].message?.conversation, undefined, 'the stub must NOT carry the (undeliverable) plaintext')
	assert.equal(f.failures.length, 0, 'the consumed-key failure is reported via the stub, not a decrypt-failure event')
	// And the plaintext is unrecoverable: the message key was consumed
	// by the first (successful) decrypt.
	let reDecryptErr = null
	try {
		await f.sock.signalRepository.decryptMessage({ jid: PEER, type: m1.type, ciphertext: m1.ciphertext })
	} catch (e) {
		reDecryptErr = e.message
	}
	assert.match(reDecryptErr || '', /No matching sessions found/i, 'direct re-decrypt must fail — the key is consumed')
	endQuietly(f.sock)
})

// ── HB-420 addendum F4 ────────────────────────────────────────────────
// relayMessage's isRetryResend branch awaited signalRepository.
// hasSenderKey twice with no guard; a throwing host store aborted a
// group retry resend that could proceed without SKDM. The calls are now
// wrapped in try/catch (mirroring getSenderKeyDistributionMessage
// below): the resend proceeds with groupSenderIdentity = undefined.
// Setup is the t1008 harness pattern verbatim.

// Count outbound <message> stanzas addressed to the group with a
// participant attribute (i.e. the retry resend actually went out).
const countResendFrames = async sent => {
	let n = 0
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		try {
			const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
			if (node.tag === 'message' && node.attrs.to === GROUP && node.attrs.participant === PEER) n++
		} catch { /* partial/non-node frame */ }
	}
	return n
}

// Build one case: ME socket (optionally faulting sender-key reads) +
// PEER repo with a live session, via the t1007 pkmsg setup.
const build420Case = async (tag, faultMode) => {
	const { state } = await lib.useMultiFileAuthState(tmpDir(`aunu-39-${tag}-`))
	let senderKeyGets = 0
	const origGet = state.keys.get.bind(state.keys)
	state.keys.get = async (type, ids) => {
		if (type === 'sender-key') {
			senderKeyGets++
			if (faultMode === 'first' && senderKeyGets === 1) throw new Error('SIMULATED-STORE-FAILURE sender-key get')
			if (faultMode === 'second' && senderKeyGets === 2) throw new Error('SIMULATED-STORE-FAILURE sender-key get')
		}
		return origGet(type, ids)
	}
	let sockAuth
	const sock = await makeOfflineSocket({
		auth: state,
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			sockAuth = auth
			return makeLibSignalRepository(auth, logger, pnFromLIDUSync)
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const sent = []
	fakeOpenTransport(sock, sent)
	sock.ev.flush()
	const peer = await makeRepo(tmpDir(`aunu-39-${tag}-peer-`))
	await peer.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(sockAuth, 11) })
	const pk = await peer.repo.encryptMessage({ jid: ME, data: encMsg(`setup-${tag}`) })
	sock.ws.emit('CB:message', stanza(`${tag}-SETUP`, pk))
	// Wait until the socket processed the pkmsg (delivery receipt out),
	// so its side of the session exists before we encrypt the reply.
	const setupOk = await waitFor(async () => {
		for (const buf of sent) {
			let off = 0
			if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
			const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
			try {
				const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
				if (node.tag === 'receipt' && node.attrs.id === `${tag}-SETUP`) return true
			} catch { /* partial frame */ }
		}
		return false
	}, 8000)
	if (!setupOk) throw new Error(`setup pkmsg not processed for ${tag}`)
	// Setup is proven by a live session, not by frames: decrypt a
	// socket-side reply through the peer repo.
	const reply = await sock.signalRepository.encryptMessage({ jid: PEER, data: encMsg(`reply-${tag}`) })
	let sessionOk = false
	try {
		await peer.repo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })
		sessionOk = true
	} catch { sessionOk = false }
	return { sock, peer, sent, sessionOk, getSenderKeyGets: () => senderKeyGets }
}

const doRetryResend = async sock => {
	return sock.relayMessage(GROUP, { conversation: 'retry-test' }, { participant: { jid: PEER, count: 0 } })
}

test('HB-420 F4 (control): retry resend resolves, one stanza, both hasSenderKey reads happen', async () => {
	const c = await build420Case('CTRL', 'none')
	assert.equal(c.sessionOk, true, 'setup session must be live (socket can encrypt to peer)')
	const before = await countResendFrames(c.sent)
	const msgId = await doRetryResend(c.sock)
	assert.equal(typeof msgId, 'string')
	assert.equal(msgId.length > 0, true)
	assert.equal((await countResendFrames(c.sent)) - before, 1, 'exactly one resend stanza must reach the participant')
	assert.equal(c.getSenderKeyGets() >= 2, true, 'both hasSenderKey sites must be reached')
	endQuietly(c.sock)
})

test('HB-420 F4: hasSenderKey throws on the 1st call -> resend still proceeds without SKDM', async () => {
	const f = await build420Case('F1', 'first')
	assert.equal(f.sessionOk, true, 'setup session must be live')
	const before = await countResendFrames(f.sent)
	const msgId = await doRetryResend(f.sock)
	assert.equal(typeof msgId, 'string', 'the resend must resolve (pre-fix: rejects with the store error)')
	assert.equal((await countResendFrames(f.sent)) - before, 1, 'exactly one resend stanza must reach the participant (pre-fix: 0)')
	endQuietly(f.sock)
})

test('HB-420 F4: hasSenderKey throws on the 2nd call -> resend still proceeds without SKDM', async () => {
	const f = await build420Case('F2', 'second')
	assert.equal(f.sessionOk, true, 'setup session must be live')
	const before = await countResendFrames(f.sent)
	const msgId = await doRetryResend(f.sock)
	assert.equal(typeof msgId, 'string', 'the resend must resolve (pre-fix: rejects with the store error)')
	assert.equal((await countResendFrames(f.sent)) - before, 1, 'exactly one resend stanza must reach the participant (pre-fix: 0)')
	endQuietly(f.sock)
})

// ── HB-2026-1112-80 addendum faset QR ─────────────────────────────────
// The pair-device handler read creds.advSecretKey unguarded; a missing
// key became an empty segment in buildPairingQRData — a dead QR was
// emitted with no diagnostic. The handler now throws a descriptive
// Boom before emitting, and the socket ends with that error.
const pairDeviceStanza = () => ({
	tag: 'iq',
	attrs: { id: 'HB80-QR-1', type: 'set', from: 's.whatsapp.net' },
	content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: Buffer.from('REF12345') }] }]
})

test('HB-80 QR (control): pair-device with full creds emits a 5-segment QR', async () => {
	const sock = await makeOfflineSocket({})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	const updates = []
	sock.ev.on('connection.update', u => updates.push(u))
	sock.ws.emit('CB:iq,type:set,pair-device', pairDeviceStanza())
	const got = await waitFor(() => updates.some(u => typeof u.qr === 'string'), 8000)
	assert.equal(got, true, 'a QR must be emitted')
	const qr = updates.find(u => typeof u.qr === 'string').qr
	const segments = qr.split('#')[1].split(',')
	assert.equal(segments.length, 5)
	assert.equal(segments.every(s => s.length > 0), true, 'every QR segment must be non-empty')
	endQuietly(sock)
})

test('HB-80 QR: missing advSecretKey -> no QR, socket ends with the descriptive error', async () => {
	const sock = await makeOfflineSocket({})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	sock.authState.creds.advSecretKey = undefined
	fakeOpenTransport(sock, [])
	const updates = []
	sock.ev.on('connection.update', u => updates.push(u))
	sock.ws.emit('CB:iq,type:set,pair-device', pairDeviceStanza())
	const closed = await waitFor(() => updates.some(u => u.connection === 'close'), 8000)
	assert.equal(closed, true, 'the socket must end')
	assert.equal(updates.some(u => typeof u.qr === 'string'), false, 'no dead QR may be emitted')
	const errMsg = String(updates.find(u => u.connection === 'close')?.lastDisconnect?.error?.message || '')
	assert.ok(errMsg.includes('advSecretKey'), `the close error must name advSecretKey, got: ${errMsg}`)
	endQuietly(sock)
})

// ── HB-411 addendum 7 ─────────────────────────────────────────────────
// event-buffer append() merged groups.update / groups.upsert with raw
// Object.assign — a parameter-less stub emitting {subject: undefined}
// after a real change overwrote the real value with undefined in the
// flushed payload. Merge sources are now trimmed first (mirroring
// concatChats). Pattern is the t1010 harness verbatim.
const groupBufferCase = async ops => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = makeInMemoryStore({})
	const seen = []
	ev.on('groups.update', d => seen.push(['groups.update', d]))
	ev.on('groups.upsert', d => seen.push(['groups.upsert', d]))
	store.bind(ev)
	ev.buffer()
	ops(ev)
	ev.flush()
	await sleep(20)
	return { store, seen }
}

const realGroup = { id: 'G1', subject: 'Real Subject', desc: 'Real Desc', inviteCode: 'REAL-CODE' }

test('HB-411 add.7 T0: single real subject survives', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.update', [{ id: 'G1', subject: 'Real Subject' }])
	})
	assert.equal(seen[0][1][0].subject, 'Real Subject')
})

test('HB-411 add.7 T1: real subject then undefined stub -> real subject', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.update', [realGroup])
		ev.emit('groups.update', [{ id: 'G1', subject: undefined }])
	})
	assert.equal(seen[0][1][0].subject, 'Real Subject')
})

test('HB-411 add.7 T2: undefined stub then real subject -> real subject', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.update', [{ id: 'G1', subject: undefined }])
		ev.emit('groups.update', [realGroup])
	})
	assert.equal(seen[0][1][0].subject, 'Real Subject')
})

test('HB-411 add.7 T3: real desc then undefined stub -> real desc', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.update', [realGroup])
		ev.emit('groups.update', [{ id: 'G1', desc: undefined }])
	})
	assert.equal(seen[0][1][0].desc, 'Real Desc')
})

test('HB-411 add.7 T4: groups.upsert subject real then undefined -> real subject', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.upsert', [realGroup])
		ev.emit('groups.upsert', [{ id: 'G1', subject: undefined }])
	})
	assert.equal(seen[0][1][0].subject, 'Real Subject')
})

test('HB-411 add.7 T5: inviteCode real then undefined -> real inviteCode', async () => {
	const { seen } = await groupBufferCase(ev => {
		ev.emit('groups.update', [realGroup])
		ev.emit('groups.update', [{ id: 'G1', inviteCode: undefined }])
	})
	assert.equal(seen[0][1][0].inviteCode, 'REAL-CODE')
})

// ── HB-2026-1113-223 addendum ke-9 ───────────────────────────────────
// A CONCURRENT redelivery of the same stanza slipped past the early
// check (outside messageMutex) while the first copy was still inside
// the mutex: copy 2 re-decrypted a consumed key, produced a
// CIPHERTEXT stub, and — because append is last-writer-wins per key
// and both upserts landed in one nested buffer session — the stub
// REPLACED the real message. The host never saw the original; the
// store kept the stub; copy 2 also sent a spurious retry receipt.
// Two fixes, both locked here (and neither may break ke-8):
// (1) re-check decryptedMessageIds INSIDE the mutex callback right
// after acquire, before decrypt — copy 2 sees copy 1's mark (ke-8
// marks before the mutex is released) and acks-and-returns;
// (2) in the buffer, a content-less stub must not overwrite a
// content-bearing upsert for the same key. Setup is the t1014
// harness pattern verbatim (store bound + synthetic creds.account
// so a retry receipt would actually go out — otherwise the
// no-retry-receipt assertion would pass vacuously).
const syntheticAccount = () => ({
	details: randomBytes(32),
	accountSignatureKey: randomBytes(32),
	accountSignature: randomBytes(64)
})

const build1014Case = async tag => {
	let sockAuth
	const sent = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			sockAuth = auth
			return makeLibSignalRepository(auth, logger, pnFromLIDUSync)
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	sock.authState.creds.account = syntheticAccount()
	await sock.signalRepository.lidMapping.storeLIDPNMappings([
		{ lid: ME_LID, pn: ME },
		{ lid: PEER_LID, pn: PEER }
	])
	const fake = fakeOpenTransport(sock, sent)
	sock.ev.flush()
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(sock.ev)
	const upserts = []
	const failures = []
	sock.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages || []) upserts.push(m)
	})
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	const peer = await makeRepo(tmpDir(`aunu-39-${tag}-peer-`))
	await peer.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(sockAuth, 11) })
	const pk = await peer.repo.encryptMessage({ jid: ME, data: encMsg(`setup-${tag}`) })
	sock.ws.emit('CB:message', stanza(`${tag}-SETUP`, pk))
	const setupOk = await waitFor(async () => (await parseFrames(sent)).receipts.has(`${tag}-SETUP`), 8000)
	const reply = await sock.signalRepository.encryptMessage({ jid: PEER, data: encMsg(`reply-${tag}`) })
	await peer.repo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })
	return { sock, peer, sent, fake, upserts, failures, store, setupOk }
}

test('HB-223 ke-9 (control): sequential redelivery dedups, store keeps the real message', async () => {
	const c = await build1014Case('CTRL9')
	assert.equal(c.setupOk, true, 'setup pkmsg must decrypt through the socket')
	const m1 = await c.peer.repo.encryptMessage({ jid: ME, data: encMsg('real-ctrl') })
	c.sock.ws.emit('CB:message', stanza('CTRL9-1', m1))
	assert.equal(await waitFor(async () => (await parseFrames(c.sent)).receipts.has('CTRL9-1'), 8000), true, 'control delivery must get a delivery receipt')
	await sleep(400)
	assert.equal(upsertOf(c.upserts, 'CTRL9-1').length, 1)
	assert.equal(upsertOf(c.upserts, 'CTRL9-1')[0].message?.conversation, 'real-ctrl')
	c.sock.ws.emit('CB:message', stanza('CTRL9-1', m1))
	assert.equal(await waitFor(async () => (await parseFrames(c.sent)).acks.has('CTRL9-1'), 8000), true, 'control redelivery must be acked (dedup path)')
	await sleep(400)
	assert.equal(upsertOf(c.upserts, 'CTRL9-1').length, 1, 'control redelivery must NOT upsert again')
	assert.equal((await parseFrames(c.sent)).retryReceipts.size, 0, 'control redelivery must send no retry receipt')
	assert.equal(c.failures.length, 0, 'no decrypt failure on the control redelivery')
	const stored = await c.store.loadMessage(PEER, 'CTRL9-1')
	assert.equal(stored?.message?.conversation, 'real-ctrl', 'store must keep the real message')
	endQuietly(c.sock)
})

test('HB-223 ke-9: concurrent redelivery keeps the real upsert, no stub, no retry receipt', async () => {
	const f = await build1014Case('FAULT9')
	assert.equal(f.setupOk, true, 'setup pkmsg must decrypt through the socket')
	const m1 = await f.peer.repo.encryptMessage({ jid: ME, data: encMsg('real-fault') })
	// Both handleMessage invocations start before either reaches the
	// mark: copy 2's early check runs while copy 1 is still inside
	// the mutex (decrypt + receipt + upsert).
	f.sock.ws.emit('CB:message', stanza('FAULT9-1', m1))
	f.sock.ws.emit('CB:message', stanza('FAULT9-1', m1))
	assert.equal(await waitFor(async () => {
		const p = await parseFrames(f.sent)
		return p.receipts.has('FAULT9-1') || p.acks.has('FAULT9-1')
	}, 8000), true, 'a receipt or ack must go out for the delivered id')
	await sleep(800)
	const ups = upsertOf(f.upserts, 'FAULT9-1')
	assert.equal(ups.length, 1, 'concurrent redelivery must upsert exactly once (pre-fix: 2, the second a stub)')
	assert.equal(ups[0].message?.conversation, 'real-fault', 'the single upsert must be the REAL message, not the stub')
	assert.equal(ups[0].messageStubType, undefined, 'no stub must reach the host')
	assert.equal((await parseFrames(f.sent)).retryReceipts.has('FAULT9-1'), false, 'no spurious retry receipt for the delivered id (this is what locks fix (1))')
	assert.equal(f.failures.length, 0, 'no decrypt-failure event (second-layer dedup preserved)')
	const stored = await f.store.loadMessage(PEER, 'FAULT9-1')
	assert.equal(stored?.message?.conversation, 'real-fault', 'store must keep the real message, not the stub')
	assert.equal(stored?.messageStubType, undefined)
	endQuietly(f.sock)
})

test('HB-223 ke-9 (buffer guard): a content-less stub must not overwrite a content-bearing upsert', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = makeInMemoryStore({ logger: silentLogger })
	const seen = []
	ev.on('messages.upsert', d => seen.push(d))
	store.bind(ev)
	ev.buffer()
	const key = { remoteJid: CHAT, fromMe: false, id: 'HB223-STUB-1', participant: '628000000001@s.whatsapp.net' }
	ev.emit('messages.upsert', {
		messages: [{ key, message: { conversation: 'real content' }, messageTimestamp: 1700000000 }],
		type: 'notify'
	})
	// The stub a concurrent redelivery would produce for the same key:
	// stub type set, no message content at all.
	ev.emit('messages.upsert', {
		messages: [{
			key,
			messageTimestamp: 1700000000,
			broadcast: false,
			messageStubType: waproto.WebMessageInfo.StubType.CIPHERTEXT,
			messageStubParameters: ['No matching sessions found for message']
		}],
		type: 'notify'
	})
	ev.flush()
	const delivered = seen.flatMap(d => d.messages || [])
	assert.equal(delivered.length, 1, 'exactly one message must be delivered for the key')
	assert.equal(delivered[0].message?.conversation, 'real content', 'the flushed upsert must keep the REAL message (pre-fix: the stub replaced it)')
	assert.equal(delivered[0].messageStubType, undefined)
	assert.equal(store.messages[CHAT]?.get('HB223-STUB-1')?.message?.conversation, 'real content')
})
