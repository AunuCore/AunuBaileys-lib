// (38) Batch 2.6.0 — Group A2 (media sweep) regressions:
// HB-2026-1112-32 addendum 2 (getStream data: URL: strict base64
// payload validation — Buffer.from is lenient and silently turns a
// corrupt payload into 0-byte media) + HB-2026-1112-42 addendum
// (decodeMediaRetryNode throws Boom 200 for <error code="1">,
// dropping the messages.media-update event). Fully offline &
// deterministic: crafted data URLs and binary nodes, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getStream, decodeMediaRetryNode } from '../lib/Utils/messages-media.js'
import { makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly } from './helpers.mjs'

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode

const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}

const collectUnhandled = () => {
	const list = []
	const fn = err => {
		list.push(err)
	}
	process.on('unhandledRejection', fn)
	return { list, stop: () => process.off('unhandledRejection', fn) }
}

const recordingLogger = () => {
	const entries = []
	const logger = {
		level: 'trace',
		entries,
		child() {
			return logger
		},
		trace() {},
		debug() {},
		info() {},
		warn(...args) {
			entries.push({ level: 'warn', args })
		},
		error(...args) {
			entries.push({ level: 'error', args })
		},
		fatal() {}
	}
	return logger
}

// ── HB-2026-1112-32 addendum 2 ──────────────────────────────────────

test('HB-2026-1112-32 addendum 2: getStream rejects a data: URL whose base64 payload has invalid characters', async () => {
	await assert.rejects(
		getStream({ url: 'data:image/png;base64,!!!' }),
		err => isBoom(err, 400),
		'non-base64 payload must be Boom 400, not 0-byte media'
	)
})

test('HB-2026-1112-32 addendum 2: getStream rejects a base64 payload whose length is not a multiple of 4', async () => {
	await assert.rejects(
		getStream({ url: 'data:image/png;base64,abc' }),
		err => isBoom(err, 400),
		'length-3 payload must be Boom 400, not silently truncated to 2 bytes'
	)
})

test('HB-2026-1112-32 addendum 2: getStream rejects an unpadded base64 payload', async () => {
	await assert.rejects(
		getStream({ url: 'data:text/plain;base64,aGk' }),
		err => isBoom(err, 400),
		'unpadded payload must be Boom 400, not decoded as "hi"'
	)
})

test('HB-2026-1112-32 addendum 2: getStream rejects padding in the middle of the payload', async () => {
	await assert.rejects(
		getStream({ url: 'data:text/plain;base64,aGk==x' }),
		err => isBoom(err, 400),
		'characters after padding must be Boom 400'
	)
})

test('HB-2026-1112-32 addendum 2: getStream rejects an empty base64 payload', async () => {
	await assert.rejects(
		getStream({ url: 'data:,' }),
		err => isBoom(err, 400),
		'empty payload must be Boom 400, not 0-byte media'
	)
})

test('HB-2026-1112-32 addendum 2 (control): getStream still decodes a valid padded payload', async () => {
	const { stream, type } = await getStream({ url: 'data:text/plain;base64,aGk=' })
	assert.equal(type, 'buffer')
	assert.equal((await consume(stream)).toString(), 'hi')
})

test('HB-2026-1112-32 addendum 2 (control): getStream still decodes a longer valid payload', async () => {
	const { stream } = await getStream({ url: 'data:text/plain;base64,aGVsbG8=' })
	assert.equal((await consume(stream)).toString(), 'hello')
})

test('HB-2026-1112-32 addendum 2 (control): getStream still decodes an uppercase DATA: URL', async () => {
	const { stream } = await getStream({ url: 'DATA:text/plain;base64,aGk=' })
	assert.equal((await consume(stream)).toString(), 'hi')
})

test('HB-2026-1112-32 addendum 2 (control): getStream still rejects a data: URL without a comma', async () => {
	await assert.rejects(
		getStream({ url: 'data:text/plain;base64' }),
		err => isBoom(err, 400)
	)
})

// ── HB-2026-1112-42 addendum ────────────────────────────────────────

const mediaRetryNode = (id, code) => ({
	tag: 'notification',
	attrs: { id, type: 'mediaretry' },
	content: [
		{ tag: 'rmr', attrs: { jid: '1234567890@s.whatsapp.net', from_me: 'true' } },
		...(code === undefined ? [{ tag: 'error', attrs: {} }] : [{ tag: 'error', attrs: { code } }])
	]
})

test('HB-2026-1112-42 addendum: decodeMediaRetryNode does not throw for <error code="1"> (SUCCESS)', () => {
	const event = decodeMediaRetryNode(mediaRetryNode('HB42A', '1'))
	assert.ok(event, 'no event returned for a SUCCESS error node')
	assert.equal(event.key.id, 'HB42A')
	assert.equal(event.key.remoteJid, '1234567890@s.whatsapp.net')
	assert.equal(event.key.fromMe, true)
	assert.equal(event.error, undefined, 'SUCCESS must not surface as a Boom error')
})

test('HB-2026-1112-42 addendum (control): decodeMediaRetryNode still maps code 0 to Boom 418', () => {
	const event = decodeMediaRetryNode(mediaRetryNode('HB42B', '0'))
	assert.ok(event?.error?.isBoom)
	assert.equal(event.error.output.statusCode, 418)
})

test('HB-2026-1112-42 addendum (control): decodeMediaRetryNode still maps code 2 to Boom 404', () => {
	const event = decodeMediaRetryNode(mediaRetryNode('HB42C', '2'))
	assert.ok(event?.error?.isBoom)
	assert.equal(event.error.output.statusCode, 404)
})

test('HB-2026-1112-42 addendum (control): decodeMediaRetryNode still maps code 3 to Boom 412', () => {
	const event = decodeMediaRetryNode(mediaRetryNode('HB42D', '3'))
	assert.ok(event?.error?.isBoom)
	assert.equal(event.error.output.statusCode, 412)
})

test('HB-2026-1112-42 addendum (control): decodeMediaRetryNode still maps a missing code to Boom 500', () => {
	const event = decodeMediaRetryNode(mediaRetryNode('HB42E', undefined))
	assert.ok(event?.error?.isBoom)
	assert.equal(event.error.output.statusCode, 500)
})

test('HB-2026-1112-42 addendum: a mediaretry notification with <error code="1"> still emits messages.media-update', async t => {
	const logger = recordingLogger()
	const sock = await makeOfflineSocket({ logger })
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	const mediaUpdates = []
	sock.ev.on('messages.media-update', ev => mediaUpdates.push(ev))
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:notification', {
		tag: 'notification',
		attrs: { from: '1234567890@s.whatsapp.net', id: 'HB42F', t: '1700000000', type: 'mediaretry' },
		content: [
			{ tag: 'rmr', attrs: { jid: '1234567890@s.whatsapp.net', from_me: 'true' } },
			{ tag: 'error', attrs: { code: '1' } }
		]
	})
	const emitted = await waitFor(() => mediaUpdates.length > 0, 3000)
	await sleep(300)
	assert.ok(emitted, 'no messages.media-update was emitted for <error code="1">')
	assert.equal(mediaUpdates[0][0].key.id, 'HB42F')
	assert.equal(mediaUpdates[0][0].error, undefined, 'the emitted update must carry no Boom error')
	// the broken code throws inside decodeMediaRetryNode and the throw
	// lands in processNodeWithBuffer's onUnexpectedError route
	// ('handling notification')
	assert.deepEqual(
		logger.entries
			.filter(e => e.level === 'error' && /unexpected error in 'handling notification'/.test(String(e.args[1] || '')))
			.map(String),
		[],
		'the SUCCESS error node was routed to onUnexpectedError instead of emitting media-update'
	)
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})
