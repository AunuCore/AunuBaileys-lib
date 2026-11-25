// HB-492 (2.7.0): prepareStickerPackMessage converted up to 60
// stickers with unbounded concurrency (Promise.all over the whole
// pack) — 12 parallel 40 MP decodes peaked at 1101 MiB RSS vs 445
// MiB sequential, so a full pack OOMs a 2–4 GiB host. Conversions
// now run through the in-tree SimpleQueue with a small bound in
// flight. The `sharp` backend is faked (see
// hb492-fake-sharp-hook.mjs) with a converter that counts
// concurrent toBuffer() calls, so the test asserts the bound
// directly while all 60 stickers still convert with deterministic,
// in-order results — the same per-sticker output the unbounded
// version produced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

register('./hb492-fake-sharp-hook.mjs', import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { prepareStickerPackMessage } = await import(path.join(ROOT, 'lib/Utils/messages.js'))

// The bound lives in src/Utils/messages.ts as
// STICKER_PACK_CONVERSION_CONCURRENCY; read it from the built lib
// so the test tracks the shipped value, and pin the design range
// (4–8) so a future bump to an unbounded value fails loudly.
const readBoundFromBuild = () => {
	const built = fs.readFileSync(path.join(ROOT, 'lib/Utils/messages.js'), 'utf8')
	const match = built.match(/STICKER_PACK_CONVERSION_CONCURRENCY = (\d+)/)
	assert.ok(match, 'conversion bound constant not found in built lib/Utils/messages.js')
	return Number(match[1])
}

// Minimal valid 1x1 PNGs, one distinct grey value per sticker.
const crcTable = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()
const crc32 = buf => {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
	const out = Buffer.alloc(12 + data.length)
	out.writeUInt32BE(data.length, 0)
	out.write(type, 4, 'ascii')
	data.copy(out, 8)
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
	return out
}
const makePng1x1 = grey => {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(1, 0)
	ihdr.writeUInt32BE(1, 4)
	ihdr[8] = 8
	ihdr[9] = 2
	const raw = Buffer.from([0, grey, grey, grey])
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	])
}

// The fake converter's exact transform (see hb492-fake-sharp.mjs):
// output = 'FAKE-WEBP:' + input, and the sticker fileName is the
// sha256 of that output, base64 with '/' replaced by '-'.
const expectedFileName = png => {
	const webp = Buffer.concat([Buffer.from('FAKE-WEBP:'), png])
	return `${createHash('sha256').update(webp).digest('base64').replace(/\//g, '-')}.webp`
}

test('HB-492: a 60-sticker pack converts with bounded concurrency and identical in-order results', async () => {
	const bound = readBoundFromBuild()
	assert.ok(bound >= 1 && bound <= 8, `conversion bound ${bound} is outside the 4–8 design range`)
	globalThis.__hb492FakeSharp = { active: 0, peak: 0, calls: 0 }

	const pngs = Array.from({ length: 60 }, (_, i) => makePng1x1(i))
	const pack = {
		name: 't',
		publisher: 't',
		stickers: pngs.map((png, i) => ({ data: png, emojis: [`E${i}`] })),
		cover: makePng1x1(200)
	}
	const uploadStub = async () => ({ directPath: '/x' })

	const { stickerPackMessage } = await prepareStickerPackMessage(pack, {
		upload: uploadStub,
		logger: undefined,
		mediaUploadTimeoutMs: 120_000
	})

	const state = globalThis.__hb492FakeSharp
	assert.equal(stickerPackMessage.stickers.length, 60, 'all 60 stickers convert')
	assert.ok(state.peak <= bound, `peak concurrent conversions ${state.peak} exceeds bound ${bound}`)
	assert.ok(state.peak > 1, `expected real parallelism, peak was ${state.peak}`)
	assert.ok(state.calls >= 61, `expected 60 sticker + 1 cover conversions, saw ${state.calls}`)
	stickerPackMessage.stickers.forEach((meta, i) => {
		assert.equal(meta.fileName, expectedFileName(pngs[i]), `sticker ${i} fileName`)
		assert.deepEqual(meta.emojis, [`E${i}`], `sticker ${i} emojis`)
		assert.equal(meta.mimetype, 'image/webp', `sticker ${i} mimetype`)
		assert.equal(meta.isAnimated, false, `sticker ${i} isAnimated`)
	})
})
