// AunuBaileys 2.5.0 batch regressions — cluster A (socket/connection):
// HB-413, HB-414, HB-419, HB-422, HB-428 (+ facets 2 & 3), HB-444,
// HB-450, HB-455, HB-262 addendum, HB-238 addendum, HB-239 addenda 3+4,
// HB-2026-1112-80 addendum; sweeps: HB-268 addendum, HB-2026-1114-243
// addendum. Each test names the HB item it locks in and fails without
// its fix. Everything runs offline against the built lib/: the WS
// connect is stubbed out and transports are fakes, so no test touches WA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, makeAuthState, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, waitFor, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { configureSuccessfulPairing, generateRegistrationNode } from '../lib/Utils/validate-connection.js'
import { extractDeviceJids } from '../lib/Utils/signal.js'
import { fetchLatestBaileysVersion } from '../lib/Utils/generics.js'
import { makeNoiseHandler } from '../lib/Utils/noise-handler.js'
import { attachAunuAutoJoin } from '../lib/Utils/aunu-autojoin.js'
import { Curve, hmacSign } from '../lib/Utils/crypto.js'
import { WA_ADV_ACCOUNT_SIG_PREFIX } from '../lib/Defaults/index.js'
import { WAJIDDomains } from '../lib/WABinary/jid-utils.js'
import { waproto } from '../WAProto/index.js'

// No real connection attempts anywhere in this file: construction
// must never race a dead-port error into end() mid-test.
WebSocketClient.prototype.connect = () => {}

const successNode = { tag: 'success', attrs: {}, content: [] }

const pairDevice = (id, refs) => ({
	tag: 'iq',
	attrs: { id, type: 'set', xmlns: 'md' },
	content: [
		{
			tag: 'pair-device',
			attrs: {},
			content: refs.map(r => ({ tag: 'ref', attrs: {}, content: Buffer.from(r) }))
		}
	]
})

// Fake transport whose close handshake takes `closeMs` — this is what
// lets end() suspend at `await ws.close()` while queued work drains.
const makeDelayedFake = closeMs => {
	const fake = {
		readyState: 1,
		_closeFn: null,
		_closeTimer: null,
		once(ev, fn) { if (ev === 'close') this._closeFn = fn },
		on() {},
		send(_data, cb) { if (cb) cb() },
		close() {
			this.readyState = 2
			this._closeTimer = setTimeout(() => {
				this.readyState = 3
				if (this._closeFn) this._closeFn()
			}, closeMs)
		},
		terminate() {
			if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
			this.readyState = 3
			if (this._closeFn) this._closeFn()
		}
	}
	return fake
}

const waitForClose = async (events, timeoutMs = 6000) => {
	const tStart = Date.now()
	while (Date.now() - tStart < timeoutMs) {
		if (events.some(e => e.connection === 'close')) return true
		await sleep(25)
	}
	return false
}

// Answer every pending TAG: waiter with a result IQ that carries a
// <count> child but NO <digest> child — the digest query then takes
// the no-digest branch (HB-455 site).
const answerAllCountOnly = sock => {
	const seen = new Set()
	const timer = setInterval(() => {
		for (const name of sock.ws.eventNames()) {
			if (typeof name === 'string' && name.startsWith('TAG:') && !seen.has(name)) {
				seen.add(name)
				const id = name.slice(4)
				sock.ws.emit(name, {
					tag: 'iq',
					attrs: { id, type: 'result' },
					content: [{ tag: 'count', attrs: { value: '100' } }]
				})
			}
		}
	}, 5)
	return () => clearInterval(timer)
}

const makeCapturingLogger = () => {
	const warns = []
	const logger = {
		level: 'silent',
		child: () => logger,
		info: () => {},
		warn: (obj, msg) => { warns.push({ obj, msg }) },
		error: () => {},
		debug: () => {},
		trace: () => {}
	}
	return { logger, warns }
}

test('HB-413: no phantom connection.update connecting after a same-tick end()', async () => {
	// The auth state is awaited FIRST so the nextTick is scheduled
	// inside the synchronous makeWASocket call below — end() must
	// land in the same tick, before the nextTick queue drains.
	const a = await makeAuthState()
	a.state.creds.me = { id: '6281234567890@s.whatsapp.net', name: 't' }
	const sock = lib.makeWASocket({
		auth: a.state,
		logger: silentLogger,
		waWebSocketUrl: 'ws://127.0.0.1:9/ws/chat',
		connectTimeoutMs: 800,
		defaultQueryTimeoutMs: 800,
		banSentinel: false,
		browser: ['aunu-p8', 'test', '1']
	})
	const seen = []
	sock.ev.on('connection.update', u => seen.push(u.connection ?? Object.keys(u).join('+')))
	// A delayed fake transport is REQUIRED here: with the stubbed
	// connect the real client has no socket at all, so end() runs
	// fully synchronous (isClosed is true, no await ws.close()) and
	// removes the connection.update listeners + destroys ev BEFORE
	// the nextTick queue drains — the phantom emit then has no
	// audience and the bug is masked. The delayed close makes end()
	// suspend at `await ws.close()`, so the nextTick callback fires
	// into live listeners, exactly like the real dead-peer path.
	sock.ws.socket = makeDelayedFake(150)
	void sock.end() // synchronous same-tick teardown; nextTick not yet fired
	await sleep(300)
	assert.ok(!seen.includes('connecting'), `phantom 'connecting' emitted after end(): ${JSON.stringify(seen)}`)
	assert.ok(seen.includes('close'), `expected a 'close' update, got ${JSON.stringify(seen)}`)
})

test('HB-419: CB:success clears the QR timer at once — no spurious QR for an authenticated session', async () => {
	const sock = await makeOfflineSocket({ qrTimeout: 100, defaultQueryTimeoutMs: 50 })
	fakeOpenTransport(sock)
	const qrs = []
	sock.ev.on('connection.update', u => {
		if (u.qr) qrs.push(u.qr)
	})
	sock.ws.emit('CB:iq,type:set,pair-device', pairDevice('pd-1', ['REF-A', 'REF-B']))
	await sleep(30)
	sock.ws.emit('CB:success', successNode)
	await sleep(600)
	const refs = qrs.map(q => (q.includes('REF-A') ? 'A' : q.includes('REF-B') ? 'B' : '?'))
	assert.deepEqual(refs, ['A'], `expected exactly one QR (A); got [${refs.join(',')}] — a QR fired after <success>`)
	endQuietly(sock)
	await sleep(50)
})

test('HB-422: CB:success emits connection.update open before the housekeeping IQs', async () => {
	const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
	fakeOpenTransport(sock)
	const t0 = Date.now()
	const openP = new Promise(resolve => {
		sock.ev.on('connection.update', u => {
			if (u.connection === 'open') resolve(Date.now() - t0)
		})
	})
	sock.ws.emit('CB:success', successNode)
	const tOpen = await Promise.race([openP, sleep(3000).then(() => null)])
	// Pre-fix 'open' waited on the unanswered housekeeping IQs
	// (~2x defaultQueryTimeoutMs, >= 350ms here); post-fix it lands
	// in the same tick as the success stanza.
	assert.ok(tOpen !== null && tOpen < 150, `expected 'open' within 150ms of <success>, got ${tOpen}ms`)
	endQuietly(sock)
	await sleep(50)
})

test('HB-428 main: CB:success emits nothing after end() lands mid-housekeeping', async () => {
	const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
	sock.ws.socket = makeDelayedFake(2000)
	sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: 'Test' }
	const events = []
	const t0 = Date.now()
	const rel = () => Date.now() - t0
	sock.ev.on('connection.update', u => events.push({ at: rel(), connection: u.connection ?? null }))
	sock.ev.on('creds.update', () => events.push({ at: rel(), credsUpdate: true }))
	sock.ws.emit('CB:success', successNode)
	await sleep(50)
	const endAt = rel()
	void sock.end(new Error('host teardown'))
	const closed = await waitForClose(events)
	const phantomOpen = events.filter(e => e.connection === 'open' && e.at >= endAt)
	const credsAfterEnd = events.filter(e => e.credsUpdate && e.at >= endAt)
	assert.equal(phantomOpen.length, 0, `phantom 'open' after end(): ${JSON.stringify(events)}`)
	assert.equal(credsAfterEnd.length, 0, `creds.update after end(): ${JSON.stringify(events)}`)
	assert.ok(closed, `expected a 'close' update, got ${JSON.stringify(events)}`)
	try { sock.end(undefined) } catch {}
	await sleep(50)
})

test('HB-428 facet 2: sync CB handlers (edge_routing / offline / pair-success) emit nothing after end()', async () => {
	// edge_routing -> creds.update
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		const events = []
		const t0 = Date.now()
		const rel = () => Date.now() - t0
		sock.ev.on('creds.update', () => events.push({ at: rel(), credsUpdate: true }))
		sock.ev.on('connection.update', u => events.push({ at: rel(), connection: u.connection ?? null }))
		await sleep(10)
		const endAt = rel()
		void sock.end(new Error('host teardown'))
		sock.ws.emit('CB:ib,,edge_routing', {
			tag: 'ib',
			attrs: {},
			content: [{
				tag: 'edge_routing',
				attrs: {},
				content: [{ tag: 'routing_info', attrs: {}, content: Buffer.from([1, 2, 3, 4]) }]
			}]
		})
		const closed = await waitForClose(events)
		assert.equal(events.filter(e => e.credsUpdate && e.at >= endAt).length, 0, 'edge_routing emitted creds.update after end()')
		assert.ok(closed, 'expected a close update after edge_routing trial')
		try { sock.end(undefined) } catch {}
		await sleep(50)
	}
	// offline -> receivedPendingNotifications
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		const events = []
		const t0 = Date.now()
		const rel = () => Date.now() - t0
		sock.ev.on('connection.update', u => events.push({ at: rel(), connection: u.connection ?? null, rpn: u.receivedPendingNotifications }))
		await sleep(10)
		const endAt = rel()
		void sock.end(new Error('host teardown'))
		sock.ws.emit('CB:ib,,offline', {
			tag: 'ib',
			attrs: {},
			content: [{ tag: 'offline', attrs: { count: '3' } }]
		})
		const closed = await waitForClose(events)
		assert.equal(events.filter(e => e.rpn === true && e.at >= endAt).length, 0, 'offline emitted receivedPendingNotifications after end()')
		assert.ok(closed, 'expected a close update after offline trial')
		try { sock.end(undefined) } catch {}
		await sleep(50)
	}
	// pair-success -> creds.update + connection.update { isNewLogin }
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		fakeOpenTransport(sock)
		const events = []
		const t0 = Date.now()
		const rel = () => Date.now() - t0
		sock.ev.on('connection.update', u => events.push({ at: rel(), connection: u.connection ?? null, isNewLogin: !!u.isNewLogin }))
		sock.ev.on('creds.update', () => events.push({ at: rel(), credsUpdate: true }))
		await sleep(10)
		const endAt = rel()
		void sock.end(new Error('host teardown'))
		sock.ws.emit('CB:iq,,pair-success', buildPairSuccessStanza())
		const closed = await waitForClose(events)
		assert.equal(events.filter(e => (e.isNewLogin || e.credsUpdate) && e.at >= endAt).length, 0, `pair-success emitted after end(): ${JSON.stringify(events)}`)
		assert.ok(closed, 'expected a close update after pair-success trial')
		try { sock.end(undefined) } catch {}
		await sleep(50)
	}
})

// Shared pair-success fixture (same shape as test 17's HB-239 builder).
const pairSuccessIdentKp = Curve.generateKeyPair()
const pairSuccessAcctKp = Curve.generateKeyPair()
const pairSuccessAdvSecretKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')
function buildPairSuccessStanza({ omitHmacDetails = false, omitHmac = false, omitAccountDetails = false } = {}) {
	const deviceDetails = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
	const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, pairSuccessIdentKp.public])
	const accountSignature = Curve.sign(pairSuccessAcctKp.private, accountMsg)
	const account = omitAccountDetails
		? { accountSignatureKey: pairSuccessAcctKp.public, accountSignature }
		: { accountSignatureKey: pairSuccessAcctKp.public, accountSignature, details: deviceDetails }
	const details = waproto.ADVSignedDeviceIdentity.encode(account).finish()
	const hmac = hmacSign(details, Buffer.from(pairSuccessAdvSecretKey, 'base64'))
	const hmacNode = waproto.ADVSignedDeviceIdentityHMAC.encode(
		omitHmacDetails ? { hmac } : omitHmac ? { details } : { details, hmac }
	).finish()
	return {
		tag: 'iq',
		attrs: { id: 'pair-1', type: 'set' },
		content: [
			{
				tag: 'pair-success',
				attrs: {},
				content: [
					{ tag: 'device-identity', attrs: {}, content: hmacNode },
					{ tag: 'device', attrs: { jid: '6281234567890:12@s.whatsapp.net' } },
					{ tag: 'platform', attrs: { name: 'TestPlatform' } }
				]
			}
		]
	}
}
const pairSuccessCreds = { advSecretKey: pairSuccessAdvSecretKey, signedIdentityKey: pairSuccessIdentKp, signalIdentities: [] }

test('HB-428 facet 3: handleClientTooOld emits nothing after end() during the version fetch', async () => {
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => {
		await sleep(300)
		return {
			ok: true,
			statusText: 'OK',
			text: async () => '/* sw.js */ var x = {"client_revision": 1056000000};'
		}
	}
	try {
		const streamError405 = {
			tag: 'stream:error',
			attrs: { code: '405' },
			content: [{ tag: 'conflict', attrs: {} }]
		}
		// Control: no host end() — clientTooOld lands, then close.
		{
			const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 800 })
			sock.ws.socket = makeDelayedFake(2000)
			const events = []
			const t0 = Date.now()
			const rel = () => Date.now() - t0
			sock.ev.on('connection.update', u => events.push({ at: rel(), clientTooOld: u.clientTooOld ?? null, connection: u.connection ?? null }))
			await sleep(10)
			sock.ws.emit('CB:stream:error', streamError405)
			const closed = await waitForClose(events)
			assert.ok(events.some(e => e.clientTooOld === true), `control: clientTooOld never landed: ${JSON.stringify(events)}`)
			assert.ok(closed, 'control: expected a close update')
			try { sock.end(undefined) } catch {}
			await sleep(50)
		}
		// Trial: host end() 50ms into the fetch — no clientTooOld after end().
		{
			const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 800 })
			sock.ws.socket = makeDelayedFake(2000)
			const events = []
			const t0 = Date.now()
			const rel = () => Date.now() - t0
			sock.ev.on('connection.update', u => events.push({ at: rel(), clientTooOld: u.clientTooOld ?? null, connection: u.connection ?? null }))
			await sleep(10)
			sock.ws.emit('CB:stream:error', streamError405)
			await sleep(50)
			const endAt = rel()
			void sock.end(new Error('host teardown'))
			const closed = await waitForClose(events)
			assert.equal(events.filter(e => e.clientTooOld === true && e.at >= endAt).length, 0, `clientTooOld emitted after end(): ${JSON.stringify(events)}`)
			assert.ok(closed, 'expected a close update after clientTooOld trial')
			try { sock.end(undefined) } catch {}
			await sleep(50)
		}
	} finally {
		globalThis.fetch = realFetch
	}
})

test('HB-414: extractDeviceJids keeps a hosted domainType on its own device only', () => {
	// PN user: device 0 hosted, device 1 plain — the plain device
	// must come back on the base domain, not HOSTED.
	const pn = extractDeviceJids(
		[{
			id: '6281111111111@s.whatsapp.net',
			devices: { deviceList: [
				{ id: 0, keyIndex: 0, isHosted: true },
				{ id: 1, keyIndex: 1, isHosted: false }
			] }
		}],
		'6289999999999@s.whatsapp.net',
		'',
		false
	)
	assert.equal(pn.length, 2, `expected 2 devices, got ${JSON.stringify(pn)}`)
	assert.equal(pn[0].domainType, WAJIDDomains.HOSTED)
	assert.equal(pn[1].domainType, WAJIDDomains.WHATSAPP, `hosted domainType leaked to the next device: ${JSON.stringify(pn[1])}`)
	assert.equal(pn[1].server, 's.whatsapp.net')
	// LID user: same leak shape, HOSTED_LID must not spread either.
	const lid = extractDeviceJids(
		[{
			id: '6281111111111@lid',
			devices: { deviceList: [
				{ id: 0, keyIndex: 0, isHosted: true },
				{ id: 2, keyIndex: 1, isHosted: false }
			] }
		}],
		'6289999999999@s.whatsapp.net',
		'',
		false
	)
	assert.equal(lid[0].domainType, WAJIDDomains.HOSTED_LID)
	assert.equal(lid[1].domainType, WAJIDDomains.LID, `hosted LID domainType leaked to the next device: ${JSON.stringify(lid[1])}`)
})

test('HB-444: auto-join re-runs once after a reconnect that lands while a run is in progress', async () => {
	const ev = new EventEmitter()
	const followed = []
	const fakeSock = {
		ev,
		logger: silentLogger,
		newsletterSubscribed: async () => new Set(),
		newsletterFollow: async jid => {
			followed.push(jid)
			await sleep(20)
		}
	}
	attachAunuAutoJoin(fakeSock, { autoJoinChannels: ['111@newsletter', '222@newsletter'], autoJoinLimit: 3 })
	ev.emit('connection.update', { connection: 'open' })
	await sleep(50) // first run is mid-flight (each channel costs ~520ms)
	ev.emit('connection.update', { connection: 'open' }) // reconnect during the run
	await sleep(2600) // two rounds: ~2 x (2 channels x ~520ms)
	assert.equal(followed.length, 4, `expected both channels followed in two rounds, got ${JSON.stringify(followed)}`)
	assert.deepEqual(followed, ['111@newsletter', '222@newsletter', '111@newsletter', '222@newsletter'])
})

test('HB-450: fetchLatestBaileysVersion forwards the host AbortSignal and applies an internal timeout', async () => {
	const realFetch = globalThis.fetch
	const seen = []
	globalThis.fetch = async (url, opts) => {
		seen.push(opts)
		return {
			ok: true,
			statusText: 'OK',
			text: async () => ['x', 'x', 'x', 'x', 'x', 'x', 'const version = [2, 3000, 1043857760]'].join('\n')
		}
	}
	try {
		// A host-supplied signal is honoured as-is.
		const ac = new AbortController()
		const r1 = await fetchLatestBaileysVersion({ signal: ac.signal })
		assert.equal(seen[0].signal, ac.signal, 'host AbortSignal was not forwarded to fetch')
		assert.deepEqual(r1.version, [2, 3000, 1043857760])
		assert.equal(r1.isLatest, true)
		// Without a host signal the call still carries a timeout
		// signal instead of hanging on a black-holed connection.
		const r2 = await fetchLatestBaileysVersion({})
		assert.ok(seen[1].signal instanceof AbortSignal, `no internal timeout signal on fetch: ${JSON.stringify(Object.keys(seen[1] || {}))}`)
		assert.deepEqual(r2.version, [2, 3000, 1043857760])
	} finally {
		globalThis.fetch = realFetch
	}
})

test('HB-455: digestKeyBundle reports a missing <digest> as Boom 502, not a plain Error', async () => {
	const { logger, warns } = makeCapturingLogger()
	const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200, logger })
	fakeOpenTransport(sock)
	const stopAnswer = answerAllCountOnly(sock)
	sock.ws.emit('CB:success', successNode)
	// The digest failure is logged by the CB:success inner catch as
	// 'failed to run digest after login' — wait for that warn, then
	// inspect the error it carries.
	const found = await waitFor(() => warns.some(w => /digest/.test(w.msg ?? '')), 5000).catch(() => false)
	stopAnswer()
	assert.ok(found, `digest warn never logged; warns=${JSON.stringify(warns.map(w => w.msg))}`)
	const warn = warns.find(w => /digest/.test(w.msg ?? ''))
	// The CB:success inner catch logs { e } (not { err }).
	const err = warn.obj?.err ?? warn.obj?.e
	assert.equal(err?.isBoom, true, `missing <digest> must be a Boom, got ${err?.constructor?.name}: ${err?.message}`)
	assert.equal(err?.output?.statusCode, 502, `missing <digest> Boom must be 502, got ${err?.output?.statusCode}`)
	endQuietly(sock)
	await sleep(50)
})

test('HB-262 addendum: end() rolls back an optimistic pairing (unregistered, pairingCode set, no account)', async () => {
	// Case A: optimistic me + pairingCode, pair-success never ran —
	// the rollback must delete both and emit creds.update so the
	// host persists the clean state (no 401 loop on next boot).
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		sock.authState.creds.registered = false
		sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: '~' }
		sock.authState.creds.pairingCode = 'ABCDEFGH'
		delete sock.authState.creds.account
		let credsUpdates = 0
		sock.ev.on('creds.update', () => credsUpdates++)
		void sock.end()
		assert.equal(sock.authState.creds.me, undefined, 'optimistic me survived end()')
		assert.equal(sock.authState.creds.pairingCode, undefined, 'pairingCode survived end()')
		assert.ok(credsUpdates >= 1, 'rollback did not emit creds.update for the host to persist')
		await sleep(300)
		try { sock.end(undefined) } catch {}
	}
	// Case B: registered session — end() must NOT touch the identity.
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		sock.authState.creds.registered = true
		sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: 'Test' }
		sock.authState.creds.pairingCode = 'ABCDEFGH'
		void sock.end()
		assert.ok(sock.authState.creds.me, 'registered me was deleted by end()')
		assert.equal(sock.authState.creds.pairingCode, 'ABCDEFGH', 'pairingCode was deleted on a registered session')
		await sleep(300)
		try { sock.end(undefined) } catch {}
	}
	// Case C: pair-success completed (account set) but companion_finish
	// has not run yet — the identity is real; end() must keep it.
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		sock.authState.creds.registered = false
		sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: 'Test', lid: '123@lid' }
		sock.authState.creds.pairingCode = 'ABCDEFGH'
		sock.authState.creds.account = { details: Buffer.from([1]) }
		void sock.end()
		assert.ok(sock.authState.creds.me, 'paired me was deleted by end() after pair-success')
		assert.equal(sock.authState.creds.pairingCode, 'ABCDEFGH', 'pairingCode was deleted after pair-success')
		await sleep(300)
		try { sock.end(undefined) } catch {}
	}
	// Case D: me set with no pairingCode at all — not a pending
	// pairing; end() must leave it alone.
	{
		const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
		sock.ws.socket = makeDelayedFake(150)
		sock.authState.creds.registered = false
		sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: 'Test' }
		delete sock.authState.creds.pairingCode
		void sock.end()
		assert.ok(sock.authState.creds.me, 'me without pairingCode was deleted by end()')
		await sleep(300)
		try { sock.end(undefined) } catch {}
	}
})

test('HB-238 addendum: processHandshake rejects short serverHello ephemeral/static descriptively', () => {
	const kp = Curve.generateKeyPair()
	const noise = makeNoiseHandler({ keyPair: kp, NOISE_HEADER: new Uint8Array([87, 65, 6, 0]), logger: silentLogger })
	assert.throws(
		() => noise.processHandshake({ serverHello: { ephemeral: new Uint8Array(16), static: new Uint8Array(48), payload: new Uint8Array(0) } }, kp),
		err => /serverHello/.test(err.message) && /ephemeral/.test(err.message) && /16|32/.test(err.message),
		'a 16-byte ephemeral must fail as a descriptive malformed-handshake error, not Curve "Invalid public key"'
	)
	assert.throws(
		() => noise.processHandshake({ serverHello: { ephemeral: new Uint8Array(32), static: new Uint8Array(16), payload: new Uint8Array(0) } }, kp),
		err => /serverHello/.test(err.message) && /static/.test(err.message) && /16|48/.test(err.message),
		'a 16-byte static must fail as a descriptive malformed-handshake error, not a raw GCM error'
	)
	// Control: well-formed lengths pass the shape gate — the failure
	// moves on to key agreement / decryption, not the length error.
	assert.throws(
		() => noise.processHandshake({ serverHello: { ephemeral: new Uint8Array(32), static: new Uint8Array(48), payload: new Uint8Array(0) } }, kp),
		err => !/serverHello.*(ephemeral|static).*(length|must be)/.test(err.message),
		'valid-length fields must not trip the shape gate'
	)
})

test('HB-239 addenda 3+4: configureSuccessfulPairing rejects null details/hmac/account.details with Boom', () => {
	// Addendum 3a: HMAC node without <details>.
	assert.throws(
		() => configureSuccessfulPairing(buildPairSuccessStanza({ omitHmacDetails: true }), pairSuccessCreds),
		err => err?.isBoom === true,
		'a missing HMAC details must be a descriptive Boom, not a raw TypeError'
	)
	// Addendum 3b: HMAC node without <hmac>.
	assert.throws(
		() => configureSuccessfulPairing(buildPairSuccessStanza({ omitHmac: true }), pairSuccessCreds),
		err => err?.isBoom === true,
		'a missing HMAC hmac must be a descriptive Boom, not a raw TypeError'
	)
	// Addendum 4: signed device identity without <details>.
	assert.throws(
		() => configureSuccessfulPairing(buildPairSuccessStanza({ omitAccountDetails: true }), pairSuccessCreds),
		err => err?.isBoom === true,
		'a missing account details must be a descriptive Boom, not a raw TypeError'
	)
	// Control: the well-formed stanza still pairs.
	const r = configureSuccessfulPairing(buildPairSuccessStanza(), pairSuccessCreds)
	assert.equal(r.reply.content[0].content[0].attrs['key-index'], '0')
})

test('HB-2026-1112-80 addendum: generateRegistrationNode rejects a non-numeric signedPreKey.keyId', () => {
	const keyPair = Curve.generateKeyPair()
	const config = { version: [2, 3000, 1043857760], browser: ['Test', 'Chrome', '1.0.0'] }
	const base = {
		registrationId: 12345,
		signedIdentityKey: keyPair,
		signedPreKey: { keyId: 5, keyPair, signature: Buffer.alloc(64) }
	}
	assert.throws(
		() => generateRegistrationNode({ ...base, signedPreKey: { ...base.signedPreKey, keyId: 'abc' } }, config),
		err => /keyId/.test(err.message),
		'a string keyId must throw instead of silently encoding eSkeyId = 0'
	)
	assert.throws(
		() => generateRegistrationNode({ ...base, signedPreKey: { ...base.signedPreKey, keyId: NaN } }, config),
		err => /keyId/.test(err.message),
		'a NaN keyId must throw instead of silently encoding eSkeyId = 0'
	)
	assert.throws(
		() => generateRegistrationNode({ ...base, signedPreKey: { ...base.signedPreKey, keyId: undefined } }, config),
		err => /keyId/.test(err.message),
		'an undefined keyId must throw'
	)
	// Controls: keyId 0 stays legal, keyId 5 encodes as [0, 0, 5].
	const r0 = generateRegistrationNode({ ...base, signedPreKey: { ...base.signedPreKey, keyId: 0 } }, config)
	assert.deepEqual([...r0.devicePairingData.eSkeyId], [0, 0, 0])
	const r5 = generateRegistrationNode(base, config)
	assert.deepEqual([...r5.devicePairingData.eSkeyId], [0, 0, 5])
})

test('HB-268 addendum (sweep): an async ws listener rejection is caught, not an unhandledRejection', async () => {
	const sock = await makeOfflineSocket({ defaultQueryTimeoutMs: 200 })
	fakeOpenTransport(sock)
	const rejections = []
	const onRej = e => rejections.push(String(e?.message || e))
	process.on('unhandledRejection', onRej)
	try {
		let secondRan = false
		sock.ws.on('frame', async () => { throw new Error('HB-268 test listener boom') })
		sock.ws.on('frame', () => { secondRan = true })
		// Raw pre-transport frame: 3-byte length + 5 payload bytes.
		sock.ws.emit('message', Buffer.concat([Buffer.from([0, 0, 5]), Buffer.from('hello')]))
		await sleep(300)
		assert.equal(rejections.length, 0, `async listener rejection floated as unhandledRejection: ${JSON.stringify(rejections)}`)
		assert.equal(secondRan, true, 'the throwing listener stopped dispatch to the next listener')
	} finally {
		process.off('unhandledRejection', onRej)
		endQuietly(sock)
		await sleep(50)
	}
})

test('HB-2026-1114-243 addendum (sweep): a duplicate pair-device IQ appends its refs to the running QR chain', async () => {
	const sock = await makeOfflineSocket({ qrTimeout: 100, defaultQueryTimeoutMs: 50 })
	fakeOpenTransport(sock)
	const qrs = []
	sock.ev.on('connection.update', u => {
		if (u.qr) qrs.push(u.qr)
	})
	sock.ws.emit('CB:iq,type:set,pair-device', pairDevice('pd-1', ['REF-A']))
	await sleep(30)
	// A second pair-device stanza while the chain is still active —
	// its ref must join the queue, not be dropped by the guard.
	sock.ws.emit('CB:iq,type:set,pair-device', pairDevice('pd-2', ['REF-C']))
	await sleep(250)
	const refs = qrs.map(q => (q.includes('REF-A') ? 'A' : q.includes('REF-C') ? 'C' : '?'))
	assert.deepEqual(refs, ['A', 'C'], `expected QRs A then C; got [${refs.join(',')}] — the duplicate stanza's ref was dropped`)
	endQuietly(sock)
	await sleep(50)
})
