// 2.0.4 batch (run-0149/0150/0180): nine v6 hardening fixes that were
// missed by the v7 rebase, restored — HB-287, HB-288, HB-289, HB-290,
// HB-291, HB-292, HB-293, HB-294, HB-314. Patterns follow
// 10-socket-regressions (real socket + fake transport, TAG waiters)
// and the heartbeat harnesses that verified each finding empirically.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import Crypto from 'node:crypto'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js'

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

// Transport that is already closed: sendRawMessage throws
// Boom 'Connection Closed' (same stub as the HB-283 test in file 10).
const closedTransport = sock => {
	sock.ws.socket = {
		readyState: 3,
		once() {},
		on() {},
		send(_data, cb) {
			if (cb) cb()
		},
		close() {}
	}
}

const dirtyNode = (type, extraAttrs = {}) => ({
	tag: 'ib',
	attrs: {},
	content: [{ tag: 'dirty', attrs: { type, ...extraAttrs } }]
})

// ── HB-287 ──────────────────────────────────────────────────────────

test('HB-287: CB:ib,,dirty (groups) on a closed socket is caught and logged, never an unhandled rejection', async t => {
	const logger = recordingLogger()
	const sock = await makeOfflineSocket({ logger })
	t.after(() => endQuietly(sock))
	closedTransport(sock)
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,dirty', dirtyNode('groups'))
	const logged = await waitFor(
		() => logger.entries.some(e => e.level === 'error' && /dirty bits \(groups\)/.test(String(e.args[1] || ''))),
		3000
	)
	await sleep(300)
	assert.ok(logged, 'the failed dirty-groups sync was never routed to onUnexpectedError')
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})

test('HB-287: CB:ib,,dirty (communities) on a closed socket never escapes as an unhandled rejection', async t => {
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	closedTransport(sock)
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,dirty', dirtyNode('communities'))
	await sleep(800)
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})

test('HB-287: CB:ib,,dirty (account_sync) on a closed socket is caught and logged, never an unhandled rejection', async t => {
	const logger = recordingLogger()
	const sock = await makeOfflineSocket({ logger })
	t.after(() => endQuietly(sock))
	// the chats handler only awaits cleanDirtyBits when a previous
	// account-sync timestamp exists
	sock.authState.creds.lastAccountSyncTimestamp = 1700000000
	closedTransport(sock)
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,dirty', dirtyNode('account_sync', { timestamp: '1700000001' }))
	const logged = await waitFor(
		() => logger.entries.some(e => e.level === 'error' && /dirty bits \(chats\)/.test(String(e.args[1] || ''))),
		3000
	)
	await sleep(300)
	assert.ok(logged, 'the failed account_sync dirty-bits clean was never routed to onUnexpectedError')
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})

test('HB-287 (control): CB:ib,,dirty (groups) on a healthy transport still sends its sync query and stays handled', async t => {
	const logger = recordingLogger()
	const sock = await makeOfflineSocket({ logger })
	t.after(() => endQuietly(sock))
	const sent = []
	fakeOpenTransport(sock, sent)
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	sock.ws.emit('CB:ib,,dirty', dirtyNode('groups'))
	assert.ok(await waitFor(() => sent.length >= 1, 3000), 'groups sync query frame was never sent')
	// the query times out (defaultQueryTimeoutMs 800, no server) and the
	// fetch proceeds on an empty result — that failure must also stay
	// inside the handler's guard
	await sleep(1600)
	assert.deepEqual(unhandled.list.map(String), [], 'healthy-path failure escaped unhandled')
})

// ── HB-288 ──────────────────────────────────────────────────────────

const nextTagEvent = async (sock, seen, timeoutMs = 3000) => {
	const t0 = Date.now()
	for (;;) {
		const name = sock.ws.eventNames().find(n => typeof n === 'string' && n.startsWith('TAG:') && !seen.has(n))
		if (name) {
			seen.add(name)
			return name
		}
		if (Date.now() - t0 > timeoutMs) return null
		await sleep(25)
	}
}

const mexResult = resp => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [
		{
			tag: 'result',
			attrs: {},
			content: Buffer.from(JSON.stringify({ data: { xwa2_newsletter_create: resp } }))
		}
	]
})

const baseThread = picture => ({
	name: { text: 'Test Channel' },
	creation_time: '1700000000',
	description: { text: 'desc' },
	invite: 'invite-code',
	subscribers_count: '42',
	verification: 'VERIFIED',
	picture
})

const newsletterCreateCase = async (t, resp) => {
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => {
		WebSocketClient.prototype.connect = originalConnect
	})
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	const seen = new Set()
	const done = sock.newsletterCreate('Test Channel')
	const tag = await nextTagEvent(sock, seen)
	assert.ok(tag, 'newsletter MEX query was never issued')
	sock.ws.emit(tag, mexResult(resp))
	return Promise.race([done, sleep(3000).then(() => 'TIMEOUT')])
}

test('HB-288: newsletterCreate resolves when the created channel has no picture', async t => {
	const out = await newsletterCreateCase(t, {
		id: '123456789012345@newsletter',
		thread_metadata: baseThread(null),
		viewer_metadata: { mute: 'OFF' }
	})
	assert.notEqual(out, 'TIMEOUT')
	assert.equal(out.id, '123456789012345@newsletter')
	assert.equal(out.name, 'Test Channel')
	assert.equal(out.picture, undefined, 'missing picture must map to undefined, not throw')
	assert.equal(out.subscribers, 42)
})

test('HB-288: newsletterCreate resolves when the created channel has no description', async t => {
	const thread = baseThread({ id: 'pic1', direct_path: '/dp/1' })
	thread.description = null
	const out = await newsletterCreateCase(t, {
		id: '123456789012345@newsletter',
		thread_metadata: thread,
		viewer_metadata: { mute: 'OFF' }
	})
	assert.notEqual(out, 'TIMEOUT')
	assert.equal(out.description, undefined, 'missing description must map to undefined, not throw')
	assert.equal(out.picture?.id, 'pic1')
})

test('HB-288: newsletterCreate resolves when thread_metadata is null entirely', async t => {
	const out = await newsletterCreateCase(t, {
		id: '123456789012345@newsletter',
		thread_metadata: null,
		viewer_metadata: { mute: 'OFF' }
	})
	assert.notEqual(out, 'TIMEOUT')
	assert.equal(out.id, '123456789012345@newsletter')
	assert.equal(out.name, '')
	assert.equal(out.picture, undefined)
	assert.equal(out.subscribers, 0)
})

test('HB-288: newsletterCreate resolves when viewer_metadata is missing', async t => {
	const out = await newsletterCreateCase(t, {
		id: '123456789012345@newsletter',
		thread_metadata: baseThread({ id: 'pic1', direct_path: '/dp/1' })
	})
	assert.notEqual(out, 'TIMEOUT')
	assert.equal(out.mute_state, undefined)
	assert.equal(out.name, 'Test Channel')
})

test('HB-288 (control): newsletterCreate maps a complete create response', async t => {
	const out = await newsletterCreateCase(t, {
		id: '123456789012345@newsletter',
		thread_metadata: baseThread({ id: 'pic1', direct_path: '/dp/1' }),
		viewer_metadata: { mute: 'ON' }
	})
	assert.notEqual(out, 'TIMEOUT')
	assert.equal(out.name, 'Test Channel')
	assert.equal(out.description, 'desc')
	assert.equal(out.picture?.id, 'pic1')
	assert.equal(out.picture?.directPath, '/dp/1')
	assert.equal(out.creation_time, 1700000000)
	assert.equal(out.mute_state, 'ON')
})

// ── HB-289 / HB-290 ─────────────────────────────────────────────────

const mediaServer = async t => {
	const mediaKey = Crypto.randomBytes(32)
	const keys = await lib.getMediaKeys(mediaKey, 'image')
	const plaintext = Buffer.from('AunuBaileys 2.0.4 probe plaintext, exactly 48 bytes....')
	const cipher = Crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const mac = Crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	const validBody = Buffer.concat([ciphertext, mac])
	const server = http.createServer((req, res) => {
		if (req.url === '/empty') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' })
			res.end()
		} else if (req.url === '/valid') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(validBody.length) })
			res.end(validBody)
		} else if (req.url === '/abort') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
			res.write(validBody.subarray(0, 32))
			setTimeout(() => res.socket?.destroy(), 100)
		} else {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => server.close())
	return { keys, plaintext, base: `http://127.0.0.1:${server.address().port}` }
}

const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}

const withTimeout = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

test('HB-289 (control): a complete encrypted download decrypts and MAC-verifies', async t => {
	const { keys, plaintext, base } = await mediaServer(t)
	const out = await withTimeout(consume(await lib.downloadEncryptedContent(`${base}/valid`, keys)), 5000, 'valid')
	assert.ok(out.equals(plaintext), 'decrypted plaintext does not match')
})

test('HB-289: a CDN drop mid-download surfaces as a stream error — no hang, no uncaught exception', async t => {
	const { keys, base } = await mediaServer(t)
	const uncaught = []
	const onUncaught = e => {
		uncaught.push(e)
	}
	process.on('uncaughtException', onUncaught)
	t.after(() => process.off('uncaughtException', onUncaught))
	let error = null
	try {
		await withTimeout(consume(await lib.downloadEncryptedContent(`${base}/abort`, keys)), 5000, 'abort')
	} catch (e) {
		error = e
	}
	await sleep(300)
	assert.ok(error, 'mid-download drop produced no error at all (consumer would hang or silently succeed)')
	assert.ok(
		!/TIMEOUT/.test(String(error.message)),
		`consumer hung instead of receiving the source error: ${error.message}`
	)
	assert.ok(
		/terminated|aborted|socket hang up|ECONNRESET|fetch failed/i.test(String(error.message || error)),
		`expected the source stream error to reach the consumer, got: ${error}`
	)
	assert.deepEqual(uncaught.map(String), [], 'source error escaped as an uncaught exception')
})

test('HB-290: an empty download fails with Boom 502, not a bare TypeError', async t => {
	const { keys, base } = await mediaServer(t)
	let error = null
	try {
		await withTimeout(consume(await lib.downloadEncryptedContent(`${base}/empty`, keys)), 5000, 'empty')
	} catch (e) {
		error = e
	}
	assert.ok(error, 'empty download produced no error')
	assert.equal(error.isBoom, true, `expected a Boom, got ${error?.constructor?.name}: ${error?.message}`)
	assert.equal(error.output?.statusCode, 502)
})

// ── HB-291 ──────────────────────────────────────────────────────────

test('HB-291: decodeMediaRetryNode returns null for a receipt without an <rmr> child', () => {
	const node = { tag: 'message', attrs: { id: 'HB291A' }, content: [] }
	assert.equal(lib.decodeMediaRetryNode(node), null)
})

test('HB-291 (control): decodeMediaRetryNode still decodes a well-formed receipt', () => {
	const node = {
		tag: 'message',
		attrs: { id: 'HB291B' },
		content: [
			{ tag: 'rmr', attrs: { jid: '1234567890@s.whatsapp.net', from_me: 'true' } },
			{ tag: 'error', attrs: { code: '404' } }
		]
	}
	const event = lib.decodeMediaRetryNode(node)
	assert.ok(event)
	assert.equal(event.key.id, 'HB291B')
	assert.equal(event.key.remoteJid, '1234567890@s.whatsapp.net')
	assert.equal(event.key.fromMe, true)
	assert.ok(event.error, 'error child must surface as event.error')
})

test('HB-291: a mediaretry notification without <rmr> emits nothing and logs no unexpected error', async t => {
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
		attrs: { from: '1234567890@s.whatsapp.net', id: 'HB291C', t: '1700000000', type: 'mediaretry' },
		content: []
	})
	await sleep(800)
	assert.deepEqual(mediaUpdates, [], 'a media-update was emitted for an undecodable receipt')
	// the broken code throws inside decodeMediaRetryNode and the throw
	// lands in processNodeWithBuffer's onUnexpectedError route
	// ('handling notification'); the unrelated 'failed to ack
	// notification' entry is a fake-transport artifact (the ack query
	// is never answered) and is not asserted on
	assert.deepEqual(
		logger.entries
			.filter(e => e.level === 'error' && /unexpected error in 'handling notification'/.test(String(e.args[1] || '')))
			.map(String),
		[],
		'the malformed receipt was routed to onUnexpectedError instead of being skipped quietly'
	)
	assert.deepEqual(unhandled.list.map(String), [], 'handler rejection escaped unhandled')
})

// ── HB-292 ──────────────────────────────────────────────────────────

test('HB-292: getStream rejects a data URL without a comma with Boom 400', async () => {
	await assert.rejects(
		lib.getStream({ url: 'data:text/plain;base64' }),
		e => e?.isBoom === true && e?.output?.statusCode === 400,
		'malformed data URL must reject with Boom 400, not a raw TypeError'
	)
})

test('HB-292 (control): getStream still decodes a well-formed data URL', async () => {
	const { stream, type } = await lib.getStream({ url: 'data:text/plain;base64,QUJD' })
	assert.equal(type, 'buffer')
	const out = await consume(stream)
	assert.equal(out.toString(), 'ABC')
})

// ── HB-293 ──────────────────────────────────────────────────────────

test('HB-293: extensionForMediaMessage returns undefined instead of throwing on missing content', () => {
	const f = lib.extensionForMediaMessage
	assert.equal(f(null), undefined)
	assert.equal(f(undefined), undefined)
	assert.equal(f({}), undefined)
	assert.equal(f({ imageMessage: undefined }), undefined)
	assert.equal(f({ imageMessage: {} }), undefined)
	assert.equal(f({ conversation: 'hi' }), undefined)
	assert.equal(f({ imageMessage: { mimetype: 'image/jpeg' } }), 'jpeg')
	assert.equal(f({ locationMessage: {} }), '.jpeg')
})

// ── HB-294 ──────────────────────────────────────────────────────────

test('HB-294: updateMediaMessage arms a 120s timeout for the media-update wait', async t => {
	// stub out the WS connect (run-0147 harness pattern): with a live
	// connect attempt to the dead URL, the client tears the transport
	// down on failure and the wait settles via the close path for
	// harness reasons instead of library ones
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => {
		WebSocketClient.prototype.connect = originalConnect
	})
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: '1234567890@s.whatsapp.net', lid: '100000000000001@lid' }
	const sent = []
	fakeOpenTransport(sock, sent)
	const delays = []
	const originalSetTimeout = globalThis.setTimeout
	globalThis.setTimeout = (fn, ms, ...args) => {
		delays.push(ms)
		const timer = originalSetTimeout(fn, ms, ...args)
		timer.unref?.()
		return timer
	}
	t.after(() => {
		globalThis.setTimeout = originalSetTimeout
	})
	const msg = {
		key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: true, id: 'HB294A' },
		message: {
			imageMessage: {
				mediaKey: Buffer.alloc(32, 7),
				url: 'https://mmg.whatsapp.net/x',
				directPath: '/x',
				mimetype: 'image/jpeg'
			}
		}
	}
	let settled = null
	const pending = sock.updateMediaMessage(msg).then(
		() => {
			settled = 'resolved'
		},
		e => {
			settled = `rejected: ${e?.message}`
		}
	)
	assert.ok(await waitFor(() => sent.length >= 1, 3000), 'media-retry request frame was never sent')
	await sleep(500)
	globalThis.setTimeout = originalSetTimeout
	assert.ok(
		delays.includes(120_000),
		`no 120s timer was armed for the media-update wait (timers seen: ${[...new Set(delays)].join(', ') || 'none'}) — the wait is unbounded`
	)
	assert.equal(settled, null, 'the wait settled before any media-update arrived')
	// control: a connection close settles the wait via
	// bindWaitForEvent's closeListener, so nothing dangles past the
	// test (the transport is fake; the close is emitted on ev, which
	// is where the listener actually lives)
	sock.ev.emit('connection.update', { connection: 'close' })
	await Promise.race([pending, sleep(3000)])
	assert.notEqual(settled, null, 'a connection close did not settle the wait')
})

// ── HB-314 ──────────────────────────────────────────────────────────

const silentishLogger = () => {
	const logger = {
		level: 'silent',
		child() {
			return logger
		},
		trace() {},
		debug() {},
		info() {},
		warn() {},
		error() {},
		fatal() {}
	}
	return logger
}

const decryptRepo = {
	lidMapping: { getLIDForPN: async () => null, storeLIDPNMappings: async () => {} },
	migrateSession: async () => {},
	decryptGroupMessage: async () => {
		throw new Error('n/a')
	},
	decryptMessage: async () => {
		throw new Error('n/a')
	},
	processSenderKeyDistributionMessage: async () => {}
}

const ME_ID = '6280000000000@s.whatsapp.net'
const FROM_JID = '6281234567890@s.whatsapp.net'
const plainEncNode = {
	tag: 'enc',
	attrs: { type: 'plaintext' },
	content: lib.proto.Message.encode({ conversation: 'hello' }).finish()
}

const stanzaWith = children => ({
	tag: 'message',
	attrs: { id: 'HB314', from: FROM_JID, t: '1700000000', type: 'text', category: 'message' },
	content: children
})

const decryptWith = async children => {
	const { fullMessage, decrypt } = decryptMessageNode(stanzaWith(children), ME_ID, '', decryptRepo, silentishLogger())
	await decrypt()
	return fullMessage
}

const emptyCertNode = {
	tag: 'verified_name',
	attrs: {},
	content: Buffer.from(lib.proto.VerifiedNameCertificate.encode({}).finish())
}

test('HB-314: a verified-name certificate without details is ignored and the message still decrypts', async () => {
	for (const children of [
		[emptyCertNode, plainEncNode],
		[plainEncNode, emptyCertNode]
	]) {
		const fullMessage = await decryptWith(children)
		assert.equal(fullMessage.message?.conversation, 'hello')
		assert.equal(fullMessage.verifiedBizName, undefined)
	}
})

test('HB-314: a truncated verified-name certificate is ignored and the message still decrypts', async () => {
	const truncated = { tag: 'verified_name', attrs: {}, content: Buffer.from([0x0a, 0x05, 0x08, 0x01]) }
	const fullMessage = await decryptWith([truncated, plainEncNode])
	assert.equal(fullMessage.message?.conversation, 'hello')
	assert.equal(fullMessage.verifiedBizName, undefined)
})

test('HB-314 (control): a valid verified-name certificate still sets verifiedBizName', async () => {
	const goodCert = {
		tag: 'verified_name',
		attrs: {},
		content: Buffer.from(
			lib.proto.VerifiedNameCertificate.encode({
				details: lib.proto.VerifiedNameCertificate.Details.encode({ verifiedName: 'Acme Corp' }).finish()
			}).finish()
		)
	}
	const fullMessage = await decryptWith([goodCert, plainEncNode])
	assert.equal(fullMessage.message?.conversation, 'hello')
	assert.equal(fullMessage.verifiedBizName, 'Acme Corp')
	const bare = await decryptWith([plainEncNode])
	assert.equal(bare.message?.conversation, 'hello')
	assert.equal(bare.verifiedBizName, undefined)
})
