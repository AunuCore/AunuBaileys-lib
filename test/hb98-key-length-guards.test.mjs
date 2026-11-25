// AunuBaileys 2.7.0 — HB-98 addendum, key-length facet: the key
// material guards checked TYPE only, so a 31-byte PRIVATE key
// (Buffer, or a base64 string decoding to 31 bytes) reached
// libsignal, which threw its raw 'Incorrect private key length'
// error — a text neither decrypt-failure classifier matches, so
// the 3-strike self-heal deleted healthy sessions over a corrupt
// key in our own creds. loadPreKey / loadSignedPreKey /
// getOurIdentity now check exact lengths (private exactly 32
// bytes; public 32 bare or 33 with the 0x05 prefix) at the same
// choke points. Adapted from the run-1060 harness
// (t1060-keylen.mjs); fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { silentLogger } from './helpers.mjs'

const ALICE = '6281111111111@s.whatsapp.net'
const BOB = '6282222222222@s.whatsapp.net'

const memKeys = () => {
	const map = new Map()
	return {
		map,
		async get(type, ids) {
			const out = {}
			for (const id of ids) {
				const v = map.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		async set(data) {
			for (const t in data) {
				for (const id in data[t]) {
					const v = data[t][id]
					if (v === null || v === undefined) map.delete(`${t}:${id}`)
					else map.set(`${t}:${id}`, v)
				}
			}
		}
	}
}

const makeParty = (jid, mutateCreds) => {
	const creds = initAuthCreds()
	creds.me = { id: jid, lid: '' }
	if (mutateCreds) mutateCreds(creds)
	const raw = memKeys()
	const keys = addTransactionCapability(raw, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 10 })
	const repo = makeLibSignalRepository({ creds, keys }, silentLogger)
	return { creds, repo, raw }
}

const bundleFrom = (creds, preKey) => ({
	registrationId: creds.registrationId,
	identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
	signedPreKey: {
		keyId: creds.signedPreKey.keyId,
		publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
		signature: creds.signedPreKey.signature
	},
	...(preKey ? { preKey } : {})
})

const descriptive = pattern => err =>
	pattern.test(err.message) && !/Incorrect private key length/.test(err.message)

test('HB-98 key-length: a 31-byte identity private key (Buffer) fails descriptively', async () => {
	const bob = makeParty(BOB)
	const corrupt = makeParty(ALICE, creds => { creds.signedIdentityKey.private = randomBytes(31) })
	await assert.rejects(
		() => corrupt.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) }),
		descriptive(/signedIdentityKey is missing or incomplete/)
	)
	corrupt.repo.close(); bob.repo.close()
})

test('HB-98 key-length: a base64-string identity private key decoding to 31 bytes fails descriptively', async () => {
	const bob = makeParty(BOB)
	const corrupt = makeParty(ALICE, creds => { creds.signedIdentityKey.private = randomBytes(31).toString('base64') })
	await assert.rejects(
		() => corrupt.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) }),
		descriptive(/signedIdentityKey is missing or incomplete/)
	)
	corrupt.repo.close(); bob.repo.close()
})

test('HB-98 key-length: a 31-byte signed-pre-key private key fails descriptively on pkmsg decrypt', async () => {
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	// mint Alice's session from Bob's VALID bundle first, then corrupt
	// only Bob's stored SPK private half (the bundle stays valid)
	await alice.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
	const c = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('pkmsg') })
	assert.equal(c.type, 'pkmsg')
	bob.creds.signedPreKey.keyPair.private = randomBytes(31)
	await assert.rejects(
		() => bob.repo.decryptMessage({ jid: ALICE, type: c.type, ciphertext: c.ciphertext }),
		descriptive(/signedPreKey is missing or incomplete/)
	)
	alice.repo.close(); bob.repo.close()
})

test('HB-98 key-length: a 31-byte signed-pre-key public key fails descriptively on pkmsg decrypt', async () => {
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	await alice.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
	const c = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('pkmsg') })
	bob.creds.signedPreKey.keyPair.public = randomBytes(31)
	await assert.rejects(
		() => bob.repo.decryptMessage({ jid: ALICE, type: c.type, ciphertext: c.ciphertext }),
		descriptive(/signedPreKey is missing or incomplete/)
	)
	alice.repo.close(); bob.repo.close()
})

test('HB-98 key-length: a stored pre-key with a 31-byte private half reads as absent (diagnosable PreKeyError)', async () => {
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	const pre = Curve.generateKeyPair()
	await bob.raw.set({ 'pre-key': { 11: { private: randomBytes(31), public: pre.public } } })
	const bundle = bundleFrom(bob.creds, { keyId: 11, publicKey: generateSignalPubKey(pre.public) })
	await alice.repo.injectE2ESession({ jid: BOB, session: bundle })
	const c = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('pkmsg') })
	assert.equal(c.type, 'pkmsg')
	await assert.rejects(
		() => bob.repo.decryptMessage({ jid: ALICE, type: c.type, ciphertext: c.ciphertext }),
		descriptive(/Invalid PreKey ID/)
	)
	alice.repo.close(); bob.repo.close()
})

test('HB-98 key-length: control — valid key material round-trips', async () => {
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	await alice.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
	const c = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('hello') })
	const pt = await bob.repo.decryptMessage({ jid: ALICE, type: c.type, ciphertext: c.ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'hello')
	alice.repo.close(); bob.repo.close()
})
