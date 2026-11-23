// 2.5.0 batch — Koordinator: HB-473 ADDENDUM (run-0990).
// A floating commit retry must not overwrite a fresher same-key
// commit with stale mutations. Fix: snapshot the pre-commit
// values of every mutation key; before each floating retry
// attempt, re-read those keys — abort the retry (throw the
// original commit error) when any key differs from BOTH its
// pre-commit value AND the value we are about to write. The
// "same as want" arm lets a retry complete our own partial
// write; the "same as pre" arm lets it proceed when untouched.
// Patterns follow 27-batch-240-auth (fake stores, real
// addTransactionCapability, no live connection).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, silentLogger, sleep } from './helpers.mjs'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { storeTcTokensFromHistorySync } from '../lib/Utils/process-message.js'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		sleep(ms).then(() => {
			throw new Error(`timeout after ${ms}ms: ${label}`)
		})
	])

const txOpts = { maxCommitRetries: 3, delayBetweenTriesMs: 200 }

const transientError = () => {
	const e = new Error('simulated transient store failure')
	e.code = 'EIO'
	return e
}

// Fake SignalKeyStore backed by a Map. `failFirst` makes the
// first N set() calls throw BEFORE applying anything (transient
// store failure); `partialFirst` makes the first set() apply
// only its first type, then throw (per-file failure midway).
const makeStore = ({ seed = {}, failFirst = 0, partialFirst = false } = {}) => {
	const backing = new Map(Object.entries(seed))
	let setCalls = 0
	const state = {
		async get(type, ids) {
			const out = {}
			for (const id of ids) {
				const v = backing.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}

			return out
		},
		async set(data) {
			setCalls++
			if (failFirst > 0 && setCalls <= failFirst) {
				throw transientError()
			}

			const types = Object.keys(data)
			for (const [ti, type] of types.entries()) {
				for (const [id, v] of Object.entries(data[type])) {
					if (v === null) backing.delete(`${type}:${id}`)
					else backing.set(`${type}:${id}`, v)
				}

				if (partialFirst && setCalls === 1 && ti === 0) {
					throw transientError()
				}
			}
		},
		_backing: backing,
		_setCalls: () => setCalls
	}
	return state
}

const waitForSetCalls = async (store, n, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs
	while (store._setCalls() < n && Date.now() < deadline) await sleep(5)
	assert.ok(store._setCalls() >= n, `timed out waiting for set call #${n}`)
}

// ── HB-473 ADDENDUM ────────────────────────────────────

test('HB-473 addendum (control): serialised same-key transactions compose', async () => {
	const store = makeStore({ seed: { 'session:peer1': 0 } })
	const tx = addTransactionCapability(store, silentLogger, txOpts)

	const txA = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 1 } })
		return 'A'
	}, 'peer1')
	const txB = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 10 } })
		return 'B'
	}, 'peer1')

	const [rA, rB] = await withTimeout(Promise.all([txA, txB]), 5000, 'control transactions')
	assert.equal(rA, 'A')
	assert.equal(rB, 'B')
	assert.equal(store._backing.get('session:peer1'), 11)
})

test('HB-473 addendum: floating retry does not overwrite a fresher same-key commit', async () => {
	const store = makeStore({ seed: { 'session:peer1': 0 }, failFirst: 1 })
	const tx = addTransactionCapability(store, silentLogger, txOpts)

	const txA = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 1 } })
		return 'A'
	}, 'peer1')
	// B starts once A's first commit has failed, and must land
	// inside A's floating delay (200 ms).
	await waitForSetCalls(store, 1)
	const txB = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 10 } })
		return 'B'
	}, 'peer1')

	const [sA, sB] = await withTimeout(Promise.allSettled([txA, txB]), 5000, 'stale-overwrite transactions')
	assert.equal(sB.status, 'fulfilled')
	assert.equal(sB.value, 'B')
	// A must FAIL (its retry is aborted) instead of silently
	// overwriting B's fresher commit with its stale +1.
	assert.equal(sA.status, 'rejected')
	assert.match(String(sA.reason?.message || sA.reason), /simulated transient store failure/)
	assert.equal(store._backing.get('session:peer1'), 10)
})

test('HB-473 addendum: floating retry completes our own partial write', async () => {
	const store = makeStore({ seed: { 'session:peer1': 0 }, partialFirst: true })
	const tx = addTransactionCapability(store, silentLogger, txOpts)
	const keyBytes = new Uint8Array([9, 8, 7])

	const result = await withTimeout(
		tx.transaction(async () => {
			const { peer1 } = await tx.get('session', ['peer1'])
			await tx.set({ session: { peer1: (peer1 ?? 0) + 1 } })
			// Blind-written key: never read during work().
			await tx.set({ 'sender-key': { group1: keyBytes } })
			return 'A'
		}, 'peer1'),
		5000,
		'partial-write transaction'
	)
	assert.equal(result, 'A')
	assert.equal(store._backing.get('session:peer1'), 1)
	assert.deepEqual(store._backing.get('sender-key:group1'), keyBytes)
})

test('HB-473 addendum: floating retry aborts when a fresher commit deleted our key', async () => {
	const store = makeStore({ seed: { 'session:peer1': 0 }, failFirst: 1 })
	const tx = addTransactionCapability(store, silentLogger, txOpts)

	const txA = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 1 } })
		return 'A'
	}, 'peer1')
	await waitForSetCalls(store, 1)
	const txB = tx.transaction(async () => {
		await tx.set({ session: { peer1: null } })
		return 'B'
	}, 'peer1')

	const [sA, sB] = await withTimeout(Promise.allSettled([txA, txB]), 5000, 'delete-abort transactions')
	assert.equal(sB.status, 'fulfilled')
	assert.equal(sA.status, 'rejected')
	assert.match(String(sA.reason?.message || sA.reason), /simulated transient store failure/)
	assert.equal(store._backing.has('session:peer1'), false)
})

test('HB-473 addendum: plain transient failure still retries to success when nothing else changed', async () => {
	const store = makeStore({ failFirst: 1 })
	const tx = addTransactionCapability(store, silentLogger, txOpts)

	const result = await withTimeout(
		tx.transaction(async () => {
			// Key never existed: read records "absent" in the
			// transaction, so the retry sees untouched state.
			const { peerX } = await tx.get('session', ['peerX'])
			await tx.set({ session: { peerX: (peerX ?? 0) + 1 } })
			return 'A'
		}, 'peerX'),
		5000,
		'plain-retry transaction'
	)
	assert.equal(result, 'A')
	assert.equal(store._backing.get('session:peerX'), 1)
})

test('HB-473 addendum: foreign write of the identical value does not abort the retry', async () => {
	const store = makeStore({ seed: { 'session:peer1': 0 }, failFirst: 1 })
	const tx = addTransactionCapability(store, silentLogger, txOpts)

	const txA = tx.transaction(async () => {
		const { peer1 } = await tx.get('session', ['peer1'])
		await tx.set({ session: { peer1: (peer1 ?? 0) + 1 } })
		return 'A'
	}, 'peer1')
	await waitForSetCalls(store, 1)
	const txB = tx.transaction(async () => {
		await tx.set({ session: { peer1: 1 } })
		return 'B'
	}, 'peer1')

	const [sA, sB] = await withTimeout(Promise.allSettled([txA, txB]), 5000, 'same-value transactions')
	assert.equal(sB.status, 'fulfilled')
	assert.equal(sA.status, 'fulfilled')
	assert.equal(sA.value, 'A')
	assert.equal(store._backing.get('session:peer1'), 1)
})

// ── Koordinator sapuan 2.5.0: HB-2026-1113-227 addendum,
// HB-2026-1111-8 addendum, HB-178 addendum (run-0993). ──
// Ketiganya addendum TERBUKA yang menyentuh file batch ini dan
// lolos dari daftar QUEUE.md — ditemukan lewat sapuan ledger
// koordinator, bukan oleh kelompok. Masing-masing tes gagal
// tanpa fix-nya dan lolos sesudahnya.
import { makeOfflineSocket, endQuietly, tmpDir } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { makeCacheableSignalKeyStore } from '../lib/Utils/auth-utils.js'
import { fetchLatestBaileysVersion } from '../lib/Utils/generics.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

const bundleFor = () => {
	const identity = Curve.generateKeyPair()
	const signed = signedKeyPair(identity, 1)
	const pre = Curve.generateKeyPair()
	return {
		registrationId: 1234,
		identityKey: generateSignalPubKey(identity.public),
		signedPreKey: { keyId: 1, publicKey: generateSignalPubKey(signed.keyPair.public), signature: signed.signature },
		preKey: { keyId: 11, publicKey: generateSignalPubKey(pre.public) }
	}
}

// Repo yang sama dengan test/26, tapi store-nya dibungkus
// makeCacheableSignalKeyStore (opt-in host) DI DALAM
// addTransactionCapability — persis susunan yang membuat
// get('device-list') mengembalikan referensi cache hidup.
const makeCachedRepo = async dir => {
	const { state } = await lib.useMultiFileAuthState(dir)
	const rawKeys = state.keys
	const cached = makeCacheableSignalKeyStore(rawKeys, silentLogger)
	state.keys = addTransactionCapability(cached, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 100 })
	const repo = makeLibSignalRepository(state, silentLogger)
	return { repo, state, rawKeys }
}

test('HB-2026-1113-227 addendum: a throwing process() handler is caught by the guard, not an unhandledRejection', async () => {
	// Pola harness run-0687 (t0687-ev-process-throw.mjs): satu
	// process() handler yang melempar + satu kontrol ev.on().
	// Pra-fix: T-A menghasilkan unhandledRejection.
	const rejections = []
	const onRejection = e => rejections.push(String(e?.message || e))
	process.on('unhandledRejection', onRejection)
	try {
		const sock = await makeOfflineSocket()
		const off = sock.ev.process(() => {
			throw new Error('process-handler-boom')
		})
		sock.ev.emit('connection.update', { connection: 'connecting' })
		await sleep(300)
		off()
		endQuietly(sock)
		await sleep(50)
		assert.equal(rejections.length, 0, `throwing process() handler must not reject unhandled (got ${JSON.stringify(rejections)})`)

		const before = rejections.length
		const sockB = await makeOfflineSocket()
		const bad = () => {
			throw new Error('on-listener-boom')
		}
		sockB.ev.on('connection.update', bad)
		sockB.ev.emit('connection.update', { connection: 'connecting' })
		await sleep(300)
		sockB.ev.off('connection.update', bad)
		endQuietly(sockB)
		await sleep(50)
		assert.equal(rejections.length - before, 0, 'control: throwing ev.on() listener must stay clean')
	} finally {
		process.off('unhandledRejection', onRejection)
	}
})

test('HB-2026-1111-8 addendum: fetchLatestBaileysVersion keeps the last good version across a failed fetch', async () => {
	const realFetch = globalThis.fetch
	// Version line must sit on line 7 (index 6) — the parser's rule.
	const pageFor = revision =>
		['// line 0', '// line 1', '// line 2', '// line 3', '// line 4', '// line 5', `const version = [2, 3000, ${revision}]`].join('\n')
	try {
		globalThis.fetch = async () => ({ ok: true, statusText: 'OK', text: async () => pageFor(1099999999) })
		const first = await fetchLatestBaileysVersion()
		assert.equal(first.isLatest, true)
		assert.deepEqual(first.version, [2, 3000, 1099999999])

		// Fetch gagal → kembali ke versi terakhir yang berhasil,
		// bukan ke pinned baileysVersion (pra-fix: pinned).
		globalThis.fetch = async () => {
			throw new Error('network down')
		}
		const second = await fetchLatestBaileysVersion()
		assert.equal(second.isLatest, false)
		assert.deepEqual(second.version, [2, 3000, 1099999999], 'a failed fetch must fall back to the last good version, not the pinned one')

		// Versi yang LEBIH LAMA tidak boleh menggerakkan cache mundur.
		globalThis.fetch = async () => ({ ok: true, statusText: 'OK', text: async () => pageFor(1000000000) })
		const third = await fetchLatestBaileysVersion()
		assert.equal(third.isLatest, true)
		assert.deepEqual(third.version, [2, 3000, 1099999999], 'the cache only ever moves forward')
	} finally {
		globalThis.fetch = realFetch
	}
})

test('HB-178 addendum: migrateSession must not mutate the cached device-list (copy before push)', async () => {
	const { repo, state } = await makeCachedRepo(tmpDir('aunu-250-178-'))
	const PN1 = '628999888777:1@s.whatsapp.net'
	const LID = '100000999888777@lid'
	// Satu sesi hanya di device 1; device-list hanya berisi '0'.
	// migrateSession harus tetap menemukan device 1 lewat salinan
	// discovery — tanpa menuliskannya ke daftar tersimpan.
	await repo.injectE2ESession({ jid: PN1, session: bundleFor() })
	await state.keys.set({ 'device-list': { 628999888777: ['0'] } })
	const { ['628999888777']: before } = await state.keys.get('device-list', ['628999888777'])
	assert.deepEqual(before, ['0'], 'setup: device-list must start as [0]')

	const result = await repo.migrateSession(PN1, LID)
	assert.equal(result.migrated, 1, `the device-1 session must still migrate via the discovery copy (got ${JSON.stringify(result)})`)
	assert.deepEqual(await repo.validateSession(PN1), { exists: false, reason: 'no session' }, 'the PN device-1 session must be gone after migration')

	// Pra-fix: get berikut mengembalikan ['0', '1'] — push in-place
	// merembes ke cache tanpa keys.set apa pun.
	const { ['628999888777']: after } = await state.keys.get('device-list', ['628999888777'])
	assert.deepEqual(after, ['0'], 'the stored device-list must be untouched — the source device belongs to the discovery copy only')
})

// --- Coordinator: HB-416 addendum 1 + HB-430 facet 2 (2.5.0) ---

// In-memory keys (test/25 recipe), plus the transaction stub the
// LID store's HB-459 check runs.
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

test('HB-416 addendum 1: storeTcTokensFromHistorySync stores tokens as-is when the dedup read throws', async () => {
	const PN = '6281111111111@s.whatsapp.net'
	const TOKEN = Buffer.from('tok-416-add1')
	const ts = Math.floor(Date.now() / 1000)
	const sets = []
	const keyStore = {
		get: async (type, ids) => {
			// The dedup read asks for the chat's storage JID; the
			// index read asks for '__index' only.
			if (ids.includes(PN)) throw new Error('tctoken store down (simulated)')
			return {}
		},
		set: async data => {
			sets.push(data)
		}
	}
	const signalRepository = { lidMapping: { getLIDForPN: async () => null } }
	await storeTcTokensFromHistorySync(
		[{ id: PN, tcToken: TOKEN, tcTokenTimestamp: ts }],
		signalRepository,
		keyStore,
		silentLogger
	)
	// Pre-fix: the throw escaped and the call rejected, so the
	// token was never stored and the history-sync chunk died.
	assert.equal(sets.length, 1, 'the token write must still happen without the dedup read')
	assert.deepEqual(sets[0].tctoken[PN].token, TOKEN)
	assert.equal(sets[0].tctoken[PN].timestamp, String(ts))
})

test('HB-430 facet 2: getLIDForPN returns the fetched pair when persisting it throws', async () => {
	const PN = '628333444555@s.whatsapp.net'
	const LID = '100000333444555@lid'
	const keys = memKeys()
	// The only set on this path is the persist inside
	// storeLIDPNMappings (lid-mapping.ts:332-333) — make it throw.
	keys.set = async () => {
		throw new Error('lid-mapping store down (simulated)')
	}
	const store = new LIDMappingStore(keys, silentLogger, async () => [{ pn: PN, lid: LID }])
	// Pre-fix: the persist throw escaped getLIDForPN, so the
	// lookup (and its caller, assertSessions) failed even though
	// the pair was already in hand.
	const lid = await store.getLIDForPN(PN)
	assert.equal(lid, LID)
})
