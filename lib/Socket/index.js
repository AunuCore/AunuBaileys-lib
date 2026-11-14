import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
import { makeInteropSocket } from './interop.js';
import { makePrivacySocket } from './privacy.js';
import { makeRegistrationSocket } from './registration.js';
import { makeManagedAccountSocket } from './managed-account.js';
import { makeGraphQLSocket } from './graphql.js';
import { attachSessionWatchdog } from '../Utils/session-watchdog.js';
import { attachAunuExperimental } from './aunu-experimental.js';
import { AunuHandler } from '../Utils/aunu-handler.js';
import { makeLIDStore } from '../Utils/lid-store.js';
import { attachAunuAutoJoin } from '../Utils/aunu-autojoin.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    // AunuBaileys (1.0.75, HB-104): transactionOpts is merged per-field —
    // the shallow spread above replaced the whole default object, so a
    // host passing a PARTIAL transactionOpts silently lost the other
    // field's default (and, before the auth-utils fallback, every
    // key-store commit with it).
    newConfig.transactionOpts = {
        ...DEFAULT_CONNECTION_CONFIG.transactionOpts,
        ...(config?.transactionOpts ?? {})
    };
    // AunuBaileys (1.0.80, HB-139 + HB-174 + addendum HB-139): the
    // numeric connection config was spread raw above — an explicit
    // undefined/NaN from the host (classically `Number(env.X)` of an
    // unset variable) silently replaced the defaults, and every
    // failure mode is silent: promiseTimeout(NaN) never settles (a
    // half-open socket hangs forever), a NaN/0/negative
    // keepAliveIntervalMs collapses setInterval to 1 ms (~850 ping
    // IQs per second, and the dead-connection watchdog compares
    // against NaN so it never fires), and a NaN/Infinity
    // maxMsgRetryCount breaks both retry gates in opposite
    // directions at once (retry receipts never capped, resends
    // never sent). Sanitise once, here at the boundary: timeouts
    // and intervals must be positive finite (else the documented
    // default), the retry count must be finite (else the default),
    // and qrTimeout — which has no Defaults entry (genPairQR falls
    // back with `|| 60000` / `|| 20000`) — must be positive finite
    // or absent (a negative value is truthy and would expire every
    // QR instantly).
    const positiveFiniteOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
    newConfig.connectTimeoutMs = positiveFiniteOr(newConfig.connectTimeoutMs, DEFAULT_CONNECTION_CONFIG.connectTimeoutMs);
    newConfig.defaultQueryTimeoutMs = positiveFiniteOr(newConfig.defaultQueryTimeoutMs, DEFAULT_CONNECTION_CONFIG.defaultQueryTimeoutMs);
    newConfig.keepAliveIntervalMs = positiveFiniteOr(newConfig.keepAliveIntervalMs, DEFAULT_CONNECTION_CONFIG.keepAliveIntervalMs);
    newConfig.maxMsgRetryCount = Number.isFinite(newConfig.maxMsgRetryCount) ? newConfig.maxMsgRetryCount : DEFAULT_CONNECTION_CONFIG.maxMsgRetryCount;
    if (newConfig.qrTimeout !== undefined && !(Number.isFinite(newConfig.qrTimeout) && newConfig.qrTimeout > 0)) {
        newConfig.qrTimeout = undefined;
    }
    // If the user hasn't provided their own history sync function,
    // let's create a default one that respects the syncFullHistory flag.
    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory;
    }
    // AunuBaileys (1.0.71): theme D layers, same nesting order as the
    // donor's index.js — graphql outermost so its token acquisition can
    // use the registration layer's wwwGetNonce/wwwExchangeNonce.
    const sock = makeGraphQLSocket(makeManagedAccountSocket(makeRegistrationSocket(makePrivacySocket(makeInteropSocket(makeCommunitiesSocket(newConfig))))));
    attachAunuExperimental(sock);
    // AunuBaileys (1.0.71): deaf-session watchdog is opt-in only —
    // config.sessionWatchdog (object = options, true = defaults).
    // It only reports; it never reconnects.
    if (newConfig.sessionWatchdog) {
        const watchdog = attachSessionWatchdog(sock, newConfig.sessionWatchdog === true ? undefined : newConfig.sessionWatchdog);
        sock.aunuSessionWatchdog = watchdog;
        // AunuBaileys (1.0.75, HB-105): stop() existed but was never
        // called anywhere in the lib — the interval is unref'd yet its
        // closure holds ev + sock, so every ended socket with the
        // watchdog enabled leaked one 30s timer and its whole socket
        // graph for the life of the process, one per reconnect cycle.
        // Register stop() as a socket-end handler, the same pattern as
        // stopOfflineDrain (HB-66). stop() is idempotent (safe on the
        // double-end path), and sockets without a watchdog never reach
        // this branch.
        sock.registerSocketEndHandler?.(() => watchdog.stop());
    }
    sock.aunuHandler = new AunuHandler(sock);
    attachAunuAutoJoin(sock, newConfig);
    if (!sock.aunuLid) {
        sock.aunuLid = makeLIDStore();
    }
    sock.ev.on('messages.upsert', (upsert) => {
        try {
            sock.aunuLid.learnFromUpsert(upsert);
        }
        catch {
            // identity learning must never break message handling
        }
        // AunuBaileys: when live traffic teaches us a PN <-> LID pair, move
        // any stored PN session onto the LID address (best-effort; the
        // decrypt heals remain the fallback).
        try {
            for (const msg of upsert?.messages ?? []) {
                const key = msg?.key ?? {};
                const pairs = [];
                if (key.senderPn && key.senderLid) {
                    pairs.push([key.senderPn, key.senderLid]);
                }
                if (key.participantPn && key.participantLid) {
                    pairs.push([key.participantPn, key.participantLid]);
                }
                if (key.remoteJid && key.senderLid && !key.fromMe) {
                    pairs.push([key.remoteJid, key.senderLid]);
                }
                for (const [pn, lid] of pairs) {
                    sock.signalRepository?.migrateSession?.(pn, lid)?.catch?.(() => { });
                }
            }
        }
        catch {
            // session migration must never break message handling
        }
    });
    sock.ev.on('connection.update', (update) => {
        // AunuBaileys: migrate the account's OWN session to its LID
        // address once the connection opens with both identities known.
        try {
            if (update.connection === 'open') {
                const me = sock.authState?.creds?.me;
                if (me?.id && me?.lid) {
                    sock.signalRepository?.migrateSession?.(me.id, me.lid)?.catch?.(() => { });
                }
            }
        }
        catch {
            // session migration must never break connection handling
        }
    });
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map