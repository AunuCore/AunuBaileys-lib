/**
 * AunuBanSentinel — guard anti-ban persisten AunuBaileys (P5, 2.0.0).
 * Implementasi bersih (clean-room) dari PERILAKU referensi yang diamati
 * pada fork lain (ban-sentinel): deteksi kata kunci ban pada teks
 * kegagalan, kode putus berbahaya 401/403/440, dan kegagalan beruntun
 * (burst) — ketiganya memicu guard persisten + cooldown (bawaan 60
 * menit), dan selama cooldown aktif upaya connect baru ditolak dengan
 * Boom 503. Tidak ada kode referensi yang disalin; struktur, API, dan
 * standar guardrail mengikuti tree ini.
 *
 * Desain:
 * - Mesin state murni + adaptor penyimpanan (`BanGuardStore`): file
 *   (atomik: tulis tmp + rename) atau memori. Seluruh I/O sinkron dan
 *   terkurung try/catch — gate connect berjalan sinkron di konstruksi
 *   socket, jadi status guard harus bisa diputuskan tanpa await.
 * - Sentinel TIDAK PERNAH melempar dari jalur pengamat
 *   (`noteFailure`/`noteDisconnect`/`noteStreamError`): ia tidak boleh
 *   membunuh socket yang ia lindungi. Satu-satunya throw yang disengaja
 *   adalah `assertCanConnect()` (Boom 503) di gate connect.
 * - Kegagalan filesystem (direktori tak bisa ditulis, file korup/JSON
 *   rusak) menurunkan sentinel ke mode memori-saja dengan log warn —
 *   tidak pernah crash, dan tidak pernah memblokir connect hanya
 *   karena guard-nya sendiri gagal ditulis/dibaca. File korup
 *   diperlakukan sebagai tidak ada guard.
 * - Tanpa timer: jendela burst dihitung dari cap waktu kegagalan,
 *   jadi tidak ada interval/listener yang perlu dibersihkan.
 */
import { Boom } from '@hapi/boom'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ILogger } from './logger'

/** Kata kunci ban bawaan (dari perilaku referensi; cocok sebagian, huruf kecil). */
export const DEFAULT_BAN_KEYWORDS: readonly string[] = [
	'restricted',
	'banned',
	'forbidden',
	'too many requests',
	'rate limit',
	'ratelimit',
	'spam',
	'account blocked',
	'account has been',
	'temporarily blocked',
	'not-authorized',
	'not authorized',
	'invalid session'
]

/** Kode putus yang langsung memicu guard. */
export const DEFAULT_BAN_CLOSE_CODES: readonly number[] = [401, 403, 440]

/** Kode stream error yang langsung memicu guard (jalur `noteStreamError`). */
export const DEFAULT_STREAM_ERROR_CODES: readonly number[] = [400, 401, 403, 409, 429, 440, 500, 503]

export const DEFAULT_BAN_COOLDOWN_MS = 60 * 60 * 1000
export const DEFAULT_BAN_BURST_THRESHOLD = 5
export const DEFAULT_BAN_BURST_WINDOW_MS = 30 * 1000
export const DEFAULT_BAN_GUARD_FILENAME = '.baileys-ban-guard.json'

/** Catatan guard yang dipersistkan. */
export interface BanGuardRecord {
	triggeredAt: number
	until: number
	reason: string
	code?: number
}

export interface BanSentinelStatus {
	active: boolean
	remainingMs: number
	until: number | null
	triggeredAt: number | null
	reason: string | null
	code?: number
}

export type BanSentinelLogger = Pick<ILogger, 'warn' | 'error' | 'info'>

/** Opsi yang boleh datang dari `SocketConfig.banSentinel`. */
export interface BanSentinelSocketOptions {
	enabled?: boolean
	/** Cooldown setelah guard terpicu. Bawaan 60 menit. */
	cooldownMs?: number
	/** Jumlah kegagalan dalam jendela yang memicu guard. Bawaan 5. */
	burstThreshold?: number
	/** Jendela hitung burst (ms). Bawaan 30 detik. */
	burstWindowMs?: number
	/**
	 * Lokasi file guard. Bawaan: `.baileys-ban-guard.json` di cwd proses
	 * (paritas referensi). Host multi-akun WAJIB memberi path per akun
	 * (idealnya di dalam direktori auth akun itu) agar satu akun yang
	 * terpicu tidak memblokir akun lain. `null` = mode memori-saja.
	 */
	guardFilePath?: string | null
	/** Kata kunci tambahan di luar daftar bawaan. */
	keywords?: string[]
	/** Kata kunci bawaan yang dilepas dari daftar. */
	removeKeywords?: string[]
	/** Mengganti seluruh daftar kode putus berbahaya (bawaan 401/403/440). */
	banCloseCodes?: number[]
	/** Dipanggil sekali saat guard terpicu; error di dalamnya diabaikan. */
	onTrip?: (record: BanGuardRecord) => void
}

export interface AunuBanSentinelOptions extends BanSentinelSocketOptions {
	logger?: BanSentinelLogger
	/** Adaptor penyimpanan kustom; mengalahkan `guardFilePath`. */
	store?: BanGuardStore
	/** Jam yang bisa disuntik (seam uji); bawaan `Date.now`. */
	now?: () => number
}

export type BanSentinelConfigValue = boolean | BanSentinelSocketOptions

/** Adaptor penyimpanan catatan guard. Semua metode TIDAK boleh melempar. */
export interface BanGuardStore {
	readonly persistent: boolean
	load(): BanGuardRecord | null
	/** Kembalikan false bila persistensi gagal (sentinel lanjut memori-saja). */
	save(record: BanGuardRecord): boolean
	clear(): void
}

/** Store memori-saja: guard hilang saat proses mati. */
export class MemoryBanGuardStore implements BanGuardStore {
	readonly persistent = false
	private record: BanGuardRecord | null = null

	load(): BanGuardRecord | null {
		return this.record ? { ...this.record } : null
	}

	save(record: BanGuardRecord): boolean {
		this.record = { ...record }
		return true
	}

	clear(): void {
		this.record = null
	}
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Terima bentuk catatan kita; bentuk warisan referensi dipetakan sebisa mungkin. */
const parseGuardRecord = (raw: unknown): BanGuardRecord | null => {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null
	}

	const r = raw as { [key: string]: unknown }
	if (isFiniteNumber(r.until) && isFiniteNumber(r.triggeredAt) && typeof r.reason === 'string') {
		return {
			triggeredAt: r.triggeredAt,
			until: r.until,
			reason: r.reason,
			...(isFiniteNumber(r.code) ? { code: r.code } : {})
		}
	}

	// Bentuk warisan: { cooldownUntil, reason, lastTrigger }
	if (isFiniteNumber(r.cooldownUntil) && typeof r.reason === 'string') {
		const parsed = typeof r.lastTrigger === 'string' ? Date.parse(r.lastTrigger) : NaN
		return { triggeredAt: Number.isFinite(parsed) ? parsed : 0, until: r.cooldownUntil, reason: r.reason }
	}

	return null
}

/** Store file: tulis atomik (tmp + rename), semua kegagalan ditelan. */
export class FileBanGuardStore implements BanGuardStore {
	readonly persistent = true
	readonly path: string
	private failed = false

	constructor(path: string) {
		this.path = path
	}

	/** true setelah satu penulisan gagal (store ini berhenti mencoba menulis). */
	get hasFailed(): boolean {
		return this.failed
	}

	load(): BanGuardRecord | null {
		try {
			if (!existsSync(this.path)) {
				return null
			}

			// JSON rusak / bentuk tak dikenal = tidak ada guard.
			return parseGuardRecord(JSON.parse(readFileSync(this.path, 'utf8')))
		} catch {
			return null
		}
	}

	save(record: BanGuardRecord): boolean {
		if (this.failed) {
			return false
		}

		const tmpPath = `${this.path}.tmp-${process.pid}`
		try {
			mkdirSync(dirname(this.path), { recursive: true })
			writeFileSync(tmpPath, JSON.stringify(record, null, 2))
			renameSync(tmpPath, this.path)
			return true
		} catch {
			this.failed = true
			try {
				unlinkSync(tmpPath)
			} catch {}

			return false
		}
	}

	clear(): void {
		try {
			unlinkSync(this.path)
		} catch {}
	}
}

// Sanitise angka di batas masuk (pola guardrail HB-139): nilai tak
// hingga / bukan angka / di luar rentang jatuh ke bawaan, tak pernah
// diteruskan mentah ke logika.
const positiveFiniteOr = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const burstThresholdOr = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_BAN_BURST_THRESHOLD

const normaliseKeywords = (list: readonly string[] | undefined, base: readonly string[]): string[] => {
	const out: string[] = []
	const push = (kw: unknown) => {
		if (typeof kw !== 'string') {
			return
		}

		const norm = kw.trim().toLowerCase()
		if (norm && !out.includes(norm)) {
			out.push(norm)
		}
	}

	for (const kw of base) push(kw)
	if (list) {
		for (const kw of list) push(kw)
	}

	return out
}

const extractText = (input: unknown): string => {
	if (typeof input === 'string') {
		return input
	}

	if (input instanceof Error) {
		return input.message || String(input)
	}

	if (input && typeof input === 'object') {
		const msg = (input as { message?: unknown }).message
		if (typeof msg === 'string') {
			return msg
		}
	}

	return ''
}

const extractCode = (input: unknown): number | undefined => {
	if (typeof input === 'number' && Number.isFinite(input)) {
		return input
	}

	if (input && typeof input === 'object') {
		const o = input as {
			statusCode?: unknown
			code?: unknown
			output?: { statusCode?: unknown }
			data?: { statusCode?: unknown }
		}
		for (const candidate of [o.statusCode, o.output?.statusCode, o.data?.statusCode, o.code]) {
			if (typeof candidate === 'number' && Number.isFinite(candidate)) {
				return candidate
			}
		}
	}

	return undefined
}

export class AunuBanSentinel {
	readonly enabled: boolean
	readonly cooldownMs: number
	readonly burstThreshold: number
	readonly burstWindowMs: number
	readonly keywords: readonly string[]
	readonly banCloseCodes: readonly number[]
	readonly guardFilePath: string | null

	private readonly store: BanGuardStore
	private readonly logger: BanSentinelLogger | undefined
	private readonly onTrip: BanSentinelSocketOptions['onTrip']
	private readonly nowFn: () => number
	private record: BanGuardRecord | null = null
	private failures: number[] = []
	private storeWarned = false

	constructor(options: AunuBanSentinelOptions = {}) {
		this.enabled = options.enabled !== false
		this.cooldownMs = positiveFiniteOr(options.cooldownMs, DEFAULT_BAN_COOLDOWN_MS)
		this.burstThreshold = burstThresholdOr(options.burstThreshold)
		this.burstWindowMs = positiveFiniteOr(options.burstWindowMs, DEFAULT_BAN_BURST_WINDOW_MS)
		const removed = new Set(normaliseKeywords(options.removeKeywords, []))
		this.keywords = normaliseKeywords(options.keywords, DEFAULT_BAN_KEYWORDS).filter(kw => !removed.has(kw))
		this.banCloseCodes =
			Array.isArray(options.banCloseCodes) && options.banCloseCodes.length
				? [...new Set(options.banCloseCodes.filter(isFiniteNumber))]
				: [...DEFAULT_BAN_CLOSE_CODES]
		this.logger = options.logger
		this.onTrip = options.onTrip
		this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now()

		if (!this.enabled) {
			// Saklar mati bersih: tanpa baca/tulis file sama sekali.
			this.guardFilePath = null
			this.store = new MemoryBanGuardStore()
			return
		}

		if (options.store) {
			this.store = options.store
			this.guardFilePath = options.store instanceof FileBanGuardStore ? options.store.path : null
		} else if (options.guardFilePath === null) {
			this.guardFilePath = null
			this.store = new MemoryBanGuardStore()
		} else {
			this.guardFilePath =
				typeof options.guardFilePath === 'string' && options.guardFilePath.length > 0
					? options.guardFilePath
					: join(process.cwd(), DEFAULT_BAN_GUARD_FILENAME)
			this.store = new FileBanGuardStore(this.guardFilePath)
		}

		// Baca file saat start: guard dari proses sebelumnya (restart)
		// tetap melindungi. Catatan kedaluwarsa dibersihkan best-effort.
		let loaded: BanGuardRecord | null = null
		try {
			loaded = this.store.load()
		} catch {
			loaded = null
		}

		if (loaded) {
			if (loaded.until > this.nowFn()) {
				this.record = loaded
			} else {
				try {
					this.store.clear()
				} catch {}
			}
		}
	}

	/** Status guard saat ini (aktif, sisa waktu, alasan). */
	status(): BanSentinelStatus {
		if (!this.enabled || !this.record) {
			return { active: false, remainingMs: 0, until: null, triggeredAt: null, reason: null }
		}

		const remainingMs = this.record.until - this.nowFn()
		const base = {
			until: this.record.until,
			triggeredAt: this.record.triggeredAt,
			reason: this.record.reason,
			...(this.record.code !== undefined ? { code: this.record.code } : {})
		}
		return remainingMs > 0 ? { active: true, remainingMs, ...base } : { active: false, remainingMs: 0, ...base }
	}

	isOnCooldown(): boolean {
		return this.status().active
	}

	/** Sisa cooldown dalam ms (0 bila tidak aktif). */
	getCooldownRemainingMs(): number {
		return this.status().remainingMs
	}

	/**
	 * Gate connect — SATU-SATUNYA jalur sentinel yang melempar.
	 * Melempar Boom 503 selama cooldown aktif; lolos diam-diam selain itu.
	 */
	assertCanConnect(): void {
		const s = this.status()
		if (!s.active) {
			return
		}

		const minutes = Math.max(1, Math.ceil(s.remainingMs / 60000))
		throw new Boom(
			`AunuBanSentinel: koneksi diblokir guard anti-ban (${s.reason ?? 'guard aktif'}) — coba lagi dalam ~${minutes} menit`,
			{ statusCode: 503 }
		)
	}

	/**
	 * Beri makan satu sinyal kegagalan (teks dan/atau kode). Urutan
	 * periksa mengikuti referensi: kata kunci → kode berbahaya → burst.
	 * Mengembalikan true bila guard aktif sesudah panggilan ini.
	 * Tidak pernah melempar.
	 */
	noteFailure(input?: unknown, codeHint?: number): boolean {
		if (!this.enabled) {
			return false
		}

		try {
			if (this.status().active) {
				return true
			}

			const text = extractText(input)
			const kw = text ? this.matchKeyword(text) : undefined
			if (kw) {
				return this.trip(`Kata kunci ban terdeteksi: "${kw}"`, extractCode(input) ?? codeHint)
			}

			const code = extractCode(input) ?? (isFiniteNumber(codeHint) ? codeHint : undefined)
			if (code !== undefined && this.banCloseCodes.includes(code)) {
				return this.trip(`Kode putus berbahaya: ${code}`, code)
			}

			return this.recordBurstFailure()
		} catch {
			return this.status().active
		}
	}

	/** Alias gaya referensi: `check(err)`. */
	check(input?: unknown): boolean {
		return this.noteFailure(input)
	}

	/**
	 * Sinyal dari peristiwa putus koneksi. Kode 401/403/440 langsung
	 * memicu; teks yang mengandung kata kunci ban juga; putus lain
	 * dihitung ke jendela burst. Tidak pernah melempar.
	 */
	noteDisconnect(code?: number | null, text?: string): boolean {
		if (!this.enabled) {
			return false
		}

		try {
			if (this.status().active) {
				return true
			}

			if (typeof text === 'string' && text) {
				const kw = this.matchKeyword(text)
				if (kw) {
					return this.trip(`Kata kunci ban terdeteksi: "${kw}"`, isFiniteNumber(code) ? code : undefined)
				}
			}

			if (isFiniteNumber(code) && this.banCloseCodes.includes(code)) {
				return this.trip(`Kode putus berbahaya: ${code}`, code)
			}

			return this.recordBurstFailure()
		} catch {
			return this.status().active
		}
	}

	/**
	 * Sinyal dari stream error WA. Kode pada daftar stream berbahaya
	 * (400/401/403/409/429/440/500/503) langsung memicu; selain itu
	 * diteruskan ke logika putus biasa. Tidak pernah melempar.
	 */
	noteStreamError(code?: number | null, text?: string): boolean {
		if (!this.enabled) {
			return false
		}

		try {
			if (this.status().active) {
				return true
			}

			if (isFiniteNumber(code) && DEFAULT_STREAM_ERROR_CODES.includes(code)) {
				return this.trip(`Kode stream error berbahaya: ${code}`, code)
			}
		} catch {
			return this.status().active
		}

		return this.noteDisconnect(code, text)
	}

	/** Hapus guard (memori + file) dan riwayat burst. Tidak pernah melempar. */
	reset(): void {
		this.record = null
		this.failures = []
		try {
			this.store.clear()
		} catch {}
	}

	private matchKeyword(text: string): string | undefined {
		const lower = text.toLowerCase()
		return this.keywords.find(kw => lower.includes(kw))
	}

	private recordBurstFailure(): boolean {
		const now = this.nowFn()
		this.failures = this.failures.filter(t => now - t <= this.burstWindowMs)
		this.failures.push(now)
		if (this.failures.length >= this.burstThreshold) {
			return this.trip(
				`Terlalu banyak kegagalan (${this.failures.length} dalam ${Math.round(this.burstWindowMs / 1000)} dtk)`
			)
		}

		return false
	}

	private trip(reason: string, code?: number): boolean {
		const now = this.nowFn()
		if (this.record && this.record.until > now) {
			return true
		}

		const record: BanGuardRecord = {
			triggeredAt: now,
			until: now + this.cooldownMs,
			reason,
			...(code !== undefined ? { code } : {})
		}
		this.record = record
		this.failures = []

		let saved = true
		try {
			saved = this.store.save(record)
		} catch {
			saved = false
		}

		if (!saved && this.store.persistent && !this.storeWarned) {
			this.storeWarned = true
			this.logger?.warn(
				{ guardFilePath: this.guardFilePath },
				'AunuBanSentinel: file guard tidak bisa ditulis — guard lanjut mode memori-saja untuk proses ini'
			)
		}

		this.logger?.error(
			{ reason, until: record.until, ...(code !== undefined ? { code } : {}) },
			'AunuBanSentinel: guard anti-ban TERPICU — koneksi diblokir selama cooldown'
		)

		if (this.onTrip) {
			try {
				this.onTrip({ ...record })
			} catch (err) {
				this.logger?.warn({ err }, 'AunuBanSentinel: callback onTrip melempar — diabaikan')
			}
		}

		return true
	}
}

/** Factory ringkas. */
export const createBanSentinel = (options?: AunuBanSentinelOptions) => new AunuBanSentinel(options)

/**
 * Resolusi nilai `SocketConfig.banSentinel` menjadi instance:
 * `false` / `{ enabled: false }` → undefined (mati bersih, tanpa I/O
 * file); `undefined` / `true` / objek → sentinel aktif dengan bawaan.
 */
export const resolveBanSentinelOption = (
	config: BanSentinelConfigValue | undefined,
	logger?: BanSentinelLogger
): AunuBanSentinel | undefined => {
	if (config === false) {
		return undefined
	}

	if (config && typeof config === 'object' && config.enabled === false) {
		return undefined
	}

	const opts: BanSentinelSocketOptions = config && typeof config === 'object' ? config : {}
	return new AunuBanSentinel({ ...opts, logger })
}
