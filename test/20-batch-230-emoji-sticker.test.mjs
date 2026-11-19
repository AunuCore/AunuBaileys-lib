// (20) Batch 2.3.0 — experimental #36 `aunuSendEmojiSticker`:
// renders one emoji (single / VS16 / skin tone / ZWJ sequence) as a
// 512x512 WebP sticker from its Twemoji asset and sends it.
// Fully offline: the asset fetcher and the renderer/converter are
// stubbed, and the socket is a fake recording sendMessage calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
	attachAunuExperimental,
	aunuEmojiTwemojiFileName,
	aunuEmojiTwemojiAssetUrl,
	AUNU_TWEMOJI_ASSET_BASE_URL
} = await import(path.join(ROOT, 'lib/Socket/aunu-experimental.js'))

// Valid 1x1 transparent PNG fixture.
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
	'base64'
)

const JID = '12345@s.whatsapp.net'

const makeFakeSock = () => {
	const calls = { sendMessage: [] }
	const sock = {
		logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
		user: { id: '111@s.whatsapp.net' },
		sendMessage: async (jid, content, options) => {
			calls.sendMessage.push({ jid, content, options })
			return { key: { id: 'TEST-MSG-ID', remoteJid: jid } }
		},
		relayMessage: async () => {},
		waUploadToServer: async () => ({})
	}
	attachAunuExperimental(sock)
	return { sock, calls }
}

const isBoomWith = statusCode => err => {
	assert.ok(err?.isBoom, `expected a Boom error, got: ${err}`)
	assert.equal(err.output?.statusCode, statusCode)
	return true
}

test('(a) aunuSendEmojiSticker is registered on the socket as experimental #36', () => {
	const { sock } = makeFakeSock()
	assert.equal(typeof sock.aunuSendEmojiSticker, 'function')
	// The #36 registration lives in the module header list (kept in
	// the built .js/.d.ts comments): feature 36 names this method.
	const built = ['lib/Socket/aunu-experimental.js', 'lib/Socket/aunu-experimental.d.ts']
		.map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8'))
		.join('\n')
	assert.match(built, /36\. Emoji sticker[\s\S]{0,300}?aunuSendEmojiSticker/)
})

test('(b) twemoji file names: single, VS16, skin tone and ZWJ sequences', () => {
	const cases = [
		// single codepoint: grinning face U+1F600
		['\u{1F600}', '1f600.png'],
		// VS16 stripped when there is no ZWJ: heavy black heart U+2764 U+FE0F
		['\u2764\uFE0F', '2764.png'],
		// VS16 stripped: airplane U+2708 U+FE0F
		['\u2708\uFE0F', '2708.png'],
		// skin tone: thumbs up + medium skin tone U+1F44D U+1F3FD
		['\u{1F44D}\u{1F3FD}', '1f44d-1f3fd.png'],
		// ZWJ sequence: family (man ZWJ woman ZWJ girl)
		['\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '1f468-200d-1f469-200d-1f467.png'],
		// ZWJ sequence keeps U+FE0F: white flag + VS16 + ZWJ + rainbow
		['\u{1F3F3}\uFE0F\u200D\u{1F308}', '1f3f3-fe0f-200d-1f308.png']
	]
	for (const [emoji, expected] of cases) {
		assert.equal(aunuEmojiTwemojiFileName(emoji), expected, `file name for ${JSON.stringify(emoji)}`)
		assert.equal(aunuEmojiTwemojiAssetUrl(emoji), `${AUNU_TWEMOJI_ASSET_BASE_URL}${expected}`)
	}
	// assetBaseUrl override, with and without a trailing slash
	assert.equal(aunuEmojiTwemojiAssetUrl('\u{1F600}', 'https://example.test/twemoji'), 'https://example.test/twemoji/1f600.png')
	assert.equal(aunuEmojiTwemojiAssetUrl('\u{1F600}', 'https://example.test/twemoji/'), 'https://example.test/twemoji/1f600.png')
})

test('(c) send path: sendMessage receives the sticker content with the 512x512 WebP buffer from the stub renderer', async () => {
	const { sock, calls } = makeFakeSock()
	const webpStub = Buffer.from('WEBP-512x512-STUB')
	const seen = { urls: [], renderCalls: [] }
	const fetcher = async url => {
		seen.urls.push(url)
		return PNG_1X1
	}
	const renderer = async (pngBuffer, info) => {
		seen.renderCalls.push({ pngBuffer, info })
		return webpStub
	}
	const quoted = { key: { id: 'QUOTED-ID', remoteJid: JID }, message: { conversation: 'hi' } }
	const sent = await sock.aunuSendEmojiSticker(JID, '\u{1F600}', { fetcher, renderer, quoted })

	assert.deepEqual(seen.urls, [`${AUNU_TWEMOJI_ASSET_BASE_URL}1f600.png`])
	assert.equal(seen.renderCalls.length, 1)
	assert.deepEqual(seen.renderCalls[0].pngBuffer, PNG_1X1)
	assert.equal(seen.renderCalls[0].info.fileName, '1f600.png')
	assert.equal(seen.renderCalls[0].info.size, 512)
	assert.equal(seen.renderCalls[0].info.width, 512)
	assert.equal(seen.renderCalls[0].info.height, 512)

	// sendMessage({ sticker }) is the standard sticker send path:
	// prepareWAMessageMedia turns it into a stickerMessage on the wire.
	assert.equal(calls.sendMessage.length, 1)
	assert.equal(calls.sendMessage[0].jid, JID)
	assert.deepEqual(Object.keys(calls.sendMessage[0].content), ['sticker'])
	assert.deepEqual(calls.sendMessage[0].content.sticker, webpStub)
	assert.equal(calls.sendMessage[0].options.quoted, quoted)
	assert.equal(sent.key.id, 'TEST-MSG-ID')
})

test('(c2) fetcher may return a Response-like value and options.converter is honoured', async () => {
	const { sock, calls } = makeFakeSock()
	const webpStub = Buffer.from('WEBP-FROM-CONVERTER')
	let converterInfo
	const fetcher = async () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () =>
			PNG_1X1.buffer.slice(PNG_1X1.byteOffset, PNG_1X1.byteOffset + PNG_1X1.byteLength)
	})
	const converter = async (pngBuffer, info) => {
		assert.deepEqual(pngBuffer, PNG_1X1)
		converterInfo = info
		return new Uint8Array(webpStub)
	}
	await sock.aunuSendEmojiSticker(JID, '\u{1F44D}\u{1F3FD}', {
		fetcher,
		converter,
		assetBaseUrl: 'https://cdn.example.test/emoji'
	})
	assert.equal(converterInfo.fileName, '1f44d-1f3fd.png')
	assert.equal(calls.sendMessage.length, 1)
	assert.deepEqual(calls.sendMessage[0].content.sticker, webpStub)
})

test('(c3) default renderer (sharp, when present) produces a real 512x512 WebP', async t => {
	let sharp
	try {
		sharp = (await import('sharp')).default
	} catch {
		t.skip('sharp is not installed in this environment')
		return
	}
	const { sock, calls } = makeFakeSock()
	const fetcher = async () => PNG_1X1
	await sock.aunuSendEmojiSticker(JID, '\u{1F600}', { fetcher })
	assert.equal(calls.sendMessage.length, 1)
	const sticker = calls.sendMessage[0].content.sticker
	assert.ok(Buffer.isBuffer(sticker) && sticker.length > 0)
	const meta = await sharp(sticker).metadata()
	assert.equal(meta.format, 'webp')
	assert.equal(meta.width, 512)
	assert.equal(meta.height, 512)
})

test('(d) empty or invalid emoji rejects with Boom 400 and sends nothing', async () => {
	const { sock, calls } = makeFakeSock()
	const fetcher = async () => PNG_1X1
	const renderer = async () => Buffer.from('WEBP')
	for (const bad of ['', '   ', '\uFE0F', '\u200D', undefined, null, 42]) {
		await assert.rejects(sock.aunuSendEmojiSticker(JID, bad, { fetcher, renderer }), isBoomWith(400))
	}
	await assert.rejects(sock.aunuSendEmojiSticker('not-a-jid', '\u{1F600}', { fetcher, renderer }), isBoomWith(400))
	assert.equal(calls.sendMessage.length, 0)
})

test('(d2) asset fetch failures surface as Boom (HTTP status or 502)', async () => {
	const { sock, calls } = makeFakeSock()
	const renderer = async () => Buffer.from('WEBP')
	await assert.rejects(
		sock.aunuSendEmojiSticker(JID, '\u{1F600}', {
			fetcher: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
			renderer
		}),
		isBoomWith(404)
	)
	await assert.rejects(
		sock.aunuSendEmojiSticker(JID, '\u{1F600}', {
			fetcher: async () => {
				throw new Error('network down')
			},
			renderer
		}),
		isBoomWith(502)
	)
	assert.equal(calls.sendMessage.length, 0)
})
