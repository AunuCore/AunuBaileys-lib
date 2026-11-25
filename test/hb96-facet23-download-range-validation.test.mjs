// HB-2026-1112-96 facet 2 + facet 3 (2.7.0): downloadEncryptedContent
// silently accepted a negative or NaN endByte (and a string 'abc'):
// no Range header, the 206 validation skipped, a 0-byte download
// resolved as success. Both bounds are now validated -> Boom 400
// before any fetch (the URL below is a dead local port; reaching
// the network at all would fail the Boom 400 expectation).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { downloadEncryptedContent } = await import(path.join(ROOT, 'lib/Utils/messages-media.js'))

const isBoom400 = err => !!err?.isBoom && err.output?.statusCode === 400
const keys = { cipherKey: Buffer.alloc(32, 1), iv: Buffer.alloc(16, 2), macKey: Buffer.alloc(32, 3) }
const DEAD_URL = 'http://127.0.0.1:9/media'

test('HB-96 facet 2: a negative endByte is rejected with Boom 400', async () => {
	await assert.rejects(() => downloadEncryptedContent(DEAD_URL, keys, { endByte: -5 }), isBoom400)
})

test('HB-96 facet 3: a NaN endByte is rejected with Boom 400 (NaN < 0 is false)', async () => {
	await assert.rejects(() => downloadEncryptedContent(DEAD_URL, keys, { endByte: Number.NaN }), isBoom400)
})

test("HB-96 facet 3 (expanded): a string endByte 'abc' is rejected with Boom 400", async () => {
	await assert.rejects(() => downloadEncryptedContent(DEAD_URL, keys, { endByte: 'abc' }), isBoom400)
})

test('HB-96 facets 2+3: invalid startByte and reversed ranges are rejected with Boom 400', async () => {
	await assert.rejects(() => downloadEncryptedContent(DEAD_URL, keys, { startByte: -1 }), isBoom400)
	await assert.rejects(() => downloadEncryptedContent(DEAD_URL, keys, { startByte: Number.NaN }), isBoom400)
	await assert.rejects(
		() => downloadEncryptedContent(DEAD_URL, keys, { startByte: 100, endByte: 50 }),
		isBoom400
	)
})
