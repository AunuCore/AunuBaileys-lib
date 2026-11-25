// AunuBaileys 2.7.0 — HB-446 addendum facet 1: the HB-446 snapshot
// restore identified the winning session ONLY by the change in its
// `indexInfo.used` millisecond timestamp. A stale message decrypted
// in the SAME millisecond the archived session was last used left
// `used` unchanged, no winner was found, the restore was skipped,
// and the open session stayed corrupted (the next message failed
// 'No matching sessions found'). The restore now falls back to a
// structural winner trace: the winner changed without stepping its
// ratchet (root key / ephemeral pair / last remote ephemeral /
// previous counter identical to the snapshot); a failed attempt is
// what steps the ratchet. Adapted from the run-1024 harness
// (t1024-hb446-used-collision.mjs) — the frozen-clock case fails
// without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { generateSignalPubKey } from '../lib/Utils/crypto.js'
import { silentLogger } from './helpers.mjs'

const require = createRequire(import.meta.url)
const libsignal = require('libsignal')

const ALICE = '6281111111111@s.whatsapp.net'
const BOB = '6282222222222@s.whatsapp.net'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clone = o => JSON.parse(JSON.stringify(o))

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

const makeParty = jid => {
	const creds = initAuthCreds()
	creds.me = { id: jid, lid: '' }
	const raw = memKeys()
	const keys = addTransactionCapability(raw, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 10 })
	const repo = makeLibSignalRepository({ creds, keys }, silentLogger)
	return { creds, raw, keys, repo }
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

const openRootKey = (party, peerJid) => {
	const addr = peerJid.split('@')[0] + '.0'
	const stored = party.raw.map.get(`session:${addr}`)
	const record = libsignal.SessionRecord.deserialize(clone(stored))
	return Buffer.from(record.getOpenSession().currentRatchet.rootKey).toString('hex')
}

const archivedUsed = (party, peerJid) => {
	const addr = peerJid.split('@')[0] + '.0'
	const stored = party.raw.map.get(`session:${addr}`)
	const record = libsignal.SessionRecord.deserialize(clone(stored))
	for (const s of Object.values(record.sessions)) {
		if (s.indexInfo.closed !== -1) return s.indexInfo.used
	}

	return undefined
}

const runScenario = async freeze => {
	const realNow = Date.now
	const alice = makeParty(ALICE)
	const bob = makeParty(BOB)
	try {
		await alice.repo.injectE2ESession({ jid: BOB, session: bundleFrom(bob.creds) })
		const c1 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('m1') })
		await bob.repo.decryptMessage({ jid: ALICE, type: c1.type, ciphertext: c1.ciphertext })
		const c2 = await bob.repo.encryptMessage({ jid: ALICE, data: Buffer.from('m2') })
		await alice.repo.decryptMessage({ jid: BOB, type: c2.type, ciphertext: c2.ciphertext })
		const c3 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('m3-normal') })
		await bob.repo.decryptMessage({ jid: ALICE, type: c3.type, ciphertext: c3.ciphertext })
		await sleep(10)
		await bob.repo.injectE2ESession({ jid: ALICE, session: bundleFrom(alice.creds) })
		const c4 = await bob.repo.encryptMessage({ jid: ALICE, data: Buffer.from('m4-pkmsg') })
		await alice.repo.decryptMessage({ jid: BOB, type: c4.type, ciphertext: c4.ciphertext })
		const c5 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('m5-normal') })
		const d5 = await bob.repo.decryptMessage({ jid: ALICE, type: c5.type, ciphertext: c5.ciphertext })
		assert.equal(d5.toString(), 'm5-normal')

		const rootBefore = openRootKey(bob, ALICE)
		const s1Used = archivedUsed(bob, ALICE)
		assert.equal(typeof s1Used, 'number')
		if (freeze) {
			// deterministic same-ms collision: hold the clock at the
			// archived session's own last-used timestamp
			Date.now = () => s1Used
		}

		// craft a message under Alice's ARCHIVED S1
		const aliceAddr = BOB.split('@')[0] + '.0'
		const aliceSnapshot = clone(alice.raw.map.get(`session:${aliceAddr}`))
		const aliceRecord = libsignal.SessionRecord.deserialize(clone(alice.raw.map.get(`session:${aliceAddr}`)))
		const sA1 = Object.values(aliceRecord.sessions).find(s => s.indexInfo.closed !== -1)
		aliceRecord.openSession(sA1)
		await alice.keys.set({ session: { [aliceAddr]: aliceRecord.serialize() } })
		const cOld = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('m-old-stale') })
		await alice.keys.set({ session: { [aliceAddr]: aliceSnapshot } })

		const dOld = await bob.repo.decryptMessage({ jid: ALICE, type: cOld.type, ciphertext: cOld.ciphertext })
		assert.equal(dOld.toString(), 'm-old-stale')
		assert.equal(
			openRootKey(bob, ALICE),
			rootBefore,
			'the open session must survive the stale decrypt (HB-446 restore must run)'
		)

		const c6 = await alice.repo.encryptMessage({ jid: BOB, data: Buffer.from('m6-after') })
		const d6 = await bob.repo.decryptMessage({ jid: ALICE, type: c6.type, ciphertext: c6.ciphertext })
		assert.equal(d6.toString(), 'm6-after')
	} finally {
		Date.now = realNow
		alice.repo.close(); bob.repo.close()
	}
}

test('HB-446 facet 1: control (real clock) — the stale decrypt restores the open session', async () => {
	await runScenario(false)
})

test('HB-446 facet 1: same-millisecond used collision — the structural trace still restores the open session', async () => {
	await runScenario(true)
})
