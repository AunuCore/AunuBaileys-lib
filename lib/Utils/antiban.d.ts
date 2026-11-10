import type { WASocket } from '../Types';
export declare const gaussianJitter: (mean?: number, sigma?: number) => number;
export declare class RateLimiter {
    constructor(max: number, windowMs: number);
    acquire(key: string): Promise<number>;
    tryAcquire(key: string): boolean;
}
export interface DisconnectClassification { category: string; action: 'stop' | 'restart' | 'reconnect' | 'backoff'; detail: string; }
export declare const classifyDisconnect: (error: unknown) => DisconnectClassification;
export interface ReconnectDelayOptions { baseDelayMs?: number; maxDelayMs?: number; }
/** Suggested reconnect delay in ms for a disconnect reason (error, status code, or a classifyDisconnect result); null when the connection must NOT be re-established automatically. */
export declare const getReconnectDelay: (attempt: number, reason: unknown, options?: ReconnectDelayOptions) => number | null;
export interface AunuAntiBanOptions {
    perChatPerMinute?: number; globalPerMinute?: number; minDelayMs?: number; jitterMs?: number;
    warmupDays?: number; warmupStart?: number; typingSimulation?: boolean;
    groupAddMax?: number; groupAddWindowMs?: number; groupCreateMax?: number; groupCreateWindowMs?: number;
}
export declare class AunuAntiBan {
    constructor(options?: AunuAntiBanOptions);
    warmupFactor(): number;
    effectiveLimit(base: number): number;
    wrap<T extends WASocket>(sock: T): T;
}
export declare const wrapAntiBan: (sock: WASocket, options?: AunuAntiBanOptions) => WASocket;
