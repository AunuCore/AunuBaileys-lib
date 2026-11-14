// (e) v6 auth-state compatibility: creds/keys written in the 1.0.89
// (BufferJSON) shape load through useMultiFileAuthState with no
// re-pairing. Plus HB-116 (0600 files), HB-151 (bad creds shape ->
// fresh creds), HB-143 (BufferJSON rejects non-canonical base64).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lib, tmpDir, silentLogger } from './helpers.mjs'

test('(e) v6-shaped creds.json + key files load without error and keep identity', async () => {
	const dir = tmpDir()
	// Build a creds object with the CURRENT factory, then serialise it
	// exactly like v6 did (JSON + BufferJSON replacer) and reload.
	const first = await lib.useMultiFileAuthState(dir)
	const creds = first.state.creds
	fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, lib.BufferJSON.replacer))
	// A v6-style key file (pre-key) in the same serialisation.
	const keyPair = lib.Curve.generateKeyPair()
	await first.state.keys.set({ 'pre-key': { '1': { keyPair } } })
	await first.saveCreds()

	const second = await lib.useMultiFileAuthState(dir)
	assert.equal(second.state.creds.registrationId, creds.registrationId)
	assert.equal(second.state.creds.advSecretKey, creds.advSecretKey)
	assert.ok(Buffer.from(second.state.creds.noiseKey.public).equals(Buffer.from(creds.noiseKey.public)))
	const loaded = await second.state.keys.get('pre-key', ['1'])
	assert.ok(loaded['1'], 'pre-key 1 survived the round-trip')
	assert.ok(Buffer.from(loaded['1'].keyPair.public).equals(Buffer.from(keyPair.public)))
})

test('HB-116: saveCreds writes creds.json with mode 0600 (and heals a looser file)', async () => {
	const dir = tmpDir()
	const { state, saveCreds } = await lib.useMultiFileAuthState(dir)
	await saveCreds()
	const mode1 = fs.statSync(path.join(dir, 'creds.json')).mode & 0o777
	assert.equal(mode1, 0o600, `mode was ${mode1.toString(8)}`)
	fs.chmodSync(path.join(dir, 'creds.json'), 0o660)
	await saveCreds()
	const mode2 = fs.statSync(path.join(dir, 'creds.json')).mode & 0o777
	assert.equal(mode2, 0o600, `healed mode was ${mode2.toString(8)}`)
	assert.ok(state.creds)
})

test('HB-151: a corrupt creds shape on disk is discarded for fresh creds', async () => {
	const dir = tmpDir()
	fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ noiseKey: {} }))
	const { state } = await lib.useMultiFileAuthState(dir)
	// fresh creds carry a full 32-byte noise key
	assert.equal(Buffer.from(state.creds.noiseKey.public).length, 32)
	assert.equal(Buffer.from(state.creds.noiseKey.private).length, 32)
	assert.equal(typeof state.creds.registrationId, 'number')
})

test('HB-143: BufferJSON.reviver rejects non-canonical base64, accepts canonical', () => {
	assert.throws(
		() => JSON.parse('{"type":"Buffer","data":"aGVsbG8!"}', lib.BufferJSON.reviver),
		/invalid base64/
	)
	const buf = JSON.parse('{"type":"Buffer","data":"aGVsbG8="}', lib.BufferJSON.reviver)
	assert.equal(Buffer.from(buf).toString(), 'hello')
	// round-trip through replacer/reviver is lossless
	const original = Buffer.from([0, 1, 2, 250, 255])
	const back = JSON.parse(JSON.stringify({ v: original }, lib.BufferJSON.replacer), lib.BufferJSON.reviver)
	assert.ok(Buffer.from(back.v).equals(original))
})

test('makeCacheableSignalKeyStore wraps a plain store without throwing', async () => {
	const { state } = await lib.useMultiFileAuthState(tmpDir())
	const cached = lib.makeCacheableSignalKeyStore(state.keys, silentLogger)
	await cached.set({ 'pre-key': { '9': { keyPair: lib.Curve.generateKeyPair() } } })
	const got = await cached.get('pre-key', ['9'])
	assert.ok(got['9'])
})
