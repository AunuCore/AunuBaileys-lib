// AunuBaileys 2.7.0 — HB-238 addendum 2: crypto/proto failures BELOW
// the HB-238 shape+length guards in processHandshake (corrupt GCM tag,
// empty payload, decrypted-garbage CertChain/Details) and the plaintext
// first-frame HandshakeMessage.decode in validateConnection must throw
// descriptive errors, not raw GCM/protobuf errors. Fails without the
// fix: T1-T4 surface 'Unsupported state or unable to authenticate data',
// 'Invalid authentication tag length: 0', 'invalid wire type ...' or a
// raw RangeError; the facet-B test ends the socket with a raw RangeError.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeNoiseHandler } from '../lib/Utils/noise-handler.js'
import { Curve, aesEncryptGCM, hkdf, sha256 } from '../lib/Utils/crypto.js'
import { NOISE_MODE, NOISE_WA_HEADER, WA_CERT_DETAILS } from '../lib/Defaults/index.js'
import { waproto } from '../WAProto/index.js'
import { makeOfflineSocket, fakeOpenTransport, sleep, waitFor, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

WebSocketClient.prototype.connect = () => {}

const stub = { child: () => stub, trace: () => {}, warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, level: 'info' }
const genIV = counter => {
	const iv = new ArrayBuffer(12)
	new DataView(iv).setUint32(8, counter)
	return new Uint8Array(iv)
}
const hkdf2 = async (ikm, salt) => {
	const k = await hkdf(Buffer.from(ikm), 64, { salt, info: '' })
	return [k.slice(0, 32), k.slice(32)]
}
const validDetails = () =>
	waproto.CertChain.NoiseCertificate.Details.encode({ serial: 1, issuerSerial: WA_CERT_DETAILS.SERIAL, key: Buffer.alloc(32) }).finish()
const validChain = () =>
	waproto.CertChain.encode({
		intermediate: { details: validDetails(), signature: Buffer.alloc(64) },
		leaf: { details: validDetails(), signature: Buffer.alloc(64) }
	}).finish()

async function buildServerHello(handlerPub, payloadPlain) {
	const serverEph = Curve.generateKeyPair()
	const serverStatic = Curve.generateKeyPair()
	const data = Buffer.from(NOISE_MODE)
	let hash = data.byteLength === 32 ? data : sha256(data)
	const salt0 = hash
	hash = sha256(Buffer.concat([hash, NOISE_WA_HEADER]))
	hash = sha256(Buffer.concat([hash, handlerPub]))
	const shared1 = Curve.sharedKey(serverEph.private, handlerPub)
	const [w1, r1] = await hkdf2(shared1, salt0)
	hash = sha256(Buffer.concat([hash, serverEph.public]))
	const ctStatic = aesEncryptGCM(serverStatic.public, r1, genIV(0), hash)
	hash = sha256(Buffer.concat([hash, ctStatic]))
	const shared2 = Curve.sharedKey(serverStatic.private, handlerPub)
	const [, r2] = await hkdf2(shared2, w1)
	const ctPayload = aesEncryptGCM(payloadPlain, r2, genIV(0), hash)
	return { serverHello: { ephemeral: serverEph.public, static: ctStatic, payload: ctPayload } }
}

const freshHandler = () => {
	const kp = Curve.generateKeyPair()
	return { kp, noise: makeNoiseHandler({ keyPair: kp, NOISE_HEADER: NOISE_WA_HEADER, logger: stub, routingInfo: undefined }) }
}

const isDescriptiveHandshakeError = err =>
	/malformed/.test(String(err?.message)) &&
	!/Unsupported state|Invalid authentication tag|invalid wire type|index out of range/.test(String(err?.message))

const expectDescriptive = async serverHelloPromise => {
	const { kp, noise } = freshHandler()
	const { serverHello } = await serverHelloPromise(kp)
	assert.throws(
		() => noise.processHandshake({ serverHello }, Curve.generateKeyPair()),
		isDescriptiveHandshakeError,
		'failure must be a descriptive malformed-handshake error, not a raw crypto/proto error'
	)
}

test('HB-238 addendum 2: valid control reaches the descriptive cert-signature Boom', async () => {
	const { kp, noise } = freshHandler()
	const { serverHello } = await buildServerHello(kp.public, validChain())
	assert.throws(
		() => noise.processHandshake({ serverHello }, Curve.generateKeyPair()),
		err => err?.isBoom === true && /noise certificate signature invalid/.test(String(err?.message))
	)
})

test('HB-238 addendum 2: static 48B with corrupt GCM tag throws descriptively', async () => {
	await expectDescriptive(async kp => {
		const built = await buildServerHello(kp.public, validChain())
		const bad = Buffer.from(built.serverHello.static)
		bad[5] ^= 0xff
		built.serverHello.static = bad
		return built
	})
})

test('HB-238 addendum 2: payload with corrupt GCM tag throws descriptively', async () => {
	await expectDescriptive(async kp => {
		const built = await buildServerHello(kp.public, validChain())
		const bad = Buffer.from(built.serverHello.payload)
		bad[10] ^= 0xff
		built.serverHello.payload = bad
		return built
	})
})

test('HB-238 addendum 2: empty payload throws descriptively', async () => {
	await expectDescriptive(async kp => {
		const built = await buildServerHello(kp.public, validChain())
		built.serverHello.payload = Buffer.alloc(0)
		return built
	})
})

test('HB-238 addendum 2: payload decrypting to garbage CertChain bytes throws descriptively', async () => {
	const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6, 0xf5, 0xf4, 0xf3, 0xf2, 0xf1, 0xf0])
	await expectDescriptive(async kp => buildServerHello(kp.public, garbage))
	const ascii = Buffer.from('NOT A CERTCHAIN AT ALL, JUST ASCII BYTES 1234567890', 'utf-8')
	await expectDescriptive(async kp => buildServerHello(kp.public, ascii))
})

test('HB-238 addendum 2: well-formed chain with garbage intermediate details throws descriptively', async () => {
	const chain = waproto.CertChain.encode({
		intermediate: { details: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]), signature: Buffer.alloc(64) },
		leaf: { details: validDetails(), signature: Buffer.alloc(64) }
	}).finish()
	await expectDescriptive(async kp => buildServerHello(kp.public, chain))
})

test('HB-238 addendum 2 facet B: garbage first frame ends the socket with a descriptive Boom, not a raw RangeError', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	let closeError = null
	sock.ev.on('connection.update', u => {
		if (u.connection === 'close') closeError = u.lastDisconnect?.error ?? null
	})
	sock.ws.emit('open')
	await sleep(100)
	sock.ws.emit('frame', Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]))
	assert.equal(await waitFor(() => closeError !== null, 5000), true, 'the socket must end after the garbage first frame')
	assert.equal(closeError?.isBoom, true, `expected a Boom, got ${closeError?.constructor?.name}: ${closeError?.message}`)
	assert.match(String(closeError?.message), /malformed/, 'the close error must describe the malformed handshake')
	endQuietly(sock)
})
