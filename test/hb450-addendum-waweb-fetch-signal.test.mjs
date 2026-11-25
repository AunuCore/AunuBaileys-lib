// AunuBaileys 2.7.0 — HB-450 addendum: fetchLatestWaWebVersion must
// forward a signal (host-supplied, or a 10s AbortSignal.timeout by
// default) so the fetch losing the handleClientTooOld 10s race is
// aborted instead of dangling. Fails without the fix: the stub fetch
// receives no signal at all when called with {}.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchLatestWaWebVersion } from '../lib/Utils/generics.js'

const withStubFetch = async fn => {
	const calls = []
	const original = globalThis.fetch
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts })
		return {
			ok: true,
			status: 200,
			text: async () => '"client_revision": 999999999'
		}
	}
	try {
		return await fn(calls)
	} finally {
		globalThis.fetch = original
	}
}

test('HB-450 addendum: fetchLatestWaWebVersion({}) passes a default AbortSignal', async () => {
	await withStubFetch(async calls => {
		const result = await fetchLatestWaWebVersion({})
		assert.equal(calls.length, 1)
		assert.ok(calls[0].opts.signal instanceof AbortSignal, 'a signal must reach the fetch call')
		assert.equal(result.isLatest, true)
	})
})

test('HB-450 addendum: a host-supplied signal is forwarded unchanged', async () => {
	await withStubFetch(async calls => {
		const controller = new AbortController()
		await fetchLatestWaWebVersion({ signal: controller.signal })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].opts.signal, controller.signal, 'the host signal must win over the default')
	})
})
