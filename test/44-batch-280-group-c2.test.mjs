// (44) Batch 2.8.0 — Group C part 2 regressions:
// HB-239 lid facet, HB-272 addendum (keyIndex 0), HB-273 addendum
// facet 1, HB-282 addendum 2, HB-320 addendum, HB-335 addendum,
// HB-365 addendum facet 1, HB-366 addendum facet 1, HB-370 addendum
// facet 3, HB-392 addendum, HB-417 addendum facet 2, HB-435 addendum
// facets 3/4/5, HB-478 addendum facets 5-9,
// HB-2026-1112-38 addendum, HB-2026-1112-112 addendum.
// (HB-446 addendum facet 2 is DEFERRED by this batch — see the batch
// report; no test for it here. HB-2026-1112-39 addendum is FIXED via
// the deferred retry-receipt in messages-recv; its timing behaviour
// is covered by the LAT-2 tests in test/30.)
// Fully offline & deterministic: crafted stanzas, local HTTP servers,
// stubbed fetch, temp dirs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = rel => path.join(ROOT, rel)

const { lib, silentLogger, tmpDir, sleep, makeOfflineSocket, fakeOpenTransport, endQuietly } = await import('./helpers.mjs')
const { configureSuccessfulPairing, generateRegistrationNode } = await import(L('lib/Utils/validate-connection.js'))
const { extractDeviceJids } = await import(L('lib/Utils/signal.js'))
const { Curve, hmacSign } = await import(L('lib/Utils/crypto.js'))
const { WA_ADV_ACCOUNT_SIG_PREFIX } = await import(L('lib/Defaults/index.js'))
const { waproto } = await import(L('WAProto/index.js'))
const { WebSocketClient } = await import(L('lib/Socket/Client/websocket.js'))
const { decodeBinaryNode } = await import(L('lib/WABinary/index.js'))
const processMessage = (await import(L('lib/Utils/process-message.js'))).default
const { encryptedStream, getWAUploadToServer, uploadWithFetch, downloadEncryptedContent, getMediaKeys } = await import(
	L('lib/Utils/messages-media.js')
)
const { useNyxAuthState, exportSessionBackup, importSessionBackup } = await import(L('lib/Utils/use-nyx-auth-state.js'))
const { downloadAndProcessHistorySyncNotification } = await import(L('lib/Utils/history.js'))

WebSocketClient.prototype.connect = () => {}

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode
const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}
const withTimeout = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

// ── HB-239 lid facet + HB-335 addendum (validate-connection) ───────

const buildPairStanza = ({ lid } = {}) => {
	const identKp = Curve.generateKeyPair()
	const advSecretKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')
	const acctKp = Curve.generateKeyPair()
	const deviceDetails = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
	const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, identKp.public])
	const accountSignature = Curve.sign(acctKp.private, accountMsg)
	const account = { accountSignatureKey: acctKp.public, accountSignature, details: deviceDetails }
	const details = waproto.ADVSignedDeviceIdentity.encode(account).finish()
	const hmac = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
	const hmacNode = waproto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish()
	const deviceAttrs = { jid: '6281234567890:12@s.whatsapp.net' }
	if (lid) deviceAttrs.lid = lid
	const stanza = {
		tag: 'iq',
		attrs: { id: 'pair-1', type: 'set' },
		content: [
			{
				tag: 'pair-success',
				attrs: {},
				content: [
					{ tag: 'device-identity', attrs: {}, content: hmacNode },
					{ tag: 'device', attrs: deviceAttrs },
					{ tag: 'platform', attrs: { name: 'TestPlatform' } }
				]
			}
		]
	}
	return { stanza, creds: { advSecretKey, signedIdentityKey: identKp, signalIdentities: [] } }
}

test('HB-239 lid facet: pair-success without lid stores NO signal identity; with lid it stores one named entry', () => {
	const noLid = buildPairStanza()
	const r1 = configureSuccessfulPairing(noLid.stanza, noLid.creds)
	assert.deepEqual(r1.creds.signalIdentities, [], 'a nameless identity must not be stored when lid is absent')
	assert.equal(r1.creds.me.lid, undefined, 'me.lid stays legally undefined')

	const withLid = buildPairStanza({ lid: '100000000000001@lid' })
	const r2 = configureSuccessfulPairing(withLid.stanza, withLid.creds)
	assert.equal(r2.creds.signalIdentities.length, 1)
	assert.equal(r2.creds.signalIdentities[0].identifier.name, '100000000000001@lid')
})

test('HB-335 addendum: generateRegistrationNode falls back to the default version for wrong-typed version elements', () => {
	const keyPair = Curve.generateKeyPair()
	const base = {
		registrationId: 12345,
		signedIdentityKey: keyPair,
		signedPreKey: { keyId: 5, keyPair, signature: Buffer.alloc(64) }
	}
	const good = generateRegistrationNode(base, { version: [2, 3000, 1043857760], browser: ['Test', 'Chrome', '1.0.0'] })
	const fromStrings = generateRegistrationNode(base, { version: ['a', 'b', 'c'], browser: ['Test', 'Chrome', '1.0.0'] })
	assert.deepEqual(
		Buffer.from(fromStrings.devicePairingData.buildHash),
		Buffer.from(good.devicePairingData.buildHash),
		'string version elements must fall back to the default version, not hash a.b.c'
	)
	const fromNaN = generateRegistrationNode(base, { version: [2, NaN, 1043857760], browser: ['Test', 'Chrome', '1.0.0'] })
	assert.deepEqual(Buffer.from(fromNaN.devicePairingData.buildHash), Buffer.from(good.devicePairingData.buildHash), 'a NaN element must fall back whole')
	// numeric browser elements used to die as a raw TypeError in getPlatformType/getUserAgent
	assert.doesNotThrow(() => generateRegistrationNode(base, { version: [2, 3000, 1043857760], browser: [1, 2, 3] }))
})

// ── HB-272 addendum: keyIndex 0 ────────────────────────────────────

test('HB-272 addendum: extractDeviceJids keeps a non-zero device with keyIndex 0, still drops absent/NaN keyIndex', () => {
	const run = deviceList =>
		extractDeviceJids(
			[{ id: '6281111111111@s.whatsapp.net', devices: { deviceList } }],
			'6289999999999@s.whatsapp.net',
			'',
			false
		)
	assert.equal(run([{ id: 1, keyIndex: 0 }]).length, 1, 'keyIndex 0 is a real index and must be kept')
	assert.equal(run([{ id: 1 }]).length, 0, 'absent keyIndex still excluded')
	assert.equal(run([{ id: 1, keyIndex: NaN }]).length, 0, 'NaN keyIndex still excluded')
	assert.equal(run([{ id: 0 }]).length, 1, 'device 0 needs no keyIndex (control)')
})

// ── HB-282 addendum 2: relayMessage without options ────────────────

test('HB-282 addendum 2: sock.relayMessage with two arguments does not die on destructuring the missing options', async () => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	try {
		const err = await sock
			.relayMessage('6281111111111@s.whatsapp.net', { conversation: 'hi' })
			.then(() => null, e => e)
		assert.ok(err, 'the send must fail offline (no devices resolvable), not succeed')
		assert.ok(
			!/Cannot destructure|Cannot read properties of undefined/.test(err.message),
			`must not be the raw options-destructuring TypeError, got: ${err.message}`
		)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-320 addendum: JOIN_APPROVAL with JSON null participant ──────

test('HB-320 addendum: a join-approval stub whose participant parses to null is skipped, not a TypeError', async () => {
	const events = []
	const ev = new EventEmitter()
	ev.on('group.join-request', e => events.push(e))
	const ctx = {
		ev,
		creds: { me: { id: '6289999999@s.whatsapp.net', lid: '100000000000001@lid' }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {},
		keyStore: {},
		options: {},
		getMessage: async () => undefined,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
	const stubType = waproto.WebMessageInfo.StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
	const msg = {
		key: { remoteJid: '120363123456789@g.us', id: 'STUB1', fromMe: false, participant: '6281111111111@s.whatsapp.net' },
		messageStubType: stubType,
		messageStubParameters: ['null', 'added', 'invite']
	}
	await processMessage(msg, ctx)
	assert.deepEqual(events, [], 'no group.join-request may be emitted for a null participant')
	// control: a real participant still emits
	const msg2 = {
		...msg,
		key: { ...msg.key, id: 'STUB2' },
		messageStubParameters: [JSON.stringify({ lid: '100000000000002@lid', pn: '6282222222222@s.whatsapp.net' }), 'added', 'invite']
	}
	await processMessage(msg2, ctx)
	assert.equal(events.length, 1, 'control: a valid participant still emits group.join-request')
})

// ── HB-370 addendum facet 3: pending-buffer REVOKE re-key ──────────

test('HB-370 addendum facet 3: a REVOKE update buffered before the upsert must not re-key the upsert', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const upserts = []
	ev.on('messages.upsert', ({ messages }) => upserts.push(...messages))
	const targetKey = { remoteJid: '6281111111111@s.whatsapp.net', id: 'TARGET123', fromMe: false }
	const protoKey = { remoteJid: '6281111111111@s.whatsapp.net', id: 'PROTO999', fromMe: true }
	const work = ev.createBufferedFunction(async () => {
		ev.emit('messages.update', [{ key: targetKey, update: { key: protoKey, status: 5 } }])
		ev.emit('messages.upsert', {
			messages: [{ key: targetKey, message: { conversation: 'real message' }, messageTimestamp: 1760000000 }],
			type: 'notify'
		})
	})
	await work()
	await sleep(250)
	const delivered = upserts.find(m => m.message?.conversation === 'real message')
	assert.ok(delivered, 'the upsert must be delivered')
	assert.equal(delivered.key.id, 'TARGET123', `the upsert must keep its own key, got ${delivered.key.id}`)
	ev.destroy()
})

// ── HB-366 addendum facet 1: initial host dedup ────────────────────

test('HB-366 addendum facet 1: getWAUploadToServer tries a duplicated initial host only once', async () => {
	const attempted = []
	const recordingLogger = {
		level: 'trace',
		child() {
			return this
		},
		trace() {},
		debug(msg) {
			if (typeof msg === 'string' && msg.startsWith('uploading to')) attempted.push(msg)
		},
		info() {},
		warn() {},
		error() {},
		fatal() {}
	}
	const dead = '127.0.0.1:1'
	const refreshMediaConn = async () => ({ auth: 'auth', hosts: [{ hostname: dead }], ttl: 3600 })
	const upload = getWAUploadToServer(
		{ customUploadHosts: [{ hostname: dead }], fetchAgent: undefined, logger: recordingLogger, options: {} },
		refreshMediaConn
	)
	const dir = tmpDir('aunu-c2-hb366-')
	const filePath = path.join(dir, 'media.bin')
	fs.writeFileSync(filePath, Buffer.alloc(32, 1))
	await assert.rejects(upload(filePath, { mediaType: 'image', fileEncSha256B64: 'AAAA', timeoutMs: 2_000 }), err =>
		isBoom(err, 500)
	)
	assert.equal(attempted.length, 1, `the same hostname must be attempted once, got ${attempted.length}: ${attempted.join(', ')}`)
})

// ── HB-392 addendum: uploadWithFetch abort translation ─────────────

test('HB-392 addendum: uploadWithFetch surfaces a fetch abort as Boom 408, not a raw DOMException', async t => {
	const dir = tmpDir('aunu-c2-hb392-')
	const filePath = path.join(dir, 'up.bin')
	fs.writeFileSync(filePath, Buffer.alloc(64, 2))
	const realFetch = globalThis.fetch
	t.after(() => {
		globalThis.fetch = realFetch
	})
	globalThis.fetch = async () => {
		throw new DOMException('The operation timed out', 'TimeoutError')
	}
	await assert.rejects(
		uploadWithFetch({ url: 'https://mmg.whatsapp.net/up', filePath, headers: {}, timeoutMs: 1_000 }),
		err => isBoom(err, 408),
		'a fetch-phase abort must be Boom 408'
	)
	// mid-body: headers arrive, reader.read() aborts
	globalThis.fetch = async () => ({
		status: 200,
		headers: { get: () => null },
		body: {
			getReader: () => ({
				read: async () => {
					throw new DOMException('The operation timed out', 'TimeoutError')
				},
				cancel: async () => {}
			})
		}
	})
	await assert.rejects(
		uploadWithFetch({ url: 'https://mmg.whatsapp.net/up', filePath, headers: {}, timeoutMs: 1_000 }),
		err => isBoom(err, 408),
		'a mid-body abort must be Boom 408'
	)
})

// ── HB-417 addendum facet 2: source error mid-body on a ranged dl ──

test('HB-417 addendum facet 2: a source error mid-body on a ranged download surfaces Boom 502 truncation', async t => {
	const mediaKey = Crypto.randomBytes(32)
	const keys = await getMediaKeys(mediaKey, 'image')
	const plaintext = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
	const cipher = Crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const mac = Crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	const validBody = Buffer.concat([ciphertext, mac])

	const server = http.createServer((req, res) => {
		const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
		const start = Number(m[1])
		const end = m[2] ? Number(m[2]) : validBody.length - 1
		const clampedEnd = Math.min(end, validBody.length - 1)
		const slice = validBody.subarray(start, clampedEnd + 1)
		res.writeHead(206, {
			'Content-Type': 'application/octet-stream',
			'Content-Range': `bytes ${start}-${clampedEnd}/${validBody.length}`,
			'Content-Length': String(slice.length)
		})
		// deliver half the promised slice, then destroy the socket:
		// a source ERROR mid-body, not a clean EOF
		res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => res.socket.destroy())
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
	})
	const base = `http://127.0.0.1:${server.address().port}`
	await assert.rejects(
		withTimeout(
			(async () => consume(await downloadEncryptedContent(`${base}/media`, keys, { startByte: 1000, endByte: 2000 })))(),
			5000,
			'range-source-error'
		),
		err => isBoom(err, 502) && /Truncated/.test(err.message),
		'a mid-body source error on a short ranged body must be the Boom 502 truncation, not the raw socket error'
	)
})

// ── HB-435 addendum facets 3/4/5 ───────────────────────────────────

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

// Answer every IQ with the given result content (or never, when null).
const answeringSocket = async (answerContent, matchXmlns) => {
	const sock = await makeOfflineSocket({ fireInitQueries: false })
	fakeOpenTransport(sock)
	if (answerContent !== null) {
		const origSend = sock.ws.socket.send.bind(sock.ws.socket)
		sock.ws.socket.send = (data, cb) => {
			origSend(data, cb)
			decodeFrame(data)
				.then(node => {
					if (node?.tag !== 'iq' || !node.attrs?.id) return
					if (matchXmlns && node.attrs.xmlns !== matchXmlns) return
					sock.ws.emit(`TAG:${node.attrs.id}`, {
						tag: 'iq',
						attrs: { type: 'result', id: node.attrs.id },
						content: answerContent
					})
				})
				.catch(() => {})
		}
	}
	return sock
}

test('HB-435 facet 3: newsletterFetchMessages rejects Boom 408 on IQ timeout instead of returning undefined', async () => {
	const sock = await answeringSocket(null)
	try {
		await assert.rejects(sock.newsletterFetchMessages('120363123456789@newsletter', 10, 0, 0), err => isBoom(err, 408))
	} finally {
		endQuietly(sock)
	}
})

test('HB-435 facet 4: groupFetchAllParticipating rejects Boom 502 on a bare result IQ, accepts an empty <groups/>', async () => {
	const bare = await answeringSocket([])
	const updates = []
	bare.ev.on('groups.update', u => updates.push(u))
	try {
		await assert.rejects(bare.groupFetchAllParticipating(), err => isBoom(err, 502))
		assert.deepEqual(updates, [], 'no groups.update may be emitted for a bare result')
	} finally {
		endQuietly(bare)
	}

	const empty = await answeringSocket([{ tag: 'groups', attrs: {}, content: [] }])
	try {
		const data = await empty.groupFetchAllParticipating()
		assert.deepEqual(data, {}, 'a present-but-empty <groups/> is a legitimate empty success')
	} finally {
		endQuietly(empty)
	}
})

test('HB-435 facet 5: resyncAppState rejects Boom 502 on a bare result IQ without <sync>', async () => {
	const sock = await answeringSocket([], 'w:sync:app:state')
	try {
		await assert.rejects(sock.resyncAppState(['regular_low'], false), err => isBoom(err, 502))
	} finally {
		endQuietly(sock)
	}
})

// ── HB-478 addendum facets 5-9 + HB-365 fsync (nyx) ────────────────

const aunuError = err => err instanceof Error && err.message.startsWith('aunu:')

test('HB-478 facets 7/8/9: importSessionBackup rejects non-Buffer, non-JSON and null/array top levels with aunu: errors', async () => {
	const dir = tmpDir('aunu-c2-hb478-')
	await assert.rejects(importSessionBackup(dir, null), aunuError, 'null argument')
	await assert.rejects(importSessionBackup(dir, undefined), aunuError, 'undefined argument')
	await assert.rejects(importSessionBackup(dir, 42), aunuError, 'numeric argument')
	await assert.rejects(importSessionBackup(dir, 'a string'), aunuError, 'string argument')
	await assert.rejects(importSessionBackup(dir, Buffer.from('this is not json')), aunuError, 'non-JSON bytes')
	await assert.rejects(importSessionBackup(dir, Buffer.from('null')), aunuError, 'JSON null top level')
	await assert.rejects(importSessionBackup(dir, Buffer.from('[1,2]')), aunuError, 'JSON array top level')
})

test('HB-478 facets 5/6: importSessionBackup rejects array and wrong-shape payloads for key files', async () => {
	const srcDir = tmpDir('aunu-c2-hb478-src-')
	const first = await useNyxAuthState(srcDir)
	await first.saveCreds()
	await first.state.keys.set({ session: { '111.0': Buffer.from(JSON.stringify({ _sessions: {}, version: '1' })) } })
	const backup = await exportSessionBackup(srcDir)
	const bundle = JSON.parse(backup.toString('utf-8'))
	const sessionName = Object.keys(bundle.files).find(n => n.startsWith('session-'))
	assert.ok(sessionName, 'fixture bundle must carry a session file')

	const withPayload = payload => {
		const copy = JSON.parse(backup.toString('utf-8'))
		copy.files[sessionName] = Buffer.from(payload, 'utf-8').toString('base64')
		return Buffer.from(JSON.stringify(copy))
	}
	const dir = tmpDir('aunu-c2-hb478-dst-')
	await assert.rejects(importSessionBackup(dir, withPayload('[1,2]')), err => aunuError(err) && /array payload/.test(err.message))
	await assert.rejects(
		importSessionBackup(dir, withPayload('{"foo":1}')),
		err => aunuError(err) && /not a recognised store record/.test(err.message)
	)
	// control: the untouched bundle still imports
	await importSessionBackup(dir, backup)
	const second = await useNyxAuthState(dir)
	assert.equal(second.state.creds.registrationId, first.state.creds.registrationId)
})

test('HB-365 addendum facet 1: nyx saveCreds fsyncs the .bak write as well as the base write (strace)', async t => {
	const hasStrace = await execFileAsync('which', ['strace']).then(() => true, () => false)
	if (!hasStrace) {
		t.skip('strace unavailable')
		return
	}
	const dir = tmpDir('aunu-c2-hb365-')
	const script = path.join(dir, 'save.mjs')
	const traceOut = path.join(dir, 'trace.log')
	fs.writeFileSync(
		script,
		`import { useNyxAuthState } from ${JSON.stringify(pathToFileURL(L('lib/Utils/use-nyx-auth-state.js')))}\n` +
			`const { state, saveCreds } = await useNyxAuthState(process.argv[2])\n` +
			`state.creds.me = { id: '6281111111111@s.whatsapp.net', name: 'T' }\n` +
			`await saveCreds()\n`
	)
	await execFileAsync('strace', ['-f', '-e', 'trace=fsync,fdatasync', '-o', traceOut, 'node', script, dir])
	const trace = fs.readFileSync(traceOut, 'utf-8')
	const fsyncs = trace.split('\n').filter(l => /fsync|fdatasync/.test(l) && !/ENOENT|EINVAL/.test(l)).length
	// base saveCreds contributes file+dir (2); the .bak write must
	// contribute its own file+dir (2 more) after the fix — without
	// it the total stays at 2.
	assert.ok(fsyncs >= 4, `expected >= 4 fsync calls (base 2 + .bak 2), got ${fsyncs}`)
})

// ── HB-273 addendum facet 1: finish-phase dual-stream race ─────────
// Runs in a child process whose preload swaps the '-original' write
// stream for one that fails at _final (flush-phase ENOSPC). Without
// the fix, the original stream's finish promise is orphaned when the
// enc await throws first (or rejects a tick early) and the child
// reports an unhandledRejection; with the joint Promise.all await
// the error is the rejection of encryptedStream itself and nothing
// is unhandled.

test('HB-273 addendum facet 1: encryptedStream finish-phase errors are not unhandled rejections', async () => {
	const dir = tmpDir('aunu-c2-hb273-')
	const wrap = path.join(dir, 'fs-wrap.mjs')
	fs.writeFileSync(
		wrap,
		`import fs from 'node:fs'\n` +
			`import { Writable } from 'node:stream'\n` +
			`export * from 'node:fs'\n` +
			`const orig = fs.createWriteStream\n` +
			`export const createWriteStream = (p, opts) => {\n` +
			`\tif (String(p).includes('-original') || String(p).includes('-enc')) {\n` +
			`\t\treturn new Writable({\n` +
			`\t\t\twrite(chunk, enc, cb) { cb() },\n` +
			`\t\t\tfinal(cb) { cb(new Error('ENOSPC-simulated-flush:' + String(p).split('/').pop())) }\n` +
			`\t\t})\n` +
			`\t}\n` +
			`\treturn orig(p, opts)\n` +
			`}\n` +
			`export default fs\n`
	)
	const loader = path.join(dir, 'loader.mjs')
	fs.writeFileSync(
		loader,
		`export async function resolve(specifier, context, next) {\n` +
			`\tif (specifier === 'fs' && context.parentURL && context.parentURL.includes('messages-media')) {\n` +
			`\t\treturn { url: ${JSON.stringify(pathToFileURL(wrap))}, shortCircuit: true }\n` +
			`\t}\n` +
			`\treturn next(specifier, context)\n` +
			`}\n`
	)
	const child = path.join(dir, 'child.mjs')
	fs.writeFileSync(
		child,
		`const unhandled = []\n` +
			`process.on('unhandledRejection', err => unhandled.push(String(err && err.message || err)))\n` +
			`const { encryptedStream } = await import(${JSON.stringify(pathToFileURL(L('lib/Utils/messages-media.js')))})\n` +
			`let thrown = null\n` +
			`try {\n` +
			`\tawait encryptedStream(Buffer.alloc(65536, 7), 'image', { saveOriginalFileIfRequired: true })\n` +
			`} catch (err) { thrown = String(err && err.message || err) }\n` +
			`await new Promise(r => setTimeout(r, 300))\n` +
			`console.log(JSON.stringify({ thrown, unhandled }))\n`
	)
	const { stdout } = await execFileAsync('node', ['--experimental-loader', loader, child], { timeout: 30_000 })
	const result = JSON.parse(stdout.trim().split('\n').pop())
	assert.ok(/ENOSPC-simulated-flush:/.test(result.thrown || ''), `encryptedStream must reject with a flush error, got ${result.thrown}`)
	assert.deepEqual(result.unhandled, [], 'no unhandled rejection may escape the finish phase')
})

// ── HB-2026-1112-38 addendum: rollback must not clobber a sibling ──

test('HB-2026-1112-38 addendum: a failing commit rolls back its own files but keeps a sibling writer commit', async () => {
	const { useMultiFileAuthState } = await import(L('lib/Utils/use-multi-file-auth-state.js'))
	const dir = tmpDir('aunu-c2-hb38-')
	const a = await useMultiFileAuthState(dir)
	const b = await useMultiFileAuthState(dir)

	// seed V0 for one early file so rollback has something to restore
	await a.state.keys.set({ session: { 's000': Buffer.from('V0') } })

	// A's batch: many session files (sorted) ending at s999. Its
	// target starts as a regular file (so A's snapshot phase reads
	// it fine) and is swapped for a DIRECTORY mid-commit, so A's
	// write of it fails (EISDIR on rename) after the earlier files
	// have landed — the t1133 interleave.
	fs.writeFileSync(path.join(dir, 'session-s999.json'), 'OLD999')
	const batch = {}
	for (let i = 0; i < 120; i++) {
		batch[`s${String(i).padStart(3, '0')}`] = Buffer.from(`VA-${i}`)
	}
	batch['s999'] = Buffer.from('VA-999')
	const aPromise = a.state.keys.set({ session: batch })
	const aOutcome = aPromise.then(() => null, err => err)

	// while A is mid-commit (an intermediate file has landed), B
	// commits a newer value for s010 — a file A has ALREADY written
	// (it sorts before the poll marker), so B's commit is strictly
	// newer than A's write of it
	const landed = await (async () => {
		for (let i = 0; i < 200; i++) {
			if (fs.existsSync(path.join(dir, 'session-s030.json'))) return true
			await sleep(5)
		}
		return false
	})()
	assert.ok(landed, 'A must be mid-commit before B writes')
	fs.unlinkSync(path.join(dir, 'session-s999.json'))
	fs.mkdirSync(path.join(dir, 'session-s999.json'))
	await b.state.keys.set({ session: { 's010': Buffer.from('VB-010') } })

	const aErr = await aOutcome
	assert.ok(aErr, 'A commit must fail on the directory target')

	const read = async id => {
		const got = await a.state.keys.get('session', [id])
		return got[id]?.toString()
	}
	assert.equal(await read('s010'), 'VB-010', "B's committed value must survive A's rollback")
	assert.equal(await read('s000'), 'V0', "A's own earlier file rolls back to its snapshot")
	assert.equal(await read('s001'), undefined, "A's own new file rolls back to absent")
})

// ── HB-2026-1112-112 addendum: history inflate cap ─────────────────

test('HB-2026-1112-112 addendum: an inline history payload inflating past the cap is refused descriptively', async () => {
	// 260 MiB of zeros deflates to a few hundred KB; the inflated
	// size crosses the 256 MiB cap, so the refusal must name the cap
	// instead of decoding (or OOMing on) the inflated buffer.
	const payload = deflateSync(Buffer.alloc(260 * 1024 * 1024))
	await assert.rejects(
		downloadAndProcessHistorySyncNotification({ initialHistBootstrapInlinePayload: payload }, {}),
		err => /inflated-size cap/.test(err.message),
		'an over-cap inline payload must be refused with the cap error'
	)
})
