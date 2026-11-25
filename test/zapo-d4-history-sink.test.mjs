// Zapo D4 (2.7.0): the history-sync streaming sink
// (SocketConfig.history.sink) receives every element of a HistorySync
// chunk — one item per element, in field order, each call awaited
// before the next — via downloadAndProcessHistorySyncNotification /
// streamHistorySyncToSink, in addition to the normal processing
// result. A throwing sink is isolated per item.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { lib, silentLogger, makeOfflineSocket, endQuietly } from './helpers.mjs'
import { downloadAndProcessHistorySyncNotification, streamHistorySyncToSink } from '../lib/Utils/history.js'
import { waproto } from '../WAProto/index.js'

const makeChunk = () => {
	const historySync = waproto.HistorySync.create({
		syncType: waproto.HistorySync.HistorySyncType.RECENT,
		conversations: [
			{ id: '111@s.whatsapp.net', name: 'One' },
			{ id: '222@s.whatsapp.net', name: 'Two' }
		],
		pushnames: [{ id: '111@s.whatsapp.net', pushname: 'Push One' }],
		phoneNumberToLidMappings: [{ pnJid: '111@s.whatsapp.net', lidJid: '999@lid' }]
	})
	const payload = deflateSync(Buffer.from(waproto.HistorySync.encode(historySync).finish()))
	return { initialHistBootstrapInlinePayload: payload }
}

test('Zapo D4: sink receives one item per HistorySync element, in order, and processing still returns data', async () => {
	const items = []
	const data = await downloadAndProcessHistorySyncNotification(makeChunk(), {}, silentLogger, async item => {
		items.push(item)
	})
	assert.deepEqual(
		items.map(i => i.field),
		['conversations', 'conversations', 'pushnames', 'phoneNumberToLidMappings']
	)
	assert.equal(items[0].value.id, '111@s.whatsapp.net')
	assert.equal(items[1].value.id, '222@s.whatsapp.net')
	assert.equal(items[0].syncType, waproto.HistorySync.HistorySyncType.RECENT)
	assert.equal(data.chats.length, 2, 'normal history processing is unaffected by the sink')
})

test('Zapo D4: sink calls are awaited one at a time (no overlap, order preserved)', async () => {
	const order = []
	let active = 0
	let maxActive = 0
	await streamHistorySyncToSink(
		{
			syncType: waproto.HistorySync.HistorySyncType.RECENT,
			conversations: [{ id: 'a@s.whatsapp.net' }, { id: 'b@s.whatsapp.net' }, { id: 'c@s.whatsapp.net' }]
		},
		async item => {
			active++
			maxActive = Math.max(maxActive, active)
			await new Promise(r => setTimeout(r, 10))
			order.push(item.value.id)
			active--
		},
		silentLogger
	)
	assert.deepEqual(order, ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net'])
	assert.equal(maxActive, 1, 'each sink call must settle before the next begins')
})

test('Zapo D4: a throwing sink item is skipped and the remaining items still arrive', async () => {
	const seen = []
	const data = await downloadAndProcessHistorySyncNotification(makeChunk(), {}, silentLogger, async item => {
		if (item.field === 'conversations' && item.value.id === '111@s.whatsapp.net') {
			throw new Error('host sink boom')
		}

		seen.push(item.field + ':' + (item.value.id || item.value.pnJid))
	})
	assert.deepEqual(seen, ['conversations:222@s.whatsapp.net', 'pushnames:111@s.whatsapp.net', 'phoneNumberToLidMappings:111@s.whatsapp.net'])
	assert.equal(data.chats.length, 2)
})

test('Zapo D4: without a sink, downloadAndProcessHistorySyncNotification behaves as before', async () => {
	const data = await downloadAndProcessHistorySyncNotification(makeChunk(), {}, silentLogger)
	assert.equal(data.chats.length, 2)
})

test('Zapo D4: history.sink is accepted as socket config (additive, no construction break)', async () => {
	const sock = await makeOfflineSocket({ history: { sink: async () => {} } })
	try {
		assert.equal(typeof sock.upsertMessage, 'function')
	} finally {
		endQuietly(sock)
	}
})

void lib
