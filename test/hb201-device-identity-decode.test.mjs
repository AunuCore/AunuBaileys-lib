// HB-201 addendum 4 (2.7.0): creds.account.details that is present
// but garbage must fail decode-ability validation in sendRetryRequest
// — pre-fix it passed the non-empty check and a retry receipt went
// out carrying a <device-identity> the peer cannot decode. Post-fix
// no retry receipt is sent for such creds. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { waproto } from '../WAProto/index.js'
import { Curve } from '../lib/Utils/crypto.js'
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

const ciphertextStanza = id => ({
	tag: 'message',
	attrs: { id, from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: randomBytes(64) }]
})

const setup = async (t, details) => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const acctKp = Curve.generateKeyPair()
	sock.authState.creds.account = {
		details,
		accountSignatureKey: acctKp.public,
		accountSignature: Curve.sign(acctKp.private, Buffer.from('x'))
	}
	const sent = []
	fakeOpenTransport(sock, sent)
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	return { sock, sent }
}

test('HB-201 add4: garbage creds.account.details blocks the retry receipt', async t => {
	const { sock, sent } = await setup(t, Buffer.from('zzzzzzzzzzzz', 'utf8'))
	sock.ws.emit('CB:message', ciphertextStanza('HB201-GARBAGE'))
	await sleep(2500)
	const nodes = await decodeSentFrames(sent)
	assert.ok(
		!nodes.some(n => n.tag === 'receipt' && n.attrs.type === 'retry'),
		'no retry receipt may be built from an undecodable device identity'
	)
})

test('HB-201 add4 control: well-formed creds.account.details still gets a retry receipt', async t => {
	const details = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
	const { sock, sent } = await setup(t, Buffer.from(details))
	sock.ws.emit('CB:message', ciphertextStanza('HB201-VALID'))
	await sleep(2500)
	const nodes = await decodeSentFrames(sent)
	assert.ok(
		nodes.some(n => n.tag === 'receipt' && n.attrs.type === 'retry'),
		'a decodable device identity still flows into the retry receipt'
	)
})
