// (34) Batch 2.6.0 — Group A (media upload/download) regressions:
// HB-417 (+ short-body addendum) + HB-466 (ranged-download response
// validation), HB-423 (+ whitespace addendum) + HB-208 addendum
// run-0819 (getStream scheme dispatch), HB-426 (getUrlInfo HQ
// thumbnail isolation), HB-451/HB-457/HB-465 (upload redirect:
// malformed Location, dropped auth query, arbitrary host),
// HB-463 (encodeFrame >16 MiB), HB-96 addendum run-0921
// (endByte: 0), HB-208 addendum situs ke-4 (string chunks) +
// addendum run-0655 (bare stream.destroy()), HB-277 addendum
// (readImageDimensions AVIF/BMP/TIFF/HEIC), HB-302 addendum ke-3 +
// addendum run-0790 (upload timeout/redirect-limit Boom),
// HB-351 addenda 3+4 (uploadWithFetch fd leak, redirect socket),
// HB-392 addendum 2 (32-bit timer overflow) + addendum run-0613
// (mid-body abort Boom 408), HB-220 addendum 2 (transient head
// concat). Fully offline & deterministic: local HTTP servers,
// stubbed fetch, crafted image headers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = rel => path.join(ROOT, rel)

const {
	getStream,
	getHttpStream,
	getRawMediaUploadData,
	encryptedStream,
	uploadWithNodeHttp,
	uploadWithFetch,
	downloadEncryptedContent,
	getMediaKeys,
	sanitizeMediaTimeoutMs,
	toBuffer,
	toBufferWithLimit,
	assertImageWithinPixelLimit
} = await import(L('lib/Utils/messages-media.js'))
const { readImageDimensions } = await import(L('lib/Utils/safe-fetch.js'))
const { getUrlInfo } = await import(L('lib/Utils/link-preview.js'))
const { makeNoiseHandler } = await import(L('lib/Utils/noise-handler.js'))
const { Curve } = await import(L('lib/Utils/crypto.js'))
const { NOISE_WA_HEADER } = await import(L('lib/Defaults/index.js'))
const { prepareWAMessageMedia } = await import(L('lib/Utils/messages.js'))

const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode
const sleep = ms => new Promise(r => setTimeout(r, ms))

const consume = async stream => {
	const chunks = []
	for await (const c of stream) chunks.push(c)
	return Buffer.concat(chunks)
}

const withTimeout = (p, ms, label) =>
	Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms (${label})`)), ms))])

const makeUploadFile = (t, size = 64, fill = 1) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb260-'))
	const filePath = path.join(dir, 'up.bin')
	fs.writeFileSync(filePath, Buffer.alloc(size, fill))
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
	return filePath
}

const listenServer = async (t, handler) => {
	const server = http.createServer(handler)
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	t.after(() => {
		server.closeAllConnections?.()
		server.close()
	})
	return { server, base: `http://127.0.0.1:${server.address().port}` }
}

// AES-256-CBC media blob (4096-byte plaintext) + the keys that
// decrypt it, built exactly like the HB-289 fixture in file 11.
const makeMediaFixture = async () => {
	const mediaKey = Crypto.randomBytes(32)
	const keys = await getMediaKeys(mediaKey, 'image')
	const plaintext = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
	const cipher = Crypto.createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const mac = Crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)
	return { keys, plaintext, validBody: Buffer.concat([ciphertext, mac]) }
}

// Range-aware media server. Modes:
// 'honor' — 206 with the correct Content-Range; 'ignore' — 200 with
// the full body despite the Range header; 'wrong-start' — 206 whose
// Content-Range starts at 0, not the requested start; 'short' —
// correct Content-Range but only half the body, then a clean EOF.
const rangeServer = async (t, mode, { validBody }) => {
	const { base } = await listenServer(t, (req, res) => {
		if (req.url === '/dl') {
			res.writeHead(302, { Location: '/media' })
			res.end()
			return
		}

		const range = req.headers.range
		if (!range) {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(validBody.length) })
			res.end(validBody)
			return
		}

		const m = /^bytes=(\d+)-(\d*)$/.exec(range)
		if (!m) {
			res.writeHead(416)
			res.end()
			return
		}

		const start = Number(m[1])
		const end = m[2] ? Number(m[2]) : validBody.length - 1
		const clampedEnd = Math.min(end, validBody.length - 1)
		if (mode === 'ignore') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(validBody.length) })
			res.end(validBody)
			return
		}

		if (mode === 'wrong-start') {
			const slice = validBody.subarray(0, clampedEnd - start + 1)
			res.writeHead(206, {
				'Content-Type': 'application/octet-stream',
				'Content-Range': `bytes 0-${slice.length - 1}/${validBody.length}`,
				'Content-Length': String(slice.length)
			})
			res.end(slice)
			return
		}

		const slice = validBody.subarray(start, clampedEnd + 1)
		if (mode === 'short') {
			const half = slice.subarray(0, Math.floor(slice.length / 2))
			res.writeHead(206, {
				'Content-Type': 'application/octet-stream',
				'Content-Range': `bytes ${start}-${clampedEnd}/${validBody.length}`,
				'Content-Length': String(half.length)
			})
			res.end(half)
			return
		}

		res.writeHead(206, {
			'Content-Type': 'application/octet-stream',
			'Content-Range': `bytes ${start}-${clampedEnd}/${validBody.length}`,
			'Content-Length': String(slice.length)
		})
		res.end(slice)
	})
	return base
}

// ── HB-417 / HB-466: ranged downloads validate the response ────────
test('HB-417/HB-466: a ranged download refused with Boom 502 when the server answers 200 instead of 206', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'ignore', fixture)
	await assert.rejects(
		withTimeout((async () => consume(await downloadEncryptedContent(`${base}/media`, fixture.keys, { startByte: 1000 })))(), 5000, 'range-200'),
		err => isBoom(err, 502)
	)
})

test('HB-417: a ranged download refused with Boom 502 when the 206 Content-Range starts at the wrong offset', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'wrong-start', fixture)
	await assert.rejects(
		withTimeout((async () => consume(await downloadEncryptedContent(`${base}/media`, fixture.keys, { startByte: 1000 })))(), 5000, 'range-wrong-start'),
		err => isBoom(err, 502)
	)
})

test('HB-417 addendum: a ranged download refused with Boom 502 when the 206 body is short (correct Content-Range, clean EOF)', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'short', fixture)
	await assert.rejects(
		withTimeout(
			(async () => consume(await downloadEncryptedContent(`${base}/media`, fixture.keys, { startByte: 1000, endByte: 2000 })))(),
			5000,
			'range-short'
		),
		err => isBoom(err, 502)
	)
})

test('HB-417 (control): a honoured ranged download still returns the exact slice', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'honor', fixture)
	const out = await withTimeout(
		consume(await downloadEncryptedContent(`${base}/media`, fixture.keys, { startByte: 1000, endByte: 2000 })),
		5000,
		'range-ok'
	)
	assert.ok(out.equals(fixture.plaintext.subarray(1000, 2000)), 'ranged slice does not match plaintext[1000:2000]')
})

test('HB-417 (control): a full download still decrypts and MAC-verifies', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'honor', fixture)
	const out = await withTimeout(consume(await downloadEncryptedContent(`${base}/media`, fixture.keys)), 5000, 'full')
	assert.ok(out.equals(fixture.plaintext), 'full download does not match plaintext')
})

// ── HB-2026-1112-96 addendum run-0921: endByte: 0 ──────────────────
test('HB-2026-1112-96 addendum: endByte: 0 returns 0 bytes, not the whole file', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'honor', fixture)
	const out = await withTimeout(
		consume(await downloadEncryptedContent(`${base}/media`, fixture.keys, { endByte: 0 })),
		5000,
		'endbyte-0'
	)
	assert.equal(out.length, 0, `a 0-byte range returned ${out.length} bytes`)
})

// ── HB-465: downloads refuse redirects to an arbitrary host ────────
test('HB-465: a media download that redirects to another origin is refused with Boom 502', async t => {
	const fixture = await makeMediaFixture()
	const { base: baseB } = await listenServer(t, (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		res.end(fixture.validBody)
	})
	const { base: baseA } = await listenServer(t, (req, res) => {
		if (req.url === '/dl') {
			res.writeHead(302, { Location: `${baseB}/target` })
			res.end()
			return
		}

		res.writeHead(404)
		res.end()
	})
	await assert.rejects(
		withTimeout((async () => consume(await downloadEncryptedContent(`${baseA}/dl`, fixture.keys)))(), 5000, 'dl-redirect'),
		err => isBoom(err, 502)
	)
})

test('HB-465 (control): a same-origin redirect still downloads', async t => {
	const fixture = await makeMediaFixture()
	const base = await rangeServer(t, 'honor', fixture)
	// the range server answers 200 + full body when no Range header
	// is sent, and /dl redirects to /media on the same origin
	const out = await withTimeout(consume(await downloadEncryptedContent(`${base}/dl`, fixture.keys)), 5000, 'dl-same-origin')
	assert.ok(out.equals(fixture.plaintext), 'same-origin redirect download does not match plaintext')
})

// ── HB-423 (+ whitespace addendum) / HB-208 addendum run-0819 ──────
test('HB-423: getStream dispatches an uppercase HTTP: URL to the remote branch', async t => {
	const fixture = await makeMediaFixture()
	const { base } = await listenServer(t, (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		res.end(fixture.validBody)
	})
	const { stream, type } = await getStream({ url: `HTTP://127.0.0.1:${new URL(base).port}/x` })
	assert.equal(type, 'remote', 'uppercase HTTP: fell through to the file branch')
	assert.ok((await consume(stream)).equals(fixture.validBody), 'uppercase HTTP: body mismatch')
})

test('HB-423: getStream dispatches an uppercase DATA: URL to the buffer branch', async t => {
	const { stream, type } = await getStream({ url: 'DATA:text/plain;base64,aGk=' })
	assert.equal(type, 'buffer', 'uppercase DATA: fell through to the file branch')
	assert.equal((await consume(stream)).toString(), 'hi', 'uppercase DATA: body mismatch')
})

test('HB-208 addendum run-0819: getStream dispatches a file: URL string to the file branch', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb260-file-'))
	const filePath = path.join(dir, 'hello.txt')
	fs.writeFileSync(filePath, 'hello file')
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
	const { stream, type } = await getStream({ url: pathToFileURL(filePath).href })
	assert.equal(type, 'file', 'file: URL string fell through to createReadStream')
	assert.equal((await consume(stream)).toString(), 'hello file', 'file: URL string body mismatch')
})

test('HB-423 addendum: getStream tolerates leading whitespace in the URL string', async t => {
	const fixture = await makeMediaFixture()
	const { base } = await listenServer(t, (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		res.end(fixture.validBody)
	})
	for (const prefix of [' ', '\t', '\n']) {
		const { stream, type } = await getStream({ url: `${prefix}${base}/x` })
		assert.equal(type, 'remote', `URL with a leading ${JSON.stringify(prefix)} fell through to the file branch`)
		assert.ok((await consume(stream)).equals(fixture.validBody), `URL with a leading ${JSON.stringify(prefix)} body mismatch`)
	}
})

test('HB-423 (control): a lowercase http URL and an ftp: URL keep their old behaviour', async t => {
	const fixture = await makeMediaFixture()
	const { base } = await listenServer(t, (_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
		res.end(fixture.validBody)
	})
	const { type } = await getStream({ url: `${base}/x` })
	assert.equal(type, 'remote')
	await assert.rejects(getStream({ url: 'ftp://example.com/x.bin' }), err => isBoom(err, 400))
})

// ── HB-426: getUrlInfo HQ thumbnail isolation ───────────────────────
const linkPreviewServer = async t => {
	const { server, base } = await listenServer(t, (req, res) => {
		if (req.url === '/page-bad') {
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(
				'<html><head><title>Test Page</title>' +
					'<meta property="og:title" content="Test Page">' +
					`<meta property="og:image" content="${base}/img404">` +
					'<meta property="og:description" content="desc"></head><body></body></html>'
			)
			return
		}

		if (req.url === '/page-huge') {
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(
				'<html><head><title>Test Page</title>' +
					'<meta property="og:title" content="Test Page">' +
					`<meta property="og:image" content="${base}/img6m">` +
					'<meta property="og:description" content="desc"></head><body></body></html>'
			)
			return
		}

		if (req.url === '/img404') {
			res.writeHead(404)
			res.end('not here')
			return
		}

		if (req.url === '/img6m') {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(6 * 1024 * 1024) })
			res.end(Buffer.alloc(6 * 1024 * 1024))
			return
		}

		if (req.url === '/img-ok') {
			// a real 1x1 WEBP the HQ branch can thumbnail
			const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
			res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(WEBP_1X1.length) })
			res.end(WEBP_1X1)
			return
		}

		if (req.url === '/page-ok') {
			res.writeHead(200, { 'Content-Type': 'text/html' })
			res.end(
				'<html><head><title>Test Page</title>' +
					'<meta property="og:title" content="Test Page">' +
					`<meta property="og:image" content="${base}/img-ok">` +
					'<meta property="og:description" content="desc"></head><body></body></html>'
			)
			return
		}

		res.writeHead(404)
		res.end()
	})
	t.after(() => server.closeAllConnections?.())
	return base
}

const linkPreviewOpts = () => ({
	thumbnailWidth: 192,
	fetchOpts: { timeout: 3000, allowPrivateNetworks: true },
	uploadImage: async () => ({ directPath: '/thumb/dp' }),
	logger: silentLogger
})

test('HB-426: getUrlInfo survives a 404 og:image (HQ branch failure is isolated)', async t => {
	const base = await linkPreviewServer(t)
	const info = await withTimeout(getUrlInfo(`${base}/page-bad`, linkPreviewOpts()), 10000, 'link-404')
	assert.equal(info.title, 'Test Page')
	assert.equal(info.highQualityThumbnail, undefined, 'a failed HQ thumbnail should not produce a thumbnail')
})

test('HB-426: getUrlInfo survives an over-limit og:image (HQ branch failure is isolated)', async t => {
	const base = await linkPreviewServer(t)
	const info = await withTimeout(getUrlInfo(`${base}/page-huge`, linkPreviewOpts()), 10000, 'link-huge')
	assert.equal(info.title, 'Test Page')
	assert.equal(info.highQualityThumbnail, undefined)
})

test('HB-426 (control): a valid og:image still yields a high-quality thumbnail', async t => {
	const base = await linkPreviewServer(t)
	const info = await withTimeout(getUrlInfo(`${base}/page-ok`, linkPreviewOpts()), 10000, 'link-ok')
	assert.equal(info.title, 'Test Page')
	assert.ok(info.highQualityThumbnail, 'a valid og:image lost its HQ thumbnail')
})

// ── HB-451 / HB-457 / HB-465 / HB-302: upload redirects ────────────
const uploadTestServer = async (t, handler) => listenServer(t, handler)

test('HB-451: a malformed Location on the upload redirect is a Boom 502, not an uncaughtException', async t => {
	const filePath = makeUploadFile(t)
	const { base } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(302, { Location: 'http://[::1' })
		res.end()
	})
	const uncaught = []
	const onUncaught = err => uncaught.push(err)
	process.on('uncaughtException', onUncaught)
	try {
		await assert.rejects(
			withTimeout(
				uploadWithNodeHttp({
					filePath,
					url: `${base}/up`,
					headers: { 'Content-Type': 'application/octet-stream' },
				}),
				5000,
				'malformed-location'
			),
			err => isBoom(err, 502)
		)
		await sleep(300)
		assert.deepEqual(uncaught, [], `uncaughtException leaked: ${uncaught.map(e => e?.message)}`)
	} finally {
		process.off('uncaughtException', onUncaught)
	}
})

test('HB-457: a relative upload redirect keeps the original ?auth= and ?token= query', async t => {
	const filePath = makeUploadFile(t)
	const { base } = await uploadTestServer(t, (req, res) => {
		req.resume()
		if (req.url.startsWith('/up1')) {
			res.writeHead(302, { Location: '/up2' })
			res.end()
			return
		}

		if (req.url.startsWith('/up2')) {
			const q = new URL(req.url, 'http://x')
			if (q.searchParams.get('auth') === 'AAA' && q.searchParams.get('token') === 'BBB') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ url: 'https://example.com/x', direct_path: '/dp' }))
			} else {
				res.writeHead(403)
				res.end('no auth')
			}

			return
		}

		res.writeHead(404)
		res.end()
	})
	const out = await withTimeout(
		uploadWithNodeHttp({
			filePath,
			url: `${base}/up1?auth=AAA&token=BBB`,
			headers: { 'Content-Type': 'application/octet-stream' },
		}),
		5000,
		'relative-redirect'
	)
	assert.deepEqual(out, { url: 'https://example.com/x', direct_path: '/dp' })
})

test('HB-465: an upload redirect to another origin is refused with Boom 502', async t => {
	const filePath = makeUploadFile(t)
	const { base: baseB } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ url: 'https://evil.example/x', direct_path: '/dp' }))
	})
	const { base: baseA } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(302, { Location: `${baseB}/up2` })
		res.end()
	})
	await assert.rejects(
		withTimeout(
			uploadWithNodeHttp({
				filePath,
				url: `${baseA}/up1`,
				headers: { 'Content-Type': 'application/octet-stream' },
			}),
			5000,
			'upload-xorigin'
		),
		err => isBoom(err, 502)
	)
})

test('HB-465: uploadWithFetch also refuses a redirect to another origin', async t => {
	const filePath = makeUploadFile(t)
	const { base: baseB } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ url: 'https://evil.example/x', direct_path: '/dp' }))
	})
	const { base: baseA } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(302, { Location: `${baseB}/up2` })
		res.end()
	})
	await assert.rejects(
		withTimeout(
			uploadWithFetch({
				filePath,
				url: `${baseA}/up1`,
				headers: { 'Content-Type': 'application/octet-stream' },
			}),
			5000,
			'upload-fetch-xorigin'
		),
		err => isBoom(err, 502)
	)
})

test('HB-457/HB-465 (control): uploadWithFetch follows a same-origin relative redirect with its query intact', async t => {
	const filePath = makeUploadFile(t)
	const { base } = await uploadTestServer(t, (req, res) => {
		req.resume()
		if (req.url.startsWith('/up1')) {
			res.writeHead(302, { Location: '/up2' })
			res.end()
			return
		}

		if (req.url.startsWith('/up2')) {
			const q = new URL(req.url, 'http://x')
			if (q.searchParams.get('auth') === 'AAA' && q.searchParams.get('token') === 'BBB') {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ url: 'https://example.com/x', direct_path: '/dp' }))
			} else {
				res.writeHead(403)
				res.end('no auth')
			}

			return
		}

		res.writeHead(404)
		res.end()
	})
	const out = await withTimeout(
		uploadWithFetch({
			filePath,
			url: `${base}/up1?auth=AAA&token=BBB`,
			headers: { 'Content-Type': 'application/octet-stream' },
		}),
		5000,
		'fetch-relative-redirect'
	)
	assert.deepEqual(out, { url: 'https://example.com/x', direct_path: '/dp' })
})

test('HB-302 addendum ke-3: the redirect cap rejects a Boom 502, not a plain Error', async t => {
	const filePath = makeUploadFile(t)
	const { base } = await uploadTestServer(t, (req, res) => {
		req.resume()
		res.writeHead(302, { Location: '/loop' })
		res.end()
	})
	await assert.rejects(
		withTimeout(
			uploadWithNodeHttp({
				filePath,
				url: `${base}/loop`,
				headers: { 'Content-Type': 'application/octet-stream' },
			}),
			5000,
			'redirect-loop'
		),
		err => {
			assert.ok(isBoom(err, 502), `expected Boom 502, got ${err?.constructor?.name}: ${err?.message}`)
			assert.equal(err.message, 'Too many redirects')
			return true
		}
	)
})

test('HB-302 addendum run-0790: a stalled upload response rejects a Boom 408, not a plain Error', async t => {
	const filePath = makeUploadFile(t)
	const { base } = await uploadTestServer(t, (req, res) => {
		req.resume()
		req.on('end', () => {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.write('{"url":')
			// never end: the response stalls mid-body
		})
	})
	await assert.rejects(
		uploadWithNodeHttp({
			filePath,
			url: `${base}/trickle`,
			headers: { 'Content-Type': 'application/octet-stream' },
			timeoutMs: 1000,
		}),
		err => isBoom(err, 408)
	)
})

// ── HB-463: encodeFrame rejects a frame >16 MiB ────────────────────
test('HB-463: encodeFrame throws Boom 400 for a payload over 16 MiB', async t => {
	const handler = makeNoiseHandler({
		keyPair: Curve.generateKeyPair(),
		NOISE_HEADER: NOISE_WA_HEADER,
		logger: silentLogger
	})
	assert.throws(
		() => handler.encodeFrame(Buffer.alloc(17 * 1024 * 1024)),
		err => isBoom(err, 400)
	)
	// control: a 1 MiB payload still encodes with the correct 24-bit
	// length field in the 3-byte frame header
	const payload = Buffer.alloc(1024 * 1024, 0xab)
	const frame = handler.encodeFrame(payload)
	assert.equal(frame.length, 4 + 3 + payload.length)
	assert.equal(frame.readUIntBE(4, 3), payload.length)
})

// ── HB-277 addendum: readImageDimensions on BMP/TIFF/AVIF/HEIC ──────
const bmp = (w, h) => {
	const b = Buffer.alloc(54)
	b.write('BM', 0)
	b.writeUInt32LE(54, 10)
	b.writeUInt32LE(40, 14)
	b.writeInt32LE(w, 18)
	b.writeInt32LE(h, 22)
	return b
}

const tiff = (w, h, be) => {
	const b = Buffer.alloc(34)
	if (be) {
		b.write('MM', 0)
		b.writeUInt16BE(42, 2)
		b.writeUInt32BE(8, 4)
		b.writeUInt16BE(2, 8)
		b.writeUInt16BE(256, 10)
		b.writeUInt16BE(4, 12)
		b.writeUInt32BE(1, 14)
		b.writeUInt32BE(w, 18)
		b.writeUInt16BE(257, 22)
		b.writeUInt16BE(4, 24)
		b.writeUInt32BE(1, 26)
		b.writeUInt32BE(h, 30)
	} else {
		b.write('II', 0)
		b.writeUInt16LE(42, 2)
		b.writeUInt32LE(8, 4)
		b.writeUInt16LE(2, 8)
		b.writeUInt16LE(256, 10)
		b.writeUInt16LE(4, 12)
		b.writeUInt32LE(1, 14)
		b.writeUInt32LE(w, 18)
		b.writeUInt16LE(257, 22)
		b.writeUInt16LE(4, 24)
		b.writeUInt32LE(1, 26)
		b.writeUInt32LE(h, 30)
	}

	return b
}

const avifLike = (w, h, brand) => {
	const ftyp = Buffer.alloc(24)
	ftyp.writeUInt32BE(24, 0)
	ftyp.write('ftyp', 4)
	ftyp.write(brand, 8)
	const ispe = Buffer.alloc(20)
	ispe.writeUInt32BE(20, 0)
	ispe.write('ispe', 4)
	ispe.writeUInt32BE(w, 12)
	ispe.writeUInt32BE(h, 16)
	const metaBody = Buffer.alloc(4 + ispe.length)
	ispe.copy(metaBody, 4)
	const meta = Buffer.alloc(8 + metaBody.length)
	meta.writeUInt32BE(meta.length, 0)
	meta.write('meta', 4)
	metaBody.copy(meta, 8)
	return Buffer.concat([ftyp, meta])
}

test('HB-277 addendum: BMP/TIFF/AVIF/HEIC dimensions are parsed so the pixel-bomb guard can fire', async t => {
	for (const [name, buf] of [
		['BMP', bmp(17000, 17000)],
		['TIFF-LE', tiff(17000, 17000, false)],
		['TIFF-BE', tiff(17000, 17000, true)],
		['AVIF', avifLike(17000, 17000, 'avif')],
		['HEIC', avifLike(17000, 17000, 'heic')]
	]) {
		assert.deepEqual(readImageDimensions(buf), { width: 17000, height: 17000 }, `${name} dimensions were not parsed`)
		assert.throws(
			() => assertImageWithinPixelLimit(buf),
			err => isBoom(err, 400),
			`${name} 17000x17000 should trip the pixel limit`
		)
	}
})

test('HB-277 addendum: small BMP/TIFF/AVIF images pass the guard and unknown formats still return null', async t => {
	assert.deepEqual(readImageDimensions(bmp(2, 2)), { width: 2, height: 2 })
	assert.deepEqual(readImageDimensions(tiff(3, 3, false)), { width: 3, height: 3 })
	assert.deepEqual(readImageDimensions(avifLike(4, 4, 'avif')), { width: 4, height: 4 })
	assert.doesNotThrow(() => assertImageWithinPixelLimit(bmp(2, 2)))
	assert.equal(readImageDimensions(Buffer.from('not an image at all, just bytes')), null)
	assert.equal(readImageDimensions(Buffer.alloc(4)), null)
})

// ── HB-208 addendum situs ke-4: host streams yielding strings ───────
test('HB-208 addendum situs ke-4: a video stream yielding string chunks encrypts with a byte-accurate fileLength', async t => {
	const out = await encryptedStream({ stream: Readable.from(['é'.repeat(2000)]) }, 'video', { logger: silentLogger })
	try {
		assert.equal(out.fileLength, 4000, 'fileLength counted chars, not bytes')
	} finally {
		if (out.encFilePath) fs.rmSync(out.encFilePath, { force: true })
		if (out.filePath) fs.rmSync(out.filePath, { force: true })
	}
})

test('HB-208 addendum situs ke-4: an image stream yielding string chunks is byte-accurate', async t => {
	const out = await encryptedStream({ stream: Readable.from(['é'.repeat(2000)]) }, 'image', { logger: silentLogger })
	try {
		assert.equal(out.fileLength, 4000, 'fileLength counted chars, not bytes')
	} finally {
		if (out.encFilePath) fs.rmSync(out.encFilePath, { force: true })
		if (out.filePath) fs.rmSync(out.filePath, { force: true })
	}
})

test('HB-208 addendum situs ke-4: toBuffer and getRawMediaUploadData accept string chunks', async t => {
	assert.ok((await toBuffer(Readable.from(['abc']))).equals(Buffer.from('abc')))
	assert.ok((await toBufferWithLimit(Readable.from(['abc']), 100)).equals(Buffer.from('abc')))
	const out = await getRawMediaUploadData({ stream: Readable.from(['é'.repeat(2000)]) }, 'image')
	try {
		assert.equal(out.fileLength, 4000, 'fileLength counted chars, not bytes')
	} finally {
		if (out.encFilePath) fs.rmSync(out.encFilePath, { force: true })
		if (out.filePath) fs.rmSync(out.filePath, { force: true })
	}
})

// ── HB-208 addendum run-0655: streams without .destroy() ────────────
test('HB-208 addendum run-0655: a bare async-iterable stream (no .destroy) survives the success path', async t => {
	async function* gen() {
		yield Buffer.from('hello')
		yield Buffer.from(' world')
	}

	const out = await getRawMediaUploadData({ stream: gen() }, 'image')
	try {
		assert.equal(out.fileLength, 11)
	} finally {
		if (out.encFilePath) fs.rmSync(out.encFilePath, { force: true })
		if (out.filePath) fs.rmSync(out.filePath, { force: true })
	}

	async function* gen2() {
		yield Buffer.from('abc')
	}

	assert.ok((await toBuffer(gen2())).equals(Buffer.from('abc')))

	async function* gen3() {
		yield Buffer.from('abc')
	}

	assert.ok((await toBufferWithLimit(gen3(), 100)).equals(Buffer.from('abc')))
})

// ── HB-208 situs 2 (already fixed in 2.5.0): media null ─────────────
test('HB-208 situs 2 (already-fixed): prepareWAMessageMedia({image: null}) rejects Boom 400 before any stream access', async t => {
	await assert.rejects(
		prepareWAMessageMedia({ image: null }, { upload: async () => ({ directPath: '/x' }), logger: silentLogger }),
		err => isBoom(err, 400)
	)
})

// ── HB-392 addendum 2: 32-bit timer overflow ─────────────────────────
test('HB-392 addendum 2: sanitizeMediaTimeoutMs clamps to the 32-bit timer ceiling', async t => {
	assert.equal(sanitizeMediaTimeoutMs(3e9), 2147483647)
	assert.equal(sanitizeMediaTimeoutMs(2147483648), 2147483647)
	assert.equal(sanitizeMediaTimeoutMs(250), 250)
})

test('HB-392 addendum 2: an upload with a >2^31-1 ms timeout is not rejected instantly', async t => {
	const filePath = makeUploadFile(t)
	// black-hole server: accepts the connection, never responds
	const { base } = await uploadTestServer(t, (_req, _res) => {})
	const p = uploadWithNodeHttp({
		filePath,
		url: `${base}/up`,
		headers: { 'Content-Type': 'application/octet-stream' },
		timeoutMs: 3e9,
	})
	const settled = await Promise.race([p.then(() => 'settled', () => 'settled'), sleep(400).then(() => 'pending')])
	assert.equal(settled, 'pending', 'the upload settled within 400ms — its timer overflowed to ~1ms')
	// do not await p: the black-hole server never answers, and the
	// attempt is only torn down when t.after closes the server
	p.catch(() => {})
})

// ── HB-392 addendum run-0613: mid-body abort is a Boom 408 ──────────
test('HB-392 addendum run-0613: a mid-body abort rejects Boom 408 from encryptedStream and getRawMediaUploadData', async t => {
	const { base } = await listenServer(t, (req, res) => {
		if (req.url === '/stall') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(1024) })
			res.write(Buffer.alloc(32))
			// never finish the body
			return
		}

		res.writeHead(404)
		res.end()
	})
	const opts = { logger: silentLogger, opts: { signal: AbortSignal.timeout(500) } }
	await assert.rejects(
		encryptedStream({ url: `${base}/stall` }, 'image', opts),
		err => isBoom(err, 408)
	)
	await assert.rejects(
		getRawMediaUploadData({ url: `${base}/stall` }, 'image', silentLogger, { signal: AbortSignal.timeout(500) }),
		err => isBoom(err, 408)
	)
})

test('HB-392 addendum run-0613: a mid-body abort rejects Boom 408 from downloadEncryptedContent and toBuffer', async t => {
	const fixture = await makeMediaFixture()
	const { base } = await listenServer(t, (req, res) => {
		if (req.url === '/stall') {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.validBody.length) })
			res.write(fixture.validBody.subarray(0, 32))
			// never finish the body
			return
		}

		res.writeHead(404)
		res.end()
	})
	await assert.rejects(
		(async () => consume(await downloadEncryptedContent(`${base}/stall`, fixture.keys, { options: { signal: AbortSignal.timeout(500) } })))(),
		err => isBoom(err, 408)
	)
	const s = new Readable({ read() {} })
	s.push(Buffer.from('x'))
	queueMicrotask(() => s.destroy(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
	await assert.rejects(toBuffer(s), err => isBoom(err, 408))
})

// ── HB-220 addendum 2: no transient full-media copy in the head scan ─
test('HB-220 addendum 2: encryptedStream never Buffer.concat()s the whole media while scanning the head', async t => {
	const origConcat = Buffer.concat
	let maxConcat = 0
	Buffer.concat = (...args) => {
		const r = origConcat(...args)
		if (r.length > maxConcat) maxConcat = r.length
		return r
	}

	try {
		const out = await encryptedStream({ stream: Readable.from([Buffer.alloc(20 * 1024 * 1024, 7)]) }, 'video', { logger: silentLogger })
		try {
			assert.equal(out.fileLength, 20 * 1024 * 1024)
			assert.ok(maxConcat < 1024 * 1024, `largest Buffer.concat was ${maxConcat} bytes — the whole media was copied`)
		} finally {
			if (out.encFilePath) fs.rmSync(out.encFilePath, { force: true })
			if (out.filePath) fs.rmSync(out.filePath, { force: true })
		}
	} finally {
		Buffer.concat = origConcat
	}
})

// ── HB-351 addendum 3: uploadWithFetch destroys the node stream ─────
test('HB-351 addendum 3: uploadWithFetch destroys its node stream when fetch fails before consuming it', async t => {
	if (!fs.existsSync('/proc/self/fd')) {
		t.skip('no /proc/self/fd on this platform')
		return
	}

	const origFetch = globalThis.fetch
	globalThis.fetch = async (_url, init) => {
		const reader = init.body.getReader()
		await reader.read()
		throw new Error('connect ECONNREFUSED 127.0.0.1:9')
	}

	try {
		const fdCount = () => fs.readdirSync('/proc/self/fd').length
		const before = fdCount()
		for (let i = 0; i < 5; i++) {
			const filePath = makeUploadFile(t)
			await assert.rejects(
				uploadWithFetch({
					filePath,
					url: 'http://127.0.0.1:9/up',
					headers: { 'Content-Type': 'application/octet-stream' },
				}),
				/connect ECONNREFUSED/
			)
		}

		await sleep(150)
		assert.equal(fdCount(), before, 'uploadWithFetch leaked file descriptors')
	} finally {
		globalThis.fetch = origFetch
	}
})

// ── HB-351 addendum 4: the redirect branch destroys the request ─────
test('HB-351 addendum 4: the upload redirect destroys the first-attempt request socket', async t => {
	const bigFile = makeUploadFile(t, 10 * 1024 * 1024, 2)
	const { base: baseB } = await listenServer(t, (req, res) => {
		req.resume()
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ url: 'https://example.com/x', direct_path: '/dp' }))
	})
	let openA = 0
	const { server: serverA, base: baseA } = await listenServer(t, (req, res) => {
		req.resume()
		// 302 immediately, without reading the body: the client is
		// still uploading the 10 MiB file when the response arrives
		res.writeHead(302, { Location: `${baseB}/up2` })
		res.end()
	})
	serverA.on('connection', socket => {
		openA++
		socket.on('close', () => openA--)
	})
	// B is a different origin, so the HB-465 guard rejects the
	// redirect — that is fine here: the test only measures whether
	// the first-attempt socket to A was destroyed
	await assert.rejects(
		withTimeout(
			uploadWithNodeHttp({
				filePath: bigFile,
				url: `${baseA}/up1`,
				headers: { 'Content-Type': 'application/octet-stream' },
			}),
			5000,
			'redirect-socket'
		),
		err => isBoom(err, 502)
	)
	await sleep(500)
	assert.equal(openA, 0, 'the first-attempt socket to the redirecting server is still open')
})
