// AunuBaileys 2.9.0 batch — group B2b (auth-utils + socket):
// HB-38 addendum (bare multi-type set atomicity), HB-2026-1112-60
// addendum 3 (stuck-transaction liveness watchdog) and L24
// (sendWAMBuffer timeout must reject Boom 408, not resolve
// undefined). Each regression test fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lib, silentLogger, makeOfflineSocket, fakeOpenTransport, sleep, waitFor, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'

// No real connection attempts anywhere in this file.
WebSocketClient.prototype.connect = () => {}

// In-memory SignalKeyStore whose set() can be told to fail on one
// type. The failure lands AFTER that type's values were applied —
// the partial-write shape a real store (ENOSPC mid-flush) produces.
const makeFlakyStore = () => {
	const mem = new Map()
	const store = {
		failOnType: null,
		async get(type, ids) {
			const out = {}
			for (const id of ids) {
				const v = mem.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		async set(data) {
			let fail = false
			for (const [type, rec] of Object.entries(data)) {
				for (const [k, v] of Object.entries(rec)) {
					if (v === null || v === undefined) mem.delete(`${type}:${k}`)
					else mem.set(`${type}:${k}`, v)
				}
				if (type === store.failOnType) fail = true
			}
			if (fail) {
				const err = new Error('no space left on device')
				err.code = 'ENOSPC'
				throw err
			}
		},
		_mem: mem
	}
	return store
}

const wrapStore = (store, logger = silentLogger, extra = {}) =>
	addTransactionCapability(store, logger, { maxCommitRetries: 3, delayBetweenTriesMs: 10, ...extra })

// ── HB-38 addendum: bare multi-type set atomicity ────────────────

test('HB-38 addendum: a bare two-type set failing on the second type leaves the store un-split', async () => {
	const store = makeFlakyStore()
	store._mem.set('session:s1', 'old-session')
	store._mem.set('identity-key:addr1', 'old-identity')
	const wrapped = wrapStore(store)

	// The saveIdentity shape: session deleted + identity replaced,
	// coupled — either both land or neither does.
	store.failOnType = 'identity-key'
	await assert.rejects(
		wrapped.set({ session: { s1: null }, 'identity-key': { addr1: 'new-identity' } }),
		/no space left on device/,
		'the store error must still propagate to the caller'
	)

	const sessionAfter = store._mem.get('session:s1')
	const identityAfter = store._mem.get('identity-key:addr1')
	const bothOld = sessionAfter === 'old-session' && identityAfter === 'old-identity'
	const bothNew = sessionAfter === undefined && identityAfter === 'new-identity'
	assert.ok(bothOld || bothNew, `store is split: session=${sessionAfter}, identity-key=${identityAfter}`)
	assert.ok(bothOld, `rollback must restore the pre-set state, got session=${sessionAfter}, identity-key=${identityAfter}`)
})

test('HB-38 addendum: a bare two-type set that succeeds writes both types', async () => {
	const store = makeFlakyStore()
	store._mem.set('session:s1', 'old-session')
	const wrapped = wrapStore(store)

	await wrapped.set({ session: { s1: 'new-session' }, 'identity-key': { addr1: 'new-identity' } })
	assert.equal(store._mem.get('session:s1'), 'new-session')
	assert.equal(store._mem.get('identity-key:addr1'), 'new-identity')
})

test('HB-38 addendum: a bare single-type set is unchanged', async () => {
	const store = makeFlakyStore()
	const wrapped = wrapStore(store)

	await wrapped.set({ session: { s1: 'only-session' } })
	assert.equal(store._mem.get('session:s1'), 'only-session')
	await wrapped.set({ session: { s1: null } })
	assert.equal(store._mem.has('session:s1'), false)
})

// ── HB-2026-1112-60 addendum 3: stuck-transaction watchdog ───────

const makeRecordingLogger = () => {
	const errors = []
	const logger = {
		...silentLogger,
		child() {
			return logger
		},
		error(obj, msg) {
			errors.push({ obj, msg })
		}
	}
	return { logger, errors }
}

test('HB-2026-1112-60 addendum 3: a transaction whose work() never settles trips the watchdog exactly once', async () => {
	const store = makeFlakyStore()
	const { logger, errors } = makeRecordingLogger()
	const stuck = []
	const wrapped = wrapStore(store, logger, {
		stuckTransactionTimeoutMs: 60,
		onStuckTransaction: info => stuck.push(info)
	})

	const pending = wrapped.transaction(() => new Promise(() => {}), 'stuck-key')
	pending.catch(() => {})

	assert.equal(await waitFor(() => stuck.length === 1, 3000), true, 'watchdog never fired')
	assert.equal(stuck[0].key, 'stuck-key')
	assert.equal(stuck[0].durationMs, 60)
	assert.ok(
		errors.some(e => e.obj?.key === 'stuck-key'),
		'watchdog must log an error carrying the transaction key'
	)

	await sleep(180)
	assert.equal(stuck.length, 1, 'watchdog must fire exactly once per stuck transaction')
})

test('HB-2026-1112-60 addendum 3: a transaction that settles in time never trips the watchdog', async () => {
	const store = makeFlakyStore()
	const { logger, errors } = makeRecordingLogger()
	const stuck = []
	const wrapped = wrapStore(store, logger, {
		stuckTransactionTimeoutMs: 80,
		onStuckTransaction: info => stuck.push(info)
	})

	const result = await wrapped.transaction(async () => {
		await sleep(10)
		return 'done'
	}, 'fast-key')
	assert.equal(result, 'done')

	// Wait well past the budget: the timer must have been cleared on
	// settle — if it leaked, the callback would fire here (and a
	// leaked ref'd timer would also hold the test process open).
	await sleep(250)
	assert.deepEqual(stuck, [])
	assert.deepEqual(errors, [])
})

test('HB-2026-1112-60 addendum 3: a transaction that rejects fast never trips the watchdog', async () => {
	const store = makeFlakyStore()
	const { logger } = makeRecordingLogger()
	const stuck = []
	const wrapped = wrapStore(store, logger, {
		stuckTransactionTimeoutMs: 80,
		onStuckTransaction: info => stuck.push(info)
	})

	await assert.rejects(
		wrapped.transaction(async () => {
			throw new Error('work-boom')
		}, 'reject-key'),
		/work-boom/
	)

	await sleep(250)
	assert.deepEqual(stuck, [])
})

// ── L24: sendWAMBuffer timeout ───────────────────────────────────

test('L24: sendWAMBuffer rejects Boom 408 when the w:stats IQ times out', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	try {
		await assert.rejects(
			sock.sendWAMBuffer(Buffer.from('wam-payload')),
			err => err?.isBoom && err?.output?.statusCode === 408,
			'a timed-out WAM upload must reject Boom 408, not resolve undefined'
		)
	} finally {
		endQuietly(sock)
	}
})

test('L24: sendWAMBuffer resolves the IQ result on a normal response', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	try {
		const pending = sock.sendWAMBuffer(Buffer.from('wam-payload'))
		const found = await waitFor(
			() => sock.ws.eventNames().some(n => typeof n === 'string' && n.startsWith('TAG:')),
			3000
		)
		assert.ok(found, 'no TAG waiter registered for the WAM IQ')
		const tagName = sock.ws.eventNames().find(n => typeof n === 'string' && n.startsWith('TAG:'))
		const id = tagName.slice('TAG:'.length)
		sock.ws.emit(tagName, {
			tag: 'iq',
			attrs: { type: 'result', id },
			content: []
		})
		const result = await pending
		assert.equal(result?.tag, 'iq')
		assert.equal(result?.attrs?.type, 'result')
	} finally {
		endQuietly(sock)
	}
})
