// AunuBaileys 2.9.0 "Last Fix" batch — GROUP A1 (Utils cluster):
// HB-512 (PresenceTracker unguarded emits), HB-141 addendum 1 site 2
// (decodeSyncdPatch mutation deref), HB-325 addendum (rich response
// shape validation), HB-435 addendum facet 6 (parseOrderDetailsNode
// missing <order> child). Each test names the HB item it locks in and
// fails without its fix. Everything runs offline against lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Crypto from 'node:crypto'
import { silentLogger } from './helpers.mjs'
import { waproto } from '../WAProto/index.js'
import { PresenceTracker } from '../lib/Utils/presence-tracker.js'
import { decodeSyncdPatch, encodeSyncdPatch, newLTHashState } from '../lib/Utils/chat-utils.js'
import { prepareRichResponseMessage, toUnified, buildAunuMapMetadata } from '../lib/Utils/rich-message-utils.js'
import { parseOrderDetailsNode } from '../lib/Utils/business.js'

const isBoom = (err, statusCode) => !!err?.isBoom && err.output?.statusCode === statusCode
const boom400 = err => isBoom(err, 400)

// --- HB-512: PresenceTracker emit isolation ---

const ALICE = '6281234567890@s.whatsapp.net'
const BOB = '6289876543210@s.whatsapp.net'

const clock = (start = 1_000_000) => {
	let now = start
	return { now: () => now, advance: ms => { now += ms } }
}

const feed = (tracker, jid, presence) =>
	tracker.ingest({ id: 'chat', presences: { [jid]: { lastKnownPresence: presence } } })

test('HB-512 facet A: a throwing presence.diagnostic listener cannot escape the stale sweep', () => {
	const c = clock()
	const tracker = new PresenceTracker({ logger: silentLogger, staleAfterMs: 60_000, now: c.now })
	tracker.subscribe(ALICE)
	feed(tracker, ALICE, 'available')
	// Register the throwing listener only after setup, so the throw
	// can only surface through the sweep path (the same call the
	// start() setInterval timer makes).
	tracker.on('presence.diagnostic', () => {
		throw new Error('diagnostic listener boom')
	})
	c.advance(61_000)
	let stale
	assert.doesNotThrow(() => {
		stale = tracker.sweepStale()
	}, 'sweepStale must not rethrow a listener error')
	assert.deepEqual(stale, [ALICE], 'the stale contact must still be reported')
	tracker.stop()
})

test('HB-512 facet B: a throwing presence.change listener does not truncate the ingest batch', () => {
	const tracker = new PresenceTracker({ logger: silentLogger, subscribeAll: true })
	// First sightings only open records (presence.change fires on a
	// subsequent, different presence), so prime both contacts first.
	feed(tracker, ALICE, 'available')
	feed(tracker, BOB, 'available')
	tracker.on('presence.change', change => {
		if (change.jid === ALICE) {
			throw new Error('change listener boom')
		}
	})
	assert.doesNotThrow(() =>
		tracker.ingest({
			id: 'chat',
			presences: {
				[ALICE]: { lastKnownPresence: 'composing' },
				[BOB]: { lastKnownPresence: 'composing' }
			}
		})
	)
	assert.equal(tracker.getPresence(ALICE)?.presence, 'composing')
	assert.equal(tracker.getPresence(BOB)?.presence, 'composing', 'the entry after the throwing one must still be processed')
	tracker.stop()
})

// --- HB-141 addendum 1 site 2: decodeSyncdPatch mutation shape ---

const MY_KEY_ID = Buffer.from(Crypto.randomBytes(16)).toString('base64')
const APP_STATE_KEY = {
	keyData: Crypto.randomBytes(32),
	fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
	timestamp: Date.now()
}
const getAppStateSyncKey = async keyId => (keyId === MY_KEY_ID ? APP_STATE_KEY : null)

const buildValidPatch = async () => {
	const { patch, state } = await encodeSyncdPatch(
		{
			type: 'regular',
			index: ['conversation', 'jid-good', 'archive'],
			syncAction: { archiveChatAction: { archived: true } },
			apiVersion: 0,
			operation: waproto.SyncdMutation.SyncdOperation.SET
		},
		MY_KEY_ID,
		newLTHashState(),
		getAppStateSyncKey
	)
	patch.version = { version: state.version }
	return patch
}

test('HB-141 addendum 1 site 2 (control): a valid patch still decodes under validateMacs', async () => {
	const patch = await buildValidPatch()
	const seen = []
	const result = await decodeSyncdPatch(patch, 'regular', newLTHashState(), getAppStateSyncKey, m => seen.push(m.index), true)
	assert.ok(result, 'decodeSyncdPatch must resolve on a valid patch')
	assert.deepEqual(seen, [['conversation', 'jid-good', 'archive']])
})

test('HB-141 addendum 1 site 2: mutations missing record/value/blob never die as a raw TypeError', async () => {
	const SET = waproto.SyncdMutation.SyncdOperation.SET
	const keyId = { id: Buffer.from(MY_KEY_ID, 'base64') }
	const malformed = [
		{ operation: SET },
		{ operation: SET, record: { keyId } },
		{ operation: SET, record: { keyId, value: {} } }
	]
	for (const bad of malformed) {
		const patch = await buildValidPatch()
		const tampered = { ...patch, mutations: [...patch.mutations, bad] }
		// Site-1 behaviour: the malformed mutation is skipped per-item
		// (both when collecting the patch MACs and in the mutation
		// decode itself), the good mutation still applies, and no raw
		// TypeError escapes. Pre-fix this rejected with a TypeError.
		const seen = []
		const result = await decodeSyncdPatch(tampered, 'regular', newLTHashState(), getAppStateSyncKey, m => seen.push(m.index), true)
		assert.ok(result, 'decodeSyncdPatch must resolve with a malformed mutation present')
		assert.deepEqual(seen, [['conversation', 'jid-good', 'archive']], 'the good mutation must still apply')
	}
})

// --- HB-325 addendum: rich response shape validation ---

test('HB-325 addendum: a null richResponse submessage element is Boom 400, not a raw TypeError', () => {
	assert.throws(() => prepareRichResponseMessage({ richResponse: [null] }), boom400)
})

test('HB-325 addendum: richResponse code as a bare string is Boom 400, not a raw TypeError', () => {
	assert.throws(() => prepareRichResponseMessage({ richResponse: [{ code: 'const x = 1' }] }), boom400)
})

test('HB-325 addendum: a null links element is Boom 400, not a raw TypeError', () => {
	assert.throws(() => prepareRichResponseMessage({ links: [null] }), boom400)
})

test('HB-325 addendum: a non-array table is Boom 400, not a raw TypeError', () => {
	assert.throws(() => prepareRichResponseMessage({ table: 'not-a-table' }), boom400)
})

test('HB-325 addendum: a null map annotation element is Boom 400, not a raw TypeError', () => {
	assert.throws(() => buildAunuMapMetadata({ latitude: 1, longitude: 2, annotations: [null] }), boom400)
	assert.throws(() => prepareRichResponseMessage({ map: { latitude: 1, longitude: 2, annotations: [null] } }), boom400)
})

test('HB-325 addendum: toUnified rejects non-array codeBlocks and non-array table rows with Boom 400', () => {
	// RichSubMessageType: CODE = 5, TABLE = 4 (proto numbering in rich-message-utils)
	assert.throws(() => toUnified([{ messageType: 5, codeMetadata: { codeLanguage: 'javascript', codeBlocks: 'nope' } }]), boom400)
	assert.throws(() => toUnified([{ messageType: 4, tableMetadata: { title: 't', rows: 'nope' } }]), boom400)
})

test('HB-325 addendum (control): valid rich content still builds the same shape', () => {
	const rich = prepareRichResponseMessage({
		richResponse: [
			{ text: 'hello' },
			{ code: [{ codeContent: 'x', highlightType: 0 }], language: 'javascript' }
		]
	})
	const subs = rich.richResponseMessage?.submessages
	assert.equal(subs?.length, 2)
	assert.equal(subs[0]?.messageText, 'hello')

	const composed = prepareRichResponseMessage({
		table: [
			['h1', 'h2'],
			['a', 'b']
		],
		links: [{ url: 'https://example.com', text: 'Example' }],
		map: { latitude: -6.2, longitude: 106.8, annotations: [{ latitude: -6.2, longitude: 106.8, title: 'Jakarta' }] }
	})
	const types = (composed.richResponseMessage?.submessages ?? []).map(s => s.messageType)
	assert.ok(types.includes(4), 'control: TABLE submessage missing')
	assert.ok(types.includes(7), 'control: MAP submessage missing')

	const unified = toUnified([{ messageType: 2, messageText: 'hi' }], 'uuid-1')
	assert.equal(unified.sections[0]?.view_model?.primitive?.text, 'hi')
})

// --- HB-435 addendum facet 6: parseOrderDetailsNode missing <order> ---

test('HB-435 addendum facet 6: a result node without an <order> child is Boom 502, not fabricated totals', () => {
	const noOrder = { tag: 'iq', attrs: {}, content: [{ tag: 'error', attrs: {}, content: undefined }] }
	assert.throws(() => parseOrderDetailsNode(noOrder), err => isBoom(err, 502))
	const empty = { tag: 'iq', attrs: {}, content: undefined }
	assert.throws(() => parseOrderDetailsNode(empty), err => isBoom(err, 502))
})

test('HB-435 addendum facet 6 (control): a real order node still parses', () => {
	const leaf = (tag, text) => ({ tag, attrs: {}, content: Buffer.from(text) })
	const node = {
		tag: 'iq',
		attrs: {},
		content: [
			{
				tag: 'order',
				attrs: {},
				content: [
					{
						tag: 'product',
						attrs: {},
						content: [
							leaf('id', 'P1'),
							leaf('name', 'Thing'),
							{ tag: 'image', attrs: {}, content: [leaf('url', 'https://mmg.whatsapp.net/x')] },
							leaf('price', '1500'),
							leaf('currency', 'IDR'),
							leaf('quantity', '2')
						]
					},
					{
						tag: 'price',
						attrs: {},
						content: [leaf('total', '3000'), leaf('currency', 'IDR')]
					}
				]
			}
		]
	}
	const details = parseOrderDetailsNode(node)
	assert.equal(details.price.total, 3000)
	assert.equal(details.price.currency, 'IDR')
	assert.equal(details.products.length, 1)
	assert.equal(details.products[0].id, 'P1')
})
