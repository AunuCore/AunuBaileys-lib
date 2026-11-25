// AunuBaileys 2.7.0 — HB-489 regression tests.
// getUSyncDevices used to key userDevicesCache by the bare user (no
// server): the same number's @s.whatsapp.net and @hosted identities
// shared one cache entry, so a lookup for one identity was served the
// other identity's devices with no USync fetch. The cache key is now
// the normalised JID (user + server) at the read, the deviceMap and
// the write.
// Fails without the fix: the second (cross-server) lookup returns the
// first identity's device and sends no new USync IQ.
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const PN = '628987654321@s.whatsapp.net'
const HOSTED = '628987654321@hosted'

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Answer every outgoing IQ. USync IQs get one device-0 <user> per
// queried JID (is_hosted iff the JID ends with @hosted); encrypt IQs
// get an empty list; the rest get an empty <result/>.
const makeResponder = sock => {
	const state = { usyncCount: 0 }
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data).then(node => {
			if (node?.tag !== 'iq' || !node.attrs?.id) return
			let content = []
			if (node.attrs.xmlns === 'usync') {
				state.usyncCount++
				const usyncNode = getBinaryNodeChild(node, 'usync')
				const listNode = getBinaryNodeChild(usyncNode, 'list')
				const users = listNode?.content && Array.isArray(listNode.content)
					? listNode.content.filter(u => u.tag === 'user')
					: []
				content = [{
					tag: 'usync', attrs: {}, content: [{
						tag: 'list', attrs: {}, content: users.map(u => ({
							tag: 'user',
							attrs: { jid: u.attrs.jid },
							content: [{
								tag: 'devices', attrs: {}, content: [{
									tag: 'device-list', attrs: {}, content: [{
										tag: 'device',
										attrs: {
											id: '0', 'key-index': '0',
											...(String(u.attrs.jid || '').endsWith('@hosted') ? { is_hosted: 'true' } : {})
										}
									}]
								}]
							}]
						}))
					}]
				}]
			} else if (node.attrs.xmlns === 'encrypt' && node.attrs.type === 'get') {
				content = [{ tag: 'list', attrs: {}, content: [] }]
			}
			sock.ws.emit(`TAG:${node.attrs.id}`, {
				tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content
			})
		}).catch(() => {})
	}
	return state
}

const makeSock = async () => {
	const sock = await makeOfflineSocket({ shouldSyncHistoryMessage: () => false })
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	return sock
}

test('HB-489: a @hosted lookup after a PN lookup for the same number fetches fresh and returns the hosted device', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([PN], true, false)
		assert.deepEqual(first.map(d => d.jid), [PN])
		assert.equal(resp.usyncCount, 1)
		const second = await sock.getUSyncDevices([HOSTED], true, false)
		assert.equal(resp.usyncCount, 2, 'the hosted lookup must not be served from the PN cache entry')
		assert.deepEqual(second.map(d => d.jid), [HOSTED], `expected the hosted device, got ${JSON.stringify(second.map(d => d.jid))}`)
	} finally {
		endQuietly(sock)
	}
})

test('HB-489: a PN lookup after a @hosted lookup for the same number fetches fresh and returns the PN device', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([HOSTED], true, false)
		assert.deepEqual(first.map(d => d.jid), [HOSTED])
		assert.equal(resp.usyncCount, 1)
		const second = await sock.getUSyncDevices([PN], true, false)
		assert.equal(resp.usyncCount, 2, 'the PN lookup must not be served from the hosted cache entry')
		assert.deepEqual(second.map(d => d.jid), [PN], `expected the PN device, got ${JSON.stringify(second.map(d => d.jid))}`)
	} finally {
		endQuietly(sock)
	}
})

test('HB-489: control — a repeated lookup for the SAME identity is still served from cache', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([PN], true, false)
		assert.deepEqual(first.map(d => d.jid), [PN])
		const second = await sock.getUSyncDevices([PN], true, false)
		assert.equal(resp.usyncCount, 1, 'same-identity lookup must hit the cache (no new USync IQ)')
		assert.deepEqual(second.map(d => d.jid), [PN])
	} finally {
		endQuietly(sock)
	}
})

test('HB-489: control — a cold-cache @hosted lookup returns the hosted device', async () => {
	const sock = await makeSock()
	makeResponder(sock)
	try {
		const only = await sock.getUSyncDevices([HOSTED], true, false)
		assert.deepEqual(only.map(d => d.jid), [HOSTED])
	} finally {
		endQuietly(sock)
	}
})
