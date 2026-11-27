// Group B2 — batch 2.8.0: HB-505 (+ facets 1-7), HB-506, HB-507
// (+ facet 1), HB-508 (+ facets 1-3), HB-509, HB-510.
// Each test names the item it locks in and fails without its fix.
// Everything runs offline against the built lib/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lib, makeOfflineSocket, fakeOpenTransport, silentLogger, endQuietly } from './helpers.mjs'
import {
	isJidMetaAI,
	isPnUser,
	isLidUser,
	isJidBroadcast,
	isJidGroup,
	isJidNewsletter,
	isHostedPnUser,
	isHostedLidUser,
	isJidBot,
	encodeBinaryNode,
	decodeBinaryNode
} from '../lib/WABinary/index.js'
import { extractLIDPairsFromKey } from '../lib/Utils/lid-store.js'
import { chatModificationToAppPatch } from '../lib/Utils/chat-utils.js'
import { generateWAMessageFromContent } from '../lib/Utils/messages.js'
import { PresenceTracker } from '../lib/Utils/presence-tracker.js'
import makeOrderedDictionary from '../lib/Store/make-ordered-dictionary.js'
import { KeyedDB } from '../lib/Store/keyed-db.js'

const ME = '628123456789@s.whatsapp.net'
const GROUP = '120363123456789012@g.us'
const NON_STRINGS = [123, {}, true, ['x@s.whatsapp.net']]

// ── HB-505 (induk) ───────────────────────────────────────────────────
// The nine JID predicates used jid?.endsWith(...) / jid.split(...):
// optional chaining only guards null/undefined, so a truthy
// non-string threw a raw TypeError. They must answer false instead.
test('HB-505: JID predicates return false (never throw) for non-string input', () => {
	const predicates = [
		isJidMetaAI,
		isPnUser,
		isLidUser,
		isJidBroadcast,
		isJidGroup,
		isJidNewsletter,
		isHostedPnUser,
		isHostedLidUser,
		isJidBot
	]
	for (const predicate of predicates) {
		for (const bad of NON_STRINGS) {
			assert.equal(predicate(bad), false, `${predicate.name}(${String(bad)}) must be false`)
		}

		assert.equal(predicate(null), false)
		assert.equal(predicate(undefined), false)
		assert.equal(predicate(''), false)
	}
})

test('HB-505: JID predicates still classify valid string JIDs', () => {
	assert.equal(isPnUser(ME), true)
	assert.equal(isLidUser('123456@lid'), true)
	assert.equal(isJidGroup(GROUP), true)
	assert.equal(isJidBroadcast('status@broadcast'), true)
	assert.equal(isJidNewsletter('120363000000000000@newsletter'), true)
	assert.equal(isHostedPnUser('123@hosted'), true)
	assert.equal(isHostedLidUser('123@hosted.lid'), true)
	assert.equal(isJidMetaAI('13135550002@bot'), true)
	assert.equal(isJidBot('13135550002@c.us'), true)
	assert.equal(isJidGroup(ME), false)
	assert.equal(isPnUser(GROUP), false)
})

// ── HB-505 facet 1: extractLIDPairsFromKey ───────────────────────────
test('HB-505 f1: extractLIDPairsFromKey tolerates non-string key fields', () => {
	assert.deepEqual(extractLIDPairsFromKey({ remoteJid: 123, remoteJidAlt: '999@lid' }), [])
	assert.deepEqual(extractLIDPairsFromKey({ remoteJid: ME, participant: {}, participantAlt: '999@lid' }), [])
	assert.deepEqual(extractLIDPairsFromKey({ remoteJid: ME, senderLid: true, senderPn: ME }), [])
	// control: a genuine PN/LID pair is still learned
	const pairs = extractLIDPairsFromKey({ remoteJid: ME, remoteJidAlt: '999888@lid' })
	assert.deepEqual(pairs, [[ME, '999888@lid']])
})

// ── HB-505 facet 2: getMessageRange via chatModificationToAppPatch ───
test('HB-505 f2: chatModificationToAppPatch tolerates a non-string remoteJid in lastMessages', () => {
	const patch = chatModificationToAppPatch(
		{
			archive: true,
			lastMessages: [{ key: { id: 'M1', remoteJid: 123, fromMe: true }, messageTimestamp: 10 }]
		},
		ME
	)
	assert.ok(patch?.syncAction?.archiveChatAction, 'patch must still be built')
	// control: a group message without participant still Boom 400s
	assert.throws(
		() =>
			chatModificationToAppPatch(
				{
					archive: true,
					lastMessages: [{ key: { id: 'M1', remoteJid: GROUP, fromMe: false }, messageTimestamp: 10 }]
				},
				GROUP
			),
		err => err?.isBoom && err.output?.statusCode === 400
	)
})

// ── HB-505 facets 3/5/induk + HB-505 f5 unit: sendMessage paths ──────
const notRawTypeError = err => !(err instanceof TypeError)

test('HB-505 induk+f5: sendMessage with a non-string jid rejects with a Boom, not a raw TypeError', async () => {
	const sock = await makeOfflineSocket({})
	try {
		await assert.rejects(sock.sendMessage(123, { disappearingMessagesInChat: true }), notRawTypeError)
		await assert.rejects(sock.sendMessage(123, { text: 'hello' }), notRawTypeError)
	} finally {
		endQuietly(sock)
	}
})

test('HB-505 f3: sendMessage delete branch tolerates a non-string remoteJid', async () => {
	const sock = await makeOfflineSocket({})
	try {
		await assert.rejects(
			sock.sendMessage(ME, { delete: { remoteJid: 123, fromMe: true, id: 'M1' } }),
			notRawTypeError
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-505 f5: generateWAMessageFromContent tolerates a non-string jid', () => {
	const msg = generateWAMessageFromContent(123, { conversation: 'halo' }, {})
	assert.ok(msg?.key, 'message must still be generated')
	assert.ok(msg.key.remoteJid, 'the generated key must carry a remoteJid')
})

// ── HB-505 facet 4: sock.onWhatsApp ──────────────────────────────────
test('HB-505 f4: onWhatsApp skips non-string entries instead of dying on jid.replace', async () => {
	const sock = await makeOfflineSocket({})
	try {
		const result = await sock.onWhatsApp(123, {}, true)
		assert.deepEqual(result, [], 'all-non-string input must resolve to an empty result without a query')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-505 facet 6: sendReceipt type 'sender' ────────────────────────
test('HB-505 f6: sendReceipt sender-type tolerates a non-string jid', async () => {
	const sock = await makeOfflineSocket({})
	try {
		const sent = []
		fakeOpenTransport(sock, sent)
		// pre-fix: isPnUser(123) threw TypeError before any node was built
		await sock.sendReceipt(123, undefined, ['M1'], 'sender')
		assert.equal(sent.length, 1, 'the receipt node must still be sent')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-505 facet 7: assertSessions filter ────────────────────────────
test('HB-505 f7: assertSessions with a non-string jid never dies in the JID predicates', async () => {
	const sock = await makeOfflineSocket({})
	try {
		// post-fix the entry flows past the isPnUser/isLidUser filters and
		// the fetch fails on the dead transport (Boom), never a TypeError
		await assert.rejects(sock.assertSessions([123], true), notRawTypeError)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-506: PresenceTracker subscribed cap ───────────────────────────
test('HB-506: subscribeAll auto-subscriptions are capped at maxContacts', () => {
	const tracker = new PresenceTracker({ logger: silentLogger, subscribeAll: true, maxContacts: 3, staleAfterMs: 0 })
	for (let i = 0; i < 6; i++) {
		tracker.ingest({
			id: ME,
			presences: { [`user${i}@s.whatsapp.net`]: { lastKnownPresence: 'available', lastSeen: 100 + i } }
		})
	}

	assert.ok(tracker.subscribedJids().length <= 3, `subscribed grew past the cap: ${tracker.subscribedJids()}`)
	assert.ok(tracker.getAllPresences().length <= 3, 'contacts must stay capped too')
	// the most recent contact is the one retained
	assert.ok(tracker.subscribedJids().includes('user5@s.whatsapp.net'))
	tracker.stop()
})

test('HB-506: explicit subscribe() is capped at maxContacts too', () => {
	const tracker = new PresenceTracker({ logger: silentLogger, maxContacts: 2, staleAfterMs: 0 })
	tracker.subscribe('a@s.whatsapp.net')
	tracker.subscribe('b@s.whatsapp.net')
	tracker.subscribe('c@s.whatsapp.net')
	assert.ok(tracker.subscribedJids().length <= 2, `subscribed grew past the cap: ${tracker.subscribedJids()}`)
	assert.ok(tracker.subscribedJids().includes('c@s.whatsapp.net'))
	tracker.stop()
})

// ── HB-507: ordered dictionary prototype pollution ───────────────────
test('HB-507: ordered dictionary get/updateAssign cannot reach Object.prototype', () => {
	const dict = makeOrderedDictionary(item => item.key.id)
	assert.equal(dict.get('__proto__'), undefined, 'pre-fix get returned Object.prototype itself')
	assert.equal(dict.get('constructor'), undefined)
	assert.equal(dict.updateAssign('__proto__', { polluted507: 'yes' }), false)
	assert.equal(dict.updateAssign('constructor', { polluted507: 'yes' }), false)
	assert.equal({}.polluted507, undefined, 'Object.prototype must stay clean')
	assert.equal(Object.prototype.polluted507, undefined)
})

test('HB-507: a message actually stored under the id __proto__ round-trips safely', () => {
	const dict = makeOrderedDictionary(item => item.key.id)
	const item = { key: { id: '__proto__', remoteJid: ME }, message: { conversation: 'x' } }
	dict.upsert(item, 'append')
	assert.equal(dict.get('__proto__'), item, 'the stored item itself must come back, not Object.prototype')
	assert.equal(dict.updateAssign('__proto__', { status: 3 }), true)
	assert.equal(item.status, 3)
	assert.equal({}.status, undefined, 'the assign must land on the item, not Object.prototype')
	assert.equal(dict.remove(item), true)
	assert.equal(dict.get('__proto__'), undefined)
})

test('HB-507: normal ordered-dictionary behaviour is unchanged', () => {
	const dict = makeOrderedDictionary(item => item.key.id)
	const a = { key: { id: 'A' }, v: 1 }
	const b = { key: { id: 'B' }, v: 2 }
	dict.upsert(a, 'append')
	dict.upsert(b, 'prepend')
	assert.deepEqual(dict.array.map(i => i.key.id), ['B', 'A'])
	assert.equal(dict.updateAssign('A', { v: 10 }), true)
	assert.equal(dict.get('A').v, 10)
	dict.filter(i => i.key.id !== 'B')
	assert.deepEqual(dict.array.map(i => i.key.id), ['A'])
	dict.clear()
	assert.equal(dict.get('A'), undefined)
	assert.equal(dict.array.length, 0)
})

// ── HB-507 facet 1: store reaction / receipt handlers + loadMessage ──
test('HB-507 f1: store reaction + receipt handlers with id __proto__ do not pollute Object.prototype', async () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('messages.upsert', {
		type: 'append',
		messages: [{ key: { id: 'REAL1', remoteJid: ME, fromMe: false }, messageTimestamp: 10, message: { conversation: 'x' } }]
	})
	ev.emit('messages.reaction', [{ key: { id: '__proto__', remoteJid: ME }, reaction: { text: 'x', key: { id: '__proto__', remoteJid: ME } } }])
	ev.emit('message-receipt.update', [{ key: { id: '__proto__', remoteJid: ME }, receipt: { userJid: ME, status: 3 } }])
	ev.emit('messages.update', [{ key: { id: '__proto__', remoteJid: ME }, update: { polluted507f1: 'yes' } }])
	assert.equal({}.polluted507f1, undefined, 'Object.prototype must stay clean')
	assert.equal(Object.prototype.polluted507f1, undefined)
	assert.equal(await store.loadMessage(ME, '__proto__'), undefined, 'no stored message may materialise under __proto__')
	const real = await store.loadMessage(ME, 'REAL1')
	assert.equal(real?.message?.conversation, 'x', 'the real message must be untouched')
})

// ── HB-508: encoder malformed frame on non-string attrs ──────────────
test('HB-508: encodeBinaryNode drops non-string attrs instead of emitting a malformed frame', async () => {
	const node = { tag: 'iq', attrs: { to: ME, count: 5, flag: true, obj: { x: 1 } }, content: undefined }
	const decoded = await decodeBinaryNode(encodeBinaryNode(node))
	assert.equal(decoded.tag, 'iq')
	assert.deepEqual(decoded.attrs, { to: ME }, 'only the string attr may survive the round-trip')
})

test('HB-508 f1: numeric business-hours style attrs round-trip cleanly', async () => {
	const node = {
		tag: 'business_profile',
		attrs: { v: '3' },
		content: [
			{
				tag: 'business_hours',
				attrs: { timezone: 'Asia/Jakarta' },
				content: [{ tag: 'business_hours_config', attrs: { day_of_week: 1, mode: 'open_24h', open_time: 800, close_time: 1700 } }]
			}
		]
	}
	const decoded = await decodeBinaryNode(encodeBinaryNode(node))
	const config = decoded.content[0].content[0]
	assert.equal(config.tag, 'business_hours_config')
	assert.deepEqual(config.attrs, { mode: 'open_24h' }, 'numeric hours must be dropped, the frame must stay parseable')
})

test('HB-508 f2: numeric list-item id in a receipt round-trips cleanly', async () => {
	const node = {
		tag: 'receipt',
		attrs: { id: 'M1', to: ME, type: 'read' },
		content: [{ tag: 'list', attrs: {}, content: [{ tag: 'item', attrs: { id: 123 } }, { tag: 'item', attrs: { id: 'M2' } }] }]
	}
	const decoded = await decodeBinaryNode(encodeBinaryNode(node))
	const items = decoded.content[0].content
	assert.equal(items.length, 2)
	assert.deepEqual(items[0].attrs, {})
	assert.deepEqual(items[1].attrs, { id: 'M2' })
})

test('HB-508 f3: a non-string host value in the to attr is dropped, frame stays valid', async () => {
	const node = { tag: 'iq', attrs: { to: 12345, type: 'get', xmlns: 'w:g2' }, content: undefined }
	const decoded = await decodeBinaryNode(encodeBinaryNode(node))
	assert.deepEqual(decoded.attrs, { type: 'get', xmlns: 'w:g2' })
})

// ── HB-509: multi-chat messages.delete ───────────────────────────────
test('HB-509: one consolidated messages.delete removes keys from EVERY chat, not just keys[0]', async () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	const chatB = '222@s.whatsapp.net'
	ev.emit('messages.upsert', {
		type: 'append',
		messages: [
			{ key: { id: 'A1', remoteJid: ME, fromMe: false }, messageTimestamp: 10, message: { conversation: 'a1' } },
			{ key: { id: 'A2', remoteJid: ME, fromMe: false }, messageTimestamp: 11, message: { conversation: 'a2' } },
			{ key: { id: 'B1', remoteJid: chatB, fromMe: false }, messageTimestamp: 12, message: { conversation: 'b1' } },
			{ key: { id: 'B2', remoteJid: chatB, fromMe: false }, messageTimestamp: 13, message: { conversation: 'b2' } }
		]
	})
	ev.emit('messages.delete', {
		keys: [
			{ id: 'A1', remoteJid: ME, fromMe: false },
			{ id: 'B1', remoteJid: chatB, fromMe: false }
		]
	})
	assert.equal(await store.loadMessage(ME, 'A1'), undefined)
	assert.equal(await store.loadMessage(chatB, 'B1'), undefined, 'pre-fix the second chat kept its deleted message')
	assert.equal((await store.loadMessage(ME, 'A2'))?.message?.conversation, 'a2')
	assert.equal((await store.loadMessage(chatB, 'B2'))?.message?.conversation, 'b2')
})

// ── HB-510: KeyedDB filtered predicate indexes ───────────────────────
const makeDb = () => {
	const db = new KeyedDB(
		{ key: v => String(v.n).padStart(3, '0'), compare: (a, b) => a.localeCompare(b) },
		v => `id-${v.n}`
	)
	for (let n = 1; n <= 10; n++) {
		db.upsert({ n })
	}

	return db
}

test('HB-510: paginated after-mode hands the predicate true array positions', () => {
	const db = makeDb()
	const seen = []
	const page = db.paginated(null, 10, (item, index) => {
		seen.push([item.n, index])
		return true
	}, 'after')
	assert.equal(page.length, 10)
	assert.deepEqual(seen, [
		[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 8], [10, 9]
	])
})

test('HB-510: paginated before-mode hands the predicate true array positions', () => {
	const db = makeDb()
	const seen = []
	db.paginated(null, 10, (item, index) => {
		seen.push([item.n, index])
		return true
	}, 'before')
	assert.deepEqual(seen, [
		[10, 9], [9, 8], [8, 7], [7, 6], [6, 5], [5, 4], [4, 3], [3, 2], [2, 1], [1, 0]
	])
	// an index-based predicate must select by real position:
	// pre-fix it received start + matchCount (10..19, out of range)
	const firstFive = db.paginated(null, 10, (_item, index) => index < 5, 'before')
	assert.deepEqual(firstFive.map(v => v.n), [1, 2, 3, 4, 5])
	const afterFive = db.paginated(null, 10, (_item, index) => index >= 5, 'after')
	assert.deepEqual(afterFive.map(v => v.n), [6, 7, 8, 9, 10])
})
