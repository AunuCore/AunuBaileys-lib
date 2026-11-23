// 2.4.0 batch — Kelompok Auth: HB-429, HB-438, HB-473,
// HB-151 facet 6 (+ sapuan facets 1/2/3b/5), HB-315 addendum 2,
// HB-2026-1113-143 addendum 2, HB-116 addendum (folder mode),
// sapuan HB-2026-1112-14 addendum 2 (tmp sweep), LINTAS HB-350
// (pre-key file removal only after writes succeed).
// Patterns follow 04-auth-state / 13-batch-210 (fake stores, real
// multi-file auth state in tmp dirs, no live connection).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lib, tmpDir, silentLogger, sleep } from './helpers.mjs'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		sleep(ms).then(() => {
			throw new Error(`timeout after ${ms}ms: ${label}`)
		})
	])

const fakeStore = (overrides = {}) => ({
	get: async () => ({}),
	set: async () => {},
	clear: async () => {},
	...overrides
})

// ── HB-429 ──────────────────────────────────────────────────────────

test('HB-429: transaction keyed with a signal type name does not deadlock on get() of that type', async () => {
	const store = fakeStore({
		get: async (type, ids) => Object.fromEntries(ids.map(id => [id, { type, id }]))
	})
	const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 })

	const result = await withTimeout(
		tx.transaction(async () => {
			const got = await tx.get('session', ['a'])
			assert.equal(got['a'].id, 'a')
			await tx.set({ session: { a: { v: 1 } } })
			return 'done'
		}, 'session'),
		2000,
		'HB-429 transaction(session) + get(session)'
	)
	assert.equal(result, 'done')

	// control: a different type inside a type-named transaction also works
	await withTimeout(
		tx.transaction(async () => {
			await tx.get('pre-key', ['1'])
		}, 'session'),
		2000,
		'HB-429 control get(pre-key)'
	)
})

// ── HB-438 ──────────────────────────────────────────────────────────

test('HB-438: permanent commit errors fail fast without retrying', async () => {
	for (const code of ['EACCES', 'EROFS', 'EINVAL', 'ENOSPC']) {
		let attempts = 0
		const err = new Error(`permanent ${code}`)
		err.code = code
		const store = fakeStore({
			set: async () => {
				attempts++
				throw err
			}
		})
		const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 10, delayBetweenTriesMs: 5 })
		const t0 = Date.now()
		await assert.rejects(
			tx.transaction(async () => {
				await tx.set({ session: { a: 1 } })
			}, 'k'),
			e => e === err
		)
		assert.equal(attempts, 1, `${code} must not be retried`)
		assert.ok(Date.now() - t0 < 1000, `${code} must fail fast`)
	}

	// Boom 4xx (non-408/429) is permanent too
	{
		let attempts = 0
		const { Boom } = await import('@hapi/boom')
		const store = fakeStore({
			set: async () => {
				attempts++
				throw new Boom('validation failed', { statusCode: 400 })
			}
		})
		const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 5, delayBetweenTriesMs: 5 })
		await assert.rejects(
			tx.transaction(async () => {
				await tx.set({ session: { a: 1 } })
			}, 'k')
		)
		assert.equal(attempts, 1, 'Boom 400 must not be retried')
	}
})

test('HB-438 (control): transient commit errors are still retried until success', async () => {
	let attempts = 0
	const store = fakeStore({
		set: async () => {
			attempts++
			if (attempts < 3) {
				throw new Error('disk busy')
			}
		}
	})
	const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 5, delayBetweenTriesMs: 5 })
	await tx.transaction(async () => {
		await tx.set({ session: { a: 1 } })
	}, 'k')
	assert.equal(attempts, 3)
})

// ── HB-473 ──────────────────────────────────────────────────────────

test('HB-473: commit retry does not hold the per-key transaction mutex', async () => {
	const store = fakeStore({
		set: async () => {
			throw new Error('transient store down')
		}
	})
	const tx = addTransactionCapability(store, silentLogger, { maxCommitRetries: 3, delayBetweenTriesMs: 300 })

	const tx1 = tx
		.transaction(async () => {
			await tx.set({ session: { a: 1 } })
		}, 'same-key')
		.catch(e => e)

	// tx1 is now inside its commit-retry delays (~600ms total)
	await sleep(100)

	let tx2WorkAt = 0
	const tx2Start = Date.now()
	const tx2 = tx
		.transaction(async () => {
			tx2WorkAt = Date.now()
			await tx.set({ session: { b: 2 } })
		}, 'same-key')
		.catch(e => e)

	const err1 = await tx1
	assert.ok(err1 instanceof Error, 'tx1 must ultimately reject')
	assert.ok(tx2WorkAt > 0, 'tx2 work must have run')
	assert.ok(
		tx2WorkAt - tx2Start < 200,
		`tx2 work started after ${tx2WorkAt - tx2Start}ms — the per-key mutex was held across tx1 commit retries`
	)
	await tx2
})

// ── creds shape gate (HB-151 facet 6, HB-315 add2, HB-143 add2, sapuan) ──

const SENTINEL_REG_ID = 424242

const loadWithMutatedCreds = async mutate => {
	const dir = tmpDir()
	const creds = initAuthCreds()
	creds.registrationId = SENTINEL_REG_ID
	mutate(creds)
	fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, lib.BufferJSON.replacer))
	const { state } = await lib.useMultiFileAuthState(dir, silentLogger)
	return state.creds
}

const assertDiscarded = async (mutate, label) => {
	const creds = await loadWithMutatedCreds(mutate)
	assert.notEqual(creds.registrationId, SENTINEL_REG_ID, `${label}: poisoned creds must be discarded for fresh creds`)
}

const assertKept = async (mutate, label) => {
	const creds = await loadWithMutatedCreds(mutate)
	assert.equal(creds.registrationId, SENTINEL_REG_ID, `${label}: valid creds must be kept`)
}

test('HB-151 facet 6 + facet 1: non-array processedHistoryMessages is discarded', async () => {
	await assertDiscarded(c => {
		c.processedHistoryMessages = 'NOT-AN-ARRAY'
	}, 'string processedHistoryMessages')
	await assertDiscarded(c => {
		c.processedHistoryMessages = 5
	}, 'numeric processedHistoryMessages')
	await assertKept(c => {
		c.processedHistoryMessages = []
	}, 'array processedHistoryMessages (control)')
})

test('HB-315 addendum 2: partial creds.me is discarded, valid/absent me is kept', async () => {
	await assertDiscarded(c => {
		c.me = {}
	}, 'me {}')
	await assertDiscarded(c => {
		c.me = { lid: '123456789012345@lid' }
	}, 'me {lid} only')
	await assertDiscarded(c => {
		c.me = { id: 123 }
	}, 'me numeric id')
	await assertDiscarded(c => {
		c.me = { id: 'abc@s.whatsapp.net' }
	}, 'me non-numeric user id')
	await assertDiscarded(c => {
		c.me = { id: '' }
	}, 'me empty id')
	await assertKept(c => {
		c.me = { id: '6281234567890@s.whatsapp.net', name: 'Test' }
	}, 'valid me (control)')
	await assertKept(() => {}, 'absent me (control)')
})

test('HB-2026-1113-143 addendum 2: wrong-length key material is discarded', async () => {
	await assertDiscarded(c => {
		c.noiseKey = { ...c.noiseKey, private: Buffer.alloc(3) }
	}, 'noiseKey.private 3 bytes')
	await assertDiscarded(c => {
		c.noiseKey = { ...c.noiseKey, private: Buffer.alloc(0) }
	}, 'noiseKey.private 0 bytes')
	await assertDiscarded(c => {
		c.signedIdentityKey = { ...c.signedIdentityKey, public: Buffer.alloc(31) }
	}, 'signedIdentityKey.public 31 bytes')
	await assertDiscarded(c => {
		c.signedPreKey = { ...c.signedPreKey, signature: Buffer.alloc(5) }
	}, 'signedPreKey.signature 5 bytes')
	await assertDiscarded(c => {
		c.advSecretKey = Buffer.alloc(5).toString('base64')
	}, 'advSecretKey 5 bytes decoded')
	await assertDiscarded(c => {
		c.advSecretKey = ''
	}, 'advSecretKey empty')
	await assertKept(() => {}, 'untouched valid creds (control)')
})

test('HB-151 sapuan facets 2/3b/5: wrong-typed accountSyncCounter / registered / routingInfo are discarded', async () => {
	await assertDiscarded(c => {
		c.accountSyncCounter = '5'
	}, 'accountSyncCounter string')
	await assertDiscarded(c => {
		c.registered = 'false'
	}, 'registered string')
	await assertDiscarded(c => {
		c.routingInfo = 'not-a-buffer'
	}, 'routingInfo string')
	await assertDiscarded(c => {
		c.routingInfo = 42
	}, 'routingInfo number')
	await assertKept(c => {
		c.routingInfo = Buffer.from([1, 2, 3])
	}, 'routingInfo Buffer (control)')
})

// ── HB-116 addendum ─────────────────────────────────────────────────

test('HB-116 addendum: auth folder is created 0700 and a pre-existing folder is tightened to 0700', async () => {
	if (process.platform === 'win32') {
		return
	}

	const fresh = path.join(tmpDir(), 'auth-fresh')
	await lib.useMultiFileAuthState(fresh, silentLogger)
	assert.equal(fs.statSync(fresh).mode & 0o777, 0o700, 'fresh auth folder must be 0700')

	const existing = tmpDir()
	fs.chmodSync(existing, 0o755)
	assert.equal(fs.statSync(existing).mode & 0o777, 0o755)
	await lib.useMultiFileAuthState(existing, silentLogger)
	assert.equal(fs.statSync(existing).mode & 0o777, 0o700, 'pre-existing auth folder must be tightened to 0700')
})

// ── Sapuan HB-2026-1112-14 addendum 2 ───────────────────────────────

test('HB-2026-1112-14 addendum 2 (sapuan): boot tmp sweep keeps live-writer tmp files, removes dead-pid ones', async () => {
	const dir = tmpDir()
	const liveTmp = path.join(dir, `creds.json.tmp-${process.pid}`)
	fs.writeFileSync(liveTmp, 'in-flight')

	let deadPid = 999999
	try {
		process.kill(deadPid, 0)
		deadPid = 0 // pid actually alive on this host — skip the dead-pid half
	} catch {
		// ESRCH — provably dead, usable for the test
	}
	const deadTmp = deadPid ? path.join(dir, `creds.json.tmp-${deadPid}`) : null
	if (deadTmp) {
		fs.writeFileSync(deadTmp, 'orphaned')
	}

	await lib.useMultiFileAuthState(dir, silentLogger)
	assert.ok(fs.existsSync(liveTmp), 'tmp of a live writer (own pid) must survive the boot sweep')
	if (deadTmp) {
		assert.ok(!fs.existsSync(deadTmp), 'tmp of a dead pid must be swept')
	}
})

// ── LINTAS HB-350 ───────────────────────────────────────────────────

test('LINTAS HB-350: pre-key file is deleted only after the sibling writes succeed', async () => {
	const dir = tmpDir()
	const { state } = await lib.useMultiFileAuthState(dir, silentLogger)
	const keyPair = lib.Curve.generateKeyPair()
	await state.keys.set({ 'pre-key': { '7': { keyPair } } })
	const preKeyFile = path.join(dir, 'pre-key-7.json')
	assert.ok(fs.existsSync(preKeyFile))

	// a session target that can never be written: a directory sits
	// where rename() would have to land the file
	fs.mkdirSync(path.join(dir, 'session-blocked.json'))
	await assert.rejects(
		state.keys.set({ session: { blocked: { v: 1 } }, 'pre-key': { '7': null } }),
		'failed write must propagate'
	)
	assert.ok(fs.existsSync(preKeyFile), 'pre-key file must survive when the sibling write fails')

	// control: a successful write lets the removal land
	await state.keys.set({ session: { fine: { v: 2 } }, 'pre-key': { '7': null } })
	assert.ok(!fs.existsSync(preKeyFile), 'pre-key file must be removed after writes succeed')
	assert.ok(fs.existsSync(path.join(dir, 'session-fine.json')))
})
