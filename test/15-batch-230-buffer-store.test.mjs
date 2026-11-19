// AunuBaileys 2.3.0 batch regressions — Cluster A (event-buffer + store + chats):
// HB-373 (chats.delete cleanup), HB-379 (flush delete-all order),
// HB-359 addenda (nested flush + same-generation timers), HB-390 (READ
// decrement on history chats), HB-393 + addendum (mark-read 0 summing /
// mark-unread -1 in the store), HB-394 (repeated history chat),
// HB-396 (label rename at cap), HB-397 (chats.lock in the store).
// Each test names the behaviour it locks in and fails without its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, silentLogger, sleep } from './helpers.mjs'
import { WAMessageStatus } from '../lib/Types/Message.js'

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

// ---------- HB-373 ----------

test('HB-373: chats.delete removes the chat messages, presences and label associations too', async () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	const jid = '123@s.whatsapp.net'

	ev.emit('chats.upsert', [{ id: jid, conversationTimestamp: 100 }])
	ev.emit('messages.upsert', {
		messages: [{ key: { remoteJid: jid, id: 'M1', fromMe: false }, message: { conversation: 'hi' }, messageTimestamp: 1 }],
		type: 'append'
	})
	ev.emit('presence.update', { id: jid, presences: { [jid]: { lastKnownPresence: 'available' } } })
	ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId: jid, labelId: '1' } })

	assert.ok(await store.loadMessage(jid, 'M1'), 'setup: message must be loadable before the delete')
	assert.equal(store.getChatLabels(jid).length, 1, 'setup: label association must exist before the delete')
	assert.ok(store.presences[jid], 'setup: presence must exist before the delete')

	ev.emit('chats.delete', [jid])

	assert.equal(store.chats.get(jid), undefined, 'chat row is gone')
	assert.equal(await store.loadMessage(jid, 'M1'), undefined, 'messages of a deleted chat must not be served')
	assert.equal(await store.mostRecentMessage(jid), undefined, 'mostRecentMessage must not serve a deleted chat')
	assert.deepEqual(store.getChatLabels(jid), [], 'label associations of a deleted chat must be dropped')
	assert.equal(store.presences[jid], undefined, 'presences of a deleted chat must be dropped')
})

// ---------- HB-379 ----------

test('HB-379: a message arriving after a buffered clear-chat is not wiped by it', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	const jid = '123@s.whatsapp.net'

	ev.buffer()
	ev.emit('messages.delete', { jid, all: true })
	ev.emit('messages.upsert', {
		messages: [{ key: { remoteJid: jid, id: 'NEW1', fromMe: false }, message: { conversation: 'after clear' }, messageTimestamp: 2 }],
		type: 'append'
	})
	await flushBuffer(ev)

	assert.ok(await store.loadMessage(jid, 'NEW1'), 'the post-clear message must survive the flush')
	ev.destroy()
})

test('HB-379: a clear-chat arriving after the message still clears it', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const delivered = []
	ev.on('messages.delete', d => delivered.push(d))
	ev.buffer()
	ev.emit('messages.upsert', {
		messages: [{ key: { remoteJid: '123@s.whatsapp.net', id: 'OLD1', fromMe: false }, message: { conversation: 'x' }, messageTimestamp: 1 }],
		type: 'append'
	})
	ev.emit('messages.delete', { jid: '123@s.whatsapp.net', all: true })
	ev.flush()
	assert.equal(delivered.length, 1, 'the later delete-all must still be delivered')
	assert.equal(delivered[0].all, true)
	ev.destroy()
})

// ---------- HB-359 addendum: nested flush ----------

test('HB-359 addendum: a nested flush releases one level instead of ending the outer session', () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('chats.upsert', chats => seen.push(...chats.map(c => c.id)))

	ev.buffer() // outer session (initial sync)
	ev.emit('chats.upsert', [{ id: 'outer@g.us' }])
	ev.buffer() // processNodeWithBuffer around a live stanza
	ev.emit('chats.upsert', [{ id: 'stanza@g.us' }])
	assert.equal(ev.flush(), false, 'nested flush must not flush the outer session')
	assert.equal(ev.isBuffering(), true, 'outer session must still be alive')
	assert.deepEqual(seen, [], 'nothing may be delivered by the nested flush')

	ev.emit('chats.upsert', [{ id: 'after@g.us' }])
	assert.deepEqual(seen, [], 'events after the nested flush must still be buffered')

	assert.equal(ev.flush(), true, 'the outer flush delivers everything at once')
	assert.deepEqual(seen, ['outer@g.us', 'stanza@g.us', 'after@g.us'])
	ev.destroy()
})

// ---------- HB-359 addendum: same-generation timers ----------

test('HB-359 addendum: a 100ms flush timer does not fire in the middle of replacement work in the same session', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const delivered = []
	const t0 = Date.now()
	ev.on('chats.upsert', chats => {
		for (const c of chats) delivered.push({ at: Date.now() - t0, id: c.id })
	})

	const fnA = ev.createBufferedFunction(async () => {
		ev.emit('chats.upsert', [{ id: 'a@s.whatsapp.net', conversationTimestamp: 1 }])
	})
	const fnB = ev.createBufferedFunction(async () => {
		await sleep(250)
		ev.emit('chats.upsert', [{ id: 'b@s.whatsapp.net', conversationTimestamp: 2 }])
	})

	await fnA() // arms the 100ms timers
	assert.equal(ev.isBuffering(), true, 'session must be buffering right after A completes')
	await sleep(10)
	const pB = fnB() // replacement work in the SAME session/generation
	await sleep(140) // past the +100ms timer fire; B still running
	assert.equal(ev.isBuffering(), true, 'session must still be alive at +150ms while B runs')
	await pB
	await sleep(200) // B's own completion flush settles (~+100ms after B ends)

	const b = delivered.find(d => d.id === 'b@s.whatsapp.net')
	assert.ok(b, 'B event must be delivered eventually')
	assert.ok(b.at >= 330, `B event must wait for a flush after B completes (~+360ms), got +${b.at}ms`)
	ev.destroy()
})

// ---------- HB-390 ----------

test('HB-390: READ decrement reaches a chat that only lives in the history set', () => {
	const { ev, maps } = freshBuffer()
	const chat = '6281111111@s.whatsapp.net'
	const msg = {
		key: { remoteJid: chat, id: 'MSG390', fromMe: false },
		message: { conversation: 'hi' },
		messageTimestamp: 1760000000
	}
	ev.emit('messaging-history.set', { chats: [{ id: chat, unreadCount: 1 }], messages: [msg], contacts: [] })
	ev.emit('messages.update', [{ key: msg.key, update: { status: WAMessageStatus.READ } }])
	ev.flush()
	const flushed = maps[0]?.['messaging-history.set']?.chats?.[0]
	assert.ok(flushed, 'history set must be flushed')
	assert.ok(
		flushed.unreadCount === undefined || flushed.unreadCount === 0,
		`history chat unreadCount must be decremented after READ, got ${flushed.unreadCount}`
	)
	ev.destroy()
})

// ---------- HB-393 ----------

test('HB-393: mark-read unreadCount 0 assigns instead of being summed into the pending count', () => {
	const { ev, maps } = freshBuffer()
	const chat = '6281111111@s.whatsapp.net'
	ev.emit('messaging-history.set', {
		chats: [{ id: chat, unreadCount: 3, conversationTimestamp: 100 }],
		messages: [],
		contacts: [],
		syncType: 1,
		isLatest: true
	})
	ev.emit('chats.update', [{ id: chat, unreadCount: 0 }])
	ev.flush()
	const flushed = maps[0]?.['messaging-history.set']?.chats?.[0]
	assert.ok(flushed.unreadCount === 0 || flushed.unreadCount === undefined, `got unreadCount=${flushed.unreadCount}`)
	ev.destroy()
})

test('HB-393: a pending conditional mark-read absorbed into a history chat wins over the snapshot count', () => {
	const { ev, maps } = freshBuffer()
	const chat = '6281111111@s.whatsapp.net'
	ev.emit('chats.update', [
		{
			id: chat,
			unreadCount: 0,
			conditional: data => {
				const c = data.historySets.chats[chat] || data.chatUpserts[chat]
				if (c) return true
			}
		}
	])
	ev.emit('messaging-history.set', {
		chats: [{ id: chat, unreadCount: 3, conversationTimestamp: 100 }],
		messages: [],
		contacts: [],
		syncType: 1,
		isLatest: true
	})
	ev.flush()
	const flushed = maps[0]?.['messaging-history.set']?.chats?.[0]
	assert.ok(flushed.unreadCount === 0 || flushed.unreadCount === undefined, `got unreadCount=${flushed.unreadCount}`)
	ev.destroy()
})

test('HB-393: positive unread deltas still accumulate', () => {
	const { ev, maps } = freshBuffer()
	const chat = '6282222222@s.whatsapp.net'
	ev.emit('chats.upsert', [{ id: chat, unreadCount: 1, conversationTimestamp: 200 }])
	ev.emit('chats.upsert', [{ id: chat, unreadCount: 1, conversationTimestamp: 201 }])
	ev.flush()
	const flushed = maps[0]?.['chats.upsert']?.find(c => c.id === chat)
	assert.equal(flushed?.unreadCount, 2)
	ev.destroy()
})

// ---------- HB-393 addendum (store) ----------

test('HB-393 addendum: the store does not keep the mark-unread -1 sentinel, so the next +1 lands on 1', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	const jid = '123@s.whatsapp.net'

	ev.emit('chats.upsert', [{ id: jid, conversationTimestamp: 100, unreadCount: 2 }])
	await flushBuffer(ev)
	assert.equal(store.chats.get(jid)?.unreadCount, 2, 'setup: chat stored with unreadCount 2')

	ev.emit('chats.update', [{ id: jid, unreadCount: -1 }])
	await flushBuffer(ev)
	assert.notEqual(store.chats.get(jid)?.unreadCount, -1, 'the -1 sentinel must not be stored as a count')

	ev.emit('chats.update', [{ id: jid, unreadCount: 1, conversationTimestamp: 200 }])
	await flushBuffer(ev)
	assert.equal(store.chats.get(jid)?.unreadCount, 1, 'the next real message must count as 1 unread, not 0')
	ev.destroy()
})

// ---------- HB-394 ----------

test('HB-394: a chat repeated in one history session keeps the fresher snapshot fields', () => {
	const { ev, maps } = freshBuffer()
	const chat = '6281111111@s.whatsapp.net'
	ev.emit('messaging-history.set', {
		chats: [{ id: chat, unreadCount: 1, conversationTimestamp: 100, name: 'Old' }],
		messages: [],
		contacts: []
	})
	ev.emit('messaging-history.set', {
		chats: [{ id: chat, unreadCount: 5, conversationTimestamp: 200, name: 'New' }],
		messages: [],
		contacts: []
	})
	ev.flush()
	const flushed = maps[0]?.['messaging-history.set']?.chats?.find(c => c.id === chat)
	assert.equal(flushed?.name, 'New')
	assert.equal(flushed?.unreadCount, 5)
	assert.equal(flushed?.conversationTimestamp, 200)
	ev.destroy()
})

// ---------- HB-396 ----------

test('HB-396: renaming an existing label applies even when the 20-label cap is reached', () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	for (let i = store.labels.count(); i < 20; i++) {
		ev.emit('labels.edit', { id: `lbl-${i}`, name: `Label ${i}`, color: 1, deleted: false })
	}
	assert.equal(store.labels.count(), 20, 'setup: cap reached')

	ev.emit('labels.edit', { id: '1', name: 'Renamed customer', color: 9, deleted: false })
	assert.equal(store.labels.findById('1')?.name, 'Renamed customer', 'rename of an existing label must apply at cap')

	ev.emit('labels.edit', { id: 'lbl-new', name: 'Brand new', color: 1, deleted: false })
	assert.equal(store.labels.findById('lbl-new'), undefined, 'a genuinely new label must still be refused at cap')
})

// ---------- HB-397 ----------

test('HB-397: chats.lock state is persisted on the chat in the store', () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('chats.upsert', [{ id: '123@g.us', conversationTimestamp: 100 }])

	ev.emit('chats.lock', { id: '123@g.us', locked: true })
	assert.equal(store.chats.get('123@g.us')?.locked, true, 'locked chat must read back as locked')

	ev.emit('chats.lock', { id: '123@g.us', locked: false })
	assert.equal(store.chats.get('123@g.us')?.locked, false, 'unlocked chat must read back as unlocked')
})
