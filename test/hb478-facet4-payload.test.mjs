// AunuBaileys 2.7.0 — HB-478 facet 4: importSessionBackup checked
// payloads with isStrictBase64 only, and only creds.json had a
// content gate. '' is strict base64 (0 bytes), 'AAAA' decodes to
// NUL bytes and 'bnVsbA==' to JSON null, so a bundle carrying such
// a payload for a key file (session-*.json, pre-key-*.json, ...)
// imported without error and silently overwrote a good session
// file with empty/garbage bytes the loader then read as missing.
// The fix rejects a payload whose decoded bytes are empty or do
// not parse as a JSON object/array for EVERY file entry, with a
// descriptive aunu: error. These tests fail without the fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSessionBackup, importSessionBackup } from '../lib/Utils/use-nyx-auth-state.js'
import { initAuthCreds } from '../lib/Utils/auth-utils.js'
import { BufferJSON } from '../lib/Utils/generics.js'

const SESSION_FILE = 'session-628123456789@s.whatsapp.net.json'
const SESSION_JSON = JSON.stringify({ _sessions: {}, version: 'v1', registrationId: 123, marker: 'good-session' })
const b64 = s => Buffer.from(s, 'utf-8').toString('base64')

const setup = async () => {
	const src = await mkdtemp(join(tmpdir(), 'aunu-270-hb478f4-src-'))
	const credsJson = JSON.stringify(initAuthCreds(), BufferJSON.replacer)
	await writeFile(join(src, 'creds.json'), credsJson)
	await writeFile(join(src, SESSION_FILE), SESSION_JSON)
	const cleanBundle = await exportSessionBackup(src)
	const cleanFiles = JSON.parse(cleanBundle.toString('utf-8')).files

	const target = await mkdtemp(join(tmpdir(), 'aunu-270-hb478f4-tgt-'))
	await writeFile(join(target, 'creds.json'), credsJson)
	await writeFile(join(target, SESSION_FILE), SESSION_JSON)

	const bundleWith = overrides => Buffer.from(
		JSON.stringify({ format: 'aunubaileys-nyx-backup', version: 1, files: { ...cleanFiles, ...overrides } }),
		'utf-8'
	)
	return { target, bundleWith }
}

const rejectsWith = fragment => error => {
	assert.ok(error instanceof Error)
	assert.ok(error.message.startsWith('aunu:'), `expected an aunu: error, got: ${error.message}`)
	assert.ok(error.message.includes(fragment), `expected "${fragment}" in: ${error.message}`)
	return true
}

test('HB-478 facet 4: an empty payload for a session file rejects and leaves the good file untouched', async () => {
	const { target, bundleWith } = await setup()
	await assert.rejects(importSessionBackup(target, bundleWith({ [SESSION_FILE]: '' })), rejectsWith('empty payload'))
	assert.equal(await readFile(join(target, SESSION_FILE), 'utf-8'), SESSION_JSON)
})

test('HB-478 facet 4: a NUL-byte payload for a session file rejects and leaves the good file untouched', async () => {
	const { target, bundleWith } = await setup()
	await assert.rejects(importSessionBackup(target, bundleWith({ [SESSION_FILE]: 'AAAA' })), rejectsWith('non-JSON payload'))
	assert.equal(await readFile(join(target, SESSION_FILE), 'utf-8'), SESSION_JSON)
})

test('HB-478 facet 4: a JSON-null payload for a session file rejects and leaves the good file untouched', async () => {
	const { target, bundleWith } = await setup()
	await assert.rejects(importSessionBackup(target, bundleWith({ [SESSION_FILE]: 'bnVsbA==' })), rejectsWith('non-JSON payload'))
	assert.equal(await readFile(join(target, SESSION_FILE), 'utf-8'), SESSION_JSON)
})

test('HB-478 facet 4: a plain-text (non-JSON) payload for a session file rejects', async () => {
	const { target, bundleWith } = await setup()
	await assert.rejects(importSessionBackup(target, bundleWith({ [SESSION_FILE]: b64('NEW-SESSION-A') })), rejectsWith('non-JSON payload'))
	assert.equal(await readFile(join(target, SESSION_FILE), 'utf-8'), SESSION_JSON)
})

test('HB-478 facet 4: an empty payload for creds.json is still rejected (existing creds gate asymmetry preserved)', async () => {
	const { target, bundleWith } = await setup()
	const before = await readFile(join(target, 'creds.json'), 'utf-8')
	await assert.rejects(importSessionBackup(target, bundleWith({ 'creds.json': '' })), rejectsWith('creds.json'))
	assert.equal(await readFile(join(target, 'creds.json'), 'utf-8'), before)
})

test('HB-478 facet 4: a clean bundle still imports fully, byte-identical', async () => {
	const { target, bundleWith } = await setup()
	await importSessionBackup(target, bundleWith({}))
	assert.equal(await readFile(join(target, SESSION_FILE), 'utf-8'), SESSION_JSON)
})
