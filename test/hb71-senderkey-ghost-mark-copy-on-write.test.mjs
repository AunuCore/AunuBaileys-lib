// AunuBaileys 2.7.0 — HB-71 addendum facet 2 regression tests.
// relayMessage's group branch marks devices in the sender-key-memory
// map BEFORE sendNode. With a cacheable store (makeCacheableSignalKeyStore,
// the canonical host setup), keys.get returns the cache's LIVE object,
// so the mark leaked into the cache even when sendNode then failed and
// the deferred persist (HB-71 addendum) never ran — a ghost mark that
// suppressed the sender-key re-offer until the cache TTL expired.
// Fix: copy-on-write — the loaded map is cloned before marking; only
// the deferred persist after a successful send writes it back.
// Fails without the fix: after the failed send the cache contains the
// mark and the follow-up send does not re-offer the sender key.
// Ported from the run-1022 Rev B harness (t1022b) to node:test.
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { lib, makeAuthState, silentLogger, sleep, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { addTransactionCapability, makeCacheableSignalKeyStore } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { decodeDecompressedBinaryNode } from '../lib/WABinary/index.js'
import * as binaryConstants from '../lib/WABinary/constants.js'

WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const GROUP = '1234567890-1234567890@g.us'

const decodeFrameSync = data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	const payload = buf.subarray(off + 3, off + 3 + len)
	if (payload[0] !== 0) throw new Error('compressed frame, cannot decode sync')
	return decodeDecompressedBinaryNode(payload.subarray(1), binaryConstants)
}

const stanzaOffersSkdmToPeer = stanza => {
	if (!stanza || stanza.tag !== 'message' || !Array.isArray(stanza.content)) return false
	const parts = stanza.content.find(c => c?.tag === 'participants')
	if (!parts || !Array.isArray(parts.content)) return false
	return parts.content.some(n => n?.tag === 'to' && n?.attrs?.jid === PEER)
}

// Multi-file layout: sender-key-memory-<group>.json holds the per-group
// map itself, e.g. {"<peer>": true}.
const readPersistedSenderKeyMemory = dir => {
	const files = fs.readdirSync(dir).filter(f => f.startsWith('sender-key-memory-'))
	if (!files.length) return null
	return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'))
}

const buildGroupSocket = async ({ cacheable, failMessage }) => {
	const { dir, state } = await makeAuthState()
	const keys = cacheable ? makeCacheableSignalKeyStore(state.keys, silentLogger) : state.keys
	const auth = { creds: state.creds, keys }
	const sock = lib.makeWASocket({
		auth,
		logger: silentLogger,
		waWebSocketUrl: 'ws://127.0.0.1:9/ws/chat',
		connectTimeoutMs: 800,
		defaultQueryTimeoutMs: 800,
		keepAliveIntervalMs: 3_600_000,
		markOnlineOnConnect: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		generateHighQualityLinkPreview: false,
		banSentinel: false,
		browser: ['aunu-hb71', 'test', '1'],
		cachedGroupMetadata: async () => ({
			id: GROUP,
			addressingMode: 'pn',
			participants: [{ id: PEER }, { id: ME }],
			ephemeralDuration: 0
		})
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID, name: 'T' }
	sock.authState.creds.account = {
		details: randomBytes(32),
		accountSignatureKey: randomBytes(32),
		accountSignature: randomBytes(64)
	}
	// Pre-seed a sender-key-memory entry for the group (a group we have
	// sent to before — the map exists, so get() returns a live object).
	await keys.set({ 'sender-key-memory': { [GROUP]: {} } })

	const mintBundle = async (state, preKeyId = 11) => {
		const creds = state.creds
		const pre = Curve.generateKeyPair()
		await state.keys.set({ 'pre-key': { [preKeyId]: { private: pre.private, public: pre.public } } })
		return {
			registrationId: creds.registrationId,
			identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
			signedPreKey: {
				keyId: creds.signedPreKey.keyId,
				publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
				signature: creds.signedPreKey.signature
			},
			preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pre.public) }
		}
	}
	const bobDir = tmpDir('aunu-hb71-bob-')
	const { state: bobState } = await lib.useMultiFileAuthState(bobDir)
	bobState.keys = addTransactionCapability(bobState.keys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	await sock.signalRepository.injectE2ESession({ jid: PEER, session: await mintBundle(bobState) })
	// senderKeyRecipients also contains ME — inject a session for ME too
	// or assertSessions fetches its bundle and the distribution is skipped.
	const mePeerDir = tmpDir('aunu-hb71-mepeer-')
	const { state: mePeerState } = await lib.useMultiFileAuthState(mePeerDir)
	mePeerState.keys = addTransactionCapability(mePeerState.keys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	await sock.signalRepository.injectE2ESession({ jid: ME, session: await mintBundle(mePeerState, 12) })

	const attempts = []
	let failMsg = failMessage
	const fake = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) { if (ev === 'close') this._closeFn = fn },
		on() {},
		send(data, cb) {
			let node = null
			try { node = decodeFrameSync(data) } catch { /* not decodable */ }
			attempts.push(node)
			const isUsync = node?.tag === 'iq' && node?.attrs?.xmlns === 'usync'
			if (isUsync) {
				const usyncNode = node.content?.find(c => c?.tag === 'usync')
				const listNode = usyncNode?.content?.find(c => c?.tag === 'list')
				const users = Array.isArray(listNode?.content)
					? listNode.content.map(u => u?.attrs?.jid).filter(Boolean)
					: []
				const result = {
					tag: 'iq',
					attrs: { id: node.attrs.id, type: 'result', from: 's.whatsapp.net' },
					content: [{
						tag: 'usync',
						attrs: { context: 'message', mode: 'query', sid: 'thb71', last: 'true', index: '0' },
						content: [{
							tag: 'list',
							attrs: {},
							content: users.map(jid => ({
								tag: 'user',
								attrs: { jid },
								content: [{
									tag: 'devices',
									attrs: { version: '2' },
									content: [{ tag: 'device-list', attrs: {}, content: [{ tag: 'device', attrs: { id: '0', 'key-index': '1' } }] }]
								}]
							}))
						}]
					}]
				}
				setImmediate(() => sock.ws.emit(`TAG:${node.attrs.id}`, result))
				if (cb) cb()
				return
			}
			const shouldFail = failMsg && node?.tag === 'message'
			if (cb) cb(shouldFail ? new Error('SIMULATED-TRANSPORT-FAIL') : undefined)
		},
		close() { this.readyState = 3; if (this._closeFn) this._closeFn() }
	}
	sock.ws.socket = fake
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	const setFailMessage = v => { failMsg = v }
	return { sock, dir, keys, attempts, setFailMessage }
}

test('HB-71 facet 2: a failed group send leaves NO ghost mark in the cacheable store and the follow-up re-offers the sender key', async () => {
	const t2 = await buildGroupSocket({ cacheable: true, failMessage: true })
	try {
		await assert.rejects(() => t2.sock.sendMessage(GROUP, { text: 'hb71 must fail at sendNode' }))
		const attempted = t2.attempts.find(n => n?.tag === 'message')
		assert.ok(stanzaOffersSkdmToPeer(attempted), 'the attempted stanza did offer the sender key (marking happened)')
		const persisted = readPersistedSenderKeyMemory(t2.dir)
		assert.ok(persisted && persisted[PEER] !== true, 'the persisted file must not contain the mark (persist skipped on throw)')
		const cached = (await t2.keys.get('sender-key-memory', [GROUP]))[GROUP]
		assert.ok(cached?.[PEER] !== true, `the cache must not contain a ghost mark, got ${JSON.stringify(cached ?? null)}`)

		t2.setFailMessage(false)
		const attemptsBefore = t2.attempts.length
		const msg = await t2.sock.sendMessage(GROUP, { text: 'hb71 follow-up' })
		assert.equal(typeof msg?.key?.id, 'string')
		await sleep(300)
		const secondStanza = t2.attempts.slice(attemptsBefore).find(n => n?.tag === 'message')
		assert.ok(stanzaOffersSkdmToPeer(secondStanza), 'the follow-up stanza must re-offer the sender key')
	} finally {
		endQuietly(t2.sock)
	}
})

test('HB-71 facet 2 control: a successful group send still persists the mark', async () => {
	const t1 = await buildGroupSocket({ cacheable: true, failMessage: false })
	try {
		const msg = await t1.sock.sendMessage(GROUP, { text: 'hb71 control' })
		assert.equal(typeof msg?.key?.id, 'string')
		await sleep(300)
		const firstStanza = t1.attempts.find(n => n?.tag === 'message')
		assert.ok(stanzaOffersSkdmToPeer(firstStanza), 'the first stanza offers the sender key to the new device')
		const persisted = readPersistedSenderKeyMemory(t1.dir)
		assert.equal(persisted?.[PEER], true, 'the persisted file contains the mark after a successful send')
	} finally {
		endQuietly(t1.sock)
	}
})

test('HB-71 facet 2 control: plain (non-cacheable) store — failed send leaves no mark and the follow-up re-offers', async () => {
	const t3 = await buildGroupSocket({ cacheable: false, failMessage: true })
	try {
		await assert.rejects(() => t3.sock.sendMessage(GROUP, { text: 'hb71 plain must fail' }))
		const cached = (await t3.keys.get('sender-key-memory', [GROUP]))[GROUP]
		assert.ok(cached?.[PEER] !== true)
		t3.setFailMessage(false)
		const attemptsBefore = t3.attempts.length
		await t3.sock.sendMessage(GROUP, { text: 'hb71 plain follow-up' })
		await sleep(300)
		const secondStanza = t3.attempts.slice(attemptsBefore).find(n => n?.tag === 'message')
		assert.ok(stanzaOffersSkdmToPeer(secondStanza))
	} finally {
		endQuietly(t3.sock)
	}
})
