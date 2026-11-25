import { EventEmitter } from 'events';
import type { WACallEvent, WACallUpdateType } from '../Types/Call.js';
import type { ILogger } from './logger.js';
export type NormalizedCallEventType = 'incoming' | 'ringing' | 'latency' | 'accepted' | 'missed' | 'ended';
export type CallState = 'ringing' | 'accepted' | 'missed' | 'ended';
export type CallSession = {
    id: string;
    chatId: string;
    from: string;
    callerPn?: string;
    isGroup?: boolean;
    groupJid?: string;
    isVideo?: boolean;
    offline: boolean;
    state: CallState;
    /** Epoch ms of the first event seen for this call. */
    startedAt: number;
    /** Epoch ms of the most recent event for this call. */
    updatedAt: number;
    answeredAt?: number;
    endedAt?: number;
    endReason?: string;
    latencyMs?: number;
    /** Raw WACallUpdateType values seen, in order. */
    history: WACallUpdateType[];
};
export type NormalizedCallEvent = {
    type: NormalizedCallEventType;
    call: CallSession;
    /** Raw status that produced this event, when one did. */
    rawStatus?: WACallUpdateType;
    at: number;
};
export type CallDiagnosticKind = NormalizedCallEventType | 'auto-reject' | 'auto-message' | 'sdp' | 'evict' | 'error';
export type CallDiagnosticEvent = {
    kind: CallDiagnosticKind;
    callId?: string;
    at: number;
    detail?: string;
};
export type CallSignalingActions = {
    /** Reject the call on the wire (host wires this to its socket). */
    rejectCall?: (call: CallSession) => Promise<void> | void;
    /** Send the auto message (host wires this to its socket). */
    sendMessage?: (jid: string, text: string, call: CallSession) => Promise<void> | void;
};
export type CallSignalingOptions = {
    logger?: ILogger;
    /** Ms a call may stay ringing before it counts as missed; 0 disables the timer. Default 45s. */
    missedAfterMs?: number;
    /** Sessions kept at once (oldest ended, then oldest overall, evicted first). Default 1000. */
    maxCalls?: number;
    /** Reject incoming calls automatically (needs a rejectCall action). Default false. */
    autoReject?: boolean | ((call: CallSession) => boolean);
    /** Text sent after an auto-reject, or a builder for it. Needs a sendMessage action. */
    autoMessageText?: string | ((call: CallSession) => string);
    actions?: CallSignalingActions;
    /** Clock override (tests); defaults to Date.now. */
    now?: () => number;
    /** Timer overrides (tests); default to the global timers. */
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
};
export type SdpMediaSection = {
    type: string;
    port: number;
    protocol: string;
    formats: string[];
};
export type SdpDiagnostics = {
    media: SdpMediaSection[];
    hasAudio: boolean;
    hasVideo: boolean;
    iceUfrag?: string;
    icePwd?: string;
    fingerprint?: {
        algorithm: string;
        value: string;
    };
    setup?: string;
    candidateCount: number;
    candidateTypes: string[];
};
/**
 * Parse the basics out of an SDP blob: media sections, ICE
 * credentials, DTLS fingerprint/setup and the candidate tally.
 * Pure and total over string input; throws Boom 400 for non-strings
 * and empty input so hosts can branch on statusCode.
 */
export declare const parseSdp: (sdp: unknown) => SdpDiagnostics;
/** Map a raw WACallUpdateType onto the normalised event it produces for a call in the given state. */
export declare const normalizedTypeForStatus: (status: WACallUpdateType, state: CallState | undefined) => NormalizedCallEventType | undefined;
type SocketLike = {
    ev: {
        on: (event: string, listener: (...args: never[]) => void) => void;
        off: (event: string, listener: (...args: never[]) => void) => void;
    };
};
export declare class CallSignalingTracker extends EventEmitter {
    private logger;
    private missedAfterMs;
    private maxCalls;
    private autoReject;
    private autoMessageText;
    private actions;
    private nowFn;
    private setTimeoutFn;
    private clearTimeoutFn;
    private calls;
    private timers;
    private pending;
    private socket;
    private callListener;
    constructor(options?: CallSignalingOptions);
    /** Replace (or extend) the host actions used by auto-reject / auto message. */
    setActions(actions: CallSignalingActions): this;
    /**
     * Feed call updates in — either one WACallEvent or the array the
     * socket emits on 'call'. Malformed entries are reported as
     * diagnostics and skipped; one bad entry never aborts the batch.
     * Returns the normalised events produced, in order.
     */
    ingest(input: WACallEvent | WACallEvent[] | unknown): NormalizedCallEvent[];
    getCall(id: string): CallSession | undefined;
    getActiveCalls(): CallSession[];
    getAllCalls(): CallSession[];
    snapshot(): {
        at: number;
        active: number;
        total: number;
        calls: CallSession[];
    };
    /** Parse SDP and surface the result as a diagnostic. Throws Boom 400 on bad input. */
    diagnoseSdp(sdp: unknown, callId?: string): SdpDiagnostics;
    /**
     * Mark every call that has been ringing past missedAfterMs as
     * missed. The missed-call timers call this too; hosts with an
     * injected clock can drive it directly. Returns the ids marked.
     */
    checkMissed(now?: number): string[];
    /** Resolve once every auto-reject / auto-message action in flight has settled. */
    whenIdle(): Promise<void>;
    /** Attach to a socket's 'call' event. Any previous attachment is detached first. */
    attach(sock: SocketLike, actions?: CallSignalingActions): this;
    detachSocket(): this;
    /** Clear every missed-call timer and detach from the socket. Safe to call twice. */
    stop(): this;
    /** Drop one call's session (and its timer) without emitting anything. */
    forget(id: string): boolean;
    private ingestOne;
    private finish;
    private maybeAutoReject;
    private scheduleMissedTimer;
    private clearMissedTimer;
    private evictIfOverCap;
    private emitNormalized;
    private diagnostic;
}
/**
 * Attach a tracker to a socket and return it. Opt-in only: creating
 * one does not change any existing socket behaviour beyond adding a
 * 'call' listener; `tracker.stop()` removes it again.
 */
export declare const monitorCallSignaling: (sock: SocketLike, options?: CallSignalingOptions, actions?: CallSignalingActions) => CallSignalingTracker;
/** Alias matching the presence-tracker's naming pattern. */
export declare const createCallSignalingTracker: (options?: CallSignalingOptions) => CallSignalingTracker;
export {};
//# sourceMappingURL=call-signaling.d.ts.map