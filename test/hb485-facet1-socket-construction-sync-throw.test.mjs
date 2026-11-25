// AunuBaileys 2.7.0 — HB-485 addendum facet 1: a throwing host
// shouldSyncHistoryMessage at makeSocket construction time must not
// break socket construction; the throw is treated as false for that
// sync type (mirrors the HB-485/HB-486 gates). Fails without the fix:
// makeWASocket throws synchronously on the first callback call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

WebSocketClient.prototype.connect = () => {}

test('HB-485 facet 1: throwing shouldSyncHistoryMessage does not break makeWASocket construction', async () => {
	let calls = 0
	const sock = await makeOfflineSocket({
		shouldSyncHistoryMessage: () => {
			calls++
			throw new Error('host boom')
		}
	})
	assert.ok(sock, 'socket must be constructed despite the throwing callback')
	assert.ok(calls >= 1, 'the callback must have been consulted at construction')
	endQuietly(sock)
})

test('HB-485 facet 1: throw on a later construction-time call is also treated as false', async () => {
	let calls = 0
	const sock = await makeOfflineSocket({
		shouldSyncHistoryMessage: () => {
			calls++
			if (calls === 3) throw new Error('host boom 3rd')
			return true
		}
	})
	assert.ok(sock, 'socket must be constructed despite a mid-map throw')
	endQuietly(sock)
})

test('HB-485 facet 1: control — non-throwing callbacks still construct', async () => {
	const sockFalse = await makeOfflineSocket({ shouldSyncHistoryMessage: () => false })
	assert.ok(sockFalse)
	endQuietly(sockFalse)
	const sockTrue = await makeOfflineSocket({ shouldSyncHistoryMessage: () => true })
	assert.ok(sockTrue)
	endQuietly(sockTrue)
})
