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
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
/** Kata kunci ban bawaan (dari perilaku referensi; cocok sebagian, huruf kecil). */
export const DEFAULT_BAN_KEYWORDS = [
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
];
/** Kode putus yang langsung memicu guard. */
export const DEFAULT_BAN_CLOSE_CODES = [401, 403, 440];
/** Kode stream error yang langsung memicu guard (jalur `noteStreamError`). */
export const DEFAULT_STREAM_ERROR_CODES = [400, 401, 403, 409, 429, 440, 500, 503];
export const DEFAULT_BAN_COOLDOWN_MS = 60 * 60 * 1000;
export const DEFAULT_BAN_BURST_THRESHOLD = 5;
export const DEFAULT_BAN_BURST_WINDOW_MS = 30 * 1000;
export const DEFAULT_BAN_GUARD_FILENAME = '.baileys-ban-guard.json';
/** Store memori-saja: guard hilang saat proses mati. */
export class MemoryBanGuardStore {
    constructor() {
        this.persistent = false;
        this.record = null;
    }
    load() {
        return this.record ? { ...this.record } : null;
    }
    save(record) {
        this.record = { ...record };
        return true;
    }
    clear() {
        this.record = null;
    }
}
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
/** Terima bentuk catatan kita; bentuk warisan referensi dipetakan sebisa mungkin. */
const parseGuardRecord = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const r = raw;
    if (isFiniteNumber(r.until) && isFiniteNumber(r.triggeredAt) && typeof r.reason === 'string') {
        return {
            triggeredAt: r.triggeredAt,
            until: r.until,
            reason: r.reason,
            ...(isFiniteNumber(r.code) ? { code: r.code } : {})
        };
    }
    // Bentuk warisan: { cooldownUntil, reason, lastTrigger }
    if (isFiniteNumber(r.cooldownUntil) && typeof r.reason === 'string') {
        const parsed = typeof r.lastTrigger === 'string' ? Date.parse(r.lastTrigger) : NaN;
        return { triggeredAt: Number.isFinite(parsed) ? parsed : 0, until: r.cooldownUntil, reason: r.reason };
    }
    return null;
};
/** Store file: tulis atomik (tmp + rename), semua kegagalan ditelan. */
export class FileBanGuardStore {
    constructor(path) {
        this.persistent = true;
        this.failed = false;
        this.path = path;
    }
    /** true setelah satu penulisan gagal (store ini berhenti mencoba menulis). */
    get hasFailed() {
        return this.failed;
    }
    load() {
        try {
            if (!existsSync(this.path)) {
                return null;
            }
            // JSON rusak / bentuk tak dikenal = tidak ada guard.
            return parseGuardRecord(JSON.parse(readFileSync(this.path, 'utf8')));
        }
        catch {
            return null;
        }
    }
    save(record) {
        if (this.failed) {
            return false;
        }
        const tmpPath = `${this.path}.tmp-${process.pid}`;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(tmpPath, JSON.stringify(record, null, 2));
            renameSync(tmpPath, this.path);
            return true;
        }
        catch {
            this.failed = true;
            try {
                unlinkSync(tmpPath);
            }
            catch { }
            return false;
        }
    }
    clear() {
        try {
            unlinkSync(this.path);
        }
        catch { }
    }
}
// Sanitise angka di batas masuk (pola guardrail HB-139): nilai tak
// hingga / bukan angka / di luar rentang jatuh ke bawaan, tak pernah
// diteruskan mentah ke logika.
const positiveFiniteOr = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const burstThresholdOr = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_BAN_BURST_THRESHOLD;
const normaliseKeywords = (list, base) => {
    const out = [];
    const push = (kw) => {
        if (typeof kw !== 'string') {
            return;
        }
        const norm = kw.trim().toLowerCase();
        if (norm && !out.includes(norm)) {
            out.push(norm);
        }
    };
    for (const kw of base)
        push(kw);
    if (list) {
        for (const kw of list)
            push(kw);
    }
    return out;
};
const extractText = (input) => {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof Error) {
        return input.message || String(input);
    }
    if (input && typeof input === 'object') {
        const msg = input.message;
        if (typeof msg === 'string') {
            return msg;
        }
    }
    return '';
};
const extractCode = (input) => {
    if (typeof input === 'number' && Number.isFinite(input)) {
        return input;
    }
    if (input && typeof input === 'object') {
        const o = input;
        for (const candidate of [o.statusCode, o.output?.statusCode, o.data?.statusCode, o.code]) {
            if (typeof candidate === 'number' && Number.isFinite(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
};
export class AunuBanSentinel {
    constructor(options = {}) {
        this.record = null;
        this.failures = [];
        this.storeWarned = false;
        this.enabled = options.enabled !== false;
        this.cooldownMs = positiveFiniteOr(options.cooldownMs, DEFAULT_BAN_COOLDOWN_MS);
        this.burstThreshold = burstThresholdOr(options.burstThreshold);
        this.burstWindowMs = positiveFiniteOr(options.burstWindowMs, DEFAULT_BAN_BURST_WINDOW_MS);
        const removed = new Set(normaliseKeywords(options.removeKeywords, []));
        this.keywords = normaliseKeywords(options.keywords, DEFAULT_BAN_KEYWORDS).filter(kw => !removed.has(kw));
        this.banCloseCodes =
            Array.isArray(options.banCloseCodes) && options.banCloseCodes.length
                ? [...new Set(options.banCloseCodes.filter(isFiniteNumber))]
                : [...DEFAULT_BAN_CLOSE_CODES];
        this.logger = options.logger;
        this.onTrip = options.onTrip;
        this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
        if (!this.enabled) {
            // Saklar mati bersih: tanpa baca/tulis file sama sekali.
            this.guardFilePath = null;
            this.store = new MemoryBanGuardStore();
            return;
        }
        if (options.store) {
            this.store = options.store;
            this.guardFilePath = options.store instanceof FileBanGuardStore ? options.store.path : null;
        }
        else if (options.guardFilePath === null) {
            this.guardFilePath = null;
            this.store = new MemoryBanGuardStore();
        }
        else {
            this.guardFilePath =
                typeof options.guardFilePath === 'string' && options.guardFilePath.length > 0
                    ? options.guardFilePath
                    : join(process.cwd(), DEFAULT_BAN_GUARD_FILENAME);
            this.store = new FileBanGuardStore(this.guardFilePath);
        }
        // Baca file saat start: guard dari proses sebelumnya (restart)
        // tetap melindungi. Catatan kedaluwarsa dibersihkan best-effort.
        let loaded = null;
        try {
            loaded = this.store.load();
        }
        catch {
            loaded = null;
        }
        if (loaded) {
            if (loaded.until > this.nowFn()) {
                this.record = loaded;
            }
            else {
                try {
                    this.store.clear();
                }
                catch { }
            }
        }
    }
    /** Status guard saat ini (aktif, sisa waktu, alasan). */
    status() {
        if (!this.enabled || !this.record) {
            return { active: false, remainingMs: 0, until: null, triggeredAt: null, reason: null };
        }
        const remainingMs = this.record.until - this.nowFn();
        const base = {
            until: this.record.until,
            triggeredAt: this.record.triggeredAt,
            reason: this.record.reason,
            ...(this.record.code !== undefined ? { code: this.record.code } : {})
        };
        return remainingMs > 0 ? { active: true, remainingMs, ...base } : { active: false, remainingMs: 0, ...base };
    }
    isOnCooldown() {
        return this.status().active;
    }
    /** Sisa cooldown dalam ms (0 bila tidak aktif). */
    getCooldownRemainingMs() {
        return this.status().remainingMs;
    }
    /**
     * Gate connect — SATU-SATUNYA jalur sentinel yang melempar.
     * Melempar Boom 503 selama cooldown aktif; lolos diam-diam selain itu.
     */
    assertCanConnect() {
        const s = this.status();
        if (!s.active) {
            return;
        }
        const minutes = Math.max(1, Math.ceil(s.remainingMs / 60000));
        throw new Boom(`AunuBanSentinel: koneksi diblokir guard anti-ban (${s.reason ?? 'guard aktif'}) — coba lagi dalam ~${minutes} menit`, { statusCode: 503 });
    }
    /**
     * Beri makan satu sinyal kegagalan (teks dan/atau kode). Urutan
     * periksa mengikuti referensi: kata kunci → kode berbahaya → burst.
     * Mengembalikan true bila guard aktif sesudah panggilan ini.
     * Tidak pernah melempar.
     */
    noteFailure(input, codeHint) {
        if (!this.enabled) {
            return false;
        }
        try {
            if (this.status().active) {
                return true;
            }
            const text = extractText(input);
            const kw = text ? this.matchKeyword(text) : undefined;
            if (kw) {
                return this.trip(`Kata kunci ban terdeteksi: "${kw}"`, extractCode(input) ?? codeHint);
            }
            const code = extractCode(input) ?? (isFiniteNumber(codeHint) ? codeHint : undefined);
            if (code !== undefined && this.banCloseCodes.includes(code)) {
                return this.trip(`Kode putus berbahaya: ${code}`, code);
            }
            return this.recordBurstFailure();
        }
        catch {
            return this.status().active;
        }
    }
    /** Alias gaya referensi: `check(err)`. */
    check(input) {
        return this.noteFailure(input);
    }
    /**
     * Sinyal dari peristiwa putus koneksi. Kode 401/403/440 langsung
     * memicu; teks yang mengandung kata kunci ban juga; putus lain
     * dihitung ke jendela burst. Tidak pernah melempar.
     */
    noteDisconnect(code, text) {
        if (!this.enabled) {
            return false;
        }
        try {
            if (this.status().active) {
                return true;
            }
            if (typeof text === 'string' && text) {
                const kw = this.matchKeyword(text);
                if (kw) {
                    return this.trip(`Kata kunci ban terdeteksi: "${kw}"`, isFiniteNumber(code) ? code : undefined);
                }
            }
            if (isFiniteNumber(code) && this.banCloseCodes.includes(code)) {
                return this.trip(`Kode putus berbahaya: ${code}`, code);
            }
            return this.recordBurstFailure();
        }
        catch {
            return this.status().active;
        }
    }
    /**
     * Sinyal dari stream error WA. Kode pada daftar stream berbahaya
     * (400/401/403/409/429/440/500/503) langsung memicu; selain itu
     * diteruskan ke logika putus biasa. Tidak pernah melempar.
     */
    noteStreamError(code, text) {
        if (!this.enabled) {
            return false;
        }
        try {
            if (this.status().active) {
                return true;
            }
            if (isFiniteNumber(code) && DEFAULT_STREAM_ERROR_CODES.includes(code)) {
                return this.trip(`Kode stream error berbahaya: ${code}`, code);
            }
        }
        catch {
            return this.status().active;
        }
        return this.noteDisconnect(code, text);
    }
    /** Hapus guard (memori + file) dan riwayat burst. Tidak pernah melempar. */
    reset() {
        this.record = null;
        this.failures = [];
        try {
            this.store.clear();
        }
        catch { }
    }
    matchKeyword(text) {
        const lower = text.toLowerCase();
        return this.keywords.find(kw => lower.includes(kw));
    }
    recordBurstFailure() {
        const now = this.nowFn();
        this.failures = this.failures.filter(t => now - t <= this.burstWindowMs);
        this.failures.push(now);
        if (this.failures.length >= this.burstThreshold) {
            return this.trip(`Terlalu banyak kegagalan (${this.failures.length} dalam ${Math.round(this.burstWindowMs / 1000)} dtk)`);
        }
        return false;
    }
    trip(reason, code) {
        const now = this.nowFn();
        if (this.record && this.record.until > now) {
            return true;
        }
        const record = {
            triggeredAt: now,
            until: now + this.cooldownMs,
            reason,
            ...(code !== undefined ? { code } : {})
        };
        this.record = record;
        this.failures = [];
        let saved = true;
        try {
            saved = this.store.save(record);
        }
        catch {
            saved = false;
        }
        if (!saved && this.store.persistent && !this.storeWarned) {
            this.storeWarned = true;
            this.logger?.warn({ guardFilePath: this.guardFilePath }, 'AunuBanSentinel: file guard tidak bisa ditulis — guard lanjut mode memori-saja untuk proses ini');
        }
        this.logger?.error({ reason, until: record.until, ...(code !== undefined ? { code } : {}) }, 'AunuBanSentinel: guard anti-ban TERPICU — koneksi diblokir selama cooldown');
        if (this.onTrip) {
            try {
                this.onTrip({ ...record });
            }
            catch (err) {
                this.logger?.warn({ err }, 'AunuBanSentinel: callback onTrip melempar — diabaikan');
            }
        }
        return true;
    }
}
/** Factory ringkas. */
export const createBanSentinel = (options) => new AunuBanSentinel(options);
/**
 * Resolusi nilai `SocketConfig.banSentinel` menjadi instance:
 * `false` / `{ enabled: false }` → undefined (mati bersih, tanpa I/O
 * file); `undefined` / `true` / objek → sentinel aktif dengan bawaan.
 */
export const resolveBanSentinelOption = (config, logger) => {
    if (config === false) {
        return undefined;
    }
    if (config && typeof config === 'object' && config.enabled === false) {
        return undefined;
    }
    const opts = config && typeof config === 'object' ? config : {};
    return new AunuBanSentinel({ ...opts, logger });
};
//# sourceMappingURL=ban-sentinel.js.map