import type { AunuBanSentinel } from './ban-sentinel.js';
/** Jitter Gaussian (Box-Muller), hasil dibatasi >= 0. */
export declare const gaussianJitter: (mean?: number, sigma?: number) => number;
/** Rate limiter jendela geser per kunci. */
export declare class RateLimiter {
    max: number;
    windowMs: number;
    hits: Map<string, number[]>;
    constructor(max: number, windowMs: number);
    /**
     * AunuBaileys (1.0.74): HB-103 — acquire/tryAcquire prune a key's
     * old timestamps but never deleted the KEY, so one entry per
     * recipient JID accumulated for the life of the socket. Lazy
     * sweep, run only once the map passes the threshold: evict every
     * key whose newest hit is already outside its rate-limit window
     * (such a key would behave as brand-new anyway — no behaviour
     * change, amortised cost).
     */
    sweepStaleKeys(now?: number): void;
    /** Tunggu sampai ada slot untuk key; kembalikan waktu tunggu (ms). */
    acquire(key: string): Promise<number>;
    /** Cek tanpa menunggu; true bila masih boleh. */
    tryAcquire(key: string): boolean;
}
export interface DisconnectClassification {
    category: string;
    action: 'stop' | 'restart' | 'reconnect' | 'backoff';
    detail: string;
}
/** Klasifikasi error disconnect -> kategori + tindakan yang disarankan. */
export declare const classifyDisconnect: (error: any) => DisconnectClassification;
export interface AunuAntiBanOptions {
    perChatPerMinute?: number;
    globalPerMinute?: number;
    minDelayMs?: number;
    jitterMs?: number;
    warmupDays?: number;
    warmupStart?: number;
    typingSimulation?: boolean;
    groupAddMax?: number;
    groupAddWindowMs?: number;
    groupCreateMax?: number;
    groupCreateWindowMs?: number;
}
type RequiredAntiBanOptions = Required<AunuAntiBanOptions>;
export declare class AunuAntiBan {
    /**
     * AunuBaileys (P5): BanSentinel milik socket yang dibungkus, bila
     * ada — diisi oleh wrap() dari `sock.aunuBanSentinel`. Murni
     * referensi bersama; AunuAntiBan tidak membuat, mengubah, atau
     * membaca status sentinel.
     */
    banSentinel?: AunuBanSentinel;
    options: RequiredAntiBanOptions;
    perChat: RateLimiter;
    global: RateLimiter;
    groupAdd: RateLimiter;
    groupCreate: RateLimiter;
    constructor(options?: AunuAntiBanOptions);
    /** Faktor warmup 0.3 -> 1.0 selama warmupDays sejak warmupStart. */
    warmupFactor(): number;
    /** Batasi laju efektif mengikuti warmup. */
    effectiveLimit(base: number): number;
    /** Terapkan perlindungan ke socket; socket yang sama dikembalikan. */
    wrap<T extends any>(sock: T): T;
}
export interface ReconnectDelayOptions {
    baseDelayMs?: number;
    maxDelayMs?: number;
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
export declare const getReconnectDelay: (attempt: number, reason: any, options?: ReconnectDelayOptions) => number | null;
/** Bungkus socket dengan AunuAntiBan (jalan pintas). */
export declare const wrapAntiBan: (sock: any, options?: AunuAntiBanOptions) => any;
export {};
//# sourceMappingURL=antiban.d.ts.map