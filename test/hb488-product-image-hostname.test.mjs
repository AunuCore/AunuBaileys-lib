// HB-488 (2.7.0): uploadingNecessaryImages treated any URL
// containing the substring '.whatsapp.net' (path or query
// included) as already uploaded to WA and returned it verbatim.
// The check is now on the parsed hostname.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { uploadingNecessaryImages } = await import(path.join(ROOT, 'lib/Utils/business.js'))

test('HB-488: a URL with .whatsapp.net only in its query is downloaded and uploaded, not passed through', async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'image/jpeg' })
		res.end(Buffer.from('fake-image-bytes-488'))
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	try {
		const port = server.address().port
		let uploads = 0
		const upload = async () => {
			uploads += 1
			return { directPath: '/dp/488-uploaded' }
		}
		const [out] = await uploadingNecessaryImages(
			[{ url: `http://127.0.0.1:${port}/img.jpg?from=.whatsapp.net` }],
			upload
		)
		assert.equal(uploads, 1, 'the image must actually be uploaded')
		assert.ok(out.url.includes('/dp/488-uploaded'), `expected the uploaded url, got ${out.url}`)
	} finally {
		server.close()
	}
})

test('HB-488 (control): a real WA media hostname passes through without an upload', async () => {
	const [out] = await uploadingNecessaryImages([{ url: 'https://mmg.whatsapp.net/v/t62/real.jpg' }], async () => {
		throw new Error('upload must not run for an already-hosted url')
	})
	assert.equal(out.url, 'https://mmg.whatsapp.net/v/t62/real.jpg')
})
