// HB-485 (2.7.0): a host shouldSyncHistoryMessage that throws in the
// connection.update gate must not wedge the sync state machine in
// AwaitingInitialSync — the throw is treated as willSyncHistory=false,
// so the socket transitions to Online and flushes its event buffer.
// Fails without the fix: ev stays buffering forever (no flush, no 20s
// timeout was ever installed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

WebSocketClient.prototype.connect = () => {}

test('HB-485: throwing shouldSyncHistoryMessage in connection.update still reaches Online + flush', async () => {
	let armed = false
	const sock = await makeOfflineSocket({
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => {
			if (armed) {
				throw new Error('host filter boom (sync gate)')
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
		sock.ev.emit('connection.update', { connection: 'open', receivedPendingNotifications: true })
		await sleep(300)
		assert.equal(sock.ev.isBuffering(), false, 'event buffer must be flushed after the gate throw (Online transition)')
		sock.ev.emit('messages.upsert', {
			messages: [{ key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'WEDGE-1', fromMe: false } }],
			type: 'notify'
		})
		await sleep(100)
		assert.equal(delivered, 1, 'messages.upsert must be delivered after the gate throw')
	} finally {
		endQuietly(sock)
	}
})

test('HB-485 control: non-throwing shouldSyncHistoryMessage=false also reaches Online + flush', async () => {
	const sock = await makeOfflineSocket({ fireInitQueries: false, shouldSyncHistoryMessage: () => false })
	fakeOpenTransport(sock)
	try {
		sock.ev.emit('connection.update', { connection: 'open', receivedPendingNotifications: true })
		await sleep(300)
		assert.equal(sock.ev.isBuffering(), false)
	} finally {
		endQuietly(sock)
	}
})

void silentLogger
