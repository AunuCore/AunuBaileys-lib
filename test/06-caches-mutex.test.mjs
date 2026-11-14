// (i) P9 diet internals: InternalCache HB-199 cap behaviour, bounded
// TTL cache caps, internal Mutex FIFO + release-on-throw, keyed mutex.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib } from './helpers.mjs'
import { InternalCache, makeCacheStore } from '../lib/Utils/internal-cache.js'
import { Mutex } from '../lib/Utils/mutex.js'
import { makeKeyedMutex } from '../lib/Utils/make-mutex.js'

test('HB-199: InternalCache filled to 2x cap never throws and stays at the cap (LRU eviction)', () => {
	const cache = new InternalCache({ maxEntries: 50 })
	assert.doesNotThrow(() => {
		for (let i = 0; i < 100; i++) cache.set(`k${i}`, i)
	})
	assert.equal(cache.size, 50)
	assert.equal(cache.get('k99'), 99) // newest survives
	assert.equal(cache.get('k0'), undefined) // oldest evicted
	cache.close()
})

test('HB-199: bounded TTL cache also caps without throwing (incl. undefined key)', () => {
	const cache = lib.makeBoundedTTLCache({ ttlSeconds: 60, maxEntries: 10 })
	for (let i = 0; i < 25; i++) cache.set(`k${i}`, i)
	assert.ok(cache.size <= 10)
	cache.set(undefined, 'x') // HB-226: an undefined key must not disable the cap
	for (let i = 0; i < 25; i++) cache.set(`z${i}`, i)
	assert.ok(cache.size <= 10)
})

test('HB-145: NaN cache config falls back to bounded defaults instead of disabling bounds', () => {
	const cache = lib.makeBoundedTTLCache({ ttlSeconds: NaN, maxEntries: NaN })
	for (let i = 0; i < 1100; i++) cache.set(`k${i}`, i)
	assert.ok(cache.size <= 1000, `size ${cache.size} exceeded the default cap`)
	const internal = new InternalCache({ maxEntries: NaN })
	for (let i = 0; i < 100; i++) internal.set(`k${i}`, i)
	assert.ok(internal.size <= 100)
	internal.close()
})

test('makeCacheStore: NodeCache-style options produce a working capped store', () => {
	const store = makeCacheStore({ stdTTL: 60, maxEntries: 5 })
	store.set('a', 1)
	assert.equal(store.get('a'), 1)
	assert.deepEqual(store.mget(['a', 'b']), { a: 1, b: undefined })
	store.mset([{ key: 'b', value: 2 }])
	assert.equal(store.get('b'), 2)
	store.mdel(['b'])
	assert.equal(store.get('b'), undefined)
	store.close()
})

test('Mutex: waiters are served strictly FIFO', async () => {
	const mutex = new Mutex()
	const release = await mutex.acquire()
	const order = []
	const waiters = [1, 2, 3].map(n =>
		mutex.acquire().then(rel => { order.push(n); rel() })
	)
	release()
	await Promise.all(waiters)
	assert.deepEqual(order, [1, 2, 3])
	assert.equal(mutex.isLocked(), false)
})

test('Mutex: runExclusive releases the lock when the callback throws', async () => {
	const mutex = new Mutex()
	await assert.rejects(mutex.runExclusive(async () => { throw new Error('boom') }), /boom/)
	assert.equal(mutex.isLocked(), false)
	assert.equal(await mutex.runExclusive(async () => 42), 42)
	// a double release must not hand the lock to two waiters
	const r1 = await mutex.acquire()
	r1(); r1()
	assert.equal(mutex.isLocked(), false)
})

test('KeyedMutex: same-key tasks serialise, different keys run free', async () => {
	const keyed = makeKeyedMutex()
	const order = []
	const slow = keyed.mutex('g1', async () => { await new Promise(r => setTimeout(r, 30)); order.push('slow') })
	const fast = keyed.mutex('g1', async () => { order.push('fast') })
	const other = keyed.mutex('g2', async () => { order.push('other') })
	await Promise.all([slow, fast, other])
	assert.ok(order.indexOf('slow') < order.indexOf('fast'), `order: ${order}`)
	// throwing task releases its key
	await assert.rejects(keyed.mutex('g1', async () => { throw new Error('x') }))
	assert.equal(await keyed.mutex('g1', async () => 'ok'), 'ok')
})
