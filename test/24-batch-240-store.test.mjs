// Batch 2.4.0 — Kelompok STORE regressions (make-in-memory-store):
// HB-406 (admin split-brain / add field loss / modify ignored),
// HB-411 + addenda 2/3/4 (undefined fields clobbering stored values),
// HB-431 (phantom unread for own messages), HB-445 + HB-278 addendum 2
// (waLabelAssociationKey collisions), HB-460 + HB-2026-1112-40
// addendum 4 store facet (id-less participants), HB-373 addenda
// (chats.delete groupMetadata, isLatest wipe, remove presence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, silentLogger } from './helpers.mjs'

const makeStore = () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	return { store, ev }
}

const GID = '1234567890@g.us'
const seedGroup = store => {
	store.groupMetadata[GID] = {
		id: GID,
		subject: 'Test Group',
		participants: [
			{ id: '111@lid', phoneNumber: '628111@s.whatsapp.net', lid: '111@lid', admin: null },
			{ id: '222@lid', phoneNumber: '628222@s.whatsapp.net', lid: '222@lid', admin: 'admin' },
			{ id: '333@lid', phoneNumber: '628333@s.whatsapp.net', lid: '333@lid', admin: 'superadmin' }
		]
	}
	return store.groupMetadata[GID]
}
const participant = (store, id) => store.groupMetadata[GID].participants.find(p => p.id === id)

test('HB-406: promote/demote keep admin and the legacy flags in sync', () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('group-participants.update', { id: GID, participants: [{ id: '111@lid', admin: 'admin' }], action: 'promote' })
	assert.equal(participant(store, '111@lid').admin, 'admin')
	assert.equal(participant(store, '111@lid').isAdmin, true)
	ev.emit('group-participants.update', { id: GID, participants: [{ id: '222@lid', admin: null }], action: 'demote' })
	assert.equal(participant(store, '222@lid').admin, null)
	assert.equal(participant(store, '222@lid').isAdmin, false)
	// a demoted superadmin becomes null, not 'admin'
	ev.emit('group-participants.update', { id: GID, participants: [{ id: '333@lid', admin: null }], action: 'demote' })
	assert.equal(participant(store, '333@lid').admin, null)
	assert.equal(participant(store, '333@lid').isSuperAdmin, false)
})

test('HB-406: add keeps the producer fields (admin/phoneNumber/lid)', () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('group-participants.update', {
		id: GID,
		participants: [{ id: '444@lid', phoneNumber: '628444@s.whatsapp.net', lid: '444@lid', admin: null }],
		action: 'add'
	})
	const added = participant(store, '444@lid')
	assert.ok(added)
	assert.equal(added.admin, null)
	assert.equal(added.phoneNumber, '628444@s.whatsapp.net')
	assert.equal(added.lid, '444@lid')
	assert.equal(added.isAdmin, false)
})

test('HB-406: modify removes the old number and adds the author as the new one', () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('group-participants.update', { id: GID, author: '999@lid', participants: ['111@lid'], action: 'modify' })
	assert.equal(participant(store, '111@lid'), undefined)
	assert.ok(participant(store, '999@lid'))
})

test('HB-460: add of an id-less participant creates no phantom entry', () => {
	const { store, ev } = makeStore()
	const meta = seedGroup(store)
	const before = meta.participants.length
	ev.emit('group-participants.update', { id: GID, participants: [{}], action: 'add' })
	ev.emit('group-participants.update', { id: GID, participants: [{ id: null }], action: 'add' })
	ev.emit('group-participants.update', { id: GID, participants: [''], action: 'add' })
	assert.equal(store.groupMetadata[GID].participants.length, before)
	assert.ok(store.groupMetadata[GID].participants.every(p => typeof p.id === 'string' && p.id))
	// an id-less remove must not sweep real participants (undefined === undefined)
	ev.emit('group-participants.update', { id: GID, participants: [{}], action: 'remove' })
	assert.equal(store.groupMetadata[GID].participants.length, before)
})

test('HB-411: groups.update / chats.update with undefined fields do not erase stored values', () => {
	const { store, ev } = makeStore()
	const meta = seedGroup(store)
	meta.desc = 'Old desc'
	meta.inviteCode = 'OLDCODE'
	ev.emit('groups.update', [{ id: GID, subject: undefined, desc: undefined, inviteCode: undefined }])
	assert.equal(store.groupMetadata[GID].subject, 'Test Group')
	assert.equal(store.groupMetadata[GID].desc, 'Old desc')
	assert.equal(store.groupMetadata[GID].inviteCode, 'OLDCODE')
	ev.emit('chats.upsert', [{ id: '555@s.whatsapp.net', name: 'Known Name', conversationTimestamp: 10 }])
	ev.emit('chats.update', [{ id: '555@s.whatsapp.net', name: undefined }])
	assert.equal(store.chats.get('555@s.whatsapp.net').name, 'Known Name')
})

test('HB-411 addendum 3: groups.update from a PN-only actor keeps stored authorPn/authorUsername', () => {
	const { store, ev } = makeStore()
	const meta = seedGroup(store)
	meta.author = '111@lid'
	meta.authorPn = '628111@s.whatsapp.net'
	meta.authorUsername = 'user111'
	ev.emit('groups.update', [{ id: GID, subject: 'New Subject', author: '222@lid', authorPn: undefined, authorUsername: undefined }])
	assert.equal(store.groupMetadata[GID].subject, 'New Subject')
	assert.equal(store.groupMetadata[GID].authorPn, '628111@s.whatsapp.net')
	assert.equal(store.groupMetadata[GID].authorUsername, 'user111')
})

test('HB-411 addendum 2+4: contacts.update / contacts.upsert with undefined fields do not erase stored values', () => {
	const { store, ev } = makeStore()
	ev.emit('contacts.upsert', [{ id: '777@s.whatsapp.net', name: 'Biz', verifiedName: 'Biz Verified', phoneNumber: '777@s.whatsapp.net' }])
	ev.emit('contacts.update', [{ id: '777@s.whatsapp.net', verifiedName: undefined }])
	assert.equal(store.contacts['777@s.whatsapp.net'].verifiedName, 'Biz Verified')
	// the absorbed-pending-update path lands as a contacts.upsert — same guard
	ev.emit('contacts.upsert', [{ id: '777@s.whatsapp.net', verifiedName: undefined, phoneNumber: undefined, name: undefined }])
	assert.equal(store.contacts['777@s.whatsapp.net'].verifiedName, 'Biz Verified')
	assert.equal(store.contacts['777@s.whatsapp.net'].phoneNumber, '777@s.whatsapp.net')
	assert.equal(store.contacts['777@s.whatsapp.net'].name, 'Biz')
})

test('HB-431: notify for our own message creates the chat without a phantom unread', () => {
	const { store, ev } = makeStore()
	const msg = fromMe => ({
		key: { id: 'M1', remoteJid: '888@s.whatsapp.net', fromMe },
		messageTimestamp: 20,
		message: { conversation: 'hi' }
	})
	ev.emit('messages.upsert', { type: 'notify', messages: [msg(true)] })
	const own = store.chats.get('888@s.whatsapp.net')
	assert.ok(own, 'chat should still be created')
	assert.equal(own.unreadCount, undefined)
	ev.emit('messages.upsert', { type: 'notify', messages: [{ ...msg(false), key: { id: 'M2', remoteJid: '889@s.whatsapp.net', fromMe: false } }] })
	assert.equal(store.chats.get('889@s.whatsapp.net').unreadCount, 1)
	// stubs do not count as unread either (processMessage rule)
	ev.emit('messages.upsert', {
		type: 'notify',
		messages: [{ key: { id: 'M3', remoteJid: '890@s.whatsapp.net', fromMe: false }, messageTimestamp: 21, messageStubType: 27 }]
	})
	assert.equal(store.chats.get('890@s.whatsapp.net').unreadCount, undefined)
})

test('HB-445 + HB-278 addendum 2: waLabelAssociationKey separates the parts — colliding triples both survive', () => {
	assert.notEqual(
		lib.waLabelAssociationKey.key({ type: 'label_message', chatId: '123@g.us', messageId: 'AB12', labelId: '3' }),
		lib.waLabelAssociationKey.key({ type: 'label_message', chatId: '123@g.us', messageId: 'AB1', labelId: '23' })
	)
	assert.notEqual(
		lib.waLabelAssociationKey.key({ type: 'label_jid', chatId: '12', labelId: '3' }),
		lib.waLabelAssociationKey.key({ type: 'label_jid', chatId: '1', labelId: '23' })
	)
	const { store, ev } = makeStore()
	ev.emit('labels.association', { type: 'add', association: { type: 'label_message', chatId: '123@g.us', messageId: 'AB12', labelId: '3' } })
	ev.emit('labels.association', { type: 'add', association: { type: 'label_message', chatId: '123@g.us', messageId: 'AB1', labelId: '23' } })
	assert.deepEqual(store.getMessageLabels('AB12'), ['3'])
	assert.deepEqual(store.getMessageLabels('AB1'), ['23'])
	ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId: '12', labelId: '3' } })
	ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId: '1', labelId: '23' } })
	assert.equal(store.getChatLabels('12').length, 1)
	assert.equal(store.getChatLabels('1').length, 1)
})

test('HB-373 addendum: chats.delete also drops groupMetadata', async () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('chats.upsert', [{ id: GID, conversationTimestamp: 5 }])
	ev.emit('chats.delete', [GID])
	assert.equal(store.groupMetadata[GID], undefined)
	assert.equal(await store.fetchGroupMetadata(GID, undefined), undefined)
})

test('HB-373 addendum 2: messaging-history.set isLatest wipes presences/groupMetadata/stale label associations', async () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('chats.upsert', [{ id: '111@s.whatsapp.net', conversationTimestamp: 5 }])
	ev.emit('presence.update', { id: '111@s.whatsapp.net', presences: { '111@s.whatsapp.net': { lastKnownPresence: 'available' } } })
	ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId: '111@s.whatsapp.net', labelId: '3' } })
	ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId: '999@s.whatsapp.net', labelId: '4' } })
	ev.emit('messaging-history.set', {
		chats: [{ id: '999@s.whatsapp.net', conversationTimestamp: 9 }],
		contacts: [{ id: '999@s.whatsapp.net' }],
		messages: [],
		isLatest: true
	})
	assert.deepEqual(Object.keys(store.presences), [])
	assert.equal(store.groupMetadata[GID], undefined)
	assert.deepEqual(store.getChatLabels('111@s.whatsapp.net'), [])
	// an association for a chat carried by the new sync survives
	assert.equal(store.getChatLabels('999@s.whatsapp.net').length, 1)
})

test('HB-373 addendum 3: group-participants.update remove also drops the member presence', () => {
	const { store, ev } = makeStore()
	seedGroup(store)
	ev.emit('presence.update', {
		id: GID,
		presences: { '111@lid': { lastKnownPresence: 'available' }, '222@lid': { lastKnownPresence: 'available' } }
	})
	ev.emit('group-participants.update', { id: GID, participants: [{ id: '111@lid' }], action: 'remove' })
	assert.equal(participant(store, '111@lid'), undefined)
	assert.equal(store.presences[GID]['111@lid'], undefined)
	assert.ok(store.presences[GID]['222@lid'])
})
