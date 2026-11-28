// Batch 2.9.0 "Last Fix" — Group B3 regressions.
// Item 1 (D-1081-A facet): sound sticker ptt passthrough + maxSeconds cap.
// Item 2 (W6): extractNewsletterMetadata fallback must not accept a
//   foreign object that merely carries a string id.
// Item 3 (L1): processMessage self-only protocol derefs — absent
//   LID payload / absent appStateSyncKeyShare must skip, not throw.
// Item 4 (L3): noise decodeFrame must join fragmented chunks with a
//   single concat (chunk collection), byte-identical output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { generateWAMessageContent } from '../lib/Utils/messages.js'
import { extractNewsletterMetadata } from '../lib/Socket/newsletter.js'
import processMessage from '../lib/Utils/process-message.js'
import { makeNoiseHandler } from '../lib/Utils/noise-handler.js'
import { Curve } from '../lib/Utils/crypto.js'
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js'
import { waproto } from '../WAProto/index.js'

const silentLogger = {
	level: 'silent',
	child() {
		return silentLogger
	},
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	fatal() {}
}

// ── Item 1: sound sticker ptt + maxSeconds ────────────────────────

const chunk = (fourCC, data) => {
	const header = Buffer.alloc(8)
	header.write(fourCC, 0, 'ascii')
	header.writeUInt32LE(data.length, 4)
	return data.length % 2 ? Buffer.concat([header, data, Buffer.alloc(1)]) : Buffer.concat([header, data])
}

const webpWithVp8x = () => {
	const vp8lData = Buffer.alloc(5)
	vp8lData[0] = 0x2f
	const body = Buffer.concat([chunk('VP8X', Buffer.alloc(10)), chunk('VP8L', vp8lData)])
	const head = Buffer.alloc(12)
	head.write('RIFF', 0, 'ascii')
	head.writeUInt32LE(4 + body.length, 4)
	head.write('WEBP', 8, 'ascii')
	return Buffer.concat([head, body])
}

const AUDIO = Buffer.concat([Buffer.from('OggS'), Buffer.from('aunu-b3-sound-sticker-audio')])

const mediaOpts = {
	logger: silentLogger,
	userJid: '6281234567@s.whatsapp.net',
	upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/fixture', directPath: '/fixture' })
}

test('B3-1: stickerAudio with ptt:true -> nested audioMessage carries ptt:true', async () => {
	const m = await generateWAMessageContent(
		{ stickerAudio: { sticker: webpWithVp8x(), audio: AUDIO, seconds: 2, ptt: true } },
		mediaOpts
	)
	assert.equal(m.stickerMessage?.audioMessage?.ptt, true)
})

test('B3-1: stickerAudio without ptt -> nested audioMessage has no ptt (control)', async () => {
	const m = await generateWAMessageContent(
		{ stickerAudio: { sticker: webpWithVp8x(), audio: AUDIO, seconds: 2 } },
		mediaOpts
	)
	assert.ok(m.stickerMessage?.audioMessage, 'nested audioMessage present')
	// proto fromObject materialises an unset ptt as null — the point
	// is it is not true, so the waveform gate stays off
	assert.ok(m.stickerMessage.audioMessage.ptt === undefined || m.stickerMessage.audioMessage.ptt === null)
})

test('B3-1: stickerAudio maxSeconds set + seconds above -> Boom 400', async () => {
	await assert.rejects(
		generateWAMessageContent(
			{ stickerAudio: { sticker: webpWithVp8x(), audio: AUDIO, seconds: 10, maxSeconds: 5 } },
			mediaOpts
		),
		err => err?.output?.statusCode === 400 && /maxSeconds/.test(err.message)
	)
})

test('B3-1: stickerAudio maxSeconds set + seconds below -> passes (control)', async () => {
	const m = await generateWAMessageContent(
		{ stickerAudio: { sticker: webpWithVp8x(), audio: AUDIO, seconds: 3, maxSeconds: 5 } },
		mediaOpts
	)
	assert.equal(Number(m.stickerMessage?.audioMessage?.seconds), 3)
})

test('B3-1: stickerAudio maxSeconds NaN / 0 / negative -> Boom 400', async () => {
	for (const maxSeconds of [Number.NaN, 0, -1]) {
		await assert.rejects(
			generateWAMessageContent(
				{ stickerAudio: { sticker: webpWithVp8x(), audio: AUDIO, seconds: 1, maxSeconds } },
				mediaOpts
			),
			err => err?.output?.statusCode === 400 && /maxSeconds/.test(err.message),
			`maxSeconds=${maxSeconds}`
		)
	}
})

// ── Item 2: extractNewsletterMetadata fallback (W6) ───────────────

test('B3-2: fallback skips a foreign id-only object ahead of the real newsletter metadata', () => {
	const foreign = { id: 'some-unrelated-object-id' }
	const real = { id: '120363999@newsletter', name: 'Chan', description: 'd' }
	const found = extractNewsletterMetadata({ first: foreign, second: real })
	assert.equal(found?.id, real.id)
	assert.equal(found?.name, 'Chan')
})

test('B3-2: fallback returns null when only a foreign id-only object is present', () => {
	assert.equal(extractNewsletterMetadata({ only: { id: 'not-a-newsletter' } }), null)
	assert.equal(extractNewsletterMetadata({ only: { id: '12345@s.whatsapp.net' } }), null)
})

test('B3-2: fallback accepts a candidate with a newsletter-specific field besides id', () => {
	const candidate = { id: 'opaque-id', subscribers: 42 }
	assert.equal(extractNewsletterMetadata({ wrap: candidate })?.id, 'opaque-id')
})

test('B3-2: normal newsletter envelopes unchanged (control)', () => {
	const meta = { id: '120363999@newsletter', name: 'Chan' }
	assert.equal(extractNewsletterMetadata(meta).id, meta.id)
	assert.equal(extractNewsletterMetadata({ xwa2_newsletter_metadata: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ result: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ somethingElse: meta }).id, meta.id)
	assert.equal(extractNewsletterMetadata({ nope: true }), null)
})

// ── Item 3: processMessage self-only derefs (L1) ──────────────────

const ME_PN = '6289999999@s.whatsapp.net'
const ME_LID = '100000000000001@lid'
const PTYPE = waproto.Message.ProtocolMessage.Type

const makeCtx = record => {
	const ev = new EventEmitter()
	ev.on('creds.update', e => record.credsUpdates.push(e))
	return {
		ev,
		creds: { me: { id: ME_PN, lid: ME_LID }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {
			lidMapping: {
				storeLIDPNMappings: async pairs => {
					record.storedMappings.push(pairs)
				}
			},
			migrateSession: async (pn, lid) => {
				record.migrated.push([pn, lid])
			}
		},
		keyStore: {
			transaction: async fn => {
				await fn()
			},
			set: async data => {
				record.keySets.push(data)
			}
		},
		options: {},
		getMessage: async () => undefined,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
}

const newRecord = () => ({ storedMappings: [], migrated: [], keySets: [], credsUpdates: [] })

const protocolMsg = protocolMessage => ({
	key: { remoteJid: ME_PN, fromMe: true, id: 'B3-L1' },
	message: { protocolMessage },
	messageTimestamp: 1760000000
})

test('B3-3: LID migration sync without a payload resolves without throwing and stores nothing', async () => {
	for (const protocolMessage of [
		{ type: PTYPE.LID_MIGRATION_MAPPING_SYNC },
		{ type: PTYPE.LID_MIGRATION_MAPPING_SYNC, lidMigrationMappingSyncMessage: {} },
		{ type: PTYPE.LID_MIGRATION_MAPPING_SYNC, lidMigrationMappingSyncMessage: { encodedMappingPayload: new Uint8Array(0) } }
	]) {
		const record = newRecord()
		await processMessage(protocolMsg(protocolMessage), makeCtx(record))
		assert.deepEqual(record.storedMappings, [])
		assert.deepEqual(record.migrated, [])
	}
})

test('B3-3: LID migration sync with a payload still stores mappings (control)', async () => {
	const record = newRecord()
	const encodedMappingPayload = waproto.LIDMigrationMappingSyncPayload.encode({
		pnToLidMappings: [{ pn: 628111222333, latestLid: 100000000000001 }],
		chatDbMigrationTimestamp: 1760000000
	}).finish()
	await processMessage(
		protocolMsg({ type: PTYPE.LID_MIGRATION_MAPPING_SYNC, lidMigrationMappingSyncMessage: { encodedMappingPayload } }),
		makeCtx(record)
	)
	assert.deepEqual(record.storedMappings, [[{ lid: '100000000000001@lid', pn: '628111222333@s.whatsapp.net' }]])
	assert.deepEqual(record.migrated, [['628111222333@s.whatsapp.net', '100000000000001@lid']])
})

test('B3-3: appStateSyncKeyShare absent / without keys resolves without throwing', async () => {
	for (const protocolMessage of [
		{ type: PTYPE.APP_STATE_SYNC_KEY_SHARE },
		{ type: PTYPE.APP_STATE_SYNC_KEY_SHARE, appStateSyncKeyShare: {} },
		{ type: PTYPE.APP_STATE_SYNC_KEY_SHARE, appStateSyncKeyShare: { keys: [] } }
	]) {
		const record = newRecord()
		await processMessage(protocolMsg(protocolMessage), makeCtx(record))
		assert.deepEqual(record.keySets, [])
		assert.deepEqual(record.credsUpdates, [])
	}
})

test('B3-3: appStateSyncKeyShare with a full key still injects and adopts it (control)', async () => {
	const record = newRecord()
	const keyIdBytes = new Uint8Array([1, 2, 3])
	const keyDataBytes = new Uint8Array([4, 5, 6])
	await processMessage(
		protocolMsg({
			type: PTYPE.APP_STATE_SYNC_KEY_SHARE,
			appStateSyncKeyShare: { keys: [{ keyId: { keyId: keyIdBytes }, keyData: { keyData: keyDataBytes, timestamp: 1760000000 } }] }
		}),
		makeCtx(record)
	)
	const strKeyId = Buffer.from(keyIdBytes).toString('base64')
	assert.equal(record.keySets.length, 1)
	assert.deepEqual(record.credsUpdates, [{ myAppStateKeyId: strKeyId }])
})

// ── Item 4: decodeFrame chunk joining (L3) ────────────────────────

const frameOf = payload => {
	const frame = Buffer.alloc(3 + payload.length)
	frame[0] = (payload.length >> 16) & 0xff
	frame[1] = (payload.length >> 8) & 0xff
	frame[2] = payload.length & 0xff
	payload.copy(frame, 3)
	return frame
}

const makeHandler = () =>
	makeNoiseHandler({ keyPair: Curve.generateKeyPair(), NOISE_HEADER: NOISE_WA_HEADER, logger: silentLogger })

test('B3-4: a frame fragmented into single-byte chunks decodes byte-identically', async () => {
	const handler = makeHandler()
	const payload = Buffer.from('aunu-b3-fragmented-frame-payload-0123456789')
	const frame = frameOf(payload)
	const received = []
	const onFrame = f => received.push(Buffer.from(f))
	for (const byte of frame) {
		await handler.decodeFrame(Buffer.from([byte]), onFrame)
	}

	assert.equal(received.length, 1)
	assert.deepEqual(received[0], payload)
})

test('B3-4: a whole frame in one chunk and two frames in one chunk still decode (control)', async () => {
	const handler = makeHandler()
	const p1 = Buffer.from([1, 2, 3, 4, 5])
	const p2 = Buffer.from([6, 7, 8, 9, 10])
	const received = []
	const onFrame = f => received.push(Buffer.from(f))
	await handler.decodeFrame(frameOf(p1), onFrame)
	await handler.decodeFrame(Buffer.concat([frameOf(p1), frameOf(p2)]), onFrame)
	assert.deepEqual(received, [p1, p1, p2])
})

test('B3-4: fragmented frames keep their order and bytes across chunk boundaries', async () => {
	const handler = makeHandler()
	const p1 = Buffer.from('first-frame')
	const p2 = Buffer.from('second-frame-with-more-bytes')
	const stream = Buffer.concat([frameOf(p1), frameOf(p2)])
	const received = []
	const onFrame = f => received.push(Buffer.from(f))
	// irregular chunking: splits headers and payloads alike
	let offset = 0
	for (const size of [1, 7, 2, 13, 3, 5, 21, 4, 100]) {
		if (offset >= stream.length) break
		await handler.decodeFrame(stream.subarray(offset, offset + size), onFrame)
		offset += size
	}

	if (offset < stream.length) {
		await handler.decodeFrame(stream.subarray(offset), onFrame)
	}

	assert.deepEqual(received, [p1, p2])
})

test('B3-4: decodeFrame collects chunks and joins with a single concat (structural)', () => {
	const src = readFileSync(new URL('../src/Utils/noise-handler.ts', import.meta.url), 'utf8')
	const decodeFrameStart = src.indexOf('decodeFrame: async')
	assert.ok(decodeFrameStart > -1, 'decodeFrame located')
	const decodeFrameBody = src.slice(decodeFrameStart)
	assert.ok(!decodeFrameBody.includes('Buffer.concat'), 'decodeFrame itself performs no concat')
	assert.ok(decodeFrameBody.includes('pendingChunks.push'), 'decodeFrame collects chunks')
	assert.ok(src.includes('Buffer.concat(pendingChunks'), 'the join is one concat over the collected chunks')
})
