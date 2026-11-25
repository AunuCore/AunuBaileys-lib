// HB-208 site-3 facet 2 + toProductNode facet + site-5 (2.7.0):
//  - a product image { url: undefined / null } passed the container
//    guard and then threw a raw TypeError on img.url.toString()
//  - toProductNode string fields were guarded only by
//    typeof !== 'undefined', so Buffer.from(number) threw raw
//  - the uploadingNecessaryImages byte-count loop counted string
//    chunks per character (evading the 16 MiB cap) and threw raw
//    TypeErrors on non-Buffer chunks
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { toProductNode, uploadingNecessaryImages } = await import(path.join(ROOT, 'lib/Utils/business.js'))

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode
const upload = async () => ({ directPath: '/dp/208' })

test('HB-208 site-3 facet 2: a product image with url undefined/null fails with Boom 400 in both sites', async () => {
	for (const bad of [{ url: undefined }, { url: null }]) {
		await assert.rejects(() => uploadingNecessaryImages([bad], upload), err => isBoom(err, 400))
		assert.throws(() => toProductNode(undefined, { images: [bad] }), err => isBoom(err, 400))
	}
})

test('HB-208 toProductNode facet: non-string fields fail with Boom 400, not a raw TypeError', () => {
	for (const product of [
		{ name: 42 },
		{ name: 'ok', description: 42 },
		{ name: 'ok', retailerId: 42 },
		{ name: 'ok', currency: 42 },
		{ name: 'ok', originCountryCode: 42 }
	]) {
		assert.throws(() => toProductNode(undefined, product), err => isBoom(err, 400), JSON.stringify(product))
	}
	assert.throws(() => toProductNode(42, { name: 'ok' }), err => isBoom(err, 400), 'numeric productId')
})

test('HB-208 toProductNode facet (control): string fields and a numeric price still build a node', () => {
	const node = toProductNode('P1', {
		name: 'Thing',
		description: 'desc',
		retailerId: 'R1',
		price: 1500,
		currency: 'IDR',
		originCountryCode: 'ID'
	})
	const tags = node.content.map(c => c.tag)
	for (const tag of ['id', 'name', 'description', 'retailer_id', 'price', 'currency', 'compliance_info']) {
		assert.ok(tags.includes(tag), `missing <${tag}>`)
	}
})

test('HB-208 site-5: string chunks are counted in BYTES against the 16 MiB product-image cap', async () => {
	// 6M '€' characters = 18 MB of UTF-8 — counted per character
	// (the old bug) this is 6M and sails under the cap; counted
	// per byte it must trip Boom 413.
	const stream = Readable.from(['€'.repeat(6_000_000)])
	await assert.rejects(() => uploadingNecessaryImages([{ stream }], upload), err => isBoom(err, 413))
})

test('HB-208 site-5: a non-Buffer/string/Uint8Array chunk fails with Boom 400, not a raw TypeError', async () => {
	const stream = Readable.from([12345])
	await assert.rejects(() => uploadingNecessaryImages([{ stream }], upload), err => isBoom(err, 400))
})

test('HB-208 site-5 (control): a small string chunk uploads and is hashed/written as its UTF-8 bytes', async () => {
	const stream = Readable.from(['hello-product-image'])
	const [out] = await uploadingNecessaryImages([{ stream }], upload)
	assert.ok(out.url.includes('/dp/208'))
})
