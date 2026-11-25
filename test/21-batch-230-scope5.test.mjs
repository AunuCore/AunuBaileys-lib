// AunuBaileys 2.3.0 batch regressions — scope 5:
// HB-403 (LID DM device-aware sender skip), HB-261 addendum
// (groupInvite thumbnail best-effort), HB-253 addendum (empty
// album rejected). Each test names the HB item it locks in and
// fails without its fix. Everything runs offline against the
// built lib/: the WS connect is stubbed out and transports are
// fakes, so no test touches WA. Socket harness follows the
// run-0574 recipe (real makeWASocket + real libsignal X3DH
// sessions, stub transport, pre-populated userDevicesCache).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { lib, silentLogger, endQuietly } from './helpers.mjs'
import { makeCacheStore } from '../lib/Utils/internal-cache.js'
import { decodeBinaryNode } from '../lib/WABinary/decode.js'
import { unpadRandomMax16 } from '../lib/Utils/generics.js'
import { generateWAMessage } from '../lib/Utils/messages.js'
import { waproto } from '../WAProto/index.js'

const require = createRequire(import.meta.url)
const libsignal = require('libsignal')

const ME_PN_USER = '6281234567890'
const ME_JID = `${ME_PN_USER}:42@s.whatsapp.net` // production-like: companion device 42
const ME_LID_USER = '100000000000001'
const ME_LID = `${ME_LID_USER}@lid` // bare by nature (pair-success device.attrs.lid)
const PEER_LID_USER = '111222333444555'
const PEER_LID = `${PEER_LID_USER}@lid`
const PEER_PN_USER = '6289876543210'
const PEER_PN = `${PEER_PN_USER}@s.whatsapp.net`
const ME_PN_BARE = `${ME_PN_USER}@s.whatsapp.net`

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

/**
 * Real socket, stub transport, pre-populated device cache, real
 * libsignal sessions for every JID that will be encrypted to.
 * `ownLidDevices` lets a test add the sender's own LID device 42
 * to the enumeration (HB-403: it must still be skipped).
 */
const makeLidSocket = async (ownLidDevices = [{ user: ME_LID_USER, device: 0, server: 'lid' }]) => {
	const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunu-scope5-auth-'))
	const { state } = await lib.useMultiFileAuthState(authDir)
	state.creds.me = { id: ME_JID, lid: ME_LID, name: 'HB-Test' }
	state.creds.registered = true

	const userDevicesCache = makeCacheStore({ stdTTL: 300, maxEntries: 1000 })
	// AunuBaileys (2.7.0, HB-489): the device cache is keyed by the
	// normalised JID (user + server) — seeds keyed by the bare user
	// miss every read, and the send falls through to a USync IQ the
	// offline transport cannot answer (Boom 408).
	userDevicesCache.set(PEER_LID, [{ user: PEER_LID_USER, device: 0, server: 'lid' }])
	userDevicesCache.set(ME_LID, ownLidDevices)
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
		userDevicesCache
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

	for (const jid of [PEER_LID, ME_LID, PEER_PN, ME_PN_BARE, `${ME_PN_USER}:1@s.whatsapp.net`]) {
		await sock.signalRepository.injectE2ESession({ jid, session: makeBundle() })
	}

	const encRecords = []
	const origEncrypt = sock.signalRepository.encryptMessage.bind(sock.signalRepository)
	sock.signalRepository.encryptMessage = async args => {
		const out = await origEncrypt(args)
		try {
			const decoded = waproto.Message.decode(unpadRandomMax16(Buffer.from(args.data)))
			encRecords.push({ jid: args.jid, type: out.type, isDsm: !!decoded.deviceSentMessage })
		} catch (e) {
			encRecords.push({ jid: args.jid, type: out.type, decodeErr: String(e) })
		}

		return out
	}

	const stanzasSince = async fromIdx => {
		const out = []
		for (const buf of frames.slice(fromIdx)) {
			try {
				const payload = buf[0] === 0x57 && buf[1] === 0x41 ? buf.subarray(7) : buf.subarray(3)
				const node = await decodeBinaryNode(payload)
				if (node?.tag === 'message') out.push(node)
			} catch {
				// non-message frames are not what this helper counts
			}
		}

		return out
	}

	return { sock, frames, encRecords, stanzasSince, authDir }
}

const cleanup = (ctx, sock) => {
	endQuietly(sock)
	try {
		fs.rmSync(ctx.authDir, { recursive: true, force: true })
	} catch {
		// temp auth dir cleanup is best-effort
	}
}

test('HB-403: LID DM echoes DSM to own phone (device 0), not skipped as the sender device', async () => {
	const ctx = await makeLidSocket()
	try {
		const mark = ctx.encRecords.length
		const sent = await ctx.sock.sendMessage(PEER_LID, { text: 'lid-dm-0574' })
		assert.ok(sent?.key?.id, 'sendMessage must resolve with a msgId')
		const encs = ctx.encRecords.slice(mark)
		assert.ok(
			encs.find(r => r.jid === PEER_LID && !r.isDsm),
			'peer must receive the message'
		)
		assert.ok(
			encs.find(r => r.jid === ME_LID && r.isDsm),
			'own LID device 0 (the phone) must receive the DSM echo — pre-fix it was skipped as "exact sender device"'
		)
	} finally {
		cleanup(ctx, ctx.sock)
	}
})

test('HB-403: LID self-chat with only device 0 sends a non-empty stanza (no silent empty send)', async () => {
	const ctx = await makeLidSocket()
	try {
		const mark = ctx.encRecords.length
		const fmark = ctx.frames.length
		const sent = await ctx.sock.sendMessage(ME_LID, { text: 'lid-self-0574' })
		assert.ok(sent?.key?.id, 'sendMessage must resolve with a msgId')
		const encs = ctx.encRecords.slice(mark)
		assert.ok(encs.length > 0, 'at least one device must be encrypted to — pre-fix every device was skipped')
		assert.ok(
			encs.find(r => r.jid === ME_LID && r.isDsm),
			'own LID device 0 must receive the DSM echo for the self-chat'
		)
		const stanzas = await ctx.stanzasSince(fmark)
		const stanza = stanzas.find(s => s.attrs?.to === ME_LID)
		assert.ok(stanza, 'a message stanza to the own LID must be sent')
		assert.ok(
			(stanza.content || []).length > 0,
			'the stanza must carry participants — pre-fix it went out with 0 children'
		)
	} finally {
		cleanup(ctx, ctx.sock)
	}
})

test('HB-403: the sender device itself is still skipped, under LID addressing too', async () => {
	const ctx = await makeLidSocket([
		{ user: ME_LID_USER, device: 0, server: 'lid' },
		{ user: ME_LID_USER, device: 42, server: 'lid' }
	])
	try {
		const mark = ctx.encRecords.length
		await ctx.sock.sendMessage(PEER_LID, { text: 'lid-dm-skip-0574' })
		const encs = ctx.encRecords.slice(mark)
		assert.equal(
			encs.find(r => r.jid === `${ME_LID_USER}:42@lid`),
			undefined,
			'own LID device 42 IS the sending device (same device number as me.id) and must still be skipped'
		)
		assert.ok(
			encs.find(r => r.jid === ME_LID && r.isDsm),
			'... while the phone (device 0) still gets its DSM echo'
		)
	} finally {
		cleanup(ctx, ctx.sock)
	}
})

test('HB-403 (control): PN DM echoes DSM to own PN device 0', async () => {
	const ctx = await makeLidSocket()
	try {
		const mark = ctx.encRecords.length
		await ctx.sock.sendMessage(PEER_PN, { text: 'pn-dm-0574' })
		const encs = ctx.encRecords.slice(mark)
		assert.ok(
			encs.find(r => r.jid === ME_PN_BARE && r.isDsm),
			'PN DM must echo DSM to own PN device 0 (unchanged behaviour)'
		)
	} finally {
		cleanup(ctx, ctx.sock)
	}
})

test('HB-403 (control): PN self-chat sends a non-empty stanza with a DSM echo', async () => {
	const ctx = await makeLidSocket()
	try {
		const mark = ctx.encRecords.length
		const fmark = ctx.frames.length
		const sent = await ctx.sock.sendMessage(ME_PN_BARE, { text: 'pn-self-0574' })
		assert.ok(sent?.key?.id, 'sendMessage must resolve with a msgId')
		const encs = ctx.encRecords.slice(mark)
		assert.ok(
			encs.find(r => r.jid === ME_PN_BARE && r.isDsm),
			'PN self-chat must echo DSM to own PN device 0'
		)
		const stanzas = await ctx.stanzasSince(fmark)
		const stanza = stanzas.find(s => s.attrs?.to === ME_PN_BARE)
		assert.ok(stanza && (stanza.content || []).length > 0, 'PN self-chat stanza must be non-empty')
	} finally {
		cleanup(ctx, ctx.sock)
	}
})

const GROUP_JID = '120363012345678901@g.us'
const inviteContent = {
	groupInvite: {
		inviteCode: 'AbCdEfGhIjKlMnOp',
		inviteExpiration: 0,
		text: 'join us',
		jid: GROUP_JID,
		subject: 'HB Test Group'
	}
}

test('HB-261 addendum: groupInvite still builds when the profile-pic lookup throws', async () => {
	const msg = await generateWAMessage(GROUP_JID, inviteContent, {
		logger: silentLogger,
		getProfilePicUrl: async () => {
			throw new Error('SIMULATED-PFP-IQ-FAIL')
		}
	})
	assert.equal(msg?.message?.groupInviteMessage?.inviteCode, 'AbCdEfGhIjKlMnOp')
	assert.equal(msg?.message?.groupInviteMessage?.jpegThumbnail, undefined)
})

test('HB-261 addendum: groupInvite still builds when the thumbnail fetch throws', async () => {
	const origFetch = globalThis.fetch
	globalThis.fetch = async () => {
		throw new Error('SIMULATED-FETCH-FAIL')
	}
	try {
		const msg = await generateWAMessage(GROUP_JID, inviteContent, {
			logger: silentLogger,
			getProfilePicUrl: async () => 'https://example.invalid/pfp.jpg'
		})
		assert.equal(msg?.message?.groupInviteMessage?.inviteCode, 'AbCdEfGhIjKlMnOp')
		assert.equal(msg?.message?.groupInviteMessage?.jpegThumbnail, undefined)
	} finally {
		globalThis.fetch = origFetch
	}
})

test('HB-261 addendum (control): groupInvite attaches the thumbnail when the fetch succeeds', async () => {
	const origFetch = globalThis.fetch
	globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
	try {
		const msg = await generateWAMessage(GROUP_JID, inviteContent, {
			logger: silentLogger,
			getProfilePicUrl: async () => 'https://example.invalid/pfp.jpg'
		})
		assert.equal(msg?.message?.groupInviteMessage?.inviteCode, 'AbCdEfGhIjKlMnOp')
		assert.equal(msg?.message?.groupInviteMessage?.jpegThumbnail?.length, 3)
	} finally {
		globalThis.fetch = origFetch
	}
})

test('HB-261 addendum (control): groupInvite builds with no thumbnail when there is no profile pic', async () => {
	const msg = await generateWAMessage(GROUP_JID, inviteContent, {
		logger: silentLogger,
		getProfilePicUrl: async () => undefined
	})
	assert.equal(msg?.message?.groupInviteMessage?.inviteCode, 'AbCdEfGhIjKlMnOp')
	assert.equal(msg?.message?.groupInviteMessage?.jpegThumbnail, undefined)
})

test('HB-253 addendum: an empty album rejects with Boom 400', async () => {
	await assert.rejects(
		generateWAMessage(GROUP_JID, { album: {} }, { logger: silentLogger }),
		err => err?.output?.statusCode === 400
	)
})

test('HB-253 addendum: an album with only zero counts rejects with Boom 400', async () => {
	await assert.rejects(
		generateWAMessage(GROUP_JID, { album: { expectedImageCount: 0, expectedVideoCount: 0 } }, { logger: silentLogger }),
		err => err?.output?.statusCode === 400
	)
})

test('HB-253 addendum: an album with a non-finite count rejects with Boom 400', async () => {
	await assert.rejects(
		generateWAMessage(GROUP_JID, { album: { expectedImageCount: NaN } }, { logger: silentLogger }),
		err => err?.output?.statusCode === 400
	)
	await assert.rejects(
		generateWAMessage(GROUP_JID, { album: { expectedVideoCount: -1 } }, { logger: silentLogger }),
		err => err?.output?.statusCode === 400
	)
})

test('HB-253 addendum (control): an album with a valid count builds', async () => {
	const msg = await generateWAMessage(GROUP_JID, { album: { expectedImageCount: 2 } }, { logger: silentLogger })
	assert.equal(msg?.message?.albumMessage?.expectedImageCount, 2)
	const msg2 = await generateWAMessage(
		GROUP_JID,
		{ album: { expectedImageCount: 0, expectedVideoCount: 1 } },
		{ logger: silentLogger }
	)
	assert.equal(msg2?.message?.albumMessage?.expectedVideoCount, 1)
})
