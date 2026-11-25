// HB-2026-1112-40 addendum 5 (2.7.0): a double-malformed
// membership-request notification (participant child resolving to
// nothing AND no actor attrs) must not emit a phantom
// group.join-request. Guarded at both sites: the recv stub builder
// and the process-message consumer. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import processMessage from '../lib/Utils/process-message.js'
import { waproto } from '../WAProto/index.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeOfflineSocket, fakeOpenTransport, sleep, silentLogger, endQuietly } from './helpers.mjs'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const GROUP = '120363011111111@g.us'
const ADMIN = '628111111111@s.whatsapp.net'
const REQUESTER = '628222222222@s.whatsapp.net'

// --- consumer side (process-message) --------------------------------

const stubCtx = () => ({
	shouldProcessHistoryMsg: false,
	placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} },
	ev: new EventEmitter(),
	creds: { me: { id: ME }, accountSettings: {} },
	signalRepository: {},
	keyStore: {},
	logger: silentLogger,
	options: {},
	getMessage: async () => undefined
})

test('HB-40 add5 (consumer): a join-request stub with no participant and no actor emits nothing', async () => {
	const ctx = stubCtx()
	const emitted = []
	ctx.ev.on('group.join-request', data => emitted.push(data))
	await processMessage(
		{
			key: { remoteJid: GROUP, id: 'HB40-PHANTOM', fromMe: false },
			messageStubType: waproto.WebMessageInfo.StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
			messageStubParameters: [JSON.stringify({}), 'created', 'invite_link'],
			messageTimestamp: Math.floor(Date.now() / 1000)
		},
		ctx
	)
	assert.equal(emitted.length, 0, 'no phantom group.join-request for a participant-less, actor-less stub')
})

test('HB-40 add5 (consumer control): a well-formed join-request stub still emits', async () => {
	const ctx = stubCtx()
	const emitted = []
	ctx.ev.on('group.join-request', data => emitted.push(data))
	await processMessage(
		{
			key: { remoteJid: GROUP, id: 'HB40-OK', fromMe: false, participant: ADMIN },
			messageStubType: waproto.WebMessageInfo.StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
			messageStubParameters: [JSON.stringify({ lid: '111222333@lid', pn: REQUESTER }), 'created', 'invite_link'],
			messageTimestamp: Math.floor(Date.now() / 1000)
		},
		ctx
	)
	assert.equal(emitted.length, 1)
	assert.equal(emitted[0].participantPn, REQUESTER)
})

// --- recv side (handleGroupNotification) -----------------------------

const gp2 = (id, childTag, participantAttrs, actorAttrs, childAttrs = {}) => ({
	tag: 'notification',
	attrs: { from: GROUP, type: 'w:gp2', id, t: String(Math.floor(Date.now() / 1000)), ...(actorAttrs || {}) },
	content: [
		{
			tag: childTag,
			attrs: childAttrs,
			content: participantAttrs === null ? [] : [{ tag: 'participant', attrs: participantAttrs }]
		}
	]
})

test('HB-40 add5 (recv): double-malformed created/revoked notifications emit no join-request', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const sent = []
	fakeOpenTransport(sock, sent)
	const joinRequests = []
	sock.ev.on('group.join-request', data => joinRequests.push(data))
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })

	sock.ws.emit('CB:notification', gp2('HB40-T1', 'created_membership_requests', null, null, { request_method: 'invite_link' }))
	sock.ws.emit('CB:notification', gp2('HB40-T2', 'revoked_membership_requests', null, null))
	await sleep(1200)
	try { sock.ev.flush() } catch {}
	assert.equal(joinRequests.length, 0, 'phantom join-requests must not be emitted')

	sock.ws.emit(
		'CB:notification',
		gp2('HB40-T3', 'created_membership_requests', { jid: REQUESTER }, { participant: ADMIN }, { request_method: 'invite_link' })
	)
	await sleep(1200)
	try { sock.ev.flush() } catch {}
	assert.ok(
		joinRequests.some(j => j.participant === REQUESTER || j.participantPn === REQUESTER),
		'control: a well-formed created notification still emits for the requester'
	)
})
