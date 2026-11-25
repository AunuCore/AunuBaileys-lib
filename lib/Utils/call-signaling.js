// AunuBaileys (2.7.0, call-signaling — clean-room implementation from
// the ledger spec in GROUP-D-REPORT 1b / run-0938, NOT a port of any
// external package): a host-side, opt-in layer over the call events
// the socket already emits. The socket forwards raw `call` updates
// (src/Socket/messages-recv.ts, handleCall) and keeps no per-call
// state beyond the offer cache; this module adds the missing layer:
//
//   - normalised events: incoming / ringing / latency / accepted /
//     missed / ended
//   - a per-call state machine (ringing -> accepted -> ended, or
//     ringing -> missed) with a missed-call timer that is always
//     cleared when the call leaves the ringing state
//   - optional auto-reject + auto message on incoming calls, driven
//     entirely by host-supplied actions (this module sends nothing
//     on its own and never touches the wire)
//   - basic SDP diagnostics (media sections, ICE ufrag/pwd,
//     fingerprint, setup, candidate tally) as a pure parser
//
// Nothing here changes default socket behaviour: a host must create
// a tracker (or call monitorCallSignaling) for any of it to run.
//
//   const calls = monitorCallSignaling(sock, {
//     missedAfterMs: 45_000,
//     autoReject: true,
//     autoMessageText: 'Sorry, calls are not accepted here.',
//   }, {
//     rejectCall: call => sock.rejectCall(call.id, call.from),
//     sendMessage: (jid, text) => sock.sendMessage(jid, { text }),
//   })
//   calls.on('call.missed', call => ...)
import { EventEmitter } from 'events';
import { Boom } from '@hapi/boom';
import { jidNormalizedUser } from '../WABinary/index.js';
const KNOWN_STATUSES = new Set([
    'offer',
    'ringing',
    'preaccept',
    'transport',
    'relaylatency',
    'timeout',
    'reject',
    'accept',
    'terminate'
]);
const DEFAULT_MISSED_AFTER_MS = 45000;
const DEFAULT_MAX_CALLS = 1000;
const normalizeJid = (value) => {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    try {
        return jidNormalizedUser(value) || undefined;
    }
    catch {
        return undefined;
    }
};
const copySession = (session) => ({ ...session, history: [...session.history] });
/**
 * Parse the basics out of an SDP blob: media sections, ICE
 * credentials, DTLS fingerprint/setup and the candidate tally.
 * Pure and total over string input; throws Boom 400 for non-strings
 * and empty input so hosts can branch on statusCode.
 */
export const parseSdp = (sdp) => {
    if (typeof sdp !== 'string' || !sdp.trim()) {
        throw new Boom('parseSdp: a non-empty SDP string is required', { statusCode: 400 });
    }
    const media = [];
    const candidateTypes = new Set();
    let candidateCount = 0;
    let iceUfrag;
    let icePwd;
    let fingerprint;
    let setup;
    for (const rawLine of sdp.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('m=')) {
            const parts = line.slice(2).split(/\s+/).filter(Boolean);
            const port = Number(parts[1]);
            media.push({
                type: parts[0] || '',
                port: Number.isFinite(port) ? port : 0,
                protocol: parts[2] || '',
                formats: parts.slice(3)
            });
            continue;
        }
        if (!line.startsWith('a=')) {
            continue;
        }
        const body = line.slice(2);
        if (body.startsWith('ice-ufrag:')) {
            iceUfrag = body.slice('ice-ufrag:'.length).trim() || undefined;
        }
        else if (body.startsWith('ice-pwd:')) {
            icePwd = body.slice('ice-pwd:'.length).trim() || undefined;
        }
        else if (body.startsWith('fingerprint:')) {
            const value = body.slice('fingerprint:'.length).trim();
            const space = value.indexOf(' ');
            if (space > 0) {
                fingerprint = { algorithm: value.slice(0, space), value: value.slice(space + 1).trim() };
            }
        }
        else if (body.startsWith('setup:')) {
            setup = body.slice('setup:'.length).trim() || undefined;
        }
        else if (body.startsWith('candidate:')) {
            candidateCount += 1;
            // a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...
            const tokens = body.split(/\s+/);
            const typIndex = tokens.indexOf('typ');
            const type = typIndex >= 0 ? tokens[typIndex + 1] : undefined;
            if (type) {
                candidateTypes.add(type);
            }
        }
    }
    return {
        media,
        hasAudio: media.some(m => m.type === 'audio'),
        hasVideo: media.some(m => m.type === 'video'),
        iceUfrag,
        icePwd,
        fingerprint,
        setup,
        candidateCount,
        candidateTypes: [...candidateTypes]
    };
};
/** Map a raw WACallUpdateType onto the normalised event it produces for a call in the given state. */
export const normalizedTypeForStatus = (status, state) => {
    switch (status) {
        case 'offer':
            return 'incoming';
        case 'ringing':
        case 'preaccept':
        case 'transport':
            return 'ringing';
        case 'relaylatency':
            return 'latency';
        case 'accept':
            return 'accepted';
        case 'timeout':
            return 'missed';
        case 'reject':
        case 'terminate':
            return state === 'accepted' ? 'ended' : 'missed';
        default:
            return undefined;
    }
};
export class CallSignalingTracker extends EventEmitter {
    constructor(options = {}) {
        super();
        this.calls = new Map();
        this.timers = new Map();
        this.pending = new Set();
        this.logger = options.logger;
        // Numeric config is sanitised at the boundary (HB-139/HB-145
        // pattern): a NaN/negative missed window would either never
        // fire or mark every call missed immediately. 0 is the
        // explicit opt-out and is honoured.
        this.missedAfterMs =
            Number.isFinite(options.missedAfterMs) && options.missedAfterMs > 0
                ? options.missedAfterMs
                : options.missedAfterMs === 0
                    ? 0
                    : DEFAULT_MISSED_AFTER_MS;
        this.maxCalls =
            Number.isFinite(options.maxCalls) && options.maxCalls > 0
                ? Math.floor(options.maxCalls)
                : DEFAULT_MAX_CALLS;
        this.autoReject = options.autoReject;
        this.autoMessageText = options.autoMessageText;
        this.actions = options.actions ?? {};
        this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
        this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimeoutFn =
            options.clearTimeoutFn ??
                (handle => {
                    clearTimeout(handle);
                });
    }
    /** Replace (or extend) the host actions used by auto-reject / auto message. */
    setActions(actions) {
        this.actions = { ...this.actions, ...actions };
        return this;
    }
    /**
     * Feed call updates in — either one WACallEvent or the array the
     * socket emits on 'call'. Malformed entries are reported as
     * diagnostics and skipped; one bad entry never aborts the batch.
     * Returns the normalised events produced, in order.
     */
    ingest(input) {
        const list = Array.isArray(input) ? input : [input];
        const produced = [];
        for (const raw of list) {
            const event = this.ingestOne(raw);
            if (event) {
                produced.push(...event);
            }
        }
        return produced;
    }
    getCall(id) {
        const session = typeof id === 'string' ? this.calls.get(id) : undefined;
        return session ? copySession(session) : undefined;
    }
    getActiveCalls() {
        return [...this.calls.values()].filter(c => c.state === 'ringing' || c.state === 'accepted').map(copySession);
    }
    getAllCalls() {
        return [...this.calls.values()].map(copySession);
    }
    snapshot() {
        return { at: this.nowFn(), active: this.getActiveCalls().length, total: this.calls.size, calls: this.getAllCalls() };
    }
    /** Parse SDP and surface the result as a diagnostic. Throws Boom 400 on bad input. */
    diagnoseSdp(sdp, callId) {
        const diagnostics = parseSdp(sdp);
        this.diagnostic({
            kind: 'sdp',
            callId,
            at: this.nowFn(),
            detail: `media=${diagnostics.media.map(m => m.type).join(',') || 'none'} candidates=${diagnostics.candidateCount} setup=${diagnostics.setup ?? 'none'}`
        });
        return diagnostics;
    }
    /**
     * Mark every call that has been ringing past missedAfterMs as
     * missed. The missed-call timers call this too; hosts with an
     * injected clock can drive it directly. Returns the ids marked.
     */
    checkMissed(now = this.nowFn()) {
        if (this.missedAfterMs <= 0) {
            return [];
        }
        const marked = [];
        for (const session of [...this.calls.values()]) {
            if (session.state === 'ringing' && now - session.startedAt >= this.missedAfterMs) {
                marked.push(session.id);
                this.finish(session, 'missed', 'timeout', now);
            }
        }
        return marked;
    }
    /** Resolve once every auto-reject / auto-message action in flight has settled. */
    async whenIdle() {
        while (this.pending.size > 0) {
            await Promise.allSettled([...this.pending]);
        }
    }
    /** Attach to a socket's 'call' event. Any previous attachment is detached first. */
    attach(sock, actions) {
        if (!sock?.ev || typeof sock.ev.on !== 'function' || typeof sock.ev.off !== 'function') {
            throw new Boom('CallSignalingTracker.attach: socket with ev.on/ev.off is required', { statusCode: 400 });
        }
        if (actions) {
            this.setActions(actions);
        }
        this.detachSocket();
        this.socket = sock;
        this.callListener = calls => {
            try {
                this.ingest(calls);
            }
            catch (error) {
                this.logger?.error({ err: error }, 'call signaling ingest failed');
            }
        };
        sock.ev.on('call', this.callListener);
        return this;
    }
    detachSocket() {
        if (this.socket && this.callListener) {
            try {
                this.socket.ev.off('call', this.callListener);
            }
            catch {
                // Best-effort: a dead emitter must not throw out of stop().
            }
        }
        this.socket = undefined;
        this.callListener = undefined;
        return this;
    }
    /** Clear every missed-call timer and detach from the socket. Safe to call twice. */
    stop() {
        for (const id of [...this.timers.keys()]) {
            this.clearMissedTimer(id);
        }
        this.detachSocket();
        return this;
    }
    /** Drop one call's session (and its timer) without emitting anything. */
    forget(id) {
        this.clearMissedTimer(id);
        return this.calls.delete(id);
    }
    ingestOne(raw) {
        const at = this.nowFn();
        if (!raw || typeof raw !== 'object') {
            this.diagnostic({ kind: 'error', at, detail: 'ingest: call update is not an object' });
            return undefined;
        }
        const candidate = raw;
        if (typeof candidate.id !== 'string' || !candidate.id) {
            this.diagnostic({ kind: 'error', at, detail: 'ingest: call update without an id' });
            return undefined;
        }
        if (typeof candidate.status !== 'string' || !KNOWN_STATUSES.has(candidate.status)) {
            this.diagnostic({ kind: 'error', callId: candidate.id, at, detail: `ingest: unknown call status: ${String(candidate.status)}` });
            return undefined;
        }
        const from = normalizeJid(candidate.from) ?? normalizeJid(candidate.chatId);
        const chatId = normalizeJid(candidate.chatId) ?? from;
        if (!from || !chatId) {
            this.diagnostic({ kind: 'error', callId: candidate.id, at, detail: 'ingest: call update without a usable from/chatId jid' });
            return undefined;
        }
        const status = candidate.status;
        let session = this.calls.get(candidate.id);
        if (!session) {
            const startedAt = candidate.date instanceof Date && Number.isFinite(candidate.date.getTime()) ? candidate.date.getTime() : at;
            session = {
                id: candidate.id,
                chatId,
                from,
                callerPn: typeof candidate.callerPn === 'string' ? candidate.callerPn : undefined,
                isGroup: candidate.isGroup === true,
                groupJid: normalizeJid(candidate.groupJid),
                isVideo: candidate.isVideo === true,
                offline: candidate.offline === true,
                state: 'ringing',
                startedAt,
                updatedAt: at,
                history: []
            };
            this.calls.set(session.id, session);
            this.evictIfOverCap(session.id);
        }
        else {
            session.updatedAt = at;
            if (typeof candidate.callerPn === 'string' && !session.callerPn) {
                session.callerPn = candidate.callerPn;
            }
            if (candidate.isVideo === true) {
                session.isVideo = true;
            }
        }
        session.history.push(status);
        if (status === 'relaylatency') {
            if (typeof candidate.latencyMs === 'number' && Number.isFinite(candidate.latencyMs)) {
                session.latencyMs = candidate.latencyMs;
            }
            const event = this.emitNormalized('latency', session, status, at);
            return [event];
        }
        if (status === 'accept') {
            if (session.state === 'ringing') {
                session.state = 'accepted';
                session.answeredAt = at;
                this.clearMissedTimer(session.id);
                return [this.emitNormalized('accepted', session, status, at)];
            }
            return [];
        }
        if (status === 'reject' || status === 'terminate' || status === 'timeout') {
            if (session.state === 'missed' || session.state === 'ended') {
                return [];
            }
            const reason = status === 'timeout' ? 'timeout' : status;
            return this.finish(session, normalizedTypeForStatus(status, session.state) === 'missed' ? 'missed' : 'ended', reason, at, status);
        }
        if (status === 'offer') {
            if (session.history.filter(s => s === 'offer').length > 1) {
                this.diagnostic({ kind: 'error', callId: session.id, at, detail: 'ingest: duplicate offer for an existing call' });
                return [];
            }
            this.scheduleMissedTimer(session);
            const event = this.emitNormalized('incoming', session, status, at);
            this.maybeAutoReject(session);
            return [event];
        }
        // ringing / preaccept / transport on a call that arrived without
        // an offer still arms the missed-call timer.
        if (session.state === 'ringing' && !this.timers.has(session.id)) {
            this.scheduleMissedTimer(session);
        }
        return [this.emitNormalized('ringing', session, status, at)];
    }
    finish(session, kind, reason, at, rawStatus) {
        this.clearMissedTimer(session.id);
        session.state = kind;
        session.endedAt = at;
        session.endReason = reason;
        const events = [this.emitNormalized(kind, session, rawStatus, at)];
        if (kind === 'missed') {
            // A missed call has also ended: hosts that only care about
            // call teardown get exactly one 'ended' per missed call.
            events.push(this.emitNormalized('ended', session, rawStatus, at));
        }
        return events;
    }
    maybeAutoReject(session) {
        let wanted = false;
        try {
            wanted = typeof this.autoReject === 'function' ? this.autoReject(copySession(session)) : this.autoReject === true;
        }
        catch (error) {
            this.logger?.error({ err: error, callId: session.id }, 'call signaling autoReject predicate failed');
            this.diagnostic({ kind: 'error', callId: session.id, at: this.nowFn(), detail: 'autoReject predicate threw' });
            return;
        }
        if (!wanted) {
            return;
        }
        const run = async () => {
            const at = this.nowFn();
            if (!this.actions.rejectCall) {
                this.diagnostic({ kind: 'auto-reject', callId: session.id, at, detail: 'auto-reject requested but no rejectCall action is configured' });
                return;
            }
            try {
                await this.actions.rejectCall(copySession(session));
            }
            catch (error) {
                this.logger?.error({ err: error, callId: session.id }, 'call signaling auto-reject failed');
                this.diagnostic({ kind: 'error', callId: session.id, at: this.nowFn(), detail: 'auto-reject action threw' });
                return;
            }
            this.diagnostic({ kind: 'auto-reject', callId: session.id, at: this.nowFn(), detail: 'incoming call auto-rejected' });
            if (session.state === 'ringing') {
                this.finish(session, 'ended', 'auto-reject', this.nowFn());
            }
            const text = typeof this.autoMessageText === 'function'
                ? this.autoMessageText(copySession(session))
                : this.autoMessageText;
            if (typeof text === 'string' && text) {
                if (!this.actions.sendMessage) {
                    this.diagnostic({ kind: 'auto-message', callId: session.id, at: this.nowFn(), detail: 'auto message set but no sendMessage action is configured' });
                    return;
                }
                try {
                    await this.actions.sendMessage(session.chatId, text, copySession(session));
                    this.diagnostic({ kind: 'auto-message', callId: session.id, at: this.nowFn(), detail: 'auto message sent' });
                }
                catch (error) {
                    this.logger?.error({ err: error, callId: session.id }, 'call signaling auto message failed');
                    this.diagnostic({ kind: 'error', callId: session.id, at: this.nowFn(), detail: 'auto message action threw' });
                }
            }
        };
        // Tracked from creation and always caught inside run(): the
        // promise can never surface as an orphan rejection.
        const tracked = run();
        this.pending.add(tracked);
        const settle = () => {
            this.pending.delete(tracked);
        };
        void tracked.then(settle, settle);
    }
    scheduleMissedTimer(session) {
        if (this.missedAfterMs <= 0 || session.state !== 'ringing') {
            return;
        }
        this.clearMissedTimer(session.id);
        const handle = this.setTimeoutFn(() => {
            this.timers.delete(session.id);
            this.checkMissed();
        }, this.missedAfterMs);
        // Real timers must never keep a host process alive on their own.
        if (handle && typeof handle === 'object' && typeof handle.unref === 'function') {
            ;
            handle.unref();
        }
        this.timers.set(session.id, handle);
    }
    clearMissedTimer(id) {
        const handle = this.timers.get(id);
        if (handle !== undefined) {
            this.timers.delete(id);
            try {
                this.clearTimeoutFn(handle);
            }
            catch {
                // Clearing is best-effort; a stale handle must not throw.
            }
        }
    }
    evictIfOverCap(exceptId) {
        if (this.calls.size <= this.maxCalls) {
            return;
        }
        let victim;
        for (const session of this.calls.values()) {
            if (session.id === exceptId) {
                continue;
            }
            if (!victim || session.updatedAt < victim.updatedAt) {
                victim = session;
            }
        }
        if (victim) {
            this.clearMissedTimer(victim.id);
            this.calls.delete(victim.id);
            this.diagnostic({ kind: 'evict', callId: victim.id, at: this.nowFn(), detail: 'maxCalls reached' });
        }
    }
    emitNormalized(type, session, rawStatus, at) {
        const event = { type, call: copySession(session), rawStatus, at };
        this.emit(`call.${type}`, event);
        this.emit('call.event', event);
        this.diagnostic({ kind: type, callId: session.id, at });
        return event;
    }
    diagnostic(event) {
        this.logger?.debug({ diagnostic: event }, 'call signaling diagnostic');
        this.emit('call.diagnostic', event);
    }
}
/**
 * Attach a tracker to a socket and return it. Opt-in only: creating
 * one does not change any existing socket behaviour beyond adding a
 * 'call' listener; `tracker.stop()` removes it again.
 */
export const monitorCallSignaling = (sock, options = {}, actions) => {
    const tracker = new CallSignalingTracker(options);
    tracker.attach(sock, actions);
    return tracker;
};
/** Alias matching the presence-tracker's naming pattern. */
export const createCallSignalingTracker = (options = {}) => new CallSignalingTracker(options);
//# sourceMappingURL=call-signaling.js.map