/**
 * AunuAntiBan — lapisan perlindungan akun bawaan AunuBaileys.
 * Konsep terinspirasi baileys-antiban (kobie3717), diimplementasikan ulang
 * secara bersih di dalam paket: rate limiting dengan jitter Gaussian,
 * jadwal warmup akun baru, penjaga operasi grup, simulasi mengetik,
 * dan klasifikasi disconnect. Tanpa telemetri, tanpa jaringan tambahan.
 */
import { Boom } from '@hapi/boom'
import { DisconnectReason } from '../Types/index.js'
import type { AunuBanSentinel } from './ban-sentinel'
import { delay } from './generics.js'

/** Jitter Gaussian (Box-Muller), hasil dibatasi >= 0. */
export const gaussianJitter = (mean = 0, sigma = 1) => {
	let u = 0
	let v = 0
	while (u === 0) u = Math.random()
	while (v === 0) v = Math.random()
	const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
	return Math.max(0, mean + n * sigma)
}

/** Rate limiter jendela geser per kunci. */
export class RateLimiter {
	max: number
	windowMs: number
	hits: Map<string, number[]>

	constructor(max: number, windowMs: number) {
		this.max = max
		this.windowMs = windowMs
		this.hits = new Map()
	}

	/**
	 * AunuBaileys (1.0.74): HB-103 — acquire/tryAcquire prune a key's
	 * old timestamps but never deleted the KEY, so one entry per
	 * recipient JID accumulated for the life of the socket. Lazy
	 * sweep, run only once the map passes the threshold: evict every
	 * key whose newest hit is already outside its rate-limit window
	 * (such a key would behave as brand-new anyway — no behaviour
	 * change, amortised cost).
	 */
	sweepStaleKeys(now = Date.now()) {
		for (const [key, arr] of this.hits) {
			if (!arr.length || now - arr[arr.length - 1]! >= this.windowMs) {
				this.hits.delete(key)
			}
		}
	}

	/** Tunggu sampai ada slot untuk key; kembalikan waktu tunggu (ms). */
	async acquire(key: string): Promise<number> {
		const now = Date.now()
		if (this.hits.size > 10000) {
			this.sweepStaleKeys(now)
		}

		let arr = this.hits.get(key)
		if (!arr) {
			arr = []
			this.hits.set(key, arr)
		}

		while (arr.length && now - arr[0]! >= this.windowMs) arr.shift()
		if (arr.length >= this.max) {
			const wait = this.windowMs - (now - arr[0]!) + 5
			await delay(wait)
			return this.acquire(key)
		}

		arr.push(Date.now())
		return 0
	}

	/** Cek tanpa menunggu; true bila masih boleh. */
	tryAcquire(key: string): boolean {
		const now = Date.now()
		if (this.hits.size > 10000) {
			this.sweepStaleKeys(now)
		}

		let arr = this.hits.get(key)
		if (!arr) {
			arr = []
			this.hits.set(key, arr)
		}

		while (arr.length && now - arr[0]! >= this.windowMs) arr.shift()
		if (arr.length >= this.max) {
			return false
		}

		arr.push(now)
		return true
	}
}

export interface DisconnectClassification {
	category: string
	action: 'stop' | 'restart' | 'reconnect' | 'backoff'
	detail: string
}

/** Klasifikasi error disconnect -> kategori + tindakan yang disarankan. */
export const classifyDisconnect = (error: any): DisconnectClassification => {
	const code = error?.output?.statusCode ?? error?.statusCode ?? error
	switch (code) {
		case DisconnectReason.loggedOut:
			return { category: 'logged_out', action: 'stop', detail: 'Sesi logout — perlu pairing ulang. Jangan auto-reconnect.' }
		case DisconnectReason.restartRequired:
			return { category: 'restart_required', action: 'restart', detail: 'Server meminta restart — hubungkan ulang sekali.' }
		case DisconnectReason.connectionReplaced:
			return { category: 'replaced', action: 'stop', detail: 'Sesi digantikan koneksi lain — periksa perangkat tertaut.' }
		case DisconnectReason.badSession:
			return { category: 'bad_session', action: 'stop', detail: 'Sesi rusak — hapus auth state dan pairing ulang.' }
		case DisconnectReason.multideviceMismatch:
			return { category: 'mismatch', action: 'stop', detail: 'Ketidakcocokan multidevice — pairing ulang.' }
		case 403:
			return { category: 'forbidden', action: 'stop', detail: '403 — kemungkinan dibatasi/diblokir. Berhenti dan periksa akun.' }
		case 429:
			return { category: 'rate_limited', action: 'backoff', detail: '429 — terlalu cepat. Mundur dan turunkan laju kirim.' }
		case DisconnectReason.timedOut:
		case DisconnectReason.connectionLost:
		case DisconnectReason.connectionClosed:
		default:
			return { category: 'transient', action: 'reconnect', detail: 'Gangguan jaringan/server sementara — aman reconnect dengan jeda.' }
	}
}

export interface AunuAntiBanOptions {
	perChatPerMinute?: number
	globalPerMinute?: number
	minDelayMs?: number
	jitterMs?: number
	warmupDays?: number
	warmupStart?: number
	typingSimulation?: boolean
	groupAddMax?: number
	groupAddWindowMs?: number
	groupCreateMax?: number
	groupCreateWindowMs?: number
}

type RequiredAntiBanOptions = Required<AunuAntiBanOptions>

export class AunuAntiBan {
	/**
	 * AunuBaileys (P5): BanSentinel milik socket yang dibungkus, bila
	 * ada — diisi oleh wrap() dari `sock.aunuBanSentinel`. Murni
	 * referensi bersama; AunuAntiBan tidak membuat, mengubah, atau
	 * membaca status sentinel.
	 */
	banSentinel?: AunuBanSentinel
	options: RequiredAntiBanOptions
	perChat: RateLimiter
	global: RateLimiter
	groupAdd: RateLimiter
	groupCreate: RateLimiter

	constructor(options: AunuAntiBanOptions = {}) {
		this.options = {
			perChatPerMinute: 12,
			globalPerMinute: 60,
			minDelayMs: 700,
			jitterMs: 900,
			warmupDays: 7,
			warmupStart: Date.now(),
			typingSimulation: true,
			groupAddMax: 3,
			groupAddWindowMs: 600000,
			groupCreateMax: 2,
			groupCreateWindowMs: 600000,
			...options
		}
		const o = this.options
		this.perChat = new RateLimiter(o.perChatPerMinute, 60000)
		this.global = new RateLimiter(o.globalPerMinute, 60000)
		this.groupAdd = new RateLimiter(o.groupAddMax, o.groupAddWindowMs)
		this.groupCreate = new RateLimiter(o.groupCreateMax, o.groupCreateWindowMs)
	}

	/** Faktor warmup 0.3 -> 1.0 selama warmupDays sejak warmupStart. */
	warmupFactor() {
		const days = (Date.now() - this.options.warmupStart) / 86400000
		if (days >= this.options.warmupDays) {
			return 1
		}

		return 0.3 + 0.7 * Math.max(0, days / this.options.warmupDays)
	}

	/** Batasi laju efektif mengikuti warmup. */
	effectiveLimit(base: number) {
		return Math.max(1, Math.floor(base * this.warmupFactor()))
	}

	/** Terapkan perlindungan ke socket; socket yang sama dikembalikan. */
	wrap<T extends any>(sock: T): T {
		const self = this
		const s = sock as any
		const origSend = s.sendMessage.bind(s)
		s.sendMessage = async (jid: string, content: any, options: any) => {
			await self.global.acquire('__global__')
			await self.perChat.acquire(jid)
			if (self.options.typingSimulation && (content?.text || content?.caption) && typeof s.sendPresenceUpdate === 'function') {
				try {
					await s.sendPresenceUpdate('composing', jid)
				} catch {}
			}

			const wait = self.options.minDelayMs * self.warmupFactor() + gaussianJitter(0, self.options.jitterMs / 2)
			if (wait > 0) {
				await delay(wait)
			}

			return origSend(jid, content, options)
		}
		if (typeof s.groupParticipantsUpdate === 'function') {
			const orig = s.groupParticipantsUpdate.bind(s)
			s.groupParticipantsUpdate = async (jid: string, participants: any, action: string, inviteMessage: any) => {
				if (action === 'add' && !self.groupAdd.tryAcquire(jid)) {
					throw new Boom('AunuAntiBan: batas tambah anggota grup tercapai — jeda dulu agar akun aman', { statusCode: 429 })
				}

				return orig(jid, participants, action, inviteMessage)
			}
		}

		if (typeof s.groupCreate === 'function') {
			const origCreate = s.groupCreate.bind(s)
			s.groupCreate = async (subject: string, participants: any) => {
				if (!self.groupCreate.tryAcquire('__create__')) {
					throw new Boom('AunuAntiBan: batas buat grup tercapai — jeda dulu agar akun aman', { statusCode: 429 })
				}

				return origCreate(subject, participants)
			}
		}

		s.aunuAntiBan = self
		// AunuBaileys (P5): socket dari makeWASocket membawa sentinel
		// yang sama sebagai sock.aunuBanSentinel — buat ia terlihat
		// juga dari lapisan ini (satu instance, dua jalan akses).
		if (s.aunuBanSentinel) {
			self.banSentinel = s.aunuBanSentinel
		}

		return sock
	}
}

export interface ReconnectDelayOptions {
	baseDelayMs?: number
	maxDelayMs?: number
}

/**
 * Jeda reconnect yang disarankan, pendamping classifyDisconnect.
 * Mengembalikan milidetik untuk menunggu sebelum reconnect, atau null
 * bila koneksi TIDAK boleh disambung ulang otomatis (sesi logout,
 * digantikan, rusak, atau 403). `reason` boleh berupa error Boom,
 * kode status numerik, atau hasil classifyDisconnect ({ action } /
 * { category }). Backoff eksponensial + jitter Gaussian; kategori
 * rate_limited memakai basis dan plafon jauh lebih besar karena
 * reconnect terlalu cepat pada 429 memperburuk pembatasan.
 */
export const getReconnectDelay = (attempt: number, reason: any, options: ReconnectDelayOptions = {}): number | null => {
	const a = Math.max(0, Math.floor(+attempt) || 0)
	let action: string
	if (reason && typeof reason === 'object' && typeof reason.action === 'string') {
		action = reason.action
	} else if (reason && typeof reason === 'object' && typeof reason.category === 'string') {
		action =
			({
				logged_out: 'stop',
				replaced: 'stop',
				bad_session: 'stop',
				mismatch: 'stop',
				forbidden: 'stop',
				restart_required: 'restart',
				rate_limited: 'backoff',
				transient: 'reconnect'
			} as { [category: string]: string })[reason.category] ?? 'reconnect'
	} else {
		action = classifyDisconnect(reason).action
	}

	if (action === 'stop') {
		return null
	}

	if (action === 'restart') {
		return 0
	}

	const isRateLimited = action === 'backoff'
	const base = options.baseDelayMs ?? (isRateLimited ? 30000 : 1000)
	const cap = options.maxDelayMs ?? (isRateLimited ? 900000 : 60000)
	const grown = Math.min(cap, base * 2 ** a)
	return Math.round(grown + gaussianJitter(0, grown * 0.1))
}

/** Bungkus socket dengan AunuAntiBan (jalan pintas). */
export const wrapAntiBan = (sock: any, options?: AunuAntiBanOptions) => new AunuAntiBan(options).wrap(sock)
