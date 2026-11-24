// Batch 2.6.0 — Kelompok D regressions (delta fitur + sapu bersih):
// Presence tracker (delta run-0936, clean-room reimplementation from
// the ledger spec): PresenceTracker / monitorPresence /
// createPresenceTracker + timezone/format helpers, lifecycle,
// presence-change events, sessions, stale sweep, socket attach.
// Each test names the behaviour it locks in and fails without the
// module (import from lib/ + behaviour assertions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { lib, silentLogger, makeOfflineSocket, sleep, endQuietly, tmpDir } from './helpers.mjs'
import { LIDMappingStore } from '../lib/Signal/lid-mapping.js'
import { executeWWWGraphQL } from '../lib/Socket/graphql.js'
import {
	PresenceTracker,
	monitorPresence,
	createPresenceTracker,
	getDefaultTimezone,
	setDefaultTimezone,
	parseTimezone,
	formatDuration,
	formatTime,
	formatDateTime,
	formatTimeAgo,
	normalizeContactJid,
	isOnlinePresence,
	isOfflinePresence
} from '../lib/Utils/presence-tracker.js'

const ALICE = '6281234567890@s.whatsapp.net'
const BOB = '6289876543210@s.whatsapp.net'

const clock = (start = 1_000_000) => {
	let now = start
	return { now: () => now, advance: ms => { now += ms } }
}

const feed = (tracker, jid, presence, lastSeen = undefined) =>
	tracker.ingest({ id: 'chat', presences: { [jid]: { lastKnownPresence: presence, lastSeen } } })

test('presence tracker: subscribe/unsubscribe lifecycle + JID normalisation', () => {
	const tracker = new PresenceTracker({ logger: silentLogger })
	assert.equal(tracker.subscribe(ALICE), true)
	assert.equal(tracker.subscribe(ALICE), false, 'duplicate subscribe is a no-op')
	assert.equal(tracker.isSubscribed(ALICE), true)
	assert.equal(tracker.subscribe('not-a-jid'), false, 'unusable jid is rejected')
	assert.equal(tracker.subscribe(''), false)
	// Device suffixes collapse onto the same contact.
	assert.equal(tracker.subscribe('6281234567890:42@s.whatsapp.net'), false, 'same user, different device')
	assert.deepEqual(tracker.subscribedJids(), [ALICE])
	assert.equal(tracker.unsubscribe(ALICE), true)
	assert.equal(tracker.unsubscribe(ALICE), false)
	assert.equal(tracker.isSubscribed(ALICE), false)
	tracker.stop()
})

test('presence tracker: change events, sessions and online accounting', () => {
	const { now, advance } = clock()
	const tracker = new PresenceTracker({ logger: silentLogger, now })
	const changes = []
	const diagnostics = []
	tracker.on('presence.change', c => changes.push(c))
	tracker.on('presence.diagnostic', d => diagnostics.push(d))
	tracker.subscribe(ALICE)
	tracker.subscribe(BOB)

	feed(tracker, ALICE, 'available')
	let record = tracker.getPresence(ALICE)
	assert.equal(record.presence, 'available')
	assert.equal(record.onlineSince, 1_000_000)
	assert.equal(record.sessions.length, 1)
	assert.equal(record.sessions[0].endedAt, undefined)
	assert.deepEqual(tracker.getOnlineJids(), [ALICE])
	assert.equal(changes.length, 0, 'first sighting is not a change')

	advance(90_000)
	feed(tracker, ALICE, 'composing')
	assert.equal(changes.length, 1, 'available -> composing is a presence change (session stays open)')
	assert.equal(changes[0].previousPresence, 'available')
	assert.equal(changes[0].presence, 'composing')
	assert.equal(tracker.getPresence(ALICE).sessions.length, 1, 'session stays open across online states')

	advance(30_000)
	feed(tracker, ALICE, 'unavailable')
	assert.equal(changes.length, 2)
	assert.equal(changes[1].previousPresence, 'composing')
	assert.equal(changes[1].presence, 'unavailable')
	record = tracker.getPresence(ALICE)
	assert.equal(record.onlineSince, undefined)
	assert.equal(record.sessions[0].durationMs, 120_000)
	assert.equal(record.totalOnlineMs, 120_000)
	assert.deepEqual(tracker.getOnlineJids(), [])

	// 'paused' counts as offline; a second session opens on return.
	advance(10_000)
	feed(tracker, ALICE, 'available')
	advance(5_000)
	feed(tracker, ALICE, 'paused')
	record = tracker.getPresence(ALICE)
	assert.equal(record.sessions.length, 2)
	assert.equal(record.totalOnlineMs, 125_000)
	assert.equal(diagnostics.filter(d => d.kind === 'session-start').length, 2)
	assert.equal(diagnostics.filter(d => d.kind === 'session-end').length, 2)
	tracker.stop()
})

test('presence tracker: unsubscribed contacts are ignored, unknown values diagnosed', () => {
	const tracker = new PresenceTracker({ logger: silentLogger })
	const diagnostics = []
	tracker.on('presence.diagnostic', d => diagnostics.push(d))
	tracker.subscribe(ALICE)
	feed(tracker, BOB, 'available')
	assert.equal(tracker.getPresence(BOB), undefined, 'not subscribed: not tracked')
	tracker.ingest({ id: 'chat', presences: { [ALICE]: { lastKnownPresence: 'teleporting' } } })
	assert.equal(tracker.getPresence(ALICE), undefined, 'unknown presence value is never stored')
	assert.equal(diagnostics.some(d => d.kind === 'unknown-presence'), true)
	tracker.ingest(null)
	tracker.ingest({ id: 'chat' })
	assert.equal(diagnostics.filter(d => d.kind === 'error').length, 2, 'garbage ingest is a diagnostic, not a throw')
	tracker.stop()
})

test('presence tracker: stale sweep flags quiet contacts, describe() reads back', () => {
	const { now, advance } = clock()
	const tracker = new PresenceTracker({ logger: silentLogger, now, staleAfterMs: 60_000 })
	const diagnostics = []
	tracker.on('presence.diagnostic', d => diagnostics.push(d))
	tracker.subscribe(ALICE)
	feed(tracker, ALICE, 'available', 999)
	assert.equal(tracker.getPresence(ALICE).stale, false)
	assert.equal(tracker.describe(ALICE), `${ALICE} available for 0s`)
	advance(59_000)
	assert.deepEqual(tracker.sweepStale(), [])
	advance(2_000)
	assert.deepEqual(tracker.sweepStale(), [ALICE])
	assert.equal(tracker.getPresence(ALICE).stale, true)
	assert.equal(diagnostics.some(d => d.kind === 'stale'), true)
	// A fresh update clears the flag.
	feed(tracker, ALICE, 'available')
	assert.equal(tracker.getPresence(ALICE).stale, false)
	assert.match(tracker.describe(ALICE), /available for /)
	tracker.stop()
})

test('presence tracker: session cap trims oldest sessions first', () => {
	const { now, advance } = clock()
	const tracker = new PresenceTracker({ logger: silentLogger, now, maxSessionsPerContact: 2 })
	tracker.subscribe(ALICE)
	for (let i = 0; i < 3; i++) {
		feed(tracker, ALICE, 'available')
		advance(1_000)
		feed(tracker, ALICE, 'unavailable')
		advance(1_000)
	}
	const record = tracker.getPresence(ALICE)
	assert.equal(record.sessions.length, 2, 'only the newest 2 sessions survive')
	assert.equal(record.totalOnlineMs, 3_000, 'total still accounts for the dropped session')
	tracker.stop()
})

test('monitorPresence: attaches to a socket, stop() detaches; createPresenceTracker is the same function', () => {
	assert.equal(createPresenceTracker, monitorPresence)
	const ev = new EventEmitter()
	const tracker = monitorPresence({ ev }, { logger: silentLogger })
	tracker.subscribe(ALICE)
	ev.emit('presence.update', { id: 'chat', presences: { [ALICE]: { lastKnownPresence: 'recording' } } })
	assert.equal(tracker.getPresence(ALICE).presence, 'recording')
	ev.emit('connection.update', { connection: 'open' })
	assert.equal(tracker.snapshot().socketState, 'open')
	tracker.stop()
	ev.emit('presence.update', { id: 'chat', presences: { [ALICE]: { lastKnownPresence: 'unavailable' } } })
	assert.equal(tracker.getPresence(ALICE).presence, 'recording', 'detached: later updates are ignored')
	assert.equal(tracker.snapshot().socketState, 'open', 'snapshot keeps the last known socket state')
})

test('monitorPresence: rejects a socket without an event emitter', () => {
	assert.throws(() => monitorPresence({}), /ev\.on\/ev\.off/)
	assert.throws(() => monitorPresence(null), /ev\.on\/ev\.off/)
})

test('presence tracker: timezone + format helpers', () => {
	assert.equal(parseTimezone('Asia/Jakarta').type, 'iana')
	assert.deepEqual(parseTimezone('+07:00'), { type: 'offset', offsetMinutes: 420 })
	assert.deepEqual(parseTimezone('-05:30'), { type: 'offset', offsetMinutes: -330 })
	assert.throws(() => parseTimezone('Mars/Olympus'), /unknown timezone/)
	assert.throws(() => parseTimezone('+15:00'), /out of range/)
	assert.throws(() => parseTimezone(7), /timezone string is required/)

	assert.equal(formatDuration(0), '0s')
	assert.equal(formatDuration(45_000), '45s')
	assert.equal(formatDuration(90_000), '1m 30s')
	assert.equal(formatDuration(3_661_000), '1h 1m 1s')
	assert.equal(formatDuration(90_061_000), '1d 1h 1m 1s')
	assert.throws(() => formatDuration(NaN), /finite non-negative/)

	// 2026-11-24T00:00:00Z is 07:00 in Jakarta (no DST there, ever).
	const midnight = Date.UTC(2026, 10, 24, 0, 0, 0)
	assert.equal(formatTime(midnight, '+07:00'), '07:00:00')
	assert.equal(formatTime(midnight, 'Asia/Jakarta'), '07:00:00')
	assert.equal(formatDateTime(midnight, '+07:00'), '2026-11-24 07:00:00')
	assert.equal(formatDateTime(midnight, '-05:00'), '2026-11-23 19:00:00')
	assert.equal(formatTimeAgo(midnight, midnight + 3_000), 'just now')
	assert.equal(formatTimeAgo(midnight, midnight + 120_000), '2m 0s ago')
	assert.equal(formatTimeAgo(midnight + 60_000, midnight), 'in 1m 0s')

	const previous = getDefaultTimezone()
	assert.equal(setDefaultTimezone('Asia/Jakarta'), 'Asia/Jakarta')
	assert.equal(getDefaultTimezone(), 'Asia/Jakarta')
	assert.equal(formatTime(midnight), '07:00:00', 'default timezone applies')
	assert.throws(() => setDefaultTimezone('Nowhere/Special'), /unknown timezone/)
	setDefaultTimezone(previous)
})

test('presence tracker: JID + presence predicates', () => {
	assert.equal(normalizeContactJid('62812:7@s.whatsapp.net'), '62812@s.whatsapp.net')
	assert.equal(normalizeContactJid(''), undefined)
	assert.equal(normalizeContactJid(42), undefined)
	assert.equal(normalizeContactJid(undefined), undefined)
	assert.equal(isOnlinePresence('available'), true)
	assert.equal(isOnlinePresence('composing'), true)
	assert.equal(isOnlinePresence('recording'), true)
	assert.equal(isOnlinePresence('unavailable'), false)
	assert.equal(isOnlinePresence('paused'), false)
	assert.equal(isOfflinePresence('unavailable'), true)
	assert.equal(isOfflinePresence('paused'), true)
	assert.equal(isOfflinePresence('available'), false)
})

test('presence tracker: NaN numeric config falls back to defaults instead of breaking', () => {
	const tracker = new PresenceTracker({ logger: silentLogger, staleAfterMs: NaN, maxSessionsPerContact: NaN, maxContacts: NaN })
	tracker.subscribe(ALICE)
	feed(tracker, ALICE, 'available')
	assert.equal(tracker.getPresence(ALICE).presence, 'available')
	tracker.start()
	tracker.stop()
})

// ── Sapu bersih 2.6.0 (Kelompok D) ─────────────────────────────────
// Ten addendum fixes, each locked by a test that FAILS without its fix.
// Ledger line numbers are in the GROUP-D report.

const SWEEP_CHAT = '6283333333333@s.whatsapp.net'
const SWEEP_GROUP = '120363099999999@g.us'
const boom400 = err => err?.output?.statusCode === 400

const freshBuffer = () => {
	const ev = lib.makeEventBuffer(silentLogger)
	const maps = []
	ev.on('event', map => maps.push(map))
	ev.buffer()
	return { ev, maps }
}

const sweepMsg = id => ({
	key: { remoteJid: SWEEP_CHAT, id, fromMe: false },
	message: { conversation: `sweep-${id}` },
	messageTimestamp: 1
})

// In-memory keys with a passthrough transaction (test/25 recipe).
const memKeys = () => {
	const mem = new Map()
	return {
		get: async (type, ids) => {
			const out = {}
			for (const id of ids) {
				const v = mem.get(`${type}:${id}`)
				if (v !== undefined) out[id] = v
			}
			return out
		},
		set: async data => {
			for (const [type, rec] of Object.entries(data)) {
				for (const [k, v] of Object.entries(rec)) {
					if (v === null || v === undefined) mem.delete(`${type}:${k}`)
					else mem.set(`${type}:${k}`, v)
				}
			}
		},
		transaction: async work => work(),
		isInTransaction: () => false
	}
}

// ── HB-2026-1112-15 addendum facet 2 ──────────────────────────────

test('HB-15 addendum f2: readFromFile on a directory path starts empty instead of throwing EISDIR', () => {
	const dir = tmpDir('aunu-260-hb15-')
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	assert.doesNotThrow(() => store.readFromFile(dir), 'a directory path must not crash the boot')
	assert.equal(store.chats.all().length, 0, 'the store must start empty after an unreadable path')
	// Control: a valid file written by writeToFile still round-trips.
	const file = join(dir, 'store.json')
	store.chats.upsert({ id: SWEEP_CHAT, conversationTimestamp: 100 })
	store.writeToFile(file)
	const store2 = lib.makeInMemoryStore({ logger: silentLogger })
	store2.readFromFile(file)
	assert.ok(store2.chats.get(SWEEP_CHAT), 'a valid store file must still load')
})

// ── HB-2026-1112-22 addendum 4 ────────────────────────────────────

test('HB-22 addendum 4: groupAcceptInviteV4 rejects a key without remoteJid with Boom 400', async () => {
	const sock = await makeOfflineSocket()
	try {
		await assert.rejects(
			sock.groupAcceptInviteV4({ id: 'INV2601' }, { groupJid: SWEEP_GROUP, inviteCode: 'CODE2601', inviteExpiration: 9999999999 }),
			boom400,
			'a key object without remoteJid must fail fast, not send an <accept> without the admin attr'
		)
		// Control: a bare string key normalises to { remoteJid } and
		// proceeds past validation (it then fails on the offline query,
		// but NOT with 400).
		await assert.rejects(
			sock.groupAcceptInviteV4('6281111111111@s.whatsapp.net', { groupJid: SWEEP_GROUP, inviteCode: 'CODE2601', inviteExpiration: 9999999999 }),
			err => err?.output?.statusCode !== 400,
			'a string key must pass the remoteJid guard'
		)
	} finally {
		endQuietly(sock)
	}
})

test('HB-22 addendum 4: communityAcceptInviteV4 rejects a key without remoteJid with Boom 400', async () => {
	const sock = await makeOfflineSocket()
	try {
		await assert.rejects(
			sock.communityAcceptInviteV4({ id: 'INV2602' }, { groupJid: SWEEP_GROUP, inviteCode: 'CODE2602', inviteExpiration: 9999999999 }),
			boom400
		)
		await assert.rejects(
			sock.communityAcceptInviteV4('6281111111111@s.whatsapp.net', { groupJid: SWEEP_GROUP, inviteCode: 'CODE2602', inviteExpiration: 9999999999 }),
			err => err?.output?.statusCode !== 400
		)
	} finally {
		endQuietly(sock)
	}
})

// ── HB-286 addendum (echo facet) ──────────────────────────────────

test('HB-286 addendum: a USync echo whose pn shape differs from the fetch key still resolves on the first call', async () => {
	const keys = memKeys()
	// The server echoes the pair under the device-specific pn
	// (628...:1@...) while we fetched under the bare pn — the pair
	// is persisted, but the old code skipped it from the return
	// value, so the in-flight caller got null once.
	const echoMismatch = async () => [{ pn: '6281234567890:1@s.whatsapp.net', lid: '100000123456789@lid' }]
	const mapping = new LIDMappingStore(keys, silentLogger, echoMismatch)
	assert.equal(
		await mapping.getLIDForPN('6281234567890@s.whatsapp.net'),
		'100000123456789:1@lid',
		'the echoed pair itself must be returned, with its device'
	)
	mapping.close()
	// Control: an echo under the exact fetch key still resolves.
	const keys2 = memKeys()
	const echoExact = async () => [{ pn: '6281234567890@s.whatsapp.net', lid: '100000123456789@lid' }]
	const mapping2 = new LIDMappingStore(keys2, silentLogger, echoExact)
	assert.equal(await mapping2.getLIDForPN('6281234567890@s.whatsapp.net'), '100000123456789@lid')
	mapping2.close()
})

// ── HB-359 addendum facet 3 ───────────────────────────────────────

test('HB-359 addendum f3: the 30s watchdog never steals a nesting level — a session nested past the watchdog stays open', async () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('chats.upsert', [{ id: SWEEP_CHAT, conversationTimestamp: 100 }])
		const work = ev.createBufferedFunction(async () => {
			await sleep(31_000)
			return 'done'
		})
		const done = work()
		assert.equal(await done, 'done')
		await sleep(500)
		// Without the fix the watchdog fired at 30s, stole one level,
		// and the completion's finally armed the debounced flush —
		// the session ended ~100ms after the work. With the fix the
		// watchdog re-armed while nested and the outer level survives.
		assert.equal(ev.isBuffering(), true, 'the outer buffer level must survive a watchdog firing mid-work')
		assert.equal(maps.length, 0, 'nothing is delivered before the outer flush')
		assert.equal(ev.flush(), true)
		assert.equal(maps.length, 1, 'the outer flush delivers the batch')
		assert.ok(maps[0]['chats.upsert']?.find(c => c.id === SWEEP_CHAT), 'the buffered upsert must be delivered')
	} finally {
		ev.destroy()
	}
})

// ── HB-382 addendum (graphql facet) ───────────────────────────────

test('HB-382 addendum: a null entry in a GraphQL errors array throws Boom, not a raw TypeError', async () => {
	const origFetch = globalThis.fetch
	try {
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [null] }) })
		await assert.rejects(
			executeWWWGraphQL('26387089294279400', {}, 'tok-260'),
			err => err?.output?.statusCode >= 400 && /GraphQL error: Unknown error/.test(err.message),
			'{"errors":[null]} must be a Boom 500, not a TypeError from .map'
		)
		// Control: a well-formed error still surfaces its message.
		globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom-x' }] }) })
		await assert.rejects(
			executeWWWGraphQL('26387089294279400', {}, 'tok-260'),
			err => /GraphQL error: boom-x/.test(err.message)
		)
	} finally {
		globalThis.fetch = origFetch
	}
})

// ── HB-393 addendum 2 ─────────────────────────────────────────────

test('HB-393 addendum 2: a -1 mark-unread absorbed into a history chat deletes the count instead of storing -1', () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('chats.update', [{ id: SWEEP_CHAT, unreadCount: -1 }])
		ev.emit('messaging-history.set', {
			chats: [{ id: SWEEP_CHAT, unreadCount: 3, conversationTimestamp: 100 }],
			messages: [],
			contacts: [],
			syncType: 1,
			isLatest: true
		})
		ev.flush()
		const flushed = maps[0]?.['messaging-history.set']?.chats?.[0]
		assert.ok(flushed, 'history set must be flushed')
		assert.equal(flushed.unreadCount, undefined, 'the -1 sentinel must not be stored as a count (was: -1, next +1 landed on 0)')
	} finally {
		ev.destroy()
	}
})

test('HB-393 addendum 2 control: a 0 mark-read absorbed into a history chat still assigns 0', () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('chats.update', [{ id: SWEEP_CHAT, unreadCount: 0 }])
		ev.emit('messaging-history.set', {
			chats: [{ id: SWEEP_CHAT, unreadCount: 3, conversationTimestamp: 100 }],
			messages: [],
			contacts: [],
			syncType: 1,
			isLatest: true
		})
		ev.flush()
		const flushed = maps[0]?.['messaging-history.set']?.chats?.[0]
		assert.equal(flushed?.unreadCount, 0, 'mark-read must still assign 0')
	} finally {
		ev.destroy()
	}
})

// ── HB-394 addendum (store facet) ─────────────────────────────────

test('HB-394 addendum: a fresher history copy arriving as a separate set merges over the stored chat', () => {
	const store = lib.makeInMemoryStore({ logger: silentLogger })
	const ev = new EventEmitter()
	store.bind(ev)
	ev.emit('messaging-history.set', {
		chats: [{ id: SWEEP_CHAT, conversationTimestamp: 100, name: 'Old', unreadCount: 1 }],
		contacts: [],
		messages: []
	})
	assert.equal(store.chats.get(SWEEP_CHAT)?.name, 'Old', 'setup: first copy stored')
	ev.emit('messaging-history.set', {
		chats: [{ id: SWEEP_CHAT, conversationTimestamp: 200, name: 'New', unreadCount: 5 }],
		contacts: [],
		messages: []
	})
	const stored = store.chats.get(SWEEP_CHAT)
	assert.equal(stored?.name, 'New', 'the fresher copy must win (was: first-wins discarded it)')
	assert.equal(stored?.unreadCount, 5)
	// Control: a STALER copy arriving later must not clobber the fresh one.
	ev.emit('messaging-history.set', {
		chats: [{ id: SWEEP_CHAT, conversationTimestamp: 50, name: 'Stale', unreadCount: 9 }],
		contacts: [],
		messages: []
	})
	assert.equal(store.chats.get(SWEEP_CHAT)?.name, 'New', 'a staler copy must not win')
})

// ── HB-404 addendum ───────────────────────────────────────────────

test('HB-404 addendum: a valid update cancels a pending delete but keeps the pre-delete messages', () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('messages.upsert', { messages: [sweepMsg('M1')], type: 'append' })
		ev.emit('chats.delete', [SWEEP_CHAT])
		ev.emit('chats.update', [{ id: SWEEP_CHAT, unreadCount: 1 }])
		ev.emit('messages.upsert', { messages: [sweepMsg('M2')], type: 'append' })
		ev.flush()
		assert.equal(maps[0]?.['chats.delete'], undefined, 'the applied update cancels the delete')
		const delivered = maps[0]?.['messages.upsert']?.messages?.map(m => m.key.id) ?? []
		assert.deepEqual(delivered, ['M1', 'M2'], 'both messages survive — the pre-delete one was dropped at append time before the fix')
	} finally {
		ev.destroy()
	}
})

test('HB-404 addendum: an invalid (condition-false) update does NOT cancel a pending delete', () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('messages.upsert', { messages: [sweepMsg('M1')], type: 'append' })
		ev.emit('chats.delete', [SWEEP_CHAT])
		ev.emit('chats.update', [{ id: SWEEP_CHAT, unreadCount: 1, conditional: () => false }])
		ev.flush()
		assert.deepEqual(maps[0]?.['chats.delete'], [SWEEP_CHAT], 'the delete survives a discarded update')
		assert.equal(maps[0]?.['messages.upsert'], undefined, 'the pre-delete message is dropped at flush time')
	} finally {
		ev.destroy()
	}
})

test('HB-404 addendum control: a bare delete still delivers the delete and drops the pre-delete message', () => {
	const { ev, maps } = freshBuffer()
	try {
		ev.emit('messages.upsert', { messages: [sweepMsg('M1')], type: 'append' })
		ev.emit('chats.delete', [SWEEP_CHAT])
		ev.flush()
		assert.deepEqual(maps[0]?.['chats.delete'], [SWEEP_CHAT])
		assert.equal(maps[0]?.['messages.upsert'], undefined)
	} finally {
		ev.destroy()
	}
})

// ── HB-362 addendum facet 2 ───────────────────────────────────────

test('HB-362 addendum f2: a throwing shouldIgnoreJid in handlePresenceUpdate loses no presence.update', async () => {
	const sock = await makeOfflineSocket({ shouldIgnoreJid: () => { throw new Error('host boom') } })
	try {
		const received = []
		sock.ev.on('presence.update', e => received.push(e))
		assert.doesNotThrow(
			() => sock.ws.emit('CB:presence', { tag: 'presence', attrs: { from: SWEEP_CHAT, type: 'available' } }),
			'a throwing host callback must be contained, not escape the handler'
		)
		await sleep(50)
		sock.ev.flush()
		await sleep(50)
		assert.equal(received.length, 1, 'the presence.update must still be delivered')
		assert.equal(received[0].id, SWEEP_CHAT)
		assert.equal(received[0].presences[SWEEP_CHAT]?.lastKnownPresence, 'available')
	} finally {
		endQuietly(sock)
	}
})

// ── HB-139 addendum ───────────────────────────────────────────────

test('HB-139 addendum: maxMsgRetryCount 0 / negative / fractional fall back to a positive integer default', async () => {
	const cases = [
		[0, 5],
		[-2, 5],
		[2.7, 2],
		[3, 3]
	]
	for (const [input, expected] of cases) {
		const sock = await makeOfflineSocket({ maxMsgRetryCount: input })
		try {
			assert.equal(
				sock.messageRetryManager.maxMsgRetryCount,
				expected,
				`maxMsgRetryCount ${input} must sanitise to ${expected}`
			)
			assert.equal(
				sock.messageRetryManager.hasExceededMaxRetries('fresh-139'),
				false,
				'a fresh message must never be over the retry limit'
			)
		} finally {
			endQuietly(sock)
		}
	}
})
