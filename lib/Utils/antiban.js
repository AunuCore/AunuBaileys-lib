/**
 * AunuAntiBan — lapisan perlindungan akun bawaan AunuBaileys.
 * Konsep terinspirasi baileys-antiban (kobie3717), diimplementasikan ulang
 * secara bersih di dalam paket: rate limiting dengan jitter Gaussian,
 * jadwal warmup akun baru, penjaga operasi grup, simulasi mengetik,
 * dan klasifikasi disconnect. Tanpa telemetri, tanpa jaringan tambahan.
 */
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '../Types/index.js';
import { delay } from './generics.js';

/** Jitter Gaussian (Box-Muller), hasil dibatasi >= 0. */
export const gaussianJitter = (mean = 0, sigma = 1) => {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(0, mean + n * sigma);
};

/** Rate limiter jendela geser per kunci. */
export class RateLimiter {
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.hits = new Map();
    }
    /** Tunggu sampai ada slot untuk key; kembalikan waktu tunggu (ms). */
    async acquire(key) {
        const now = Date.now();
        let arr = this.hits.get(key);
        if (!arr) {
            arr = [];
            this.hits.set(key, arr);
        }
        while (arr.length && now - arr[0] >= this.windowMs)
            arr.shift();
        if (arr.length >= this.max) {
            const wait = this.windowMs - (now - arr[0]) + 5;
            await delay(wait);
            return this.acquire(key);
        }
        arr.push(Date.now());
        return 0;
    }
    /** Cek tanpa menunggu; true bila masih boleh. */
    tryAcquire(key) {
        const now = Date.now();
        let arr = this.hits.get(key);
        if (!arr) {
            arr = [];
            this.hits.set(key, arr);
        }
        while (arr.length && now - arr[0] >= this.windowMs)
            arr.shift();
        if (arr.length >= this.max) {
            return false;
        }
        arr.push(now);
        return true;
    }
}

/** Klasifikasi error disconnect -> kategori + tindakan yang disarankan. */
export const classifyDisconnect = (error) => {
    const code = error?.output?.statusCode ?? error?.statusCode ?? error;
    switch (code) {
        case DisconnectReason.loggedOut:
            return { category: 'logged_out', action: 'stop', detail: 'Sesi logout — perlu pairing ulang. Jangan auto-reconnect.' };
        case DisconnectReason.restartRequired:
            return { category: 'restart_required', action: 'restart', detail: 'Server meminta restart — hubungkan ulang sekali.' };
        case DisconnectReason.connectionReplaced:
            return { category: 'replaced', action: 'stop', detail: 'Sesi digantikan koneksi lain — periksa perangkat tertaut.' };
        case DisconnectReason.badSession:
            return { category: 'bad_session', action: 'stop', detail: 'Sesi rusak — hapus auth state dan pairing ulang.' };
        case DisconnectReason.multideviceMismatch:
            return { category: 'mismatch', action: 'stop', detail: 'Ketidakcocokan multidevice — pairing ulang.' };
        case 403:
            return { category: 'forbidden', action: 'stop', detail: '403 — kemungkinan dibatasi/diblokir. Berhenti dan periksa akun.' };
        case 429:
            return { category: 'rate_limited', action: 'backoff', detail: '429 — terlalu cepat. Mundur dan turunkan laju kirim.' };
        case DisconnectReason.timedOut:
        case DisconnectReason.connectionLost:
        case DisconnectReason.connectionClosed:
        default:
            return { category: 'transient', action: 'reconnect', detail: 'Gangguan jaringan/server sementara — aman reconnect dengan jeda.' };
    }
};

export class AunuAntiBan {
    constructor(options = {}) {
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
        };
        const o = this.options;
        this.perChat = new RateLimiter(o.perChatPerMinute, 60000);
        this.global = new RateLimiter(o.globalPerMinute, 60000);
        this.groupAdd = new RateLimiter(o.groupAddMax, o.groupAddWindowMs);
        this.groupCreate = new RateLimiter(o.groupCreateMax, o.groupCreateWindowMs);
    }
    /** Faktor warmup 0.3 -> 1.0 selama warmupDays sejak warmupStart. */
    warmupFactor() {
        const days = (Date.now() - this.options.warmupStart) / 86400000;
        if (days >= this.options.warmupDays) {
            return 1;
        }
        return 0.3 + 0.7 * Math.max(0, days / this.options.warmupDays);
    }
    /** Batasi laju efektif mengikuti warmup. */
    effectiveLimit(base) {
        return Math.max(1, Math.floor(base * this.warmupFactor()));
    }
    /** Terapkan perlindungan ke socket; socket yang sama dikembalikan. */
    wrap(sock) {
        const self = this;
        const origSend = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            await self.global.acquire('__global__');
            await self.perChat.acquire(jid);
            if (self.options.typingSimulation && (content?.text || content?.caption) && typeof sock.sendPresenceUpdate === 'function') {
                try {
                    await sock.sendPresenceUpdate('composing', jid);
                }
                catch { }
            }
            const wait = self.options.minDelayMs * self.warmupFactor() + gaussianJitter(0, self.options.jitterMs / 2);
            if (wait > 0) {
                await delay(wait);
            }
            return origSend(jid, content, options);
        };
        if (typeof sock.groupParticipantsUpdate === 'function') {
            const orig = sock.groupParticipantsUpdate.bind(sock);
            sock.groupParticipantsUpdate = async (jid, participants, action, inviteMessage) => {
                if (action === 'add' && !self.groupAdd.tryAcquire(jid)) {
                    throw new Boom('AunuAntiBan: batas tambah anggota grup tercapai — jeda dulu agar akun aman', { statusCode: 429 });
                }
                return orig(jid, participants, action, inviteMessage);
            };
        }
        if (typeof sock.groupCreate === 'function') {
            const origCreate = sock.groupCreate.bind(sock);
            sock.groupCreate = async (subject, participants) => {
                if (!self.groupCreate.tryAcquire('__create__')) {
                    throw new Boom('AunuAntiBan: batas buat grup tercapai — jeda dulu agar akun aman', { statusCode: 429 });
                }
                return origCreate(subject, participants);
            };
        }
        sock.aunuAntiBan = self;
        return sock;
    }
}

/** Bungkus socket dengan AunuAntiBan (jalan pintas). */
export const wrapAntiBan = (sock, options) => new AunuAntiBan(options).wrap(sock);
