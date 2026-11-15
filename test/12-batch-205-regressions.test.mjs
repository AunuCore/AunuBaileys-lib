// 2.0.5 batch: HB-327 (CRITICAL, group sender keys), HB-323, HB-324,
// HB-325, HB-326, HB-328, HB-330, HB-331, addendum HB-269 (null patch
// entry), addendum HB-2026-1112-19 (mediaConn poison). Patterns follow
// 10/11 (real socket + fake transport, TAG waiters) and the heartbeat
// harnesses that verified each finding empirically (run-0231, run-0206,
// run-0234, run-0240, run-manual-1115-1518).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly, silentLogger, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { GroupSessionBuilder } from '../lib/Signal/Group/group-session-builder.js'
import { GroupCipher } from '../lib/Signal/Group/group_cipher.js'
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js'
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js'
import { toProductNode } from '../lib/Utils/business.js'

const GROUP = '120363012345678@g.us'
const ME = '628123456789@s.whatsapp.net'
const PEER = '628999888777@s.whatsapp.net'

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	state.keys = addTransactionCapability(state.keys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	return makeLibSignalRepository(state, silentLogger)
}

// Peer sender-key material minted against an object-identity store (no
// JSON round-trip on the peer side), exactly like the run-0231 harness.
const mintPeerMaterial = async () => {
	const sender = { id: '628999888777', deviceId: 0, toString: () => '628999888777.0' }
	const name = new SenderKeyName(GROUP, sender)
	const peerDb = new Map()
	const peerStore = {
		loadSenderKey: async n => peerDb.get(n.toString()) || new SenderKeyRecord(),
		storeSenderKey: async (n, r) => {
			peerDb.set(n.toString(), r)
		}
	}
	const skdm = await new GroupSessionBuilder(peerStore).create(name)
	const ciphertext = await new GroupCipher(peerStore, name).encrypt(Buffer.from('peer says hi'))
	return { skdm, ciphertext }
}

const processPeerSkdm = async repo => {
	const { skdm, ciphertext } = await mintPeerMaterial()
	await repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: skdm.serialize() },
		authorJid: PEER
	})
	return ciphertext
}

// ── HB-327 ──────────────────────────────────────────────────────────

test('HB-327: group encrypt survives store->load round-trips through the real multi-file store', async () => {
	const dir = tmpDir('aunu-205-sk-')
	const repo = await makeRepo(dir)
	const r1 = await repo.encryptGroupMessage({ group: GROUP, meId: ME, data: Buffer.from('hello-1') })
	assert.ok(r1.ciphertext.length > 0, 'first encrypt produced no ciphertext')
	// second encrypt reloads the record from disk
	const r2 = await repo.encryptGroupMessage({ group: GROUP, meId: ME, data: Buffer.from('hello-2') })
	assert.ok(r2.ciphertext.length > 0, 'second encrypt (after reload) produced no ciphertext')
	// fresh repository over the same directory (simulated restart)
	const repo2 = await makeRepo(dir)
	const r3 = await repo2.encryptGroupMessage({ group: GROUP, meId: ME, data: Buffer.from('hello-3') })
	assert.ok(r3.ciphertext.length > 0, 'post-restart encrypt produced no ciphertext')
	// the stored record's seeds must be in the base64-string form the
	// reviver restores — never the {type:'Buffer',data:[...]} array
	// form (the file's outer wrapper is the auth state's own Buffer
	// encoding of the record bytes, so decode one level first)
	const skFile = fs.readdirSync(dir).find(f => f.startsWith('sender-key-'))
	assert.ok(skFile, 'no sender-key file was written')
	const storedValue = JSON.parse(fs.readFileSync(path.join(dir, skFile), 'utf-8'), lib.BufferJSON.reviver)
	const inner = Buffer.from(storedValue).toString('utf-8')
	assert.ok(!inner.includes('"data":['), 'sender-key record still stores seeds in the broken array form')
})

test('HB-327: a peer SKDM processed into the real store decrypts the peer ciphertext', async () => {
	const dir = tmpDir('aunu-205-skd-')
	const repo = await makeRepo(dir)
	const ciphertext = await processPeerSkdm(repo)
	const pt = await repo.decryptGroupMessage({ group: GROUP, authorJid: PEER, msg: ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'peer says hi')
})

test('HB-327 (healing): a sender-key file written in the broken 2.0.0-2.0.4 array form heals on load', async () => {
	const dir = tmpDir('aunu-205-heal-')
	const repo = await makeRepo(dir)
	const ciphertext = await processPeerSkdm(repo)
	// rewrite the stored record exactly as 2.0.0-2.0.4 wrote it:
	// the record bytes are JSON.stringify WITHOUT BufferJSON.replacer
	// (seeds become {type:'Buffer',data:[...]}), wrapped by the auth
	// state's own file encoding as usual
	const skFile = fs.readdirSync(dir).find(f => f.startsWith('sender-key-'))
	assert.ok(skFile, 'no sender-key file was written')
	const filePath = path.join(dir, skFile)
	const storedValue = JSON.parse(fs.readFileSync(filePath, 'utf-8'), lib.BufferJSON.reviver)
	const structures = JSON.parse(Buffer.from(storedValue).toString('utf-8'), lib.BufferJSON.reviver)
	const brokenInner = JSON.stringify(structures)
	assert.ok(brokenInner.includes('"data":['), 'fixture record is not in the broken array form')
	fs.writeFileSync(filePath, JSON.stringify(Buffer.from(brokenInner, 'utf-8'), lib.BufferJSON.replacer))
	// fresh repository over the healed directory decrypts
	const repo2 = await makeRepo(dir)
	const pt = await repo2.decryptGroupMessage({ group: GROUP, authorJid: PEER, msg: ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'peer says hi')
})

test('HB-327 (healing, unit): deserialize accepts the legacy array form but still drops corrupt seeds', () => {
	const seed = Crypto.randomBytes(32)
	const legacy = [
		{
			senderKeyId: 42,
			senderChainKey: { iteration: 0, seed: { type: 'Buffer', data: [...seed] } },
			senderSigningKey: { public: { type: 'Buffer', data: [...Crypto.randomBytes(32)] } },
			senderMessageKeys: []
		}
	]
	const record = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(legacy), 'utf-8'))
	assert.ok(!record.isEmpty(), 'legacy-form record loaded empty')
	assert.equal(record.getSenderKeyState()?.getKeyId(), 42)
	// a data array with non-byte values is NOT the legacy form — the
	// sanitizer must still drop the state (healing must not weaken it)
	const corrupt = [
		{
			senderKeyId: 43,
			senderChainKey: { iteration: 0, seed: { type: 'Buffer', data: ['x', 1, 2] } },
			senderSigningKey: { public: Crypto.randomBytes(32) },
			senderMessageKeys: []
		}
	]
	const record2 = SenderKeyRecord.deserialize(Buffer.from(JSON.stringify(corrupt), 'utf-8'))
	assert.ok(record2.isEmpty(), 'corrupt seed form was accepted')
})

// ── HB-323 ──────────────────────────────────────────────────────────

test('HB-323: a CDN 404 triggers ctx.reuploadRequest and the retried download succeeds', async t => {
	const plaintext = Crypto.randomBytes(2048)
	const enc = await lib.encryptedStream(plaintext, 'image', {})
	t.after(() => fs.promises.unlink(enc.encFilePath).catch(() => {}))
	const encBytes = await fs.promises.readFile(enc.encFilePath)
	const message = {
		key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: false, id: 'HB323MSG' },
		message: {
			imageMessage: {
				mimetype: 'image/jpeg',
				mediaKey: enc.mediaKey,
				url: 'https://mmg.whatsapp.net/x.jpg',
				directPath: '/media/x.jpg',
				fileSha256: enc.fileSha256,
				fileEncSha256: enc.fileEncSha256,
				fileLength: plaintext.length
			}
		}
	}
	let fetches = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => {
		fetches++
		if (fetches === 1) {
			return new Response('not found', { status: 404 })
		}

		return new Response(new Uint8Array(encBytes), { status: 200 })
	}
	t.after(() => {
		globalThis.fetch = originalFetch
	})
	let reuploadCalls = 0
	const ctx = {
		logger: silentLogger,
		reuploadRequest: async m => {
			reuploadCalls++
			return m
		}
	}
	const out = await lib.downloadMediaMessage(message, 'buffer', {}, ctx)
	assert.equal(reuploadCalls, 1, 'reuploadRequest was not called exactly once')
	assert.ok(Buffer.from(out).equals(plaintext), 'downloaded plaintext does not match')
})

test('HB-323 (control): without ctx a CDN 404 still rejects with Boom 404', async t => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response('not found', { status: 404 })
	t.after(() => {
		globalThis.fetch = originalFetch
	})
	const message = {
		key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: false, id: 'HB323CTL' },
		message: {
			imageMessage: {
				mimetype: 'image/jpeg',
				mediaKey: Crypto.randomBytes(32),
				url: 'https://mmg.whatsapp.net/x.jpg',
				directPath: '/media/x.jpg',
				fileSha256: Crypto.randomBytes(32),
				fileLength: 10
			}
		}
	}
	await assert.rejects(lib.downloadMediaMessage(message, 'buffer', {}), err => err?.output?.statusCode === 404)
})

// ── HB-324 ──────────────────────────────────────────────────────────

test('HB-324: generateForwardMessageContent rejects messages with no forwardable content (Boom 400)', () => {
	const mkMsg = message => ({ key: { id: 'MSG1', fromMe: false, remoteJid: '123@s.whatsapp.net' }, message })
	for (const bad of [
		{},
		{ messageContextInfo: { messageSecret: Buffer.alloc(32, 7) } },
		{ senderKeyDistributionMessage: { groupId: '1@g.us', axolotlSenderKeyDistributionMessage: Buffer.alloc(4) } }
	]) {
		assert.throws(
			() => lib.generateForwardMessageContent(mkMsg(bad)),
			err => err?.isBoom && err?.output?.statusCode === 400,
			`expected Boom 400 for ${Object.keys(bad)[0] || 'empty'}`
		)
	}
})

test('HB-324 (control): a normal conversation still forwards', () => {
	const out = lib.generateForwardMessageContent({
		key: { id: 'MSG1', fromMe: false, remoteJid: '123@s.whatsapp.net' },
		message: { conversation: 'hello' }
	})
	assert.equal(out.extendedTextMessage?.text, 'hello')
	assert.equal(out.extendedTextMessage?.contextInfo?.forwardingScore, 1)
	assert.equal(out.extendedTextMessage?.contextInfo?.isForwarded, true)
})

// ── HB-325 ──────────────────────────────────────────────────────────

test('HB-325: event content validates startDate/endDate (Boom 400) and floors endTime', async () => {
	const isBoom400 = err => err?.isBoom && err?.output?.statusCode === 400
	await assert.rejects(
		lib.generateWAMessageContent({ event: { name: 'Ev', startDate: '2026-12-01T10:00:00.000Z' } }, {}),
		isBoom400
	)
	await assert.rejects(lib.generateWAMessageContent({ event: { name: 'Ev' } }, {}), isBoom400)
	await assert.rejects(
		lib.generateWAMessageContent({ event: { name: 'Ev', startDate: new Date(NaN) } }, {}),
		isBoom400
	)
	await assert.rejects(
		lib.generateWAMessageContent(
			{ event: { name: 'Ev', startDate: new Date(1764568800123), endDate: 'tomorrow' } },
			{}
		),
		isBoom400
	)
	const m = await lib.generateWAMessageContent(
		{ event: { name: 'Ev', startDate: new Date(1764568800123), endDate: new Date(1764572400456) } },
		{}
	)
	assert.equal(Number(m.eventMessage.startTime), 1764568800)
	assert.equal(Number(m.eventMessage.endTime), 1764572400, 'endTime was not floored to whole seconds')
})

// ── HB-326 ──────────────────────────────────────────────────────────

test('HB-326: one retry receipt advances the resend counter by exactly one', async t => {
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => {
		WebSocketClient.prototype.connect = originalConnect
	})
	const store = new Map()
	const msgRetryCounterCache = {
		get: async k => store.get(k),
		set: async (k, v) => {
			store.set(k, v)
		},
		del: async k => {
			store.delete(k)
		}
	}
	const sock = await makeOfflineSocket({
		msgRetryCounterCache,
		getMessage: async () => ({ conversation: 'resend me' })
	})
	t.after(() => endQuietly(sock))
	fakeOpenTransport(sock, [])
	sock.authState.creds.me = { id: ME, name: '~' }

	// a valid E2E bundle for the peer, carried in the receipt itself
	// (injectedFromBundle path — no session fetch needed)
	const identity = lib.Curve.generateKeyPair()
	const signed = lib.signedKeyPair(identity, 1)
	const preKey = lib.Curve.generateKeyPair()
	const uint = (n, len) => {
		const b = Buffer.alloc(len)
		b.writeUIntBE(n, 0, len)
		return b
	}
	const msgId = 'HB326MSG1'
	const receipt = {
		tag: 'receipt',
		attrs: { id: msgId, from: PEER, participant: PEER, type: 'retry', t: '1700000000' },
		content: [
			{ tag: 'retry', attrs: { count: '1', id: msgId, v: '2' } },
			{ tag: 'registration', attrs: {}, content: uint(12345, 4) },
			{
				tag: 'keys',
				attrs: {},
				content: [
					{ tag: 'type', attrs: {}, content: Buffer.from([5]) },
					{ tag: 'identity', attrs: {}, content: identity.public },
					{
						tag: 'skey',
						attrs: {},
						content: [
							{ tag: 'id', attrs: {}, content: uint(1, 3) },
							{ tag: 'value', attrs: {}, content: signed.keyPair.public },
							{ tag: 'signature', attrs: {}, content: signed.signature }
						]
					},
					{
						tag: 'key',
						attrs: {},
						content: [
							{ tag: 'id', attrs: {}, content: uint(2, 3) },
							{ tag: 'value', attrs: {}, content: preKey.public }
						]
					}
				]
			}
		]
	}
	sock.ws.emit('CB:receipt', receipt)
	const counted = await waitFor(() => (store.get(`${msgId}:${PEER}`) || 0) >= 1, 8000)
	assert.ok(counted, 'the resend counter never advanced — the retry receipt was not processed')
	// the two increment sites sit ~2.5 s apart in this flow (the
	// pre-call site fires immediately, the loop site only after the
	// session injection settles) — wait well past that gap, then
	// assert the round cost exactly one unit of budget
	await sleep(4000)
	assert.equal(store.get(`${msgId}:${PEER}`), 1, 'one retry round must advance the counter by exactly 1')
})

// ── HB-328 ──────────────────────────────────────────────────────────

test('HB-328: NaN/zero watchdog config falls back to defaults instead of false-firing', async () => {
	const mkWatchdog = options => {
		const ev = new EventEmitter()
		const state = { fired: 0 }
		ev.on('session.watchdog', () => state.fired++)
		const wd = lib.makeSessionWatchdog({ ev, ws: null }, options)
		return { wd, state }
	}
	// NaN quietAfterMs: quietForMs < NaN is always false, so the buggy
	// code fired on the first tick
	{
		const { wd, state } = mkWatchdog({ quietAfterMs: NaN, checkIntervalMs: 50 })
		await sleep(250)
		wd.stop()
		assert.equal(state.fired, 0, 'NaN quietAfterMs fired a false deaf alert')
	}
	// NaN checkIntervalMs: Node coerces it to 1 ms, so with a small
	// valid quietAfterMs the buggy code fired almost immediately; the
	// sanitised 30 s default must not fire inside this window
	{
		const { wd, state } = mkWatchdog({ quietAfterMs: 120, checkIntervalMs: NaN })
		await sleep(400)
		wd.stop()
		assert.equal(state.fired, 0, 'NaN checkIntervalMs spun the timer at 1 ms')
	}
	// zero is not a usable quiet period either
	{
		const { wd, state } = mkWatchdog({ quietAfterMs: 0, checkIntervalMs: 50 })
		await sleep(200)
		wd.stop()
		assert.equal(state.fired, 0, 'zero quietAfterMs fired immediately')
	}
	// control: valid small values still fire
	{
		const { wd, state } = mkWatchdog({ quietAfterMs: 60, checkIntervalMs: 30 })
		const fired = await waitFor(() => state.fired >= 1, 2000)
		wd.stop()
		assert.ok(fired, 'watchdog with valid config never fired')
	}
})

// ── HB-330 ──────────────────────────────────────────────────────────

test('HB-330: toProductNode tolerates a product update without images', () => {
	const node = toProductNode('123456', { name: 'Thing', price: 1000, currency: 'IDR' })
	assert.ok(node, 'no node produced')
	assert.ok(
		!node.content.some(n => n.tag === 'media'),
		'a media node was emitted for an imageless product'
	)
	const withImages = toProductNode('123456', {
		name: 'Thing',
		price: 1000,
		currency: 'IDR',
		images: [{ url: 'https://example.com/img.jpg' }]
	})
	assert.ok(
		withImages.content.some(n => n.tag === 'media'),
		'media node missing for a product with images (control)'
	)
})

// ── HB-331 ──────────────────────────────────────────────────────────

const makeFakeMp4 = (faststart = true) => {
	const ftyp = Buffer.alloc(24)
	ftyp.writeUInt32BE(24, 0)
	ftyp.write('ftyp', 4)
	ftyp.write('isom', 8)
	const moov = Buffer.alloc(16)
	moov.writeUInt32BE(16, 0)
	moov.write('moov', 4)
	const mdat = Buffer.alloc(64)
	mdat.writeUInt32BE(64, 0)
	mdat.write('mdat', 4)
	return faststart
		? Buffer.concat([ftyp, moov, mdat, Buffer.alloc(1024)])
		: Buffer.concat([ftyp, mdat, moov, Buffer.alloc(1024)])
}

test('HB-331: aunuScanStreamable verdicts (faststart / non-faststart / non-BMFF / undecided)', () => {
	assert.equal(lib.aunuScanStreamable(makeFakeMp4(true)), true)
	assert.equal(lib.aunuScanStreamable(makeFakeMp4(false)), false)
	assert.equal(lib.aunuScanStreamable(Buffer.from('OggS fake opus payload bytes')), true)
	assert.equal(lib.aunuScanStreamable(Buffer.alloc(4)), null)
})

test('HB-331: encryptedStream returns a streamingSidecar for streamable video/audio only', async () => {
	const video = await lib.encryptedStream(makeFakeMp4(true), 'video', {})
	assert.ok(Buffer.isBuffer(video.streamingSidecar), 'faststart video has no streamingSidecar')
	assert.equal(video.streamingSidecar.length, 10, 'small file should yield exactly one 10-byte digest')
	const nonFaststart = await lib.encryptedStream(makeFakeMp4(false), 'video', {})
	assert.equal(nonFaststart.streamingSidecar, undefined, 'non-faststart video must not advertise a sidecar')
	const audio = await lib.encryptedStream(Buffer.from('OggS fake opus payload bytes, streamable'), 'audio', {})
	assert.ok(Buffer.isBuffer(audio.streamingSidecar), 'non-BMFF audio has no streamingSidecar')
	const image = await lib.encryptedStream(Buffer.from('not a real jpeg but bytes'), 'image', {})
	assert.equal(image.streamingSidecar, undefined, 'image media must not carry a sidecar')
	// >64 KiB of payload crosses a window boundary: two digests
	const big = await lib.encryptedStream(Buffer.concat([makeFakeMp4(true), Buffer.alloc(70_000)]), 'video', {})
	assert.equal(big.streamingSidecar?.length, 20, 'two windows should yield two digests')
	for (const r of [video, nonFaststart, audio, image, big]) {
		await fs.promises.unlink(r.encFilePath).catch(() => {})
	}
})

test('HB-331: prepareWAMessageMedia attaches streamingSidecar to the video message', async () => {
	const obj = await lib.prepareWAMessageMedia(
		{ video: makeFakeMp4(true) },
		{
			logger: silentLogger,
			upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/v.mp4', directPath: '/v.mp4' })
		}
	)
	assert.ok(Buffer.isBuffer(obj.videoMessage?.streamingSidecar), 'videoMessage carries no streamingSidecar')
	assert.equal(obj.videoMessage.streamingSidecar.length, 10)
})

// ── Addendum HB-269 ─────────────────────────────────────────────────

test('HB-269 addendum: a null entry in the patch array no longer destroys the whole send', async t => {
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => {
		WebSocketClient.prototype.connect = originalConnect
	})
	const mkSock = async patchResult => {
		const sock = await makeOfflineSocket({ patchMessageBeforeSending: async () => patchResult })
		sock.authState.creds.me = { id: '11111111111@s.whatsapp.net' }
		return sock
	}
	const isBoom = (err, code) => err?.isBoom && err?.output?.statusCode === code
	// [null, valid]: the valid entry is isolated per-recipient; its
	// encryption fails (no real session), so the house guard fires
	// Boom 500 — crucially NOT the raw TypeError the parameter-list
	// destructuring used to throw for the null entry
	{
		const sock = await mkSock([null, { recipientJid: '22222222222@s.whatsapp.net', message: { conversation: 'hi' } }])
		t.after(() => endQuietly(sock))
		await assert.rejects(
			sock.createParticipantNodes(['22222222222@s.whatsapp.net'], { conversation: 'hi' }),
			err => isBoom(err, 500) && /All encryptions failed/.test(err.message),
			'null entry did not degrade to the per-recipient isolation path'
		)
	}
	// [undefined] alone: entry skipped, no nodes, same Boom 500 guard
	{
		const sock = await mkSock([undefined])
		t.after(() => endQuietly(sock))
		await assert.rejects(
			sock.createParticipantNodes(['22222222222@s.whatsapp.net'], { conversation: 'hi' }),
			err => isBoom(err, 500)
		)
	}
	// scalar undefined result: the original HB-269 Boom 400 guard holds
	{
		const sock = await mkSock(undefined)
		t.after(() => endQuietly(sock))
		await assert.rejects(
			sock.createParticipantNodes(['22222222222@s.whatsapp.net'], { conversation: 'hi' }),
			err => isBoom(err, 400)
		)
	}
})

// ── Addendum HB-2026-1112-19 ────────────────────────────────────────

test('HB-2026-1112-19: a rejected mediaConn does not poison later refreshes', async t => {
	const originalConnect = WebSocketClient.prototype.connect
	WebSocketClient.prototype.connect = async () => {}
	t.after(() => {
		WebSocketClient.prototype.connect = originalConnect
	})
	const sock = await makeOfflineSocket()
	t.after(() => endQuietly(sock))
	const fake = new EventEmitter()
	fake.send = (_data, cb) => {
		if (cb) cb()
	}
	fake.close = function () {
		this.emit('close')
	}
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	sock.authState.creds.me = { id: '6281234567890@s.whatsapp.net', name: '~' }

	const tagListener = () => sock.ws.eventNames().find(n => typeof n === 'string' && n.startsWith('TAG:'))
	const badNode = id => ({ tag: 'iq', attrs: { id, type: 'result' }, content: [] })
	const goodNode = id => ({
		tag: 'iq',
		attrs: { id, type: 'result' },
		content: [
			{
				tag: 'media_conn',
				attrs: { auth: 'test-auth', ttl: '3600' },
				content: [{ tag: 'host', attrs: { hostname: 'mmg.whatsapp.net', maxContentLengthBytes: '104857600' } }]
			}
		]
	})

	// first refresh: the server answers without a <media_conn> node,
	// so the fetch rejects (Boom 502) and the promise is cached
	const p1 = sock.refreshMediaConn(true)
	p1.catch(() => {})
	assert.ok(await waitFor(() => tagListener(), 3000), 'first media_conn query was never issued')
	const tag1 = tagListener()
	sock.ws.emit(tag1, badNode(tag1.slice(4)))
	await assert.rejects(p1, err => err?.output?.statusCode === 502)

	// second refresh: must RE-ISSUE the query, not rethrow the stale
	// rejection — with the bug, no new TAG listener ever appears
	const p2 = sock.refreshMediaConn(true)
	p2.catch(() => {})
	assert.ok(await waitFor(() => tagListener(), 3000), 'second refresh never re-issued the media_conn query (poisoned cache)')
	const tag2 = tagListener()
	sock.ws.emit(tag2, goodNode(tag2.slice(4)))
	const info = await p2
	assert.equal(info.hosts[0]?.hostname, 'mmg.whatsapp.net')
	assert.equal(info.ttl, 3600)
})
