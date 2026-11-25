// AunuBaileys 2.7.0 — HB-410 addendum: the injectE2ESession guard
// validated identityKey + signedPreKey only. A preKey present
// without a usable publicKey recorded pendingPreKey.preKeyId and
// injected a phantom session (validates locally, Bad MAC at the
// peer); a wrong-length/string publicKey died as a raw libsignal
// error; a non-integer registrationId stored the HB-367 phantom
// shape. All three are now rejected with Boom 400 before anything
// is created. Adapted from the run-1081 harnesses
// (t1081-prekey.mjs, t1081-regid.mjs); fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'
import { silentLogger } from './helpers.mjs'

const JID = '6281234567890@s.whatsapp.net'

const makeRepo = () => {
	const mem = new Map()
	const base = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) {
				const v = mem.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		async set(data) {
			for (const t in data) {
				for (const id in data[t]) {
					const v = data[t][id]
					if (v === null || v === undefined) mem.delete(`${t}:${id}`)
					else mem.set(`${t}:${id}`, v)
				}
			}
		}
	}
	const keys = addTransactionCapability(base, silentLogger)
	const repo = makeLibSignalRepository({ creds: initAuthCreds(), keys }, silentLogger)
	return { repo }
}

const peerBundle = (mutate) => {
	const peerIdentity = Curve.generateKeyPair()
	const peerSpk = signedKeyPair(peerIdentity, 1)
	const peerPreKey = Curve.generateKeyPair()
	const bundle = {
		registrationId: 1234,
		identityKey: generateSignalPubKey(peerIdentity.public),
		signedPreKey: {
			keyId: 1,
			publicKey: generateSignalPubKey(peerSpk.keyPair.public),
			signature: peerSpk.signature
		},
		preKey: { keyId: 5, publicKey: generateSignalPubKey(peerPreKey.public) }
	}
	if (mutate) mutate(bundle)
	return bundle
}

const isBoom400 = err => !!err && err.isBoom === true && err.output?.statusCode === 400

test('HB-410 addendum: control — a valid bundle (33-byte preKey) injects and validates', async () => {
	const { repo } = makeRepo()
	await repo.injectE2ESession({ jid: JID, session: peerBundle() })
	assert.equal((await repo.validateSession(JID)).exists, true)
	repo.close()
})

test('HB-410 addendum: a preKey without publicKey is rejected with Boom 400 and stores nothing', async () => {
	const { repo } = makeRepo()
	const bad = peerBundle(b => { b.preKey = { keyId: 5 } })
	await assert.rejects(() => repo.injectE2ESession({ jid: JID, session: bad }), isBoom400)
	assert.equal((await repo.validateSession(JID)).exists, false)
	repo.close()
})

test('HB-410 addendum: a 31-byte preKey publicKey is rejected with Boom 400 (not a raw libsignal error)', async () => {
	const { repo } = makeRepo()
	const bad = peerBundle(b => { b.preKey.publicKey = Buffer.from(b.preKey.publicKey).slice(0, 31) })
	await assert.rejects(() => repo.injectE2ESession({ jid: JID, session: bad }), isBoom400)
	assert.equal((await repo.validateSession(JID)).exists, false)
	repo.close()
})

test('HB-410 addendum: a string preKey publicKey is rejected with Boom 400', async () => {
	const { repo } = makeRepo()
	const bad = peerBundle(b => { b.preKey.publicKey = Buffer.from(b.preKey.publicKey).toString('base64') })
	await assert.rejects(() => repo.injectE2ESession({ jid: JID, session: bad }), isBoom400)
	assert.equal((await repo.validateSession(JID)).exists, false)
	repo.close()
})

test('HB-410 addendum: non-integer registrationId (undefined / NaN / fractional) is rejected with Boom 400', async () => {
	for (const regId of [undefined, NaN, 12.5]) {
		const { repo } = makeRepo()
		const bad = peerBundle(b => { b.registrationId = regId })
		await assert.rejects(() => repo.injectE2ESession({ jid: JID, session: bad }), isBoom400)
		assert.equal((await repo.validateSession(JID)).exists, false)
		repo.close()
	}
})

test('HB-410 addendum: an absent preKey stays optional (libsignal accepts a session without one)', async () => {
	const { repo } = makeRepo()
	const bundle = peerBundle(b => { delete b.preKey })
	await repo.injectE2ESession({ jid: JID, session: bundle })
	assert.equal((await repo.validateSession(JID)).exists, true)
	repo.close()
})
