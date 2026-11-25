// AunuBaileys 2.7.0 — D-1081-A: sound stickers. A stickerAudio
// content builds a StickerMessage whose nested audioMessage
// (proto field 26) survives the wire encode, and the sticker WebP
// uploaded for it carries "sound-sha256" (the audio's SHA-256) in
// its EXIF — proven end-to-end via the sticker's fileSha256, which
// prepareWAMessageMedia computes over the exact uploaded bytes.
import { test } from 'node:test'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { generateWAMessageContent, addSoundSha256ToStickerWebP } from '../lib/Utils/messages.js'
import { sha256 } from '../lib/Utils/crypto.js'
import { waproto as proto } from '../WAProto/index.js'

// --- programmatic WebP fixtures -------------------------------------
const chunk = (fourCC, data) => {
	const header = Buffer.alloc(8)
	header.write(fourCC, 0, 'ascii')
	header.writeUInt32LE(data.length, 4)
	return data.length % 2 ? Buffer.concat([header, data, Buffer.alloc(1)]) : Buffer.concat([header, data])
}

const webpFromChunks = chunks => {
	const body = Buffer.concat(chunks)
	const head = Buffer.alloc(12)
	head.write('RIFF', 0, 'ascii')
	head.writeUInt32LE(4 + body.length, 4)
	head.write('WEBP', 8, 'ascii')
	return Buffer.concat([head, body])
}

// VP8X (flags 0, canvas 1x1) + a minimal VP8L chunk
const vp8lChunk = () => {
	const data = Buffer.alloc(5)
	data[0] = 0x2f // VP8L signature; remaining bits: width-1 = 0, height-1 = 0
	return chunk('VP8L', data)
}
const webpWithVp8x = () => webpFromChunks([chunk('VP8X', Buffer.alloc(10)), vp8lChunk()])
const webpWithoutVp8x = () => webpFromChunks([vp8lChunk()])

const readChunks = webp => {
	const out = []
	let offset = 12
	while (offset + 8 <= webp.length) {
		const fourCC = webp.toString('ascii', offset, offset + 4)
		const size = webp.readUInt32LE(offset + 4)
		out.push({ fourCC, data: webp.subarray(offset + 8, offset + 8 + size) })
		offset += 8 + size + (size % 2)
	}

	return out
}

const exifJsonOf = webp => {
	const exif = readChunks(webp).find(c => c.fourCC === 'EXIF')
	assert.ok(exif, 'EXIF chunk present')
	// TIFF: header + IFD end at byte 26, the JSON payload follows
	return JSON.parse(exif.data.subarray(26).toString('utf-8'))
}

// --- fixtures ---------------------------------------------------------
const AUDIO = Buffer.concat([Buffer.from('OggS'), Buffer.from('aunu-sound-sticker-fixture-audio')])
const AUDIO_SHA256_HEX = createHash('sha256').update(AUDIO).digest('hex')

const opts = {
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
	userJid: '6281234567@s.whatsapp.net',
	upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/fixture', directPath: '/fixture' })
}

test('sound sticker EXIF: addSoundSha256ToStickerWebP writes sound-sha256 and sets the VP8X EXIF flag', () => {
	const out = addSoundSha256ToStickerWebP(webpWithVp8x(), AUDIO_SHA256_HEX)
	assert.equal(exifJsonOf(out)['sound-sha256'], AUDIO_SHA256_HEX)
	const vp8x = readChunks(out).find(c => c.fourCC === 'VP8X')
	assert.ok(vp8x.data[0] & 0x20, 'VP8X EXIF flag set')
	assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size rebuilt')
})

test('sound sticker EXIF: a plain VP8L WebP gains a synthesised VP8X header', () => {
	const out = addSoundSha256ToStickerWebP(webpWithoutVp8x(), AUDIO_SHA256_HEX)
	const chunks = readChunks(out)
	assert.equal(chunks[0].fourCC, 'VP8X')
	assert.ok(chunks[0].data[0] & 0x20)
	assert.equal(exifJsonOf(out)['sound-sha256'], AUDIO_SHA256_HEX)
})

test('sound sticker EXIF: non-WebP input and a bad digest are Boom 400', () => {
	assert.throws(
		() => addSoundSha256ToStickerWebP(Buffer.from('not a webp at all'), AUDIO_SHA256_HEX),
		err => err?.output?.statusCode === 400
	)
	assert.throws(
		() => addSoundSha256ToStickerWebP(webpWithVp8x(), 'xyz'),
		err => err?.output?.statusCode === 400
	)
})

test('stickerAudio: builds a stickerMessage with the audio nested on field 26', async () => {
	const sticker = webpWithVp8x()
	const m = await generateWAMessageContent(
		{
			stickerAudio: {
				sticker,
				audio: AUDIO,
				seconds: 2,
				mentions: ['628987654321@s.whatsapp.net']
			}
		},
		opts
	)

	const sm = m.stickerMessage
	assert.ok(sm, 'stickerMessage built')
	assert.equal(sm.isAnimated, true)
	assert.equal(sm.isLottie, false)
	assert.equal(typeof sm.stickerSentTs, 'number')
	assert.ok(sm.audioMessage, 'nested audioMessage present')
	assert.equal(sm.audioMessage.mimetype, 'audio/ogg; codecs=opus')
	assert.equal(Number(sm.audioMessage.seconds), 2)
	assert.deepEqual(sm.contextInfo?.mentionedJid, ['628987654321@s.whatsapp.net'])

	// field 26 survives the wire encode/decode round-trip
	const decoded = proto.Message.decode(proto.Message.encode(m).finish())
	assert.ok(decoded.stickerMessage?.audioMessage, 'audioMessage present after wire round-trip')
	assert.equal(decoded.stickerMessage.audioMessage.mimetype, 'audio/ogg; codecs=opus')

	// the uploaded sticker bytes are the EXIF-injected WebP: the
	// branch computes the audio hash itself and injects it, and
	// fileSha256 is taken over exactly those uploaded bytes
	const expectedSticker = addSoundSha256ToStickerWebP(sticker, AUDIO_SHA256_HEX)
	assert.equal(Buffer.from(sm.fileSha256).toString('hex'), sha256(expectedSticker).toString('hex'))
})

test('stickerAudio: a non-WebP sticker and a missing audio are Boom 400', async () => {
	await assert.rejects(
		generateWAMessageContent({ stickerAudio: { sticker: Buffer.from('png?'), audio: AUDIO, seconds: 1 } }, opts),
		err => err?.output?.statusCode === 400 && /WebP/.test(err.message)
	)
	await assert.rejects(
		generateWAMessageContent({ stickerAudio: { sticker: webpWithVp8x() } }, opts),
		err => err?.output?.statusCode === 400
	)
})
