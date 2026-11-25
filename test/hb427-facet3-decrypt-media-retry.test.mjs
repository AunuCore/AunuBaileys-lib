// HB-427 facet 3 (2.7.0): decryptMediaRetryData had no validation —
// malformed enc_p / enc_iv from a peer surfaced as raw Node crypto
// errors, rethrown verbatim by updateMediaMessage. Malformed retry
// data is now Boom 502, matching the neighbouring guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { decryptMediaRetryData } = await import(path.join(ROOT, 'lib/Utils/messages-media.js'))
const { aesEncryptGCM, hkdf } = await import(path.join(ROOT, 'lib/Utils/crypto.js'))
const { waproto } = await import(path.join(ROOT, 'WAProto/index.js'))

const isBoom502 = err => !!err?.isBoom && err.output?.statusCode === 502

const validRetryData = (mediaKey, msgId) => {
	const retryKey = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
	const plaintext = waproto.MediaRetryNotification.encode({
		result: waproto.MediaRetryNotification.ResultType.SUCCESS,
		directPath: '/v/t62/ok.jpg'
	}).finish()
	const iv = randomBytes(12)
	return { ciphertext: aesEncryptGCM(plaintext, retryKey, iv, Buffer.from(msgId)), iv }
}

test('HB-427 facet 3: an empty iv fails with Boom 502, not a raw TypeError', () => {
	const mediaKey = randomBytes(32)
	assert.throws(
		() => decryptMediaRetryData({ ciphertext: randomBytes(48), iv: Buffer.alloc(0) }, mediaKey, 'MSG1'),
		isBoom502
	)
})

test('HB-427 facet 3: a ciphertext shorter than the GCM tag fails with Boom 502', () => {
	const mediaKey = randomBytes(32)
	assert.throws(
		() => decryptMediaRetryData({ ciphertext: randomBytes(8), iv: randomBytes(12) }, mediaKey, 'MSG1'),
		isBoom502
	)
})

test('HB-427 facet 3: a corrupted auth tag fails with Boom 502, not a raw crypto Error', () => {
	const mediaKey = randomBytes(32)
	const { ciphertext, iv } = validRetryData(mediaKey, 'MSG1')
	const tampered = Buffer.from(ciphertext)
	tampered[tampered.length - 1] ^= 0xff
	assert.throws(() => decryptMediaRetryData({ ciphertext: tampered, iv }, mediaKey, 'MSG1'), isBoom502)
})

test('HB-427 facet 3 (control): well-formed retry data still decrypts', () => {
	const mediaKey = randomBytes(32)
	const data = validRetryData(mediaKey, 'MSG1')
	const decoded = decryptMediaRetryData(data, mediaKey, 'MSG1')
	assert.equal(decoded.result, waproto.MediaRetryNotification.ResultType.SUCCESS)
	assert.equal(decoded.directPath, '/v/t62/ok.jpg')
})

test('HB-427 facet 3 / F2 (run-1097): GCM-valid ciphertext whose plaintext is protobuf garbage fails with Boom 502, not a raw decode Error', () => {
	const mediaKey = randomBytes(32)
	const msgId = 'MSG1'
	const retryKey = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
	// First byte 0xff => field 31, wire type 7: MediaRetryNotification.decode
	// throws a raw Error on this plaintext. The whole-function try/catch
	// in decryptMediaRetryData must convert it to Boom 502 — that is the
	// F2 trigger from run-1097, already closed by the facet-3 fix.
	const garbage = Buffer.from([0xff, 0x00, 0xaa, 0x55, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
	const iv = randomBytes(12)
	const ciphertext = aesEncryptGCM(garbage, retryKey, iv, Buffer.from(msgId))
	assert.throws(() => decryptMediaRetryData({ ciphertext, iv }, mediaKey, msgId), isBoom502)
})
