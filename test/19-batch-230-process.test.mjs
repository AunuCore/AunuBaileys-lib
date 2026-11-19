// Batch 2.3.0 — Cluster E (process-message / history / groups) regressions.
// HB-388: history-sync notification was marked processed BEFORE its
// download/inflate, so a failed download lost the chunk silently.
// HB-391: participantsIncludesMe() never compared me.lid, so self
// add/remove/leave in a LID group with a lid-only participant stanza
// was not recognised and chat.readOnly stayed wrong.
// HB-2026-1112-40 addendum 3: SKIPPED-DELIBERATE in this cluster —
// the ledger site is src/Socket/messages-recv.ts:1093-1094,1213-1229,
// which is outside this cluster's permitted file list; no equivalent
// actor-fallback code exists in src/Socket/groups.ts. No test here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { deflateSync } from 'node:zlib'
import processMessage from '../lib/Utils/process-message.js'
import { waproto } from '../WAProto/index.js'

const silentLogger = {
	level: 'silent',
	child() {
		return silentLogger
	},
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	fatal() {}
}

const ME_PN = '6289999999@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const GROUP = '120363123456789@g.us'
const STUB = waproto.WebMessageInfo.StubType

// ── HB-391 ─────────────────────────────────────────────────────────

const groupCtx = events => {
	const ev = new EventEmitter()
	ev.on('group-participants.update', e => events.push(['group-participants.update', e]))
	ev.on('chats.update', e => events.push(['chats.update', e]))
	ev.on('groups.update', e => events.push(['groups.update', e]))
	return {
		ev,
		creds: { me: { id: ME_PN, lid: ME_LID }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {},
		keyStore: {},
		options: {},
		getMessage: async () => undefined,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
}

const stubMsg = (stubType, params) => ({
	key: { remoteJid: GROUP, fromMe: false, id: 'T-230-1', participant: '6282222222@s.whatsapp.net' },
	messageStubType: stubType,
	messageStubParameters: params,
	messageTimestamp: 1760000000
})

const chatUpdateOf = events => events.find(([t]) => t === 'chats.update')?.[1]?.[0]

test('HB-391: REMOVE lid-only self -> readOnly=true', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_PARTICIPANT_REMOVE, [JSON.stringify({ id: ME_LID })]), groupCtx(events))
	assert.equal(chatUpdateOf(events)?.readOnly, true)
})

test('HB-391: REMOVE self with phoneNumber (control) -> readOnly=true', async () => {
	const events = []
	await processMessage(
		stubMsg(STUB.GROUP_PARTICIPANT_REMOVE, [JSON.stringify({ id: ME_LID, phoneNumber: ME_PN })]),
		groupCtx(events)
	)
	assert.equal(chatUpdateOf(events)?.readOnly, true)
})

test('HB-391: REMOVE self by PN id only -> readOnly=true', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_PARTICIPANT_REMOVE, [JSON.stringify({ id: ME_PN })]), groupCtx(events))
	assert.equal(chatUpdateOf(events)?.readOnly, true)
})

test('HB-391: ADD lid-only self -> readOnly=false', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_PARTICIPANT_ADD, [JSON.stringify({ id: ME_LID })]), groupCtx(events))
	assert.equal(chatUpdateOf(events)?.readOnly, false)
})

test('HB-391: LEAVE lid-only self -> readOnly=true', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_PARTICIPANT_LEAVE, [JSON.stringify({ id: ME_LID })]), groupCtx(events))
	assert.equal(chatUpdateOf(events)?.readOnly, true)
})

test('HB-391: REMOVE of another lid-only participant -> no readOnly (guard)', async () => {
	const events = []
	await processMessage(
		stubMsg(STUB.GROUP_PARTICIPANT_REMOVE, [JSON.stringify({ id: '100000000000002@lid' })]),
		groupCtx(events)
	)
	assert.equal(chatUpdateOf(events), undefined)
})

test('HB-391: REMOVE with an empty participant object -> no readOnly (no undefined/undefined match)', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_PARTICIPANT_REMOVE, [JSON.stringify({})]), groupCtx(events))
	assert.equal(chatUpdateOf(events), undefined)
})

// ── HB-388 ─────────────────────────────────────────────────────────

const histCtx = (creds, events) => {
	const ev = new EventEmitter()
	ev.on('creds.update', data => {
		events.push(['creds.update', data])
		// mirror the real socket's internal listener: Object.assign synchronously
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

test('HB-388: corrupt inline payload resolves, is NOT marked processed, and emits no history set', async () => {
	const creds = { me: { id: ME_PN }, processedHistoryMessages: [], accountSettings: {} }
	const events = []
	// must not reject: the old code rejected after already marking the chunk
	await processMessage(histMsg('HISTFAIL1', Buffer.from('this-is-not-zlib-data')), histCtx(creds, events))
	assert.equal(events.some(([t]) => t === 'creds.update'), false)
	assert.equal(creds.processedHistoryMessages.length, 0)
	assert.equal(events.some(([t]) => t === 'messaging-history.set'), false)
})

test('HB-388: valid inline payload (control) is marked processed and emits history set, mark before set', async () => {
	const creds = { me: { id: ME_PN }, processedHistoryMessages: [], accountSettings: {} }
	const events = []
	const payload = deflateSync(
		Buffer.from(waproto.HistorySync.encode({ syncType: waproto.HistorySync.HistorySyncType.RECENT }).finish())
	)
	await processMessage(histMsg('HISTOK1', payload), histCtx(creds, events))
	assert.equal(events.some(([t]) => t === 'messaging-history.set'), true)
	assert.equal(creds.processedHistoryMessages.length, 1)
	assert.equal(creds.processedHistoryMessages[0]?.key?.id, 'HISTOK1')
	const markIdx = events.findIndex(([t]) => t === 'creds.update')
	const setIdx = events.findIndex(([t]) => t === 'messaging-history.set')
	assert.ok(markIdx !== -1 && setIdx !== -1 && markIdx < setIdx)
})
