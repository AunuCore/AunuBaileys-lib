// (d) BanSentinel (P5): keyword/code/burst triggers -> cooldown ->
// gate rejects with Boom 503 -> clean reset; corrupt guard file and
// unwritable FS degrade to memory-only without throwing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lib, tmpDir } from './helpers.mjs'

const { AunuBanSentinel, MemoryBanGuardStore, FileBanGuardStore } = lib
const memOpts = extra => ({ guardFilePath: null, cooldownMs: 60_000, ...extra })

test('(d) keyword trigger trips the guard and the gate rejects with Boom 503', () => {
	const s = new AunuBanSentinel(memOpts())
	assert.equal(s.status().active, false)
	assert.equal(s.noteFailure(new Error('account has been banned')), true)
	assert.equal(s.status().active, true)
	assert.throws(
		() => s.assertCanConnect(),
		err => err?.isBoom && err.output?.statusCode === 503
	)
	s.reset()
	assert.equal(s.status().active, false)
	s.assertCanConnect() // must not throw after reset
})

test('(d) dangerous disconnect codes 401/403/440 trip immediately', () => {
	for (const code of [401, 403, 440]) {
		const s = new AunuBanSentinel(memOpts())
		assert.equal(s.noteDisconnect(code), true, `code ${code} should trip`)
		assert.equal(s.status().code, code)
		s.reset()
		assert.equal(s.isOnCooldown(), false)
	}
	// an ordinary disconnect code does NOT trip on first sight
	const s = new AunuBanSentinel(memOpts({ burstThreshold: 5 }))
	assert.equal(s.noteDisconnect(428), false)
})

test('(d) burst: N failures inside the window trip the guard', () => {
	let now = 1_000_000
	const s = new AunuBanSentinel(memOpts({ burstThreshold: 3, burstWindowMs: 30_000, now: () => now }))
	assert.equal(s.noteFailure(new Error('socket closed')), false)
	assert.equal(s.noteFailure(new Error('socket closed')), false)
	assert.equal(s.noteFailure(new Error('socket closed')), true)
	assert.equal(s.status().active, true)
	// failures outside the window do not accumulate
	const s2 = new AunuBanSentinel(memOpts({ burstThreshold: 3, burstWindowMs: 30_000, now: () => now }))
	s2.noteFailure(new Error('x')); now += 31_000
	s2.noteFailure(new Error('x')); now += 31_000
	assert.equal(s2.noteFailure(new Error('x')), false)
})

test('(d) cooldown expiry: status flips inactive once `until` passes', () => {
	let now = 5_000_000
	const s = new AunuBanSentinel(memOpts({ cooldownMs: 10_000, now: () => now }))
	s.noteDisconnect(403)
	assert.equal(s.status().active, true)
	now += 10_001
	assert.equal(s.status().active, false)
	s.assertCanConnect()
})

test('(d) guard persists across instances through the file store', () => {
	const dir = tmpDir()
	const file = path.join(dir, 'guard.json')
	const a = new AunuBanSentinel({ guardFilePath: file, cooldownMs: 60_000 })
	a.noteDisconnect(401)
	assert.ok(fs.existsSync(file))
	const b = new AunuBanSentinel({ guardFilePath: file, cooldownMs: 60_000 })
	assert.equal(b.status().active, true)
	b.reset()
	assert.equal(fs.existsSync(file), false)
	const c = new AunuBanSentinel({ guardFilePath: file })
	assert.equal(c.status().active, false)
})

test('(d) corrupt guard file is treated as no guard (never crashes)', () => {
	const dir = tmpDir()
	const file = path.join(dir, 'guard.json')
	fs.writeFileSync(file, '{this is not json!!!')
	const s = new AunuBanSentinel({ guardFilePath: file })
	assert.equal(s.status().active, false)
	s.assertCanConnect()
	fs.writeFileSync(file, JSON.stringify({ nonsense: true }))
	const s2 = new AunuBanSentinel({ guardFilePath: file })
	assert.equal(s2.status().active, false)
})

test('(d) unwritable FS: trip still works in-memory, observers never throw', () => {
	// Parent path is a regular file, so mkdir/write under it must fail.
	const dir = tmpDir()
	const blocker = path.join(dir, 'blocker')
	fs.writeFileSync(blocker, 'x')
	const file = path.join(blocker, 'guard.json')
	const s = new AunuBanSentinel({ guardFilePath: file, cooldownMs: 60_000 })
	assert.equal(s.noteFailure(new Error('you are banned')), true) // trips in memory
	assert.equal(s.status().active, true)
	assert.throws(() => s.assertCanConnect(), err => err.output?.statusCode === 503)
	s.reset() // clear() must swallow the FS failure too
	assert.equal(s.status().active, false)
})

test('(d) disabled sentinel is fully inert; note* never throw on junk input', () => {
	const off = new AunuBanSentinel({ enabled: false, guardFilePath: null })
	assert.equal(off.noteFailure(new Error('banned')), false)
	assert.equal(off.noteDisconnect(401), false)
	off.assertCanConnect()
	const s = new AunuBanSentinel(memOpts())
	for (const junk of [undefined, null, 0, {}, [], Symbol('x')]) {
		assert.equal(typeof s.noteFailure(junk), 'boolean')
	}
	assert.ok(new MemoryBanGuardStore() && new FileBanGuardStore(path.join(tmpDir(), 'g.json')))
})
