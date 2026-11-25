// AunuBaileys 2.7.0 — HB-489 addendum facet 1 regression tests.
// The HB-489 fix keyed the device cache by normalised JID (user +
// server), but a USync result for a chat input (always PN/LID) can
// return HOSTED devices — the server resolves that input to a Cloud
// API identity — so the write key ('user@hosted') never matched a
// later read for the same input ('user@s.whatsapp.net'): the entry
// was write-only and every send paid a full USync IQ. The write
// now also seeds the entry under the input key that produced it.
// Fails without the fix: the second lookup for the same hosted
// peer fetches a fresh USync IQ (usyncCount 2).
import { test } from 'node:test'
import assert from 'node:assert'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode, getBinaryNodeChild } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const HOSTED_PN = '628555555555@s.whatsapp.net'
const HOSTED_PN_DEVICE = '628555555555@hosted'
const HOSTED_LID = '12345678901234@lid'
const HOSTED_LID_DEVICE = '12345678901234@hosted.lid'
const MIXED_PN = '628666666666@s.whatsapp.net'
const MIXED_HOSTED_DEVICE = '628666666666:1@hosted'

// Users whose USync answer is a hosted identity (the server
// resolves the PN/LID input to Cloud API devices). MIXED_PN is
// both: its device list carries a plain device 0 AND a hosted
// device 1.
const HOSTED_USERS = new Set(['628555555555', '12345678901234', '628666666666'])

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Answer every outgoing IQ. USync IQs get the queried users' devices
// (is_hosted iff the user is in HOSTED_USERS); encrypt IQs get an
// empty list; the rest get an empty <result/>.
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
						tag: 'list', attrs: {}, content: users.map(u => {
							const user = String(u.attrs.jid || '').split('@')[0]
							const devices = []
							if (user === '628666666666') {
								devices.push({ tag: 'device', attrs: { id: '0', 'key-index': '0' } })
							}
							if (HOSTED_USERS.has(user)) {
								// a non-zero device needs a non-zero key-index:
								// extractDeviceJids treats key-index 0 as
								// "not specified" for non-zero devices
								devices.push({ tag: 'device', attrs: { id: user === '628666666666' ? '1' : '0', 'key-index': user === '628666666666' ? '1' : '0', is_hosted: 'true' } })
							} else {
								devices.push({ tag: 'device', attrs: { id: '0', 'key-index': '0' } })
							}
							return {
								tag: 'user',
								attrs: { jid: u.attrs.jid },
								content: [{ tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: devices }] }]
							}
						})
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

test('HB-489 facet 1: a repeated lookup for a PN peer whose devices are hosted hits the cache', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([HOSTED_PN], true, false)
		assert.deepEqual(first.map(d => d.jid), [HOSTED_PN_DEVICE])
		assert.equal(resp.usyncCount, 1)
		const second = await sock.getUSyncDevices([HOSTED_PN], true, false)
		assert.equal(resp.usyncCount, 1, 'the second lookup must be served from the cache entry seeded under the input key (no new USync IQ)')
		assert.deepEqual(second.map(d => d.jid), [HOSTED_PN_DEVICE])
	} finally {
		endQuietly(sock)
	}
})

test('HB-489 facet 1: a repeated lookup for a hosted-LID peer hits the cache', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([HOSTED_LID], true, false)
		assert.deepEqual(first.map(d => d.jid), [HOSTED_LID_DEVICE])
		assert.equal(resp.usyncCount, 1)
		const second = await sock.getUSyncDevices([HOSTED_LID], true, false)
		assert.equal(resp.usyncCount, 1, 'the second lookup must be served from the cache entry seeded under the input key (no new USync IQ)')
		assert.deepEqual(second.map(d => d.jid), [HOSTED_LID_DEVICE])
	} finally {
		endQuietly(sock)
	}
})

test('HB-489 facet 1: a mixed PN+hosted result does not let the hosted alias overwrite the PN entry', async () => {
	const sock = await makeSock()
	const resp = makeResponder(sock)
	try {
		const first = await sock.getUSyncDevices([MIXED_PN], true, false)
		assert.deepEqual(first.map(d => d.jid).sort(), [MIXED_PN, MIXED_HOSTED_DEVICE].sort(), `expected both devices on the cold path, got ${JSON.stringify(first.map(d => d.jid))}`)
		assert.equal(resp.usyncCount, 1)
		const second = await sock.getUSyncDevices([MIXED_PN], true, false)
		assert.equal(resp.usyncCount, 1, 'the second lookup must hit the cache (no new USync IQ)')
		assert.deepEqual(second.map(d => d.jid), [MIXED_PN], 'the PN entry stays authoritative for PN reads — the hosted alias must not overwrite it')
	} finally {
		endQuietly(sock)
	}
})
