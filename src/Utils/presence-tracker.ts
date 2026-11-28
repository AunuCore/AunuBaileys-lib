// AunuBaileys (2.6.0, delta run-0936 — presence tracker, clean-room
// reimplementation from the ledger spec, NOT a port): host-side
// presence tracking. The socket itself only forwards `presence.update`
// events (src/Socket/chats.ts); it keeps no per-contact state. This
// module fills that gap for hosts that need to know who is online,
// for how long, and when that changed — without touching the wire.
//
//   const tracker = monitorPresence(sock, { staleAfterMs: 5 * 60_000 })
//   tracker.subscribe('62812xxxx@s.whatsapp.net')
//   tracker.on('presence.change', ({ jid, presence, previousPresence }) => ...)
//   tracker.on('presence.diagnostic', event => ...)
//
// The tracker is purely observational: it never sends anything and
// never mutates socket state. `subscribe()` only selects which JIDs
// are tracked; asking the server to send presence for a JID stays
// the host's job (`sock.presenceSubscribe(jid)`).
import { EventEmitter } from 'events'
import { Boom } from '@hapi/boom'
import { jidNormalizedUser } from '../WABinary'
import type { WAPresence, PresenceData } from '../Types/Chat'
import type { ILogger } from './logger'

const ONLINE_PRESENCES: ReadonlySet<WAPresence> = new Set(['available', 'composing', 'recording'])
const OFFLINE_PRESENCES: ReadonlySet<WAPresence> = new Set(['unavailable', 'paused'])
const ALL_PRESENCES: ReadonlySet<string> = new Set([...ONLINE_PRESENCES, ...OFFLINE_PRESENCES])

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000
const DEFAULT_MAX_SESSIONS_PER_CONTACT = 20
const DEFAULT_MAX_CONTACTS = 5000

/** A single continuous online episode for one contact. */
export type PresenceSession = {
	jid: string
	startedAt: number
	endedAt?: number
	/** Set once the session ends; undefined while it is still open. */
	durationMs?: number
	/** Presence value that opened the session. */
	presence: WAPresence
}

export type PresenceDiagnosticKind =
	| 'presence-change'
	| 'session-start'
	| 'session-end'
	| 'subscribe'
	| 'unsubscribe'
	| 'stale'
	| 'unknown-presence'
	| 'evict'
	| 'error'

export type PresenceDiagnosticEvent = {
	kind: PresenceDiagnosticKind
	jid?: string
	presence?: WAPresence
	previousPresence?: WAPresence
	at: number
	detail?: string
}

export type PresenceChangeEvent = {
	jid: string
	presence: WAPresence
	previousPresence?: WAPresence
	at: number
}

export type ContactPresence = {
	jid: string
	presence: WAPresence
	/** Epoch ms of the last accepted presence change. */
	lastChangeAt: number
	/** Server-reported last-seen, when the update carried one. */
	lastSeen?: number
	/** Epoch ms the current online session started; undefined while offline. */
	onlineSince?: number
	/** Total online time across closed sessions, in ms. */
	totalOnlineMs: number
	/** True when the stale sweep has flagged this contact (no update within staleAfterMs). */
	stale: boolean
	updates: number
	sessions: PresenceSession[]
}

export type ParsedTimezone =
	| { type: 'iana'; timeZone: string }
	| { type: 'offset'; offsetMinutes: number }

export type PresenceTrackerOptions = {
	logger?: ILogger
	/** IANA zone name (e.g. 'Asia/Jakarta') or a fixed offset ('+07:00'). Defaults to the host zone. */
	timeZone?: string
	/** Ms without an update before a contact is flagged stale; 0 disables the sweep. Default 10 min. */
	staleAfterMs?: number
	/** Sessions kept per contact (oldest dropped first). Default 20. */
	maxSessionsPerContact?: number
	/** Contacts tracked at once (oldest untouched evicted first). Default 5000. */
	maxContacts?: number
	/** Track every JID seen in a presence.update, not just subscribed ones. Default false. */
	subscribeAll?: boolean
	/** Clock override (tests); defaults to Date.now. */
	now?: () => number
}

let defaultTimeZone = 'UTC'
try {
	defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
} catch {
	// Host without ICU data: UTC is the only safe default.
	defaultTimeZone = 'UTC'
}

export const getDefaultTimezone = () => defaultTimeZone

export const setDefaultTimezone = (timeZone: string) => {
	// Validates (throws Boom 400 when unknown) before adopting it.
	parseTimezone(timeZone)
	defaultTimeZone = timeZone
	return defaultTimeZone
}

const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/

/** Validate a timezone: IANA name, 'UTC', or a fixed '+HH:MM' offset. Throws Boom 400 otherwise. */
export const parseTimezone = (value: unknown): ParsedTimezone => {
	if (typeof value !== 'string' || !value) {
		throw new Boom('parseTimezone: a timezone string is required', { statusCode: 400 })
	}
	const offset = OFFSET_RE.exec(value)
	if (offset) {
		const hours = Number(offset[2])
		const minutes = Number(offset[3])
		if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
			throw new Boom(`parseTimezone: offset out of range: ${value}`, { statusCode: 400 })
		}
		const total = hours * 60 + minutes
		return { type: 'offset', offsetMinutes: (offset[1] === '-' ? -1 : 1) * total }
	}
	try {
		// Throws RangeError for unknown zones; the constructor is the validation.
		new Intl.DateTimeFormat('en-US', { timeZone: value })
	} catch {
		throw new Boom(`parseTimezone: unknown timezone: ${value}`, { statusCode: 400 })
	}
	return { type: 'iana', timeZone: value }
}

const resolveTimezone = (timeZone?: string): ParsedTimezone =>
	timeZone === undefined ? parseTimezone(defaultTimeZone) : parseTimezone(timeZone)

const pad2 = (n: number) => String(n).padStart(2, '0')

const formatInOffset = (date: Date, offsetMinutes: number, withDate: boolean) => {
	const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
	const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`
	if (!withDate) {
		return time
	}
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${time}`
}

const formatInIana = (date: Date, timeZone: string, withDate: boolean) => {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).formatToParts(date)
	const get = (type: string) => parts.find(p => p.type === type)?.value || ''
	const time = `${get('hour')}:${get('minute')}:${get('second')}`
	if (!withDate) {
		return time
	}
	return `${get('year')}-${get('month')}-${get('day')} ${time}`
}

const toDate = (value: Date | number): Date => {
	const date = value instanceof Date ? value : new Date(value)
	if (!Number.isFinite(date.getTime())) {
		throw new Boom('presence-tracker: invalid date', { statusCode: 400 })
	}
	return date
}

/** '1d 2h 3m 4s' for a duration; throws Boom 400 on non-finite or negative input. */
export const formatDuration = (ms: number): string => {
	if (!Number.isFinite(ms) || ms < 0) {
		throw new Boom('formatDuration: duration must be a finite non-negative number of ms', { statusCode: 400 })
	}
	const totalSeconds = Math.floor(ms / 1000)
	const days = Math.floor(totalSeconds / 86_400)
	const hours = Math.floor((totalSeconds % 86_400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	const parts: string[] = []
	if (days > 0) {
		parts.push(`${days}d`)
	}
	if (hours > 0 || days > 0) {
		parts.push(`${hours}h`)
	}
	if (minutes > 0 || hours > 0 || days > 0) {
		parts.push(`${minutes}m`)
	}
	parts.push(`${seconds}s`)
	return parts.join(' ')
}

/** 'HH:MM:SS' in the given (or default) timezone. */
export const formatTime = (date: Date | number, timeZone?: string): string => {
	const parsed = resolveTimezone(timeZone)
	const d = toDate(date)
	return parsed.type === 'offset' ? formatInOffset(d, parsed.offsetMinutes, false) : formatInIana(d, parsed.timeZone, false)
}

/** 'YYYY-MM-DD HH:MM:SS' in the given (or default) timezone. */
export const formatDateTime = (date: Date | number, timeZone?: string): string => {
	const parsed = resolveTimezone(timeZone)
	const d = toDate(date)
	return parsed.type === 'offset' ? formatInOffset(d, parsed.offsetMinutes, true) : formatInIana(d, parsed.timeZone, true)
}

/** 'just now' / '45s ago' / '3m ago' / '2h ago' / '5d ago'; future dates read 'in …'. */
export const formatTimeAgo = (date: Date | number, now: Date | number = Date.now()): string => {
	const then = toDate(date).getTime()
	const nowMs = toDate(now).getTime()
	const diff = nowMs - then
	if (diff < 0) {
		return `in ${formatDuration(-diff)}`
	}
	if (diff < 5000) {
		return 'just now'
	}
	return `${formatDuration(diff)} ago`
}

/** Normalise a contact JID the way the rest of the tree does; undefined for anything unusable. */
export const normalizeContactJid = (jid: unknown): string | undefined => {
	if (typeof jid !== 'string' || !jid) {
		return undefined
	}
	try {
		const normalized = jidNormalizedUser(jid)
		return normalized || undefined
	} catch {
		return undefined
	}
}

export const isOnlinePresence = (presence: unknown): presence is WAPresence =>
	typeof presence === 'string' && ONLINE_PRESENCES.has(presence as WAPresence)

export const isOfflinePresence = (presence: unknown): presence is WAPresence =>
	typeof presence === 'string' && OFFLINE_PRESENCES.has(presence as WAPresence)

const isValidPresence = (presence: unknown): presence is WAPresence =>
	typeof presence === 'string' && ALL_PRESENCES.has(presence)

type SocketLike = {
	ev: {
		on: (event: string, listener: (...args: never[]) => void) => void
		off: (event: string, listener: (...args: never[]) => void) => void
	}
}

export class PresenceTracker extends EventEmitter {
	private logger: ILogger | undefined
	private timeZone: ParsedTimezone
	private staleAfterMs: number
	private maxSessionsPerContact: number
	private maxContacts: number
	private subscribeAll: boolean
	private nowFn: () => number
	private subscribed = new Set<string>()
	private contacts = new Map<string, ContactPresence>()
	private sweepTimer: ReturnType<typeof setInterval> | undefined
	private socket: SocketLike | undefined
	private presenceListener: ((update: { id: string; presences: { [participant: string]: PresenceData } }) => void) | undefined
	private connectionListener: ((update: { connection?: string }) => void) | undefined
	private socketState: string | undefined
	private socketStateAt: number | undefined

	constructor(options: PresenceTrackerOptions = {}) {
		super()
		this.logger = options.logger
		this.timeZone = resolveTimezone(options.timeZone)
		// AunuBaileys (1.0.80, HB-145): numeric config is sanitised at
		// the boundary — a NaN/negative stale window would either
		// never fire or flag everything stale on the first sweep.
		this.staleAfterMs =
			Number.isFinite(options.staleAfterMs) && (options.staleAfterMs as number) > 0
				? (options.staleAfterMs as number)
				: options.staleAfterMs === 0
					? 0
					: DEFAULT_STALE_AFTER_MS
		this.maxSessionsPerContact =
			Number.isFinite(options.maxSessionsPerContact) && (options.maxSessionsPerContact as number) > 0
				? Math.floor(options.maxSessionsPerContact as number)
				: DEFAULT_MAX_SESSIONS_PER_CONTACT
		this.maxContacts =
			Number.isFinite(options.maxContacts) && (options.maxContacts as number) > 0
				? Math.floor(options.maxContacts as number)
				: DEFAULT_MAX_CONTACTS
		this.subscribeAll = options.subscribeAll === true
		this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
	}

	/** Start the stale sweep (no-op when staleAfterMs is 0). Safe to call twice. */
	start(): this {
		if (this.sweepTimer || this.staleAfterMs <= 0) {
			return this
		}
		this.sweepTimer = setInterval(() => this.sweepStale(), this.staleAfterMs)
		// The sweep must never keep a host process alive on its own.
		if (typeof this.sweepTimer === 'object' && typeof (this.sweepTimer as unknown as { unref?: () => void }).unref === 'function') {
			;(this.sweepTimer as unknown as { unref: () => void }).unref()
		}
		return this
	}

	/** Stop the sweep and, when attached, detach from the socket. Safe to call twice. */
	stop(): this {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer)
			this.sweepTimer = undefined
		}
		this.detachSocket()
		return this
	}

	subscribe(jid: string): boolean {
		const normalized = normalizeContactJid(jid)
		if (!normalized) {
			this.diagnostic({ kind: 'error', at: this.nowFn(), detail: `subscribe: invalid jid: ${String(jid)}` })
			return false
		}
		if (this.subscribed.has(normalized)) {
			return false
		}
		this.subscribed.add(normalized)
		this.evictSubscribedIfOverCap(normalized)
		this.diagnostic({ kind: 'subscribe', jid: normalized, at: this.nowFn() })
		return true
	}

	unsubscribe(jid: string): boolean {
		const normalized = normalizeContactJid(jid)
		if (!normalized || !this.subscribed.has(normalized)) {
			return false
		}
		this.subscribed.delete(normalized)
		this.diagnostic({ kind: 'unsubscribe', jid: normalized, at: this.nowFn() })
		return true
	}

	isSubscribed(jid: string): boolean {
		const normalized = normalizeContactJid(jid)
		return normalized !== undefined && this.subscribed.has(normalized)
	}

	subscribedJids(): string[] {
		return [...this.subscribed]
	}

	/**
	 * Feed one `presence.update` payload (`{ id, presences }`) into the
	 * tracker. Only subscribed JIDs are tracked (unless `subscribeAll`
	 * is on); unknown presence values are reported as diagnostics and
	 * skipped, never stored.
	 */
	ingest(update: { id: string; presences: { [participant: string]: PresenceData } }): void {
		if (!update || typeof update !== 'object' || !update.presences || typeof update.presences !== 'object') {
			this.diagnostic({ kind: 'error', at: this.nowFn(), detail: 'ingest: presence.update without a presences map' })
			return
		}
		const at = this.nowFn()
		for (const [rawJid, data] of Object.entries(update.presences)) {
			const jid = normalizeContactJid(rawJid)
			if (!jid) {
				this.diagnostic({ kind: 'unknown-presence', at, detail: `ingest: unusable participant jid: ${String(rawJid)}` })
				continue
			}
			if (!data || typeof data !== 'object' || !isValidPresence(data.lastKnownPresence)) {
				this.diagnostic({
					kind: 'unknown-presence',
					jid,
					at,
					detail: `ingest: unknown presence value: ${String(data?.lastKnownPresence)}`
				})
				continue
			}
			if (!this.subscribed.has(jid)) {
				if (!this.subscribeAll) {
					continue
				}
				this.subscribed.add(jid)
				this.evictSubscribedIfOverCap(jid)
				this.diagnostic({ kind: 'subscribe', jid, at })
			}
			this.applyPresence(jid, data.lastKnownPresence, data.lastSeen, at)
		}
	}

	/** The last known record for a contact, or undefined when never seen. */
	getPresence(jid: string): ContactPresence | undefined {
		const normalized = normalizeContactJid(jid)
		if (!normalized) {
			return undefined
		}
		const record = this.contacts.get(normalized)
		return record ? { ...record, sessions: record.sessions.map(s => ({ ...s })) } : undefined
	}

	getAllPresences(): ContactPresence[] {
		return [...this.contacts.values()].map(r => ({ ...r, sessions: r.sessions.map(s => ({ ...s })) }))
	}

	getOnlineJids(): string[] {
		return [...this.contacts.values()].filter(r => isOnlinePresence(r.presence)).map(r => r.jid)
	}

	/** Point-in-time view of the tracker (and the socket, when attached). */
	snapshot(): {
		at: number
		timeZone: string
		subscribed: string[]
		onlineCount: number
		contacts: ContactPresence[]
		socketState?: string
		socketStateAt?: number
	} {
		return {
			at: this.nowFn(),
			timeZone: this.timeZone.type === 'iana' ? this.timeZone.timeZone : `UTC${this.timeZone.offsetMinutes >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(this.timeZone.offsetMinutes) / 60))}:${pad2(Math.abs(this.timeZone.offsetMinutes) % 60)}`,
			subscribed: this.subscribedJids(),
			onlineCount: this.getOnlineJids().length,
			contacts: this.getAllPresences(),
			socketState: this.socketState,
			socketStateAt: this.socketStateAt
		}
	}

	/** Human-readable one-liner for a contact, e.g. `62812… online for 3m 12s`. */
	describe(jid: string): string | undefined {
		const record = this.getPresence(jid)
		if (!record) {
			return undefined
		}
		const online = isOnlinePresence(record.presence)
		const since = online && record.onlineSince ? formatDuration(this.nowFn() - record.onlineSince) : undefined
		const seen = record.lastSeen ? formatTimeAgo(record.lastSeen * 1000, this.nowFn()) : undefined
		if (online) {
			return `${record.jid} ${record.presence}${since ? ` for ${since}` : ''}`
		}
		return `${record.jid} ${record.presence}${seen ? ` (last seen ${seen})` : ''}`
	}

	/** Attach to a socket's event emitter (presence.update + connection.update). */
	attach(sock: SocketLike): this {
		if (!sock?.ev || typeof sock.ev.on !== 'function' || typeof sock.ev.off !== 'function') {
			throw new Boom('PresenceTracker.attach: socket with ev.on/ev.off is required', { statusCode: 400 })
		}
		this.detachSocket()
		this.socket = sock
		this.presenceListener = update => {
			try {
				this.ingest(update)
			} catch (error) {
				this.logger?.error({ err: error }, 'presence tracker ingest failed')
			}
		}
		this.connectionListener = update => {
			if (update && typeof update.connection === 'string') {
				this.socketState = update.connection
				this.socketStateAt = this.nowFn()
			}
		}
		sock.ev.on('presence.update', this.presenceListener as (...args: never[]) => void)
		sock.ev.on('connection.update', this.connectionListener as (...args: never[]) => void)
		return this
	}

	detachSocket(): this {
		if (this.socket) {
			if (this.presenceListener) {
				try {
					this.socket.ev.off('presence.update', this.presenceListener as (...args: never[]) => void)
				} catch {
					// Detach is best-effort; a dead emitter must not throw out of stop().
				}
			}
			if (this.connectionListener) {
				try {
					this.socket.ev.off('connection.update', this.connectionListener as (...args: never[]) => void)
				} catch {
					// See above.
				}
			}
		}
		this.socket = undefined
		this.presenceListener = undefined
		this.connectionListener = undefined
		return this
	}

	/** Flag contacts with no update inside staleAfterMs (does not change their presence). */
	sweepStale(now = this.nowFn()): string[] {
		if (this.staleAfterMs <= 0) {
			return []
		}
		const stale: string[] = []
		for (const record of this.contacts.values()) {
			if (now - record.lastChangeAt >= this.staleAfterMs && !record.stale) {
				record.stale = true
				stale.push(record.jid)
				this.diagnostic({ kind: 'stale', jid: record.jid, presence: record.presence, at: now, detail: `no update for ${formatDuration(now - record.lastChangeAt)}` })
			}
		}
		return stale
	}

	private applyPresence(jid: string, presence: WAPresence, lastSeen: number | undefined, at: number): void {
		let record = this.contacts.get(jid)
		if (!record) {
			record = {
				jid,
				presence,
				lastChangeAt: at,
				totalOnlineMs: 0,
				stale: false,
				updates: 0,
				sessions: []
			}
			this.contacts.set(jid, record)
			this.evictOldestIfOverCap(jid)
		}
		const previousPresence = record.presence
		const changed = record.updates > 0 && previousPresence !== presence
		record.updates += 1
		record.stale = false
		if (typeof lastSeen === 'number' && Number.isFinite(lastSeen)) {
			record.lastSeen = lastSeen
		}
		if (!changed && record.updates > 1) {
			// Same presence re-reported: refresh the clock, keep the session.
			record.lastChangeAt = at
			return
		}
		record.presence = presence
		record.lastChangeAt = at
		const wasOnline = isOnlinePresence(previousPresence)
		const nowOnline = isOnlinePresence(presence)
		if (record.updates === 1) {
			// First sighting: open a session when the contact is online.
			if (nowOnline) {
				this.openSession(record, presence, at)
			}
		} else if (!wasOnline && nowOnline) {
			this.openSession(record, presence, at)
		} else if (wasOnline && !nowOnline) {
			this.closeSession(record, at)
		}
		if (changed) {
			const change: PresenceChangeEvent = { jid, presence, previousPresence, at }
			// AunuBaileys (2.9.0, HB-512): a throwing 'presence.change'
			// listener used to propagate out of the ingest() loop; the
			// socket listener caught and logged it, silently dropping
			// every remaining presence in the batch. Isolate it so the
			// rest of the batch still applies.
			try {
				this.emit('presence.change', change)
			} catch (error) {
				this.logger?.warn({ err: error, jid }, 'presence change listener threw')
			}
			this.diagnostic({ kind: 'presence-change', jid, presence, previousPresence, at })
		}
	}

	private openSession(record: ContactPresence, presence: WAPresence, at: number): void {
		record.onlineSince = at
		const session: PresenceSession = { jid: record.jid, startedAt: at, presence }
		record.sessions.push(session)
		if (record.sessions.length > this.maxSessionsPerContact) {
			record.sessions.splice(0, record.sessions.length - this.maxSessionsPerContact)
		}
		this.diagnostic({ kind: 'session-start', jid: record.jid, presence, at })
	}

	private closeSession(record: ContactPresence, at: number): void {
		const session = record.sessions[record.sessions.length - 1]
		if (session && session.endedAt === undefined) {
			session.endedAt = at
			session.durationMs = at - session.startedAt
			record.totalOnlineMs += session.durationMs
		}
		record.onlineSince = undefined
		this.diagnostic({ kind: 'session-end', jid: record.jid, presence: record.presence, at })
	}

	// AunuBaileys (2.8.0, HB-506): `subscribed` gets the same cap as
	// `contacts`. With subscribeAll every presence.update auto-added
	// its JID here, and only `contacts` was ever pruned — the set
	// grew without bound for the life of the tracker. Insertion order
	// is oldest-first, so eviction drops the longest-held entries.
	private evictSubscribedIfOverCap(exceptJid: string): void {
		while (this.subscribed.size > this.maxContacts) {
			let evicted = false
			for (const jid of this.subscribed) {
				if (jid === exceptJid) {
					continue
				}

				this.subscribed.delete(jid)
				evicted = true
				break
			}

			if (!evicted) {
				break
			}
		}
	}

	private evictOldestIfOverCap(exceptJid: string): void {
		this.evictSubscribedIfOverCap(exceptJid)
		if (this.contacts.size <= this.maxContacts) {
			return
		}
		let oldest: ContactPresence | undefined
		for (const record of this.contacts.values()) {
			if (record.jid === exceptJid) {
				continue
			}
			if (!oldest || record.lastChangeAt < oldest.lastChangeAt) {
				oldest = record
			}
		}
		if (oldest) {
			this.contacts.delete(oldest.jid)
			this.diagnostic({ kind: 'evict', jid: oldest.jid, at: this.nowFn(), detail: 'maxContacts reached' })
		}
	}

	private diagnostic(event: PresenceDiagnosticEvent): void {
		this.logger?.debug({ diagnostic: event }, 'presence diagnostic')
		// AunuBaileys (2.9.0, HB-512): diagnostic() is also reached from
		// the stale-sweep timer (start → sweepStale), where a throwing
		// 'presence.diagnostic' listener escaped as an uncaught
		// exception and could kill the host process. Isolate listener
		// failures here so no emit site has to defend itself.
		try {
			this.emit('presence.diagnostic', event)
		} catch (error) {
			this.logger?.warn({ err: error }, 'presence diagnostic listener threw')
		}
	}
}

/**
 * Attach a tracker to a socket and return it. The tracker starts its
 * stale sweep immediately; `tracker.stop()` detaches it again.
 */
export const monitorPresence = (sock: SocketLike, options: PresenceTrackerOptions = {}): PresenceTracker => {
	const tracker = new PresenceTracker(options)
	tracker.attach(sock)
	tracker.start()
	return tracker
}

/** Alias kept for parity with the upstream naming. */
export const createPresenceTracker = monitorPresence
