// Batch 2.5.0 — Kelompok D regressions (store / history / event-buffer):
// HB-412 (pending conditional chats.update clobbers the previous one),
// HB-421 (live messages.upsert vs messaging-history.set for the same key),
// HB-181 addendum (key-less history message aborts the whole chunk),
// HB-2026-1113-166 addendum 1 (type-mismatch emit drops re-buffered upserts),
// HB-425 addenda (run-0724: group-participants.update + group.join-request
// bypass the buffer; chats.lock facet: lock patch lost while the chat row
// is still buffered), HB-2026-1112-34 (decision: saveCreds throws by
// design — the event-buffer dispatcher catches async listener rejections
// and every in-tree creds.update emit is guarded).
// Each test names the behaviour it locks in and fails without its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, silentLogger, sleep } from './helpers.mjs'
import { waproto } from '../WAProto/index.js'
import processMessage from '../lib/Utils/process-message.js'

const CHAT = '123@s.whatsapp.net'
const GID = '1234567890@g.us'

const flushBuffer = async ev => {
	ev.flush()
	await sleep(20)
}

const freshBuffer = () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const maps = []
	ev.on('event', map => maps.push(map))
	ev.buffer()
	return { ev, maps }
}

const historyChats = maps => maps.flatMap(m => m['messaging-history.set']?.chats || [])
const historyMessages = maps => maps.flatMap(m => m['messaging-history.set']?.messages || [])
const upserts = maps => maps.flatMap(m => (m['messages.upsert'] ? [{ type: m['messages.upsert'].type, messages: m['messages.upsert'].messages }] : []))
const upsertMessages = maps => upserts(maps).flatMap(u => u.messages)

const mkMsg = (id, text, ts = 10) => ({
	key: { remoteJid: CHAT, id, fromMe: false },
	messageTimestamp: ts,
	message: { conversation: text }
})

// Mimics getChatUpdateConditional (chat-utils.ts): undefined until the
// snapshot chat for this id has arrived in the buffer.
const pendingConditional = () => data => (data.historySets.chats[CHAT] || data.chatUpserts[CHAT] ? true : undefined)

// ---------- HB-412 ----------

test('HB-412: three pending conditional updates for one chat all survive the snapshot', async () => {
	const { ev, maps } = freshBuffer()
	const cond = pendingConditional()
	ev.emit('chats.update', [{ id: CHAT, archived: true, conditional: cond }])
	ev.emit('chats.update', [{ id: CHAT, unreadCount: 0, conditional: cond }])
	ev.emit('chats.update', [{ id: CHAT, muteEndTime: 999, conditional: cond }])
	ev.emit('messaging-history.set', { chats: [{ id: CHAT, conversationTimestamp: 5 }], contacts: [], messages: [], isLatest: false })
	await flushBuffer(ev)
	const chat = historyChats(maps).find(c => c.id === CHAT)
	assert.ok(chat, 'snapshot chat must be delivered')
	assert.equal(chat.archived, true, 'archived from the first pending update must survive')
	assert.equal(chat.unreadCount, 0, 'unreadCount 0 from the second pending update must survive')
	assert.equal(chat.muteEndTime, 999, 'muteEndTime from the third pending update must survive')
	ev.destroy()
})

test('HB-412: a non-conditional update is not wiped by a later pending conditional for the same chat', async () => {
	const { ev, maps } = freshBuffer()
	ev.emit('chats.update', [{ id: CHAT, archived: true }])
	ev.emit('chats.update', [{ id: CHAT, unreadCount: 0, conditional: pendingConditional() }])
	ev.emit('messaging-history.set', { chats: [{ id: CHAT, conversationTimestamp: 5 }], contacts: [], messages: [], isLatest: false })
	await flushBuffer(ev)
	const chat = historyChats(maps).find(c => c.id === CHAT)
	assert.ok(chat, 'snapshot chat must be delivered')
	assert.equal(chat.archived, true, 'the already-merged archived flag must survive the pending conditional')
	assert.equal(chat.unreadCount, 0, 'the pending unreadCount must survive too')
	ev.destroy()
})

test('HB-412 control: conditionals that are already satisfiable merge (passes before and after the fix)', async () => {
	const { ev, maps } = freshBuffer()
	ev.emit('messaging-history.set', { chats: [{ id: CHAT, conversationTimestamp: 5 }], contacts: [], messages: [], isLatest: false })
	const cond = pendingConditional()
	ev.emit('chats.update', [{ id: CHAT, archived: true, conditional: cond }])
	ev.emit('chats.update', [{ id: CHAT, unreadCount: 0, conditional: cond }])
	ev.emit('chats.update', [{ id: CHAT, muteEndTime: 999, conditional: cond }])
	await flushBuffer(ev)
	const chat = historyChats(maps).find(c => c.id === CHAT)
	assert.ok(chat, 'snapshot chat must be delivered')
	assert.equal(chat.archived, true)
	assert.equal(chat.unreadCount, 0)
	assert.equal(chat.muteEndTime, 999)
	ev.destroy()
})

// ---------- HB-421 ----------

test('HB-421 (A): history first, live after — the live message fires one notify upsert, not a silent history copy', async () => {
	const { ev, maps } = freshBuffer()
	ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [mkMsg('M1', 'v1-history', 10)], isLatest: false })
	ev.emit('messages.upsert', { messages: [mkMsg('M1', 'v2-live', 11)], type: 'notify' })
	await flushBuffer(ev)
	const delivered = upserts(maps)
	assert.equal(delivered.length, 1, `expected exactly one upsert batch, got ${JSON.stringify(delivered)}`)
	assert.equal(delivered[0].type, 'notify', 'the live notify channel must fire')
	assert.equal(delivered[0].messages[0].message.conversation, 'v2-live', 'the live text wins')
	assert.equal(historyMessages(maps).filter(m => m.key.id === 'M1').length, 0, 'the history copy must not also deliver M1')
	ev.destroy()
})

test('HB-421 (B): live first, history after — the message is delivered once, not twice', async () => {
	const { ev, maps } = freshBuffer()
	ev.emit('messages.upsert', { messages: [mkMsg('M1', 'v2-live', 11)], type: 'notify' })
	ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [mkMsg('M1', 'v1-history', 10)], isLatest: false })
	await flushBuffer(ev)
	const total = upsertMessages(maps).filter(m => m.key.id === 'M1').length + historyMessages(maps).filter(m => m.key.id === 'M1').length
	assert.equal(total, 1, `M1 must be delivered exactly once, got ${total}`)
	assert.equal(upserts(maps).length, 1, 'the single delivery is the live notify upsert')
	assert.equal(upserts(maps)[0].messages[0].message.conversation, 'v2-live')
	ev.destroy()
})

test('HB-421 controls: history-only and live-only are each delivered once', async () => {
	const { ev, maps } = freshBuffer()
	ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [mkMsg('M1', 'v1-history', 10)], isLatest: false })
	await flushBuffer(ev)
	assert.equal(historyMessages(maps).filter(m => m.key.id === 'M1').length, 1)
	assert.equal(upserts(maps).length, 0)
	ev.destroy()

	const second = freshBuffer()
	second.ev.emit('messages.upsert', { messages: [mkMsg('M1', 'v2-live', 11)], type: 'notify' })
	await flushBuffer(second.ev)
	assert.equal(upserts(second.maps).length, 1)
	assert.equal(upserts(second.maps)[0].type, 'notify')
	assert.equal(historyMessages(second.maps).length, 0)
	second.ev.destroy()
})

// ---------- HB-181 addendum ----------

const historyChunk = msgs => ({
	syncType: waproto.HistorySync.HistorySyncType.FULL,
	progress: 100,
	conversations: [{ id: CHAT, messages: msgs.map(m => ({ message: m })) }]
})

test('HB-181 addendum: a message with .key undefined is skipped — the rest of the chunk survives', () => {
	const good1 = mkMsg('GOOD1', 'good1', 100)
	const good2 = mkMsg('GOOD2', 'good2', 102)
	const keyless = { messageTimestamp: 101, message: { conversation: 'keyless' } }
	const out = lib.processHistoryMessage(historyChunk([good1, keyless, good2]))
	assert.deepEqual(
		out.messages.map(m => m.key.id),
		['GOOD1', 'GOOD2'],
		'the key-less entry must be skipped, not abort the chunk'
	)
	assert.equal(out.chats.length, 1, 'the chat itself must survive')
})

test('HB-181 addendum: a message with .key null is skipped the same way', () => {
	const good1 = mkMsg('GOOD1', 'good1', 100)
	const nullKey = { key: null, messageTimestamp: 101, message: { conversation: 'nullkey' } }
	const out = lib.processHistoryMessage(historyChunk([good1, nullKey]))
	assert.deepEqual(out.messages.map(m => m.key.id), ['GOOD1'])
})

// ---------- HB-2026-1113-166 addendum 1 ----------

test('HB-2026-1113-166 addendum 1: an upsert re-buffered during a type-mismatch emit is not dropped', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const delivered = []
	let rebuffered = false
	ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages) delivered.push(m.key.id)
		if (!rebuffered) {
			rebuffered = true
			// A host listener that batches its follow-up synchronously.
			ev.emit('messages.upsert', { messages: [mkMsg('M2', 're-buffered', 12)], type: 'notify' })
		}
	})
	ev.buffer()
	ev.emit('messages.upsert', { messages: [mkMsg('M1', 'first', 11)], type: 'notify' })
	// A different type forces the mismatch branch to emit the buffered M1 first.
	ev.emit('messages.upsert', { messages: [mkMsg('M3', 'third', 13)], type: 'append' })
	await flushBuffer(ev)
	await flushBuffer(ev)
	assert.deepEqual(delivered.sort(), ['M1', 'M2', 'M3'], `M2 re-buffered during the mismatch emit must survive, got ${delivered}`)
	ev.destroy()
})

// ---------- HB-425 addenda (sweep) ----------

test('HB-425 addendum (run-0724): group-participants.update + group.join-request wait for the flush, after the stub upsert', async () => {
	const { ev, maps } = freshBuffer()
	const seenEvents = []
	ev.on('event', map => seenEvents.push(...Object.keys(map)))
	ev.emit('messages.upsert', { messages: [mkMsg('S1', 'stub', 11)], type: 'append' })
	ev.emit('group-participants.update', { id: GID, author: '111@s.whatsapp.net', participants: [{ id: '222@s.whatsapp.net' }], action: 'add' })
	ev.emit('group.join-request', { id: GID, author: '111@s.whatsapp.net', participant: '333@s.whatsapp.net', action: 'add', method: 'invite_link' })
	assert.deepEqual(seenEvents, [], 'nothing may leak before the flush while buffering')
	await flushBuffer(ev)
	assert.ok(seenEvents.includes('messages.upsert'), 'the stub upsert must be delivered')
	assert.ok(seenEvents.includes('group-participants.update'), 'the participant update must be delivered')
	assert.ok(seenEvents.includes('group.join-request'), 'the join-request must be delivered')
	assert.ok(
		seenEvents.indexOf('messages.upsert') < seenEvents.indexOf('group-participants.update'),
		'the stub that explains the change must arrive before the participant update'
	)
	ev.destroy()
})

test('HB-425 addendum (chats.lock facet): a lock patch for a still-buffered chat row is not lost', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	ev.buffer()
	ev.emit('messaging-history.set', { chats: [{ id: CHAT, conversationTimestamp: 5 }], contacts: [], messages: [], isLatest: false })
	ev.emit('chats.lock', { id: CHAT, locked: true })
	await flushBuffer(ev)
	assert.equal(store.chats.get(CHAT)?.locked, true, 'the lock patch must land once the chat row exists')
	ev.destroy()
})

test('HB-425 addendum (chats.lock facet): an unlock patch for a locked buffered chat applies too', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	ev.buffer()
	ev.emit('messaging-history.set', { chats: [{ id: CHAT, conversationTimestamp: 5, locked: true }], contacts: [], messages: [], isLatest: false })
	ev.emit('chats.lock', { id: CHAT, locked: false })
	await flushBuffer(ev)
	assert.equal(store.chats.get(CHAT)?.locked, false, 'the unlock patch must land once the chat row exists')
	ev.destroy()
})

// ---------- HB-2026-1112-34 (decision) ----------

test('HB-2026-1112-34: a rejecting async creds.update listener (saveCreds failing) does not crash the process', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const rejections = []
	const onUnhandled = err => rejections.push(err)
	process.on('unhandledRejection', onUnhandled)
	try {
		// saveCreds throws by design when persist fails; the host wires it
		// as `sock.ev.on('creds.update', saveCreds)`.
		ev.on('creds.update', async () => {
			throw new Error('EISDIR: persist failed')
		})
		let secondListenerRan = false
		ev.on('creds.update', () => {
			secondListenerRan = true
		})
		ev.emit('creds.update', { accountSyncCounter: 1 })
		await sleep(50)
		assert.equal(secondListenerRan, true, 'dispatch must continue past the throwing listener')
		assert.equal(rejections.length, 0, `no unhandledRejection may escape, got ${rejections.map(String)}`)
	} finally {
		process.off('unhandledRejection', onUnhandled)
		ev.destroy()
	}
})

test('HB-2026-1112-34: a synchronously throwing creds.update listener does not stop the other listeners', () => {
	const ev = lib.makeEventBuffer(silentLogger)
	ev.on('creds.update', () => {
		throw new Error('host bug')
	})
	let secondListenerRan = false
	ev.on('creds.update', () => {
		secondListenerRan = true
	})
	ev.emit('creds.update', { accountSyncCounter: 1 })
	assert.equal(secondListenerRan, true, 'the second listener must still run')
	ev.destroy()
})

// ---------- HB-411 addendum 6 ----------
// Adapted from heartbeat run-0991 (t0991-hb411-buffer-upsert.mjs): the
// producer is the real processMessage stub path, not a hand-built update.

const GID6 = '120363012345678@g.us'

const stubCtx = ev => ({
	shouldProcessHistoryMsg: false,
	placeholderResendCache: new Map(),
	ev,
	creds: { me: undefined, accountSettings: {} },
	signalRepository: {},
	keyStore: {},
	logger: silentLogger,
	options: {},
	getMessage: async () => undefined
})

const stubMsg = params => ({
	key: { remoteJid: GID6, id: 'STUB-' + Math.random().toString(36).slice(2, 8), fromMe: false, participant: '6281111111111@s.whatsapp.net' },
	messageStubType: waproto.WebMessageInfo.StubType.GROUP_CHANGE_SUBJECT,
	messageStubParameters: params,
	messageTimestamp: 1763550000
})

const seedGroupMeta6 = store => {
	store.groupMetadata[GID6] = { id: GID6, subject: 'Old Subject', desc: 'Old desc', inviteCode: 'OLDCODE', participants: [] }
}

test('HB-411 addendum 6 (T1): a parameter-less subject stub in a buffered window must not erase the pending upsert chat name', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	seedGroupMeta6(store)
	ev.buffer()
	ev.emit('chats.upsert', [{ id: GID6, name: 'Old Subject', conversationTimestamp: 1000 }])
	await processMessage(stubMsg([undefined]), stubCtx(ev))
	await flushBuffer(ev)
	assert.equal(store.chats.get(GID6)?.name, 'Old Subject', 'the buffered chats.update { name: undefined } must not clobber the upsert name')
	assert.equal(store.groupMetadata[GID6]?.subject, 'Old Subject', 'the group subject must hold too (store trims groups.update)')
	ev.destroy()
})

test('HB-411 addendum 6 (T3): the same stub must not erase a buffered history-set chat name', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	seedGroupMeta6(store)
	ev.buffer()
	ev.emit('messaging-history.set', { chats: [{ id: GID6, name: 'Old Subject', conversationTimestamp: 1000 }], contacts: [], messages: [], isLatest: false })
	await processMessage(stubMsg([undefined]), stubCtx(ev))
	await flushBuffer(ev)
	assert.equal(store.chats.get(GID6)?.name, 'Old Subject', 'the buffered chats.update { name: undefined } must not clobber the history chat name')
	assert.equal(store.groupMetadata[GID6]?.subject, 'Old Subject')
	ev.destroy()
})

test('HB-411 addendum 6 (T0 control): the direct path already holds (2.4.0 store trim)', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	seedGroupMeta6(store)
	ev.emit('chats.upsert', [{ id: GID6, name: 'Old Subject', conversationTimestamp: 1000 }])
	ev.flush()
	await processMessage(stubMsg([undefined]), stubCtx(ev))
	ev.flush()
	assert.equal(store.chats.get(GID6)?.name, 'Old Subject')
	assert.equal(store.groupMetadata[GID6]?.subject, 'Old Subject')
	ev.destroy()
})

test('HB-411 addendum 6 (T2 control): a well-formed subject stub still renames through the buffer', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	seedGroupMeta6(store)
	ev.buffer()
	ev.emit('chats.upsert', [{ id: GID6, name: 'Old Subject', conversationTimestamp: 1000 }])
	await processMessage(stubMsg(['New Subject']), stubCtx(ev))
	await flushBuffer(ev)
	assert.equal(store.chats.get(GID6)?.name, 'New Subject', 'a defined rename must still land')
	assert.equal(store.groupMetadata[GID6]?.subject, 'New Subject')
	ev.destroy()
})

// --- Coordinator: HB-2026-1113-223 addendum 7 (2.5.0) — a redelivered
// CIPHERTEXT stub must not clobber the good stored copy ---

test('HB-2026-1113-223 addendum 7: a CIPHERTEXT stub upsert does not replace a stored message with content (append)', async () => {
	const { MISSING_KEYS_ERROR_TEXT } = await import('../lib/Utils/decode-wa-message.js')
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	const good = {
		key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-1' },
		messageTimestamp: 100,
		message: { conversation: 'hello good copy' }
	}
	ev.emit('messages.upsert', { messages: [good], type: 'append' })
	assert.equal((await store.loadMessage(CHAT, 'ADD7-1'))?.message?.conversation, 'hello good copy')
	// Exactly what handleMessage's MISSING_KEYS branch upserts on a
	// redelivery past the dedup window: same key id, no `message`,
	// stub CIPHERTEXT with the MISSING_KEYS param.
	const stub = {
		key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-1' },
		messageTimestamp: 101,
		messageStubType: waproto.WebMessageInfo.StubType.CIPHERTEXT,
		messageStubParameters: [MISSING_KEYS_ERROR_TEXT]
	}
	ev.emit('messages.upsert', { messages: [stub], type: 'append' })
	const kept = await store.loadMessage(CHAT, 'ADD7-1')
	assert.equal(kept?.message?.conversation, 'hello good copy', 'the stored content must survive the stub redelivery')
	assert.equal(kept?.messageStubType, undefined, 'the stored copy must not gain the stub type')
})

test('HB-2026-1113-223 addendum 7: same guard on the notify path', async () => {
	const { MISSING_KEYS_ERROR_TEXT } = await import('../lib/Utils/decode-wa-message.js')
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('messages.upsert', { messages: [{ key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-2' }, messageTimestamp: 100, message: { conversation: 'notify good copy' } }], type: 'notify' })
	const stub = {
		key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-2' },
		messageTimestamp: 101,
		messageStubType: waproto.WebMessageInfo.StubType.CIPHERTEXT,
		messageStubParameters: [MISSING_KEYS_ERROR_TEXT]
	}
	ev.emit('messages.upsert', { messages: [stub], type: 'notify' })
	assert.equal((await store.loadMessage(CHAT, 'ADD7-2'))?.message?.conversation, 'notify good copy')
})

test('HB-2026-1113-223 addendum 7 (controls): a stub still inserts when nothing is stored, and content still replaces a stub', async () => {
	const { MISSING_KEYS_ERROR_TEXT } = await import('../lib/Utils/decode-wa-message.js')
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	// First sight of a failed decrypt: the stub is the only copy — it must still insert.
	const stub = {
		key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-3' },
		messageTimestamp: 100,
		messageStubType: waproto.WebMessageInfo.StubType.CIPHERTEXT,
		messageStubParameters: [MISSING_KEYS_ERROR_TEXT]
	}
	ev.emit('messages.upsert', { messages: [stub], type: 'append' })
	assert.equal((await store.loadMessage(CHAT, 'ADD7-3'))?.messageStubType, waproto.WebMessageInfo.StubType.CIPHERTEXT)
	// A later decrypt success for the same id must still replace the stub with content.
	ev.emit('messages.upsert', { messages: [{ key: { remoteJid: CHAT, fromMe: false, id: 'ADD7-3' }, messageTimestamp: 101, message: { conversation: 'late content' } }], type: 'append' })
	const replaced = await store.loadMessage(CHAT, 'ADD7-3')
	assert.equal(replaced?.message?.conversation, 'late content')
	assert.equal(replaced?.messageStubType, undefined)
})
