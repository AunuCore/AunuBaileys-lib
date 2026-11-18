// AunuBaileys 2.2.0 batch regressions (heartbeat queue HB-337..HB-369 + addenda).
// Each test names the HB item it locks in and fails without its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { makeOfflineSocket, silentLogger } from './helpers.mjs'
import { Curve } from '../lib/Utils/crypto.js'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'

test('HB-361: Curve.verify rejects forged signatures and accepts genuine ones', () => {
	const keyPair = Curve.generateKeyPair()
	const message = Buffer.from('account-signature-payload')
	const signature = Curve.sign(keyPair.private, message)

	assert.equal(Curve.verify(keyPair.public, message, signature), true, 'genuine signature must verify')

	const tampered = Buffer.from(signature)
	tampered[0] = tampered[0] ^ 0xff
	assert.equal(Curve.verify(keyPair.public, message, tampered), false, 'tampered signature must be rejected')

	assert.equal(
		Curve.verify(keyPair.public, Buffer.from('a different message'), signature),
		false,
		'signature over another message must be rejected'
	)

	const other = Curve.generateKeyPair()
	assert.equal(Curve.verify(other.public, message, signature), false, 'signature under another key must be rejected')
})

test('HB-335 addenda: explicit-undefined config fields fall back to defaults instead of exploding', async () => {
	// every one of these used to clobber its default via the config
	// spread and explode as a bare TypeError at construction/first use
	const sock = await makeOfflineSocket({
		waWebSocketUrl: undefined,
		logger: undefined,
		makeSignalRepository: undefined,
		shouldIgnoreJid: undefined,
		patchMessageBeforeSending: undefined,
		customUploadHosts: undefined
	})
	assert.ok(sock, 'socket must construct with defaulted fields')
	assert.equal(typeof sock.shouldIgnoreJid, 'undefined') // config lives inside; construction not throwing is the lock
})

test('HB-342: a malformed custom pairing code is rejected before the handshake wait', async () => {
	const sock = await makeOfflineSocket()
	const t0 = Date.now()
	await assert.rejects(sock.requestPairingCode('6281234567890', 'NINECHARS'), /exactly 8 chars/)
	assert.ok(Date.now() - t0 < 5_000, 'rejection must be immediate, not after the 30s handshake race')
})

test('HB-341: WebSocketClient.close() settles within the grace window when the peer black-holes the close frame', async () => {
	// raw TCP server that completes the WS upgrade by hand, then goes
	// silent forever — the close frame is never answered
	const server = net.createServer(socket => {
		socket.once('data', data => {
			const key = /sec-websocket-key:\s*(.+)\r/i.exec(data.toString())?.[1]?.trim()
			const accept = createHash('sha1')
				.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
				.digest('base64')
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
					accept +
					'\r\n\r\n'
			)
			socket.on('data', () => {})
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port

	const client = new WebSocketClient(new URL(`ws://127.0.0.1:${port}/ws/chat`), {
		connectTimeoutMs: 2_000,
		options: {}
	})
	client.connect()
	await new Promise((resolve, reject) => {
		client.once('open', resolve)
		client.once('error', reject)
	})

	const t0 = Date.now()
	await client.close()
	const elapsed = Date.now() - t0
	server.close()
	assert.ok(elapsed < 12_000, `close() must settle via the 5s grace + terminate, not the 30s ws closeTimeout (took ${elapsed}ms)`)
})

test('HB-367: a key-bundle entry without a valid <registration> is skipped, never injected as a phantom session', async () => {
	const { parseAndInjectE2ESessions } = await import('../lib/Utils/signal.js')
	const { Curve: curve } = await import('../lib/Utils/crypto.js')
	const kp = curve.generateKeyPair()
	const userNode = (jid, registration) => ({
		tag: 'user',
		attrs: { jid },
		content: [
			{ tag: 'identity', attrs: {}, content: kp.public },
			...(registration ? [{ tag: 'registration', attrs: {}, content: registration }] : []),
			{
				tag: 'skey',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 6]) },
					{ tag: 'value', attrs: {}, content: kp.public },
					{ tag: 'signature', attrs: {}, content: Buffer.alloc(64, 1) }
				]
			},
			{
				tag: 'key',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 5]) },
					{ tag: 'value', attrs: {}, content: kp.public }
				]
			}
		]
	})
	const bundle = {
		tag: 'iq',
		attrs: {},
		content: [
			{
				tag: 'list',
				attrs: {},
				content: [
					userNode('missing@s.whatsapp.net', null),
					userNode('short@s.whatsapp.net', Buffer.from([0, 7])),
					userNode('good@s.whatsapp.net', Buffer.from([0, 0, 0, 7]))
				]
			}
		]
	}
	const injected = []
	const repo = {
		injectE2ESession: async ({ jid, session }) => {
			injected.push({ jid, registrationId: session.registrationId })
		}
	}
	await parseAndInjectE2ESessions(bundle, repo, silentLogger)
	assert.deepEqual(injected, [{ jid: 'good@s.whatsapp.net', registrationId: 7 }])
})

test('HB-358: remapping a PN to a new LID retires the old LID reverse mapping', async () => {
	const { LIDMappingStore } = await import('../lib/Signal/lid-mapping.js')
	const data = new Map()
	const keys = {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) {
				if (data.has(`${type}:${id}`)) out[id] = data.get(`${type}:${id}`)
			}
			return out
		},
		set: async update => {
			for (const [type, entries] of Object.entries(update)) {
				for (const [id, value] of Object.entries(entries)) {
					if (value === null) data.delete(`${type}:${id}`)
					else data.set(`${type}:${id}`, value)
				}
			}
		},
		transaction: async fn => fn()
	}
	const store = new LIDMappingStore(keys, silentLogger)
	const pnUserOf = jid => jid?.split('@')[0].split(':')[0]
	await store.storeLIDPNMappings([{ lid: '111@lid', pn: '628111@s.whatsapp.net' }])
	assert.equal(pnUserOf(await store.getPNForLID('111@lid')), '628111')

	await store.storeLIDPNMappings([{ lid: '222@lid', pn: '628111@s.whatsapp.net' }])
	assert.equal(await store.getLIDForPN('628111@s.whatsapp.net'), '222@lid')
	assert.equal(pnUserOf(await store.getPNForLID('222@lid')), '628111')
	assert.equal(await store.getPNForLID('111@lid'), null, 'the stale LID must no longer resolve back to the PN')
})

test('HB-2026-1112-114: getUrlFromDirectPath refuses a directPath that does not start with /', async () => {
	const { getUrlFromDirectPath } = await import('../lib/Utils/messages-media.js')
	assert.equal(getUrlFromDirectPath('/mms/image/abc123'), 'https://mmg.whatsapp.net/mms/image/abc123')
	assert.throws(() => getUrlFromDirectPath('@127.0.0.1:8443/evil.bin'), /malformed directPath/)
	assert.throws(() => getUrlFromDirectPath('@attacker.example/x.png'), /malformed directPath/)
})

test('HB-366: getWAUploadToServer tries the FRESH hosts after a media-conn refresh', async () => {
	const https = await import('node:https')
	const fs = await import('node:fs')
	const os = await import('node:os')
	const path = await import('node:path')
	const { execFileSync } = await import('node:child_process')
	const { getWAUploadToServer } = await import('../lib/Utils/messages-media.js')

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunu-220-hb366-'))
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'),
		'-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'
	], { stdio: 'ignore' })

	const hits = []
	const server = https.createServer(
		{ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) },
		(req, res) => {
			hits.push(req.url)
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ url: 'https://mmg.whatsapp.net/v/x.enc', direct_path: '/v/x.enc' }))
		}
	)
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const goodHost = `127.0.0.1:${server.address().port}`
	const deadHost = '127.0.0.1:1'

	let refreshCalls = 0
	const refreshMediaConn = async () => {
		refreshCalls += 1
		// first (unforced) lookup yields only the dead host; the forced
		// refresh after the failure yields the live one
		return refreshCalls === 1
			? { auth: 'old-auth', hosts: [{ hostname: deadHost }], ttl: 3600 }
			: { auth: 'fresh-auth', hosts: [{ hostname: goodHost }], ttl: 3600 }
	}

	const upload = getWAUploadToServer(
		{
			customUploadHosts: [],
			fetchAgent: new https.Agent({ rejectUnauthorized: false }),
			logger: silentLogger,
			options: {}
		},
		refreshMediaConn
	)
	const filePath = path.join(dir, 'media.bin')
	fs.writeFileSync(filePath, Buffer.alloc(64, 3))

	const result = await upload(filePath, { mediaType: 'image', fileEncSha256B64: 'AAAA', timeoutMs: 5_000 })
	server.close()
	assert.equal(result.directPath, '/v/x.enc')
	assert.ok(hits.length >= 1, 'the fresh host from the refresh must actually be tried')
	assert.ok(refreshCalls >= 2, 'a refresh must have happened after the dead host failed')
})

test('HB-337: a fromMe LID-mode 1:1 message takes remoteJidAlt from the RECIPIENT, not from our own sender alt', async () => {
	const { decodeMessageNode } = await import('../lib/Utils/decode-wa-message.js')
	const myPn = '628111@s.whatsapp.net'
	const myLid = '111222@lid'
	const peerPn = '628333@s.whatsapp.net'
	const peerLid = '333444@lid'

	const fromMeStanza = {
		tag: 'message',
		attrs: {
			id: 'ABCD1234',
			from: myLid,
			recipient: peerLid,
			addressing_mode: 'lid',
			sender_pn: myPn,
			recipient_pn: peerPn,
			t: '1700000000',
			type: 'text'
		},
		content: []
	}
	const decoded = decodeMessageNode(fromMeStanza, myPn, myLid).fullMessage
	assert.equal(decoded.key.remoteJid, peerLid)
	assert.equal(decoded.key.fromMe, true)
	assert.equal(decoded.key.remoteJidAlt, peerPn, 'remoteJidAlt must be the peer PN — our own PN here poisons the mapping')

	const incomingStanza = {
		tag: 'message',
		attrs: {
			id: 'ABCD1235',
			from: peerLid,
			addressing_mode: 'lid',
			sender_pn: peerPn,
			t: '1700000000',
			type: 'text'
		},
		content: []
	}
	const incoming = decodeMessageNode(incomingStanza, myPn, myLid).fullMessage
	assert.equal(incoming.key.remoteJidAlt, peerPn, 'incoming messages keep the sender alt')
})

test('HB-354: resolveTcTokenJid falls back to the raw JID when the LID lookup throws', async () => {
	const { resolveTcTokenJid } = await import('../lib/Utils/tc-token-utils.js')
	const throwing = async () => {
		throw new Error('USync failed')
	}
	assert.equal(await resolveTcTokenJid('628999@s.whatsapp.net', throwing), '628999@s.whatsapp.net')
	const working = async () => '999888@lid'
	assert.equal(await resolveTcTokenJid('628999@s.whatsapp.net', working), '999888@lid')
	assert.equal(await resolveTcTokenJid('999888@lid', throwing), '999888@lid')
})

test('HB-2026-1113-143 addendum: BufferJSON numeric form rejects non-byte values instead of wrapping them', async () => {
	const { BufferJSON } = await import('../lib/Utils/generics.js')
	const revive = json => JSON.parse(json, BufferJSON.reviver)
	assert.deepEqual([...revive('{"0":65,"1":66}')], [65, 66])
	assert.throws(() => revive('{"0":300}'), /invalid byte value/, '300 used to wrap silently to 44')
	assert.throws(() => revive('{"0":-1}'), /invalid byte value/)
	assert.throws(() => revive('{"0":1.5}'), /invalid byte value/, 'fractions used to truncate silently')
})

test('HB-340: a timed-out set IQ rejects; waitForMessage keeps the undefined-on-timeout contract', async () => {
	const { makeOfflineSocket, waitFor } = await import('./helpers.mjs')
	const { WebSocketServer } = await import('ws')
	// a black-hole WS server: accepts the connection, never answers —
	// the transport stays OPEN so waits can only settle by timeout
	const wss = new WebSocketServer({ port: 0 })
	await new Promise(resolve => wss.on('listening', resolve))
	const port = wss.address().port
	const sock = await makeOfflineSocket({ waWebSocketUrl: `ws://127.0.0.1:${port}/ws/chat` })
	try {
		await waitFor(() => sock.ws.socket?.readyState === 1, 5000)

		// the choke point itself: a timeout is swallowed into undefined
		assert.equal(await sock.waitForMessage('NO_SUCH_TAG', 200), undefined)

		// a set IQ must NEVER resolve as if the write landed: it either
		// hits the HB-340 throw (waitForMessage resolved undefined) or
		// the query-level timeout — both are a Boom 408 rejection
		await assert.rejects(
			sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'w:sync:app:state' }, content: [] }, 200),
			err => err?.output?.statusCode === 408,
			'a set IQ that times out must fail loudly, not resolve as if the write landed'
		)

		// a get IQ keeps the audited contract: resolve undefined on
		// timeout (the query-level 408 race predates this batch and is
		// unchanged); it must never resolve with a fabricated result
		const getOutcome = await sock
			.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'encrypt' }, content: [] }, 200)
			.then(value => ({ resolved: value }), err => ({ rejected: err }))
		if ('resolved' in getOutcome) {
			assert.equal(getOutcome.resolved, undefined)
		} else {
			assert.equal(getOutcome.rejected?.output?.statusCode, 408)
		}
	} finally {
		sock.end(new Error('test done'))
		await new Promise(resolve => wss.close(resolve))
	}
})
test('HB-295 addendum: a partial persist evicts the touched cache keys — the cache never serves replaced values', async () => {
	const { makeCacheableSignalKeyStore } = await import('../lib/Utils/auth-utils.js')
	const { silentLogger } = await import('./helpers.mjs')
	const backing = {
		session: { 'addr.1': Buffer.from('old-session') },
		'identity-key': { 'addr.1': Buffer.from('old-identity') }
	}
	const store = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) if (backing[type]?.[id]) out[id] = backing[type][id]
			return out
		},
		async set(data) {
			// applies types in order, then fails on identity-key (ENOSPC mid-set)
			for (const type in data) {
				if (type === 'identity-key') throw new Error('ENOSPC: no space left on device')
				for (const id in data[type]) backing[type][id] = data[type][id]
			}
		},
		async clear() {}
	}
	const keys = makeCacheableSignalKeyStore(store, silentLogger)
	const primed = await keys.get('session', ['addr.1'])
	assert.equal(primed['addr.1'].toString(), 'old-session', 'cache primed with the old value')
	await assert.rejects(
		keys.set({ session: { 'addr.1': Buffer.from('new-session') }, 'identity-key': { 'addr.1': Buffer.from('new-identity') } }),
		/ENOSPC/
	)
	const after = await keys.get('session', ['addr.1'])
	assert.equal(after['addr.1'].toString(), 'new-session', 'the persisted value must be served, not the stale cached one')
})

test('HB-264 addendum: an async listener rejection is contained by the event fan-out', async () => {
	const { lib, silentLogger, sleep } = await import('./helpers.mjs')
	const unhandled = []
	const onUnhandled = reason => unhandled.push(reason)
	process.on('unhandledRejection', onUnhandled)
	try {
		const ev = lib.makeEventBuffer(silentLogger)
		let second = 0
		ev.on('chats.upsert', async () => {
			throw new Error('async host bug')
		})
		ev.on('chats.upsert', () => {
			second++
		})
		ev.emit('chats.upsert', [{ id: '1@g.us' }])
		ev.flush()
		await sleep(50)
		assert.equal(second, 1, 'the sync listener after the async one still ran')
		assert.equal(unhandled.length, 0, 'no rejection may escape the dispatcher')
		ev.destroy()
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('HB-353 + addendum: chatModificationToAppPatch rejects malformed host payloads with Boom 400, not raw TypeErrors', async () => {
	const { chatModificationToAppPatch } = await import('../lib/Utils/chat-utils.js')
	const jid = '12345@g.us'
	const isBoom400 = err => err?.isBoom && err?.output?.statusCode === 400
	assert.throws(() => chatModificationToAppPatch(undefined, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch(null, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ star: { messages: [] } }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ star: {} }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ deleteForMe: undefined }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ deleteForMe: { key: {} } }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ addLabel: undefined }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ addChatLabel: {} }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ removeMessageLabel: { labelId: 'L1' } }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ quickReply: undefined }, jid), isBoom400)
	assert.throws(() => chatModificationToAppPatch({ archive: true, lastMessages: [null] }, jid), /Incomplete key/)
	const ok = chatModificationToAppPatch({ star: { star: true, messages: [{ id: 'MSG1', fromMe: true }] } }, jid)
	assert.deepEqual(ok.index, ['star', jid, 'MSG1', '1', '0'], 'the valid control still builds its patch')
})

test('HB-83 addendum: getNextPreKeys filters out entries whose PRIVATE half is corrupt or missing', async () => {
	const { lib, makeAuthState } = await import('./helpers.mjs')
	const { state } = await makeAuthState()
	const good = lib.Curve.generateKeyPair()
	await state.keys.set({
		'pre-key': {
			'5': { public: good.public, private: 123 },
			'6': { public: good.public },
			'7': good
		}
	})
	state.creds.firstUnuploadedPreKeyId = 5
	state.creds.nextPreKeyId = 8
	const { preKeys } = await lib.getNextPreKeys(state, 3)
	assert.deepEqual(Object.keys(preKeys), ['7'], 'only the entry with both key halves may be uploaded')
})

test('HB-343 addendum site 4: getDecryptionJid falls back to the raw sender when the LID lookup throws', async () => {
	const { getDecryptionJid } = await import('../lib/Utils/decode-wa-message.js')
	const throwingRepo = {
		lidMapping: {
			getLIDForPN: async () => {
				throw new Error('USync boom')
			}
		}
	}
	assert.equal(await getDecryptionJid('628123@s.whatsapp.net', throwingRepo), '628123@s.whatsapp.net')
	const okRepo = { lidMapping: { getLIDForPN: async () => '999888@lid' } }
	assert.equal(await getDecryptionJid('628123@s.whatsapp.net', okRepo), '999888@lid')
	assert.equal(await getDecryptionJid('999888@lid', throwingRepo), '999888@lid', 'LID senders never hit the lookup')
})

test('HB-278 addendum: a colliding chats.upsert restores the pre-existing chat instead of losing it', async () => {
	const { lib, silentLogger, sleep } = await import('./helpers.mjs')
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	ev.emit('chats.upsert', [{ id: '65900000123@s.whatsapp.net' }, { id: '123@s.whatsapp.net', conversationTimestamp: 1703936001 }])
	ev.flush()
	await sleep(20)
	assert.ok(store.chats.get('123@s.whatsapp.net'), 'control: chat B present after the initial upsert')
	ev.emit('chats.upsert', [{ id: '123@s.whatsapp.net', conversationTimestamp: 1703936000 }])
	ev.flush()
	await sleep(20)
	const b = store.chats.get('123@s.whatsapp.net')
	assert.ok(b, 'chat B must survive its own colliding upsert (restored), not vanish')
	assert.equal(b.conversationTimestamp, 1703936001, 'the restored chat is the pre-upsert version')
	ev.destroy()
})

test('HB-359: a stale flush timer from a finished session does not flush the next session early', async () => {
	const { lib, silentLogger, sleep, waitFor } = await import('./helpers.mjs')
	const ev = lib.makeEventBuffer(silentLogger)
	const seen = []
	ev.on('chats.upsert', chats => seen.push(...chats.map(c => c.id)))
	// session A: a buffered function completes, arming its 100ms timers
	const workA = ev.createBufferedFunction(async () => 'A')
	await workA()
	// session A ends via an explicit flush — flush() clears the stored
	// debounce timer, but the anonymous try-block timer is still pending
	ev.flush()
	// session B starts; a long-running buffered function holds it open
	const workB = ev.createBufferedFunction(async () => {
		await sleep(150)
		return 'B'
	})
	const bPromise = workB()
	ev.emit('chats.upsert', [{ id: 'session-b@g.us' }])
	// at +100ms session A's stale timer fires — it must NOT flush B
	await sleep(130)
	assert.deepEqual(seen, [], 'session B must still be buffering — the stale timer may not flush it')
	await bPromise
	await waitFor(() => seen.length === 1, 3000)
	assert.deepEqual(seen, ['session-b@g.us'], 'session B flushes on its own schedule')
	ev.destroy()
})
test('HB-370: a REVOKE update carrying the protocol message key does not re-key the stored message', async () => {
	const { lib, silentLogger, sleep } = await import('./helpers.mjs')
	const ev = lib.makeEventBuffer(silentLogger)
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	store.bind(ev)
	const chatJid = '628123@s.whatsapp.net'
	ev.emit('messages.upsert', {
		messages: [{ key: { remoteJid: chatJid, fromMe: false, id: 'TARGET1' }, message: { conversation: 'hello' }, messageTimestamp: 1700000000 }],
		type: 'notify'
	})
	ev.flush()
	await sleep(20)
	assert.ok(await store.loadMessage(chatJid, 'TARGET1'), 'control: message loadable before the revoke')
	// the exact shape process-message emits for a REVOKE: outer key = target, update.key = the protocol message's own key
	ev.emit('messages.update', [
		{
			key: { remoteJid: chatJid, fromMe: false, id: 'TARGET1' },
			update: { message: null, messageStubType: 1, key: { remoteJid: chatJid, fromMe: false, id: 'PROTO999' } }
		}
	])
	ev.flush()
	await sleep(20)
	const stillThere = await store.loadMessage(chatJid, 'TARGET1')
	assert.ok(stillThere, 'the revoked message must stay addressable under its own id')
	assert.equal(stillThere.key.id, 'TARGET1')
	assert.equal(await store.loadMessage(chatJid, 'PROTO999'), undefined, 'nothing may surface under the protocol message id')
	ev.destroy()
})
