// LAT-2 (2.7.0, latency audit #5): the fixed retry backoff delay
// (retryRequestDelayMs, default 250 ms) must sit BEFORE the global
// retryMutex acquisition, not inside it. Inside, a decrypt-failure
// flood serialized every later retry receipt behind
// N x retryRequestDelayMs of pure waiting; outside, each failure
// still waits its own delay (per-item pacing unchanged) but the
// mutex itself only guards receipt construction/send + the counter,
// so another item can enter it while one item is backing off.
//
// Test 1 is structural (precedent: test/35 reads the same source for
// ordering invariants) because the retry branch also runs under
// handleMessage's messageMutex, which masks the retryMutex timing
// in black-box measurements. Test 2 is behavioral: the per-item
// backoff itself still happens before the receipt goes out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { waproto } from '../WAProto/index.js'
import { Curve } from '../lib/Utils/crypto.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeOfflineSocket, fakeOpenTransport, sleep, endQuietly } from './helpers.mjs'

WebSocketClient.prototype.connect = () => {}

test('LAT-2: the retry backoff delay is outside (before) the retryMutex', () => {
	const src = fs.readFileSync(new URL('../src/Socket/messages-recv.ts', import.meta.url), 'utf8')
	const mutexIdx = src.indexOf('await retryMutex.mutex(')
	assert.ok(mutexIdx > 0, 'the retryMutex call site exists')
	const delayIdx = src.indexOf('await delay(retryRequestDelayMs)', mutexIdx - 2000)
	assert.ok(delayIdx > 0, 'a retryRequestDelayMs delay exists near the retryMutex site')
	assert.ok(
		delayIdx < mutexIdx,
		'the backoff delay must run BEFORE acquiring retryMutex — inside, it serializes the global retry queue'
	)
	// And no second delay hides inside the mutex callback (the
	// callback ends where the stanza ack is recorded, HB-481 site).
	const callbackEnd = src.indexOf('sendMessageAck(node, NACK_REASONS.UnhandledError)', mutexIdx)
	assert.ok(callbackEnd > mutexIdx, 'the retryMutex callback region is found')
	assert.equal(
		src.slice(mutexIdx, callbackEnd).includes('delay(retryRequestDelayMs)'),
		false,
		'no backoff delay may remain inside the retryMutex callback'
	)
})

test('LAT-2: per-item backoff still happens — the retry receipt waits out the delay', async t => {
	const DELAY_MS = 1200
	const sock = await makeOfflineSocket({ retryRequestDelayMs: DELAY_MS })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: '628123456789@s.whatsapp.net' }
	const acctKp = Curve.generateKeyPair()
	sock.authState.creds.account = {
		details: Buffer.from(
			waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
		),
		accountSignatureKey: acctKp.public,
		accountSignature: Curve.sign(acctKp.private, Buffer.from('x'))
	}
	const sent = []
	fakeOpenTransport(sock, sent)
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })

	const t0 = Date.now()
	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'LAT2-1', from: '628987654321@s.whatsapp.net', t: String(Math.floor(Date.now() / 1000)), type: 'text' },
		content: [{ tag: 'enc', attrs: { type: 'msg' }, content: randomBytes(64) }]
	})

	let receiptAt = 0
	for (let i = 0; i < 24 && !receiptAt; i++) {
		await sleep(250)
		for (const buf of sent) {
			let off = 0
			if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
			const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
			try {
				const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
				if (node.tag === 'receipt' && node.attrs.type === 'retry' && node.attrs.id === 'LAT2-1') {
					receiptAt = Date.now()
				}
			} catch {}
		}
	}

	assert.ok(receiptAt > 0, 'the retry receipt was sent')
	assert.ok(
		receiptAt - t0 >= DELAY_MS - 100,
		`the receipt still waited out the per-item backoff (${receiptAt - t0} ms < ${DELAY_MS} ms)`
	)
})
