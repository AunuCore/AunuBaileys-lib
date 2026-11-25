// AunuBaileys 2.7.0 — HB-239 addendum (decode-malformed facet): the
// three protobuf decodes in configureSuccessfulPairing must turn
// present-but-malformed device-identity bytes into a descriptive Boom,
// not a raw RangeError. Fails without the fix: T1/T2/T5 throw
// 'RangeError: index out of range' (isBoom false).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureSuccessfulPairing } from '../lib/Utils/validate-connection.js'
import { Curve, hmacSign } from '../lib/Utils/crypto.js'
import { waproto as proto } from '../WAProto/index.js'

const identKp = Curve.generateKeyPair()
const advSecretKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')
const acctKp = Curve.generateKeyPair()
const creds = { advSecretKey, signedIdentityKey: identKp, signalIdentities: [] }

const buildStanza = deviceIdentityContent => ({
	tag: 'iq',
	attrs: { id: 'pair-1', type: 'set' },
	content: [
		{
			tag: 'pair-success',
			attrs: {},
			content: [
				{ tag: 'device-identity', attrs: {}, content: deviceIdentityContent },
				{ tag: 'device', attrs: { jid: '6281234567890:12@s.whatsapp.net' } },
				{ tag: 'platform', attrs: { name: 'TestPlatform' } }
			]
		}
	]
})

const buildValidHmacNode = details => {
	const accountMsg = Buffer.concat([Buffer.from([6, 0]), details, identKp.public])
	const accountSignature = Curve.sign(acctKp.private, accountMsg)
	const account = { accountSignatureKey: acctKp.public, accountSignature, details }
	const enc = proto.ADVSignedDeviceIdentity.encode(account).finish()
	const hmac = hmacSign(enc, Buffer.from(advSecretKey, 'base64'))
	return proto.ADVSignedDeviceIdentityHMAC.encode({ details: enc, hmac }).finish()
}

const isDescriptiveBoom = err => err?.isBoom === true && /Invalid device-identity/.test(String(err?.message))

test('HB-239 decode-malformed: garbage device-identity content throws a descriptive Boom', () => {
	assert.throws(
		() => configureSuccessfulPairing(buildStanza(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), creds),
		isDescriptiveBoom
	)
})

test('HB-239 decode-malformed: HMAC-valid garbage details throws a descriptive Boom', () => {
	const garbageDetails = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
	const hmac = hmacSign(garbageDetails, Buffer.from(advSecretKey, 'base64'))
	const hmacNode = proto.ADVSignedDeviceIdentityHMAC.encode({ details: garbageDetails, hmac }).finish()
	assert.throws(() => configureSuccessfulPairing(buildStanza(hmacNode), creds), isDescriptiveBoom)
})

test('HB-239 decode-malformed: valid account with garbage deviceDetails throws a descriptive Boom', () => {
	const garbageDeviceDetails = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef])
	assert.throws(() => configureSuccessfulPairing(buildStanza(buildValidHmacNode(garbageDeviceDetails)), creds), isDescriptiveBoom)
})

test('HB-239 decode-malformed: control — fully valid stanza still pairs', () => {
	const good = proto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 5 }).finish()
	const result = configureSuccessfulPairing(buildStanza(buildValidHmacNode(good)), creds)
	assert.equal(result.creds.me.id, '6281234567890:12@s.whatsapp.net')
})

test('HB-239 decode-malformed: control — HMAC mismatch still throws the descriptive signature Boom', () => {
	const good = proto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 5 }).finish()
	const accountMsg = Buffer.concat([Buffer.from([6, 0]), good, identKp.public])
	const accountSignature = Curve.sign(acctKp.private, accountMsg)
	const account = { accountSignatureKey: acctKp.public, accountSignature, details: good }
	const enc = proto.ADVSignedDeviceIdentity.encode(account).finish()
	const hmacNode = proto.ADVSignedDeviceIdentityHMAC.encode({ details: enc, hmac: Buffer.alloc(32, 0x11) }).finish()
	assert.throws(
		() => configureSuccessfulPairing(buildStanza(hmacNode), creds),
		err => err?.isBoom === true && /Invalid account signature/.test(String(err?.message))
	)
})
