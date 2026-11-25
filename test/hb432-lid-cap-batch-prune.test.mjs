// AunuBaileys 2.7.0 — HB-432 addendum: the persistent lid-mapping
// cap was enforced only over the pairs the LIDMappingStore instance
// had already seen — a single batch larger than the cap landed
// whole, and pairs already on disk (previous boot) were invisible
// to a fresh instance. The batch itself is now pruned against the
// cap, and the pure read paths register the pairs they load from
// the store so a restarted instance's index converges on the
// store's contents. Adapted from the run-1084 harness
// (t1084-lidmapping-cap.mjs); the batch-prune cases fail without
// the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { initInMemoryKeyStore } from '../lib/Utils/fork-compat.js'
import { silentLogger } from './helpers.mjs'

const pn = n => `6281000000${String(n).padStart(3, '0')}@s.whatsapp.net`
const lid = n => `100000000000${String(n).padStart(3, '0')}@lid`
const userOf = j => j.split('@')[0]

const freshKeys = async () => addTransactionCapability(initInMemoryKeyStore(), silentLogger, {})

const countPairs = async (keys, pairs) => {
	const ids = []
	for (const [p, l] of pairs) ids.push(p, `${l}_reverse`)
	const got = await keys.get('lid-mapping', ids)
	let n = 0
	for (const [p, l] of pairs) if (got[p] === l && got[`${l}_reverse`] === p) n++
	return n
}
const asUsers = pairs => pairs.map(x => [userOf(x.pn), userOf(x.lid)])

test('HB-432 addendum: a single batch larger than the cap is pruned to the cap (freshest pairs win)', async () => {
	const keys = await freshKeys()
	const store = new LIDMappingStore(keys, silentLogger, undefined, { maxEntries: 3 })
	const pairs = [21, 22, 23, 24].map(n => ({ pn: pn(n), lid: lid(n) }))
	await store.storeLIDPNMappings(pairs)
	assert.equal(await countPairs(keys, asUsers(pairs)), 3)
	// the dropped pair is the EARLIEST in the batch
	const got = await keys.get('lid-mapping', [userOf(pn(21))])
	assert.equal(got[userOf(pn(21))], undefined)
	store.close()
})

test('HB-432 addendum: pairs read back from the store join the cap index (restart convergence)', async () => {
	const keys = await freshKeys()
	// five pairs persisted by a "previous boot"
	const oldPairs = [1, 2, 3, 4, 5].map(n => [userOf(pn(n)), userOf(lid(n))])
	const seed = {}
	for (const [p, l] of oldPairs) { seed[p] = l; seed[`${l}_reverse`] = p }
	await keys.set({ 'lid-mapping': seed })

	const store = new LIDMappingStore(keys, silentLogger, undefined, { maxEntries: 3 })
	// the fresh instance reads the pre-existing pairs (pure read path)
	const read = await store.getLIDsForPNs(oldPairs.map(([p]) => `${p}@s.whatsapp.net`))
	assert.equal(read?.length, 5)
	// storing one new pair now enforces the cap over the read-back pairs too
	await store.storeLIDPNMappings([{ pn: pn(11), lid: lid(11) }])
	const oldPresent = await countPairs(keys, oldPairs)
	const newPresent = await countPairs(keys, [[userOf(pn(11)), userOf(lid(11))]])
	assert.equal(oldPresent + newPresent, 3)
	assert.equal(newPresent, 1)
	store.close()
})

test('HB-432 addendum: control — the within-instance cap still evicts LRU-first across calls', async () => {
	const keys = await freshKeys()
	const store = new LIDMappingStore(keys, silentLogger, undefined, { maxEntries: 3 })
	const first = [31, 32].map(n => ({ pn: pn(n), lid: lid(n) }))
	const second = [33, 34].map(n => ({ pn: pn(n), lid: lid(n) }))
	await store.storeLIDPNMappings(first)
	await store.storeLIDPNMappings(second)
	const total = (await countPairs(keys, asUsers(first))) + (await countPairs(keys, asUsers(second)))
	assert.equal(total, 3)
	store.close()
})
