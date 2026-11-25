// HB-490 (2.7.0): absorbingChatUpdate must merge the pending
// chats.update OVER the history snapshot / live upsert, not under it.
// Mirrors the run-1096 harness cases: archive/pin/mute updates that
// arrive before the snapshot must survive absorption, and the HB-393
// unreadCount protection (mark-read 0 / mark-unread -1 on history
// chats) must keep working after the merge-order swap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, silentLogger, sleep } from './helpers.mjs'

const runCase = setup => {
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = {}
	ev.on('messaging-history.set', data => {
		seen.history = data
	})
	ev.on('chats.upsert', data => {
		seen.chatUpserts = data
	})
	ev.buffer()
	setup(ev)
	ev.flush()
	return seen
}

const historySet = chats => ({ chats, contacts: [], messages: [], isLatest: false })

test('HB-490: pending archived=true survives a history snapshot carrying archived=false', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '111@s.whatsapp.net', archived: true }])
		ev.emit('messaging-history.set', historySet([{ id: '111@s.whatsapp.net', archived: false, conversationTimestamp: 100 }]))
	})
	await sleep(20)
	assert.equal(seen.history?.chats?.[0]?.archived, true)
})

test('HB-490: pending pinned timestamp survives a snapshot carrying pinned=null', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '333@s.whatsapp.net', pinned: 1700000000 }])
		ev.emit('messaging-history.set', historySet([{ id: '333@s.whatsapp.net', pinned: null, conversationTimestamp: 100 }]))
	})
	await sleep(20)
	assert.equal(seen.history?.chats?.[0]?.pinned, 1700000000)
})

test('HB-490: pending muteEndTime survives a snapshot carrying an older muteEndTime', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '444@s.whatsapp.net', muteEndTime: 999999 }])
		ev.emit('messaging-history.set', historySet([{ id: '444@s.whatsapp.net', muteEndTime: 111111, conversationTimestamp: 100 }]))
	})
	await sleep(20)
	assert.equal(seen.history?.chats?.[0]?.muteEndTime, 999999)
})

test('HB-490: pending archived=true survives absorption into a live chats.upsert', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '666@s.whatsapp.net', archived: true }])
		ev.emit('chats.upsert', [{ id: '666@s.whatsapp.net', archived: false, conversationTimestamp: 100 }])
	})
	await sleep(20)
	assert.equal(seen.chatUpserts?.[0]?.archived, true)
})

test('HB-490 + HB-393: pending mark-read unreadCount=0 still wins over a snapshot count of 5', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '555@s.whatsapp.net', unreadCount: 0 }])
		ev.emit('messaging-history.set', historySet([{ id: '555@s.whatsapp.net', unreadCount: 5, conversationTimestamp: 100 }]))
	})
	await sleep(20)
	assert.equal(seen.history?.chats?.[0]?.unreadCount, 0)
})

test('HB-490 + HB-393: pending mark-unread unreadCount=-1 still deletes the snapshot count', async () => {
	const seen = runCase(ev => {
		ev.emit('chats.update', [{ id: '777@s.whatsapp.net', unreadCount: -1 }])
		ev.emit('messaging-history.set', historySet([{ id: '777@s.whatsapp.net', unreadCount: 5, conversationTimestamp: 100 }]))
	})
	await sleep(20)
	assert.equal(seen.history?.chats?.[0]?.unreadCount, undefined)
})
