// 2.1.0 batch: HB-333, HB-334, HB-335, HB-336 + addendum HB-2026-1112-23
// + full-tree sweep fixes (decodeSyncdMutations per-item isolation, mex
// JSON/array guards, jidToSignalProtocolAddress / transferDevice jidDecode
// guards, join-approval stub missing-param guard, baileys-event-stream
// per-line isolation, placeholder-resend timer catch, business cover-photo
// tmp cleanup). Patterns follow 10/11/12 (real socket + fake transport,
// TAG waiters) and the heartbeat harnesses that verified each finding
// empirically (run-0248, run-0250, run-0251, run-0252).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lib, makeOfflineSocket, fakeOpenTransport, waitFor, sleep, endQuietly, silentLogger, tmpDir } from './helpers.mjs'
import { waproto } from '../WAProto/index.js'
import { encodeBinaryNode, decodeBinaryNode } from '../lib/WABinary/index.js'
import { addTransactionCapability, initAuthCreds } from '../lib/Utils/auth-utils.js'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { transferDevice } from '../lib/WABinary/jid-utils.js'
import { executeWMexQuery } from '../lib/Socket/mex.js'
import { decodeSyncdMutations, encodeSyncdPatch, newLTHashState } from '../lib/Utils/chat-utils.js'
import { aesEncrypt, hmacSign } from '../lib/Utils/crypto.js'
import { expandAppStateKeys } from 'whatsapp-rust-bridge'
import processMessage from '../lib/Utils/process-message.js'
import { readAndEmitEventStream } from '../lib/Utils/baileys-event-stream.js'
import { generateLoginNode, generateRegistrationNode } from '../lib/Utils/validate-connection.js'
import { DEFAULT_CONNECTION_CONFIG } from '../lib/Defaults/index.js'
import { getCodeFromWSError } from '../lib/Utils/generics.js'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { makeSocket } from '../lib/Socket/socket.js'

const ME = '628123456789@s.whatsapp.net'
const PEER = '628987654321@s.whatsapp.net'
const ME_LID = '123456789012345@lid'
const PEER_LID = '111222333444555@lid'
const GROUP = '120363012345678@g.us'

const collectUnhandled = () => {
	const list = []
	const fn = err => { list.push(err) }
	process.on('unhandledRejection', fn)
	return { list, stop: () => process.off('unhandledRejection', fn) }
}

const recordingLogger = () => {
	const entries = []
	const logger = {
		level: 'trace',
		entries,
		child() { return logger },
		trace() {}, debug() {}, info() {},
		warn(...args) { entries.push({ level: 'warn', args }) },
		error(...args) { entries.push({ level: 'error', args }) },
		fatal() {}
	}
	return logger
}

/** Decode Noise-framed sent buffers back to binary nodes. */
const decodeSentFrames = async sent => {
	const nodes = []
	for (const buf of sent) {
		let off = 0
		// first frame carries the 4-byte Noise intro header ("WA", 6, x)
		if (buf[0] === 0x57 && buf[1] === 0x41) off = 4
		const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
		nodes.push(await decodeBinaryNode(buf.subarray(off + 3, off + 3 + len)))
	}
	return nodes
}

const plaintextStanza = (from, recipient, id, extraAttrs = {}) => ({
	tag: 'message',
	attrs: { id, from, recipient, t: String(Math.floor(Date.now() / 1000)), type: 'text', ...extraAttrs },
	content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ conversation: 'hi' }).finish() }]
})

const setupSocket = async (t, extra = {}) => {
	const sock = await makeOfflineSocket(extra)
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	// Pre-seed the LID mappings: decryptMessageNode resolves the author's
	// LID via USync on a cache miss, which can never answer offline — a
	// real companion has these cached from history sync.
	await sock.signalRepository.lidMapping.storeLIDPNMappings([
		{ lid: ME_LID, pn: ME },
		{ lid: PEER_LID, pn: PEER }
	])
	const sent = []
	fakeOpenTransport(sock, sent)
	return { sock, sent }
}

const findReceipt = async sent => {
	const nodes = await decodeSentFrames(sent)
	return nodes.find(n => n.tag === 'receipt')
}

// ── HB-333 ──────────────────────────────────────────────────────────

test('HB-333: transactionOpts maxCommitRetries NaN/0/negative still persist (clamped to a finite retry count)', async () => {
	const runTx = async opts => {
		const calls = []
		const store = {
			get: async () => ({}),
			set: async data => { calls.push(data) },
			clear: async () => {}
		}
		const tx = addTransactionCapability(store, silentLogger, opts)
		let threw = null
		try {
			await tx.transaction(async () => {
				await tx.set({ session: { '123@s.whatsapp.net': { record: 'x' } } })
				return 'ok'
			}, 'test-key')
		} catch (e) { threw = e }
		return { calls, threw }
	}

	// Replicates heartbeat run-0248 t0241-txopts.mjs T1–T3: before the fix
	// these silently dropped the mutation (0 store.set calls, no throw).
	for (const bad of [NaN, 0, -5]) {
		const r = await runTx({ maxCommitRetries: bad, delayBetweenTriesMs: 0 })
		assert.equal(r.threw, null, `maxCommitRetries=${bad} must not throw`)
		assert.equal(r.calls.length, 1, `maxCommitRetries=${bad} must persist exactly once`)
	}

	// Controls: 10 and 1 persist exactly once.
	assert.equal((await runTx({ maxCommitRetries: 10, delayBetweenTriesMs: 0 })).calls.length, 1)
	assert.equal((await runTx({ maxCommitRetries: 1, delayBetweenTriesMs: 0 })).calls.length, 1)

	// T6: a flaky store is retried, then persists.
	{
		const calls = []
		let fails = 0
		const flaky = {
			get: async () => ({}),
			set: async data => { if (fails++ < 1) throw new Error('disk busy'); calls.push(data) },
			clear: async () => {}
		}
		const tx = addTransactionCapability(flaky, silentLogger, { maxCommitRetries: 10, delayBetweenTriesMs: 0 })
		await tx.transaction(async () => { await tx.set({ session: { a: 1 } }) }, 'k')
		assert.equal(calls.length, 1, 'flaky store must persist after one retry')
	}
})

test('HB-333: Infinity maxCommitRetries is bounded to 10 attempts, not unbounded', async () => {
	const attempts = []
	const failing = {
		get: async () => ({}),
		set: async () => { attempts.push(1); throw new Error('disk down') },
		clear: async () => {}
	}
	const tx = addTransactionCapability(failing, silentLogger, { maxCommitRetries: Infinity, delayBetweenTriesMs: 0 })
	await assert.rejects(tx.transaction(async () => { await tx.set({ session: { a: 1 } }) }, 'k'))
	assert.equal(attempts.length, 10, 'Infinity must clamp to 10 attempts')
})

// ── HB-334 ──────────────────────────────────────────────────────────

test('HB-334: sender receipt for a fromMe PN 1:1 DM carries the to attribute (== author)', async t => {
	const { sock, sent } = await setupSocket(t)
	sock.ws.emit('CB:message', plaintextStanza(ME, PEER, 'HB334PN'))
	const receipt = await waitFor(async () => findReceipt(sent), 8000).then(ok => (ok ? findReceipt(sent) : null))
	assert.ok(receipt, 'no receipt frame was sent for the fromMe PN DM')
	assert.equal(receipt.attrs.type, 'sender')
	assert.equal(receipt.attrs.recipient, PEER)
	assert.equal(receipt.attrs.to, ME, 'to must be the sending device (author), not absent')
})

test('HB-334 (control): sender receipt for a fromMe LID 1:1 DM still carries to == author', async t => {
	const { sock, sent } = await setupSocket(t)
	sock.ws.emit('CB:message', plaintextStanza(ME_LID, PEER_LID, 'HB334LID', { addressing_mode: 'lid' }))
	const receipt = await waitFor(async () => findReceipt(sent), 8000).then(ok => (ok ? findReceipt(sent) : null))
	assert.ok(receipt, 'no receipt frame was sent for the fromMe LID DM')
	assert.equal(receipt.attrs.type, 'sender')
	assert.equal(receipt.attrs.recipient, PEER_LID)
	assert.equal(receipt.attrs.to, ME_LID)
})

test('HB-334 (control): a delivered receipt for an incoming DM still routes to the peer', async t => {
	const { sock, sent } = await setupSocket(t)
	sock.ws.emit('CB:message', {
		tag: 'message',
		attrs: { id: 'HB334IN', from: PEER, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
		content: [{ tag: 'plaintext', attrs: {}, content: waproto.Message.encode({ conversation: 'hi' }).finish() }]
	})
	const receipt = await waitFor(async () => findReceipt(sent), 8000).then(ok => (ok ? findReceipt(sent) : null))
	assert.ok(receipt, 'no receipt frame was sent for the incoming DM')
	assert.equal(receipt.attrs.to, PEER)
	assert.equal('recipient' in receipt.attrs, false, 'delivered receipts carry no recipient attr')
})

// ── Sweep 1: decodeSyncdMutations per-item isolation ────────────────

const MY_KEY_ID = Buffer.from(Crypto.randomBytes(16)).toString('base64')
const APP_STATE_KEY = {
	keyData: Crypto.randomBytes(32),
	fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
	timestamp: Date.now()
}
const getAppStateSyncKey = async keyId => (keyId === MY_KEY_ID ? APP_STATE_KEY : null)
const syncKeys = () => expandAppStateKeys(APP_STATE_KEY.keyData)

// Replicates chat-utils generateMac (op byte + keyId + data + length,
// HMAC-SHA512 truncated to 32) so hand-built records pass validateMacs.
const valueMac = (operation, encContent, keyIdBytes, valueMacKey) => {
	const opByte = operation === waproto.SyncdMutation.SyncdOperation.SET ? 0x01 : 0x02
	const keyData = new Uint8Array(1 + keyIdBytes.length)
	keyData[0] = opByte
	keyData.set(keyIdBytes, 1)
	const last = new Uint8Array(8)
	last[7] = keyData.length
	const total = new Uint8Array(keyData.length + encContent.length + last.length)
	total.set(keyData, 0)
	total.set(encContent, keyData.length)
	total.set(last, keyData.length + encContent.length)
	return hmacSign(total, valueMacKey, 'sha512').subarray(0, 32)
}

const buildRecord = (syncActionBytes, indexBytes, withMac) => {
	const keys = syncKeys()
	const encContent = aesEncrypt(syncActionBytes, keys.valueEncryptionKey)
	const keyIdBytes = Buffer.from(MY_KEY_ID, 'base64')
	const mac = withMac
		? valueMac(waproto.SyncdMutation.SyncdOperation.SET, encContent, keyIdBytes, keys.valueMacKey)
		: Crypto.randomBytes(32)
	return {
		keyId: { id: keyIdBytes },
		value: { blob: Buffer.concat([encContent, mac]) },
		// record.index.blob is the HMAC of the index under the index key —
		// a random blob fails the validateMacs HMAC check.
		index: { blob: indexBytes ? hmacSign(indexBytes, keys.indexKey) : Crypto.randomBytes(32) }
	}
}

const goodIndex = ['conversation', 'jid-good', 'archive']
const goodIndexBytes = Buffer.from(JSON.stringify(goodIndex))
const goodActionBytes = () => waproto.SyncActionData.encode({ index: goodIndexBytes }).finish()

test('sweep 1: a record with an unparseable SyncActionData index is skipped, the good record still applies', async () => {
	const initial = newLTHashState()
	const bad = buildRecord(waproto.SyncActionData.encode({ index: Buffer.from('not-json{{{') }).finish(), Buffer.from('not-json{{{'), false)
	const good = buildRecord(goodActionBytes(), goodIndexBytes, false)
	const seen = []
	const result = await decodeSyncdMutations(
		[bad, good], initial, getAppStateSyncKey, m => seen.push(m.index), false
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on a bad index')
	assert.deepEqual(seen, [goodIndex])
})

test('sweep 1: a record whose payload is not a SyncActionData is skipped, the good record still applies', async () => {
	const initial = newLTHashState()
	const bad = buildRecord(Buffer.from(Array(16).fill(0xff)), null, false)
	const good = buildRecord(goodActionBytes(), goodIndexBytes, false)
	const seen = []
	const result = await decodeSyncdMutations(
		[bad, good], initial, getAppStateSyncKey, m => seen.push(m.index), false
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on an undecodable payload')
	assert.deepEqual(seen, [goodIndex])
})

test('sweep 1: a throwing onMutation does not abort the patch', async () => {
	const initial = newLTHashState()
	const { record: good1 } = await (async () => {
		const { patch } = await encodeSyncdPatch(
			{ type: 'regular', index: ['conversation', 'jid-1', 'archive'], syncAction: { archiveChatAction: { archived: true } }, apiVersion: 0, operation: waproto.SyncdMutation.SyncdOperation.SET },
			MY_KEY_ID, initial, getAppStateSyncKey
		)
		return { record: patch.mutations[0].record }
	})()
	const { record: good2 } = await (async () => {
		const { patch } = await encodeSyncdPatch(
			{ type: 'regular', index: ['conversation', 'jid-2', 'archive'], syncAction: { archiveChatAction: { archived: true } }, apiVersion: 0, operation: waproto.SyncdMutation.SyncdOperation.SET },
			MY_KEY_ID, initial, getAppStateSyncKey
		)
		return { record: patch.mutations[0].record }
	})()
	const seen = []
	const onMutation = m => {
		if (seen.length === 0 && m.index[1] === 'jid-1') throw new Error('host callback boom')
		seen.push(m.index)
	}
	const result = await decodeSyncdMutations(
		[good1, good2], initial, getAppStateSyncKey, onMutation, true
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on a throwing onMutation')
	assert.equal(seen.length, 1, 'the second good record must still apply')
	assert.equal(seen[0][1], 'jid-2')
})

test('sweep 1: a record without an index is skipped under validateMacs (not a raw deref throw)', async () => {
	const initial = newLTHashState()
	// Control first: the same builder with a valid index must pass the
	// HMAC check, proving the replicated MAC is correct.
	const control = buildRecord(goodActionBytes(), goodIndexBytes, true)
	const seenControl = []
	await decodeSyncdMutations([control], initial, getAppStateSyncKey, m => seenControl.push(m.index), true)
	assert.deepEqual(seenControl, [goodIndex], 'control record with a valid index must apply under validateMacs')

	const noIndex = buildRecord(waproto.SyncActionData.encode({}).finish(), null, true)
	const seen = []
	const result = await decodeSyncdMutations(
		[noIndex], initial, getAppStateSyncKey, m => seen.push(m.index), true
	)
	assert.ok(result, 'decodeSyncdMutations must resolve, not reject, on a missing index')
	assert.deepEqual(seen, [])
})

// ── Sweep 2: mex.ts ─────────────────────────────────────────────────

const mexResult = content => ({
	tag: 'iq',
	attrs: { id: '1', type: 'result' },
	content: [{ tag: 'result', attrs: {}, content }]
})

test('sweep 2: a non-JSON MEX body surfaces as Boom 502, not a raw SyntaxError', async () => {
	const query = async () => mexResult(Buffer.from('not json'))
	await assert.rejects(
		executeWMexQuery({}, '1', 'xwa2_test', query, () => '1'),
		err => {
			assert.ok(err.isBoom, 'must be a Boom error')
			assert.equal(err.output.statusCode, 502)
			return true
		}
	)
})

test('sweep 2: a non-array errors field surfaces as Boom, not a TypeError on .map', async () => {
	const query = async () => mexResult(Buffer.from(JSON.stringify({ errors: 'oops', data: {} })))
	await assert.rejects(
		executeWMexQuery({}, '1', 'xwa2_test', query, () => '1'),
		err => {
			assert.ok(err.isBoom, 'must be a Boom error, not a TypeError')
			return true
		}
	)
})

test('sweep 2 (control): a proper GraphQL errors array still surfaces as Boom 500', async () => {
	const query = async () =>
		mexResult(Buffer.from(JSON.stringify({ errors: [{ message: 'boom', extensions: { error_code: 500 } }], data: {} })))
	await assert.rejects(
		executeWMexQuery({}, '1', 'xwa2_test', query, () => '1'),
		err => {
			assert.ok(err.isBoom)
			assert.equal(err.output.statusCode, 500)
			assert.match(err.message, /GraphQL server error: boom/)
			return true
		}
	)
})

// ── Sweep 3: jidToSignalProtocolAddress ─────────────────────────────

test('sweep 3: jidToSignalProtocolAddress rejects a JID without @ with a clear Error, not a raw TypeError', async () => {
	const dir = tmpDir('aunu-210-repo-')
	const { state } = await lib.useMultiFileAuthState(dir)
	const repo = makeLibSignalRepository(state, silentLogger)
	assert.throws(
		() => repo.jidToSignalProtocolAddress('notajid'),
		/Cannot derive a Signal ProtocolAddress/
	)
	const addr = repo.jidToSignalProtocolAddress(ME)
	assert.equal(addr.toString(), '628123456789.0')
})

// ── Sweep 4: transferDevice ─────────────────────────────────────────

test('sweep 4: transferDevice rejects a toJid without @ with a clear Error, not a raw TypeError', () => {
	assert.throws(() => transferDevice(ME, 'notajid'), /transferDevice: invalid toJid/)
	assert.equal(
		transferDevice('628123456789:5@s.whatsapp.net', PEER),
		'628987654321:5@s.whatsapp.net'
	)
})

// ── Sweep 5: join-approval stub missing-param guard ─────────────────

const stubCtx = () => ({
	shouldProcessHistoryMsg: false,
	placeholderResendCache: {
		get: async () => undefined,
		set: async () => {},
		del: async () => {}
	},
	ev: new EventEmitter(),
	creds: { me: { id: ME }, accountSettings: {} },
	signalRepository: {},
	keyStore: {},
	logger: silentLogger,
	options: {},
	getMessage: async () => undefined
})

const joinApprovalMsg = stubParameters => ({
	key: { remoteJid: GROUP, id: 'STUB1', fromMe: false, participant: PEER },
	messageStubType: waproto.WebMessageInfo.StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
	messageStubParameters: stubParameters,
	messageTimestamp: Math.floor(Date.now() / 1000)
})

test('sweep 5: a join-approval-request stub without parameters is skipped, not a JSON.parse throw', async () => {
	// No messageStubParameters at all (history-sync shape).
	await processMessage(joinApprovalMsg(undefined), stubCtx())
	// Present-but-garbage parameters are skipped too.
	await processMessage(joinApprovalMsg(['not-json{{{']), stubCtx())
})

test('sweep 5 (control): a well-formed join-approval-request stub still emits group.join-request', async () => {
	const ctx = stubCtx()
	const emitted = []
	ctx.ev.on('group.join-request', data => emitted.push(data))
	await processMessage(
		joinApprovalMsg([JSON.stringify({ lid: PEER_LID, pn: PEER }), 'created', 'non_admin_add']),
		ctx
	)
	assert.equal(emitted.length, 1)
	assert.equal(emitted[0].participant, PEER_LID)
	assert.equal(emitted[0].participantPn, PEER)
	assert.equal(emitted[0].action, 'created')
})

// ── Sweep 6: baileys-event-stream per-line isolation ────────────────

test('sweep 6: a corrupt line in a replay file is skipped, the good lines still emit', async () => {
	const dir = tmpDir('aunu-210-stream-')
	const file = path.join(dir, 'events.log')
	fs.writeFileSync(file, [
		JSON.stringify({ event: 'a', data: 1 }),
		'{bad json',
		JSON.stringify({ event: 'b', data: 2 })
	].join('\n'))
	const { ev, task } = readAndEmitEventStream(file)
	const got = []
	ev.on('a', d => got.push(['a', d]))
	ev.on('b', d => got.push(['b', d]))
	await task
	assert.deepEqual(got, [['a', 1], ['b', 2]])
})

test('sweep 6: a throwing replay listener does not abort the replay', async () => {
	const dir = tmpDir('aunu-210-stream-')
	const file = path.join(dir, 'events.log')
	fs.writeFileSync(file, [
		JSON.stringify({ event: 'a', data: 1 }),
		JSON.stringify({ event: 'b', data: 2 })
	].join('\n'))
	const { ev, task } = readAndEmitEventStream(file)
	const got = []
	ev.on('a', () => { throw new Error('listener boom') })
	ev.on('b', d => got.push(['b', d]))
	await task
	assert.deepEqual(got, [['b', 2]])
})

// ── Sweep 7: placeholder-resend timer ───────────────────────────────

test('sweep 7: a rejecting retry cache in the placeholder-resend timer is caught and logged, never an unhandled rejection', async t => {
	const logger = recordingLogger()
	const unhandled = collectUnhandled()
	t.after(() => unhandled.stop())
	// get() succeeds for the two request-time calls, then rejects — the
	// timer-time call (3rd) is the one the fix guards.
	const store = new Map()
	let gets = 0
	const cache = {
		get: async id => {
			gets++
			if (gets >= 3) throw new Error('cache down')
			return store.get(id)
		},
		set: async (id, v) => { store.set(id, v) },
		del: async id => { store.delete(id) }
	}
	const sock = await makeOfflineSocket({ logger, placeholderResendCache: cache })
	t.after(() => endQuietly(sock))
	sock.authState.creds.me = { id: ME, lid: ME_LID }
	fakeOpenTransport(sock, [])
	// The PDO send is expected to fail offline (relay to self needs a
	// session) — the 8 s timer is armed before the send either way.
	await sock.requestPlaceholderResend({ remoteJid: PEER, id: 'PH1', fromMe: false }).catch(() => {})
	assert.ok(
		await waitFor(
			() => logger.entries.some(e => e.level === 'warn' && String(e.args[1]).includes('failed to check placeholder resend cache')),
			15000
		),
		'the timer-time cache failure was never logged (timer did not fire or the catch is missing)'
	)
	assert.deepEqual(unhandled.list.map(String), [], 'an unhandled rejection escaped the timer')
})

// ── Sweep 8: business cover-photo tmp cleanup ───────────────────────

test('sweep 8: a failed cover-photo upload does not leak the tmp file', async t => {
	const { sock } = await setupSocket(t)
	const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('biz-cover-photo')))
	// The offline socket has no mediaConn: refreshMediaConn times out on
	// its query, so waUploadToServer throws and the tmp file must be
	// removed by the try/finally.
	await assert.rejects(sock.updateCoverPhoto(Buffer.from('fake-image-bytes')))
	const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('biz-cover-photo'))
	assert.deepEqual(
		after.filter(n => !before.has(n)),
		[],
		'the failed upload leaked a tmp file'
	)
})

// ── HB-335 ──────────────────────────────────────────────────────────

const PN = '6281234567890@s.whatsapp.net'
const HOSTED_LID = '123456789012345@hosted.lid'
const HOSTED_PN = '6281234567890@hosted'

test('HB-335: generateLoginNode tolerates an undefined browser/version (falls back to the bundled defaults)', () => {
	const loginUndefinedBrowser = generateLoginNode(PN, { ...DEFAULT_CONNECTION_CONFIG, browser: undefined })
	assert.equal(loginUndefinedBrowser.userAgent.appVersion.primary, 2)
	assert.equal(loginUndefinedBrowser.userAgent.platform, waproto.ClientPayload.UserAgent.Platform.WEB)
	const loginUndefinedVersion = generateLoginNode(PN, { ...DEFAULT_CONNECTION_CONFIG, version: undefined })
	assert.equal(loginUndefinedVersion.userAgent.appVersion.primary, 2)
	assert.equal(loginUndefinedVersion.userAgent.appVersion.secondary, 3000)
	assert.equal(loginUndefinedVersion.userAgent.appVersion.tertiary, 1043857760)
})

test('HB-335 (control): generateLoginNode with the defaults and with a valid custom browser/version', () => {
	const control = generateLoginNode(PN, { ...DEFAULT_CONNECTION_CONFIG })
	assert.equal(control.userAgent.appVersion.primary, 2)
	// Valid custom values flow through untouched - the boundary only
	// replaces invalid ones.
	const custom = generateLoginNode(PN, {
		...DEFAULT_CONNECTION_CONFIG,
		browser: ['AunuTest', 'Firefox', '1.0'],
		version: [2, 3000, 999]
	})
	assert.deepEqual(
		{
			primary: custom.userAgent.appVersion.primary,
			secondary: custom.userAgent.appVersion.secondary,
			tertiary: custom.userAgent.appVersion.tertiary
		},
		{ primary: 2, secondary: 3000, tertiary: 999 }
	)
	assert.equal(custom.userAgent.platform, waproto.ClientPayload.UserAgent.Platform.WEB)
	const android = generateLoginNode(PN, { ...DEFAULT_CONNECTION_CONFIG, browser: ['X', 'Android', ''] })
	assert.equal(android.userAgent.platform, waproto.ClientPayload.UserAgent.Platform.ANDROID)
})

test('HB-335: generateRegistrationNode tolerates an undefined/short browser and an undefined version', () => {
	const creds = initAuthCreds()
	// The companion DeviceProps are encoded into devicePairingData.deviceProps -
	// decode them back to observe which browser the node carries.
	const regOs = node => waproto.DeviceProps.decode(node.devicePairingData.deviceProps).os
	const noBrowser = generateRegistrationNode(creds, { ...DEFAULT_CONNECTION_CONFIG, browser: undefined })
	assert.equal(regOs(noBrowser), 'Chrome')
	const noVersion = generateRegistrationNode(creds, { ...DEFAULT_CONNECTION_CONFIG, version: undefined })
	assert.equal(regOs(noVersion), 'Mac OS')
	const shortBrowser = generateRegistrationNode(creds, { ...DEFAULT_CONNECTION_CONFIG, browser: ['Ubuntu'] })
	assert.equal(regOs(shortBrowser), 'Ubuntu')
	const custom = generateRegistrationNode(creds, { ...DEFAULT_CONNECTION_CONFIG, browser: ['AunuTest', 'Firefox', '1.0'] })
	assert.equal(regOs(custom), 'AunuTest')
})

test('HB-335: makeSocket tolerates an undefined browser/version (harness T7-T9)', async t => {
	const authState = { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } }
	const noBrowser = makeSocket({ ...DEFAULT_CONNECTION_CONFIG, browser: undefined, auth: authState, waWebSocketUrl: 'wss://127.0.0.1:9' })
	t.after(() => endQuietly(noBrowser))
	assert.equal(noBrowser.type, 'md')
	const noVersion = makeSocket({ ...DEFAULT_CONNECTION_CONFIG, version: undefined, auth: authState, waWebSocketUrl: 'wss://127.0.0.1:9' })
	t.after(() => endQuietly(noVersion))
	assert.equal(noVersion.type, 'md')
	const control = makeSocket({ ...DEFAULT_CONNECTION_CONFIG, auth: authState, waWebSocketUrl: 'wss://127.0.0.1:9' })
	t.after(() => endQuietly(control))
	assert.equal(control.type, 'md')
})

test('HB-335: makeWASocket sanitises a poisoned browser/version at the boundary instead of throwing', async t => {
	// Before the fix, browser=undefined threw synchronously in makeSocket
	// (browser[1] deref) and version=undefined threw in the ws 'open'
	// handler on every boot (reconnect loop). Each variant must construct.
	for (const extra of [
		{ browser: undefined },
		{ version: undefined },
		{ browser: ['Ubuntu'] },
		{ browser: 'not-an-array' },
		{ browser: [1, 2, 3] },
		{ version: [2, 3000] },
		{ version: ['2', 3000, 1] },
		{ version: [2, 3000, NaN] },
		{ version: [2, 3000, Infinity] }
	]) {
		const sock = await makeOfflineSocket(extra)
		t.after(() => endQuietly(sock))
		assert.equal(sock.type, 'md')
	}
	// A valid custom browser/version still constructs.
	const custom = await makeOfflineSocket({ browser: ['AunuTest', 'Firefox', '1.0'], version: [2, 3000, 999] })
	t.after(() => endQuietly(custom))
	assert.equal(custom.type, 'md')
})

// ── Addendum HB-2026-1112-23 ────────────────────────────────────────

test('addendum HB-2026-1112-23: getCodeFromWSError tolerates a numeric error.code', () => {
	// Before the fix, (error as any)?.code?.startsWith('E') threw a
	// TypeError when code was a NUMBER (e.g. a websocket close code).
	assert.equal(getCodeFromWSError({ code: 1006 }), 500)
	assert.equal(getCodeFromWSError({ code: 0 }), 500)
	assert.equal(getCodeFromWSError({ code: 'ENOTFOUND' }), 408)
	assert.equal(getCodeFromWSError(new Error('Timed Out')), 408)
	assert.equal(getCodeFromWSError(new Error('Unexpected server response: 500')), 500)
})

// ── HB-336 ──────────────────────────────────────────────────────────

/** In-memory key store shaped like the run-0252 harness (records set calls). */
const makeLidKeyStore = (seed = {}) => {
	const db = { ...seed }
	const sets = []
	return {
		db,
		sets,
		async get(type, ids) {
			const out = {}
			for (const id of ids) if (db[type]?.[id] !== undefined) out[id] = db[type][id]
			return out
		},
		async set(data) {
			sets.push(JSON.parse(JSON.stringify(data)))
			for (const [type, dict] of Object.entries(data)) {
				db[type] = db[type] || {}
				for (const [id, v] of Object.entries(dict)) {
					if (v === null) delete db[type][id]
					else db[type][id] = v
				}
			}
		},
		async transaction(fn) { return fn() }
	}
}

test('HB-336: a hosted LID-PN pair is stored and reverse-resolves (harness T1)', async () => {
	const keys = makeLidKeyStore()
	const logger = recordingLogger()
	const map = new LIDMappingStore(keys, logger)
	await map.storeLIDPNMappings([{ lid: HOSTED_LID, pn: HOSTED_PN }])
	assert.equal(keys.sets.filter(s => s['lid-mapping']).length, 1, 'the hosted pair was never persisted')
	assert.equal(await map.getPNForLID(HOSTED_LID), '6281234567890:0@hosted')
	assert.equal(
		logger.entries.some(e => String(e.args[0]).includes('Invalid LID-PN mapping')),
		false,
		'the hosted pair was still rejected as invalid'
	)
})

test('HB-336 (control): a plain LID-PN pair still stores and resolves both ways (harness T2)', async () => {
	const keys = makeLidKeyStore()
	const map = new LIDMappingStore(keys, recordingLogger())
	await map.storeLIDPNMappings([{ lid: ME_LID, pn: ME }])
	assert.equal(await map.getPNForLID(ME_LID), '628123456789:0@s.whatsapp.net')
	assert.equal(await map.getLIDForPN(ME), '123456789012345@lid')
})

test('HB-336: reverse lookup does not skip a hosted LID whose reverse key is in the store (harness T3)', async () => {
	const keys = makeLidKeyStore({ 'lid-mapping': { '123456789012345_reverse': '6281234567890' } })
	const map = new LIDMappingStore(keys, recordingLogger())
	assert.deepEqual(
		await map.getPNsForLIDs([HOSTED_LID]),
		[{ lid: HOSTED_LID, pn: '6281234567890:0@hosted' }]
	)
	const controlKeys = makeLidKeyStore({ 'lid-mapping': { '123456789012345_reverse': '6281234567890' } })
	const control = new LIDMappingStore(controlKeys, recordingLogger())
	assert.deepEqual(
		await control.getPNsForLIDs([ME_LID]),
		[{ lid: ME_LID, pn: '6281234567890:0@s.whatsapp.net' }]
	)
})

test('HB-336: a hosted PN resolves once via USync, persists, and does not re-fetch (harness T4)', async () => {
	let usyncCalls = 0
	const keys = makeLidKeyStore()
	const map = new LIDMappingStore(keys, recordingLogger(), async jids => {
		usyncCalls++
		return jids.map(pn => ({ pn, lid: HOSTED_LID }))
	})
	assert.equal(await map.getLIDForPN(HOSTED_PN), '123456789012345@hosted.lid')
	assert.equal(usyncCalls, 1)
	assert.equal(keys.sets.filter(s => s['lid-mapping']).length, 1, 'the USync result was never persisted')
	assert.equal(await map.getLIDForPN(HOSTED_PN), '123456789012345@hosted.lid')
	assert.equal(usyncCalls, 1, 'the second call re-fetched via USync instead of using the cache')
})

// ── Addendum HB-273 (third site) ────────────────────────────────────

// Child script mirroring the run-0254 harness: calls the REAL
// uploadingNecessaryImages with a slow input stream. Exit 0 = OK,
// exit 1 = UNCAUGHT (the bug), exit 2 = unhandled rejection,
// exit 3 = clean rejection (the fix: the caller sees the error).
const HB273_CHILD = `
import { Readable } from 'node:stream'
import { uploadingNecessaryImages } from '__LIB__'

process.on('uncaughtException', err => {
	console.log('UNCAUGHT: ' + (err && err.message))
	process.exit(1)
})
process.on('unhandledRejection', err => {
	console.log('UNHANDLED-REJECTION: ' + (err && err.message))
	process.exit(2)
})

const slowStream = () => {
	let n = 0
	return Readable.from(
		(async function* () {
			while (n < 5) {
				n++
				await new Promise(r => setTimeout(r, 60))
				yield Buffer.alloc(1024, 0x78)
			}
		})()
	)
}

const stubUpload = async () => ({ directPath: '/x/y.jpg' })

try {
	const res = await uploadingNecessaryImages([{ stream: slowStream() }], stubUpload)
	console.log('OK: ' + JSON.stringify(res))
	process.exit(0)
} catch (err) {
	console.log('REJECTED: ' + (err && err.message))
	process.exit(3)
}
`

const runHb273Child = tmpdirValue => new Promise(resolve => {
	const dir = tmpDir('aunu-p8-hb273-')
	const childFile = path.join(dir, 'child.mjs')
	const libBusiness = fileURLToPath(new URL('../lib/Utils/business.js', import.meta.url))
	fs.writeFileSync(childFile, HB273_CHILD.replaceAll('__LIB__', libBusiness))
	const child = spawn('node', [childFile], { env: { ...process.env, TMPDIR: tmpdirValue } })
	let out = ''
	child.stdout.on('data', d => (out += d))
	child.stderr.on('data', d => (out += d))
	const timer = setTimeout(() => {
		child.kill('SIGKILL')
		resolve({ code: 'TIMEOUT-HANG', out })
	}, 15000)
	child.on('close', code => {
		clearTimeout(timer)
		resolve({ code, out: out.trim() })
	})
})

test('addendum HB-273: a failed tmp write stream rejects instead of crashing the process (bad TMPDIR)', async () => {
	const bad = await runHb273Child('/tmp/does-not-exist-hb273-210')
	assert.equal(bad.code, 3, `expected a clean rejection (exit 3), got exit ${bad.code}: ${bad.out}`)
	assert.match(bad.out, /REJECTED: ENOENT/)
	assert.doesNotMatch(bad.out, /UNCAUGHT/)
})

test('addendum HB-273 (control): the same upload succeeds with a good TMPDIR', async () => {
	const good = await runHb273Child(os.tmpdir())
	assert.equal(good.code, 0, `expected exit 0, got ${good.code}: ${good.out}`)
	assert.match(good.out, /^OK: /)
})
