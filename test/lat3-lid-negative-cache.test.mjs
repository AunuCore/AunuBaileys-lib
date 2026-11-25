// AunuBaileys 2.7.0 — LAT-3 (latency audit 2026-11-25 #1; partial
// amendment of the QUEUE section G hold on the HB-2026-1112-60
// family, authorised for the negative-cache facet only): a PN with
// no LID mapping used to pay a full USync fetch on EVERY lookup,
// forever. A negative result is now cached for 60 seconds and is
// invalidated immediately when a positive mapping for the same PN
// is written through the existing write path. The TTL case mocks
// Date.now — no real 60-second wait. Fails without the fix (the
// fetch counter keeps rising on sequential lookups).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { initInMemoryKeyStore } from '../lib/Utils/fork-compat.js'
import { silentLogger } from './helpers.mjs'

const UNMAPPED = '628987654321@s.whatsapp.net'
const UNMAPPED_LID = '987654321000111@lid'

const freshKeys = async () => addTransactionCapability(initInMemoryKeyStore(), silentLogger, {})

test('LAT-3 (1): sequential lookups for an unmapped PN fetch USync only once within the TTL', async () => {
	const keys = await freshKeys()
	let fetches = 0
	const pnToLIDFunc = async () => {
		fetches++
		return []
	}
	const store = new LIDMappingStore(keys, silentLogger, pnToLIDFunc)
	assert.equal(await store.getLIDForPN(UNMAPPED), null)
	assert.equal(await store.getLIDForPN(UNMAPPED), null)
	assert.equal(await store.getLIDForPN(UNMAPPED), null)
	assert.equal(fetches, 1, 'the 2nd and 3rd lookups must be served by the negative cache')
	store.close()
})

test('LAT-3 (2): a positive mapping written through storeLIDPNMappings invalidates the negative entry at once', async () => {
	const keys = await freshKeys()
	let fetches = 0
	const pnToLIDFunc = async () => {
		fetches++
		return []
	}
	const store = new LIDMappingStore(keys, silentLogger, pnToLIDFunc)
	assert.equal(await store.getLIDForPN(UNMAPPED), null)
	assert.equal(fetches, 1)
	// the mapping arrives (any producer — they all funnel through
	// storeLIDPNMappings); the very next lookup must use it,
	// without waiting for the negative TTL and without a new fetch
	await store.storeLIDPNMappings([{ pn: UNMAPPED, lid: UNMAPPED_LID }])
	assert.equal(await store.getLIDForPN(UNMAPPED), UNMAPPED_LID)
	assert.equal(fetches, 1)
	store.close()
})

test('LAT-3 (2b): a mapping learned via a later USync result also clears the negative entry', async () => {
	const keys = await freshKeys()
	let fetches = 0
	let mapped = false
	const pnToLIDFunc = async jids => {
		fetches++
		return mapped ? jids.map(pn => ({ pn, lid: UNMAPPED_LID })) : []
	}
	const store = new LIDMappingStore(keys, silentLogger, pnToLIDFunc)
	assert.equal(await store.getLIDForPN(UNMAPPED), null)
	assert.equal(fetches, 1)
	mapped = true
	// still inside the negative TTL the lookup is suppressed, so
	// simulate the mapping arriving through the identity write path
	// (which shares the same storeLIDPNMappings funnel)
	await store.storeLIDPNMappings([{ pn: UNMAPPED, lid: UNMAPPED_LID }])
	assert.equal(await store.getLIDForPN(UNMAPPED), UNMAPPED_LID)
	store.close()
})

test('LAT-3 (3): after the 60-second TTL lapses (mocked clock), a fresh fetch happens again', async () => {
	const keys = await freshKeys()
	let fetches = 0
	const pnToLIDFunc = async () => {
		fetches++
		return []
	}
	const store = new LIDMappingStore(keys, silentLogger, pnToLIDFunc)
	const realNow = Date.now
	const t0 = realNow()
	try {
		Date.now = () => t0
		assert.equal(await store.getLIDForPN(UNMAPPED), null)
		assert.equal(await store.getLIDForPN(UNMAPPED), null)
		assert.equal(fetches, 1)
		// 59 seconds in: still cached
		Date.now = () => t0 + 59_000
		assert.equal(await store.getLIDForPN(UNMAPPED), null)
		assert.equal(fetches, 1)
		// past the 60-second TTL: a fresh fetch must run
		Date.now = () => t0 + 61_000
		assert.equal(await store.getLIDForPN(UNMAPPED), null)
		assert.equal(fetches, 2)
	} finally {
		Date.now = realNow
		store.close()
	}
})
