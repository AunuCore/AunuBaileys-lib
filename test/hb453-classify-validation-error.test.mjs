// HB-453 addendum facet 1 (2.7.0): classifyDecryptFailureForRetry
// must NOT map an inconclusive session-store read ('validation
// error') to BadMac(7). Pre-fix the condition
// `validation.exists || validation.reason !== 'no session'` sent a
// retry receipt with error=7 for a store problem; post-fix the class
// falls through to UnknownError(0). Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { waproto } from '../WAProto/index.js'
import { Curve } from '../lib/Utils/crypto.js'
import { decodeBinaryNode, getBinaryNodeChild } from '../lib/WABinary/index.js'
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

test('HB-453 f1: a validation-error store read yields retry error=0, not BadMac 7', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const acctKp = Curve.generateKeyPair()
	sock.authState.creds.account = {
		details: Buffer.from(waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
		accountSignatureKey: acctKp.public,
		accountSignature: Curve.sign(acctKp.private, Buffer.from('x'))
	}
	// The store cannot prove anything about the session.
	sock.signalRepository.validateSession = async () => ({ exists: false, reason: 'validation error' })
	const sent = []
	fakeOpenTransport(sock, sent)
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })

	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'HB453-1', from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
		content: [{ tag: 'enc', attrs: { type: 'msg' }, content: randomBytes(64) }]
	})
	await sleep(2500)

	const nodes = await decodeSentFrames(sent)
	const receipt = nodes.find(n => n.tag === 'receipt' && n.attrs.type === 'retry')
	assert.ok(receipt, 'a retry receipt is still sent')
	const retryNode = getBinaryNodeChild(receipt, 'retry')
	assert.equal(
		retryNode?.attrs?.error,
		'0',
		`an inconclusive store read must classify UnknownError(0), got error=${retryNode?.attrs?.error}`
	)
})
