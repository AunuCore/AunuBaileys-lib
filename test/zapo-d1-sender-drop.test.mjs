// Zapo D1 (2.7.0): <unavailable type="sender_drop"/> is its own
// unavailable kind — the sender dropped the message, so no
// placeholder resend can ever recover it. It must be classified and
// skipped from the resend placeholder path like the fanout kinds,
// with a plain ack. Pre-fix only 3 types were excluded and
// sender_drop fell through to requestPlaceholderResend. Fails
// without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

const makeCapturingLogger = () => {
	const lines = []
	const logger = {
		level: 'trace',
		child() {
			return logger
		},
		trace() {},
		debug(o, m) {
			lines.push(`debug: ${m || ''} ${JSON.stringify(o ?? '')}`)
		},
		info(o, m) {
			lines.push(`info: ${m || ''} ${JSON.stringify(o ?? '')}`)
		},
		warn(o, m) {
			lines.push(`warn: ${m || ''} ${JSON.stringify(o ?? '')}`)
		},
		error(o, m) {
			lines.push(`error: ${m || ''} ${JSON.stringify(o ?? '')}`)
		},
		fatal() {}
	}
	return { logger, lines }
}

test('Zapo D1: sender_drop is skipped from placeholder resend and plain-acked', async t => {
	const cap = makeCapturingLogger()
	const sock = await makeOfflineSocket({ logger: cap.logger })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const sent = []
	fakeOpenTransport(sock, sent)

	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'D1-SENDER-DROP', from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
		content: [{ tag: 'unavailable', attrs: { type: 'sender_drop' } }]
	})
	await sleep(1500)

	assert.ok(
		cap.lines.some(l => l.includes('skipping placeholder resend for excluded unavailable type') && l.includes('sender_drop')),
		'sender_drop must be classified as an excluded unavailable type'
	)
	assert.ok(
		!cap.lines.some(l => l.includes('requested placeholder resend for unavailable message')),
		'no placeholder resend may be requested for a sender_drop message'
	)
	const nodes = await decodeSentFrames(sent)
	const ack = nodes.find(n => n.tag === 'ack' && n.attrs.id === 'D1-SENDER-DROP')
	assert.ok(ack, 'the stanza is acked')
	assert.equal(ack.attrs.error, undefined, 'the ack is plain, not a NACK')
})
