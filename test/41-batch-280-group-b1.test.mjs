// Group B1 — batch 2.8.0: HB-493, HB-494 (+ pairing facet +
// facet 2), HB-495, HB-496, HB-497, HB-498, HB-504, HB-511.
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { prepareWAMessageMedia, addSoundSha256ToStickerWebP } from '../lib/Utils/messages.js'
import { Curve } from '../lib/Utils/crypto.js'

const REAL_WS_CONNECT = WebSocketClient.prototype.connect
WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const GROUP = '120363123456789012@g.us'
const NEWSLETTER = '120363000000000000@newsletter'

// ── HB-493 ───────────────────────────────────────────────────────────
// Store shaped like the multi-file store: get() returns { id: null }
// for a missing key. Pre-fix the floating-commit freshness check
// compared cur=null against pre=undefined (snapshot-absent) and
// want, declared the retry stale, and threw the original error.
test('HB-493: floating retry commits a read-absent-then-write transaction when the store returns null for absent keys', async () => {
	const backing = new Map()
	let setCalls = 0
	const store = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) {
				const v = backing.get(`${type}:${id}`)
				out[id] = v === undefined ? null : v
			}
			return out
		},
		async set(data) {
			setCalls++
			if (setCalls === 1) {
				const e = new Error('simulated transient EIO on first commit')
				e.code = 'EIO'
				throw e
			}
			for (const [type, rec] of Object.entries(data)) {
				for (const [id, v] of Object.entries(rec)) {
					if (v === null) backing.delete(`${type}:${id}`)
					else backing.set(`${type}:${id}`, v)
				}
			}
		}
	}
	const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 50 })
	const result = await tx.transaction(async () => {
		const { peerX } = await tx.get('session', ['peerX'])
		await tx.set({ session: { peerX: (peerX ?? 0) + 1 } })
		return 'A'
	}, 'peerX')
	assert.equal(result, 'A', 'the retry must commit (pre-fix: aborted as stale, original EIO rethrown)')
	assert.equal(backing.get('session:peerX'), 1)
})

// ── HB-494 (induk) ───────────────────────────────────────────────────
test('HB-494: rotateSignedPreKey with missing signedPreKey rejects Boom 500, not a raw TypeError', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.signedPreKey = undefined
		await assert.rejects(
			sock.rotateSignedPreKey(),
			err => err?.isBoom && err.output?.statusCode === 500 && !(err instanceof TypeError),
			'expected a descriptive Boom 500'
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-494: rotateSignedPreKey with missing signedIdentityKey rejects Boom 500, not a raw TypeError', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.signedIdentityKey = undefined
		await assert.rejects(
			sock.rotateSignedPreKey(),
			err => err?.isBoom && err.output?.statusCode === 500 && !(err instanceof TypeError)
		)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-494 pairing facets — fake WA server (test/36 HB-191 pattern) ──
const { makeNoiseHandler } = await import('../lib/Utils/noise-handler.js')
const { hkdf, aesEncryptGCM, aesDecryptGCM } = await import('../lib/Utils/crypto.js')
const { waproto: proto } = await import('../WAProto/index.js')
const { encodeBinaryNode } = await import('../lib/WABinary/encode.js')
const { decodeBinaryNode: decodeNode } = await import('../lib/WABinary/decode.js')
const { NOISE_WA_HEADER, NOISE_MODE, WA_CERT_DETAILS } = await import('../lib/Defaults/index.js')
const { WebSocketServer: WSS } = await import('ws')

async function runPairingCase(port, mutateCreds) {
	const AUTH_DIR = await mkdtemp(join(tmpdir(), 'aunu-41b1-auth-'))
	const { state, saveCreds } = await lib.useMultiFileAuthState(AUTH_DIR)
	mutateCreds(state.creds)
	const caPair = Curve.generateKeyPair()
	const origPub = WA_CERT_DETAILS.PUBLIC_KEY
	WA_CERT_DETAILS.PUBLIC_KEY = Buffer.from(caPair.public)
	const interPair = Curve.generateKeyPair()
	const stub = silentLogger
	const frame = payload => {
		const out = Buffer.alloc(3 + payload.length)
		out.writeUInt8(payload.length >> 16, 0)
		out.writeUInt16BE(payload.length & 65535, 1)
		payload.copy(out, 3)
		return out
	}
	const genIV = ctr => {
		const iv = Buffer.alloc(12)
		iv.writeUInt32BE(ctr, 8)
		return iv
	}
	const S = { phase: 'hello', buf: Buffer.alloc(0), introStripped: false, srv: null, se: null, ss: null, salt: null, postEnc: null, postDec: null, writeCtr: 0, readCtr: 0 }
	const captured = { wrappedLen: null }
	const postEncode = plain => {
		const ct = aesEncryptGCM(plain, S.postEnc, genIV(S.writeCtr), Buffer.alloc(0))
		S.writeCtr += 1
		return frame(ct)
	}
	const postDecode = ct => {
		const pt = aesDecryptGCM(ct, S.postDec, genIV(S.readCtr), Buffer.alloc(0))
		S.readCtr += 1
		return pt
	}
	const sendNode = (ws, node) => ws.send(postEncode(encodeBinaryNode(node)))
	async function onFrame(ws, payload) {
		if (S.phase === 'hello') {
			const hm = proto.HandshakeMessage.decode(payload)
			const cePub = Buffer.from(hm.clientHello.ephemeral)
			S.se = Curve.generateKeyPair()
			S.ss = Curve.generateKeyPair()
			S.srv = makeNoiseHandler({ keyPair: { public: cePub, private: S.se.private }, NOISE_HEADER: NOISE_WA_HEADER, logger: stub, routingInfo: undefined })
			S.srv.encodeFrame(Buffer.alloc(0))
			S.srv.authenticate(Buffer.from(S.se.public))
			const shared1 = Curve.sharedKey(S.se.private, cePub)
			await S.srv.mixIntoKey(shared1)
			const staticEnc = S.srv.encrypt(Buffer.from(S.ss.public))
			const shared2 = Curve.sharedKey(S.ss.private, cePub)
			await S.srv.mixIntoKey(shared2)
			const interDetails = proto.CertChain.NoiseCertificate.Details.encode({ serial: 1, issuerSerial: 0, key: Buffer.from(interPair.public) }).finish()
			const interSig = Curve.sign(caPair.private, interDetails)
			const leafDetails = proto.CertChain.NoiseCertificate.Details.encode({ serial: 2, issuerSerial: 1, key: Buffer.from(S.ss.public) }).finish()
			const leafSig = Curve.sign(interPair.private, leafDetails)
			const cert = proto.CertChain.encode({
				intermediate: { details: interDetails, signature: Buffer.from(interSig) },
				leaf: { details: leafDetails, signature: Buffer.from(leafSig) }
			}).finish()
			const payloadEnc = S.srv.encrypt(cert)
			ws.send(frame(proto.HandshakeMessage.encode({ serverHello: { ephemeral: Buffer.from(S.se.public), static: staticEnc, payload: payloadEnc } }).finish()))
			const h0 = Buffer.from(NOISE_MODE)
			S.salt = (await hkdf(shared1, 64, { salt: h0, info: '' })).subarray(0, 32)
			S.salt = (await hkdf(shared2, 64, { salt: S.salt, info: '' })).subarray(0, 32)
			S.phase = 'finish'
			return
		}
		if (S.phase === 'finish') {
			const hm = proto.HandshakeMessage.decode(payload)
			const cf = hm.clientFinish
			const noiseKeyPub = S.srv.decrypt(Buffer.from(cf.static))
			const shared3 = Curve.sharedKey(S.se.private, noiseKeyPub)
			await S.srv.mixIntoKey(shared3)
			S.srv.decrypt(Buffer.from(cf.payload))
			S.salt = (await hkdf(shared3, 64, { salt: S.salt, info: '' })).subarray(0, 32)
			const fin = await hkdf(Buffer.alloc(0), 64, { salt: S.salt, info: '' })
			S.postDec = Buffer.from(fin.subarray(0, 32))
			S.postEnc = Buffer.from(fin.subarray(32, 64))
			S.writeCtr = 0
			S.readCtr = 0
			S.phase = 'open'
			sendNode(ws, { tag: 'success', attrs: { lid: '6281234567890@lid' } })
			return
		}
		const node = await decodeNode(postDecode(Buffer.from(payload)))
		if (node.tag === 'iq') {
			const reg = Array.isArray(node.content) ? node.content.find(c => c.tag === 'link_code_companion_reg') : null
			if (reg && Array.isArray(reg.content)) {
				const wrapped = reg.content.find(c => c.tag === 'link_code_pairing_wrapped_companion_ephemeral_pub')
				if (wrapped) captured.wrappedLen = Buffer.from(wrapped.content).length
			}
			sendNode(ws, { tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content: [] })
		}
	}
	async function onBytes(ws, data) {
		S.buf = Buffer.concat([S.buf, Buffer.from(data)])
		if (!S.introStripped) {
			if (S.buf.length < 4) return
			S.buf = S.buf.subarray(4)
			S.introStripped = true
		}
		while (S.buf.length >= 3) {
			const size = (S.buf.readUInt8(0) << 16) | S.buf.readUInt16BE(1)
			if (S.buf.length < 3 + size) return
			const payload = S.buf.subarray(3, 3 + size)
			S.buf = S.buf.subarray(3 + size)
			await onFrame(ws, payload)
		}
	}
	const wss = new WSS({ port, host: '127.0.0.1' })
	let q = Promise.resolve()
	wss.on('connection', ws => {
		ws.on('message', data => {
			q = q.then(() => onBytes(ws, data)).catch(() => {})
		})
		ws.on('error', () => {})
	})
	WebSocketClient.prototype.connect = REAL_WS_CONNECT
	let sock
	try {
		sock = lib.makeWASocket({
			logger: stub,
			auth: state,
			browser: ['AunuBaileys-HB', 'Chrome', '1.0'],
			waWebSocketUrl: `ws://127.0.0.1:${port}`,
			connectTimeoutMs: 10000,
			defaultQueryTimeoutMs: 5000,
			keepAliveIntervalMs: 25000,
			printQRInTerminal: false,
			markOnlineOnConnect: false,
			syncFullHistory: false,
			fireInitQueries: false,
			emitOwnEvents: false,
			banSentinel: false
		})
		sock.ev.on('creds.update', saveCreds)
		const opened = await new Promise(resolve => {
			const t = setTimeout(() => resolve(false), 15000)
			sock.ev.on('connection.update', u => {
				if (u.connection === 'open') {
					clearTimeout(t)
					resolve(true)
				}
			})
		})
		assert.equal(opened, true, 'fake server handshake must open')
		await sleep(800)
		let error = null
		let code = null
		try {
			code = await sock.requestPairingCode('6289876543210')
		} catch (e) {
			error = e
		}
		await sleep(300)
		try { await sock.end(undefined) } catch {}
		await sleep(200)
		return { error, code, captured }
	} finally {
		WebSocketClient.prototype.connect = () => {}
		WA_CERT_DETAILS.PUBLIC_KEY = origPub
		wss.close()
	}
}

test('HB-494 addendum (pairing facet): missing pairingEphemeralKeyPair rejects Boom 500, not a raw TypeError', async () => {
	const { error } = await runPairingCase(18841, creds => {
		creds.pairingEphemeralKeyPair = undefined
	})
	assert.ok(error, 'the call must reject')
	assert.ok(error.isBoom && error.output?.statusCode === 500, `expected Boom 500, got ${error?.constructor?.name}: ${error?.message}`)
	assert.ok(!(error instanceof TypeError), 'must not be a raw TypeError')
})

test('HB-494 addendum facet 2: a base64-string pairing ephemeral public key is encrypted as 32 bytes, not 44 UTF-8 bytes', async () => {
	let origPublic = null
	const { error, code, captured } = await runPairingCase(18842, creds => {
		origPublic = Buffer.from(creds.pairingEphemeralKeyPair.public)
		creds.pairingEphemeralKeyPair = { ...creds.pairingEphemeralKeyPair, public: origPublic.toString('base64') }
	})
	assert.equal(error, null, `pairing must succeed (got ${error?.message})`)
	assert.ok(code, 'a pairing code is returned')
	// blob = 32 salt + 16 iv + ciphered; ciphered must be the
	// 32-byte key (total 80), not the 44-char base64 text (92).
	assert.equal(captured.wrappedLen, 80, `wrapped blob must be 80 bytes (pre-fix: 92)`)
})

// ── HB-495 ───────────────────────────────────────────────────────────
test('HB-495: a late ws.send success after the 408 timeout still registers the sent message for retry', async () => {
	const sock = await makeOfflineSocket({ connectTimeoutMs: 300 })
	try {
		sock.authState.creds.me = { id: ME, lid: '100000123456789@lid' }
		const frames = []
		const fake = fakeOpenTransport(sock, frames)
		fake.send = (data, cb) => {
			frames.push(data)
			setTimeout(() => cb && cb(), 600)
		}
		const MSG_ID = '3EB0LATE49500001'
		await assert.rejects(
			sock.relayMessage(NEWSLETTER, { conversation: 'hi late' }, { messageId: MSG_ID }),
			err => err?.output?.statusCode === 408,
			'the caller still sees the 408 timeout'
		)
		assert.equal(frames.length, 1, 'the stanza did reach the transport (late success)')
		const recent = sock.messageRetryManager?.getRecentMessage(NEWSLETTER, MSG_ID)
		assert.ok(recent, 'the sent message must be registered despite the timeout (pre-fix: undefined)')
		assert.equal(recent.message?.conversation, 'hi late')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-496 ───────────────────────────────────────────────────────────
test('HB-496: a socket end handler that never settles does not hang end() or block the close emit', async () => {
	const sock = await makeOfflineSocket({})
	fakeOpenTransport(sock, [])
	let closeSeen = false
	sock.ev.on('connection.update', u => {
		if (u.connection === 'close') closeSeen = true
	})
	sock.registerSocketEndHandler(() => new Promise(() => {}))
	const t0 = Date.now()
	await sock.end(new Error('test end'))
	const elapsed = Date.now() - t0
	assert.ok(elapsed < 9000, `end() must settle via the bounded handler timeout (took ${elapsed}ms; pre-fix: never)`)
	assert.equal(closeSeen, true, 'connection.update close must be emitted (pre-fix: never)')
})

// ── HB-497 ───────────────────────────────────────────────────────────
test('HB-497: FileBanGuardStore retries after a transient save failure instead of latching failed forever', async t => {
	const dir = tmpDir('aunu-41b1-ban-')
	const blocker = path.join(dir, 'blocker')
	fs.writeFileSync(blocker, 'x')
	const file = path.join(blocker, 'guard.json')
	const store = new lib.FileBanGuardStore(file)
	const record = { triggeredAt: 1000, until: 61000, reason: 'test', code: 403 }
	assert.equal(store.save(record), false, 'first save fails while the parent path is a file')
	assert.equal(store.hasFailed, true)
	// Filesystem recovers.
	fs.unlinkSync(blocker)
	assert.equal(store.save(record), true, 'the same store must retry and succeed after recovery (pre-fix: latched false)')
	assert.equal(store.hasFailed, false)
	assert.ok(fs.existsSync(file), 'the guard record is persisted after recovery')
	const loaded = store.load()
	assert.equal(loaded?.reason, 'test')
	// reset() via clear() also clears the latch.
	const dir2 = tmpDir('aunu-41b1-ban2-')
	const blocker2 = path.join(dir2, 'blocker')
	fs.writeFileSync(blocker2, 'x')
	const store2 = new lib.FileBanGuardStore(path.join(blocker2, 'guard2.json'))
	assert.equal(store2.save(record), false)
	store2.clear()
	assert.equal(store2.hasFailed, false, 'clear() must clear the failed latch')
})

// ── HB-498 ───────────────────────────────────────────────────────────
const chunk = (fourCC, data) => {
	const header = Buffer.alloc(8)
	header.write(fourCC, 0, 'ascii')
	header.writeUInt32LE(data.length, 4)
	return data.length % 2 ? Buffer.concat([header, data, Buffer.alloc(1)]) : Buffer.concat([header, data])
}
const webpFromChunks = chunks => {
	const body = Buffer.concat(chunks)
	const head = Buffer.alloc(12)
	head.write('RIFF', 0, 'ascii')
	head.writeUInt32LE(4 + body.length, 4)
	head.write('WEBP', 8, 'ascii')
	return Buffer.concat([head, body])
}
const vp8lChunk = () => {
	const data = Buffer.alloc(5)
	data[0] = 0x2f
	return chunk('VP8L', data)
}
const readVp8xFlags = webp => {
	let offset = 12
	while (offset + 8 <= webp.length) {
		const fourCC = webp.toString('ascii', offset, offset + 4)
		const size = webp.readUInt32LE(offset + 4)
		if (fourCC === 'VP8X') return webp[offset + 8]
		offset += 8 + size + (size % 2)
	}
	return undefined
}
const HASH = 'a'.repeat(64)

test('HB-498: addSoundSha256ToStickerWebP sets the VP8X EXIF flag 0x08, not ICCP 0x20 (existing VP8X)', () => {
	const vp8xData = Buffer.alloc(10)
	vp8xData[0] = 0x10 // alpha
	const webp = webpFromChunks([chunk('VP8X', vp8xData), vp8lChunk()])
	const out = addSoundSha256ToStickerWebP(webp, HASH)
	assert.equal(readVp8xFlags(out), 0x18, 'flags must be alpha|EXIF 0x10|0x08 (pre-fix: 0x30 with ICCP)')
})

test('HB-498: addSoundSha256ToStickerWebP sets the VP8X EXIF flag 0x08 on a synthesised VP8X header', () => {
	const out = addSoundSha256ToStickerWebP(webpFromChunks([vp8lChunk()]), HASH)
	assert.equal(readVp8xFlags(out), 0x08, 'synthesised VP8X must carry EXIF 0x08 only (pre-fix: 0x20)')
})

// ── HB-504 ───────────────────────────────────────────────────────────
test('HB-504: aunuGhostMention skips null / non-object participants instead of aborting', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.groupMetadata = async () => ({
			participants: [{ id: '628111@s.whatsapp.net' }, null, { id: '628222@s.whatsapp.net' }, 42, {}]
		})
		let sent = null
		sock.sendMessage = async (jid, content) => {
			sent = { jid, content }
			return { key: { id: 'x' } }
		}
		await sock.aunuGhostMention(GROUP, { text: 'hi' })
		assert.deepEqual(sent.content.mentions, ['628111@s.whatsapp.net', '628222@s.whatsapp.net'])
	} finally {
		endQuietly(sock)
	}
})

test('HB-504: aunuPersonalTagAll skips null / non-object participants and still returns { sent, failed }', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.groupMetadata = async () => ({
			participants: [{ id: '628111@s.whatsapp.net' }, null, { id: '628222@s.whatsapp.net' }, 42, {}]
		})
		sock.profilePictureUrl = async () => {
			throw new Error('no pp')
		}
		sock.sendMessage = async () => ({ key: { id: 'x' } })
		const res = await sock.aunuPersonalTagAll(GROUP, { delayMs: 0, text: 'Hai {mention}' })
		assert.equal(res.sent, 2, 'both valid members are tagged (pre-fix: raw TypeError, no result)')
		assert.ok(Array.isArray(res.failed))
	} finally {
		endQuietly(sock)
	}
})

// ── HB-511 ───────────────────────────────────────────────────────────
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')

test('HB-511: a throwing mediaCache.get is treated as a cache miss and the media still sends', async t => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'image/png' })
		res.end(PNG_1X1)
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
	})
	const url = `http://127.0.0.1:${server.address().port}/img.png`
	const mediaCache = {
		get: async () => {
			throw new Error('redis down')
		},
		set: async () => {}
	}
	const obj = await prepareWAMessageMedia(
		{ image: { url } },
		{
			logger: silentLogger,
			mediaCache,
			upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/fixture', directPath: '/fixture' }),
			jid: '628111@s.whatsapp.net'
		}
	)
	assert.ok(obj.imageMessage, 'the image message is built despite the cache get failure (pre-fix: rejected with the raw cache error)')
})

test('HB-511: a throwing mediaCache.set after a successful upload does not fail the send (main + newsletter branches)', async t => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'image/png' })
		res.end(PNG_1X1)
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
	})
	const url = `http://127.0.0.1:${server.address().port}/img.png`
	const mediaCache = {
		get: async () => undefined,
		set: async () => {
			throw new Error('redis down')
		}
	}
	const baseOpts = {
		logger: silentLogger,
		mediaCache,
		upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/fixture', directPath: '/fixture' })
	}
	const main = await prepareWAMessageMedia({ image: { url } }, { ...baseOpts, jid: '628111@s.whatsapp.net' })
	assert.ok(main.imageMessage, 'main branch: send succeeds despite set failure (pre-fix: rejected after upload)')
	const news = await prepareWAMessageMedia({ image: { url } }, { ...baseOpts, jid: NEWSLETTER })
	assert.ok(news.imageMessage, 'newsletter branch: send succeeds despite set failure (pre-fix: rejected after upload)')
})
