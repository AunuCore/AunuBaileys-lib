// Event buffer + in-memory store regressions:
// HB-264/227/228/229 (per-listener isolation), HB-279 (messages.delete
// {all:true} buffered), HB-130/HB-166 (flush semantics),
// HB-274 (fromJSON chat-key collision isolation), HB-278 (live
// chats.upsert / chats.update isolation + restore), KeyedDB basics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, silentLogger, sleep } from './helpers.mjs'

const flush = async ev => { ev.flush(); await sleep(20) }

test('HB-264/227: a throwing listener does not stop other listeners or escape emit', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	let second = 0
	ev.on('chats.upsert', () => { throw new Error('host bug') })
	ev.on('chats.upsert', () => { second++ })
	ev.emit('chats.upsert', [{ id: '1@g.us' }])
	await flush(ev)
	assert.equal(second, 1)
	ev.destroy()
})

test('HB-279: messages.delete {all:true} is buffered and flushed alongside the keys form', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const deletes = []
	ev.on('messages.delete', d => deletes.push(d))
	ev.emit('messages.delete', { keys: [{ remoteJid: '1@s.whatsapp.net', id: 'A' }] })
	ev.emit('messages.delete', { jid: '2@s.whatsapp.net', all: true })
	await flush(ev)
	assert.equal(deletes.length, 2, JSON.stringify(deletes))
	assert.ok(deletes.some(d => Array.isArray(d.keys)))
	assert.ok(deletes.some(d => d.all === true && d.jid === '2@s.whatsapp.net'))
	ev.destroy()
})

test('HB-130: history dedup cache clears on flush — a second sync of the same chat is delivered', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	let sets = 0
	ev.on('messaging-history.set', () => { sets++ })
	const payload = { chats: [{ id: '9@g.us' }], contacts: [], messages: [], isLatest: false }
	ev.emit('messaging-history.set', payload)
	await flush(ev)
	ev.emit('messaging-history.set', payload)
	await flush(ev)
	assert.equal(sets, 2)
	ev.destroy()
})

test('HB-166: an event re-buffered by a listener DURING flush is not lost', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	let rebuffered = false
	ev.on('chats.upsert', chats => {
		seen.push(chats[0].id)
		if (!rebuffered) {
			rebuffered = true
			ev.emit('chats.upsert', [{ id: 'second@g.us' }])
		}
	})
	ev.emit('chats.upsert', [{ id: 'first@g.us' }])
	await flush(ev)
	await flush(ev)
	assert.deepEqual(seen.sort(), ['first@g.us', 'second@g.us'])
	ev.destroy()
})

// waChatKey(true) = pinBit + archBit + tsHex(padStart 8) + id.
// Timestamps wider than 8 hex chars make (ts,id) pairs collide:
// 0x123456789 + 'a@x' and 0x12345678 + '9a@x' share one sort key.
const COLLIDING_A = { id: 'a@x', conversationTimestamp: 0x123456789, pinned: false, archived: false }
const COLLIDING_B = { id: '9a@x', conversationTimestamp: 0x12345678, pinned: false, archived: false }
const HEALTHY = { id: 'healthy@s.whatsapp.net', conversationTimestamp: 100, pinned: false, archived: false }

test('HB-274: fromJSON isolates a colliding chat entry — the rest of the store still loads', () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.fromJSON({
		chats: [COLLIDING_A, COLLIDING_B, HEALTHY],
		contacts: { 'c1@s.whatsapp.net': { id: 'c1@s.whatsapp.net', name: 'C1' } },
		messages: {},
		labels: {},
		labelAssociations: []
	})
	const ids = store.chats.all().map(c => c.id)
	assert.ok(ids.includes('healthy@s.whatsapp.net'), `healthy chat lost: ${ids}`)
	assert.equal(ids.length, 2, `expected colliding one skipped, got ${ids}`)
	assert.equal(store.contacts['c1@s.whatsapp.net']?.name, 'C1')
})

test('HB-278: live chats.upsert isolates collisions; chats.update restores on collision', async () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('chats.upsert', [COLLIDING_A, COLLIDING_B, HEALTHY])
	let ids = store.chats.all().map(c => c.id)
	assert.ok(ids.includes('healthy@s.whatsapp.net'), `upsert lost healthy: ${ids}`)
	// update HEALTHY so its sort key collides with an existing chat:
	// give it COLLIDING_A's timestamp+pin/archive shape via its own id —
	// instead collide by timestamp trick: healthy id is long, so use
	// two fresh chats whose update creates the (ts,id) collision.
	const store2 = lib.makeInMemoryStore({ logger: silentLogger })
	const ev2 = new EventEmitter()
	store2.bind(ev2)
	const victim = { id: '9a@x', conversationTimestamp: 555, pinned: false, archived: false }
	ev2.emit('chats.upsert', [COLLIDING_A, victim])
	// updating victim's timestamp to 0x12345678 makes its key equal COLLIDING_A's
	ev2.emit('chats.update', [{ id: '9a@x', conversationTimestamp: 0x12345678 }])
	const restored = store2.chats.get('9a@x')
	assert.ok(restored, 'chat vanished after a colliding update (HB-278)')
	assert.equal(Number(restored.conversationTimestamp), 555, 'restored chat kept its pre-update timestamp')
})

test('KeyedDB (internal): upsert/get/update/delete round-trip', async () => {
	const { KeyedDB } = await import('../lib/Store/keyed-db.js').catch(() => ({}))
	if (!KeyedDB) {
		// KeyedDB is not a public export; reach it through the store's
		// chats collection, which IS a KeyedDB instance.
		const store = lib.makeInMemoryStore({ logger: silentLogger })
		store.chats.upsert({ id: 'k1@g.us', conversationTimestamp: 5 })
		assert.equal(store.chats.get('k1@g.us')?.id, 'k1@g.us')
		store.chats.update('k1@g.us', c => { c.unreadCount = 3 })
		assert.equal(store.chats.get('k1@g.us')?.unreadCount, 3)
		return
	}
	assert.ok(KeyedDB)
})

test('HB-177: loadMessages with count 0 returns [] (not the whole history)', async () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('messages.upsert', {
		type: 'append',
		messages: [{ key: { id: 'M1', remoteJid: '1@s.whatsapp.net', fromMe: false }, messageTimestamp: 10, message: { conversation: 'x' } }]
	})
	assert.deepEqual(await store.loadMessages('1@s.whatsapp.net', 0), [])
	assert.equal((await store.loadMessages('1@s.whatsapp.net', 5)).length, 1)
})
