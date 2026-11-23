// AunuBaileys 2.4.0 batch regressions — COORDINATOR items (the
// producer-side / cross-file leftovers the file groups could not
// own): HB-411 addendum (boolean facet) and HB-411 addendum 5 in
// src/Utils/process-message.ts, and HB-2026-1113-223 addendum ke-4
// (redelivery strike counting) in src/Socket/messages-recv.ts.
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, waitFor, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import processMessage from '../lib/Utils/process-message.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'
import { waproto } from '../WAProto/index.js'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_LID = '111222333444555@lid'
const GROUP = '120363123456789@g.us'
const STUB = waproto.WebMessageInfo.StubType

// ── HB-411 addendum (boolean) + addendum 5: stub producer ──────

const groupCtx = events => {
	const ev = new EventEmitter()
	ev.on('groups.update', e => events.push(['groups.update', e]))
	ev.on('chats.update', e => events.push(['chats.update', e]))
	ev.on('group-participants.update', e => events.push(['group-participants.update', e]))
	return {
		ev,
		creds: { me: { id: ME, lid: ME_LID }, accountSettings: {} },
		logger: silentLogger,
		signalRepository: {},
		keyStore: {},
		options: {},
		getMessage: async () => undefined,
		shouldProcessHistoryMsg: false,
		placeholderResendCache: { get: async () => undefined, set: async () => {}, del: async () => {} }
	}
}

const stubMsg = (stubType, params) => ({
	key: {
		remoteJid: GROUP,
		fromMe: false,
		id: 'T-240-C1',
		participant: '6282222222@s.whatsapp.net',
		participantAlt: '6282222222@s.whatsapp.net'
	},
	messageStubType: stubType,
	messageStubParameters: params,
	messageTimestamp: 1760000000
})

const groupUpdateOf = events => events.find(([t]) => t === 'groups.update')?.[1]?.[0]

test('HB-411 addendum (boolean): a parameter-less boolean stub emits no groups.update at all', async () => {
	for (const stubType of [STUB.GROUP_CHANGE_ANNOUNCE, STUB.GROUP_CHANGE_RESTRICT, STUB.GROUP_MEMBER_ADD_MODE, STUB.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE]) {
		const events = []
		await processMessage(stubMsg(stubType, undefined), groupCtx(events))
		assert.equal(groupUpdateOf(events), undefined, `stub type ${stubType} without parameters must not emit a coerced false`)
		const events2 = []
		await processMessage(stubMsg(stubType, []), groupCtx(events2))
		assert.equal(groupUpdateOf(events2), undefined, `stub type ${stubType} with empty parameters must not emit a coerced false`)
	}
})

test('HB-411 addendum (boolean, control): a stub WITH a parameter still emits its boolean', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_CHANGE_ANNOUNCE, ['on']), groupCtx(events))
	assert.equal(groupUpdateOf(events)?.announce, true)
	const events2 = []
	await processMessage(stubMsg(STUB.GROUP_CHANGE_ANNOUNCE, ['off']), groupCtx(events2))
	assert.equal(groupUpdateOf(events2)?.announce, false, 'an explicit off is a legitimate false and must still be emitted')
	const events3 = []
	await processMessage(stubMsg(STUB.GROUP_MEMBER_ADD_MODE, ['all_member_add']), groupCtx(events3))
	assert.equal(groupUpdateOf(events3)?.memberAddMode, true)
})

test('HB-411 addendum 5: subject/description stubs also emit the sibling owner/time fields', async () => {
	const events = []
	await processMessage(stubMsg(STUB.GROUP_CHANGE_SUBJECT, ['New Subject']), groupCtx(events))
	const upd = groupUpdateOf(events)
	assert.equal(upd?.subject, 'New Subject')
	assert.equal(upd?.subjectOwner, '6282222222@s.whatsapp.net', 'the changer must ride along as subjectOwner')
	assert.equal(upd?.subjectTime, 1760000000, 'the change time must ride along as subjectTime')

	const events2 = []
	await processMessage(stubMsg(STUB.GROUP_CHANGE_DESCRIPTION, ['New Desc']), groupCtx(events2))
	const upd2 = groupUpdateOf(events2)
	assert.equal(upd2?.desc, 'New Desc')
	assert.equal(upd2?.descOwner, '6282222222@s.whatsapp.net')
	assert.equal(upd2?.descTime, 1760000000)
})

// ── HB-2026-1113-223 addendum ke-4: redelivery strikes ─────────

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

// A bundle the INITIATOR can inject, minted from the RECIPIENT's
// own identity + signed prekey (test-16/26 recipe).
const mintIncomingBundle = async (state, preKeyId = 11) => {
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

test('HB-2026-1113-223 ke-4: redeliveries of an already-decrypted 1:1 message never count toward the session reset', async () => {
	let sockAuth
	const deleteSessionCalls = []
	const failures = []
	const sent = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			sockAuth = auth
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	// Pre-seed the LID mappings (test-13 setupSocket pattern):
	// decryptMessageNode resolves the author's LID via USync on a
	// cache miss, which can never answer offline — a real companion
	// has these cached from history sync.
	await sock.signalRepository.lidMapping.storeLIDPNMappings([
		{ lid: ME_LID, pn: ME },
		{ lid: PEER_LID, pn: PEER }
	])
	fakeOpenTransport(sock, sent)
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		const peer = await makeRepo(tmpDir('aunu-240-223k4-peer-'))
		await peer.repo.injectE2ESession({ jid: ME, session: await mintIncomingBundle(sockAuth, 11) })
		// Wire plaintext is the Message protobuf with PKCS#7-style
		// padding to a 16-byte boundary (the shape
		// unpadRandomMax16 reverses on the receive path).
		const encMsg = text => {
			const raw = Buffer.from(waproto.Message.encode({ conversation: text }).finish())
			const pad = 16 - (raw.length % 16)
			return Buffer.concat([raw, Buffer.alloc(pad, pad)])
		}
		const stanza = (id, enc) => ({
			tag: 'message',
			attrs: { id, from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
			content: [{ tag: 'enc', attrs: { type: enc.type }, content: enc.ciphertext }]
		})
		// A successful delivery is observable in this harness as a
		// plain delivery receipt frame for the stanza id (a RETRY
		// receipt — the failure path's answer — carries a <retry>
		// child and does not count). Test-13 decode pattern.
		const deliveredIds = async () => {
			const ids = new Set()
			for (const buf of sent) {
				let off = 0
				if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
				const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
				try {
					const node = await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
					const kids = Array.isArray(node.content) ? node.content : []
					if (node.tag === 'receipt' && !kids.some(c => c.tag === 'retry')) {
						ids.add(node.attrs.id)
					}
				} catch {
					// a partial/non-node frame in the record — not a receipt
				}
			}
			return ids
		}
		const sawDelivery = async id => (await deliveredIds()).has(id)

		// Setup: a pkmsg establishes the session through the socket.
		const pk = await peer.repo.encryptMessage({ jid: ME, data: encMsg('setup-223k4') })
		assert.equal(pk.type, 'pkmsg', 'setup did not produce a pkmsg')
		sock.ws.emit('CB:message', stanza('HB223K4-SETUP', pk))
		assert.equal(await waitFor(() => sawDelivery('HB223K4-SETUP'), 8000), true, 'setup pkmsg must decrypt through the socket')

		// Complete the X3DH handshake: while the peer's session is
		// still pending-prekey it can only send pkmsg. One reply
		// from the socket side, decrypted by the peer at repo
		// level, ratchets the peer's session to a plain whisper
		// session — the state a real conversation is in when a
		// redelivery can occur.
		const reply = await sock.signalRepository.encryptMessage({ jid: PEER, data: encMsg('reply-223k4') })
		assert.equal(reply.type, 'msg', 'the socket reply must be a whisper message')
		await peer.repo.decryptMessage({ jid: ME, type: reply.type, ciphertext: reply.ciphertext })

		// A real whisper message, delivered once — decrypts fine.
		const m1 = await peer.repo.encryptMessage({ jid: ME, data: encMsg('real-223k4') })
		assert.equal(m1.type, 'msg', 'second message must be a whisper message')
		sock.ws.emit('CB:message', stanza('HB223K4-1', m1))
		assert.equal(await waitFor(() => sawDelivery('HB223K4-1'), 8000), true, 'the whisper message must decrypt through the socket')

		// The SAME stanza redelivered three times (ack lost / offline
		// replay). Each fails inside libsignal with the aggregate
		// 'No matching sessions found for message' — pre-fix each one
		// was a strike and the third reset the healthy session.
		for (let i = 0; i < 3; i++) {
			sock.ws.emit('CB:message', stanza('HB223K4-1', m1))
		}
		await sleep(1500)
		assert.equal(failures.length, 0, 'a redelivery of an already-decrypted message must not be reported as a decrypt failure')
		assert.equal(deleteSessionCalls.length, 0, 'redeliveries must never reset the healthy session')
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'the healthy session must survive')

		// Control: a genuinely new bad message still counts, once.
		sock.ws.emit('CB:message', {
			tag: 'message',
			attrs: { id: 'HB223K4-BAD', from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
			content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.alloc(32, 3) }]
		})
		assert.equal(await waitFor(() => failures.length >= 1, 8000), true, 'a new bad message must still be counted')
		assert.equal(failures[0].healed, false)
		assert.equal(failures[0].failures, 1)
	} finally {
		endQuietly(sock)
	}
})
