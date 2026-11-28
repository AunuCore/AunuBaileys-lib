// (48) Batch 2.9.0 — Group A3 (media cluster) regressions:
// HB-417 addendum facet 3 (a mid-body source error on a FULL
// download surfaces as Boom 502, not the raw undici TypeError),
// W14/H6/D18 (updateCoverPhoto refuses an upload result missing
// meta_hmac/fbid/ts instead of sending an IQ with "undefined"
// attrs), L7 (fixFileName treats '\' like '/'), L12
// (encryptMediaRetryRequest guards a key without a valid id).
// Fully offline & deterministic: local HTTP(S) servers, a fake
// socket transport, crafted fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import Crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lib, makeOfflineSocket, endQuietly, silentLogger, tmpDir } from './helpers.mjs'
import { downloadEncryptedContent, encryptMediaRetryRequest, getMediaKeys } from '../lib/Utils/messages-media.js'
import { decodeBinaryNode } from '../lib/WABinary/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode

const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}

const withTimeout = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

const listenServer = async (t, server) => {
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
	})
	return `http://127.0.0.1:${server.address().port}`
}

// AES-256-CBC media blob + keys, built like the fixture in file 34.
const makeMediaFixture = async () => {
	const mediaKey = Crypto.randomBytes(32)
	const keys = await getMediaKeys(mediaKey, 'image')
	const plaintext = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
	const cipher = Crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const mac = Crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	return { keys, plaintext, validBody: Buffer.concat([ciphertext, mac]) }
}

// ── HB-417 addendum facet 3: full-download mid-body source error ──

test('HB-417 facet 3: a full download whose source errors mid-body rejects Boom 502, not a raw TypeError', async t => {
	const fixture = await makeMediaFixture()
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		// deliver part of the body, then destroy the socket: a source
		// ERROR mid-body (undici surfaces it as TypeError 'terminated')
		res.write(fixture.validBody.subarray(0, 64), () => res.socket.destroy())
	})
	const base = await listenServer(t, server)
	await assert.rejects(
		withTimeout((async () => consume(await downloadEncryptedContent(`${base}/media`, fixture.keys)))(), 5000, 'full-drop'),
		err => isBoom(err, 502) && /failed while reading the response body/.test(err.message),
		'a mid-body source error on a full download must be a Boom 502, not the raw source error'
	)
})

test('HB-417 facet 3 (control): an intact full download still returns the exact plaintext', async t => {
	const fixture = await makeMediaFixture()
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		res.end(fixture.validBody)
	})
	const base = await listenServer(t, server)
	const out = await withTimeout(consume(await downloadEncryptedContent(`${base}/media`, fixture.keys)), 5000, 'full-ok')
	assert.ok(out.equals(fixture.plaintext), 'full download does not match plaintext')
})

// ── L12: encryptMediaRetryRequest key.id guard ────────────────────

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'

test('L12: encryptMediaRetryRequest rejects a key without a valid id with Boom 400, not a TypeError', () => {
	const mediaKey = Buffer.alloc(32, 7)
	assert.throws(() => encryptMediaRetryRequest({}, mediaKey, ME), err => isBoom(err, 400), 'key without id')
	assert.throws(() => encryptMediaRetryRequest(null, mediaKey, ME), err => isBoom(err, 400), 'null key')
	assert.throws(
		() => encryptMediaRetryRequest({ id: 123, remoteJid: PEER }, mediaKey, ME),
		err => isBoom(err, 400),
		'non-string id'
	)
	assert.throws(
		() => encryptMediaRetryRequest({ id: '', remoteJid: PEER }, mediaKey, ME),
		err => isBoom(err, 400),
		'empty id'
	)
})

test('L12 (control): encryptMediaRetryRequest with a valid key builds the same receipt node as before', () => {
	const node = encryptMediaRetryRequest({ id: 'MSG1', remoteJid: PEER, fromMe: true }, Buffer.alloc(32, 7), ME)
	assert.equal(node.tag, 'receipt')
	assert.equal(node.attrs.id, 'MSG1')
	assert.equal(node.attrs.type, 'server-error')
	assert.equal(node.attrs.to, ME)
	const rmr = node.content.find(n => n.tag === 'rmr')
	assert.equal(rmr.attrs.jid, PEER)
	assert.equal(rmr.attrs.from_me, 'true')
})

// ── L7: fixFileName treats backslash like forward slash ───────────

test('L7: useMultiFileAuthState maps a backslash id to the same file as the forward-slash id', async () => {
	const dir = tmpDir('aunu-290-a3-l7-')
	const { state } = await lib.useMultiFileAuthState(dir, silentLogger)
	await state.keys.set({ session: { 'a\\b\\c': { record: 'backslash' } } })
	const afterBackslash = fs.readdirSync(dir)
	assert.ok(
		afterBackslash.includes('session-a__b__c.json'),
		`expected session-a__b__c.json on disk, got: ${afterBackslash.join(', ')}`
	)
	assert.ok(
		!afterBackslash.some(name => name.includes('\\')),
		`a filename still carries a raw backslash: ${afterBackslash.join(', ')}`
	)
	// the forward-slash spelling of the same id resolves to the same file
	const got = await state.keys.get('session', ['a/b/c'])
	assert.deepEqual(got['a/b/c'], { record: 'backslash' })
	// and the backslash spelling round-trips too
	const gotBack = await state.keys.get('session', ['a\\b\\c'])
	assert.deepEqual(gotBack['a\\b\\c'], { record: 'backslash' })
})

test('L7 (control): a plain id keeps its existing filename', async () => {
	const dir = tmpDir('aunu-290-a3-l7ctl-')
	const { state } = await lib.useMultiFileAuthState(dir, silentLogger)
	await state.keys.set({ session: { plain: { record: 'plain' } } })
	assert.ok(fs.readdirSync(dir).includes('session-plain.json'))
	const got = await state.keys.get('session', ['plain'])
	assert.deepEqual(got.plain, { record: 'plain' })
})

// ── W14/H6/D18: updateCoverPhoto incomplete upload result ─────────

const decodeFrame = async data => {
	const buf = Buffer.from(data)
	let off = 0
	if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
	const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
	return decodeBinaryNode(buf.subarray(off + 3, off + 3 + len))
}

const decodeSent = async sent => {
	const nodes = []
	for (const frame of sent) {
		nodes.push(await decodeFrame(frame))
	}
	return nodes
}

const findCoverPhotoNode = nodes => {
	const bizIq = nodes.find(n => n.tag === 'iq' && n.attrs?.xmlns === 'w:biz')
	if (!bizIq) return undefined
	const profile = bizIq.content?.find(n => n.tag === 'business_profile')
	return profile?.content?.find(n => n.tag === 'cover_photo')
}

// Socket whose transport records frames and answers every IQ: the
// w:m query gets a media_conn result, everything else a bare result.
// The fake is installed with defineProperty (the HB-2026-1112-19
// harness pattern in file 12): a plain assignment is replaced when
// the real dead-URL socket errors out during the async upload-data
// preparation, which made sendNode throw 'Connection Closed'.
const coverPhotoSocket = async (t, uploadPort) => {
	const sock = await makeOfflineSocket({
		fireInitQueries: false,
		customUploadHosts: [{ hostname: `127.0.0.1:${uploadPort}` }],
		fetchAgent: new https.Agent({ rejectUnauthorized: false })
	})
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME, name: '~' }
	const sent = []
	const fake = {
		readyState: 1,
		_closeFn: null,
		once(ev, fn) {
			if (ev === 'close') this._closeFn = fn
		},
		on() {},
		send(data, cb) {
			sent.push(data)
			if (cb) cb()
			decodeFrame(data)
				.then(node => {
					if (node?.tag !== 'iq' || !node.attrs?.id) return
					const content =
						node.attrs.xmlns === 'w:m'
							? [{ tag: 'media_conn', attrs: { auth: 'test-auth', ttl: '3600' }, content: [] }]
							: []
					sock.ws.emit(`TAG:${node.attrs.id}`, { tag: 'iq', attrs: { type: 'result', id: node.attrs.id }, content })
				})
				.catch(() => {})
		},
		close() {
			this.readyState = 3
			if (this._closeFn) this._closeFn()
		}
	}
	Object.defineProperty(sock.ws, 'socket', { get: () => fake, set: () => {}, configurable: true })
	Object.defineProperty(sock.ws, 'isOpen', { value: true, configurable: true })
	return { sock, sent }
}

// Local HTTPS upload host (self-signed, like the HB-366 fixture in
// file 14) answering with the given upload-result JSON.
const uploadServer = async (t, resultJson) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunu-290-a3-w14-'))
	execFileSync(
		'openssl',
		[
			'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'),
			'-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'
		],
		{ stdio: 'ignore' }
	)
	const server = https.createServer(
		{ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) },
		(req, res) => {
			req.resume()
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(resultJson))
			})
		}
	)
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})
	return server.address().port
}

test('W14/H6/D18: updateCoverPhoto throws Boom 502 and sends no IQ when the upload result lacks meta_hmac', async t => {
	const port = await uploadServer(t, {
		url: 'https://mmg.whatsapp.net/v/cover.enc',
		direct_path: '/v/cover.enc',
		fbid: 12345,
		ts: 1700000000
	})
	const { sock, sent } = await coverPhotoSocket(t, port)
	await assert.rejects(
		withTimeout(sock.updateCoverPhoto(Buffer.from('fake-cover-bytes')), 8000, 'cover-no-hmac'),
		err => isBoom(err, 502) && /incomplete/.test(err.message)
	)
	const nodes = await decodeSent(sent)
	assert.equal(findCoverPhotoNode(nodes), undefined, 'a cover_photo IQ went out despite the incomplete upload result')
	assert.equal(
		nodes.some(n => n.tag === 'iq' && n.attrs?.xmlns === 'w:biz'),
		false,
		'a w:biz IQ went out despite the incomplete upload result'
	)
})

test('W14/H6/D18: updateCoverPhoto throws Boom 502 and sends no IQ when the upload result lacks fbid', async t => {
	const port = await uploadServer(t, {
		url: 'https://mmg.whatsapp.net/v/cover.enc',
		direct_path: '/v/cover.enc',
		meta_hmac: 'hmac-x',
		ts: 1700000000
	})
	const { sock, sent } = await coverPhotoSocket(t, port)
	await assert.rejects(
		withTimeout(sock.updateCoverPhoto(Buffer.from('fake-cover-bytes')), 8000, 'cover-no-fbid'),
		err => isBoom(err, 502) && /incomplete/.test(err.message)
	)
	const nodes = await decodeSent(sent)
	assert.equal(
		nodes.some(n => n.tag === 'iq' && n.attrs?.xmlns === 'w:biz'),
		false,
		'a w:biz IQ went out despite the incomplete upload result'
	)
})

test('W14/H6/D18 (control): a complete upload result sends the same cover_photo IQ as before', async t => {
	const port = await uploadServer(t, {
		url: 'https://mmg.whatsapp.net/v/cover.enc',
		direct_path: '/v/cover.enc',
		meta_hmac: 'hmac-x',
		fbid: 12345,
		ts: 1700000000
	})
	const { sock, sent } = await coverPhotoSocket(t, port)
	const fbid = await withTimeout(sock.updateCoverPhoto(Buffer.from('fake-cover-bytes')), 8000, 'cover-ok')
	assert.equal(fbid, 12345)
	const nodes = await decodeSent(sent)
	const cover = findCoverPhotoNode(nodes)
	assert.ok(cover, 'no cover_photo node was sent for a complete upload result')
	assert.equal(cover.attrs.id, '12345')
	assert.equal(cover.attrs.op, 'update')
	assert.equal(cover.attrs.token, 'hmac-x')
	assert.equal(cover.attrs.ts, '1700000000')
})
