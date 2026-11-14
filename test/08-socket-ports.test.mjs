// (j) P2e/P2f ports through a REAL constructed socket with a fake
// open transport: newsletter.status emit + ack despite a throwing
// listener; 405 -> clientTooOld emitted BEFORE end(); sticker-pack
// proto round-trip. Plus HB-276 (waiter fail-fast on end), HB-280
// (send on a dead client calls back at once), HB-139/174 (numeric
// config sanitisation at construction).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

test('(j) newsletter.status: event is emitted AND acked even when a listener throws', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	const sent = []
	fakeOpenTransport(sock, sent)
	let got = null
	sock.ev.on('newsletter.status', p => { got = p })
	sock.ev.on('newsletter.status', () => { throw new Error('host listener bug') })
	const plaintext = Buffer.from(
		lib.proto.Message.encode(lib.proto.Message.create({ conversation: 'halo' })).finish()
	)
	sock.ws.emit('CB:status', {
		tag: 'status',
		attrs: { id: '111', from: '123@newsletter', type: 'text', t: '1700000000' },
		content: [{ tag: 'plaintext', attrs: {}, content: plaintext }]
	})
	assert.ok(await waitFor(() => got), 'newsletter.status listener never received the event')
	assert.equal(got.id, '123@newsletter')
	assert.equal(got.content?.message?.conversation, 'halo')
	assert.ok(await waitFor(() => sent.length > 0), 'ack frame was never sent')
})

test('(j) 405: clientTooOld signal is emitted BEFORE the connection closes (fetch stubbed)', async t => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, text: async () => '{"client_revision": 424242}' })
	t.after(() => { globalThis.fetch = originalFetch })
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	const order = []
	sock.ev.on('connection.update', u => {
		if (u.clientTooOld) order.push('clientTooOld')
		if (u.connection === 'close') order.push('close')
	})
	sock.ws.emit('CB:stream:error', {
		tag: 'stream:error', attrs: { code: '405' },
		content: [{ tag: 'conflict', attrs: {} }]
	})
	assert.ok(await waitFor(() => order.includes('clientTooOld')), 'clientTooOld never emitted')
	assert.ok(await waitFor(() => order.includes('close')), 'connection never closed')
	assert.ok(
		order.indexOf('clientTooOld') < order.indexOf('close'),
		`clientTooOld must precede close, order was ${order}`
	)
})

test('(j) sticker-pack: prepareStickerPackMessage output survives a proto round-trip', async () => {
	const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')
	const { silentLogger } = await import('./helpers.mjs')
	const out = await lib.prepareStickerPackMessage(
		{ name: 'Pack P8', publisher: 'p8', stickers: [{ data: webp }], cover: webp },
		{ logger: silentLogger, upload: async () => ({ directPath: '/sticker-pack/abc' }) }
	)
	const bytes = lib.proto.Message.encode(
		lib.proto.Message.create({ stickerPackMessage: out.stickerPackMessage })
	).finish()
	const back = lib.proto.Message.decode(bytes)
	assert.equal(back.stickerPackMessage.name, 'Pack P8')
	assert.equal(back.stickerPackMessage.stickers.length, 1)
	assert.equal(back.stickerPackMessage.directPath, '/sticker-pack/abc')
	// invalid packs fail with a Boom 400, not a bare TypeError
	await assert.rejects(
		lib.prepareStickerPackMessage({ stickers: [] }, { logger: silentLogger, upload: async () => ({}) }),
		err => err.output?.statusCode === 400
	)
})

test('HB-42/64: CB:failure with a non-numeric reason is sanitised to Boom 500, never throws in the handler', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	let closeUpdate = null
	sock.ev.on('connection.update', u => { if (u.connection === 'close') closeUpdate = u })
	sock.ws.emit('CB:failure', { tag: 'failure', attrs: { reason: 'not-a-number' }, content: [] })
	assert.ok(await waitFor(() => closeUpdate), 'connection never closed after CB:failure')
	const code = closeUpdate.lastDisconnect?.error?.output?.statusCode
	assert.equal(code, 500, `expected sanitised 500, got ${code}`)
})

test('HB-276: end() fail-fasts a pending waitForMessage with 428 instead of the full timeout', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	const t0 = Date.now()
	let settled = null
	const pending = sock.waitForMessage('never-arrives', 30_000)
		.then(() => { settled = 'resolved' })
		.catch(err => { settled = err })
	setTimeout(() => endQuietly(sock), 300)
	await Promise.race([pending, new Promise(r => setTimeout(r, 5000))])
	const elapsed = Date.now() - t0
	assert.ok(settled && settled !== 'resolved', `waiter did not reject: ${settled}`)
	assert.ok(elapsed < 5000, `waiter took ${elapsed}ms — not fail-fast`)
	const code = settled.output?.statusCode
	assert.ok(code === 428 || /Connection Closed/i.test(settled.message), `unexpected rejection: ${settled.message} (${code})`)
})

test('HB-280: WebSocketClient.send on a dead socket calls the callback back at once', async () => {
	const client = new WebSocketClient('ws://127.0.0.1:9/ws/chat', {})
	// never connect()ed: the underlying socket is null; send() calls
	// the callback back synchronously with an error (HB-280).
	let callbackErr = 'callback never fired'
	const ret = client.send('frame', err => { callbackErr = err })
	assert.equal(ret, false)
	assert.ok(callbackErr instanceof Error && /Connection Closed/.test(callbackErr.message))
})

test('HB-139/174: garbage numeric config is sanitised at construction, never reaches the socket raw', async t => {
	const sock = await makeOfflineSocket({
		connectTimeoutMs: 'lima',
		defaultQueryTimeoutMs: -5,
		keepAliveIntervalMs: NaN,
		maxMsgRetryCount: 'banyak',
		qrTimeout: 'kapan-kapan'
	})
	t.after(() => endQuietly(sock))
	// the sanitised config is the one handed to the WS client
	const config = sock.ws.config
	for (const key of ['connectTimeoutMs', 'defaultQueryTimeoutMs', 'keepAliveIntervalMs']) {
		const v = config[key]
		assert.ok(typeof v === 'number' && Number.isFinite(v) && v > 0, `${key} = ${v}`)
	}
	assert.ok(
		config.qrTimeout === undefined ||
		(typeof config.qrTimeout === 'number' && Number.isFinite(config.qrTimeout) && config.qrTimeout > 0),
		`qrTimeout = ${config.qrTimeout}`
	)
})
