// AunuBaileys 2.7.0 — HB-140 addendum facet 2: generateOrGetPreKeys
// guarded only the INVERTED counter direction. A huge POSITIVE gap
// (nextPreKeyId >> firstUnuploadedPreKeyId) made `remaining`
// negative, generated zero keys, returned an empty upload map, and
// marched firstUnuploadedPreKeyId past ids never uploaded — forever.
// Now the positive direction fails descriptively, like the inverted
// one. Adapted from the run-1075 harness (t1075-prekey-posgap.mjs);
// fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateOrGetPreKeys, getNextPreKeys } from '../lib/Utils/signal.js'
import { Curve } from '../lib/Utils/crypto.js'

const baseCreds = () => {
	const id = Curve.generateKeyPair()
	const spk = Curve.generateKeyPair()
	return {
		signedIdentityKey: id,
		signedPreKey: { keyPair: spk, signature: Buffer.alloc(64, 1), keyId: 1 },
		registrationId: 424242,
		nextPreKeyId: 10,
		firstUnuploadedPreKeyId: 10
	}
}

const memStore = () => {
	const data = new Map()
	return {
		async get(type, ids) {
			const out = {}
			const m = data.get(type)
			for (const id of ids) if (m?.has(id)) out[id] = m.get(id)
			return out
		},
		async set(d) {
			for (const [type, vals] of Object.entries(d)) {
				if (!data.has(type)) data.set(type, new Map())
				const m = data.get(type)
				for (const [id, v] of Object.entries(vals)) {
					if (v === null || v === undefined) m.delete(id)
					else m.set(id, v)
				}
			}
		}
	}
}

test('HB-140 facet 2: a huge positive counter gap throws descriptively instead of generating zero keys', () => {
	const creds = baseCreds()
	creds.nextPreKeyId = 2147483647
	creds.firstUnuploadedPreKeyId = 1
	assert.throws(() => generateOrGetPreKeys(creds, 5), /unuploaded backlog larger than the requested range/)
})

test('HB-140 facet 2: getNextPreKeys rejects on the positive gap (no empty upload, no counter march)', async () => {
	const creds = baseCreds()
	creds.nextPreKeyId = 2147483647
	creds.firstUnuploadedPreKeyId = 1
	await assert.rejects(() => getNextPreKeys({ creds, keys: memStore() }, 5), /unuploaded backlog/)
	assert.equal(creds.firstUnuploadedPreKeyId, 1)
	assert.equal(creds.nextPreKeyId, 2147483647)
})

test('HB-140 facet 2: consistent counters still generate the requested range', async () => {
	const creds = baseCreds()
	const { newPreKeys } = generateOrGetPreKeys(creds, 5)
	assert.equal(Object.keys(newPreKeys).length, 5)
	const { update, preKeys } = await getNextPreKeys({ creds, keys: memStore() }, 5)
	assert.equal(Object.keys(preKeys).length, 5)
	assert.equal(update.nextPreKeyId, 15)
	assert.equal(update.firstUnuploadedPreKeyId, 15)
})

test('HB-140 facet 2: the transient wiped-store form (avaliable == range) does not throw and heals', async () => {
	const creds = baseCreds()
	creds.nextPreKeyId = 10
	creds.firstUnuploadedPreKeyId = 5
	const keys = memStore()
	const out = await getNextPreKeys({ creds, keys }, 5)
	assert.equal(Object.keys(out.preKeys).length, 0)
	assert.equal(out.update.firstUnuploadedPreKeyId, 10)
	creds.nextPreKeyId = out.update.nextPreKeyId
	creds.firstUnuploadedPreKeyId = out.update.firstUnuploadedPreKeyId
	const out2 = await getNextPreKeys({ creds, keys }, 5)
	assert.equal(Object.keys(out2.preKeys).length, 5)
})

test('HB-140 facet 2: the inverted direction still throws (HB-140 fix intact)', () => {
	const creds = baseCreds()
	creds.nextPreKeyId = 1
	creds.firstUnuploadedPreKeyId = 101
	assert.throws(() => generateOrGetPreKeys(creds, 5), /inverted/)
})
