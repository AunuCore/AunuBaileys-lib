// HB-476 addendum facet 1 (2.7.0): the non-<enc> CB:status branch
// (newsletter status) must pass through the same ignore gates as
// processNode. Pre-fix it called handleNewsletterStatus directly, so
// a status from an ignored channel still emitted 'newsletter.status'.
// The dropped stanza must still be acked. Fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeOfflineSocket, fakeOpenTransport, sleep, endQuietly } from './helpers.mjs'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const CHANNEL = '120363333911663927@newsletter'
const OTHER_CHANNEL = '120363000000000009@newsletter'

const decodeSentFrames = async sent => {
	const nodes = []
	for (const buf of sent) {
		let off = 0
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		nodes.push(await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len)))
	}
	return nodes
}

const statusStanza = (from, id) => ({
	tag: 'status',
	attrs: { id, from, type: 'text', t: String(Math.floor(Date.now() / 1000)) },
	content: [{ tag: 'plaintext', attrs: {}, content: Buffer.from('AAAA') }]
})

const setup = async t => {
	const sock = await makeOfflineSocket({ shouldIgnoreJid: jid => jid === CHANNEL })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME }
	const sent = []
	fakeOpenTransport(sock, sent)
	const events = []
	sock.ev.on('event', map => {
		if (map['newsletter.status']) events.push(map['newsletter.status'])
	})
	return { sock, sent, events }
}

test('HB-476 f1: newsletter status from an ignored channel emits NO event but is acked', async t => {
	const { sock, sent, events } = await setup(t)
	sock.ws.emit('CB:status', statusStanza(CHANNEL, 'HB476-IGN'))
	await sleep(1000)
	assert.equal(events.length, 0, 'ignored channel status must not emit newsletter.status')
	const nodes = await decodeSentFrames(sent)
	assert.ok(
		nodes.some(n => n.tag === 'ack' && n.attrs.id === 'HB476-IGN'),
		'the dropped stanza is still acked so the server stops redelivering it'
	)
})

test('HB-476 f1 control: newsletter status from a non-ignored channel still emits', async t => {
	const { sock, events } = await setup(t)
	sock.ws.emit('CB:status', statusStanza(OTHER_CHANNEL, 'HB476-OK'))
	await sleep(1000)
	assert.equal(events.length, 1, 'the live path still emits for non-ignored channels')
})
