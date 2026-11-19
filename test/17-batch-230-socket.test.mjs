// AunuBaileys 2.3.0 batch regressions — cluster C (socket/pairing):
// HB-376, HB-315 addendum, HB-382, HB-383 + addendum, HB-386 +
// addendum, HB-389, HB-317 addendum, HB-239 addendum, HB-401.
// Each test names the HB item it locks in and fails without its fix.
// Everything runs offline against the built lib/: the WS connect is
// stubbed out and transports are fakes, so no test touches WA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { lib, makeAuthState, makeOfflineSocket, fakeOpenTransport, silentLogger, sleep, waitFor, endQuietly } from './helpers.mjs'
import { WebSocketClient } from '../lib/Socket/Client/websocket.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { executeWMexQuery } from '../lib/Socket/mex.js'
import { addTransactionCapability } from '../lib/Utils/auth-utils.js'
import { configureSuccessfulPairing } from '../lib/Utils/validate-connection.js'
import { Curve, hmacSign, keyMaterialToBuffer } from '../lib/Utils/crypto.js'
import { WA_ADV_ACCOUNT_SIG_PREFIX } from '../lib/Defaults/index.js'
import { waproto } from '../WAProto/index.js'

// No real connection attempts anywhere in this file: construction
// must never race a dead-port error into end() mid-test.
WebSocketClient.prototype.connect = () => {}

const makeSocket = (state, extra = {}) =>
	lib.makeWASocket({
		auth: state,
		logger: silentLogger,
		waWebSocketUrl: 'ws://127.0.0.1:9/ws/chat',
		connectTimeoutMs: 800,
		defaultQueryTimeoutMs: 800,
		keepAliveIntervalMs: 3_600_000,
		markOnlineOnConnect: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		generateHighQualityLinkPreview: false,
		banSentinel: false,
		browser: ['aunu-230', 'test', '1'],
		...extra
	})

test('HB-376: a sync-throwing host signalRepository.close() cannot abort end() teardown', async () => {
	const unhandled = []
	const onUnhandled = reason => unhandled.push(reason)
	process.on('unhandledRejection', onUnhandled)
	try {
		const throwingRepo = (args, logger, pnFn) => {
			const repo = makeLibSignalRepository(args, logger, pnFn)
			return {
				...repo,
				close: () => {
					throw new Error('boom-close-sync')
				}
			}
		}
		const sock = await makeOfflineSocket({ makeSignalRepository: throwingRepo })
		fakeOpenTransport(sock)
		let closeEmitted = false
		sock.ev.on('connection.update', u => {
			if (u.connection === 'close') closeEmitted = true
		})
		await sock.end(new Error('manual-end'))
		await sleep(200)
		assert.equal(closeEmitted, true, 'the close update must still be emitted')
		assert.equal(sock.ws.isClosed, true, 'the transport must still be closed')
		assert.deepEqual(unhandled, [], 'no rejection may escape end()')
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('HB-376: an async-rejecting host signalRepository.close() produces no unhandled rejection', async () => {
	const unhandled = []
	const onUnhandled = reason => unhandled.push(reason)
	process.on('unhandledRejection', onUnhandled)
	try {
		const rejectingRepo = (args, logger, pnFn) => {
			const repo = makeLibSignalRepository(args, logger, pnFn)
			return {
				...repo,
				close: async () => {
					throw new Error('boom-close-async')
				}
			}
		}
		const sock = await makeOfflineSocket({ makeSignalRepository: rejectingRepo })
		fakeOpenTransport(sock)
		let closeEmitted = false
		sock.ev.on('connection.update', u => {
			if (u.connection === 'close') closeEmitted = true
		})
		await sock.end(new Error('manual-end'))
		await sleep(250)
		assert.equal(closeEmitted, true, 'the close update must still be emitted')
		assert.equal(sock.ws.isClosed, true, 'the transport must still be closed')
		assert.deepEqual(unhandled, [], 'the close() rejection must be caught, not floated')
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('HB-383 + addendum: query() defaults missing/null attrs and rejects non-object attrs with Boom 400', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	try {
		// a get query with no answer settles as resolved-undefined
		// (waitForMessage contract) or as the query-level Boom 408,
		// depending on which of the two 80ms timers fires first —
		// either is correct; a bare TypeError is not
		const settle = p => p.then(value => ({ resolved: value }), err => ({ rejected: err }))
		const assertSettled = (outcome, label) => {
			if ('resolved' in outcome) {
				assert.equal(outcome.resolved, undefined, label)
			} else {
				assert.equal(outcome.rejected?.output?.statusCode, 408, label)
				assert.notEqual(outcome.rejected?.constructor?.name, 'TypeError', label)
			}
		}

		// attrs absent entirely — used to be a bare TypeError
		const noAttrs = { tag: 'iq' }
		assertSettled(await settle(sock.query(noAttrs, 80)), 'no-attrs query must settle as a timeout, not a TypeError')
		assert.equal(typeof noAttrs.attrs.id, 'string', 'an id must have been generated onto the defaulted attrs')

		// attrs: null — the addendum facet (??= covers it, a bare deref does not)
		const nullAttrs = { tag: 'iq', attrs: null }
		assertSettled(await settle(sock.query(nullAttrs, 80)), 'null-attrs query must settle as a timeout, not a TypeError')
		assert.equal(typeof nullAttrs.attrs.id, 'string')

		// attrs: non-object — assigning .id onto a string throws a
		// strict-mode TypeError; the fix rejects it as Boom 400
		const isBoom400 = err => err?.isBoom && err?.output?.statusCode === 400
		await assert.rejects(sock.query({ tag: 'iq', attrs: 'iq' }, 80), isBoom400)
		await assert.rejects(sock.query({ tag: 'iq', attrs: [] }, 80), isBoom400)
		await assert.rejects(sock.query(null, 80), isBoom400)
	} finally {
		endQuietly(sock)
	}
})

test('HB-382: executeWMexQuery turns a null body and null error entries into Boom, never a raw TypeError', async () => {
	const mockQuery = body => async () => ({
		tag: 'iq',
		attrs: { id: 'm1', type: 'result' },
		content: [{ tag: 'result', attrs: {}, content: Buffer.from(body, 'utf-8') }]
	})
	const tag = () => 'tag-1'
	const isBoom = code => err => err?.isBoom && err?.output?.statusCode === code

	// body is the literal `null` — valid JSON, used to throw on data.errors
	await assert.rejects(executeWMexQuery({}, '1', 'xwa2_do_thing', mockQuery('null'), tag), isBoom(400))
	// errors: [null] — used to throw on err.message / firstError.extensions
	await assert.rejects(executeWMexQuery({}, '1', 'xwa2_do_thing', mockQuery('{"errors":[null]}'), tag), isBoom(500))
	// control: a string error entry already degraded to Boom 500
	await assert.rejects(executeWMexQuery({}, '1', 'xwa2_do_thing', mockQuery('{"errors":["oops"]}'), tag), isBoom(500))
	// control: a well-formed server error keeps its message and code
	await assert.rejects(
		executeWMexQuery({}, '1', 'xwa2_do_thing', mockQuery('{"errors":[{"message":"bad thing","extensions":{"error_code":463}}]}'), tag),
		err => err?.isBoom && err?.output?.statusCode === 463 && /bad thing/.test(err.message)
	)
	// control: a well-formed data payload still resolves
	assert.deepEqual(
		await executeWMexQuery({}, '1', 'xwa2_do_thing', mockQuery('{"data":{"xwa2_do_thing":{"ok":true}}}'), tag),
		{ ok: true }
	)
})

test('HB-239 addendum: configureSuccessfulPairing rejects a null keyIndex with Boom but accepts 0', () => {
	const identKp = Curve.generateKeyPair()
	const advSecretKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')
	const acctKp = Curve.generateKeyPair()
	const buildStanza = deviceDetails => {
		const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, identKp.public])
		const accountSignature = Curve.sign(acctKp.private, accountMsg)
		const account = { accountSignatureKey: acctKp.public, accountSignature, details: deviceDetails }
		const details = waproto.ADVSignedDeviceIdentity.encode(account).finish()
		const hmac = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
		const hmacNode = waproto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish()
		return {
			tag: 'iq',
			attrs: { id: 'pair-1', type: 'set' },
			content: [
				{
					tag: 'pair-success',
					attrs: {},
					content: [
						{ tag: 'device-identity', attrs: {}, content: hmacNode },
						{ tag: 'device', attrs: { jid: '6281234567890:12@s.whatsapp.net' } },
						{ tag: 'platform', attrs: { name: 'TestPlatform' } }
					]
				}
			]
		}
	}
	const creds = { advSecretKey, signedIdentityKey: identKp, signalIdentities: [] }

	// no keyIndex at all — protobufjs decodes the field to null;
	// used to die as `TypeError: Cannot read properties of null`
	const noKeyIndex = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000 }).finish()
	assert.throws(
		() => configureSuccessfulPairing(buildStanza(noKeyIndex), creds),
		err => err?.isBoom === true,
		'a missing keyIndex must be a descriptive Boom, not a raw TypeError'
	)

	// keyIndex 0 is legal and must not be treated as missing
	const zero = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 0 }).finish()
	const r0 = configureSuccessfulPairing(buildStanza(zero), creds)
	assert.equal(r0.reply.content[0].content[0].attrs['key-index'], '0')

	const five = waproto.ADVDeviceIdentity.encode({ rawId: 1234567890, timestamp: 1700000000, keyIndex: 5 }).finish()
	const r5 = configureSuccessfulPairing(buildStanza(five), creds)
	assert.equal(r5.reply.content[0].content[0].attrs['key-index'], '5')
})

test('HB-315 addendum: CB:success with creds.me undefined persists no partial me', async () => {
	// socket A: fresh auth state — creds.me is undefined
	const a = await makeAuthState()
	const sockA = makeSocket(a.state)
	let openedA = false
	sockA.ev.on('connection.update', u => {
		if (u.connection === 'open') openedA = true
	})
	sockA.ws.emit('CB:success', { tag: 'success', attrs: { lid: '123456789012345@lid' } })
	assert.equal(await waitFor(() => openedA, 5000), true, 'control: the success handler must reach the open emit')
	assert.equal(a.state.creds.me, undefined, 'no { lid } / {} partial me may be written when me was undefined')
	endQuietly(sockA)

	// socket B (control): a complete me keeps its id and gains the lid
	const b = await makeAuthState()
	b.state.creds.me = { id: '6281234567890@s.whatsapp.net', name: 'Test' }
	const sockB = makeSocket(b.state)
	let openedB = false
	sockB.ev.on('connection.update', u => {
		if (u.connection === 'open') openedB = true
	})
	sockB.ws.emit('CB:success', { tag: 'success', attrs: { lid: '123456789012345@lid' } })
	assert.equal(await waitFor(() => openedB, 5000), true)
	assert.equal(b.state.creds.me.id, '6281234567890@s.whatsapp.net')
	assert.equal(b.state.creds.me.lid, '123456789012345@lid')
	endQuietly(sockB)
})

test('HB-317 addendum: CB:success treats a non-array stored device-list as empty instead of spreading it', async () => {
	const { state } = await makeAuthState()
	state.creds.me = { id: '6281234567890:5@s.whatsapp.net', name: 'Test' }
	await state.keys.set({ 'device-list': { '6281234567890': 'garbage-no-zero' } })
	const sock = makeSocket(state)
	sock.ws.emit('CB:success', { tag: 'success', attrs: { lid: '999888777@lid' } })
	const readList = async () => (await state.keys.get('device-list', ['6281234567890']))['6281234567890']
	assert.equal(await waitFor(async () => Array.isArray(await readList()), 5000), true, 'the union must rewrite the list as an array')
	assert.deepEqual(await readList(), ['5'], 'only the current device may be unioned in — not the characters of the corrupt string')
	endQuietly(sock)
})

test('HB-386 + addendum: a failed uploadPreKeys re-offers the same batch, and end() stops the retry loop', async () => {
	const { dir, state } = await makeAuthState()
	const sock = makeSocket(state, { defaultQueryTimeoutMs: 100 })
	fakeOpenTransport(sock)
	// count the pre-key FILES in the auth dir — the file store's
	// get() reports every requested id (missing ones as empty), so
	// only the directory listing shows what was actually persisted
	const storedIds = () =>
		fs
			.readdirSync(dir)
			.filter(f => f.startsWith('pre-key-'))
			.map(f => f.slice('pre-key-'.length, -'.json'.length))
			.sort((x, y) => +x - +y)
	// the fake transport never answers, so every upload attempt
	// fails on the query timeout; swallow the final rejection
	const upload = sock.uploadPreKeys(5)
	upload.catch(() => {})

	assert.equal(await waitFor(() => state.creds.nextPreKeyId === 6, 5000), true, 'the first batch must be generated')
	await sleep(300)
	assert.equal(state.creds.firstUnuploadedPreKeyId, 1, 'the advertisement pointer must NOT move before the upload lands')
	assert.deepEqual(await storedIds(), ['1', '2', '3', '4', '5'])

	// the first retry fires after a 1s backoff (~1.1s in): it must
	// re-offer the SAME batch — pre-fix it minted ids 6-10 and
	// advanced both counters, orphaning 1-5
	await sleep(1500)
	assert.equal(state.creds.nextPreKeyId, 6, 'a retry must not mint a fresh batch')
	assert.equal(state.creds.firstUnuploadedPreKeyId, 1)
	assert.deepEqual(await storedIds(), ['1', '2', '3', '4', '5'], 'no orphaned or extra pre-keys may appear')

	// end() during the next backoff must stop the loop entirely
	await sock.end(undefined)
	await sleep(2600)
	assert.equal(state.creds.nextPreKeyId, 6, 'no batch may be generated after end()')
	assert.deepEqual(await storedIds(), ['1', '2', '3', '4', '5'])
})

test('HB-401: disposeTransactionStorage releases the transaction storage and is safe to call', async () => {
	const backingData = new Map()
	const backing = {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) {
				const v = backingData.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		set: async data => {
			for (const [type, entries] of Object.entries(data)) {
				for (const [id, value] of Object.entries(entries)) {
					if (value === null) backingData.delete(`${type}:${id}`)
					else backingData.set(`${type}:${id}`, value)
				}
			}
		}
	}
	const wrapped = addTransactionCapability(backing, silentLogger)
	// pre-fix this method did not exist at all — the per-socket
	// AsyncLocalStorage was enabled by the first transaction and
	// never disabled for the life of the process
	assert.equal(typeof wrapped.disposeTransactionStorage, 'function')

	// transactions behave normally before dispose
	let insideTx = null
	await wrapped.transaction(async () => {
		insideTx = wrapped.isInTransaction()
		await wrapped.set({ 'identity-key': { 'addr.1': Buffer.from('identity-1') } })
	}, 'hb401-key')
	assert.equal(insideTx, true)
	assert.equal(backingData.get('identity-key:addr.1')?.toString(), 'identity-1', 'the transaction must commit')
	assert.equal(wrapped.isInTransaction(), false)

	// dispose is idempotent — the second call is a no-op, not a throw
	wrapped.disposeTransactionStorage()
	wrapped.disposeTransactionStorage()

	// behavior is unchanged after dispose: a later transaction
	// still runs and commits (run() re-enables the storage)
	await wrapped.transaction(async () => {
		await wrapped.set({ 'identity-key': { 'addr.2': Buffer.from('identity-2') } })
	}, 'hb401-key')
	assert.equal(backingData.get('identity-key:addr.2')?.toString(), 'identity-2')
})

test('HB-401: end() disposes the socket transaction storage without breaking teardown', async () => {
	const sock = await makeOfflineSocket()
	fakeOpenTransport(sock)
	let closeEmitted = false
	sock.ev.on('connection.update', u => {
		if (u.connection === 'close') closeEmitted = true
	})
	await sock.end(new Error('manual-end'))
	assert.equal(closeEmitted, true, 'teardown must complete with the dispose wired into end()')
	assert.equal(sock.ws.isClosed, true)
})

test('HB-389: pair-success stops the QR chain — no post-pair QR and no QR-refs-ended kill', async () => {
	const { state } = await makeAuthState()
	const sock = makeSocket(state, { qrTimeout: 150, defaultQueryTimeoutMs: 200 })
	fakeOpenTransport(sock)

	// build a fully valid pair-success stanza against this socket's
	// own creds (HMAC + account signature must pass)
	const deviceDetails = waproto.ADVDeviceIdentity.encode({ keyIndex: 0, deviceType: 0 }).finish()
	const acctKp = Curve.generateKeyPair()
	const accountMsg = Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, Buffer.from(deviceDetails), keyMaterialToBuffer(state.creds.signedIdentityKey.public)])
	const accountSignature = Curve.sign(acctKp.private, accountMsg)
	const account = waproto.ADVSignedDeviceIdentity.encode({
		accountSignatureKey: Buffer.from(acctKp.public),
		accountSignature: Buffer.from(accountSignature),
		details: Buffer.from(deviceDetails)
	}).finish()
	const hmac = hmacSign(Buffer.from(account), Buffer.from(state.creds.advSecretKey, 'base64'))
	const deviceIdentityContent = waproto.ADVSignedDeviceIdentityHMAC.encode({ details: Buffer.from(account), hmac: Buffer.from(hmac) }).finish()
	const pairSuccessNode = {
		tag: 'iq',
		attrs: { id: 'ps-1', type: 'set' },
		content: [
			{
				tag: 'pair-success',
				attrs: {},
				content: [
					{ tag: 'device-identity', attrs: {}, content: deviceIdentityContent },
					{ tag: 'platform', attrs: { name: 'Chrome' } },
					{ tag: 'device', attrs: { jid: '6281234567890@s.whatsapp.net', lid: '6281234567890@lid' } }
				]
			}
		]
	}
	assert.doesNotThrow(() => configureSuccessfulPairing(pairSuccessNode, state.creds), 'fixture stanza must be valid')

	let qrCount = 0
	let newLogin = false
	let closedWith = null
	sock.ev.on('connection.update', u => {
		if (u.qr) qrCount++
		if (u.isNewLogin) newLogin = true
		if (u.connection === 'close') closedWith = u.lastDisconnect?.error?.message ?? 'close'
	})

	sock.ws.emit('CB:iq,type:set,pair-device', {
		tag: 'iq',
		attrs: { id: 'pd-1', type: 'set', xmlns: 'md' },
		content: [
			{
				tag: 'pair-device',
				attrs: {},
				content: [
					{ tag: 'ref', attrs: {}, content: Buffer.from('REF-1') },
					{ tag: 'ref', attrs: {}, content: Buffer.from('REF-2') }
				]
			}
		]
	})
	await sleep(50)
	assert.equal(qrCount, 1, 'control: the first QR is emitted before pairing')

	sock.ws.emit('CB:iq,,pair-success', pairSuccessNode)
	// deliberately NO CB:success — pre-fix the chain kept cycling,
	// emitted QR #2 at +150ms and ended the fresh login with
	// 'QR refs attempts ended' when the refs ran out
	await sleep(700)
	assert.equal(newLogin, true, 'control: pairing must have succeeded')
	assert.equal(qrCount, 1, 'no QR may be emitted after pair-success')
	assert.equal(closedWith, null, 'the freshly paired session must not be ended')
	endQuietly(sock)
})
