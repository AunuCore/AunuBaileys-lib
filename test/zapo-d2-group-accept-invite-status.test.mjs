// Zapo D2 (2.7.0): groupAcceptInviteWithStatus distinguishes a
// joined group (<group> node) from a pending membership approval
// request (<membership_approval_request> node). The legacy
// groupAcceptInvite keeps its exact contract: jid string when
// joined, undefined when pending.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeOfflineSocket, fakeOpenTransport, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'

WebSocketClient.prototype.connect = () => {}

const GROUP_JID = '120363000000000777@g.us'

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) {
		off = 4
	}

	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

const makeInviteSocket = async responder => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		decodeFrame(data)
			.then(node => {
				if (node?.tag !== 'iq' || !node.attrs?.id) {
					return
				}

				sock.ws.emit(`TAG:${node.attrs.id}`, {
					tag: 'iq',
					attrs: { type: 'result', id: node.attrs.id },
					content: [responder()]
				})
			})
			.catch(() => {})
	}
	return sock
}

test('Zapo D2: a <group> answer reports { status: joined, jid } and legacy returns the jid', async () => {
	const sock = await makeInviteSocket(() => ({ tag: 'group', attrs: { jid: GROUP_JID } }))
	try {
		assert.deepEqual(await sock.groupAcceptInviteWithStatus('CODEJOIN'), { status: 'joined', jid: GROUP_JID })
		assert.equal(await sock.groupAcceptInvite('CODEJOIN'), GROUP_JID)
	} finally {
		endQuietly(sock)
	}
})

test('Zapo D2: a <membership_approval_request> answer reports { status: pending, jid } and legacy returns undefined', async () => {
	const sock = await makeInviteSocket(() => ({ tag: 'membership_approval_request', attrs: { jid: GROUP_JID } }))
	try {
		assert.deepEqual(await sock.groupAcceptInviteWithStatus('CODEPEND'), { status: 'pending', jid: GROUP_JID })
		assert.equal(await sock.groupAcceptInvite('CODEPEND'), undefined, 'legacy contract unchanged: pending reads as undefined')
	} finally {
		endQuietly(sock)
	}
})
