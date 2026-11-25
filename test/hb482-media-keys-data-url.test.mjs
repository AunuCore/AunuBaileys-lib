// HB-482 (2.7.0): getMediaKeys only stripped the literal
// 'data:;base64,' prefix — a standard data:<mediatype>;base64, URL
// was base64-decoded whole (prefix included), deriving garbage
// keys that differ from the same key material sent bare.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { getMediaKeys } = await import(path.join(ROOT, 'lib/Utils/messages-media.js'))

const keyMaterial = Buffer.alloc(32, 7)
const b64 = keyMaterial.toString('base64')

const sameKeys = (a, b) => {
	assert.deepEqual(Buffer.from(a.iv), Buffer.from(b.iv))
	assert.deepEqual(Buffer.from(a.cipherKey), Buffer.from(b.cipherKey))
	assert.deepEqual(Buffer.from(a.macKey), Buffer.from(b.macKey))
}

test('HB-482: a data:<mediatype>;base64, media key derives the same keys as the bare base64 key', async () => {
	const bare = await getMediaKeys(b64, 'image')
	sameKeys(await getMediaKeys(`data:image/png;base64,${b64}`, 'image'), bare)
	sameKeys(await getMediaKeys(`data:application/octet-stream;base64,${b64}`, 'image'), bare)
})

test('HB-482 (control): the legacy data:;base64, form and a raw Buffer still derive the same keys', async () => {
	const bare = await getMediaKeys(b64, 'image')
	sameKeys(await getMediaKeys(`data:;base64,${b64}`, 'image'), bare)
	sameKeys(await getMediaKeys(keyMaterial, 'image'), bare)
})
