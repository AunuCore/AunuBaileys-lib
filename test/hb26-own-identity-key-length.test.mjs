// AunuBaileys 2.7.0 — HB-2026-1112-26 addendum facet 1: our OWN
// identity public key with a wrong LENGTH passed the type-only
// HB-98 guard in getOurIdentity, and generateSignalPubKey silently
// padded a 31-byte key into a wrong 32-byte key — every 1:1 pkmsg
// then failed 'Bad MAC' forever and the self-heal kept deleting
// healthy sessions. getOurIdentity now requires the public key to
// be 32 bytes bare, or 33 bytes carrying the 0x05 prefix, and
// fails descriptively otherwise. Adapted from the run-1032 harness
// (t1032-ownkey-length.mjs); fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { generateSignalPubKey } from '../lib/Utils/crypto.js'
import { silentLogger } from './helpers.mjs'

const ALICE = '6281111111111@s.whatsapp.net'
const BOB = '6282222222222@s.whatsapp.net'

const memKeys = () => {
	const map = new Map()
	return {
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
	const keys = addTransactionCapability(memKeys(), silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 10 })
	const repo = makeLibSignalRepository({ creds, keys }, silentLogger)
	return { creds, repo }
}

const bundleFrom = creds => ({
	registrationId: creds.registrationId,
	identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
	signedPreKey: {
		keyId: creds.signedPreKey.keyId,
		publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
		signature: creds.signedPreKey.signature
	}
})

test('HB-2026-1112-26 facet 1: control — valid creds establish and use a session', async () => {
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	await alice.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
	const c = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('hello') })
	const pt = await bob.repo.decryptMessage({ jid: ALICE, type: c.type, ciphertext: c.ciphertext })
	assert.equal(Buffer.from(pt).toString(), 'hello')
	alice.repo.close(); bob.repo.close()
})

test('HB-2026-1112-26 facet 1: a 31-byte own identity public key fails descriptively, not with Bad MAC', async () => {
	const bob = makeParty(BOB)
	const corrupt = makeParty(ALICE, creds => {
		creds.signedIdentityKey.public = Buffer.from(creds.signedIdentityKey.public).slice(0, 31)
	})
	await assert.rejects(
		() => corrupt.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) }),
		err => /signedIdentityKey is missing or incomplete/.test(err.message) && !/Bad MAC/.test(err.message)
	)
	corrupt.repo.close(); bob.repo.close()
})

test('HB-2026-1112-26 facet 1: a 33-byte own identity public key with a wrong prefix fails descriptively', async () => {
	const bob = makeParty(BOB)
	const corrupt = makeParty(ALICE, creds => {
		const pub33 = Buffer.from(generateSignalPubKey(creds.signedIdentityKey.public))
		pub33[0] = 0x07
		creds.signedIdentityKey.public = pub33
	})
	await assert.rejects(
		() => corrupt.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) }),
		/signedIdentityKey is missing or incomplete/
	)
	corrupt.repo.close(); bob.repo.close()
})

test('HB-2026-1112-26 facet 1: a 33-byte own identity public key with the 0x05 prefix is accepted', async () => {
	const bob = makeParty(BOB)
	const prefixed = makeParty(ALICE, creds => {
		creds.signedIdentityKey.public = generateSignalPubKey(creds.signedIdentityKey.public)
	})
	await prefixed.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
	assert.equal((await prefixed.repo.validateSession(BOB)).exists, true)
	prefixed.repo.close(); bob.repo.close()
})
