// HB-481 + addendum facet 1 (2.7.0): `acked` in handleMessage is set
// only AFTER the send it records resolves. Pre-fix, acked=true was set
// optimistically before await sendReceipt/sendMessageAck — a transport
// throw then skipped the upsert AND suppressed the outer catch's NACK,
// so a decrypted message vanished silently. Post-fix the failed send
// leaves acked=false and the catch NACKs (error 500), so the server
// redelivers. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waproto } from '../WAProto/index.js'
import { decodeDecompressedBinaryNode } from '../lib/WABinary/decode.js'
import * as binaryConstants from '../lib/WABinary/constants.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeOfflineSocket, sleep, waitFor, endQuietly } from './helpers.mjs'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'
const T = () => String(Math.floor(Date.now() / 1000))

const decodeFrameSync = data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	const payload = buf.subarray(off + 3, off + 3 + len)
	if (payload[0] !== 0) throw new Error('compressed frame')
	return decodeDecompressedBinaryNode(payload.subarray(1), binaryConstants)
}

const plaintextStanza = (from, id) => ({
	tag: 'message',
	attrs: { id, from, t: T(), type: 'text' },
	content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ conversation: 'hi' }).finish() }]
})

const setup = async (t, failTag) => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const attempts = []
	const sentOk = []
	sock.ws.socket = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) {
			if (ev === 'close') this._closeFn = fn
		},
		on() {},
		send(data, cb) {
			let node = null
			try {
				node = decodeFrameSync(data)
			} catch {}
			attempts.push(node)
			const shouldFail = !!failTag && node?.tag === failTag
			if (!shouldFail) sentOk.push(node)
			if (cb) cb(shouldFail ? new Error('SIMULATED-TRANSPORT-FAIL') : undefined)
		},
		close() {
			this.readyState = 3
			if (this._closeFn) this._closeFn()
		}
	}
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	const upserts = []
	sock.ev.on('messages.upsert', ({ messages }) => upserts.push(...messages))
	return { sock, attempts, sentOk, upserts }
}

test('HB-481 control: a working transport upserts and receipts, with no NACK', async t => {
	const { sock, sentOk, upserts } = await setup(t, null)
	sock.ws.emit('CB:message', plaintextStanza(PEER, 'HB481-OK'))
	const ok = await waitFor(() => { try { sock.ev.flush() } catch {} return upserts.some(m => m.key?.id === 'HB481-OK') }, 6000)
	assert.ok(ok, 'message upserted')
	assert.ok(sentOk.some(n => n?.tag === 'receipt'), 'delivery receipt sent')
	assert.ok(!sentOk.some(n => n?.tag === 'ack' && n?.attrs?.error), 'no NACK sent')
})

test('HB-481: when sendReceipt throws, the stanza is NACKed instead of vanishing', async t => {
	const { sock, attempts, sentOk } = await setup(t, 'receipt')
	sock.ws.emit('CB:message', plaintextStanza(PEER, 'HB481-FAIL'))
	await waitFor(() => attempts.some(n => n?.tag === 'receipt'), 6000)
	await sleep(1200)
	assert.ok(attempts.some(n => n?.tag === 'receipt'), 'the receipt was attempted (and failed)')
	const nack = sentOk.find(n => n?.tag === 'ack' && n?.attrs?.id === 'HB481-FAIL')
	assert.ok(nack, 'a fallback ack must go out after the failed receipt — pre-fix acked=true suppressed it')
	assert.equal(nack.attrs.error, '500', 'the fallback ack is the UnhandledError NACK')
})
