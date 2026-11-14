// HB-283 / HB-284 / HB-285 (run-0147): three v6 hardening fixes that
// were missed by the v7 rebase, restored in 2.0.2. All scenarios run
// through a REAL constructed socket with a fake transport — the same
// pattern as 08-socket-ports — plus a unit pass over the one function
// that is part of the public export surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Boom } from '@hapi/boom'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

const collectUnhandled = () => {
	const list = []
	const fn = err => { list.push(err) }
	process.on('unhandledRejection', fn)
	return { list, stop: () => process.off('unhandledRejection', fn) }
}

const recordingLogger = () => {
	const entries = []
	const logger = {
		level: 'trace',
		entries,
		child() { return logger },
		trace() {}, debug() {}, info() {},
		warn(...args) { entries.push({ level: 'warn', args }) },
		error(...args) { entries.push({ level: 'error', args }) },
		fatal() {}
	}
	return logger
}

// ── HB-283 ──────────────────────────────────────────────────────────

test('HB-283: CB:ib,,offline_preview on a closed socket is caught and logged, never an unhandled rejection', async t => {
	const logger = recordingLogger()
	const sock = await makeOfflineSocket({ logger })
	t.after(() => endQuietly(sock))
	// transport already closed: sendRawMessage throws Boom 'Connection Closed'
	sock.ws.socket = {
		readyState: 3,
		once() {},
		on() {},
		send(_data, cb) { if (cb) cb() },
		close() {}
	}
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,offline_preview', { tag: 'ib', attrs: {}, content: [] })
	const logged = await waitFor(
		() => logger.entries.some(e => e.level === 'error' && /offline batch/.test(String(e.args[1] || ''))),
		3000
	)
	await sleep(300)
	assert.ok(logged, 'the failed offline-batch send was never logged')
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})

test('HB-283 (control): CB:ib,,offline_preview on a healthy socket still sends the offline_batch request', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	const sent = []
	fakeOpenTransport(sock, sent)
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,offline_preview', { tag: 'ib', attrs: {}, content: [] })
	assert.ok(await waitFor(() => sent.length >= 1, 3000), 'offline_batch frame was never sent')
	await sleep(200)
	assert.deepEqual(unhandled.list.map(String), [], 'healthy path produced an unhandled rejection')
})

// ── HB-284 ──────────────────────────────────────────────────────────

const nextTagEvent = async (sock, seen, timeoutMs = 3000) => {
	const t0 = Date.now()
	for (;;) {
		const name = sock.ws.eventNames()
			.find(n => typeof n === 'string' && n.startsWith('TAG:') && !seen.has(n))
		if (name) {
			seen.add(name)
			return name
		}
		if (Date.now() - t0 > timeoutMs) return null
		await sleep(25)
	}
}

// Answer the pre-key count query with `countContent`, then watch
// whether the initial upload IQ follows. Fixed behaviour: a malformed
// count reads as 0, which triggers INITIAL_PREKEY_COUNT upload. Broken
// behaviour: NaN/TypeError is swallowed and no upload frame ever goes
// out. The WS connect is stubbed out (the run-0147 harness pattern):
// with a live connect attempt to the dead URL, the client tears the
// transport down on failure long before the 812-key generation inside
// the upload finishes, and every send starts failing 'Connection
// Closed' for harness reasons instead of library ones.
const preKeyScenario = async (t, countContent) => {
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => { WebSocketClient.prototype.connect = originalConnect })
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	const sent = []
	fakeOpenTransport(sock, sent)
	const seen = new Set()
	const done = sock.uploadPreKeysToServerIfRequired()
	const tag1 = await nextTagEvent(sock, seen)
	assert.ok(tag1, 'pre-key count query was never issued')
	sock.ws.emit(tag1, { tag: 'iq', attrs: { type: 'result' }, content: countContent })
	const uploaded = await waitFor(() => sent.length >= 2, 3000)
	const tag2 = await nextTagEvent(sock, seen, 1000)
	if (tag2) {
		sock.ws.emit(tag2, { tag: 'iq', attrs: { type: 'result' }, content: [] })
	}
	await Promise.race([done, sleep(3000)])
	return uploaded
}

test('HB-284: a <count> without a value attr reads as 0 and triggers the initial pre-key upload', async t => {
	const uploaded = await preKeyScenario(t, [{ tag: 'count', attrs: {} }])
	assert.equal(uploaded, true, 'malformed count silently skipped the pre-key upload')
})

test('HB-284: a result with no <count> child at all reads as 0 and triggers the initial pre-key upload', async t => {
	const uploaded = await preKeyScenario(t, [])
	assert.equal(uploaded, true, 'missing count child silently skipped the pre-key upload')
})

// ── HB-285 ──────────────────────────────────────────────────────────

test('HB-285: getErrorCodeFromStreamError always returns an integer status code in 400-599', () => {
	assert.equal(typeof lib.getErrorCodeFromStreamError, 'function')
	const f = lib.getErrorCodeFromStreamError
	const node = (attrs, content = []) => ({ tag: 'stream:error', attrs, content })
	assert.equal(f(node({ code: 'abc' })).statusCode, 500, 'non-numeric code must fall back to badSession (500)')
	assert.equal(f(node({ code: '302' })).statusCode, 500, 'sub-400 code must fall back to badSession (500)')
	assert.equal(f(node({ code: '999' })).statusCode, 500, 'out-of-range code must fall back to badSession (500)')
	assert.equal(f(node({ code: '500' })).statusCode, 500)
	assert.equal(f(node({ code: '405' })).statusCode, 405, 'valid codes pass through untouched')
	const conflict = f(node({}, [{ tag: 'conflict', attrs: {} }]))
	assert.equal(conflict.statusCode, 440, 'CODE_MAP reason mapping must survive sanitisation')
	assert.equal(conflict.reason, 'conflict')
	assert.equal(f(node({})).statusCode, 500)
	for (const attrs of [{ code: 'abc' }, { code: '302' }, { code: '500' }, { code: '405' }, {}]) {
		const { statusCode } = f(node(attrs))
		assert.ok(Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599, `statusCode ${statusCode} is not Boom-safe`)
		assert.doesNotThrow(() => new Boom('stream error', { statusCode }))
	}
})

const streamErrorScenario = async (t, code) => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	let closeUpdate = null
	sock.ev.on('connection.update', u => { if (u.connection === 'close') closeUpdate = u })
	sock.ws.emit('CB:stream:error', { tag: 'stream:error', attrs: { code }, content: [] })
	const closed = await waitFor(() => closeUpdate, 3000)
	await sleep(200)
	return { closed, closeUpdate, unhandled: unhandled.list }
}

test('HB-285: CB:stream:error with a non-numeric code closes with Boom 500 instead of throwing in the handler', async t => {
	const { closed, closeUpdate, unhandled } = await streamErrorScenario(t, 'abc')
	assert.ok(closed, 'connection never closed after CB:stream:error — the handler threw')
	assert.equal(closeUpdate.lastDisconnect?.error?.output?.statusCode, 500)
	assert.deepEqual(unhandled.map(String), [], 'handler rejection escaped unhandled')
})

test('HB-285: CB:stream:error with a sub-400 code closes with Boom 500 instead of throwing in the handler', async t => {
	const { closed, closeUpdate, unhandled } = await streamErrorScenario(t, '302')
	assert.ok(closed, 'connection never closed after CB:stream:error — the handler threw')
	assert.equal(closeUpdate.lastDisconnect?.error?.output?.statusCode, 500)
	assert.deepEqual(unhandled.map(String), [], 'handler rejection escaped unhandled')
})
