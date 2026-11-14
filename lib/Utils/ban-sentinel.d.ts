import type { ILogger } from './logger.js';
/** Kata kunci ban bawaan (dari perilaku referensi; cocok sebagian, huruf kecil). */
export declare const DEFAULT_BAN_KEYWORDS: readonly string[];
/** Kode putus yang langsung memicu guard. */
export declare const DEFAULT_BAN_CLOSE_CODES: readonly number[];
/** Kode stream error yang langsung memicu guard (jalur `noteStreamError`). */
export declare const DEFAULT_STREAM_ERROR_CODES: readonly number[];
export declare const DEFAULT_BAN_COOLDOWN_MS: number;
export declare const DEFAULT_BAN_BURST_THRESHOLD = 5;
export declare const DEFAULT_BAN_BURST_WINDOW_MS: number;
export declare const DEFAULT_BAN_GUARD_FILENAME = ".baileys-ban-guard.json";
/** Catatan guard yang dipersistkan. */
export interface BanGuardRecord {
    triggeredAt: number;
    until: number;
    reason: string;
    code?: number;
}
export interface BanSentinelStatus {
    active: boolean;
    remainingMs: number;
    until: number | null;
    triggeredAt: number | null;
    reason: string | null;
    code?: number;
}
export type BanSentinelLogger = Pick<ILogger, 'warn' | 'error' | 'info'>;
/** Opsi yang boleh datang dari `SocketConfig.banSentinel`. */
export interface BanSentinelSocketOptions {
    enabled?: boolean;
    /** Cooldown setelah guard terpicu. Bawaan 60 menit. */
    cooldownMs?: number;
    /** Jumlah kegagalan dalam jendela yang memicu guard. Bawaan 5. */
    burstThreshold?: number;
    /** Jendela hitung burst (ms). Bawaan 30 detik. */
    burstWindowMs?: number;
    /**
     * Lokasi file guard. Bawaan: `.baileys-ban-guard.json` di cwd proses
     * (paritas referensi). Host multi-akun WAJIB memberi path per akun
     * (idealnya di dalam direktori auth akun itu) agar satu akun yang
     * terpicu tidak memblokir akun lain. `null` = mode memori-saja.
     */
    guardFilePath?: string | null;
    /** Kata kunci tambahan di luar daftar bawaan. */
    keywords?: string[];
    /** Kata kunci bawaan yang dilepas dari daftar. */
    removeKeywords?: string[];
    /** Mengganti seluruh daftar kode putus berbahaya (bawaan 401/403/440). */
    banCloseCodes?: number[];
    /** Dipanggil sekali saat guard terpicu; error di dalamnya diabaikan. */
    onTrip?: (record: BanGuardRecord) => void;
}
export interface AunuBanSentinelOptions extends BanSentinelSocketOptions {
    logger?: BanSentinelLogger;
    /** Adaptor penyimpanan kustom; mengalahkan `guardFilePath`. */
    store?: BanGuardStore;
    /** Jam yang bisa disuntik (seam uji); bawaan `Date.now`. */
    now?: () => number;
}
export type BanSentinelConfigValue = boolean | BanSentinelSocketOptions;
/** Adaptor penyimpanan catatan guard. Semua metode TIDAK boleh melempar. */
export interface BanGuardStore {
    readonly persistent: boolean;
    load(): BanGuardRecord | null;
    /** Kembalikan false bila persistensi gagal (sentinel lanjut memori-saja). */
    save(record: BanGuardRecord): boolean;
    clear(): void;
}
/** Store memori-saja: guard hilang saat proses mati. */
export declare class MemoryBanGuardStore implements BanGuardStore {
    readonly persistent = false;
    private record;
    load(): BanGuardRecord | null;
    save(record: BanGuardRecord): boolean;
    clear(): void;
}
/** Store file: tulis atomik (tmp + rename), semua kegagalan ditelan. */
export declare class FileBanGuardStore implements BanGuardStore {
    readonly persistent = true;
    readonly path: string;
    private failed;
    constructor(path: string);
    /** true setelah satu penulisan gagal (store ini berhenti mencoba menulis). */
    get hasFailed(): boolean;
    load(): BanGuardRecord | null;
    save(record: BanGuardRecord): boolean;
    clear(): void;
}
export declare class AunuBanSentinel {
    readonly enabled: boolean;
    readonly cooldownMs: number;
    readonly burstThreshold: number;
    readonly burstWindowMs: number;
    readonly keywords: readonly string[];
    readonly banCloseCodes: readonly number[];
    readonly guardFilePath: string | null;
    private readonly store;
    private readonly logger;
    private readonly onTrip;
    private readonly nowFn;
    private record;
    private failures;
    private storeWarned;
    constructor(options?: AunuBanSentinelOptions);
    /** Status guard saat ini (aktif, sisa waktu, alasan). */
    status(): BanSentinelStatus;
    isOnCooldown(): boolean;
    /** Sisa cooldown dalam ms (0 bila tidak aktif). */
    getCooldownRemainingMs(): number;
    /**
     * Gate connect — SATU-SATUNYA jalur sentinel yang melempar.
     * Melempar Boom 503 selama cooldown aktif; lolos diam-diam selain itu.
     */
    assertCanConnect(): void;
    /**
     * Beri makan satu sinyal kegagalan (teks dan/atau kode). Urutan
     * periksa mengikuti referensi: kata kunci → kode berbahaya → burst.
     * Mengembalikan true bila guard aktif sesudah panggilan ini.
     * Tidak pernah melempar.
     */
    noteFailure(input?: unknown, codeHint?: number): boolean;
    /** Alias gaya referensi: `check(err)`. */
    check(input?: unknown): boolean;
    /**
     * Sinyal dari peristiwa putus koneksi. Kode 401/403/440 langsung
     * memicu; teks yang mengandung kata kunci ban juga; putus lain
     * dihitung ke jendela burst. Tidak pernah melempar.
     */
    noteDisconnect(code?: number | null, text?: string): boolean;
    /**
     * Sinyal dari stream error WA. Kode pada daftar stream berbahaya
     * (400/401/403/409/429/440/500/503) langsung memicu; selain itu
     * diteruskan ke logika putus biasa. Tidak pernah melempar.
     */
    noteStreamError(code?: number | null, text?: string): boolean;
    /** Hapus guard (memori + file) dan riwayat burst. Tidak pernah melempar. */
    reset(): void;
    private matchKeyword;
    private recordBurstFailure;
    private trip;
}
/** Factory ringkas. */
export declare const createBanSentinel: (options?: AunuBanSentinelOptions) => AunuBanSentinel;
/**
 * Resolusi nilai `SocketConfig.banSentinel` menjadi instance:
 * `false` / `{ enabled: false }` → undefined (mati bersih, tanpa I/O
 * file); `undefined` / `true` / objek → sentinel aktif dengan bawaan.
 */
export declare const resolveBanSentinelOption: (config: BanSentinelConfigValue | undefined, logger?: BanSentinelLogger) => AunuBanSentinel | undefined;
//# sourceMappingURL=ban-sentinel.d.ts.map