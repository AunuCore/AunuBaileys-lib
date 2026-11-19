// (18) Batch 2.3.0 — Cluster D (send/media/binary/usync) regressions:
// HB-344 addendum (sticker-pack host signal), HB-372, HB-282 addenda
// (relay guards + USync setAt), HB-381, HB-325 addendum, HB-384,
// HB-385, HB-387, HB-208 addenda (getStream validation + tmp leaks),
// HB-392 (+addendum), HB-252 addendum, HB-399, HB-400, HB-402.
// Fully offline & deterministic: local HTTP servers, stubbed fetch,
// fabricated USync/key-bundle answers over a fake transport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = rel => path.join(ROOT, rel)

const {
	getStream,
	getHttpStream,
	getRawMediaUploadData,
	encryptedStream,
	uploadWithNodeHttp,
	sanitizeMediaTimeoutMs
} = await import(L('lib/Utils/messages-media.js'))
const { generateWAMessageContent, prepareStickerPackMessage, downloadMediaMessage } = await import(
	L('lib/Utils/messages.js')
)
const { uploadingNecessaryImages } = await import(L('lib/Utils/business.js'))
const { decodeBinaryNode } = await import(L('lib/WABinary/decode.js'))
const { encodeBinaryNode } = await import(L('lib/WABinary/encode.js'))
const { USyncStatusProtocol } = await import(L('lib/WAUSync/Protocols/USyncStatusProtocol.js'))
const { USyncDisappearingModeProtocol } = await import(L('lib/WAUSync/Protocols/USyncDisappearingModeProtocol.js'))
const { USyncTextStatusProtocol } = await import(L('lib/WAUSync/Protocols/USyncTextStatusProtocol.js'))
const { USyncBotProfileProtocol } = await import(L('lib/WAUSync/Protocols/UsyncBotProfileProtocol.js'))

const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode
const WEBP_1X1 = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')

// ── HB-392: timeout sanitisation ────────────────────────────────────
test('HB-392: sanitizeMediaTimeoutMs falls back for 0/negative/NaN/Infinity/non-number', () => {
	for (const bad of [0, -1, NaN, Infinity, -Infinity, undefined, null, '500', {}]) {
		assert.equal(sanitizeMediaTimeoutMs(bad), 120_000, `value ${String(bad)}`)
		assert.equal(sanitizeMediaTimeoutMs(bad, 30_000), 30_000, `fallback for ${String(bad)}`)
	}
	assert.equal(sanitizeMediaTimeoutMs(250), 250)
	assert.equal(sanitizeMediaTimeoutMs(250, 30_000), 250)
})

// ── HB-208 addendum: getStream validation ───────────────────────────
test('HB-208: getStream rejects unusable stream members and bad URL schemes with Boom 400', async () => {
	for (const bad of [{ stream: null }, { stream: 42 }, { stream: {} }, { stream: 'abc' }]) {
		await assert.rejects(getStream(bad), err => isBoom(err, 400), JSON.stringify(bad))
	}
	await assert.rejects(getStream({ url: new URL('ftp://example.com/x.bin') }), err => isBoom(err, 400))
	await assert.rejects(getStream({ url: 'ftp://example.com/x.bin' }), err => isBoom(err, 400))
	const ok = await getStream({ stream: Readable.from(['x']) })
	assert.equal(ok.type, 'readable')
	const okBuf = await getStream(Buffer.from('x'))
	assert.equal(okBuf.type, 'buffer')
})

// ── HB-384 + HB-392: getHttpStream null body / abort translation ────
test('HB-384: getHttpStream on a 204 (null body) fails with a Boom carrying the status, not a raw TypeError', async () => {
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, status: 204, body: null })
	try {
		await assert.rejects(
			getHttpStream('http://127.0.0.1/empty'),
			err => isBoom(err, 502) && err.data?.status === 204 && !(err instanceof TypeError)
		)
	} finally {
		globalThis.fetch = realFetch
	}
})

test('HB-392: getHttpStream translates a timeout abort into Boom 408', async () => {
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => {
		throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
	}
	try {
		await assert.rejects(getHttpStream('http://127.0.0.1/slow'), err => isBoom(err, 408))
	} finally {
		globalThis.fetch = realFetch
	}
})

// ── HB-372: synchronous http.request throw must not orphan the deadline timer ──
test('HB-372: uploadWithNodeHttp rejects cleanly on a synchronous request() throw; no TDZ crash follows', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb372-'))
	const filePath = path.join(dir, 'up.bin')
	fs.writeFileSync(filePath, Buffer.alloc(64, 1))
	const uncaught = []
	const onUncaught = err => uncaught.push(err)
	process.on('uncaughtException', onUncaught)
	try {
		await assert.rejects(
			uploadWithNodeHttp({
				url: 'http://127.0.0.1:9/upload',
				filePath,
				headers: { 'x-bad': 'inv\x01alid' },
				timeoutMs: 120
			}),
			err => err?.code === 'ERR_INVALID_CHAR' && !(err instanceof ReferenceError)
		)
		// the pre-fix orphan timer fired at ~timeoutMs with a TDZ
		// ReferenceError (stream/req not yet initialised)
		await new Promise(r => setTimeout(r, 400))
		assert.deepEqual(uncaught, [])
	} finally {
		process.off('uncaughtException', onUncaught)
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

// ── HB-385: BINARY_32 length with the top bit set must error, not silently empty ──
test('HB-385: decodeBinaryNode rejects a poisoned BINARY_32 length (first byte >= 0x80)', async () => {
	const payload = Buffer.alloc(1_100_000, 7) // > 2^20 forces the BINARY_32 length form
	const encoded = encodeBinaryNode({ tag: 'message', attrs: {}, content: payload })
	const ok = await decodeBinaryNode(encoded)
	assert.equal(ok.content.length, 1_100_000)
	const lenPos = encoded.indexOf(Buffer.from([0x00, 0x10, 0xc8, 0xe0])) // 1100000 as u32 BE
	assert.ok(lenPos > 0, 'length prefix located')
	const poisoned = Buffer.from(encoded)
	poisoned[lenPos] = 0x80
	await assert.rejects(decodeBinaryNode(poisoned), /end of stream/i)
})

// ── HB-282 addendum: USync setAt must not fabricate epoch / Invalid Date ──
test('HB-282: USync parsers leave setAt undefined for missing/non-numeric t', () => {
	const status = new USyncStatusProtocol()
	const noT = status.parser({ tag: 'status', attrs: {}, content: Buffer.from('online') })
	assert.equal(noT.status, 'online')
	assert.equal(noT.setAt, undefined)
	const badT = status.parser({ tag: 'status', attrs: { t: 'abc' }, content: Buffer.from('online') })
	assert.equal(badT.setAt, undefined)
	const goodT = status.parser({ tag: 'status', attrs: { t: '1700000000' }, content: Buffer.from('online') })
	assert.equal(goodT.setAt.getTime(), 1_700_000_000_000)

	const dm = new USyncDisappearingModeProtocol()
	const dmNoT = dm.parser({ tag: 'disappearing_mode', attrs: { duration: '86400' } })
	assert.equal(dmNoT.duration, 86400)
	assert.equal(dmNoT.setAt, undefined)
	const dmGood = dm.parser({ tag: 'disappearing_mode', attrs: { duration: '86400', t: '1700000000' } })
	assert.equal(dmGood.setAt.getTime(), 1_700_000_000_000)

	const ts = new USyncTextStatusProtocol()
	const tsNoT = ts.parser({ tag: 'text_status', attrs: { text: 'hi' } })
	assert.equal(tsNoT.setAt, undefined)
	assert.equal(tsNoT.expiresAt, null)
	const tsGood = ts.parser({
		tag: 'text_status',
		attrs: { text: 'hi', last_update_time: '1700000000', ephemeral_duration_sec: '60' }
	})
	assert.equal(tsGood.setAt.getTime(), 1_700_000_000_000)
	assert.equal(tsGood.expiresAt.getTime(), 1_700_000_060_000)
})

// ── HB-402: bot-profile parser reads <profile> from the <bot> node itself ──
test('HB-402: USyncBotProfileProtocol.parser parses a real <bot> node and returns null for an empty one', () => {
	const proto_ = new USyncBotProfileProtocol()
	const str = s => Buffer.from(s)
	const botNode = {
		tag: 'bot',
		attrs: { jid: '123456789@bot' },
		content: [
			{
				tag: 'profile',
				attrs: { persona_id: 'persona-1' },
				content: [
					{ tag: 'name', attrs: {}, content: str('Botty') },
					{ tag: 'attributes', attrs: {}, content: str('attr') },
					{ tag: 'description', attrs: {}, content: str('desc') },
					{ tag: 'category', attrs: {}, content: str('cat') },
					{
						tag: 'commands',
						attrs: {},
						content: [
							{ tag: 'description', attrs: {}, content: str('cmds desc') },
							{
								tag: 'command',
								attrs: {},
								content: [
									{ tag: 'name', attrs: {}, content: str('help') },
									{ tag: 'description', attrs: {}, content: str('shows help') }
								]
							}
						]
					},
					{
						tag: 'prompts',
						attrs: {},
						content: [
							{
								tag: 'prompt',
								attrs: {},
								content: [
									{ tag: 'emoji', attrs: {}, content: str('👋') },
									{ tag: 'text', attrs: {}, content: str('say hi') }
								]
							}
						]
					}
				]
			}
		]
	}
	const info = proto_.parser(botNode)
	assert.equal(info.name, 'Botty')
	assert.equal(info.personaId, 'persona-1')
	assert.equal(info.jid, '123456789@bot')
	assert.deepEqual(info.commands, [{ name: 'help', description: 'shows help' }])
	assert.deepEqual(info.prompts, ['👋 say hi'])
	assert.equal(proto_.parser({ tag: 'bot', attrs: { jid: '123456789@bot' }, content: [] }), null)
})

// ── HB-381: viewOnce must wrap AFTER mentions/contextInfo are applied ──
test('HB-381: viewOnce messages keep their mentions and contextInfo', async () => {
	const PEER = '6281234567890@s.whatsapp.net'
	const m = await generateWAMessageContent({ text: 'hi', mentions: [PEER], viewOnce: true }, {})
	const inner = m.viewOnceMessage.message
	assert.deepEqual(inner.extendedTextMessage.contextInfo.mentionedJid, [PEER])

	const m2 = await generateWAMessageContent(
		{ text: 'hi', mentions: [PEER], contextInfo: { stanzaId: 'STANZA-1' }, viewOnce: true },
		{}
	)
	const inner2 = m2.viewOnceMessage.message
	assert.equal(inner2.extendedTextMessage.contextInfo.stanzaId, 'STANZA-1')
	assert.deepEqual(inner2.extendedTextMessage.contextInfo.mentionedJid, [PEER])
})

// ── HB-325 addendum: poll.endDate validation ────────────────────────
test('HB-325: a non-Date poll.endDate is a Boom 400, not a raw TypeError', async () => {
	for (const bad of ['tomorrow', 1_700_000_000_000, new Date('not a date')]) {
		await assert.rejects(
			generateWAMessageContent({ poll: { name: 'q', values: ['a', 'b'], selectableCount: 1, endDate: bad } }, {}),
			err => isBoom(err, 400) && /poll\.endDate/.test(err.message),
			`endDate=${String(bad)}`
		)
	}
	const ok = await generateWAMessageContent(
		{ poll: { name: 'q', values: ['a', 'b'], selectableCount: 1, endDate: new Date(1_800_000_000_000) } },
		{}
	)
	const pollMsg = ok.pollCreationMessageV3 || ok.pollCreationMessage
	assert.ok(pollMsg, 'poll message created')
	assert.equal(Number(pollMsg.endTime), 1_800_000_000_000)
})

// ── HB-344 addendum + HB-392: sticker-pack downloads honour the host signal / sanitised budget ──
test('HB-344: prepareStickerPackMessage forwards the host abort signal to sticker downloads', async () => {
	const hanging = http.createServer(() => {})
	await new Promise(r => hanging.listen(0, '127.0.0.1', r))
	const port = hanging.address().port
	try {
		const started = Date.now()
		await assert.rejects(
			prepareStickerPackMessage(
				{
					stickers: [{ data: { url: `http://127.0.0.1:${port}/s.webp` } }],
					cover: WEBP_1X1,
					name: 'Pack',
					publisher: 'tester'
				},
				{
					upload: async () => ({ directPath: '/unused' }),
					mediaUploadTimeoutMs: 120_000,
					options: { signal: AbortSignal.timeout(250) },
					logger: silentLogger
				}
			),
			err => isBoom(err, 400) && /sticker/i.test(err.message)
		)
		assert.ok(Date.now() - started < 8_000, 'host signal aborted the download promptly')
	} finally {
		hanging.closeAllConnections?.()
		await new Promise(r => hanging.close(r))
	}
})

test('HB-392: prepareStickerPackMessage survives mediaUploadTimeoutMs = NaN (no synchronous RangeError)', async () => {
	const result = await prepareStickerPackMessage(
		{ stickers: [{ data: WEBP_1X1 }], cover: WEBP_1X1, name: 'Pack', publisher: 'tester' },
		{
			upload: async () => ({ directPath: '/sticker-pack/abc' }),
			mediaUploadTimeoutMs: NaN,
			logger: silentLogger
		}
	)
	assert.ok(result.stickerPackMessage.stickerPackId)
	assert.equal(result.stickerPackMessage.stickers.length, 1)
})

// ── HB-392 addendum: business.ts upload timeout is sanitised ────────
test('HB-392: uploadingNecessaryImages survives a NaN timeoutMs', async () => {
	const urls = await uploadingNecessaryImages([WEBP_1X1], async () => ({ directPath: '/v/t62/img.jpg' }), NaN)
	assert.equal(urls.length, 1)
	assert.match(urls[0].url, /^https:\/\/mmg\.whatsapp\.net\/v\/t62\/img\.jpg/)
})

// ── HB-208 addendum: a throwing stream.destroy() in catch blocks must not leak tmp files ──
test('HB-208: getRawMediaUploadData/encryptedStream clean up tmp files even when stream.destroy() throws', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb208-'))
	const prevTmp = process.env.TMPDIR
	process.env.TMPDIR = dir
	const makeBadStream = () => {
		const s = Readable.from(
			(async function* () {
				throw new Error('read exploded')
			})()
		)
		const origDestroy = s.destroy.bind(s)
		// only the bare destroy() calls made by catch blocks throw —
		// internal teardown destroy(err) keeps working, exactly the
		// addendum scenario (destroy throws inside the catch)
		s.destroy = err => {
			if (!err) throw new Error('destroy exploded')
			return origDestroy(err)
		}
		return s
	}
	try {
		await assert.rejects(getRawMediaUploadData({ stream: makeBadStream() }, silentLogger), /read exploded/)
		assert.deepEqual(fs.readdirSync(dir), [], 'getRawMediaUploadData leaked a tmp file')
		await assert.rejects(encryptedStream({ stream: makeBadStream() }, 'image', { logger: silentLogger }), /read exploded/)
		assert.deepEqual(fs.readdirSync(dir), [], 'encryptedStream leaked tmp files')
	} finally {
		if (prevTmp === undefined) delete process.env.TMPDIR
		else process.env.TMPDIR = prevTmp
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

// ── HB-252 addendum: sticker packs download via their own directPath, not the thumbnail ──
test('HB-252: downloadMediaMessage downloads the sticker PACK (sticker-pack keys), not its thumbnail', async () => {
	const zipBytes = Buffer.from('PK\x03\x04-fake-sticker-pack-zip')
	const enc = await encryptedStream({ stream: Readable.from([zipBytes]) }, 'sticker-pack', {
		logger: silentLogger
	})
	const encBytes = await fs.promises.readFile(enc.encFilePath)
	await fs.promises.unlink(enc.encFilePath).catch(() => {})
	await fs.promises.unlink(enc.originalFilePath).catch(() => {})

	const realFetch = globalThis.fetch
	const fetchedUrls = []
	globalThis.fetch = async url => {
		fetchedUrls.push(String(url))
		return new Response(encBytes, { status: 200 })
	}
	try {
		const msg = {
			key: { id: 'MSG1', remoteJid: '6281234567890@s.whatsapp.net', fromMe: false },
			message: {
				stickerPackMessage: {
					stickerPackId: 'pack-1',
					directPath: '/pack.zip',
					thumbnailDirectPath: '/thumb.jpg',
					mediaKey: enc.mediaKey.toString('base64'),
					fileSha256: enc.fileSha256.toString('base64'),
					fileEncSha256: enc.fileEncSha256.toString('base64'),
					fileLength: zipBytes.length
				}
			}
		}
		const out = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: async m => m })
		assert.deepEqual(out, zipBytes)
		assert.ok(
			fetchedUrls.some(u => u.includes('/pack.zip')),
			`pack directPath fetched (got: ${fetchedUrls.join(', ')})`
		)
		assert.ok(!fetchedUrls.some(u => u.includes('/thumb.jpg')), 'thumbnail must not be fetched for a pack')
	} finally {
		globalThis.fetch = realFetch
	}
})

// ── Socket-level tests (fake transport, fabricated server answers) ──
const { makeWASocket, useMultiFileAuthState } = await import(L('lib/index.js'))
const { WebSocketClient } = await import(L('lib/Socket/Client/index.js'))
const { Curve, signedKeyPair } = await import(L('lib/Utils/crypto.js'))
const pino = (await import('pino')).default

WebSocketClient.prototype.connect = async () => {}

const ME = '6280000000000@s.whatsapp.net'
const ME_LID = '123456789012345@lid'
const PEER = '6281234567890@s.whatsapp.net'
const PEER_LID = '987654321098765@lid'
const GROUP = '120207123456789@g.us'

const be = (n, len) => {
	const b = Buffer.alloc(len)
	b.writeUIntBE(n, 0, len)
	return b
}
const bundleUser = jid => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const preKey = Curve.generateKeyPair()
	return {
		tag: 'user',
		attrs: { jid },
		content: [
			{ tag: 'registration', attrs: {}, content: be(4242, 4) },
			{ tag: 'identity', attrs: {}, content: Buffer.from(identity.public) },
			{
				tag: 'skey',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: be(1, 3) },
					{ tag: 'value', attrs: {}, content: Buffer.from(signed.keyPair.public) },
					{ tag: 'signature', attrs: {}, content: Buffer.from(signed.signature) }
				]
			},
			{
				tag: 'key',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: be(7, 3) },
					{ tag: 'value', attrs: {}, content: Buffer.from(preKey.public) }
				]
			}
		]
	}
}
const devicesUser = (jid, lid) => ({
	tag: 'user',
	attrs: { jid },
	content: [
		{
			tag: 'devices',
			attrs: {},
			content: [
				{
					tag: 'device-list',
					attrs: {},
					content: [{ tag: 'device', attrs: { id: '0', 'key-index': '0' } }]
				}
			]
		},
		...(lid ? [{ tag: 'lid', attrs: { val: lid } }] : [])
	]
})

const mkSock = async ({ meId = ME, meLid = ME_LID, wrapKeysSet = null } = {}) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb18-auth-'))
	const { state } = await useMultiFileAuthState(dir)
	state.creds.me = { id: meId, lid: meLid }
	if (wrapKeysSet) {
		const origSet = state.keys.set.bind(state.keys)
		state.keys.set = async data => wrapKeysSet(data, origSet)
	}
	const sock = makeWASocket({
		auth: state,
		logger: pino({ level: 'silent' }),
		browser: ['HB-Test', 'Chrome', '1.0'],
		markOnlineOnConnect: false,
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => false,
		connectTimeoutMs: 3000,
		defaultQueryTimeoutMs: 1500,
		getMessage: async () => ({ conversation: 'hi' })
	})
	const sends = []
	const fake = {
		send: (data, cb) => {
			sends.push(Buffer.from(data))
			if (cb) cb()
		},
		close() {}
	}
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	return { sock, sends, dir }
}

const tryDecodeFrame = async buf => {
	for (let k = 0; k <= Math.min(64, buf.length - 4); k++) {
		const len = (buf[k] << 16) | (buf[k + 1] << 8) | buf[k + 2]
		if (len !== buf.length - k - 3) continue
		try {
			return await decodeBinaryNode(buf.subarray(k + 3))
		} catch {
			/* not a node */
		}
	}
	return null
}

// Answers server IQs on the fake transport. `usyncUsers` is a function
// returning the <user> nodes for a usync result; encrypt IQs get
// fabricated key bundles; w:g2 gets group metadata.
const startPump = (sock, sends, { usyncUsers, countEncrypt = null } = {}) => {
	let processed = 0
	let busy = false
	const answered = new Set()
	const timer = setInterval(async () => {
		if (busy) return
		busy = true
		try {
			while (processed < sends.length) {
				const node = await tryDecodeFrame(sends[processed++])
				if (node?.tag !== 'iq' || answered.has(node.attrs.id)) continue
				const { id, xmlns } = node.attrs
				if (xmlns === 'usync') {
					answered.add(id)
					sock.ws.emit(`TAG:${id}`, {
						tag: 'iq',
						attrs: { id, type: 'result', from: 's.whatsapp.net' },
						content: [
							{
								tag: 'usync',
								attrs: { context: 'message', mode: 'query', sid: '1', last: 'true', index: '0' },
								content: [{ tag: 'list', attrs: {}, content: usyncUsers() }]
							}
						]
					})
				} else if (xmlns === 'encrypt' && node.attrs.type === 'get') {
					answered.add(id)
					if (countEncrypt) countEncrypt.n += 1
					const keyNode = node.content?.find(c => c.tag === 'key')
					const jids = (keyNode?.content || []).map(u => u.attrs.jid)
					sock.ws.emit(`TAG:${id}`, {
						tag: 'iq',
						attrs: { id, type: 'result', from: 's.whatsapp.net' },
						content: [{ tag: 'list', attrs: {}, content: jids.map(bundleUser) }]
					})
				} else if (xmlns === 'w:g2') {
					answered.add(id)
					sock.ws.emit(`TAG:${id}`, {
						tag: 'iq',
						attrs: { id, type: 'result', from: GROUP },
						content: [
							{
								tag: 'group',
								attrs: {
									id: '120207123456789',
									subject: 'Grup Tes',
									creator: ME,
									creation: '1700000000',
									s_t: '1700000000',
									addressing_mode: 'pn'
								},
								content: [
									{ tag: 'participant', attrs: { jid: ME, type: 'superadmin' } },
									{ tag: 'participant', attrs: { jid: PEER } }
								]
							}
						]
					})
				}
			}
		} finally {
			busy = false
		}
	}, 5)
	return () => clearInterval(timer)
}

const decodedFrames = async sends => {
	const out = []
	for (const buf of sends) {
		const n = await tryDecodeFrame(buf)
		if (n) out.push(n)
	}
	return out
}
const endSock = async ({ sock, dir }) => {
	try {
		await sock.end()
	} catch {}
	fs.rmSync(dir, { recursive: true, force: true })
}

// ── HB-282 addendum sites 2+4: malformed stored me.id / me.lid → Boom 401, never a raw TypeError ──
test(
	'HB-282: relayMessage guards jidDecode(meId)!/jidDecode(meLid)! (Boom 401 on malformed stored identities)',
	{ timeout: 60_000 },
	async () => {
		const usyncUsers = () => [devicesUser(PEER), devicesUser(PEER_LID), devicesUser(ME)]
		// site 2: malformed me.lid, DM to a PN peer
		{
			const ctx = await mkSock({ meLid: 'not-a-jid' })
			const stop = startPump(ctx.sock, ctx.sends, { usyncUsers })
			const err = await ctx.sock.sendMessage(PEER, { text: 'halo' }).then(
				() => null,
				e => e
			)
			stop()
			assert.ok(isBoom(err, 401), `expected Boom 401, got ${err?.constructor?.name}: ${err?.message}`)
			assert.ok(!(err instanceof TypeError), 'must not be a raw TypeError')
			await endSock(ctx)
		}
		// site 4: malformed me.id, DM to a @lid peer (site-3 guard only covers meLid here)
		{
			const ctx = await mkSock({ meId: 'not-a-jid' })
			const stop = startPump(ctx.sock, ctx.sends, { usyncUsers })
			const err = await ctx.sock.sendMessage(PEER_LID, { text: 'halo' }).then(
				() => null,
				e => e
			)
			stop()
			assert.ok(isBoom(err, 401), `expected Boom 401, got ${err?.constructor?.name}: ${err?.message}`)
			assert.ok(!(err instanceof TypeError), 'must not be a raw TypeError')
			await endSock(ctx)
		}
		// control: valid identities pass both guards and reach the encrypt IQ
		{
			const ctx = await mkSock({})
			const stop = startPump(ctx.sock, ctx.sends, { usyncUsers })
			await ctx.sock.sendMessage(PEER, { text: 'halo' }).catch(() => {})
			stop()
			const frames = await decodedFrames(ctx.sends)
			assert.ok(
				frames.some(n => n.tag === 'iq' && n.attrs.xmlns === 'encrypt'),
				'control send reached the key-bundle fetch'
			)
			await endSock(ctx)
		}
	}
)

// ── HB-399: force-refresh only for NEWLY mapped LIDs ────────────────
test(
	'HB-399: getUSyncDevices force-refreshes sessions only for newly mapped LIDs',
	{ timeout: 60_000 },
	async () => {
		const ctx = await mkSock({})
		const countEncrypt = { n: 0 }
		const stop = startPump(ctx.sock, ctx.sends, {
			usyncUsers: () => [devicesUser(PEER, PEER_LID), devicesUser(ME)],
			countEncrypt
		})
		await ctx.sock.getUSyncDevices([PEER], false, false)
		const afterFirst = countEncrypt.n
		assert.ok(afterFirst >= 1, 'first call: new mapping → forced bundle fetch happened')
		await ctx.sock.getUSyncDevices([PEER], false, false)
		stop()
		assert.equal(countEncrypt.n, afterFirst, 'second call: mapping already known → no forced bundle fetch')
		await endSock(ctx)
	}
)

// ── HB-400: retry resend must be encrypted exactly once ─────────────
test(
	'HB-400: a retry resend produces ONE <enc> for the participant and no <participants> fan-out',
	{ timeout: 60_000 },
	async () => {
		const ctx = await mkSock({})
		const stop = startPump(ctx.sock, ctx.sends, {
			usyncUsers: () => [devicesUser(PEER), devicesUser(ME)]
		})
		const MSG_ID = 'HB400RETRY1'
		await ctx.sock.relayMessage(PEER, { conversation: 'retry me' }, {
			participant: { jid: PEER, count: 2 },
			messageId: MSG_ID
		})
		stop()
		const frames = await decodedFrames(ctx.sends)
		const stanza = frames.find(n => n.tag === 'message' && n.attrs.id === MSG_ID)
		assert.ok(stanza, 'retry stanza was sent')
		const tags = (stanza.content || []).map(c => c.tag)
		assert.equal(tags.filter(t => t === 'enc').length, 1, `exactly one direct <enc> (got tags: ${tags.join(',')})`)
		assert.ok(!tags.includes('participants'), 'no fan-out <participants> node for a retry resend')
		await endSock(ctx)
	}
)

// ── HB-387: a failing sender-key-memory persist must not fail a sent group message ──
test(
	'HB-387: group send resolves even when persisting sender-key-memory throws after the send',
	{ timeout: 60_000 },
	async () => {
		const ctx = await mkSock({
			wrapKeysSet: async (data, origSet) => {
				if (data && 'sender-key-memory' in data) {
					throw new Error('host store exploded')
				}
				return origSet(data)
			}
		})
		const stop = startPump(ctx.sock, ctx.sends, {
			usyncUsers: () => [devicesUser(PEER), devicesUser(ME)]
		})
		const result = await ctx.sock.sendMessage(GROUP, { text: 'halo grup' })
		stop()
		assert.ok(result?.key?.id, 'sendMessage resolved with a message key')
		const frames = await decodedFrames(ctx.sends)
		assert.ok(
			frames.some(n => n.tag === 'message' && n.attrs.to === GROUP),
			'group stanza went out on the wire'
		)
		await endSock(ctx)
	}
)
