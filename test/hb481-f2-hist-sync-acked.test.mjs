// AunuBaileys 2.7.0 — HB-481 addendum facet 2 regression tests.
// The success branch of handleMessage sends the delivery receipt
// and then, for a history message, a second `hist_sync` receipt.
// Pre-fix, `acked = true` was set between the two sends, so a
// throw from the hist_sync receipt skipped the upsert AND the
// outer catch suppressed the NACK — the history message vanished
// silently. Post-fix the flag is set only after BOTH receipts
// resolve, so the failed receipt NACKs (error 500) and the
// server's redelivery upserts the message.
// Fails without the fix: no NACK goes out after the failed
// hist_sync receipt.
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

const historyStanza = (from, id) => ({
	tag: 'message',
	attrs: { id, from, t: T(), type: 'text' },
	content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ protocolMessage: { historySyncNotification: {} } }).finish() }]
})

const setup = async (t, failHistSyncOnce) => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const attempts = []
	const sentOk = []
	let histSyncFailed = false
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
			const shouldFail = !!failHistSyncOnce && !histSyncFailed && node?.tag === 'receipt' && node?.attrs?.type === 'hist_sync'
			if (shouldFail) histSyncFailed = true
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

test('HB-481 facet 2 control: a history message upserts with both receipts and no NACK', async t => {
	const { sock, sentOk, upserts } = await setup(t, false)
	sock.ws.emit('CB:message', historyStanza(PEER, 'HB481F2-OK'))
	const ok = await waitFor(() => { try { sock.ev.flush() } catch {} return upserts.some(m => m.key?.id === 'HB481F2-OK') }, 6000)
	assert.ok(ok, 'history message upserted')
	const receipts = sentOk.filter(n => n?.tag === 'receipt')
	assert.equal(receipts.length, 2, 'exactly two receipts go out (delivery + hist_sync)')
	assert.ok(receipts.some(n => n?.attrs?.type === 'hist_sync'), 'hist_sync receipt sent')
	assert.ok(receipts.some(n => n?.attrs?.type !== 'hist_sync'), 'delivery receipt sent')
	assert.ok(!sentOk.some(n => n?.tag === 'ack' && n?.attrs?.error), 'no NACK sent')
})

test('HB-481 facet 2: when the hist_sync receipt throws, the stanza is NACKed and redelivery upserts it', async t => {
	const { sock, attempts, sentOk, upserts } = await setup(t, true)
	sock.ws.emit('CB:message', historyStanza(PEER, 'HB481F2-FAIL'))
	await waitFor(() => attempts.some(n => n?.tag === 'receipt' && n?.attrs?.type === 'hist_sync'), 6000)
	await sleep(1200)
	const nack = sentOk.find(n => n?.tag === 'ack' && n?.attrs?.id === 'HB481F2-FAIL')
	assert.ok(nack, 'a fallback ack must go out after the failed hist_sync receipt — pre-fix acked=true suppressed it')
	assert.equal(nack.attrs.error, '500', 'the fallback ack is the UnhandledError NACK')
	try { sock.ev.flush() } catch {}
	assert.ok(!upserts.some(m => m.key?.id === 'HB481F2-FAIL'), 'no upsert on the first attempt — the throw happens before upsertMessage')
	// the server redelivers after the NACK; the transport is healthy now
	sock.ws.emit('CB:message', historyStanza(PEER, 'HB481F2-FAIL'))
	const ok = await waitFor(() => { try { sock.ev.flush() } catch {} return upserts.some(m => m.key?.id === 'HB481F2-FAIL') }, 6000)
	assert.ok(ok, 'redelivery upserts the history message')
	assert.equal(sentOk.filter(n => n?.tag === 'ack' && n?.attrs?.id === 'HB481F2-FAIL').length, 1, 'exactly one NACK — the redelivery is acked cleanly')
})
