// AunuBaileys 2.3.0 batch regression — HB-375 DSM facet:
// on a first send, the deviceSentMessage echo to our own devices
// used to wrap the ORIGINAL (pre-patch) message while the peer
// received the patchMessageBeforeSending output, so companion
// devices displayed different content from the peer. The fix
// routes own devices through the same patch + DSM-wrap path.
// Harness follows the test/21 recipe (real makeWASocket + real
// libsignal X3DH sessions, stub transport, pre-populated
// userDevicesCache, encryptMessage spy decoding the plaintext).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { lib, silentLogger, endQuietly } from './helpers.mjs'
import { makeCacheStore } from '../lib/Utils/internal-cache.js'
import { unpadRandomMax16 } from '../lib/Utils/generics.js'
import { waproto } from '../WAProto/index.js'

const require = createRequire(import.meta.url)
const libsignal = require('libsignal')

const ME_PN_USER = '6281234567890'
const ME_JID = `${ME_PN_USER}:42@s.whatsapp.net` // companion device 42 sends
const ME_LID = '100000000000001@lid'
const ME_PN_BARE = `${ME_PN_USER}@s.whatsapp.net`
const ME_PN_DEV1 = `${ME_PN_USER}:1@s.whatsapp.net`
const PEER_PN_USER = '6289876543210'
const PEER_PN = `${PEER_PN_USER}@s.whatsapp.net`

const makeBundle = () => {
	const idPair = libsignal.keyhelper.generateIdentityKeyPair()
	const spk = libsignal.keyhelper.generateSignedPreKey(idPair, 1)
	const pk = libsignal.keyhelper.generatePreKey(1)
	return {
		registrationId: libsignal.keyhelper.generateRegistrationId(),
		identityKey: idPair.pubKey,
		signedPreKey: { keyId: spk.keyId, publicKey: spk.keyPair.pubKey, signature: spk.signature },
		preKey: { keyId: pk.keyId, publicKey: pk.keyPair.pubKey }
	}
}

const patchHook = async msg => {
	if (msg && typeof msg.conversation === 'string') {
		return { ...msg, conversation: `${msg.conversation} [PATCHED]` }
	}

	if (msg?.extendedTextMessage?.text) {
		return {
			...msg,
			extendedTextMessage: { ...msg.extendedTextMessage, text: `${msg.extendedTextMessage.text} [PATCHED]` }
		}
	}

	return msg
}

const makeSocket = async ({ withPatch, patchFn }) => {
	const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunu-hb375-auth-'))
	const { state } = await lib.useMultiFileAuthState(authDir)
	state.creds.me = { id: ME_JID, lid: ME_LID, name: 'HB-Test' }
	state.creds.registered = true

	const userDevicesCache = makeCacheStore({ stdTTL: 300, maxEntries: 1000 })
	// AunuBaileys (2.7.0, HB-489): the device cache is keyed by the
	// normalised JID (user + server), not the bare user — seeds keyed
	// by the bare user are never read back and the send falls through
	// to a USync query the stub transport cannot answer.
	userDevicesCache.set(PEER_PN, [{ user: PEER_PN_USER, device: 0, server: 's.whatsapp.net' }])
	userDevicesCache.set(ME_PN_BARE, [
		{ user: ME_PN_USER, device: 0, server: 's.whatsapp.net' },
		{ user: ME_PN_USER, device: 1, server: 's.whatsapp.net' }
	])

	const sock = lib.makeWASocket({
		auth: state,
		logger: silentLogger,
		browser: ['HB-Test', 'Chrome', '1.0'],
		markOnlineOnConnect: false,
		fireInitQueries: false,
		shouldSyncHistoryMessage: () => false,
		connectTimeoutMs: 3000,
		defaultQueryTimeoutMs: 500,
		enableRecentMessageCache: true,
		emitOwnEvents: false,
		userDevicesCache,
		...(patchFn ? { patchMessageBeforeSending: patchFn } : withPatch ? { patchMessageBeforeSending: patchHook } : {})
	})
	const frames = []
	const fake = {
		send: (data, cb) => {
			frames.push(Buffer.from(data))
			cb && cb()
		},
		close: () => {}
	}
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })

	for (const jid of [PEER_PN, ME_PN_BARE, ME_PN_DEV1]) {
		await sock.signalRepository.injectE2ESession({ jid, session: makeBundle() })
	}

	const encRecords = []
	const origEncrypt = sock.signalRepository.encryptMessage.bind(sock.signalRepository)
	sock.signalRepository.encryptMessage = async args => {
		const out = await origEncrypt(args)
		try {
			const decoded = waproto.Message.decode(unpadRandomMax16(Buffer.from(args.data)))
			// sendMessage({ text }) encodes as extendedTextMessage,
			// not conversation — read both.
			const textOf = m => m?.conversation ?? m?.extendedTextMessage?.text
			encRecords.push({
				jid: args.jid,
				isDsm: !!decoded.deviceSentMessage,
				text: decoded.deviceSentMessage
					? textOf(decoded.deviceSentMessage.message)
					: textOf(decoded),
				destinationJid: decoded.deviceSentMessage?.destinationJid
			})
		} catch (e) {
			encRecords.push({ jid: args.jid, decodeErr: String(e) })
		}

		return out
	}

	return { sock, encRecords, authDir }
}

const cleanup = ctx => {
	endQuietly(ctx.sock)
	try {
		fs.rmSync(ctx.authDir, { recursive: true, force: true })
	} catch {
		// temp auth dir cleanup is best-effort
	}
}

test('HB-375: DSM echo to own devices carries the patched message, same as the peer copy', async () => {
	const ctx = await makeSocket({ withPatch: true })
	try {
		await ctx.sock.sendMessage(PEER_PN, { text: 'hello-375' })
		const peer = ctx.encRecords.find(r => r.jid === PEER_PN && !r.isDsm)
		assert.ok(peer, 'peer device must receive the message')
		assert.equal(peer.text, 'hello-375 [PATCHED]', 'peer receives the patched text')

		const echo0 = ctx.encRecords.find(r => r.jid === ME_PN_BARE && r.isDsm)
		assert.ok(echo0, 'own phone (device 0) must receive the DSM echo')
		assert.equal(
			echo0.text,
			'hello-375 [PATCHED]',
			'DSM echo inner message must be the PATCHED text — pre-fix it was the original "hello-375"'
		)
		assert.equal(echo0.destinationJid, PEER_PN, 'DSM destination stays the peer')

		const echo1 = ctx.encRecords.find(r => r.jid === ME_PN_DEV1 && r.isDsm)
		assert.ok(echo1, 'own device 1 must receive the DSM echo')
		assert.equal(echo1.text, 'hello-375 [PATCHED]', 'every own-device echo carries the patched text')
	} finally {
		cleanup(ctx)
	}
})

// ── HB-269 addendum 2: the reporting-site .find in the DM branch
// used to deref item.recipientJid on a null/undefined patch-array
// entry and kill the whole relay with a raw TypeError before any
// device enumeration. Post-fix the relay must get past the site —
// a wholly-bad patch array now fails later with the Boom 500
// 'All encryptions failed' guard, never the TypeError.
const isReportingSiteTypeError = e =>
	!!e && e instanceof TypeError && /recipientJid/i.test(e.message || '')

test('HB-269 addendum 2: patch array [null] no longer throws a raw TypeError at the reporting site', async () => {
	const ctx = await makeSocket({ patchFn: async () => [null] })
	try {
		let error
		try {
			await ctx.sock.sendMessage(PEER_PN, { text: 'halo-269' })
		} catch (e) {
			error = e
		}

		assert.ok(!isReportingSiteTypeError(error), 'must not throw the reporting-site TypeError')
		assert.ok(error?.isBoom && error?.output?.statusCode === 500, 'a wholly-bad patch fails later with the Boom 500 encryption guard')
	} finally {
		cleanup(ctx)
	}
})

test('HB-269 addendum 2: patch array [valid-other, null] no longer throws a raw TypeError at the reporting site', async () => {
	const ctx = await makeSocket({
		patchFn: async () => [
			{ recipientJid: '6289999999999@s.whatsapp.net', message: { conversation: 'hi' } },
			null
		]
	})
	try {
		let error
		try {
			await ctx.sock.sendMessage(PEER_PN, { text: 'halo-269' })
		} catch (e) {
			error = e
		}

		assert.ok(!isReportingSiteTypeError(error), 'must not throw the reporting-site TypeError')
		assert.ok(error?.isBoom, 'any later failure must be a Boom, not a raw error')
	} finally {
		cleanup(ctx)
	}
})

test('HB-269 addendum 2: patch array [undefined] no longer throws a raw TypeError at the reporting site', async () => {
	const ctx = await makeSocket({ patchFn: async () => [undefined] })
	try {
		let error
		try {
			await ctx.sock.sendMessage(PEER_PN, { text: 'halo-269' })
		} catch (e) {
			error = e
		}

		assert.ok(!isReportingSiteTypeError(error), 'must not throw the reporting-site TypeError')
		assert.ok(error?.isBoom && error?.output?.statusCode === 500, 'a wholly-bad patch fails later with the Boom 500 encryption guard')
	} finally {
		cleanup(ctx)
	}
})

test('HB-269 addendum 2 (control): patch array with a valid entry for the peer sends normally', async () => {
	const ctx = await makeSocket({
		patchFn: async () => [{ recipientJid: PEER_PN, message: { conversation: 'halo-269' } }]
	})
	try {
		const sent = await ctx.sock.sendMessage(PEER_PN, { text: 'halo-269' })
		assert.ok(sent?.key?.id, 'sendMessage must resolve with a msgId')
		const peer = ctx.encRecords.find(r => r.jid === PEER_PN && !r.isDsm)
		assert.ok(peer, 'peer device must receive the message')
		assert.equal(peer.text, 'halo-269', 'peer receives the per-jid patched text')
	} finally {
		cleanup(ctx)
	}
})

test('HB-375 (control): without a patch hook, DSM echo and peer copy are the original text', async () => {
	const ctx = await makeSocket({ withPatch: false })
	try {
		await ctx.sock.sendMessage(PEER_PN, { text: 'hello-375' })
		const peer = ctx.encRecords.find(r => r.jid === PEER_PN && !r.isDsm)
		assert.ok(peer, 'peer device must receive the message')
		assert.equal(peer.text, 'hello-375')
		const echo0 = ctx.encRecords.find(r => r.jid === ME_PN_BARE && r.isDsm)
		assert.ok(echo0, 'own phone (device 0) must receive the DSM echo')
		assert.equal(echo0.text, 'hello-375', 'no hook configured — behaviour unchanged')
	} finally {
		cleanup(ctx)
	}
})
