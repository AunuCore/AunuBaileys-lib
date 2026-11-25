// Batch 2.7.0 — call-signaling layer (clean-room from the ledger
// spec, GROUP-D-REPORT 1b): normalised events, per-call state
// machine, missed-call timer (injected, controlled), auto-reject +
// auto message, SDP diagnostics, opt-in socket attach. Runs against
// lib/; every test fails without src/Utils/call-signaling.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { silentLogger } from './helpers.mjs'
import {
	CallSignalingTracker,
	monitorCallSignaling,
	createCallSignalingTracker,
	parseSdp,
	normalizedTypeForStatus
} from '../lib/Utils/call-signaling.js'

const ALICE = '6281234567890@s.whatsapp.net'
const BOB = '6289876543210@s.whatsapp.net'

const makeHarness = (options = {}) => {
	let now = 1_000_000
	let seq = 0
	const timers = new Map()
	const tracker = new CallSignalingTracker({
		logger: silentLogger,
		now: () => now,
		setTimeoutFn: (fn, ms) => {
			const handle = { id: ++seq, fn, ms }
			timers.set(handle.id, handle)
			return handle
		},
		clearTimeoutFn: handle => {
			if (handle && typeof handle === 'object') timers.delete(handle.id)
		},
		...options
	})
	return {
		tracker,
		timers,
		advance: ms => {
			now += ms
		},
		fireTimers: () => {
			for (const handle of [...timers.values()]) {
				timers.delete(handle.id)
				handle.fn()
			}
		}
	}
}

const callEvent = (overrides = {}) => ({
	chatId: ALICE,
	from: ALICE,
	id: 'CALL-1',
	date: new Date(1_000_000),
	offline: false,
	status: 'offer',
	...overrides
})

const collect = tracker => {
	const events = []
	const diagnostics = []
	tracker.on('call.event', e => events.push(e))
	tracker.on('call.diagnostic', d => diagnostics.push(d))
	return { events, diagnostics }
}

test('call-signaling: offer normalises to incoming and opens a ringing session', () => {
	const { tracker, timers } = makeHarness()
	const { events } = collect(tracker)
	const produced = tracker.ingest(callEvent({ isVideo: true }))
	assert.equal(produced.length, 1)
	assert.equal(produced[0].type, 'incoming')
	assert.equal(events.length, 1)
	const session = tracker.getCall('CALL-1')
	assert.equal(session.state, 'ringing')
	assert.equal(session.from, ALICE)
	assert.equal(session.chatId, ALICE)
	assert.equal(session.isVideo, true)
	assert.deepEqual(session.history, ['offer'])
	assert.equal(timers.size, 1, 'missed-call timer is armed on offer')
	assert.equal(tracker.getActiveCalls().length, 1)
	tracker.stop()
	assert.equal(timers.size, 0, 'stop() clears the missed-call timer')
})

test('call-signaling: ringing and latency updates stay on the ringing session', () => {
	const { tracker } = makeHarness()
	collect(tracker)
	tracker.ingest(callEvent())
	assert.equal(tracker.ingest(callEvent({ status: 'ringing' }))[0].type, 'ringing')
	assert.equal(tracker.ingest(callEvent({ status: 'preaccept' }))[0].type, 'ringing')
	const latency = tracker.ingest(callEvent({ status: 'relaylatency', latencyMs: 123 }))
	assert.equal(latency[0].type, 'latency')
	assert.equal(tracker.getCall('CALL-1').latencyMs, 123)
	assert.equal(tracker.getCall('CALL-1').state, 'ringing')
	// Non-finite latency is guarded, never stored.
	tracker.ingest(callEvent({ status: 'relaylatency', latencyMs: Number.NaN }))
	assert.equal(tracker.getCall('CALL-1').latencyMs, 123)
	tracker.stop()
})

test('call-signaling: accept clears the missed timer, terminate ends the call', () => {
	const { tracker, timers, advance, fireTimers } = makeHarness({ missedAfterMs: 30_000 })
	const { events } = collect(tracker)
	tracker.ingest(callEvent())
	assert.equal(tracker.ingest(callEvent({ status: 'accept' }))[0].type, 'accepted')
	assert.equal(tracker.getCall('CALL-1').state, 'accepted')
	assert.ok(tracker.getCall('CALL-1').answeredAt)
	assert.equal(timers.size, 0, 'missed-call timer cleared on accept')
	advance(60_000)
	fireTimers()
	assert.equal(tracker.getCall('CALL-1').state, 'accepted', 'no missed transition after accept')
	const ended = tracker.ingest(callEvent({ status: 'terminate' }))
	assert.deepEqual(ended.map(e => e.type), ['ended'])
	assert.equal(tracker.getCall('CALL-1').state, 'ended')
	assert.equal(tracker.getCall('CALL-1').endReason, 'terminate')
	assert.equal(tracker.getActiveCalls().length, 0)
	assert.deepEqual(events.map(e => e.type), ['incoming', 'accepted', 'ended'])
	tracker.stop()
})

test('call-signaling: reject before accept is missed + ended', () => {
	const { tracker, timers } = makeHarness()
	collect(tracker)
	tracker.ingest(callEvent())
	const produced = tracker.ingest(callEvent({ status: 'reject' }))
	assert.deepEqual(produced.map(e => e.type), ['missed', 'ended'])
	assert.equal(tracker.getCall('CALL-1').state, 'missed')
	assert.equal(tracker.getCall('CALL-1').endReason, 'reject')
	assert.equal(timers.size, 0)
	tracker.stop()
})

test('call-signaling: missed-call timer marks an unanswered call missed', () => {
	const { tracker, timers, advance, fireTimers } = makeHarness({ missedAfterMs: 30_000 })
	const { events } = collect(tracker)
	tracker.ingest(callEvent())
	advance(29_000)
	fireTimers()
	// Firing the captured timer early only runs checkMissed, which is
	// the authority: the deadline has not been reached on the
	// injected clock, so the call is still ringing.
	assert.equal(tracker.getCall('CALL-1').state, 'ringing')
	tracker.ingest(callEvent({ id: 'CALL-2', chatId: BOB, from: BOB }))
	advance(31_000)
	assert.deepEqual(tracker.checkMissed(), ['CALL-1', 'CALL-2'])
	assert.equal(tracker.getCall('CALL-1').state, 'missed')
	assert.equal(tracker.getCall('CALL-1').endReason, 'timeout')
	assert.deepEqual(events.filter(e => e.type === 'missed').map(e => e.call.id), ['CALL-1', 'CALL-2'])
	assert.equal(timers.size, 0, 'all missed-call timers cleared after firing/marking')
	tracker.stop()
})

test('call-signaling: timeout status and duplicate terminal updates', () => {
	const { tracker } = makeHarness()
	collect(tracker)
	tracker.ingest(callEvent())
	const produced = tracker.ingest(callEvent({ status: 'timeout' }))
	assert.deepEqual(produced.map(e => e.type), ['missed', 'ended'])
	assert.equal(tracker.ingest(callEvent({ status: 'terminate' })).length, 0, 'terminal state is sticky')
	tracker.stop()
})

test('call-signaling: malformed updates are diagnosed and skipped, batch survives', () => {
	const { tracker } = makeHarness()
	const { diagnostics } = collect(tracker)
	const produced = tracker.ingest([
		null,
		{ status: 'offer' },
		{ id: 'X', status: 'bogus', from: ALICE, chatId: ALICE },
		{ id: 'Y', status: 'offer', from: 'not a jid at all :::', chatId: '' },
		callEvent({ id: 'GOOD' })
	])
	assert.deepEqual(produced.map(e => e.call.id), ['GOOD'])
	assert.ok(diagnostics.filter(d => d.kind === 'error').length >= 4)
	assert.equal(tracker.getCall('GOOD').state, 'ringing')
	tracker.stop()
})

test('call-signaling: duplicate offer does not re-emit incoming', () => {
	const { tracker } = makeHarness()
	const { diagnostics } = collect(tracker)
	tracker.ingest(callEvent())
	assert.equal(tracker.ingest(callEvent()).length, 0)
	assert.ok(diagnostics.some(d => d.kind === 'error' && /duplicate offer/.test(d.detail || '')))
	tracker.stop()
})

test('call-signaling: auto-reject rejects and sends the auto message', async () => {
	const rejected = []
	const sent = []
	const { tracker, timers } = makeHarness({
		autoReject: true,
		autoMessageText: call => `Cannot take your call (${call.id})`,
		actions: {
			rejectCall: async call => {
				rejected.push(call.id)
			},
			sendMessage: async (jid, text) => {
				sent.push({ jid, text })
			}
		}
	})
	const { diagnostics } = collect(tracker)
	tracker.ingest(callEvent())
	await tracker.whenIdle()
	assert.deepEqual(rejected, ['CALL-1'])
	assert.deepEqual(sent, [{ jid: ALICE, text: 'Cannot take your call (CALL-1)' }])
	assert.equal(tracker.getCall('CALL-1').state, 'ended')
	assert.equal(tracker.getCall('CALL-1').endReason, 'auto-reject')
	assert.equal(timers.size, 0, 'missed-call timer cleared by auto-reject')
	assert.ok(diagnostics.some(d => d.kind === 'auto-reject'))
	assert.ok(diagnostics.some(d => d.kind === 'auto-message'))
	tracker.stop()
})

test('call-signaling: auto-reject predicate off leaves the call ringing; throwing action is contained', async () => {
	const off = makeHarness({ autoReject: () => false, actions: { rejectCall: () => { throw new Error('must not run') } } })
	off.tracker.ingest(callEvent())
	await off.tracker.whenIdle()
	assert.equal(off.tracker.getCall('CALL-1').state, 'ringing')
	off.tracker.stop()

	const failing = makeHarness({
		autoReject: true,
		actions: {
			rejectCall: async () => {
				throw new Error('wire down')
			}
		}
	})
	const { diagnostics } = collect(failing.tracker)
	failing.tracker.ingest(callEvent())
	await failing.tracker.whenIdle()
	assert.equal(failing.tracker.getCall('CALL-1').state, 'ringing', 'failed auto-reject does not fake an ended call')
	assert.ok(diagnostics.some(d => d.kind === 'error' && /auto-reject/.test(d.detail || '')))
	failing.tracker.stop()
	assert.equal(failing.timers.size, 0)
})

test('call-signaling: parseSdp extracts media, ICE, fingerprint, setup and candidates', () => {
	const sdp = [
		'v=0',
		'o=- 4611733050430602912 2 IN IP4 127.0.0.1',
		's=-',
		'a=ice-ufrag:abcd',
		'a=ice-pwd:efghijklmnopqrstuvwx',
		'a=fingerprint:sha-256 AA:BB:CC',
		'a=setup:actpass',
		'm=audio 9 UDP/TLS/RTP/SAVPF 111 126',
		'a=candidate:1 1 udp 2113937151 192.0.2.1 54400 typ host generation 0',
		'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
		'a=candidate:2 1 udp 1677729535 203.0.113.5 9 typ relay generation 0'
	].join('\r\n')
	const parsed = parseSdp(sdp)
	assert.equal(parsed.hasAudio, true)
	assert.equal(parsed.hasVideo, true)
	assert.deepEqual(parsed.media.map(m => m.type), ['audio', 'video'])
	assert.deepEqual(parsed.media[0].formats, ['111', '126'])
	assert.equal(parsed.iceUfrag, 'abcd')
	assert.equal(parsed.icePwd, 'efghijklmnopqrstuvwx')
	assert.deepEqual(parsed.fingerprint, { algorithm: 'sha-256', value: 'AA:BB:CC' })
	assert.equal(parsed.setup, 'actpass')
	assert.equal(parsed.candidateCount, 2)
	assert.deepEqual(parsed.candidateTypes.sort(), ['host', 'relay'])
	assert.throws(() => parseSdp(''), err => err?.output?.statusCode === 400)
	assert.throws(() => parseSdp(undefined), err => err?.output?.statusCode === 400)

	const { tracker } = makeHarness()
	const { diagnostics } = collect(tracker)
	assert.equal(tracker.diagnoseSdp(sdp, 'CALL-1').candidateCount, 2)
	assert.ok(diagnostics.some(d => d.kind === 'sdp' && d.callId === 'CALL-1'))
	tracker.stop()
})

test('call-signaling: normalised type mapping matches the spec table', () => {
	assert.equal(normalizedTypeForStatus('offer', undefined), 'incoming')
	assert.equal(normalizedTypeForStatus('ringing', 'ringing'), 'ringing')
	assert.equal(normalizedTypeForStatus('relaylatency', 'ringing'), 'latency')
	assert.equal(normalizedTypeForStatus('accept', 'ringing'), 'accepted')
	assert.equal(normalizedTypeForStatus('timeout', 'ringing'), 'missed')
	assert.equal(normalizedTypeForStatus('terminate', 'accepted'), 'ended')
	assert.equal(normalizedTypeForStatus('terminate', 'ringing'), 'missed')
	assert.equal(normalizedTypeForStatus('reject', 'ringing'), 'missed')
})

test('call-signaling: opt-in socket attach via monitorCallSignaling, detach on stop', () => {
	const ev = new EventEmitter()
	const sock = { ev }
	const { tracker } = (() => {
		// monitorCallSignaling builds its own tracker with real timers;
		// use a short missed window and stop it before it can fire.
		const t = monitorCallSignaling(sock, { logger: silentLogger, missedAfterMs: 60_000 })
		return { tracker: t }
	})()
	const { events } = collect(tracker)
	ev.emit('call', [callEvent({ id: 'SOCK-1' })])
	assert.deepEqual(events.map(e => e.type), ['incoming'])
	assert.equal(tracker.getCall('SOCK-1').state, 'ringing')
	tracker.stop()
	ev.emit('call', [callEvent({ id: 'SOCK-2' })])
	assert.equal(tracker.getCall('SOCK-2'), undefined, 'no ingest after detach')
	assert.equal(typeof createCallSignalingTracker, 'function')
	assert.ok(createCallSignalingTracker({ logger: silentLogger }) instanceof CallSignalingTracker)
})
