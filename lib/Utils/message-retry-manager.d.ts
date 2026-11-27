import type { waproto } from '../../WAProto/index.js';
import type { ILogger } from './logger.js';
export interface RecentMessageKey {
    to: string;
    id: string;
}
export interface RecentMessage {
    message: waproto.IMessage;
    timestamp: number;
}
export interface SessionRecreateHistory {
    [jid: string]: number;
}
export interface RetryCounter {
    [messageId: string]: number;
}
export type PendingPhoneRequest = Record<string, ReturnType<typeof setTimeout>>;
export interface RetryStatistics {
    totalRetries: number;
    successfulRetries: number;
    failedRetries: number;
    mediaRetries: number;
    sessionRecreations: number;
    phoneRequests: number;
}
export declare enum RetryReason {
    UnknownError = 0,
    SignalErrorNoSession = 1,
    SignalErrorInvalidKey = 2,
    SignalErrorInvalidKeyId = 3,
    /** MAC verification failed - most common cause of decryption failures */
    SignalErrorInvalidMessage = 4,
    SignalErrorInvalidSignature = 5,
    SignalErrorFutureMessage = 6,
    /** Explicit MAC failure - session is definitely out of sync */
    SignalErrorBadMac = 7,
    SignalErrorInvalidSession = 8,
    SignalErrorInvalidMsgKey = 9,
    BadBroadcastEphemeralSetting = 10,
    UnknownCompanionNoPrekey = 11,
    AdvFailure = 12,
    StatusRevokeDelay = 13
}
export declare class MessageRetryManager {
    private logger;
    private recentMessagesMap;
    private messageKeyIndex;
    private sessionRecreateHistory;
    private retryCounters;
    private baseKeys;
    private pendingPhoneRequests;
    private readonly maxMsgRetryCount;
    private statistics;
    constructor(logger: ILogger, maxMsgRetryCount: number);
    /**
     * Add a recent message to the cache for retry handling
     */
    addRecentMessage(to: string, id: string, message: waproto.IMessage): void;
    /**
     * Get a recent message from the cache
     */
    getRecentMessage(to: string, id: string): RecentMessage | undefined;
    /**
     * Check if a session should be recreated based on retry count, history, and error code.
     * MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout.
     */
    shouldRecreateSession(jid: string, hasSession: boolean, errorCode?: RetryReason): {
        reason: string;
        recreate: boolean;
    };
    /**
     * HB-405: has this peer had a session recreation inside the
     * throttle window? Read-only — consulted ONLY by the
     * peer-supplied call site (sendMessagesAgain, retry receipt
     * error codes), where a peer can force unbounded session churn
     * by retrying many message ids with error="7". Our own decrypt
     * failures keep the immediate path above (HB-380); this gate
     * never throttles those.
     */
    hasRecentSessionRecreate(jid: string): boolean;
    /**
     * HB-405 addendum (2.8.0): record a session recreation that
     * happened OUTSIDE shouldRecreateSession — the reg-id mismatch
     * and base-key collision deletes in sendMessagesAgain — so the
     * throttle above actually knows about them. Without this the
     * peer-supplied branches deleted (and re-deleted fresh sessions)
     * without ever consulting or feeding the history.
     */
    noteSessionRecreate(jid: string): void;
    /**
     * Parse error code from retry receipt's retry node.
     * Returns undefined if no error code is present.
     */
    parseRetryErrorCode(errorAttr: string | undefined): RetryReason | undefined;
    /**
     * Check if an error code indicates a MAC failure
     */
    isMacError(errorCode: RetryReason | undefined): boolean;
    /**
     * Increment retry counter for a message
     */
    incrementRetryCount(messageId: string): number;
    /**
     * Get retry count for a message
     */
    getRetryCount(messageId: string): number;
    /**
     * Check if message has exceeded maximum retry attempts
     */
    hasExceededMaxRetries(messageId: string): boolean;
    /**
     * Mark retry as successful
     */
    markRetrySuccess(messageId: string): void;
    /**
     * Mark retry as failed
     */
    markRetryFailed(messageId: string): void;
    /**
     * Schedule a phone request with delay
     */
    schedulePhoneRequest(messageId: string, callback: () => void, delay?: number): void;
    /**
     * Cancel pending phone request
     */
    cancelPendingPhoneRequest(messageId: string): void;
    /**
     * AunuBaileys (2.2.0, HB-346): clear() empties the caches but
     * leaves their InternalCache purge timers (60s intervals)
     * running — the manager had no close() at all, so every ended
     * socket leaked four timers (and, via the dispose closure, the
     * whole manager). close() is the socket-end path: clear, then
     * stop every purge timer.
     */
    close(): void;
    clear(): void;
    saveBaseKey(addr: string, msgId: string, baseKey: Uint8Array): void;
    hasSameBaseKey(addr: string, msgId: string, baseKey: Uint8Array): boolean;
    deleteBaseKey(addr: string, msgId: string): void;
    private keyToString;
    private removeRecentMessage;
}
//# sourceMappingURL=message-retry-manager.d.ts.map