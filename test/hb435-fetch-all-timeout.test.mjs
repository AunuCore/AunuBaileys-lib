// HB-435 addendum facet 2 (2.7.0): groupFetchAllParticipating and
// communityFetchAllParticipating must not fabricate an empty success
// when the get IQ times out (query() resolves undefined, HB-340
// contract). They must reject with Boom 408 and must NOT emit an
// empty groups.update. Fails without the fix: both resolve {} and
// emit groups.update [].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

WebSocketClient.prototype.connect = () => {}

// No IQ is ever answered: every query hits the default query timeout
// and resolves undefined.
const makeDeadEndSocket = async () => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	const groupUpdates = []
	sock.ev.on('groups.update', updates => groupUpdates.push(updates))
	return { sock, groupUpdates }
}

test('HB-435 facet 2: groupFetchAllParticipating rejects Boom 408 on IQ timeout instead of resolving {}', async () => {
	const { sock, groupUpdates } = await makeDeadEndSocket()
	try {
		await assert.rejects(sock.groupFetchAllParticipating(), err => err?.output?.statusCode === 408)
		assert.deepEqual(groupUpdates, [], 'no groups.update may be emitted on a timed-out fetch')
	} finally {
		endQuietly(sock)
	}
})

test('HB-435 facet 2: communityFetchAllParticipating rejects Boom 408 on IQ timeout instead of resolving {}', async () => {
	const { sock, groupUpdates } = await makeDeadEndSocket()
	try {
		await assert.rejects(sock.communityFetchAllParticipating(), err => err?.output?.statusCode === 408)
		assert.deepEqual(groupUpdates, [], 'no groups.update may be emitted on a timed-out fetch')
	} finally {
		endQuietly(sock)
	}
})
