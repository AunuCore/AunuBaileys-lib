// HB-435 facet 1 (2.7.0): getOrderDetails forwarded an undefined
// query() result (IQ timeout) into parseOrderDetailsNode, which
// fabricated { price: { total: NaN, currency: undefined },
// products: [] }. A missing response node is now Boom 408.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { parseOrderDetailsNode } = await import(path.join(ROOT, 'lib/Utils/business.js'))

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode

test('HB-435 facet 1: parseOrderDetailsNode(undefined) throws Boom 408 instead of fabricating NaN totals', () => {
	assert.throws(() => parseOrderDetailsNode(undefined), err => isBoom(err, 408))
	assert.throws(() => parseOrderDetailsNode(null), err => isBoom(err, 408))
})

test('HB-435 facet 1 (control): a real order node still parses', () => {
	const leaf = (tag, text) => ({ tag, attrs: {}, content: Buffer.from(text) })
	const node = {
		tag: 'iq',
		attrs: {},
		content: [
			{
				tag: 'order',
				attrs: {},
				content: [
					{
						tag: 'product',
						attrs: {},
						content: [
							leaf('id', 'P1'),
							leaf('name', 'Thing'),
							{ tag: 'image', attrs: {}, content: [leaf('url', 'https://mmg.whatsapp.net/x')] },
							leaf('price', '1500'),
							leaf('currency', 'IDR'),
							leaf('quantity', '2')
						]
					},
					{ tag: 'price', attrs: {}, content: [leaf('total', '3000'), leaf('currency', 'IDR')] }
				]
			}
		]
	}
	const details = parseOrderDetailsNode(node)
	assert.equal(details.price.total, 3000)
	assert.equal(details.price.currency, 'IDR')
	assert.equal(details.products.length, 1)
	assert.equal(details.products[0].id, 'P1')
})
