// AunuBaileys 2.3.0 batch regressions — Scope 7 (HB-404):
// flush delivered chats.delete BEFORE an earlier messages.upsert in
// fixed category order, so a pre-delete message arrived after the
// delete and the store's notify handler recreated the chat (or, with
// type append, the pre-delete message stayed loadable). A buffered
// chats.delete must drop the older buffered message events for that
// chat; a message arriving AFTER the delete must still recreate it.
// Ported from heartbeat harness t0577-chatdelete-upsert.mjs (T1–T4),
// plus sibling-isolation (T5) and history-message (T6) coverage.
// Each test fails without the HB-404 fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, silentLogger, sleep } from './helpers.mjs'

const C = '1234567890@s.whatsapp.net'
const D = '0987654321@s.whatsapp.net'
const msg = (jid, id, ts) => ({
	key: { remoteJid: jid, id, fromMe: false },
	message: { conversation: 'msg ' + id },
	messageTimestamp: ts
})

const fresh = () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	const order = []
	ev.on('event', map => {
		for (const k of Object.keys(map)) order.push(k)
	})
	return { ev, store, order }
}

const setupChat = async (ev, store) => {
	ev.emit('chats.upsert', [{ id: C, conversationTimestamp: 100 }])
	ev.emit('messages.upsert', { messages: [msg(C, 'M0', 100)], type: 'append' })
	await sleep(10)
	assert.ok(store.chats.get(C), 'setup: chat must exist')
	assert.ok(await store.loadMessage(C, 'M0'), 'setup: M0 must be loadable')
}

const flushBuffer = async ev => {
	ev.flush()
	await sleep(30)
}

// ---------- HB-404 ----------

test('HB-404 T1: [upsert-notify, delete] in one session — the delete wins, no resurrection', async () => {
	const { ev, store, order } = fresh()
	await setupChat(ev, store)
	order.length = 0
	ev.buffer()
	ev.emit('messages.upsert', { messages: [msg(C, 'M1', 200)], type: 'notify' })
	ev.emit('chats.delete', [C])
	await flushBuffer(ev)

	assert.equal(store.chats.get(C), undefined, 'the deleted chat must not come back')
	assert.equal(await store.loadMessage(C, 'M1'), undefined, 'the pre-delete message must not survive')
	assert.equal(await store.loadMessage(C, 'M0'), undefined, 'pre-existing messages must be gone too')
	ev.destroy()
})

test('HB-404 T2: [delete, upsert-notify] in one session — the newer message still recreates the chat', async () => {
	const { ev, store, order } = fresh()
	await setupChat(ev, store)
	order.length = 0
	ev.buffer()
	ev.emit('chats.delete', [C])
	ev.emit('messages.upsert', { messages: [msg(C, 'M1', 200)], type: 'notify' })
	await flushBuffer(ev)

	assert.ok(store.chats.get(C), 'a newer message must recreate the chat')
	assert.equal(store.chats.get(C).unreadCount, 1, 'the recreated chat carries the notify unread')
	assert.ok(await store.loadMessage(C, 'M1'), 'the newer message must be loadable')
	assert.ok(order.includes('chats.delete'), 'the delete itself must still be delivered')
	assert.ok(
		order.indexOf('chats.delete') < order.indexOf('messages.upsert'),
		'delete is delivered before the newer upsert'
	)
	ev.destroy()
})

test('HB-404 T3: unbuffered [upsert, delete] still delivers in arrival order', async () => {
	const { ev, store } = fresh()
	await setupChat(ev, store)
	ev.emit('messages.upsert', { messages: [msg(C, 'M1', 200)], type: 'notify' })
	ev.emit('chats.delete', [C])
	await sleep(30)

	assert.equal(store.chats.get(C), undefined, 'chat must be gone')
	assert.equal(await store.loadMessage(C, 'M1'), undefined, 'M1 must be gone')
	ev.destroy()
})

test('HB-404 T4: [upsert-append, delete] in one session — the pre-delete message must not stay loadable', async () => {
	const { ev, store, order } = fresh()
	await setupChat(ev, store)
	order.length = 0
	ev.buffer()
	ev.emit('messages.upsert', { messages: [msg(C, 'M1', 200)], type: 'append' })
	ev.emit('chats.delete', [C])
	await flushBuffer(ev)

	assert.equal(store.chats.get(C), undefined, 'chat row must stay gone')
	assert.equal(await store.loadMessage(C, 'M1'), undefined, 'the pre-delete append message must not survive')
	ev.destroy()
})

test('HB-404 T5: the delete drops only its own chat — sibling messages, updates, reactions and receipts survive', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const delivered = []
	ev.on('event', map => delivered.push(map))
	ev.buffer()
	// Pre-delete message events for C: upsert + update + reaction + receipt for the pre-existing M0.
	ev.emit('messages.upsert', { messages: [msg(C, 'M1', 200)], type: 'append' })
	ev.emit('messages.update', [{ key: msg(C, 'M0', 100).key, update: { status: 3 } }])
	ev.emit('messages.reaction', [{ key: msg(C, 'M0', 100).key, reaction: { key: msg(C, 'M0', 100).key, text: 'heart' } }])
	ev.emit('message-receipt.update', [{ key: msg(C, 'M0', 100).key, receipt: { userJid: C, receiptTimestamp: 300 } }])
	// Same-shape events for the sibling chat D, which is not deleted.
	ev.emit('messages.upsert', { messages: [msg(D, 'N1', 200)], type: 'append' })
	ev.emit('messages.update', [{ key: msg(D, 'N0', 100).key, update: { status: 3 } }])
	ev.emit('chats.delete', [C])
	await flushBuffer(ev)

	const upserts = delivered.filter(m => m['messages.upsert']).flatMap(m => m['messages.upsert'].messages)
	assert.deepEqual(
		upserts.map(m => m.key.id),
		['N1'],
		"only the sibling chat's message may be flushed"
	)
	assert.equal(
		delivered.filter(m => m['messages.update']).length,
		1,
		"only the sibling chat's update may be flushed"
	)
	assert.equal(
		delivered.filter(m => m['messages.reaction']).length,
		0,
		"the deleted chat's reaction must be dropped"
	)
	assert.equal(
		delivered.filter(m => m['message-receipt.update']).length,
		0,
		"the deleted chat's receipt must be dropped"
	)
	assert.deepEqual(
		delivered.filter(m => m['chats.delete']).flatMap(m => m['chats.delete']),
		[C],
		'the delete itself must still be delivered'
	)
	ev.destroy()
})

test('HB-404 T6: a history-sync message for the deleted chat is dropped with it', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const delivered = []
	ev.on('event', map => delivered.push(map))
	ev.buffer()
	ev.emit('messaging-history.set', {
		chats: [{ id: C, conversationTimestamp: 100 }],
		messages: [msg(C, 'M1', 200)],
		contacts: [],
		isLatest: true
	})
	ev.emit('chats.delete', [C])
	await flushBuffer(ev)

	const history = delivered.filter(m => m['messaging-history.set'])
	assert.equal(history.length, 1, 'the history set is still delivered')
	assert.deepEqual(history[0]['messaging-history.set'].chats, [], 'the deleted chat must leave the history set')
	assert.deepEqual(history[0]['messaging-history.set'].messages, [], 'its history message must leave with it')
	ev.destroy()
})
