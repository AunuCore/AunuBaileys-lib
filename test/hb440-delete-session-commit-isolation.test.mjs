// AunuBaileys 2.7.0 — HB-440 addendum facet 1: HB-440 isolated the
// RESOLUTION phase of deleteSession per JID, but the COMMIT (the
// per-JID keys transaction) was still a bare await in the loop — a
// store failure committing one JID's delete aborted the batch and
// every later JID's session survived. The commit is now isolated
// per JID too: log, skip, continue. Adapted from the run-1095
// harness (t1095-delete-commit.mjs); fails without the fix (there
// deleteSession throws and B survives).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { Curve, generateSignalPubKey } from '../lib/Utils/crypto.js'
import { silentLogger } from './helpers.mjs'

const JID_A = '6281111111111@s.whatsapp.net'
const JID_B = '6282222222222@s.whatsapp.net'
const ADDR_A = '6281111111111.0'

let faultArmed = false
const backing = new Map()
const baseStore = {
	async get(type, ids) {
		const out = {}
		for (const id of ids) {
			const v = backing.get(`${type}:${id}`)
			if (v !== undefined && v !== null) out[id] = v
		}
		return out
	},
	async set(data) {
		for (const type of Object.keys(data)) {
			for (const id of Object.keys(data[type])) {
				if (faultArmed && type === 'session' && id === ADDR_A) {
					throw new Error('simulated per-key store failure for ' + ADDR_A)
				}

				const v = data[type][id]
				if (v === null || v === undefined) backing.delete(`${type}:${id}`)
				else backing.set(`${type}:${id}`, v)
			}
		}
	}
}

const makeBundle = () => {
	const idPair = Curve.generateKeyPair()
	const spkPair = Curve.generateKeyPair()
	const prePair = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(idPair.public),
		signedPreKey: {
			keyId: 1,
			publicKey: generateSignalPubKey(spkPair.public),
			signature: Curve.sign(idPair.private, generateSignalPubKey(spkPair.public))
		},
		preKey: { keyId: 2, publicKey: generateSignalPubKey(prePair.public) }
	}
}

test('HB-440 facet 1: a commit failure for one JID does not abort the rest of the delete batch', async () => {
	backing.clear()
	faultArmed = false
	const keys = addTransactionCapability(baseStore, silentLogger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 })
	const repo = makeLibSignalRepository({ creds: initAuthCreds(), keys }, silentLogger)
	await repo.injectE2ESession({ jid: JID_A, session: makeBundle() })
	await repo.injectE2ESession({ jid: JID_B, session: makeBundle() })
	assert.equal((await repo.validateSession(JID_A)).exists, true)
	assert.equal((await repo.validateSession(JID_B)).exists, true)

	faultArmed = true
	// must NOT throw, and B must still be deleted; only A's delete failed
	await repo.deleteSession([JID_A, JID_B])
	assert.equal((await repo.validateSession(JID_A)).exists, true, 'the JID whose commit failed keeps its session')
	assert.equal((await repo.validateSession(JID_B)).exists, false, 'the later JID is still deleted')

	faultArmed = false
	await repo.deleteSession([JID_A, JID_B])
	assert.equal((await repo.validateSession(JID_A)).exists, false)
	assert.equal((await repo.validateSession(JID_B)).exists, false)
	repo.close()
})
