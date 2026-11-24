import { EventEmitter } from 'events';
import type { WAPresence, PresenceData } from '../Types/Chat.js';
import type { ILogger } from './logger.js';
/** A single continuous online episode for one contact. */
export type PresenceSession = {
    jid: string;
    startedAt: number;
    endedAt?: number;
    /** Set once the session ends; undefined while it is still open. */
    durationMs?: number;
    /** Presence value that opened the session. */
    presence: WAPresence;
};
export type PresenceDiagnosticKind = 'presence-change' | 'session-start' | 'session-end' | 'subscribe' | 'unsubscribe' | 'stale' | 'unknown-presence' | 'evict' | 'error';
export type PresenceDiagnosticEvent = {
    kind: PresenceDiagnosticKind;
    jid?: string;
    presence?: WAPresence;
    previousPresence?: WAPresence;
    at: number;
    detail?: string;
};
export type PresenceChangeEvent = {
    jid: string;
    presence: WAPresence;
    previousPresence?: WAPresence;
    at: number;
};
export type ContactPresence = {
    jid: string;
    presence: WAPresence;
    /** Epoch ms of the last accepted presence change. */
    lastChangeAt: number;
    /** Server-reported last-seen, when the update carried one. */
    lastSeen?: number;
    /** Epoch ms the current online session started; undefined while offline. */
    onlineSince?: number;
    /** Total online time across closed sessions, in ms. */
    totalOnlineMs: number;
    /** True when the stale sweep has flagged this contact (no update within staleAfterMs). */
    stale: boolean;
    updates: number;
    sessions: PresenceSession[];
};
export type ParsedTimezone = {
    type: 'iana';
    timeZone: string;
} | {
    type: 'offset';
    offsetMinutes: number;
};
export type PresenceTrackerOptions = {
    logger?: ILogger;
    /** IANA zone name (e.g. 'Asia/Jakarta') or a fixed offset ('+07:00'). Defaults to the host zone. */
    timeZone?: string;
    /** Ms without an update before a contact is flagged stale; 0 disables the sweep. Default 10 min. */
    staleAfterMs?: number;
    /** Sessions kept per contact (oldest dropped first). Default 20. */
    maxSessionsPerContact?: number;
    /** Contacts tracked at once (oldest untouched evicted first). Default 5000. */
    maxContacts?: number;
    /** Track every JID seen in a presence.update, not just subscribed ones. Default false. */
    subscribeAll?: boolean;
    /** Clock override (tests); defaults to Date.now. */
    now?: () => number;
};
export declare const getDefaultTimezone: () => string;
export declare const setDefaultTimezone: (timeZone: string) => string;
/** Validate a timezone: IANA name, 'UTC', or a fixed '+HH:MM' offset. Throws Boom 400 otherwise. */
export declare const parseTimezone: (value: unknown) => ParsedTimezone;
/** '1d 2h 3m 4s' for a duration; throws Boom 400 on non-finite or negative input. */
export declare const formatDuration: (ms: number) => string;
/** 'HH:MM:SS' in the given (or default) timezone. */
export declare const formatTime: (date: Date | number, timeZone?: string) => string;
/** 'YYYY-MM-DD HH:MM:SS' in the given (or default) timezone. */
export declare const formatDateTime: (date: Date | number, timeZone?: string) => string;
/** 'just now' / '45s ago' / '3m ago' / '2h ago' / '5d ago'; future dates read 'in …'. */
export declare const formatTimeAgo: (date: Date | number, now?: Date | number) => string;
/** Normalise a contact JID the way the rest of the tree does; undefined for anything unusable. */
export declare const normalizeContactJid: (jid: unknown) => string | undefined;
export declare const isOnlinePresence: (presence: unknown) => presence is WAPresence;
export declare const isOfflinePresence: (presence: unknown) => presence is WAPresence;
type SocketLike = {
    ev: {
        on: (event: string, listener: (...args: never[]) => void) => void;
        off: (event: string, listener: (...args: never[]) => void) => void;
    };
};
export declare class PresenceTracker extends EventEmitter {
    private logger;
    private timeZone;
    private staleAfterMs;
    private maxSessionsPerContact;
    private maxContacts;
    private subscribeAll;
    private nowFn;
    private subscribed;
    private contacts;
    private sweepTimer;
    private socket;
    private presenceListener;
    private connectionListener;
    private socketState;
    private socketStateAt;
    constructor(options?: PresenceTrackerOptions);
    /** Start the stale sweep (no-op when staleAfterMs is 0). Safe to call twice. */
    start(): this;
    /** Stop the sweep and, when attached, detach from the socket. Safe to call twice. */
    stop(): this;
    subscribe(jid: string): boolean;
    unsubscribe(jid: string): boolean;
    isSubscribed(jid: string): boolean;
    subscribedJids(): string[];
    /**
     * Feed one `presence.update` payload (`{ id, presences }`) into the
     * tracker. Only subscribed JIDs are tracked (unless `subscribeAll`
     * is on); unknown presence values are reported as diagnostics and
     * skipped, never stored.
     */
    ingest(update: {
        id: string;
        presences: {
            [participant: string]: PresenceData;
        };
    }): void;
    /** The last known record for a contact, or undefined when never seen. */
    getPresence(jid: string): ContactPresence | undefined;
    getAllPresences(): ContactPresence[];
    getOnlineJids(): string[];
    /** Point-in-time view of the tracker (and the socket, when attached). */
    snapshot(): {
        at: number;
        timeZone: string;
        subscribed: string[];
        onlineCount: number;
        contacts: ContactPresence[];
        socketState?: string;
        socketStateAt?: number;
    };
    /** Human-readable one-liner for a contact, e.g. `62812… online for 3m 12s`. */
    describe(jid: string): string | undefined;
    /** Attach to a socket's event emitter (presence.update + connection.update). */
    attach(sock: SocketLike): this;
    detachSocket(): this;
    /** Flag contacts with no update inside staleAfterMs (does not change their presence). */
    sweepStale(now?: number): string[];
    private applyPresence;
    private openSession;
    private closeSession;
    private evictOldestIfOverCap;
    private diagnostic;
}
/**
 * Attach a tracker to a socket and return it. The tracker starts its
 * stale sweep immediately; `tracker.stop()` detaches it again.
 */
export declare const monitorPresence: (sock: SocketLike, options?: PresenceTrackerOptions) => PresenceTracker;
/** Alias kept for parity with the upstream naming. */
export declare const createPresenceTracker: (sock: SocketLike, options?: PresenceTrackerOptions) => PresenceTracker;
export {};
//# sourceMappingURL=presence-tracker.d.ts.map