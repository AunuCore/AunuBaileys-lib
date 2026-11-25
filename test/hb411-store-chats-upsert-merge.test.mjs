// HB-411 addendum 8 (2.7.0): the in-memory store's chats.upsert
// handler must MERGE the incoming row over the stored row (like
// chats.update does) — KeyedDB.upsert replaces the row whole, so a
// partial upsert that does not carry a field (e.g. a group-create
// upsert without a subject/name) used to erase the stored value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, silentLogger } from './helpers.mjs'

const makeBoundStore = () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	return { store, ev }
}

test('HB-411 add.8: a partial chats.upsert preserves the stored chat name', () => {
	const { store, ev } = makeBoundStore()
	const jid = '120363000000000001@g.us'
	ev.emit('chats.upsert', [{ id: jid, name: 'Stored Group Name', conversationTimestamp: 100 }])
	// partial upsert: no name carried at all
	ev.emit('chats.upsert', [{ id: jid, conversationTimestamp: 200 }])
	const chat = store.chats.get(jid)
	assert.equal(chat?.name, 'Stored Group Name', 'stored name must survive a partial upsert')
	assert.equal(chat?.conversationTimestamp, 200, 'carried fields still win')
})

test('HB-411 add.8: a chats.upsert carrying a new name replaces the stored name', () => {
	const { store, ev } = makeBoundStore()
	const jid = '120363000000000002@g.us'
	ev.emit('chats.upsert', [{ id: jid, name: 'Old Name', conversationTimestamp: 100 }])
	ev.emit('chats.upsert', [{ id: jid, name: 'New Name', conversationTimestamp: 200 }])
	assert.equal(store.chats.get(jid)?.name, 'New Name')
})

test('HB-411 add.8: a chats.upsert carrying name:undefined does not erase the stored name', () => {
	const { store, ev } = makeBoundStore()
	const jid = '120363000000000003@g.us'
	ev.emit('chats.upsert', [{ id: jid, name: 'Kept Name', conversationTimestamp: 100 }])
	ev.emit('chats.upsert', [{ id: jid, name: undefined, conversationTimestamp: 200 }])
	assert.equal(store.chats.get(jid)?.name, 'Kept Name')
})
