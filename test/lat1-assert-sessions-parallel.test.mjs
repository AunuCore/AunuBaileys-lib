// AunuBaileys 2.7.0 — LAT-1 (latency audit #4) regression tests.
// assertSessions used to validate sessions SEQUENTIALLY: for N cold
// recipients, N store reads ran one after another before the (already
// batched) bundle IQ could leave. The validations now run
// concurrently, with the sequential semantics preserved exactly:
//   - jidsRequiringFetch (and hence the bundle IQ's wire JIDs) keeps
//     input order, regardless of validation completion order;
//   - the error a caller sees is the FIRST rejection in input order
//     (the one the old loop would have thrown), not the first in time;
//   - force=true still skips validation entirely.
// Fails without the fix: the concurrency counter in test 1 never
// exceeds 1 (validations run one at a time).
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../lib/WABinary/index.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const jidOf = n => `62890000000${n}@s.whatsapp.net`

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Socket whose signal repository wraps the real one with an
// instrumented validateSession (the `handler` decides per-JID results,
// delays and throws, and records call/concurrency stats). Outgoing
// encrypt IQs are answered with an empty bundle list and their wire
// JIDs recorded; USync IQs get an empty result.
const makeInstrumentedSocket = async handler => {
	const stats = { calls: [], inFlight: 0, maxInFlight: 0 }
	const sock = await makeOfflineSocket({
		shouldSyncHistoryMessage: () => false,
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.validateSession = async jid => {
				stats.calls.push(jid)
				stats.inFlight++
				stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
				try {
					return await handler(jid)
				} finally {
					stats.inFlight--
				}
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	const encryptWireJids = []
	let encryptIqCount = 0
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data).then(node => {
			if (node?.tag !== 'iq' || !node.attrs?.id) return
			if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'get') {
				encryptIqCount++
				const keyNode = getBinaryNodeChild(node, 'key')
				for (const userNode of getBinaryNodeChildren(keyNode, 'user')) {
					if (userNode.attrs?.jid) encryptWireJids.push(userNode.attrs.jid)
				}
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq', attrs: { type: 'result', id: node.attrs.id },
					content: [{ tag: 'list', attrs: {}, content: [] }]
				})
			} else if (node.attrs.xmlns === 'usync') {
				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: []
				})
			}
		}).catch(() => {})
	}
	return { sock, stats, encryptWireJids, encryptIqCount: () => encryptIqCount }
}

test('LAT-1: validations for N recipients run concurrently (max in-flight > 1), all-existing returns false with no fetch', async () => {
	const N = 6
	const jids = Array.from({ length: N }, (_, i) => jidOf(i))
	const { sock, stats, encryptIqCount } = await makeInstrumentedSocket(async () => {
		await sleep(25)
		return { exists: true }
	})
	try {
		const didFetch = await sock.assertSessions(jids)
		assert.equal(didFetch, false, 'all sessions exist — nothing to fetch')
		assert.equal(stats.calls.length, N)
		assert.ok(stats.maxInFlight > 1, `validations must overlap (max in-flight was ${stats.maxInFlight})`)
		assert.equal(stats.maxInFlight, N, 'every validation starts before any completes')
		assert.equal(encryptIqCount(), 0, 'no bundle IQ when every session exists')
	} finally {
		endQuietly(sock)
	}
})

test('LAT-1: fetch list keeps INPUT order even when validations complete in reverse order; duplicates validated once', async () => {
	const jids = [jidOf(0), jidOf(1), jidOf(2), jidOf(3), jidOf(4)]
	const existsFor = new Set([jids[0], jids[2], jids[4]])
	const { sock, stats, encryptWireJids } = await makeInstrumentedSocket(async jid => {
		// Later recipients finish FIRST — completion order is the
		// exact reverse of input order.
		const idx = jids.indexOf(jid)
		await sleep((jids.length - idx) * 10)
		return { exists: existsFor.has(jid) }
	})
	try {
		// A duplicate of a missing-session JID rides along: it must be
		// validated (and fetched) only once, as with the old loop's
		// uniqueJids dedupe.
		const didFetch = await sock.assertSessions([...jids, jids[1]])
		assert.equal(didFetch, true)
		assert.equal(stats.calls.length, jids.length, 'one validation per unique JID')
		assert.deepEqual(
			encryptWireJids,
			[jids[1], jids[3]],
			`the bundle IQ must list exactly the missing-session JIDs in input order, got ${JSON.stringify(encryptWireJids)}`
		)
	} finally {
		endQuietly(sock)
	}
})

test('LAT-1: a throwing validation propagates the FIRST error in input order (sequential semantics), and no fetch is attempted', async () => {
	const jids = [jidOf(0), jidOf(1), jidOf(2), jidOf(3)]
	const { sock, stats, encryptIqCount } = await makeInstrumentedSocket(async jid => {
		if (jid === jids[3]) {
			// Rejects FIRST IN TIME — the sequential loop would never
			// have surfaced this error, because jids[1] throws first
			// in input order.
			await sleep(1)
			throw new Error('later-in-order failure')
		}
		if (jid === jids[1]) {
			await sleep(30)
			throw new Error('first-in-order failure')
		}
		await sleep(5)
		return { exists: false, reason: 'no session' }
	})
	try {
		await assert.rejects(
			() => sock.assertSessions(jids),
			err => err?.message === 'first-in-order failure',
			'the propagated error must be the first rejection in input order, as the sequential loop produced'
		)
		assert.equal(stats.calls.length, jids.length, 'all validations were started (parallel)')
		assert.equal(encryptIqCount(), 0, 'no bundle IQ after a validation failure')
	} finally {
		endQuietly(sock)
	}
})

test('LAT-1: force=true still skips validation entirely and fetches every JID in input order', async () => {
	const jids = [jidOf(0), jidOf(1), jidOf(2)]
	const { sock, stats, encryptWireJids } = await makeInstrumentedSocket(async () => {
		throw new Error('validateSession must not be called under force')
	})
	try {
		const didFetch = await sock.assertSessions(jids, true)
		assert.equal(didFetch, true)
		assert.equal(stats.calls.length, 0)
		assert.deepEqual(encryptWireJids, jids)
	} finally {
		endQuietly(sock)
	}
})
