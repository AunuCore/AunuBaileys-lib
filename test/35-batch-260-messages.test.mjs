// Batch 2.6.0 — Kelompok B (messages / process-message / decode /
// chat-utils / business / recv) regression tests. Every test FAILS
// without its fix (verified by re-introducing the old behaviour in
// lib/ — see GROUP-B-REPORT.md for the per-item verification).
// Covered:
// - HB-452: generateWAMessageContent rejects non-object content Boom 400
// - HB-454: processMessage protocol cases survive store failures
// - HB-458: decrypt() catch is safe for non-Error throws
// - HB-474: downloadEncryptedContent final() defers to the MAC check
// - HB-476: CB:status <enc> route goes through processNode (ignore gates)
// - HB-381 addendum 1: poll branch keeps mentions / mentionAll / contextInfo
// - HB-427 main + addendum facet 2: missing directPath is Boom, not TypeError
// - HB-2026-1113-223 addendum ke-7: out-of-window redelivery is not strike-counted
// - Delta: Kage favicon link-preview (favicon -> faviconMmsMetadata)
// - Delta: clearChat deleteStarred facet
// - Sweep: HB-321 addendum (short hex), HB-208 addendum situs ke-3
//   (non-object product images), HB-2026-1112-50 addendum (cover-photo
//   timeout), HB-392 addendum 2 (timer-overflow clamp, choke-point fix
//   by Group A in messages-media.ts — locked here)
// HELD, not fixed here (see GROUP-B-REPORT.md): HB-468 (jimp branch —
// messages-media.ts belongs to Group A).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createCipheriv, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { lib, makeOfflineSocket, fakeOpenTransport, makeAuthState, waitFor, sleep, endQuietly, silentLogger } from './helpers.mjs'
import { generateWAMessageContent } from '../lib/Utils/messages.js'
import { downloadEncryptedContent, getMediaKeys, sanitizeMediaTimeoutMs } from '../lib/Utils/messages-media.js'
import processMessage from '../lib/Utils/process-message.js'
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js'
import { chatModificationToAppPatch } from '../lib/Utils/chat-utils.js'
import { uploadingNecessaryImages, toProductNode } from '../lib/Utils/business.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { Curve, generateSignalPubKey, signedKeyPair, aesEncryptGCM, hkdf } from '../lib/Utils/crypto.js'
import { waproto } from '../WAProto/index.js'

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'
const GROUP = '120363123456789012@g.us'

const isBoom = (statusCode, message) => err => {
	if (message && !String(err?.message || '').includes(message)) return false
	return err?.isBoom && err?.output?.statusCode === statusCode
}
const boom400 = message => isBoom(400, message)
const boom502 = message => isBoom(502, message)

const T = () => String(Math.floor(Date.now() / 1000))

// A live local WS server keeps the transport OPEN so the event buffer
// stays alive for multi-stanza flows (the dead-URL offline socket tears
// its listeners down on ECONNREFUSED ~50 ms after creation).
const liveServer = async () => {
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	await new Promise(r => wss.on('listening', r))
	const frames = []
	wss.on('connection', ws => ws.on('message', d => frames.push(Buffer.from(d))))
	return { wss, port: wss.address().port, frames }
}

const offlineOpts = port => ({
	logger: silentLogger,
	waWebSocketUrl: `ws://127.0.0.1:${port}`,
	connectTimeoutMs: 30_000,
	defaultQueryTimeoutMs: 800,
	keepAliveIntervalMs: 3_600_000,
	markOnlineOnConnect: false,
	syncFullHistory: false,
	shouldSyncHistoryMessage: () => false,
	generateHighQualityLinkPreview: false,
	banSentinel: false,
	browser: ['aunu-35', 'test', '1']
})

const liveSocket = async (port, extra = {}) => {
	const { state } = await makeAuthState()
	const sock = lib.makeWASocket({ auth: state, ...offlineOpts(port), ...extra })
	await new Promise(r => sock.ws.on('open', r))
	await sleep(300)
	return sock
}

const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}

const withTimeout = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

// ── HB-452 ─────────────────────────────────────────────────────────

test('HB-452: generateWAMessageContent rejects non-object content with Boom 400, not a raw TypeError', async () => {
	for (const bad of ['just a string', null, undefined, 42, true]) {
		await assert.rejects(() => generateWAMessageContent(bad, {}), boom400('must be an object'), `content ${String(bad)}`)
	}
})

test('HB-452 (control): an empty array still reaches the media branch Boom 400, and a text object resolves', async () => {
	await assert.rejects(() => generateWAMessageContent([], {}), boom400('Invalid media type'))
	const m = await generateWAMessageContent({ text: 'hi-452' }, {})
	assert.equal(m.extendedTextMessage?.text, 'hi-452')
})

// ── HB-321 addendum (sweep) ────────────────────────────────────────

test('HB-321 addendum: short hex expands per digit instead of zero-padding (via backgroundColor)', async () => {
	const white = await generateWAMessageContent({ text: 'x' }, { backgroundColor: '#FFF' })
	assert.equal(white.extendedTextMessage?.backgroundArgb, 0xFFFFFFFF, '#FFF must be white, not 0xFF000FFF')
	const red = await generateWAMessageContent({ text: 'x' }, { backgroundColor: '#F00' })
	assert.equal(red.extendedTextMessage?.backgroundArgb, 0xFFFF0000, '#F00 must be red, not 0xFF000F00')
	const rgba = await generateWAMessageContent({ text: 'x' }, { backgroundColor: '#F008' })
	assert.equal(rgba.extendedTextMessage?.backgroundArgb, 0x88FF0000, '#F008 must be AARRGGBB 0x88FF0000')
})

test('HB-321 addendum (control): full hex and numbers are unchanged', async () => {
	const full = await generateWAMessageContent({ text: 'x' }, { backgroundColor: '#FF0000' })
	assert.equal(full.extendedTextMessage?.backgroundArgb, 0xFFFF0000)
	const num = await generateWAMessageContent({ text: 'x' }, { backgroundColor: 0xFF112233 })
	assert.equal(num.extendedTextMessage?.backgroundArgb, 0xFF112233)
})

// ── HB-381 addendum 1 ──────────────────────────────────────────────

const pollContent = (extra = {}) => ({
	poll: { name: 'Q-381?', values: ['A', 'B'], selectableCount: 1 },
	...extra
})

test('HB-381 addendum 1: poll keeps mentions on the poll content, not on messageContextInfo', async () => {
	const m = await generateWAMessageContent(pollContent({ mentions: [PEER] }), {})
	const poll = m.pollCreationMessageV3
	assert.ok(poll, 'expected pollCreationMessageV3')
	assert.deepEqual(poll.contextInfo?.mentionedJid, [PEER], 'mentionedJid must land on the poll content')
	assert.equal(m.messageContextInfo?.messageSecret?.length, 32, 'messageSecret stays on messageContextInfo')
	// The proto must carry it: encode the content and read it back.
	const back = waproto.Message.decode(waproto.Message.encode(m).finish())
	assert.deepEqual(back.pollCreationMessageV3?.contextInfo?.mentionedJid, [PEER])
})

test('HB-381 addendum 1: poll keeps mentionAll (nonJidMentions) and caller contextInfo', async () => {
	const quoted = { conversation: 'quoted-381' }
	const m = await generateWAMessageContent(
		pollContent({
			mentionAll: true,
			contextInfo: { stanzaId: '3EB0381001', participant: PEER, quotedMessage: quoted }
		}),
		{}
	)
	const ctx = m.pollCreationMessageV3?.contextInfo
	assert.ok(ctx, 'poll contextInfo must exist')
	assert.equal(ctx.mentionedJid, undefined, 'mentionAll must not invent a mentionedJid')
	assert.equal(ctx.nonJidMentions, 1, 'mentionAll must set nonJidMentions')
	assert.equal(ctx.stanzaId, '3EB0381001', 'caller contextInfo must merge onto the poll content')
	assert.deepEqual(ctx.quotedMessage, quoted)
})

test('HB-381 addendum 1 (control): text and event mentions still work', async () => {
	const text = await generateWAMessageContent({ text: 'hi', mentions: [PEER] }, {})
	assert.deepEqual(text.extendedTextMessage?.contextInfo?.mentionedJid, [PEER])
	const event = await generateWAMessageContent(
		{
			event: {
				name: 'E-381',
				startDate: new Date(Date.now() + 3600_000),
				endDate: new Date(Date.now() + 7200_000)
			},
			mentions: [PEER]
		},
		{}
	)
	assert.deepEqual(event.eventMessage?.contextInfo?.mentionedJid, [PEER])
})

// ── Delta: Kage favicon link-preview ───────────────────────────────

const tinyPng = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
)

test('Delta favicon: a supplied favicon uploads and lands as faviconMmsMetadata on extendedTextMessage', async () => {
	const upload = async () => ({
		mediaUrl: 'https://mmg.whatsapp.net/favicon',
		directPath: '/favicon-path-35',
		fileSha256: Buffer.alloc(32, 1),
		fileEncSha256: Buffer.alloc(32, 2),
		mediaKey: Buffer.alloc(32, 3),
		mediaKeyTimestamp: 1760000000,
		fileEncSha256B64: Buffer.alloc(32, 2).toString('base64')
	})
	const m = await generateWAMessageContent({ text: 'with favicon', favicon: tinyPng }, { upload })
	const meta = m.extendedTextMessage?.faviconMmsMetadata
	assert.ok(meta, 'faviconMmsMetadata must be present')
	assert.equal(meta.thumbnailDirectPath, '/favicon-path-35')
	assert.ok(Number(meta.mediaKeyTimestamp) > 0, 'mediaKeyTimestamp must be set by the upload path (number or Long)')
	assert.equal(meta.thumbnailHeight, 1)
	assert.equal(meta.thumbnailWidth, 1)
})

test('Delta favicon (control): no favicon means no faviconMmsMetadata and the text is unchanged', async () => {
	const m = await generateWAMessageContent({ text: 'plain-35' }, {})
	assert.equal(m.extendedTextMessage?.faviconMmsMetadata, undefined)
	assert.equal(m.extendedTextMessage?.text, 'plain-35')
})

// ── Delta: clearChat deleteStarred ─────────────────────────────────

const clearMod = (extra = {}) => ({
	clear: true,
	lastMessages: [{ key: { id: '3EB035CLEAR1', remoteJid: GROUP, fromMe: true }, messageTimestamp: 1760000000 }],
	...extra
})

test('Delta deleteStarred: default and true delete starred (index 1); false keeps them (index 0)', async () => {
	assert.deepEqual(chatModificationToAppPatch(clearMod(), GROUP).index, ['clearChat', GROUP, '1', '0'])
	assert.deepEqual(chatModificationToAppPatch(clearMod({ deleteStarred: true }), GROUP).index, ['clearChat', GROUP, '1', '0'])
	assert.deepEqual(chatModificationToAppPatch(clearMod({ deleteStarred: false }), GROUP).index, ['clearChat', GROUP, '0', '0'])
})

// ── HB-454 ─────────────────────────────────────────────────────────

const procCtx = (overrides = {}) => {
	const events = []
	return {
		ctx: {
			shouldProcessHistoryMsg: false,
			placeholderResendCache: undefined,
			creds: { me: { id: ME, lid: '100000000000001@lid' }, accountSettings: {} },
			keyStore: {
				get: async () => ({}),
				set: async () => {},
				transaction: async fn => fn()
			},
			ev: { emit: (type, data) => { events.push([type, data]); return true } },
			logger: silentLogger,
			options: {},
			signalRepository: {
				lidMapping: {
					getLIDForPN: async () => null,
					getPNForLID: async () => null,
					storeLIDPNMappings: async () => {}
				},
				migrateSession: async () => ({ migrated: 0, skipped: 0, total: 0 })
			},
			getMessage: async () => undefined,
			...overrides
		},
		events
	}
}

const lidPayload = waproto.LIDMigrationMappingSyncPayload.encode({
	pnToLidMappings: [
		{ pn: '6281111111111', latestLid: '100000000000001' },
		{ pn: '6282222222222', latestLid: '100000000000002' }
	]
}).finish()

const lidMsg = () => ({
	key: { remoteJid: ME, id: 'LIDMIG35', fromMe: true },
	messageTimestamp: 1760000000,
	message: {
		protocolMessage: {
			type: waproto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
			lidMigrationMappingSyncMessage: { encodedMappingPayload: lidPayload }
		}
	}
})

test('HB-454 facet A: a throwing mapping store no longer rejects the LID migration case — migration still runs per pair', async () => {
	const migrated = []
	const { ctx } = procCtx({
		signalRepository: {
			lidMapping: {
				getLIDForPN: async () => null,
				getPNForLID: async () => null,
				storeLIDPNMappings: async () => { throw new Error('store down') }
			},
			migrateSession: async (pn, lid) => { migrated.push([pn, lid]); return { migrated: 1, skipped: 0, total: 1 } }
		}
	})
	await processMessage(lidMsg(), ctx)
	assert.deepEqual(migrated, [
		['6281111111111@s.whatsapp.net', '100000000000001@lid'],
		['6282222222222@s.whatsapp.net', '100000000000002@lid']
	])
})

test('HB-454 facet A: one failing migrateSession does not abort the pairs after it', async () => {
	const migrated = []
	const { ctx } = procCtx({
		signalRepository: {
			lidMapping: {
				getLIDForPN: async () => null,
				getPNForLID: async () => null,
				storeLIDPNMappings: async () => {}
			},
			migrateSession: async (pn, lid) => {
				if (pn === '6281111111111@s.whatsapp.net') throw new Error('session gone')
				migrated.push([pn, lid])
				return { migrated: 1, skipped: 0, total: 1 }
			}
		}
	})
	await processMessage(lidMsg(), ctx)
	assert.deepEqual(migrated, [['6282222222222@s.whatsapp.net', '100000000000002@lid']])
})

const appStateShareMsg = () => ({
	key: { remoteJid: ME, id: 'APPSHARE35', fromMe: true },
	messageTimestamp: 1760000000,
	message: {
		protocolMessage: {
			type: waproto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
			appStateSyncKeyShare: {
				keys: [
					{ keyData: { keyData: Buffer.alloc(32, 7) }, keyId: { keyId: Buffer.from('key-35-a') } },
					{ keyData: { keyData: Buffer.alloc(32, 8) }, keyId: { keyId: Buffer.from('key-35-b') } }
				]
			}
		}
	}
})

test('HB-454 facet B: a throwing key-store transaction no longer rejects the app-state share — and no key id is adopted', async () => {
	const { ctx, events } = procCtx({
		keyStore: {
			get: async () => ({}),
			set: async () => {},
			transaction: async () => { throw new Error('store down') }
		}
	})
	await processMessage(appStateShareMsg(), ctx)
	assert.equal(events.filter(([t]) => t === 'creds.update').length, 0, 'a failed share must not adopt any key id')
})

test('HB-454 facet B (control): a healthy share still injects keys and adopts the last key id', async () => {
	const stored = {}
	const { ctx, events } = procCtx({
		keyStore: {
			get: async () => ({}),
			set: async patch => { Object.assign(stored, patch['app-state-sync-key']) },
			transaction: async fn => fn()
		}
	})
	await processMessage(appStateShareMsg(), ctx)
	assert.equal(Object.keys(stored).length, 2, 'both keys must be stored')
	const adopted = events.filter(([t]) => t === 'creds.update').map(([, d]) => d.myAppStateKeyId)
	assert.deepEqual(adopted, [Buffer.from('key-35-b').toString('base64')])
})

// ── HB-458 ─────────────────────────────────────────────────────────

const decryptAuth = storeFailure => {
	const keys = {
		get: async (type, _ids) => {
			if (type === 'session') throw storeFailure
			return {}
		},
		set: async () => {},
		transaction: async work => work()
	}
	return {
		creds: {
			registrationId: 1234,
			signedIdentityKey: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) },
			signedPreKey: { keyPair: { public: Buffer.alloc(32, 3), private: Buffer.alloc(32, 4) }, keyId: 1, signature: Buffer.alloc(64, 5) }
		},
		keys
	}
}

const decryptStanza = {
	tag: 'message',
	attrs: {
		id: 'T35C1',
		from: '6281234567890@s.whatsapp.net',
		t: String(Math.floor(Date.now() / 1000)),
		type: 'chat'
	},
	content: [{ tag: 'enc', attrs: { type: 'msg', v: '2' }, content: Buffer.from([0x11, 0x22, 0x33, 0x44]) }]
}

test('HB-458: decrypt() resolves with a CIPHERTEXT stub when the key store throws a bare string', async () => {
	const repo = makeLibSignalRepository(decryptAuth('db locked'), silentLogger)
	const { fullMessage, decrypt } = decryptMessageNode(decryptStanza, ME, '', repo, silentLogger)
	await decrypt()
	assert.equal(fullMessage.messageStubType, waproto.WebMessageInfo.StubType.CIPHERTEXT)
	assert.deepEqual(fullMessage.messageStubParameters, ['db locked'])
})

test('HB-458: decrypt() resolves with a CIPHERTEXT stub when the key store throws a non-Error object', async () => {
	const repo = makeLibSignalRepository(decryptAuth({ code: 'SQLITE_BUSY' }), silentLogger)
	const { fullMessage, decrypt } = decryptMessageNode(decryptStanza, ME, '', repo, silentLogger)
	await decrypt()
	assert.equal(fullMessage.messageStubType, waproto.WebMessageInfo.StubType.CIPHERTEXT)
	assert.equal(fullMessage.messageStubParameters?.[0], '[object Object]')
})

test('HB-458 (control): an Error store failure still resolves with the same stub param', async () => {
	const repo = makeLibSignalRepository(decryptAuth(new Error('db locked')), silentLogger)
	const { fullMessage, decrypt } = decryptMessageNode(decryptStanza, ME, '', repo, silentLogger)
	await decrypt()
	assert.equal(fullMessage.messageStubType, waproto.WebMessageInfo.StubType.CIPHERTEXT)
	assert.deepEqual(fullMessage.messageStubParameters, ['db locked'])
})

// ── HB-474 ─────────────────────────────────────────────────────────

const mediaBodies = async () => {
	const mediaKey = randomBytes(32)
	const keys = await getMediaKeys(mediaKey, 'image')
	const plaintext = Buffer.from('AunuBaileys 2.6.0 probe plaintext, exactly 48 bytes....')
	const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const fullMac = createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	const valid = Buffer.concat([ciphertext, fullMac])
	const cut = Buffer.concat([ciphertext.subarray(0, ciphertext.length - 20), fullMac])
	const flipped = Buffer.concat([ciphertext, fullMac])
	flipped[ciphertext.length - 1] ^= 0xff
	return { keys, plaintext, valid, cut, flipped, noMac: ciphertext }
}

const mediaServerFor = async (t, bodies) => {
	const server = createServer((req, res) => {
		const body = bodies[req.url]
		if (!body) {
			res.writeHead(404)
			res.end()
			return
		}
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) })
		res.end(body)
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => server.close())
	return `http://127.0.0.1:${server.address().port}`
}

test('HB-474 (control): a complete encrypted download decrypts and MAC-verifies', async t => {
	const { keys, plaintext, valid } = await mediaBodies()
	const base = await mediaServerFor(t, { '/valid': valid })
	const out = await withTimeout(consume(await downloadEncryptedContent(`${base}/valid`, keys)), 5000, 'valid')
	assert.ok(out.equals(plaintext), 'decrypted plaintext does not match')
})

test('HB-474: a truncated ciphertext fails with Boom 400 HMAC, not a raw bad-decrypt', async t => {
	const { keys, cut } = await mediaBodies()
	const base = await mediaServerFor(t, { '/cut': cut })
	await assert.rejects(
		async () => withTimeout(consume(await downloadEncryptedContent(`${base}/cut`, keys)), 5000, 'cut'),
		boom400('HMAC')
	)
})

test('HB-474: a flipped last ciphertext byte fails with Boom 400 HMAC, not a raw bad-decrypt', async t => {
	const { keys, flipped } = await mediaBodies()
	const base = await mediaServerFor(t, { '/flip': flipped })
	await assert.rejects(
		async () => withTimeout(consume(await downloadEncryptedContent(`${base}/flip`, keys)), 5000, 'flip'),
		boom400('HMAC')
	)
})

test('HB-474: a body missing its MAC entirely fails with Boom 400 HMAC', async t => {
	const { keys, noMac } = await mediaBodies()
	const base = await mediaServerFor(t, { '/nomac': noMac })
	await assert.rejects(
		async () => withTimeout(consume(await downloadEncryptedContent(`${base}/nomac`, keys)), 5000, 'nomac'),
		boom400('HMAC')
	)
})

test('HB-474: with no macKey to verify, a truncated ciphertext fails with Boom 400 PKCS7 padding', async t => {
	const { keys, cut, valid } = await mediaBodies()
	const noMacKeys = { cipherKey: keys.cipherKey, iv: keys.iv, macKey: undefined }
	const base = await mediaServerFor(t, { '/cut': cut, '/valid': valid })
	const out = await withTimeout(consume(await downloadEncryptedContent(`${base}/valid`, noMacKeys)), 5000, 'valid-no-mac')
	assert.ok(out.length > 0, 'a valid body must still download without a macKey')
	await assert.rejects(
		async () => withTimeout(consume(await downloadEncryptedContent(`${base}/cut`, noMacKeys)), 5000, 'cut-no-mac'),
		boom400('PKCS7')
	)
})

// ── HB-476 ─────────────────────────────────────────────────────────

const encStanza = (tag, from, id) => ({
	tag,
	attrs: { id, from, participant: PEER, t: T() },
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from('garbage-ciphertext-not-a-real-message') }]
})

test('HB-476: an encrypted status from an ignored group is dropped like a CB:message, not decrypted and upserted', async () => {
	const { wss, port, frames } = await liveServer()
	try {
		// Phase 1 (control): CB:message from the ignored group is dropped.
		{
			const sock = await liveSocket(port, { shouldIgnoreJid: jid => jid === GROUP })
			try {
				let upserts = 0
				sock.ev.on('messages.upsert', () => { upserts++ })
				const framesBefore = frames.length
				sock.ws.emit('CB:message', encStanza('message', GROUP, '3EB035476A1'))
				await sleep(3000)
				assert.equal(upserts, 0, 'CB:message from an ignored group must not upsert')
				assert.ok(frames.length > framesBefore, 'the dropped stanza must still be acked')
			} finally {
				endQuietly(sock)
			}
		}
		// Phase 2: CB:status <enc> from the SAME ignored group must now be dropped too.
		{
			const sock = await liveSocket(port, { shouldIgnoreJid: jid => jid === GROUP })
			try {
				let upserts = 0
				sock.ev.on('messages.upsert', () => { upserts++ })
				const framesBefore = frames.length
				sock.ws.emit('CB:status', encStanza('status', GROUP, '3EB035476A2'))
				await sleep(3000)
				assert.equal(upserts, 0, 'CB:status <enc> from an ignored group must not upsert (was: decrypted + upserted)')
				assert.ok(frames.length > framesBefore, 'the dropped status stanza must still be acked')
			} finally {
				endQuietly(sock)
			}
		}
		// Phase 3 (control): CB:status <enc> from a NON-ignored group is still processed.
		{
			const sock = await liveSocket(port, { shouldIgnoreJid: jid => jid === GROUP })
			try {
				let upserts = 0
				sock.ev.on('messages.upsert', () => { upserts++ })
				sock.ws.emit('CB:status', encStanza('status', '120363000000000001@g.us', '3EB035476A3'))
				assert.equal(await waitFor(() => upserts > 0, 10_000), true, 'a non-ignored encrypted status must still upsert')
			} finally {
				endQuietly(sock)
			}
		}
	} finally {
		wss.close()
	}
})

test('HB-476 (src parity): the CB:status <enc> branch routes through processNode', async () => {
	const { readFileSync } = await import('node:fs')
	const src = readFileSync(new URL('../src/Socket/messages-recv.ts', import.meta.url), 'utf8')
	const routeIdx = src.indexOf("'processing status message'")
	assert.ok(routeIdx > 0, 'the CB:status route marker must exist')
	const routeLine = src.slice(0, routeIdx).split('\n').pop()
	assert.ok(routeLine.includes('processNode('), `the route must call processNode, got: ${routeLine.trim()}`)
	assert.ok(!routeLine.includes('processNodeWithBuffer'), 'the route must not use processNodeWithBuffer anymore')
})

// ── HB-427 main ────────────────────────────────────────────────────

const mediaRetryNotification = (mediaKey, msgId, fields) => {
	const retryKey = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
	const plaintext = waproto.MediaRetryNotification.encode({
		result: waproto.MediaRetryNotification.ResultType.SUCCESS,
		...fields
	}).finish()
	const iv = randomBytes(12)
	const ciphertext = aesEncryptGCM(plaintext, retryKey, iv, Buffer.from(msgId))
	return { ciphertext, iv }
}

const retryTestMessage = mediaKey => ({
	key: { remoteJid: PEER, fromMe: true, id: '3EB035427001' },
	messageTimestamp: 1760000000,
	message: {
		imageMessage: {
			mediaKey,
			mimetype: 'image/jpeg',
			fileSha256: Buffer.alloc(32, 1),
			fileLength: 1234
		}
	}
})

test('HB-427 main: a SUCCESS media-retry notification without directPath fails with Boom 502, not a raw TypeError', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
		const record = []
		fakeOpenTransport(sock, record)
		const mediaKey = randomBytes(32)
		const msg = retryTestMessage(mediaKey)
		const pending = sock.updateMediaMessage(msg)
		assert.equal(await waitFor(() => record.length > 0, 5000), true, 'the retry request must go out first')
		const { ciphertext, iv } = mediaRetryNotification(mediaKey, msg.key.id, {})
		sock.ev.emit('messages.media-update', [{ key: msg.key, media: { ciphertext, iv } }])
		await assert.rejects(() => withTimeout(pending, 10_000, 'updateMediaMessage'), boom502('no directPath'))
	} finally {
		endQuietly(sock)
	}
})

test('HB-427 main (control): a SUCCESS notification WITH directPath resolves and fills url', async () => {
	const sock = await makeOfflineSocket({})
	try {
		sock.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
		const record = []
		fakeOpenTransport(sock, record)
		const mediaKey = randomBytes(32)
		const msg = retryTestMessage(mediaKey)
		const pending = sock.updateMediaMessage(msg)
		assert.equal(await waitFor(() => record.length > 0, 5000), true, 'the retry request must go out first')
		const { ciphertext, iv } = mediaRetryNotification(mediaKey, msg.key.id, { directPath: '/dp/35-427' })
		sock.ev.emit('messages.media-update', [{ key: msg.key, media: { ciphertext, iv } }])
		await withTimeout(pending, 10_000, 'updateMediaMessage')
		assert.equal(msg.message.imageMessage.directPath, '/dp/35-427')
		assert.ok(String(msg.message.imageMessage.url).includes('/dp/35-427'), `url must carry the directPath, got ${msg.message.imageMessage.url}`)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-427 addendum facet 2 + HB-208 addendum situs ke-3 ──────────

test('HB-427 addendum facet 2: an upload host that answers url-only (no directPath) fails with Boom 400', async () => {
	const urlOnlyUpload = async () => ({ mediaUrl: 'https://example.com/img.jpg' })
	await assert.rejects(
		() => uploadingNecessaryImages([Buffer.from('fake-image-bytes-35')], urlOnlyUpload),
		boom400('no directPath')
	)
})

test('HB-427 addendum facet 2 (control): a host that returns a directPath builds the whatsapp.net url', async () => {
	const upload = async () => ({ directPath: '/dp/35-427b' })
	const [out] = await uploadingNecessaryImages([Buffer.from('fake-image-bytes-35')], upload)
	assert.ok(out.url.includes('/dp/35-427b'), `expected the directPath in the url, got ${out.url}`)
	assert.ok(out.url.includes('whatsapp.net'), `expected a whatsapp.net url, got ${out.url}`)
})

test('HB-208 addendum situs ke-3: a plain-string / null / undefined product image fails with Boom 400, not a raw TypeError', async () => {
	const upload = async () => ({ directPath: '/dp/35-208' })
	for (const bad of ['https://example.com/x.jpg', null, undefined, 42]) {
		await assert.rejects(() => uploadingNecessaryImages([bad], upload), boom400(), `image ${String(bad)}`)
		await assert.throws(() => toProductNode(undefined, { images: [bad] }), boom400('already be uploaded'), `toProductNode image ${String(bad)}`)
	}
})

test('HB-208 addendum situs ke-3 (control): an already-uploaded whatsapp.net url passes through, a Buffer uploads', async () => {
	const [passthrough] = await uploadingNecessaryImages(
		[{ url: 'https://mmg.whatsapp.net/already-there' }],
		async () => { throw new Error('upload must not run for an already-hosted url') }
	)
	assert.equal(passthrough.url, 'https://mmg.whatsapp.net/already-there')
	const [uploaded] = await uploadingNecessaryImages(
		[Buffer.from('fake-image-bytes-35')],
		async () => ({ directPath: '/dp/35-208b' })
	)
	assert.ok(uploaded.url.includes('/dp/35-208b'))
	const node = toProductNode('PROD-35', { images: [{ url: 'https://mmg.whatsapp.net/p1' }] })
	const media = node.content.find(c => c.tag === 'media')
	assert.ok(media, 'the product node must carry its media child')
})

// ── HB-2026-1113-223 addendum ke-7 (strike-count facet) ────────────

const bundleForMe = async (meSock, preKeyId) => {
	const pair = Curve.generateKeyPair()
	await meSock.authState.keys.set({ 'pre-key': { [preKeyId]: pair } })
	const creds = meSock.authState.creds
	return {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: {
			keyId: creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
			signature: creds.signedPreKey.signature
		},
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pair.public) }
	}
}

const encMessageStanza = (id, from, type, ciphertext) => ({
	tag: 'message',
	attrs: { id, from, t: T() },
	content: [{ tag: 'enc', attrs: { type, count: '0' }, content: ciphertext }]
})

// Wire plaintext is the Message protobuf with PKCS#7-style padding
// to a 16-byte boundary — the shape unpadRandomMax16 reverses on the
// receive path (test/28 recipe).
const encMsg = text => {
	const raw = Buffer.from(waproto.Message.encode({ conversation: text }).finish())
	const pad = 16 - (raw.length % 16)
	return Buffer.concat([raw, Buffer.alloc(pad, pad)])
}

// Delivers one pkmsg + one WhisperMessage to sockA (real X3DH), then
// opens sockB on the SAME auth dir: cold dedup set, cold retry cache,
// same session — the redelivery must fail decrypt on sockB with the
// aggregate 'No matching sessions found' text. Returns the harness.
const redeliverySetup = async (port, getMessage) => {
	const { dir, state: stateA } = await makeAuthState()
	const sockA = lib.makeWASocket({ auth: stateA, ...offlineOpts(port) })
	// Attach the 'open' waiter synchronously: any await between
	// construction and attach can let the localhost handshake finish
	// first and the event is missed forever (the test then hangs).
	const openA = new Promise(r => sockA.ws.on('open', r))
	// Seed the peer's PN<->LID mapping BEFORE any session work:
	// every getLIDForPN miss fires a USync query, and the dummy
	// server never answers, so each miss burns the 800 ms query
	// timeout — and a single message needs several sequential
	// lookups (decrypt, session store, addressing). With the pair
	// cached, no lookup ever touches the network. The session is
	// injected after the seed, so both sides resolve consistently.
	const PEER_LID = '100000000000002@lid'
	await sockA.signalRepository.lidMapping.storeLIDPNMappings([{ pn: PEER, lid: PEER_LID }])
	// The peer needs a full socket (not a bare repository): the raw
	// multi-file keys object has no `transaction`, which
	// injectE2ESession requires — makeWASocket adds it. The peer
	// socket never receives stanzas, so its dead-URL transport is
	// irrelevant here (t0994 recipe).
	const peerSock = await makeOfflineSocket({})
	const peerRepo = peerSock.signalRepository
	sockA.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
	await openA
	await sleep(300)
	const store = new Map()
	sockA.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages) if (m.message) store.set(m.key.id, m)
	})
	await peerRepo.injectE2ESession({ jid: ME, session: await bundleForMe(sockA, 61) })
	// Wire plaintext is the Message protobuf with PKCS#7-style
	// padding to a 16-byte boundary — the shape unpadRandomMax16
	// reverses on the receive path (test/28 recipe). Without the
	// pad, decrypt() dies in the protobuf decode with 'unpad given
	// N bytes, but pad is M' and the message lands as a CIPHERTEXT
	// stub even though the Signal decrypt itself succeeded.
	const c1 = await peerRepo.encryptMessage({ jid: ME, data: encMsg('hello-redelivery-1') })
	assert.equal(c1.type, 'pkmsg', 'the first message must be a pkmsg')
	const MSG_ID = '3EB035223002'
	sockA.ws.emit('CB:message', encMessageStanza('3EB035223001', PEER, c1.type, c1.ciphertext))
	// The upsert is held by the socket event buffer until a flush
	// (the offline socket never flushes on its own — test/30 pattern).
	sockA.ev.flush?.()
	assert.equal(await waitFor(() => store.has('3EB035223001'), 10_000), true, 'first delivery must decrypt')
	// libsignal keeps the sender's pendingPreKey until it receives a
	// reply — the peer's second encrypt stays a pkmsg without one.
	// Complete the handshake at repo level (no stanza needed): ME
	// replies, the peer decrypts it, and the peer's next encrypt is
	// a real WhisperMessage — the only shape whose redelivery fails
	// with the aggregate 'No matching sessions found' text.
	const reply = await sockA.signalRepository.encryptMessage({ jid: PEER, data: Buffer.from('handshake-reply-35') })
	assert.equal(reply.type, 'msg', "ME's reply to the peer must be a WhisperMessage")
	await peerRepo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })
	const c2 = await peerRepo.encryptMessage({ jid: ME, data: encMsg('hello-redelivery-2') })
	assert.equal(c2.type, 'msg', 'the second message must be a WhisperMessage (msg), not pkmsg')
	sockA.ws.emit('CB:message', encMessageStanza(MSG_ID, PEER, c2.type, c2.ciphertext))
	sockA.ev.flush?.()
	assert.equal(await waitFor(() => store.has(MSG_ID), 10_000), true, 'second delivery must decrypt')
	assert.equal(store.get(MSG_ID)?.message?.conversation, 'hello-redelivery-2')
	const { state: stateB } = await lib.useMultiFileAuthState(dir)
	const sockB = lib.makeWASocket({ auth: stateB, ...offlineOpts(port), ...(getMessage ? { getMessage } : {}) })
	const openB = new Promise(r => sockB.ws.on('open', r))
	sockB.authState.creds.me = { id: ME, lid: '100000000000001@lid', name: 'T' }
	await openB
	await sleep(300)
	return { sockA, sockB, peerSock, store, c2, MSG_ID }
}

const redeliverThrice = async (sockB, c2, MSG_ID) => {
	const failures = []
	const stubUpserts = []
	sockB.ev.on('messages.decrypt-failure', e => failures.push(e))
	sockB.ev.on('messages.upsert', ({ messages }) => {
		for (const m of messages) {
			if (m.key?.id === MSG_ID && m.messageStubType === waproto.WebMessageInfo.StubType.CIPHERTEXT) stubUpserts.push(m)
		}
	})
	for (let i = 0; i < 3; i++) {
		const before = stubUpserts.length
		sockB.ws.emit('CB:message', encMessageStanza(MSG_ID, PEER, c2.type, c2.ciphertext))
		sockB.ev.flush?.()
		assert.equal(await waitFor(() => stubUpserts.length > before, 10_000), true, `redelivery ${i + 1} must reach the CIPHERTEXT branch`)
		await sleep(300)
	}
	return { failures, stubUpserts }
}

test('HB-2026-1113-223 addendum ke-7: a redelivery past the dedup window is not strike-counted when the host store proves prior delivery', async () => {
	const { wss, port } = await liveServer()
	try {
		const { sockA, sockB, peerSock, store, c2, MSG_ID } = await redeliverySetup(port, async key => store.get(key.id))
		try {
			const { failures, stubUpserts } = await redeliverThrice(sockB, c2, MSG_ID)
			assert.equal(stubUpserts.length, 3, 'all three redeliveries must still upsert their stub (the branch is unchanged)')
			assert.equal(failures.length, 0, 'no decrypt-failure must be counted or reported for an already-delivered message')
			const validation = await sockB.signalRepository.validateSession(PEER)
			assert.equal(validation.exists, true, 'the healthy session must survive the redeliveries')
		} finally {
			endQuietly(sockA)
			endQuietly(sockB)
			endQuietly(peerSock)
		}
	} finally {
		wss.close()
	}
})

test('HB-2026-1113-223 addendum ke-7 (control): without a host store, the same redeliveries strike-count to a heal on the third', async () => {
	const { wss, port } = await liveServer()
	try {
		const { sockA, sockB, peerSock, c2, MSG_ID } = await redeliverySetup(port, undefined)
		try {
			const { failures } = await redeliverThrice(sockB, c2, MSG_ID)
			assert.equal(failures.length, 3, 'three unprovable redeliveries must each report a failure')
			assert.deepEqual(failures.map(f => f.failures), [1, 2, 3])
			assert.equal(failures[2].healed, true, 'the third consecutive failure must heal (reset the session)')
			const validation = await sockB.signalRepository.validateSession(PEER)
			assert.equal(validation.exists, false, 'the session must be gone after the heal')
		} finally {
			endQuietly(sockA)
			endQuietly(sockB)
			endQuietly(peerSock)
		}
	} finally {
		wss.close()
	}
})

// ── HB-392 addendum 2 (sweep; choke-point fix by Group A) ──────────

test('HB-392 addendum 2: sanitizeMediaTimeoutMs clamps finite huge values to the 32-bit timer limit', async () => {
	assert.equal(sanitizeMediaTimeoutMs(2 ** 40), 2_147_483_647)
	assert.equal(sanitizeMediaTimeoutMs(2 ** 31), 2_147_483_647)
	assert.equal(sanitizeMediaTimeoutMs(60_000), 60_000, 'an ordinary value must pass through unchanged')
	assert.equal(sanitizeMediaTimeoutMs(0), 120_000, '0 still falls back to the default')
	assert.equal(sanitizeMediaTimeoutMs(NaN), 120_000, 'NaN still falls back to the default')
})

// ── HB-2026-1112-50 addendum (sweep) ───────────────────────────────

test('HB-2026-1112-50 addendum: updateCoverPhoto honours the host AbortSignal — a stalled download aborts fast', async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'image/jpeg' })
		// never end the body: a stall, like the t0613 harness
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	const port = server.address().port
	try {
		const controller = new AbortController()
		// makeBusinessSocket is a composition layer, not a standalone
		// factory — build the full socket via the helper (test/13
		// pattern) and pass the host signal through `options`.
		const sock = await makeOfflineSocket({ options: { signal: controller.signal } })
		try {
			const pending = sock.updateCoverPhoto({ url: `http://127.0.0.1:${port}/stall.jpg` })
			const settled = { done: false }
			pending.then(() => { settled.done = true }, () => { settled.done = true })
			setTimeout(() => controller.abort(), 500)
			const err = await withTimeout(pending.then(
				() => { throw new Error('updateCoverPhoto resolved on a stalled download') },
				e => e
			), 5000, 'cover-photo abort')
			assert.ok(err?.isBoom && err?.output?.statusCode === 408, `expected a Boom 408 abort, got ${err?.constructor?.name}: ${err?.message}`)
			assert.equal(settled.done, true)
		} finally {
			endQuietly(sock)
		}
	} finally {
		server.close()
	}
})

test('HB-2026-1112-50 addendum (src parity): updateCoverPhoto forwards host options with a default timeout signal', async () => {
	const { readFileSync } = await import('node:fs')
	const src = readFileSync(new URL('../src/Socket/business.ts', import.meta.url), 'utf8')
	assert.ok(src.includes('sanitizeMediaTimeoutMs(undefined)'), 'the cover-photo path must apply the default 120 s timeout when the host sets no signal')
	assert.ok(src.includes('...config.options'), 'the cover-photo path must forward the host fetch options')
})

// ── HB-380 addendum (inbound immediate-recreate) ───────────────────

test('HB-380 addendum: a first Bad MAC failure recreates the session immediately (inbound fast-path)', async () => {
	const { wss, port } = await liveServer()
	try {
		const { sockA, sockB, peerSock, c2 } = await redeliverySetup(port, undefined)
		try {
			// sendRetryRequest validates creds.account before it
			// reaches the recreate block — a fresh unpaired socket
			// has none, so the receipt round throws first and the
			// recreate is never observed. The details blob must be a
			// DECODABLE ADVDeviceIdentity: since 2.7.0 (HB-201
			// addendum 4) sendRetryRequest also requires
			// decode-ability, so the random bytes the 2.6.0 recipe
			// used here now fail the guard the same way a missing
			// account does (that rejection is locked by
			// test/hb201-device-identity-decode.test.mjs).
			sockA.authState.creds.account = {
				details: Buffer.from(waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()),
				accountSignatureKey: randomBytes(32),
				accountSignature: randomBytes(64)
			}
			// Flip one byte of a live WhisperMessage: the decrypt fails
			// with libsignal's aggregate text, and the existing session
			// record proves it is a Bad MAC (classifyDecryptFailureForRetry
			// -> SignalErrorBadMac, 7). The immediate-recreate branch in
			// sendRetryRequest used to read that code from a <retry> child
			// that never exists on an inbound <message> stanza, so the
			// session survived the first failure and only died on the
			// second retry (retryCount > 1).
			const bad = Buffer.from(c2.ciphertext)
			bad[bad.length - 1] ^= 0xFF
			const failures = []
			sockA.ev.on('messages.decrypt-failure', e => failures.push(e))
			sockA.ws.emit('CB:message', encMessageStanza('3EB035223101', PEER, c2.type, bad))
			sockA.ev.flush?.()
			assert.equal(await waitFor(() => failures.length > 0, 10_000), true, 'the tampered message must report a decrypt failure')
			assert.equal(failures[0].failures, 1, 'this is the first failure for the author')
			assert.equal(failures[0].healed, false, 'emitDecryptFailure must NOT have healed (strike-counted, below the limit) — the recreate below must come from sendRetryRequest')
			// The recreate runs inside sendRetryRequest, after the
			// decrypt-failure event — give the receipt round a moment.
			assert.equal(
				await waitFor(async () => !(await sockA.signalRepository.validateSession(PEER)).exists, 10_000),
				true,
				'the session must be recreated (deleted) on the FIRST Bad MAC, not the second retry'
			)
		} finally {
			endQuietly(sockA)
			endQuietly(sockB)
			endQuietly(peerSock)
		}
	} finally {
		wss.close()
	}
})

// ── HB-2026-1112-78 addendum (ALREADY-FIXED 2.4.0 via the
// isSenderKeyUnavailableError classifier — these tests lock the fixed
// behaviour; the group gap is never reported/counted/healed) ────────

test('HB-2026-1112-78 addendum: a group skmsg 2000+ ahead is not reported, not counted, not healed — the healthy 1:1 session survives', async () => {
	const { GroupSessionBuilder } = await import('../lib/Signal/Group/group-session-builder.js')
	const { SenderKeyMessage } = await import('../lib/Signal/Group/sender-key-message.js')
	const { SenderKeyName } = await import('../lib/Signal/Group/sender-key-name.js')
	const { SenderKeyRecord } = await import('../lib/Signal/Group/sender-key-record.js')
	const { wss, port } = await liveServer()
	try {
		const { sockA, sockB, peerSock } = await redeliverySetup(port, undefined)
		try {
			// Seed the author's sender key for the group at chain
			// iteration 0 (t0976 recipe), then send a validly-signed
			// skmsg at iteration 5000: GroupCipher throws 'Over 2000
			// messages into the future!' — a sender-key chain gap, not
			// a dead E2E session. The 2.4.0 fix (ke-6) added that text
			// to isSenderKeyUnavailableError, so emitDecryptFailure
			// returns early for group messages: no event, no strike,
			// no heal — only the retry receipt is sent. This test locks
			// that fixed behaviour (a stub IS still upserted).
			const mem = new Map()
			const memStore = {
				loadSenderKey: async name => mem.get(name.toString()) || new SenderKeyRecord(),
				storeSenderKey: async (name, rec) => { mem.set(name.toString(), rec) }
			}
			const peerUser = PEER.split('@')[0]
			const name = new SenderKeyName(GROUP, { id: peerUser, deviceId: 0, toString() { return `${peerUser}.0` } })
			const skdm = await new GroupSessionBuilder(memStore).create(name)
			const record = await memStore.loadSenderKey(name)
			const state = record.getSenderKeyState()
			assert.equal(state.getSenderChainKey().getIteration(), 0, 'the seeded sender-key chain must start at iteration 0')
			await sockA.signalRepository.processSenderKeyDistributionMessage({
				authorJid: PEER,
				item: waproto.SenderKeyDistributionMessage.create({
					groupId: GROUP,
					axolotlSenderKeyDistributionMessage: skdm.serialize()
				})
			})
			const future = new SenderKeyMessage(state.getKeyId(), 5000, Buffer.alloc(16, 0x41), state.getSigningKeyPrivate())
			const failures = []
			const stubs = []
			sockA.ev.on('messages.decrypt-failure', e => failures.push(e))
			sockA.ev.on('messages.upsert', ({ messages }) => {
				for (const m of messages) {
					if (m.key?.id === '3EB035223102' && m.messageStubType === waproto.WebMessageInfo.StubType.CIPHERTEXT) stubs.push(m)
				}
			})
			sockA.ws.emit('CB:message', {
				tag: 'message',
				attrs: { id: '3EB035223102', from: GROUP, participant: PEER, t: T() },
				content: [{ tag: 'enc', attrs: { type: 'skmsg', count: '0' }, content: future.serialize() }]
			})
			sockA.ev.flush?.()
			assert.equal(await waitFor(() => stubs.length > 0, 10_000), true, 'the far-future skmsg must still upsert its CIPHERTEXT stub')
			assert.equal(stubs[0].messageStubParameters?.[0], 'Over 2000 messages into the future!', 'the stub must carry the sender-key gap text')
			await sleep(1000)
			assert.equal(failures.length, 0, 'the group gap must not be reported as a decrypt failure (sender-key-unavailable class, fixed 2.4.0)')
			const validation = await sockA.signalRepository.validateSession(PEER)
			assert.equal(validation.exists, true, 'the healthy 1:1 session with the author must survive a group sender-key gap')
		} finally {
			endQuietly(sockA)
			endQuietly(sockB)
			endQuietly(peerSock)
		}
	} finally {
		wss.close()
	}
})

test('HB-2026-1112-78 addendum (control): the same >2000 gap on a 1:1 message is strike-counted — the aggregate masks the gap text', async () => {
	const { wss, port } = await liveServer()
	try {
		const { sockA, sockB, peerSock } = await redeliverySetup(port, undefined)
		try {
			// Advance the peer's sending chain 2005 messages past ME's
			// receiving chain, then deliver only the last one: the
			// ratchet gap is >2000 and SessionCipher throws 'Over 2000
			// messages into the future!' — but decryptWithSessions
			// swallows the per-session text and rethrows libsignal's
			// aggregate, so at emitDecryptFailure the failure is
			// indistinguishable from a Bad MAC: the HB-371 facet 2
			// demotion strike-counts it (no instant reset) while the
			// session record exists.
			const peerRepo = peerSock.signalRepository
			let last = null
			for (let i = 0; i < 2005; i++) {
				last = await peerRepo.encryptMessage({ jid: ME, data: encMsg(`gap-fill-${i}`) })
			}
			assert.equal(last.type, 'msg', 'the far-future message must be a WhisperMessage')
			const failures = []
			const stubs = []
			sockA.ev.on('messages.decrypt-failure', e => failures.push(e))
			sockA.ev.on('messages.upsert', ({ messages }) => {
				for (const m of messages) {
					if (m.key?.id === '3EB035223103' && m.messageStubType === waproto.WebMessageInfo.StubType.CIPHERTEXT) stubs.push(m)
				}
			})
			sockA.ws.emit('CB:message', encMessageStanza('3EB035223103', PEER, last.type, last.ciphertext))
			sockA.ev.flush?.()
			assert.equal(await waitFor(() => failures.length > 0, 10_000), true, 'the far-future DM must report a decrypt failure')
			assert.equal(await waitFor(() => stubs.length > 0, 10_000), true, 'the far-future DM must upsert its CIPHERTEXT stub')
			assert.equal(stubs[0].messageStubParameters?.[0], 'No matching sessions found for message', 'the stub carries the aggregate, not the gap text')
			assert.equal(failures[0].isGroup, false, 'the failure must be classified as a 1:1 message')
			assert.equal(failures[0].failures, 1, 'the first far-future DM is strike-counted')
			assert.equal(failures[0].healed, false, 'no instant reset: the aggregate cannot prove a dead ratchet while the session record exists (HB-371 facet 2)')
			const validation = await sockA.signalRepository.validateSession(PEER)
			assert.equal(validation.exists, true, 'the session survives the first far-future DM')
		} finally {
			endQuietly(sockA)
			endQuietly(sockB)
			endQuietly(peerSock)
		}
	} finally {
		wss.close()
	}
})

// ── HB-107 addendum (throwing host getMessage) ──────────────────────

const eventResponseCtx = (events, getMessage) => {
	const ev = new EventEmitter()
	ev.on('messages.update', e => events.push(['messages.update', e]))
	return {
		ev,
		creds: { me: { id: ME, lid: '100000000000001@lid' }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {},
		keyStore: {},
		options: {},
		getMessage,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
}

const eventResponseMsg = () => ({
	key: { remoteJid: GROUP, fromMe: false, id: 'T-260-107-1', participant: PEER },
	messageTimestamp: 1760000000,
	message: {
		encEventResponseMessage: {
			eventCreationMessageKey: { remoteJid: GROUP, fromMe: false, id: 'T-260-107-0', participant: PEER },
			encPayload: new Uint8Array([1, 2, 3]),
			encIv: new Uint8Array(12)
		}
	}
})

test('HB-107 addendum: a throwing host getMessage in the encEventResponseMessage branch resolves instead of killing the message', async () => {
	const events = []
	// Must resolve, not reject: before the fix the throw escaped
	// processMessage after the delivery receipt was already sent, so
	// the server never redelivered and the RSVP was lost silently.
	await processMessage(eventResponseMsg(), eventResponseCtx(events, async () => { throw new Error('store boom') }))
	assert.equal(events.length, 0, 'no event-response update may be emitted when the creation message cannot be fetched')
})

test('HB-107 addendum (control): getMessage returning undefined resolves the same way (existing behaviour)', async () => {
	const events = []
	await processMessage(eventResponseMsg(), eventResponseCtx(events, async () => undefined))
	assert.equal(events.length, 0, 'no event-response update may be emitted when the creation message is absent')
})
