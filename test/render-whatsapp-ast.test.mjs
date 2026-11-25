// AunuBaileys 2.7.0 — D-1096-A: renderWhatsApp renders a formatted
// text AST to a WhatsApp string and collects mention JIDs.
import { test } from 'node:test'
import assert from 'node:assert'
import { renderWhatsApp } from '../lib/Utils/render-whatsapp.js'

const PEER = '628987654321@s.whatsapp.net'
const EXTRA = '628555000111@s.whatsapp.net'

test('renderWhatsApp: text nodes pass through and concatenate', () => {
	const { text, mentions } = renderWhatsApp([
		{ type: 'text', text: 'halo ' },
		{ type: 'text', text: 'dunia' }
	])
	assert.equal(text, 'halo dunia')
	assert.deepEqual(mentions, [])
})

test('renderWhatsApp: a single node (not an array) is accepted', () => {
	assert.equal(renderWhatsApp({ type: 'text', text: 'solo' }).text, 'solo')
})

test('renderWhatsApp: bold wraps in *, italic in _, code in backticks', () => {
	assert.equal(renderWhatsApp([{ type: 'bold', children: [{ type: 'text', text: 'tebal' }] }]).text, '*tebal*')
	assert.equal(renderWhatsApp([{ type: 'italic', children: [{ type: 'text', text: 'miring' }] }]).text, '_miring_')
	assert.equal(renderWhatsApp([{ type: 'code', text: 'x = 1' }]).text, '`x = 1`')
})

test('renderWhatsApp: formatting nests', () => {
	const { text } = renderWhatsApp([
		{
			type: 'bold',
			children: [
				{ type: 'text', text: 'a ' },
				{ type: 'italic', children: [{ type: 'text', text: 'b' }] }
			]
		}
	])
	assert.equal(text, '*a _b_*')
})

test('renderWhatsApp: edge whitespace moves outside the markers', () => {
	assert.equal(renderWhatsApp([{ type: 'bold', children: [{ type: 'text', text: '  tebal  ' }] }]).text, '  *tebal*  ')
	assert.equal(renderWhatsApp([{ type: 'italic', children: [{ type: 'text', text: ' miring' }] }]).text, ' _miring_')
	assert.equal(renderWhatsApp([{ type: 'code', text: ' x ' }]).text, ' `x` ')
})

test('renderWhatsApp: empty / whitespace-only content is returned unwrapped', () => {
	assert.equal(renderWhatsApp([{ type: 'bold', children: [{ type: 'text', text: '   ' }] }]).text, '   ')
	assert.equal(renderWhatsApp([{ type: 'bold', children: [] }]).text, '')
	assert.equal(renderWhatsApp([{ type: 'code', text: '' }]).text, '')
})

test('renderWhatsApp: link renders label (url), or the bare url when label equals url or is absent', () => {
	assert.equal(
		renderWhatsApp([{ type: 'link', url: 'https://example.com', label: 'Contoh' }]).text,
		'Contoh (https://example.com)'
	)
	assert.equal(renderWhatsApp([{ type: 'link', url: 'https://example.com', label: 'https://example.com' }]).text, 'https://example.com')
	assert.equal(renderWhatsApp([{ type: 'link', url: 'https://example.com' }]).text, 'https://example.com')
})

test('renderWhatsApp: mention renders @user and collects the JID once', () => {
	const { text, mentions } = renderWhatsApp([
		{ type: 'text', text: 'hai ' },
		{ type: 'mention', jid: PEER },
		{ type: 'text', text: ' dan ' },
		{ type: 'mention', jid: EXTRA },
		{ type: 'mention', jid: PEER }
	])
	assert.equal(text, 'hai @628987654321 dan @628555000111@628987654321')
	assert.deepEqual(mentions, [PEER, EXTRA])
})

test('renderWhatsApp: mention inside bold still collects the JID', () => {
	const { text, mentions } = renderWhatsApp([
		{ type: 'bold', children: [{ type: 'mention', jid: PEER }] }
	])
	assert.equal(text, '*@628987654321*')
	assert.deepEqual(mentions, [PEER])
})

test('renderWhatsApp: malformed nodes throw Boom 400', () => {
	assert.throws(() => renderWhatsApp([{ type: 'nope' }]), err => err?.output?.statusCode === 400)
	assert.throws(() => renderWhatsApp([{ type: 'mention', jid: 'bukan-jid' }]), err => err?.output?.statusCode === 400)
	assert.throws(() => renderWhatsApp([{ type: 'link', url: '' }]), err => err?.output?.statusCode === 400)
	assert.throws(() => renderWhatsApp([{ type: 'bold', children: 'x' }]), err => err?.output?.statusCode === 400)
	assert.throws(() => renderWhatsApp([null]), err => err?.output?.statusCode === 400)
})
