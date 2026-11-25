// AunuBaileys 2.7.0 — HB-456 addendum facet 1: the HB-456 SKDM dedup
// compared the stored state's chain ITERATION, but that iteration
// advances on every group decrypt while a re-delivered SKDM still
// carries its original iteration — after ONE decrypt the
// byte-identical SKDM was pushed again and evicted a DISTINCT state.
// The dedup now compares only the immutable identity of the state
// (keyId, chain seed, signing key). Adapted from the run-1024
// harness (t1024-skdm-dedup-iteration.mjs); fails without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { GroupSessionBuilder } from '../lib/Signal/Group/group-session-builder.js'
import { SenderKeyDistributionMessage } from '../lib/Signal/Group/sender-key-distribution-message.js'
import { SenderKeyRecord } from '../lib/Signal/Group/sender-key-record.js'
import { GroupCipher } from '../lib/Signal/Group/group_cipher.js'
import { SenderKeyName } from '../lib/Signal/Group/sender-key-name.js'
import * as keyhelper from '../lib/Signal/Group/keyhelper.js'

const GROUP = '123@g.us'

const setup = async () => {
	let record = new SenderKeyRecord()
	const store = {
		async loadSenderKey() { return record },
		async storeSenderKey(_n, r) { record = r }
	}
	const name = new SenderKeyName(GROUP, { id: '999', deviceId: 0, toString() { return '999.0' } })
	const builder = new GroupSessionBuilder(store)
	const keys = {}
	for (let id = 1; id <= 5; id++) {
		keys[id] = { chain: randomBytes(32), kp: keyhelper.generateSenderSigningKey() }
		await builder.process(name, new SenderKeyDistributionMessage(id, 0, keys[id].chain, keys[id].kp.public))
	}

	const mintWire = async (id, text) => {
		let rec = new SenderKeyRecord()
		rec.setSenderKeyState(id, 0, keys[id].chain, keys[id].kp)
		const s = { async loadSenderKey() { return rec }, async storeSenderKey(_n, r) { rec = r } }
		return new GroupCipher(s, name).encrypt(Buffer.from(text))
	}

	return { getRecord: () => record, store, name, builder, keys, mintWire }
}

test('HB-456 facet 1: replaying an SKDM after a decrypt under its state is still deduped', async () => {
	const { getRecord, store, name, builder, keys, mintWire } = await setup()
	assert.deepEqual(getRecord().serialize().map(s => s.senderKeyId), [1, 2, 3, 4, 5])

	const wire1 = await mintWire(1, 'hello under key 1')
	const wire3 = await mintWire(3, 'hello under key 3')

	// one decrypt under key 3 advances the stored chain iteration 0 -> 1
	const pt3 = await new GroupCipher(store, name).decrypt(wire3)
	assert.equal(Buffer.from(pt3).toString(), 'hello under key 3')
	assert.equal(getRecord().serialize().find(s => s.senderKeyId === 3)?.senderChainKey.iteration, 1)

	// re-deliver the BYTE-IDENTICAL SKDM 3 (iteration 0, same seed, same signing key)
	await builder.process(name, new SenderKeyDistributionMessage(3, 0, keys[3].chain, keys[3].kp.public))
	assert.deepEqual(
		getRecord().serialize().map(s => s.senderKeyId),
		[1, 2, 3, 4, 5],
		'the replayed SKDM must not push a duplicate state or evict key 1'
	)

	// the oldest distinct state still decrypts
	const pt1 = await new GroupCipher(store, name).decrypt(wire1)
	assert.equal(Buffer.from(pt1).toString(), 'hello under key 1')
})

test('HB-456 facet 1: a genuine rotation (same keyId, new chain seed) still adds a state', async () => {
	const { getRecord, builder, name } = await setup()
	const rotated = keyhelper.generateSenderSigningKey()
	await builder.process(name, new SenderKeyDistributionMessage(3, 0, randomBytes(32), rotated.public))
	const ids = getRecord().serialize().map(s => s.senderKeyId)
	assert.equal(ids.length, 5)
	assert.equal(ids[ids.length - 1], 3, 'the rotated state is appended (and the oldest evicted)')
	assert.deepEqual(ids, [2, 3, 4, 5, 3])
})
