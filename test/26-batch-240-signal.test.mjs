// AunuBaileys 2.4.0 batch regressions — GROUP C (signal):
// HB-409 (+ TOCTOU addendum), HB-449, HB-446, HB-440, HB-469,
// HB-94 addendum run-0590 (bare-set resurrection) + run-0646
// (multi-JID delete key), HB-367 addendum (31-byte bundle keys),
// HB-371 addendum faset ke-5 (store-error strikes), HB-416
// addendum 3 (lid-mapping throw in assertSessions), and
// HB-2026-1113-223 addenda ke-3/ke-5/ke-6 (+ ke-2 sapuan) in the
// decode-wa-message classifiers. HB-350 addendum is
// HELD-FOR-DECISION (no safe in-tree mitigation) — no test.
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, waitFor, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { parseAndInjectE2ESessions } from '../lib/Utils/signal.js'
import { isSenderKeyUnavailableError, isUnrecoverableSessionError } from '../lib/Utils/decode-wa-message.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const GROUP = '120363012345678@g.us'
const ME = '628123456789@s.whatsapp.net'
const ME_LID = '100000123456789@lid'
const PEER = '628987654321@s.whatsapp.net'
const PEER_LID = '111222333444555@lid'

const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

const bundleFor = () => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
	}
}

// A bundle the INITIATOR can inject, minted from the RECIPIENT's
// own identity + signed prekey, with the prekey stored in the
// recipient's store (test-16 recipe).
const mintIncomingBundle = async (state, preKeyId = 11) => {
	const creds = state.creds
	const pre = Curve.generateKeyPair()
	await state.keys.set({ 'pre-key': { [preKeyId]: { private: pre.private, public: pre.public } } })
	return {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: { keyId: creds.signedPreKey.keyId, publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public), signature: creds.signedPreKey.signature },
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pre.public) }
	}
}

const msgStanza = (id, ciphertext) => ({
	tag: 'message',
	attrs: { id, from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
	content: [{ tag: 'enc', attrs: { type: 'msg' }, content: ciphertext }]
})

// ── HB-409: migrateSession must not overwrite a live LID session ──

test('HB-409: migrateSession skips a device whose LID target already has an open session', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-240-409-'))
	const PN = '628999888777@s.whatsapp.net'
	const LID = '100000999888777@lid'
	await repo.injectE2ESession({ jid: PN, session: bundleFor() })
	await repo.injectE2ESession({ jid: LID, session: bundleFor() })
	const lidAddr = repo.jidToSignalProtocolAddress(LID)
	const { [lidAddr]: lidBefore } = await state.keys.get('session', [lidAddr])
	assert.ok(lidBefore, 'setup: LID session missing')
	await state.keys.set({ 'device-list': { 628999888777: ['0'] } })
	const result = await repo.migrateSession(PN, LID)
	assert.equal(result.migrated, 0, `a live LID session must not be overwritten (got ${JSON.stringify(result)})`)
	assert.equal(result.total, 1)
	const { [lidAddr]: lidAfter } = await state.keys.get('session', [lidAddr])
	assert.deepEqual(lidAfter, lidBefore, 'the LID session record must be byte-identical after the skipped migration')
	assert.equal((await repo.validateSession(PN)).exists, true, 'the PN session must survive a skipped migration')
	assert.equal((await repo.validateSession(LID)).exists, true, 'the LID session must survive')
})

test('HB-409 (control): migrateSession still migrates when the LID target has no session', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-240-409c-'))
	const PN = '628999888777@s.whatsapp.net'
	const LID = '100000999888777@lid'
	await repo.injectE2ESession({ jid: PN, session: bundleFor() })
	await state.keys.set({ 'device-list': { 628999888777: ['0'] } })
	const result = await repo.migrateSession(PN, LID)
	assert.equal(result.migrated, 1, `expected the session to migrate (got ${JSON.stringify(result)})`)
	assert.equal((await repo.validateSession(LID)).exists, true)
	assert.deepEqual(await repo.validateSession(PN), { exists: false, reason: 'no session' })
})

test('HB-409 addendum (TOCTOU): migrateSession serialises against a transaction held on the LID wire address', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-240-409t-'))
	const PN = '628999888777@s.whatsapp.net'
	const LID = '100000999888777@lid'
	await repo.injectE2ESession({ jid: PN, session: bundleFor() })
	await state.keys.set({ 'device-list': { 628999888777: ['0'] } })
	const lidAddr = repo.jidToSignalProtocolAddress(LID)
	// Hold a transaction under the peer's wire-address key — the
	// key a concurrent pkmsg decrypt for this peer would hold.
	// Pre-fix the migration ran under a bespoke key and completed
	// underneath the hold, free to overwrite whatever the held
	// transaction was about to commit.
	const hold = state.keys.transaction(async () => {
		await sleep(400)
	}, lidAddr)
	await sleep(30)
	let migDone = false
	const mig = repo.migrateSession(PN, LID).then(r => {
		migDone = true
		return r
	})
	await sleep(150)
	assert.equal(migDone, false, 'migration must wait for the wire-address transaction, not race past it')
	await hold
	const result = await mig
	assert.equal(result.migrated, 1, `migration must complete after the hold releases (got ${JSON.stringify(result)})`)
})

// ── HB-449: a fresh PN session after the first migration migrates ──

test('HB-449: migrateSession migrates a PN session created after an earlier migration of the same device', async () => {
	const { repo, state } = await makeRepo(tmpDir('aunu-240-449-'))
	const PN = '628999888777@s.whatsapp.net'
	const LID = '100000999888777@lid'
	await state.keys.set({ 'device-list': { 628999888777: ['0'] } })
	await repo.injectE2ESession({ jid: PN, session: bundleFor() })
	const first = await repo.migrateSession(PN, LID)
	assert.equal(first.migrated, 1, `setup migration failed (got ${JSON.stringify(first)})`)
	// The peer re-keys under the PN spelling (fresh session record).
	await repo.injectE2ESession({ jid: PN, session: bundleFor() })
	assert.equal((await repo.validateSession(PN)).exists, true, 'setup: fresh PN session missing')
	// Pre-fix the never-invalidated migratedSessionCache skipped
	// this device for 3 days and the fresh session stayed orphaned.
	const second = await repo.migrateSession(PN, LID)
	assert.equal(second.migrated, 1, `the fresh PN session must migrate too (got ${JSON.stringify(second)})`)
	assert.deepEqual(await repo.validateSession(PN), { exists: false, reason: 'no session' })
	assert.equal((await repo.validateSession(LID)).exists, true)
})

// ── HB-440: one unbuildable JID must not abort the batch delete ──

test('HB-440: deleteSession deletes the buildable entries when one JID cannot be built', async () => {
	const { repo } = await makeRepo(tmpDir('aunu-240-440-'))
	const GOOD1 = '6281111111111@s.whatsapp.net'
	const GOOD2 = '6282222222222@s.whatsapp.net'
	await repo.injectE2ESession({ jid: GOOD1, session: bundleFor() })
	await repo.injectE2ESession({ jid: GOOD2, session: bundleFor() })
	// ':99' on a non-hosted server makes jidToSignalProtocolAddress
	// throw; pre-fix it aborted the whole batch before any commit.
	await repo.deleteSession(['628999888777:99@s.whatsapp.net', GOOD1, GOOD2])
	assert.deepEqual(await repo.validateSession(GOOD1), { exists: false, reason: 'no session' }, 'first good entry must be deleted')
	assert.deepEqual(await repo.validateSession(GOOD2), { exists: false, reason: 'no session' }, 'second good entry must be deleted')
	// Reversed order (bad entry last) and a JID with no user part.
	await repo.injectE2ESession({ jid: GOOD1, session: bundleFor() })
	await repo.deleteSession([GOOD1, 'nope'])
	assert.deepEqual(await repo.validateSession(GOOD1), { exists: false, reason: 'no session' }, 'good entry before a bad one must be deleted')
})

// ── HB-446: a stale archived-session message must not wreck the open session ──

test('HB-446: decrypting a stale message under an archived session leaves the live session working', async () => {
	const alice = await makeRepo(tmpDir('aunu-240-446a-'))
	const bob = await makeRepo(tmpDir('aunu-240-446b-'))
	const ALICE = '6282222222222@s.whatsapp.net'
	const BOB = '6281111111111@s.whatsapp.net'
	// S1: bob initiates to alice, both directions flow.
	await bob.repo.injectE2ESession({ jid: ALICE, session: await mintIncomingBundle(alice.state, 11) })
	const pk1 = await bob.repo.encryptMessage({ jid: ALICE, data: Buffer.from('bob-m1') })
	assert.equal(Buffer.from(await alice.repo.decryptMessage({ jid: BOB, type: pk1.type, ciphertext: pk1.ciphertext })).toString(), 'bob-m1')
	const m2 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-m2') })
	assert.equal(Buffer.from(await bob.repo.decryptMessage({ jid: ALICE, type: m2.type, ciphertext: m2.ciphertext })).toString(), 'alice-m2')
	// A message created under S1 but delivered late (the backlog).
	const stale = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-stale') })
	assert.equal(stale.type, 'msg')
	// Re-key to S2: bob injects a fresh bundle, S1 is archived.
	await bob.repo.injectE2ESession({ jid: ALICE, session: await mintIncomingBundle(alice.state, 12) })
	const pk4 = await bob.repo.encryptMessage({ jid: ALICE, data: Buffer.from('bob-m4') })
	assert.equal(Buffer.from(await alice.repo.decryptMessage({ jid: BOB, type: pk4.type, ciphertext: pk4.ciphertext })).toString(), 'bob-m4')
	const m5 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-m5') })
	assert.equal(Buffer.from(await bob.repo.decryptMessage({ jid: ALICE, type: m5.type, ciphertext: m5.ciphertext })).toString(), 'alice-m5', 'setup: S2 must be healthy before the stale message')
	// The stale S1 message arrives: it decrypts under the archived
	// session — and pre-fix its failed attempt on the OPEN session
	// stepped that ratchet before the MAC check, persisting the
	// wreckage over S2.
	const stalePt = await bob.repo.decryptMessage({ jid: ALICE, type: stale.type, ciphertext: stale.ciphertext })
	assert.equal(Buffer.from(stalePt).toString(), 'alice-stale', 'the stale message itself must still decrypt')
	const m6 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-m6') })
	assert.equal(
		Buffer.from(await bob.repo.decryptMessage({ jid: ALICE, type: m6.type, ciphertext: m6.ciphertext })).toString(),
		'alice-m6',
		'the live S2 session must still decrypt after the stale message (HB-446)'
	)
})

// ── HB-469: sender-key names are canonical across PN/LID spellings ──

test('HB-469: an SKDM processed under the PN spelling decrypts skmsg addressed under the LID spelling', async () => {
	const sender = await makeRepo(tmpDir('aunu-240-469s-'))
	const receiver = await makeRepo(tmpDir('aunu-240-469r-'))
	const SENDER_PN = '6281111111111@s.whatsapp.net'
	const SENDER_LID = '100000111111111@lid'
	await receiver.repo.lidMapping.storeLIDPNMappings([{ pn: SENDER_PN, lid: SENDER_LID }])
	const { senderKeyDistributionMessage } = await sender.repo.encryptGroupMessage({
		group: GROUP,
		meId: SENDER_PN,
		data: Buffer.from('setup')
	})
	// The SKDM rides a 1-1 message addressed by PN…
	await receiver.repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage },
		authorJid: SENDER_PN
	})
	const { ciphertext } = await sender.repo.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('group hello') })
	// …but the group message itself is addressed by LID. Pre-fix
	// the record sat under the PN name and this threw
	// 'No session found to decrypt message' forever.
	const pt = await receiver.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER_LID, msg: ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'group hello')
	// deleteSenderKey under the LID spelling must remove the
	// record the PN-spelled SKDM created (pre-fix a silent miss).
	await receiver.repo.deleteSenderKey(GROUP, SENDER_LID)
	const { ciphertext: ct2 } = await sender.repo.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('group hello 2') })
	await assert.rejects(receiver.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER_LID, msg: ct2 }), /No session found to decrypt message/)
})

// ── HB-94 addendum run-0646: multi-JID delete vs in-flight decrypt ──

test('HB-94 run-0646: a multi-JID deleteSession cannot be resurrected by an in-flight decrypt of one of its peers', async () => {
	const alice = await makeRepo(tmpDir('aunu-240-94m-a-'))
	const bob = await makeRepo(tmpDir('aunu-240-94m-b-'))
	const ALICE = '6281111111111@s.whatsapp.net'
	const BOB = '6282222222222@s.whatsapp.net'
	const OTHER = '6283333333333@s.whatsapp.net'
	await bob.repo.injectE2ESession({ jid: ALICE, session: await mintIncomingBundle(alice.state, 11) })
	const pk1 = await bob.repo.encryptMessage({ jid: ALICE, data: Buffer.from('bob-hello') })
	await alice.repo.decryptMessage({ jid: BOB, type: pk1.type, ciphertext: pk1.ciphertext })
	const reply = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-hello') })
	await bob.repo.decryptMessage({ jid: ALICE, type: reply.type, ciphertext: reply.ciphertext })
	await bob.repo.injectE2ESession({ jid: OTHER, session: bundleFor() })
	const incoming = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('alice-race') })
	// Widen the window: session reads/writes cost 25ms, so the
	// decrypt transaction is mid-flight when the delete fires.
	// Pre-fix the batch delete ran under a joined key that shared
	// a mutex with nothing, committed during the decrypt, and the
	// decrypt's later commit resurrected alice's session.
	const delay = ms => new Promise(r => setTimeout(r, ms))
	const origGet = bob.rawKeys.get.bind(bob.rawKeys)
	const origSet = bob.rawKeys.set.bind(bob.rawKeys)
	bob.rawKeys.get = async (type, ids) => {
		if (type === 'session') await delay(25)
		return origGet(type, ids)
	}
	bob.rawKeys.set = async data => {
		if (data.session) await delay(25)
		return origSet(data)
	}
	try {
		const decrypting = bob.repo.decryptMessage({ jid: ALICE, type: incoming.type, ciphertext: incoming.ciphertext })
		await sleep(60)
		await bob.repo.deleteSession([ALICE, OTHER])
		const pt = await decrypting
		assert.equal(Buffer.from(pt).toString(), 'alice-race', 'the in-flight decrypt must still return its plaintext')
	} finally {
		bob.rawKeys.get = origGet
		bob.rawKeys.set = origSet
	}
	assert.deepEqual(await bob.repo.validateSession(ALICE), { exists: false, reason: 'no session' }, 'the deleted session must stay deleted after the in-flight decrypt commits')
	assert.deepEqual(await bob.repo.validateSession(OTHER), { exists: false, reason: 'no session' }, 'the second batch entry must be deleted too')
})

// ── HB-94 addendum run-0590: deleteSenderKey vs a decrypt that starts mid-write ──

test('HB-94 run-0590: deleteSenderKey is not resurrected by a group decrypt that starts while the delete is landing', async () => {
	const sender = await makeRepo(tmpDir('aunu-240-94s-s-'))
	const receiver = await makeRepo(tmpDir('aunu-240-94s-r-'))
	const SENDER_PN = '6281111111111@s.whatsapp.net'
	const { senderKeyDistributionMessage } = await sender.repo.encryptGroupMessage({
		group: GROUP,
		meId: SENDER_PN,
		data: Buffer.from('setup')
	})
	await receiver.repo.processSenderKeyDistributionMessage({
		item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage },
		authorJid: SENDER_PN
	})
	const { ciphertext: ct1 } = await sender.repo.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('group one') })
	assert.equal(Buffer.from(await receiver.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER_PN, msg: ct1 })).toString(), 'group one')
	const { ciphertext: ct2 } = await sender.repo.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('group two') })
	const senderNameStr = `${GROUP}::${receiver.repo.jidToSignalProtocolAddress(SENDER_PN).replace('.', '::')}`
	// Slow the sender-key write down: pre-fix deleteSenderKey was a
	// BARE set, and a decrypt transaction starting inside the
	// write window loaded the pre-delete record and committed it
	// back after the delete landed. Post-fix the delete runs in
	// the per-group transaction, so the decrypt waits and then
	// finds no record at all.
	const origSet = receiver.rawKeys.set.bind(receiver.rawKeys)
	receiver.rawKeys.set = async data => {
		if (data['sender-key']) await sleep(80)
		return origSet(data)
	}
	try {
		const deleting = receiver.repo.deleteSenderKey(GROUP, SENDER_PN)
		await sleep(25)
		const decrypting = receiver.repo.decryptGroupMessage({ group: GROUP, authorJid: SENDER_PN, msg: ct2 })
		await deleting
		await assert.rejects(decrypting, /No session found to decrypt message/, 'a decrypt serialised after the delete must find no sender key')
	} finally {
		receiver.rawKeys.set = origSet
	}
	const { [senderNameStr]: after } = await receiver.state.keys.get('sender-key', [senderNameStr])
	assert.ok(!after, 'the deleted sender-key record must stay deleted')
})

// ── HB-367 addendum: 31-byte bundle key material is rejected ──

test('HB-367 addendum: parseAndInjectE2ESessions rejects 31-byte identity/signed-pre-key material and drops a 31-byte pre-key', async () => {
	const kp = Curve.generateKeyPair()
	const short = kp.public.subarray(0, 31)
	const userNode = (jid, { identity = kp.public, skeyValue = kp.public, keyValue = kp.public } = {}) => ({
		tag: 'user',
		attrs: { jid },
		content: [
			{ tag: 'identity', attrs: {}, content: identity },
			{ tag: 'registration', attrs: {}, content: Buffer.from([0, 0, 0, 7]) },
			{
				tag: 'skey',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 6]) },
					{ tag: 'value', attrs: {}, content: skeyValue },
					{ tag: 'signature', attrs: {}, content: Buffer.alloc(64, 1) }
				]
			},
			{
				tag: 'key',
				attrs: {},
				content: [
					{ tag: 'id', attrs: {}, content: Buffer.from([0, 0, 5]) },
					{ tag: 'value', attrs: {}, content: keyValue }
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
					userNode('badidentity@s.whatsapp.net', { identity: short }),
					userNode('badskey@s.whatsapp.net', { skeyValue: short }),
					userNode('shortprekey@s.whatsapp.net', { keyValue: short }),
					userNode('good@s.whatsapp.net')
				]
			}
		]
	}
	const injected = []
	const repo = {
		injectE2ESession: async ({ jid, session }) => {
			injected.push({ jid, hasPreKey: !!session.preKey })
		}
	}
	await parseAndInjectE2ESessions(bundle, repo, silentLogger)
	assert.deepEqual(
		injected,
		[
			{ jid: 'shortprekey@s.whatsapp.net', hasPreKey: false },
			{ jid: 'good@s.whatsapp.net', hasPreKey: true }
		],
		'31-byte identity/skey entries must be skipped; a 31-byte pre-key must be dropped, not injected'
	)
})

// ── HB-2026-1113-223 addenda: classifier classes ──

test('HB-2026-1113-223 addenda ke-3/ke-6 (+ke-2 sapuan, ke-5): group-side non-session texts are sender-key-unavailable', () => {
	// ke-3: SKDM signing key, 33 bytes with a wrong prefix byte.
	assert.equal(isSenderKeyUnavailableError('Invalid public key'), true)
	// ke-6: sender-key chain more than 2000 iterations behind.
	assert.equal(isSenderKeyUnavailableError('Over 2000 messages into the future!'), true)
	// The 1-1 reading is unchanged: the same text still counts as
	// an unrecoverable session error outside the group path.
	assert.equal(isUnrecoverableSessionError('Over 2000 messages into the future!'), true)
	// ke-2 (sapuan): a legitimate group redelivery.
	assert.equal(isSenderKeyUnavailableError('Received message with old counter: 1, 0'), true)
	// ke-5: a consumed message key (redelivered pkmsg/skmsg).
	assert.equal(isSenderKeyUnavailableError('Key used already or never filled'), true)
	// Controls: genuine session classes stay out of this class.
	assert.equal(isSenderKeyUnavailableError('Bad MAC'), false)
	assert.equal(isSenderKeyUnavailableError('No matching sessions found for message'), false)
	assert.equal(isSenderKeyUnavailableError(undefined), false)
})

// ── HB-371 faset ke-5 + HB-223 ke-5 (socket, emitDecryptFailure) ──

test('HB-371 faset ke-5: three transient store-read failures never reset the healthy session', async () => {
	let armThrow = false
	const deleteSessionCalls = []
	const failures = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger) => {
			const rawGet = auth.keys.get.bind(auth.keys)
			auth.keys.get = async (type, ids) => {
				if (armThrow && type === 'session') throw new Error('SQLITE_BUSY: database is locked (simulated transient read failure)')
				return rawGet(type, ids)
			}
			// Offline harness: no USync server answers here, so the
			// socket's real pnToLIDFunc would burn the 800 ms query
			// timeout on every stanza's LID resolution and the three
			// stanzas could not all be processed inside the waitFor
			// window — a harness artifact, not the behaviour under
			// test. Resolve mappings from the local store only.
			const real = makeLibSignalRepository(auth, logger, async () => [])
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		await sock.signalRepository.injectE2ESession({ jid: PEER, session: bundleFor() })
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'setup session missing')
		armThrow = true
		for (const id of ['HB0371F5-1', 'HB0371F5-2', 'HB0371F5-3']) {
			sock.ws.emit('CB:message', msgStanza(id, Buffer.alloc(32, 3)))
		}
		assert.equal(await waitFor(() => failures.length >= 3, 8000), true, 'expected one decrypt-failure event per store failure')
		await sleep(400)
		armThrow = false
		assert.equal(deleteSessionCalls.length, 0, 'store-read failures must never reach the 3-strike session reset')
		assert.ok(
			failures.every(f => f.healed === false && f.failures === 0),
			`store failures must not be strike-counted (got ${JSON.stringify(failures.map(f => [f.failures, f.healed]))})`
		)
		assert.equal((await sock.signalRepository.validateSession(PEER)).exists, true, 'the healthy session must survive')
	} finally {
		endQuietly(sock)
	}
})

test('HB-2026-1113-223 ke-5: a redelivered pkmsg (consumed message key) is not counted and never heals', async () => {
	const deleteSessionCalls = []
	const failures = []
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.decryptMessage = async () => {
				throw new Error('Key used already or never filled')
			}
			const origDelete = real.deleteSession.bind(real)
			real.deleteSession = async jids => {
				deleteSessionCalls.push([...jids])
				return origDelete(jids)
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	sock.ev.on('messages.decrypt-failure', e => failures.push(e))
	try {
		for (const id of ['HB223K5-1', 'HB223K5-2', 'HB223K5-3']) {
			sock.ws.emit('CB:message', msgStanza(id, Buffer.alloc(32, 3)))
		}
		await sleep(1500)
		assert.equal(failures.length, 0, 'a redelivery must not be reported as a decrypt failure')
		assert.equal(deleteSessionCalls.length, 0, 'a redelivery must never reset the session')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-416 addendum 3: lid-mapping throw in assertSessions ──

test('HB-416 addendum 3: a throwing lid-mapping lookup in assertSessions degrades to no mapping instead of aborting the send', async () => {
	const sock = await makeOfflineSocket({
		makeSignalRepository: (auth, logger, pnFromLIDUSync) => {
			const real = makeLibSignalRepository(auth, logger, pnFromLIDUSync)
			real.lidMapping.getLIDsForPNs = async () => {
				throw new Error('lid-mapping store down (simulated)')
			}
			return real
		}
	})
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	const frames = []
	fakeOpenTransport(sock, frames)
	// Answer the encrypt bundle IQ with an empty list, as in the
	// test-16 retry env, so the send proceeds past the fetch.
	const origSend = sock.ws.socket.send.bind(sock.ws.socket)
	sock.ws.socket.send = (data, cb) => {
		origSend(data, cb)
		try {
			const buf = Buffer.from(data)
			let off = 0
			if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
			const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
			decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
				.then(node => {
					if (node?.tag === 'iq' && node.attrs?.xmlns === 'encrypt' && node.attrs?.type === 'get') {
						sock.ws.emit(`TAG:${node.attrs.id}`, {
							tag: 'iq',
							attrs: { type: 'result', id: node.attrs.id },
							content: [{ tag: 'list', attrs: {}, content: [] }]
						})
					}
				})
				.catch(() => {})
		} catch {}
	}
	try {
		let caught
		try {
			await sock.sendMessage(PEER, { text: 'hello-416' })
		} catch (err) {
			caught = err
		}
		// The send still fails offline (no session can be
		// established from an empty bundle list) — but it must NOT
		// fail with the mapping store's error: pre-fix that throw
		// propagated straight out of assertSessions and aborted
		// the send before the bundle fetch was even attempted.
		assert.ok(caught, 'the offline send must fail for a downstream reason (no session)')
		assert.ok(!/lid-mapping store down/.test(caught.message || ''), `send must not abort on the mapping read (got: ${caught.message})`)
	} finally {
		endQuietly(sock)
	}
})
