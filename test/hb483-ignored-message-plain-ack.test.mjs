// HB-483 (2.7.0): the shouldIgnoreJid fast path in processNode must
// PLAIN-ack an ignored MESSAGE stanza, not NACK it with error 500 —
// the NACK made the server redeliver the very message the host asked
// to drop, looping while the rule stayed active. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waproto } from '../WAProto/index.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeOfflineSocket, fakeOpenTransport, sleep, endQuietly } from './helpers.mjs'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'

const decodeSentFrames = async sent => {
	const nodes = []
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		nodes.push(await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len)))
	}
	return nodes
}

test('HB-483: an ignored message gets a plain ack (no error attr) and no upsert', async t => {
	const sock = await makeOfflineSocket({ shouldIgnoreJid: jid => jid === PEER })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const sent = []
	fakeOpenTransport(sock, sent)
	const upserts = []
	sock.ev.on('messages.upsert', ({ messages }) => upserts.push(...messages))

	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'HB483-1', from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
		content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ conversation: 'hi' }).finish() }]
	})
	await sleep(1000)

	const nodes = await decodeSentFrames(sent)
	const ack = nodes.find(n => n.tag === 'ack' && n.attrs.id === 'HB483-1')
	assert.ok(ack, 'the ignored stanza is still acked so the server stops redelivering it')
	assert.equal(ack.attrs.error, undefined, 'the ack must be PLAIN — a 500 NACK loops redelivery (HB-483)')
	assert.equal(upserts.length, 0, 'the ignored message is not upserted')
})
