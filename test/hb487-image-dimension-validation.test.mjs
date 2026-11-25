// HB-487 + addendum (2.7.0): generateProfilePicture passed host
// dimensions straight into the image backend (0 / negative / NaN /
// fractional / absurd -> raw library Error, not Boom 400), and
// extractImageThumb did the same with its width — a huge-but-valid
// width also upscaled without bound. Both boundaries now validate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { generateProfilePicture, extractImageThumb } = await import(path.join(ROOT, 'lib/Utils/messages-media.js'))

const isBoom400 = err => !!err?.isBoom && err.output?.statusCode === 400

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
	'base64'
)

test('HB-487: generateProfilePicture rejects invalid dimensions with Boom 400', async () => {
	for (const dimensions of [
		{ width: 0, height: 640 },
		{ width: 640, height: 0 },
		{ width: -1, height: 640 },
		{ width: Number.NaN, height: 640 },
		{ width: 640, height: Number.POSITIVE_INFINITY },
		{ width: 192.5, height: 640 },
		{ width: 100_000_000, height: 640 },
		{ width: '640', height: 640 }
	]) {
		await assert.rejects(
			() => generateProfilePicture(PNG_1X1, dimensions),
			isBoom400,
			`dimensions ${JSON.stringify(dimensions)}`
		)
	}
})

test('HB-487 (control): generateProfilePicture with valid dimensions still produces an image', async () => {
	const { img } = await generateProfilePicture(PNG_1X1, { width: 64, height: 64 })
	assert.ok(Buffer.isBuffer(img) && img.length > 0)
	const fallback = await generateProfilePicture(PNG_1X1)
	assert.ok(Buffer.isBuffer(fallback.img) && fallback.img.length > 0)
})

test('HB-487 addendum: extractImageThumb rejects invalid widths with Boom 400', async () => {
	for (const width of [0, -5, Number.NaN, 192.5, 1e9, 10_000, '32']) {
		await assert.rejects(() => extractImageThumb(PNG_1X1, width), isBoom400, `width ${String(width)}`)
	}
})

test('HB-487 addendum (control): extractImageThumb with a normal width still thumbnails', async () => {
	const { buffer, original } = await extractImageThumb(PNG_1X1, 32)
	assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0)
	assert.equal(original.width, 1)
	assert.equal(original.height, 1)
})
