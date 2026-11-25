// HB-486 (2.7.0): a host shouldSyncHistoryMessage that throws in the
// upsertMessage gate must be treated as "do not sync" — upsertMessage
// resolves and the message event is still delivered. Fails without
// the fix: upsertMessage rejects with the host error (and upstream
// the payload is lost silently — receipt already sent, acked=true,
// so no NACK/redelivery ever happens).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, fakeOpenTransport, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

WebSocketClient.prototype.connect = () => {}

const now = Math.floor(Date.now() / 1000)
const HISTORY_MSG = {
	key: { remoteJid: 'status@broadcast', id: 'HIST-486', fromMe: false },
	message: { protocolMessage: { historySyncNotification: { syncType: 3 } } },
	messageTimestamp: now
}
const NORMAL_MSG = {
	key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'NORM-486', fromMe: false },
	message: { conversation: 'halo' },
	messageTimestamp: now
}

test('HB-486: throwing shouldSyncHistoryMessage in upsertMessage does not reject or lose the message', async () => {
	let armed = false
	const sock = await makeOfflineSocket({
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => {
			if (armed) {
				throw new Error('host filter boom (history gate)')
			}

			return false
		}
	})
	fakeOpenTransport(sock)
	try {
		let delivered = 0
		sock.ev.on('messages.upsert', () => {
			delivered++
		})
		armed = true
		await sock.upsertMessage(HISTORY_MSG, 'notify')
		await sleep(250)
		assert.equal(delivered, 1, 'messages.upsert must still be emitted for the history message')
		await sock.upsertMessage(NORMAL_MSG, 'notify')
		await sleep(250)
		assert.equal(delivered, 2, 'a following normal message must still be processed')
	} finally {
		endQuietly(sock)
	}
})
