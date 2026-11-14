// (f) messages.decrypt-failure surface, (g) USync protocol count = 12,
// (h) Tenka symbol audit (tenka_needs.json, AnyMessageContent exempt).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, lib, silentLogger } from './helpers.mjs'

test('(h) Tenka audit: all 28 runtime symbols from tenka_needs.json are exported', () => {
	// The canonical file lives in the maintainer tree (outside the
	// repo); from a bare repo checkout it is absent, so fall back to
	// the vendored copy below (identical list).
	let needs = null
	try {
		needs = JSON.parse(
			fs.readFileSync(path.join(ROOT, '..', 'aunubaileys-tools', 'tenka_needs.json'), 'utf8')
		)
	} catch { /* bare checkout — vendored list below */ }
	const list = Array.isArray(needs) && needs.length ? needs : FALLBACK_TENKA
	for (const name of list) {
		if (name === 'AnyMessageContent') continue // type-only, exempt
		assert.ok(name in lib, `missing export: ${name}`)
	}
})

const FALLBACK_TENKA = [
	'makeWASocket', 'BufferJSON', 'processedMessages', 'PHONENUMBER_MCC',
	'initInMemoryKeyStore', 'DisconnectReason', 'AnyMessageContent',
	'makeInMemoryStore', 'useMultiFileAuthState', 'delay',
	'fetchLatestBaileysVersion', 'generateForwardMessageContent',
	'prepareWAMessageMedia', 'generateWAMessageFromContent',
	'generateMessageID', 'downloadContentFromMessage', 'jidDecode',
	'makeCacheableSignalKeyStore', 'getAggregateVotesInPollMessage',
	'proto', 'extractImageThumb', 'downloadMediaMessage', 'Browsers',
	'areJidsSameUser', 'extractMessageContent', 'getContentType',
	'getDevice', 'generateWAMessage', 'jidNormalizedUser'
]

test('export surface stays broad (>= 400 runtime exports)', () => {
	assert.ok(Object.keys(lib).length >= 400, `only ${Object.keys(lib).length} exports`)
})

test('(f) messages.decrypt-failure is declared in the socket event types', () => {
	const dts = fs.readFileSync(path.join(ROOT, 'lib/Types/Events.d.ts'), 'utf8')
	assert.match(dts, /'messages\.decrypt-failure':/)
	// and the payload carries the self-heal fields hosts branch on
	for (const field of ['remoteJid', 'author', 'failures', 'healed', 'errorClass']) {
		assert.match(dts, new RegExp(field), `decrypt-failure payload missing ${field}`)
	}
})

test('(f) messages.decrypt-failure can be subscribed and emitted on a real event buffer', async () => {
	const ev = lib.makeEventBuffer(silentLogger)
	let got = null
	ev.on('messages.decrypt-failure', payload => { got = payload })
	ev.emit('messages.decrypt-failure', {
		remoteJid: '123@s.whatsapp.net', author: '123@s.whatsapp.net',
		address: '123', isGroup: false, failures: 1, healed: false,
		errorClass: 'session', messageId: 'ABC', timestamp: 1
	})
	await new Promise(r => setTimeout(r, 100))
	assert.equal(got?.remoteJid, '123@s.whatsapp.net')
	ev.destroy()
})

test('(g) USync protocol count is exactly 12', () => {
	const q = new lib.USyncQuery()
	q.withDeviceProtocol().withContactProtocol().withStatusProtocol()
		.withDisappearingModeProtocol().withBotProfileProtocol().withLIDProtocol()
		.withUsernameProtocol().withBusinessProtocol().withPictureProtocol()
		.withTextStatusProtocol().withSidelistProtocol().withFeatureProtocol()
	assert.equal(q.protocols.length, 12)
	assert.equal(new Set(q.protocols.map(p => p.name)).size, 12)
	const files = fs.readdirSync(path.join(ROOT, 'src/WAUSync/Protocols'))
		.filter(f => f.endsWith('.ts') && f !== 'index.ts')
	assert.equal(files.length, 12, `protocol files: ${files.join(',')}`)
})
