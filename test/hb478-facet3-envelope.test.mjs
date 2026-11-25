// AunuBaileys 2.7.0 — HB-478 facet 3: importSessionBackup encrypted
// envelope fields were not validated before crypto. A missing or
// non-string salt/iv/authTag/data field threw a raw TypeError from
// Buffer.from, and a short iv/authTag/salt produced a GCM error
// byte-identical to a wrong password, so a corrupt envelope could
// not be told apart from a bad password. The fix validates all four
// fields first (strict base64, salt >= 16 bytes, iv exactly 12,
// authTag exactly 16, data non-empty) and rejects with a descriptive
// aunu: malformed-envelope error. These tests fail without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSessionBackup, importSessionBackup } from '../lib/Utils/use-nyx-auth-state.js'

const tmp = async () => mkdtemp(join(tmpdir(), 'aunu-270-hb478f3-'))
const b64 = n => Buffer.alloc(n).toString('base64')
const envelope = fields => Buffer.from(JSON.stringify({ format: 'aunubaileys-nyx-backup', version: 1, encrypted: true, ...fields }))
const validFields = () => ({ salt: b64(16), iv: b64(12), authTag: b64(16), data: b64(16) })

const assertMalformed = async (backup, label) => {
	const dir = await tmp()
	await assert.rejects(
		importSessionBackup(dir, backup, { password: 'pw' }),
		error => {
			assert.ok(!(error instanceof TypeError), `${label}: must not be a raw TypeError, got ${error}`)
			assert.match(error.message, /^aunu: nyx backup envelope is malformed/, `${label}: ${error.message}`)
			return true
		},
		label
	)
}

test('HB-478 facet 3: an envelope with all fields missing rejects with a descriptive aunu: error, not a TypeError', async () => {
	await assertMalformed(envelope({}), 'missing fields')
})

test('HB-478 facet 3: a non-string envelope field rejects with a descriptive aunu: error, not a TypeError', async () => {
	await assertMalformed(envelope({ ...validFields(), salt: 123 }), 'numeric salt')
	await assertMalformed(envelope({ ...validFields(), data: 12345 }), 'numeric data')
})

test('HB-478 facet 3: a non-base64 envelope field rejects as malformed', async () => {
	await assertMalformed(envelope({ ...validFields(), iv: '!!!not-base64!!!' }), 'garbage iv')
})

test('HB-478 facet 3: short salt / iv / authTag and empty data reject as malformed, distinguishable from a wrong password', async () => {
	await assertMalformed(envelope({ ...validFields(), salt: b64(1) }), 'salt 1 byte')
	await assertMalformed(envelope({ ...validFields(), iv: b64(8) }), 'iv 8 bytes')
	await assertMalformed(envelope({ ...validFields(), authTag: b64(8) }), 'authTag 8 bytes')
	await assertMalformed(envelope({ ...validFields(), data: '' }), 'empty data')
})

test('HB-478 facet 3: a well-formed envelope with a wrong password still fails the GCM auth check (not reported as malformed)', async () => {
	const src = await tmp()
	const good = await exportSessionBackup(src, { password: 'correct-horse' })
	const dir = await tmp()
	await assert.rejects(importSessionBackup(dir, good, { password: 'wrong' }), error => {
		assert.match(error.message, /authenticate/, `wrong password must keep the GCM error, got: ${error.message}`)
		assert.doesNotMatch(error.message, /malformed/)
		return true
	})
})

test('HB-478 facet 3: a well-formed envelope with the right password still imports', async () => {
	const src = await tmp()
	const good = await exportSessionBackup(src, { password: 'correct-horse' })
	const dir = await tmp()
	await importSessionBackup(dir, good, { password: 'correct-horse' })
})
