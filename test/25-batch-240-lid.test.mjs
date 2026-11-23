// AunuBaileys 2.4.0 batch regressions — GROUP B (LID):
// HB-407 (+ mirror addendum + orphan facet prevention), HB-415
// (+ stale-reverse addendum), HB-358 facet 5 (intra-batch),
// HB-459 (nested transaction), HB-432 (persistent-store cap),
// HB-336 addendum lid-store (already fixed, locked in), SAPUAN
// HB-407 in makeLIDStore. Each test names the HB item it locks in
// and fails without its fix. Everything runs offline against the
// built lib/ with in-memory keys — no WA connection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { silentLogger } from './helpers.mjs'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { makeLIDStore } from '../lib/Utils/lid-store.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'

// In-memory keys with a passthrough transaction (test/16 recipe),
// plus an isInTransaction stub so the store's HB-459 check runs.
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
		isInTransaction: () => false,
		_mem: mem
	}
}

const PN_A = '6281111111111@s.whatsapp.net'
const PN_B = '6282222222222@s.whatsapp.net'
const LID_X = '123456789012345@lid'
const LID_Y = '987654321098765@lid'
const A_USER = '6281111111111'
const B_USER = '6282222222222'
const X_USER = '123456789012345'
const Y_USER = '987654321098765'

// ── HB-407 ────────────────────────────────────────────────────────

test('HB-407: a pair with lid user 0 / non-digit is rejected at the store choke point', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: '0@lid' }])
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: 'undefined@lid' }])
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: 'garbage@lid' }])
	assert.equal(keys._mem.size, 0, 'bogus pairs must never reach the persistent store')
	assert.equal(await mapping.getLIDForPN(PN_A), null, 'bogus lid must not resolve')
	// Control: a well-formed pair still stores and resolves.
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	assert.equal(await mapping.getLIDForPN(PN_A), LID_X)
	mapping.close()
})

test('HB-407 mirror addendum: a pair with pn user 0 is rejected and does not retire the real forward entry', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	assert.equal(await mapping.getLIDForPN(PN_A), LID_X)
	// The pn-less LID_MIGRATION entry, as built by the producer.
	await mapping.storeLIDPNMappings([{ pn: '0@s.whatsapp.net', lid: LID_X }])
	assert.equal(keys._mem.get('lid-mapping:0'), undefined, 'bogus pn must not be stored')
	assert.equal(keys._mem.get(`lid-mapping:${X_USER}_reverse`), A_USER, 'real reverse must survive')
	assert.equal(await mapping.getLIDForPN(PN_A), LID_X, 'real forward must not be retired by the bogus mirror remap')
	assert.equal(await mapping.getPNForLID(LID_X), `${A_USER}:0@s.whatsapp.net`)
	mapping.close()
})

// ── HB-415 + addendum ─────────────────────────────────────────────

test('HB-415: re-storing the same pair repairs a torn-write reverse entry that is missing', async () => {
	const keys = memKeys()
	// Torn write: forward landed, reverse did not.
	await keys.set({ 'lid-mapping': { [A_USER]: X_USER } })
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	assert.equal(keys._mem.get(`lid-mapping:${X_USER}_reverse`), A_USER, 'reverse must be rewritten by the re-store')
	const cold = new LIDMappingStore(keys, silentLogger)
	assert.equal(await cold.getPNForLID(LID_X), `${A_USER}:0@s.whatsapp.net`, 'cold reverse lookup must resolve after repair')
	mapping.close()
	cold.close()
})

test('HB-415 addendum: re-storing the same pair repairs a stale reverse pointing at an old PN', async () => {
	const keys = memKeys()
	// Forward says PN-B, reverse still says PN-A (stale).
	await keys.set({ 'lid-mapping': { [B_USER]: X_USER, [`${X_USER}_reverse`]: A_USER } })
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_B, lid: LID_X }])
	assert.equal(keys._mem.get(`lid-mapping:${X_USER}_reverse`), B_USER, 'stale reverse must be corrected to the current PN')
	const cold = new LIDMappingStore(keys, silentLogger)
	assert.equal(await cold.getPNForLID(LID_X), `${B_USER}:0@s.whatsapp.net`)
	mapping.close()
	cold.close()
})

test('HB-415 control: a fully consistent pair is still skipped (no rewrite)', async () => {
	const keys = memKeys()
	let sets = 0
	const origSet = keys.set
	keys.set = async data => {
		sets++
		return origSet(data)
	}
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	const afterFirst = sets
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	assert.equal(sets, afterFirst, 'a consistent pair must not be rewritten')
	mapping.close()
})

// ── HB-358 facet 5 (intra-batch) ──────────────────────────────────

test('HB-358 facet 5: two PNs claiming one LID in a single batch leave no dangling loser forward', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([
		{ pn: PN_A, lid: LID_X },
		{ pn: PN_B, lid: LID_X }
	])
	assert.equal(keys._mem.get(`lid-mapping:${A_USER}`), undefined, 'loser forward must not be stored')
	assert.equal(keys._mem.get(`lid-mapping:${B_USER}`), X_USER, 'winner forward must be stored')
	assert.equal(keys._mem.get(`lid-mapping:${X_USER}_reverse`), B_USER)
	assert.equal(await mapping.getLIDForPN(PN_A), null, 'loser PN must not resolve to the LID')
	assert.equal(await mapping.getLIDForPN(PN_B), LID_X)
	assert.equal(await mapping.getPNForLID(LID_X), `${B_USER}:0@s.whatsapp.net`)
	// Cascade facet: a later legitimate remap of the loser must not
	// delete the winner's reverse.
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_Y }])
	assert.equal(await mapping.getPNForLID(LID_X), `${B_USER}:0@s.whatsapp.net`, 'winner reverse must survive the loser remap')
	assert.equal(await mapping.getLIDForPN(PN_A), LID_Y)
	mapping.close()
})

test('HB-358 mirror (already fixed in 2.3.0, locked in): sequential LID remap retires the old PN forward', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger)
	await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	await mapping.storeLIDPNMappings([{ pn: PN_B, lid: LID_X }])
	assert.equal(await mapping.getLIDForPN(PN_A), null)
	assert.equal(await mapping.getPNForLID(LID_X), `${B_USER}:0@s.whatsapp.net`)
	mapping.close()
})

// ── HB-459 ────────────────────────────────────────────────────────

test('HB-459: a nested store inside a rolling-back outer transaction does not poison the cache', async () => {
	const store = {}
	const rawKeys = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) if (store[`${type}:${id}`] !== undefined) out[id] = store[`${type}:${id}`]
			return out
		},
		async set(data) {
			for (const type in data) {
				for (const id in data[type]) {
					if (data[type][id] === null) delete store[`${type}:${id}`]
					else store[`${type}:${id}`] = data[type][id]
				}
			}
		}
	}
	const keys = addTransactionCapability(rawKeys, silentLogger)
	const mapping = new LIDMappingStore(keys, silentLogger)
	await assert.rejects(
		keys.transaction(async () => {
			await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
			throw new Error('outer rollback (simulated)')
		}, 'lid-mapping'),
		/outer rollback/
	)
	assert.equal(store[`lid-mapping:${A_USER}`], undefined, 'rolled-back write must not persist')
	assert.equal(await mapping.getLIDForPN(PN_A), null, 'cache must not claim a mapping the store never persisted')
	// Control: the same nested store inside a COMMITTING outer
	// transaction persists, and then resolves.
	await keys.transaction(async () => {
		await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
	}, 'lid-mapping')
	assert.equal(store[`lid-mapping:${A_USER}`], X_USER, 'committed nested write must persist')
	const cold = new LIDMappingStore(keys, silentLogger)
	assert.equal(await cold.getLIDForPN(PN_A), LID_X)
	mapping.close()
	cold.close()
})

// ── HB-432 ────────────────────────────────────────────────────────

test('HB-432: the persistent store is capped — oldest pairs are pruned LRU-first', async () => {
	const keys = memKeys()
	const mapping = new LIDMappingStore(keys, silentLogger, undefined, { maxEntries: 3 })
	const pairs = [
		['6281000000001@s.whatsapp.net', '100000000000001@lid'],
		['6281000000002@s.whatsapp.net', '100000000000002@lid'],
		['6281000000003@s.whatsapp.net', '100000000000003@lid'],
		['6281000000004@s.whatsapp.net', '100000000000004@lid'],
		['6281000000005@s.whatsapp.net', '100000000000005@lid']
	]
	for (const [pn, lid] of pairs) {
		await mapping.storeLIDPNMappings([{ pn, lid }])
	}
	assert.equal(keys._mem.size, 6, 'store must hold exactly 3 pairs (forward + reverse) after pruning')
	assert.equal(await mapping.getLIDForPN(pairs[0][0]), null, 'oldest pair must be evicted')
	assert.equal(await mapping.getLIDForPN(pairs[1][0]), null, 'second-oldest pair must be evicted')
	assert.equal(await mapping.getLIDForPN(pairs[4][0]), pairs[4][1], 'newest pair must survive')
	assert.equal(await mapping.getPNForLID(pairs[4][1]), '6281000000005:0@s.whatsapp.net')
	mapping.close()
})

test('HB-432 gate: an invalid maxEntries falls back to the default instead of disabling the cap or wedging', async () => {
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 2.5]) {
		const keys = memKeys()
		const mapping = new LIDMappingStore(keys, silentLogger, undefined, { maxEntries: bad })
		await mapping.storeLIDPNMappings([{ pn: PN_A, lid: LID_X }])
		assert.equal(await mapping.getLIDForPN(PN_A), LID_X, `maxEntries=${bad} must fall back to the default and still store`)
		mapping.close()
	}
})

// ── HB-336 addendum (lid-store, already fixed) + SAPUAN ───────────

test('HB-336 addendum lid-store (already fixed, locked in): makeLIDStore learns hosted pairs both ways', () => {
	const store = makeLIDStore()
	assert.equal(store.addPair('6281234567890@hosted', '123456789012345@hosted.lid'), true, 'hosted pair must be accepted')
	assert.equal(store.getAltJid('6281234567890@hosted'), '123456789012345@hosted.lid')
	assert.equal(store.getAltJid('123456789012345@hosted.lid'), '6281234567890@hosted')
	assert.equal(store.hasPN('6281234567890@hosted'), true)
	assert.equal(store.hasLID('123456789012345@hosted.lid'), true)
})

test('SAPUAN HB-407 lid-store: makeLIDStore rejects all-zero / non-digit users', () => {
	const store = makeLIDStore()
	assert.equal(store.addPair('0@s.whatsapp.net', '123456789012345@lid'), false)
	assert.equal(store.addPair('6281234567890@s.whatsapp.net', '0@lid'), false)
	assert.equal(store.addPair('6281234567890@s.whatsapp.net', 'undefined@lid'), false)
	assert.equal(store.size, 0)
	// Control: a well-formed pair is still learned.
	assert.equal(store.addPair('6281234567890@s.whatsapp.net', '123456789012345@lid'), true)
	assert.equal(store.size, 1)
})

// ── HB-470 (coordinator): learnFromKey reads the fields the live
// decoder actually sets (remoteJidAlt / participantAlt), not only
// the senderPn/participantPn fields no producer ever writes. ──

test('HB-470: learnFromKey learns from decoder-shaped keys (remoteJidAlt / participantAlt)', () => {
	const store = makeLIDStore()
	// DM, LID-addressed stanza carrying sender_pn: the decoder key
	// is { remoteJid: LID, remoteJidAlt: PN }.
	assert.equal(store.learnFromKey({ remoteJid: LID_X, remoteJidAlt: PN_A, fromMe: false }), 1)
	assert.equal(store.getLIDForPN(PN_A), LID_X)
	assert.equal(store.getAltJid(PN_A), LID_X)
	// DM, PN-addressed stanza carrying sender_lid.
	assert.equal(store.learnFromKey({ remoteJid: PN_B, remoteJidAlt: LID_Y, fromMe: false }), 1)
	assert.equal(store.getLIDForPN(PN_B), LID_Y)
	// One key carrying the same pair in two shapes counts it once
	// (the extractor dedupes; addPair itself re-confirms known
	// pairs, which is the store's long-standing count semantics).
	const storeDedupe = makeLIDStore()
	assert.equal(
		storeDedupe.learnFromKey({ senderPn: PN_A, senderLid: LID_X, remoteJid: LID_X, remoteJidAlt: PN_A, fromMe: false }),
		1,
		'the same pair in two shapes of one key must count once'
	)
	// Group stanza: participant + participantAlt carry the author pair.
	const store2 = makeLIDStore()
	assert.equal(
		store2.learnFromKey({ remoteJid: '120363012345678@g.us', participant: PN_B, participantAlt: LID_Y, fromMe: false }),
		1
	)
	assert.equal(store2.getLIDForPN(PN_B), LID_Y)
	// fromMe DM: remoteJidAlt is the RECIPIENT's alt (HB-337), so
	// the pair is still the chat partner's and is learned.
	const store3 = makeLIDStore()
	assert.equal(store3.learnFromKey({ remoteJid: PN_A, remoteJidAlt: LID_X, fromMe: true }), 1)
	assert.equal(store3.getLIDForPN(PN_A), LID_X)
	// Legacy hand-built keys keep working.
	const store4 = makeLIDStore()
	assert.equal(store4.learnFromKey({ senderPn: PN_A, senderLid: LID_X }), 1)
	assert.equal(store4.getLIDForPN(PN_A), LID_X)
	// A key with no Alt and no legacy pair learns nothing.
	assert.equal(store4.learnFromKey({ remoteJid: PN_B, fromMe: false }), 0)
})
