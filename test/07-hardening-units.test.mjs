// Cheap-site HB regressions from P3 (re-applied) + P4, unit level:
// HB-111/112 (binary decode caps), HB-124 family + HB-271 (sender-key
// sanitiser), HB-69 (corrupt sender-key record), HB-272 (USync device
// parser), HB-168 (SKDM validation), HB-102 (noise handshake guard),
// HB-122/165 (message generation guards), HB-133 (WS error code case),
// HB-277 (pixel bomb guard), HB-114/205 (media/link SSRF guards),
// HB-1 (key-bundle per-entry isolation), HB-273 (encryptedStream
// write-error surfacing), PTV delta (extractMessageContent mapping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { lib, silentLogger } from './helpers.mjs'
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js'
import { GroupSessionBuilder } from '../lib/Signal/Group/group-session-builder.js'
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js'
import { USyncDeviceProtocol } from '../lib/WAUSync/Protocols/USyncDeviceProtocol.js'
import { decompressingIfRequired } from '../lib/WABinary/decode.js'
import { makeNoiseHandler } from '../lib/Utils/noise-handler.js'
import { parseAndInjectE2ESessions } from '../lib/Utils/signal.js'
import { encryptedStream } from '../lib/Utils/messages-media.js'

const goodState = (over = {}) => ({
	senderKeyId: 5,
	senderChainKey: { iteration: 0, seed: Buffer.alloc(32, 7) },
	senderSigningKey: { public: Buffer.alloc(32, 8), private: Buffer.alloc(32, 9) },
	senderMessageKeys: [],
	...over
})

test('HB-124/162/180/197/202: sender-key sanitiser drops poison, normalises house formats', () => {
	// base64 string seed is decoded as base64 (HB-162), string iteration normalised (HB-180/197)
	const rec = new SenderKeyRecord([goodState({
		senderKeyId: '5',
		senderChainKey: { iteration: '3', seed: Buffer.alloc(32, 7).toString('base64') }
	})])
	assert.equal(rec.isEmpty(), false)
	assert.equal(rec.getSenderKeyState(5)?.getKeyId(), 5)
	// bad seed type -> state dropped
	assert.equal(new SenderKeyRecord([goodState({ senderChainKey: { iteration: 0, seed: 12345 } })]).isEmpty(), true)
	// negative iteration -> dropped (HB-202)
	assert.equal(new SenderKeyRecord([goodState({ senderChainKey: { iteration: -1, seed: Buffer.alloc(32) } })]).isEmpty(), true)
	// mixed batch: valid state survives alongside poison (P3 spot-check shape)
	const mixed = new SenderKeyRecord([
		goodState({ senderChainKey: { iteration: 0, seed: 'not-a-seed' } }),
		goodState({ senderKeyId: 6 })
	])
	assert.equal(mixed.isEmpty(), false)
	assert.ok(mixed.getSenderKeyState(6))
	// non-array stored value -> empty record, no throw (HB-69 behaviour)
	assert.equal(new SenderKeyRecord('garbage').isEmpty(), true)
	assert.equal(new SenderKeyRecord(null).isEmpty(), true)
})

test('HB-271: a negative senderKeyId is dropped by the sanitiser', () => {
	assert.equal(new SenderKeyRecord([goodState({ senderKeyId: -5 })]).isEmpty(), true)
	assert.equal(new SenderKeyRecord([goodState({ senderKeyId: 5 })]).isEmpty(), false)
})

test('HB-69: SenderKeyRecord.deserialize of corrupt bytes yields an empty record', () => {
	const rec = SenderKeyRecord.deserialize(Buffer.from('{{{not json'))
	assert.equal(rec.isEmpty(), true)
})

test('HB-272: USync device parser drops <device> without a finite id; extractDeviceJids guards NaN', () => {
	const parser = new USyncDeviceProtocol().parser
	const wrap = devices => ({ tag: 'devices', attrs: {}, content: [
		{ tag: 'device-list', attrs: {}, content: devices }
	]})
	const noId = parser(wrap([{ tag: 'device', attrs: { 'key-index': '1' }, content: [] }]))
	assert.deepEqual(noId.deviceList, [])
	const withId = parser(wrap([{ tag: 'device', attrs: { id: '3' }, content: [] }]))
	assert.equal(withId.deviceList.length, 1)
	assert.equal(withId.deviceList[0].id, 3)
	const extracted = lib.extractDeviceJids(
		[{ id: '999@s.whatsapp.net', devices: { deviceList: [{ id: NaN, keyIndex: 1 }] } }],
		'111@s.whatsapp.net', '111@lid', false
	)
	assert.deepEqual(extracted, [])
})

test('HB-168: GroupSessionBuilder refuses junk SKDMs, stores valid ones', async () => {
	let stored = new SenderKeyRecord()
	const store = {
		loadSenderKey: async () => stored,
		storeSenderKey: async (_name, rec) => { stored = rec }
	}
	const builder = new GroupSessionBuilder(store)
	const name = new SenderKeyName('123@g.us', '456@s.whatsapp.net')
	await builder.process(name, {
		getId: () => 0, getIteration: () => 0,
		getChainKey: () => new Uint8Array(0), getSignatureKey: () => new Uint8Array(0)
	})
	assert.equal(stored.isEmpty(), true)
	await builder.process(name, {
		getId: () => 7, getIteration: () => 0,
		getChainKey: () => new Uint8Array(32).fill(1), getSignatureKey: () => new Uint8Array(33).fill(2)
	})
	assert.equal(stored.isEmpty(), false)
	assert.equal(stored.getSenderKeyState()?.getKeyId(), 7)
})

test('HB-112: decompressingIfRequired refuses a zlib bomb over the 128 MiB cap', async () => {
	const bomb = Buffer.concat([Buffer.from([2]), deflateSync(Buffer.alloc(200 * 1024 * 1024))])
	await assert.rejects(decompressingIfRequired(bomb), /decompressed-size cap|too large/i)
	// a small legit payload still inflates
	const small = Buffer.concat([Buffer.from([2]), deflateSync(Buffer.from('hello'))])
	assert.equal((await decompressingIfRequired(small)).toString(), 'hello')
	// uncompressed prefix is stripped untouched
	const plain = Buffer.concat([Buffer.from([0]), Buffer.from('raw')])
	assert.equal((await decompressingIfRequired(plain)).toString(), 'raw')
})

test('HB-111: decodeBinaryNode refuses nesting beyond the depth cap with a descriptive error', async () => {
	let node = { tag: 'leaf', attrs: {}, content: Buffer.from('x') }
	for (let i = 0; i < 600; i++) node = { tag: 'nest', attrs: {}, content: [node] }
	const bytes = lib.encodeBinaryNode(node)
	await assert.rejects(lib.decodeBinaryNode(bytes), /nesting exceeds|depth/i)
	// shallow nesting still decodes
	const shallow = lib.encodeBinaryNode({ tag: 'a', attrs: {}, content: [{ tag: 'b', attrs: {}, content: Buffer.from('y') }] })
	const decoded = await lib.decodeBinaryNode(shallow)
	assert.equal(decoded.tag, 'a')
})

test('HB-102: noise processHandshake fails descriptively on a partial creds restore', () => {
	const handler = makeNoiseHandler({
		keyPair: lib.Curve.generateKeyPair(),
		NOISE_HEADER: lib.NOISE_WA_HEADER,
		logger: silentLogger
	})
	assert.throws(
		() => handler.processHandshake({ serverHello: { ephemeral: Buffer.alloc(32) } }, {}),
		/noiseKey is missing or incomplete/
	)
	assert.throws(
		() => handler.processHandshake(
			{ serverHello: { ephemeral: Buffer.alloc(32) } },
			{ public: Buffer.alloc(10), private: Buffer.alloc(32) }
		),
		/noiseKey|32-byte/
	)
})

test('HB-122: generateWAMessageFromContent tolerates bare-string content with quoted+ephemeral', () => {
	const msg = lib.generateWAMessageFromContent(
		'123@s.whatsapp.net',
		{ conversation: 'halo' },
		{ quoted: {
			key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'Q1' },
			message: { conversation: 'asal' }
		}, ephemeralExpiration: 86400 }
	)
	assert.ok(msg?.message)
})

test('HB-165: generateWAMessageContent does not mutate the caller react/poll objects', async () => {
	const react = { key: { remoteJid: '1@s.whatsapp.net', id: 'M1' }, text: '🔥' }
	await lib.generateWAMessageContent({ react }, genOpts())
	assert.equal(react.senderTimestampMs, undefined)
	const poll = { name: 'Q', values: ['A', 'B'] }
	await lib.generateWAMessageContent({ poll }, genOpts())
	assert.equal(poll.selectableCount, undefined)
	assert.equal(poll.toAnnouncementGroup, undefined)
})

function genOpts() {
	return {
		logger: silentLogger,
		userJid: '1@s.whatsapp.net',
		getProfilePicUrl: async () => undefined,
		getProfileName: async () => 'x',
		waUploadToServer: async () => ({}),
		mediaCache: undefined,
		options: {}
	}
}

test('HB-133: getCodeFromWSError matches "Timed Out" case-insensitively', () => {
	// our own Boom text is 'Timed Out' — the code must classify it
	const code = lib.getCodeFromWSError(new Error('Timed Out'))
	assert.ok(code !== undefined && code !== null)
	const lower = lib.getCodeFromWSError(new Error('socket timed out'))
	assert.equal(code, lower)
})

test('HB-277: assertImageWithinPixelLimit rejects a crafted >40MP PNG header, passes a small one', () => {
	const pngHeader = (w, h) => {
		const buf = Buffer.alloc(33)
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
		buf.writeUInt32BE(13, 8)
		buf.write('IHDR', 12, 'ascii')
		buf.writeUInt32BE(w, 16)
		buf.writeUInt32BE(h, 20)
		return buf
	}
	assert.equal(lib.MAX_IMAGE_PIXELS, 40_000_000)
	assert.throws(() => lib.assertImageWithinPixelLimit(pngHeader(17000, 17000), 'test'), /pixel limit/)
	assert.doesNotThrow(() => lib.assertImageWithinPixelLimit(pngHeader(100, 100), 'test'))
	// unknown formats keep the old behaviour (decode decides)
	assert.doesNotThrow(() => lib.assertImageWithinPixelLimit(Buffer.from('not an image'), 'test'))
})

test('HB-114: downloadContentFromMessage refuses a non-WhatsApp host without directPath', async () => {
	await assert.rejects(
		lib.downloadContentFromMessage(
			{ url: 'https://evil.internal.example/x', mediaKey: Buffer.alloc(32), directPath: undefined },
			'image', {}
		),
		err => /non-WhatsApp host/.test(err.message)
	)
})

test('HB-205: safe-fetch blocks private/loopback addresses, allows public ones', () => {
	assert.equal(lib.isBlockedAddress('127.0.0.1'), true)
	assert.equal(lib.isBlockedAddress('10.0.0.5'), true)
	assert.equal(lib.isBlockedAddress('192.168.1.1'), true)
	assert.equal(lib.isBlockedAddress('8.8.8.8'), false)
})

test('HB-205: getUrlInfo refuses an SSRF target without fetching it bare', async () => {
	await assert.rejects(lib.getUrlInfo('http://127.0.0.1:9/secret', {}), /non-public|refusing|blocked/i)
})

test('HB-1: parseAndInjectE2ESessions skips a bad bundle entry, injects the good ones', async () => {
	const kp = lib.Curve.generateKeyPair()
	const userNode = (jid, extra = []) => ({
		tag: 'user', attrs: { jid }, content: [
			{ tag: 'identity', attrs: {}, content: kp.public },
			{ tag: 'registration', attrs: {}, content: Buffer.from([0, 0, 0, 7]) },
			{ tag: 'skey', attrs: {}, content: [
				{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 6]) },
				{ tag: 'value', attrs: {}, content: kp.public },
				{ tag: 'signature', attrs: {}, content: Buffer.alloc(64, 1) }
			]},
			{ tag: 'key', attrs: {}, content: [
				{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 5]) },
				{ tag: 'value', attrs: {}, content: kp.public }
			]},
			...extra
		]
	})
	const bundle = { tag: 'iq', attrs: {}, content: [
		{ tag: 'list', attrs: {}, content: [
			{ tag: 'user', attrs: { jid: 'bad@s.whatsapp.net' }, content: [{ tag: 'error', attrs: { code: '401' } }] },
			userNode('good1@s.whatsapp.net'),
			userNode('good2@s.whatsapp.net')
		]}
	]}
	const injected = []
	const repo = { injectE2ESession: async ({ jid }) => { injected.push(jid) } }
	await parseAndInjectE2ESessions(bundle, repo, silentLogger)
	assert.deepEqual(injected.sort(), ['good1@s.whatsapp.net', 'good2@s.whatsapp.net'])
})

test('HB-273: encryptedStream surfaces a write-stream error instead of hanging/crashing', async () => {
	const prev = process.env.TMPDIR
	process.env.TMPDIR = '/nonexistent-p8-dir-xyz'
	try {
		await assert.rejects(
			encryptedStream(Buffer.from('hello world, hello WA'), 'image', { logger: silentLogger }),
			err => err?.code === 'ENOENT' || /ENOENT/.test(err.message)
		)
	} finally {
		if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev
	}
})

test('HB-175: one user\'s USync parser error does not abort the rest of the batch', () => {
	const q = new lib.USyncQuery().withDeviceProtocol()
	const deviceNode = id => ({
		tag: 'devices', attrs: {}, content: [
			{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: String(id) }, content: [] }] }
		]
	})
	const errorDeviceNode = {
		tag: 'devices', attrs: {}, content: [{ tag: 'error', attrs: { code: '404', text: 'not found' } }]
	}
	const result = { tag: 'iq', attrs: { type: 'result' }, content: [
		{ tag: 'usync', attrs: {}, content: [
			{ tag: 'list', attrs: {}, content: [
				{ tag: 'user', attrs: { jid: 'bad@s.whatsapp.net' }, content: [errorDeviceNode] },
				{ tag: 'user', attrs: { jid: 'good@s.whatsapp.net' }, content: [deviceNode(3)] }
			]}
		]}
	]}
	const parsed = q.parseUSyncQueryResult(result)
	assert.ok(parsed, 'parse returned nothing')
	const good = parsed.list.find(e => e.id === 'good@s.whatsapp.net')
	assert.ok(good?.devices?.deviceList?.length === 1, `good user lost: ${JSON.stringify(parsed.list)}`)
})

test('PTV delta: extractMessageContent maps ptvMessage to videoMessage; assertMediaContent accepts it', () => {
	const ptv = { ptvMessage: { url: 'https://mmg.whatsapp.net/x', mediaKey: Buffer.alloc(32) } }
	const extracted = lib.extractMessageContent(ptv)
	assert.ok(extracted.videoMessage, `expected videoMessage, got ${Object.keys(extracted)}`)
	assert.doesNotThrow(() => lib.assertMediaContent(ptv))
	const video = { videoMessage: { url: 'https://mmg.whatsapp.net/y' } }
	assert.ok(lib.extractMessageContent(video).videoMessage)
})
