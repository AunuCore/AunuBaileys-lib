// AunuBaileys 2.7.0 — HB-484 regression tests.
// A host userDevicesCache holding [] for a user used to be treated as an
// authoritative cache HIT in getUSyncDevices (`if (devices)` — [] is
// truthy): the user never reached the USync fetch and was silently
// dropped from group sends. An empty array must be a cache MISS.
// Cache keys here are the normalised JIDs (HB-489 keying).
// Fails without the fix: B is absent from the result and no USync IQ
// is sent for B.
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const A = '6281111111111@s.whatsapp.net'
const A_USER = '6281111111111'
const B = '6282222222222@s.whatsapp.net'
const B_USER = '6282222222222'

const dev0 = user => ({ user, device: 0, server: 's.whatsapp.net' })

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Answer every outgoing USync IQ with device 0 for each requested user;
// count how many USync IQs were sent.
const answerUSync = (sock, counter) => {
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data)
			.then(node => {
				if (node?.tag !== 'iq' || !node.attrs?.id || node.attrs.xmlns !== 'usync') return
				counter.n++
				const list = getBinaryNodeChild(getBinaryNodeChild(node, 'usync'), 'list')
				const users = getBinaryNodeChildren(list, 'user').map(u => u.attrs.jid)
				const content = [{
					tag: 'usync',
					attrs: {},
					content: [{
						tag: 'list',
						attrs: {},
						content: users.map(jid => ({
							tag: 'user',
							attrs: { jid },
							content: [{
								tag: 'devices',
								attrs: {},
								content: [{
									tag: 'device-list',
									attrs: {},
									content: [{ tag: 'device', attrs: { id: '0', 'key-index': '0' } }]
								}]
							}]
						}))
					}]
				}]
				sock.ws.emit(`TAG:${node.attrs.id}`, { tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content })
			})
			.catch(() => {})
	}
}

const makeHostCache = (store, withMget = true) => {
	const cache = {
		get: async key => store[key],
		set: async (key, value) => {
			store[key] = value
		},
		mset: async entries => {
			for (const { key, value } of entries) store[key] = value
		}
	}
	if (withMget) {
		cache.mget = async keys => {
			const out = {}
			for (const k of keys) out[k] = store[k]
			return out
		}
	}
	return cache
}

const makeSock = async hostCache => {
	const sock = await makeOfflineSocket({ shouldSyncHistoryMessage: () => false, userDevicesCache: hostCache })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	return sock
}

test('HB-484: mget cache holding [] for a user is a miss — the user is fetched via USync and returned', async () => {
	const store = { [A]: [dev0(A_USER)], [B]: [] }
	const sock = await makeSock(makeHostCache(store, true))
	try {
		const counter = { n: 0 }
		answerUSync(sock, counter)
		const devices = await sock.getUSyncDevices([A, B], true, false)
		const users = [...new Set(devices.map(d => d.user))].sort()
		assert.deepEqual(users, [A_USER, B_USER], `expected A and B, got ${JSON.stringify(devices)}`)
		assert.equal(counter.n, 1, 'a USync IQ must be sent for the []-cached user')
	} finally {
		endQuietly(sock)
	}
})

test('HB-484: single-get cache (no mget) holding [] for a user is a miss too', async () => {
	const store = { [A]: [dev0(A_USER)], [B]: [] }
	const sock = await makeSock(makeHostCache(store, false))
	try {
		const counter = { n: 0 }
		answerUSync(sock, counter)
		const devices = await sock.getUSyncDevices([A, B], true, false)
		const users = [...new Set(devices.map(d => d.user))].sort()
		assert.deepEqual(users, [A_USER, B_USER], `expected A and B, got ${JSON.stringify(devices)}`)
		assert.equal(counter.n, 1, 'a USync IQ must be sent for the []-cached user')
	} finally {
		endQuietly(sock)
	}
})

test('HB-484: control — a user absent from the cache is fetched and returned (unchanged behaviour)', async () => {
	const store = { [A]: [dev0(A_USER)] }
	const sock = await makeSock(makeHostCache(store, true))
	try {
		const counter = { n: 0 }
		answerUSync(sock, counter)
		const devices = await sock.getUSyncDevices([A, B], true, false)
		const users = [...new Set(devices.map(d => d.user))].sort()
		assert.deepEqual(users, [A_USER, B_USER])
		assert.equal(counter.n, 1)
	} finally {
		endQuietly(sock)
	}
})
