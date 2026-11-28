// AunuBaileys 2.9.0 batch — group B2a (Signal/libsignal + lid-mapping):
// HB-350 addendum (residu): a successfully decrypted pkmsg whose
// identity key differs from the stored one (peer reinstalled) must
// update the stored identity WITHOUT saveIdentity nulling the
// session that very pkmsg just built. Controls lock the invariant
// from both sides: an UNMARKED saveIdentity keeps the pre-2.9.0
// clear-on-change behaviour exactly, and a pkmsg whose identity
// matches the stored one changes nothing.
// HB-407 orphan-repair facet is DISPOSITIONED (no code change — see
// the batch report): SignalKeyStore has no enumeration API, so the
// pre-2.4.0 zero-user orphan is undiscoverable without guessing
// storage addresses; there is no test for it here by design.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, silentLogger, tmpDir } from './helpers.mjs'
import { makeLibSignalRepository, signalStorage } from '../lib/Signal/libsignal.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'

// Multi-file repo over a temp dir (test 16 recipe).
const makeRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	state.keys = addTransactionCapability(rawKeys, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

// X3DH bundle for injectE2ESession (test 16 recipe).
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
// recipient's store (test 16 recipe).
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

// In-memory keys with a passthrough transaction (test 16 recipe).
const memKeys = () => {
	const mem = new Map()
	return {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) {
				const v = mem.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		set: async data => {
			for (const [type, rec] of Object.entries(data)) {
				for (const [k, v] of Object.entries(rec)) {
					if (v === null || v === undefined) mem.delete(`${type}:${k}`)
					else mem.set(`${type}:${k}`, v)
				}
			}
		},
		transaction: async work => work(),
		_mem: mem
	}
}

const credsFor = id => ({
	me: { id, lid: '100000000000001@lid' },
	registrationId: 4242,
	signedPreKey: { keyId: 1, keyPair: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) }, signature: Buffer.alloc(64, 3) },
	signedIdentityKey: { public: Buffer.alloc(32, 4), private: Buffer.alloc(32, 5) },
	nextPreKeyId: 1,
	firstUnuploadedPreKeyId: 1
})

// ── HB-350 addendum (2.9.0): skenario reinstall, end to end ──────

test('HB-350 addendum: a reinstall pkmsg with a new identity keeps the session it just built', async () => {
	const { repo: alice1, state: alice1State } = await makeRepo(tmpDir('aunu-290-b2a-a1-'))
	const { repo: bob, state: bobState } = await makeRepo(tmpDir('aunu-290-b2a-bob-'))
	const bobAddr = bob.jidToSignalProtocolAddress(ME)

	// Original session: alice1's pkmsg decrypts at bob, who stores
	// her (old) identity key and the session.
	await alice1.injectE2ESession({ jid: PEER, session: await mintIncomingBundle(bobState) })
	const pk1 = await alice1.encryptMessage({ jid: PEER, data: Buffer.from('before reinstall') })
	assert.equal(pk1.type, 'pkmsg', 'setup did not produce a pkmsg')
	const pt1 = await bob.decryptMessage({ jid: ME, type: pk1.type, ciphertext: pk1.ciphertext })
	assert.equal(Buffer.from(pt1).toString(), 'before reinstall')
	assert.equal((await bob.validateSession(ME)).exists, true, 'setup: original session missing')
	const alice1Identity = generateSignalPubKey(alice1State.creds.signedIdentityKey.public)
	const storedBefore = await bobState.keys.get('identity-key', [bobAddr])
	assert.deepEqual(Buffer.from(storedBefore[bobAddr]), Buffer.from(alice1Identity), 'setup: bob must hold the old identity')

	// Reinstall: a fresh repo = fresh creds = a NEW identity key.
	// Her pkmsg decrypts at bob and builds a fresh session bound to
	// the new identity.
	const { repo: alice2, state: alice2State } = await makeRepo(tmpDir('aunu-290-b2a-a2-'))
	const alice2Identity = generateSignalPubKey(alice2State.creds.signedIdentityKey.public)
	assert.notDeepEqual(Buffer.from(alice2Identity), Buffer.from(alice1Identity), 'setup: reinstall must carry a different identity')
	await alice2.injectE2ESession({ jid: PEER, session: await mintIncomingBundle(bobState, 12) })
	const pk2 = await alice2.encryptMessage({ jid: PEER, data: Buffer.from('after reinstall') })
	assert.equal(pk2.type, 'pkmsg', 'setup: reinstall message must be a pkmsg')
	const pt2 = await bob.decryptMessage({ jid: ME, type: pk2.type, ciphertext: pk2.ciphertext })
	assert.equal(Buffer.from(pt2).toString(), 'after reinstall')

	// The identity key moved to the new one AND the session the
	// pkmsg built survived the post-decrypt saveIdentity. Without
	// the fix the record is null here (clear-on-change).
	const storedAfter = await bobState.keys.get('identity-key', [bobAddr])
	assert.deepEqual(Buffer.from(storedAfter[bobAddr]), Buffer.from(alice2Identity), 'identity key must be updated to the reinstall key')
	assert.equal((await bob.validateSession(ME)).exists, true, 'the session built by the reinstall pkmsg must NOT be nulled by saveIdentity')

	// The surviving session is usable end to end: bob's reply rides
	// it as a plain msg and alice2 decrypts it — no retry round-trip.
	const reply = await bob.encryptMessage({ jid: ME, data: Buffer.from('reply after reinstall') })
	assert.equal(reply.type, 'msg', 'reply must ride the preserved open session')
	const ptReply = await alice2.decryptMessage({ jid: PEER, type: reply.type, ciphertext: reply.ciphertext })
	assert.equal(Buffer.from(ptReply).toString(), 'reply after reinstall')
})

// ── HB-350 addendum (2.9.0): kontrol B, identity sama ────────────

test('HB-350 addendum control B: a pkmsg whose identity matches the stored one changes nothing', async () => {
	const { repo: alice, state: aliceState } = await makeRepo(tmpDir('aunu-290-b2a-cb-a-'))
	const { repo: bob, state: bobState } = await makeRepo(tmpDir('aunu-290-b2a-cb-b-'))
	const bobAddr = bob.jidToSignalProtocolAddress(ME)

	// Bob already holds alice's CURRENT identity key (stored by an
	// earlier contact), so the pkmsg's saveIdentity is a no-op.
	const aliceIdentity = generateSignalPubKey(aliceState.creds.signedIdentityKey.public)
	await bobState.keys.set({ 'identity-key': { [bobAddr]: aliceIdentity } })

	await alice.injectE2ESession({ jid: PEER, session: await mintIncomingBundle(bobState) })
	const pk = await alice.encryptMessage({ jid: PEER, data: Buffer.from('same identity') })
	assert.equal(pk.type, 'pkmsg', 'setup did not produce a pkmsg')
	const pt = await bob.decryptMessage({ jid: ME, type: pk.type, ciphertext: pk.ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'same identity')

	const stored = await bobState.keys.get('identity-key', [bobAddr])
	assert.deepEqual(Buffer.from(stored[bobAddr]), Buffer.from(aliceIdentity), 'identity key must be untouched')
	assert.equal((await bob.validateSession(ME)).exists, true, 'session built by the pkmsg must be present')
})

// ── HB-350 addendum (2.9.0): storage level — marked vs unmarked ──

// Seed one auth object (in-memory keys) with a real session record
// for PEER plus a stored identity key, and return its storage.
const makeSeededStorage = async () => {
	const keys = memKeys()
	const auth = { creds: credsFor(ME), keys }
	const repo = makeLibSignalRepository(auth, silentLogger)
	await repo.injectE2ESession({ jid: PEER, session: bundleFor() })
	const addr = repo.jidToSignalProtocolAddress(PEER)
	assert.equal((await repo.validateSession(PEER)).exists, true, 'setup: seeded session missing')
	const storage = signalStorage(auth, repo.lidMapping)
	return { keys, repo, storage, addr }
}

test('HB-350 addendum control A: saveIdentity WITHOUT the preserve marker still clears the session on identity change', async () => {
	const { keys, repo, storage, addr } = await makeSeededStorage()
	try {
		const keyOld = new Uint8Array(33).fill(0x11)
		const keyNew = new Uint8Array(33).fill(0x22)
		await keys.set({ 'identity-key': { [addr]: keyOld } })

		const changed = await storage.saveIdentity(addr, keyNew)
		assert.equal(changed, true, 'identity change must be reported')
		const sess = await keys.get('session', [addr])
		assert.equal(sess[addr], undefined, 'unmarked saveIdentity must null the session record, exactly as before')
		const stored = await keys.get('identity-key', [addr])
		assert.deepEqual(Buffer.from(stored[addr]), Buffer.from(keyNew), 'identity key must still be updated')
	} finally {
		repo.close()
	}
})

test('HB-350 addendum: saveIdentity WITH preserveSession updates the identity key and keeps the session', async () => {
	const { keys, repo, storage, addr } = await makeSeededStorage()
	try {
		const keyOld = new Uint8Array(33).fill(0x33)
		const keyNew = new Uint8Array(33).fill(0x44)
		await keys.set({ 'identity-key': { [addr]: keyOld } })

		const changed = await storage.saveIdentity(addr, keyNew, true)
		assert.equal(changed, true, 'identity change must be reported')
		assert.equal((await repo.validateSession(PEER)).exists, true, 'marked saveIdentity must keep the session record')
		const stored = await keys.get('identity-key', [addr])
		assert.deepEqual(Buffer.from(stored[addr]), Buffer.from(keyNew), 'identity key must be updated')

		// A same-key marked call stays a no-op, like the unmarked one.
		const again = await storage.saveIdentity(addr, keyNew, true)
		assert.equal(again, false, 'same-key saveIdentity must report no change')
		assert.equal((await repo.validateSession(PEER)).exists, true, 'session must survive a same-key marked call')
	} finally {
		repo.close()
	}
})
