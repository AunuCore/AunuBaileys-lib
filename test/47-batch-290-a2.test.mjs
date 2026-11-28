// (47) Batch 2.9.0 "Last Fix" — Group A2 (Socket chats/communities):
// HB-388 addendum facet 2 (history-sync 'complete' must be decided
// AFTER the chunk's own processMessage result is known) and
// HB-435 addendum facet 4 follow-up (communityFetchAllParticipating
// must reject Boom 502 on a bare result IQ without <communities>).
// Item H1 (communities dirty handler cleaning 'groups') is a
// DISPOSITION in this batch — no code change, no test.
// Fully offline & deterministic: crafted stanzas, fake transport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = rel => path.join(ROOT, rel)

const { makeOfflineSocket, fakeOpenTransport, endQuietly } = await import('./helpers.mjs')
const { waproto } = await import(L('WAProto/index.js'))
const { WebSocketClient } = await import(L('lib/Socket/Client/websocket.js'))
const { decodeBinaryNode } = await import(L('lib/WABinary/index.js'))

WebSocketClient.prototype.connect = () => {}

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode

// ── HB-388 addendum facet 2 ────────────────────────────────────────

const HS = waproto.HistorySync.HistorySyncType
const PT = waproto.Message.ProtocolMessage.Type

const validPayload = syncType =>
	deflateSync(Buffer.from(waproto.HistorySync.encode({ syncType }).finish()))

const histChunkMsg = (id, syncType, payload, progress) => ({
	key: { remoteJid: '123@s.whatsapp.net', fromMe: true, id },
	messageTimestamp: 1760000000,
	message: {
		protocolMessage: {
			type: PT.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: {
				syncType,
				...(progress !== undefined ? { progress } : {}),
				initialHistBootstrapInlinePayload: payload
			}
		}
	}
})

const makeHistorySocket = async () => {
	const sock = await makeOfflineSocket({
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => true
	})
	fakeOpenTransport(sock)
	const statuses = []
	sock.ev.on('messaging-history.status', s => statuses.push(s))
	return { sock, statuses }
}

const completesFor = (statuses, syncType) =>
	statuses.filter(s => s.syncType === syncType && s.status === 'complete')

test('HB-388 facet 2: RECENT chunk at progress 100 whose download fails emits NO complete', async () => {
	const { sock, statuses } = await makeHistorySocket()
	try {
		await assert.rejects(
			sock.upsertMessage(histChunkMsg('A2-RECENT-FAIL', HS.RECENT, Buffer.from('this-is-not-zlib-data'), 100), 'notify'),
			/history sync download failed/
		)
		assert.deepEqual(
			completesFor(statuses, HS.RECENT),
			[],
			'a chunk whose own processing failed must not emit complete for itself'
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-388 facet 2: RECENT chunk at progress 100 that processes successfully DOES emit complete', async () => {
	const { sock, statuses } = await makeHistorySocket()
	try {
		await sock.upsertMessage(histChunkMsg('A2-RECENT-OK', HS.RECENT, validPayload(HS.RECENT), 100), 'notify')
		assert.equal(completesFor(statuses, HS.RECENT).length, 1, 'a successful chunk must still emit complete')
		assert.equal(completesFor(statuses, HS.RECENT)[0].explicit, true)
	} finally {
		endQuietly(sock)
	}
})

test('HB-388 facet 2: INITIAL_BOOTSTRAP chunk whose download fails emits NO complete', async () => {
	const { sock, statuses } = await makeHistorySocket()
	try {
		await assert.rejects(
			sock.upsertMessage(histChunkMsg('A2-BOOT-FAIL', HS.INITIAL_BOOTSTRAP, Buffer.from('this-is-not-zlib-data')), 'notify'),
			/history sync download failed/
		)
		assert.deepEqual(
			completesFor(statuses, HS.INITIAL_BOOTSTRAP),
			[],
			'the bootstrap completion has no gate at all in the old order — a failed chunk must not emit it'
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-388 facet 2: INITIAL_BOOTSTRAP chunk that processes successfully DOES emit complete', async () => {
	const { sock, statuses } = await makeHistorySocket()
	try {
		await sock.upsertMessage(
			histChunkMsg('A2-BOOT-OK', HS.INITIAL_BOOTSTRAP, validPayload(HS.INITIAL_BOOTSTRAP)),
			'notify'
		)
		assert.equal(
			completesFor(statuses, HS.INITIAL_BOOTSTRAP).length,
			1,
			'a successful bootstrap chunk must still emit complete'
		)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-435 addendum facet 4 follow-up (communities) ────────────────

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Answer every IQ with the given result content.
const answeringSocket = async answerContent => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data)
			.then(node => {
				if (node?.tag !== 'iq' || !node.attrs?.id) return
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq',
					attrs: { type: 'result', id: node.attrs.id },
					content: answerContent
				})
			})
			.catch(() => {})
	}
	return sock
}

test('HB-435 facet 4 follow-up: communityFetchAllParticipating rejects Boom 502 on a bare result IQ', async () => {
	const sock = await answeringSocket([])
	const updates = []
	sock.ev.on('groups.update', u => updates.push(u))
	try {
		await assert.rejects(sock.communityFetchAllParticipating(), err => isBoom(err, 502))
		assert.deepEqual(updates, [], 'no groups.update may be emitted for a bare result')
	} finally {
		endQuietly(sock)
	}
})

test('HB-435 facet 4 follow-up: communityFetchAllParticipating parses a valid <communities> result as before', async () => {
	const communityNode = {
		tag: 'community',
		attrs: { id: '1234567890', subject: 'A2 Test Community', creation: '1700000000', creator: '6281234567890@s.whatsapp.net' },
		content: []
	}
	const sock = await answeringSocket([{ tag: 'communities', attrs: {}, content: [communityNode] }])
	try {
		const data = await sock.communityFetchAllParticipating()
		assert.deepEqual(Object.keys(data), ['1234567890@g.us'])
		assert.equal(data['1234567890@g.us'].subject, 'A2 Test Community')
	} finally {
		endQuietly(sock)
	}

	const empty = await answeringSocket([{ tag: 'communities', attrs: {}, content: [] }])
	try {
		const data = await empty.communityFetchAllParticipating()
		assert.deepEqual(data, {}, 'a present-but-empty <communities/> is a legitimate empty success')
	} finally {
		endQuietly(empty)
	}
})
