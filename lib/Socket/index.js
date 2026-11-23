import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { AunuHandler } from '../Utils/aunu-handler.js';
import { attachAunuAutoJoin } from '../Utils/aunu-autojoin.js';
import { extractLIDPairsFromKey, makeLIDStore } from '../Utils/lid-store.js';
import { attachSessionWatchdog } from '../Utils/session-watchdog.js';
import { attachAunuExperimental } from './aunu-experimental.js';
import { makeCommunitiesSocket } from './communities.js';
import { makeGraphQLSocket } from './graphql.js';
import { makeInteropSocket } from './interop.js';
import { makeManagedAccountSocket } from './managed-account.js';
import { makePrivacySocket } from './privacy.js';
import { makeRegistrationSocket } from './registration.js';
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
    // AunuBaileys (2.1.0, HB-333): transactionOpts needs the same boundary sanitisation as the HB-139 numerics below — a NaN/0/negative maxCommitRetries (classically Number('') from env) made commitWithRetry run zero attempts and silently drop the transaction's mutations.
    newConfig.transactionOpts = {
        maxCommitRetries: typeof newConfig.transactionOpts.maxCommitRetries === 'number' &&
            Number.isFinite(newConfig.transactionOpts.maxCommitRetries)
            ? Math.min(10, Math.max(1, Math.floor(newConfig.transactionOpts.maxCommitRetries)))
            : (DEFAULT_CONNECTION_CONFIG.transactionOpts.maxCommitRetries ?? 10),
        delayBetweenTriesMs: typeof newConfig.transactionOpts.delayBetweenTriesMs === 'number' &&
            Number.isFinite(newConfig.transactionOpts.delayBetweenTriesMs) &&
            newConfig.transactionOpts.delayBetweenTriesMs >= 0
            ? newConfig.transactionOpts.delayBetweenTriesMs
            : (DEFAULT_CONNECTION_CONFIG.transactionOpts.delayBetweenTriesMs ?? 3000)
    };
    // AunuBaileys (2.1.0, HB-335): browser/version passed through raw above -
    // an explicit undefined (or a short/wrong-typed array) clobbered the
    // defaults, and every consumer derefs [0..2] unguarded (socket.ts:138,
    // validate-connection getUserAgent/getWebInfo/getClientPayload/
    // generateRegistrationNode, requestPairingCode): browser=undefined threw
    // synchronously at construction, version=undefined threw in the ws
    // 'open' handler on every boot (reconnect loop, the HB-43 class).
    // Sanitise once, here at the boundary, HB-139 style: browser must be a
    // 3-string array and version a 3-number finite tuple, else the default.
    // NOTE the HB-199 lesson: values are never coerced - a non-string
    // browser element or a non-number version element falls back whole.
    const isValidBrowser = (value) => Array.isArray(value) && value.length === 3 && value.every(element => typeof element === 'string');
    newConfig.browser = isValidBrowser(newConfig.browser) ? newConfig.browser : DEFAULT_CONNECTION_CONFIG.browser;
    const isValidVersion = (value) => Array.isArray(value) &&
        value.length === 3 &&
        value.every(element => typeof element === 'number' && Number.isFinite(element));
    newConfig.version = isValidVersion(newConfig.version) ? newConfig.version : DEFAULT_CONNECTION_CONFIG.version;
    // AunuBaileys (2.2.0, HB-335 addenda): the same explicit-undefined
    // clobbering hit six more defaulted fields — each exploded as a bare
    // TypeError at construction or first use (new URL(undefined),
    // logger.child, makeSignalRepository(...), shouldIgnoreJid(...),
    // patchMessageBeforeSending(...), [...customUploadHosts]). Sanitise
    // them at the same boundary: waWebSocketUrl must be a parseable URL
    // string, logger a pino-shaped object, the two callbacks and the
    // repository factory functions, customUploadHosts an array — else
    // the documented default. Values are never coerced (HB-199).
    const isValidWaUrl = (value) => {
        if (typeof value !== 'string' || !value) {
            return false;
        }
        try {
            return !!new URL(value).protocol;
        }
        catch {
            return false;
        }
    };
    newConfig.waWebSocketUrl = isValidWaUrl(newConfig.waWebSocketUrl)
        ? newConfig.waWebSocketUrl
        : DEFAULT_CONNECTION_CONFIG.waWebSocketUrl;
    const isValidLogger = (value) => !!value && typeof value === 'object' && typeof value.child === 'function';
    newConfig.logger = isValidLogger(newConfig.logger) ? newConfig.logger : DEFAULT_CONNECTION_CONFIG.logger;
    newConfig.makeSignalRepository =
        typeof newConfig.makeSignalRepository === 'function'
            ? newConfig.makeSignalRepository
            : DEFAULT_CONNECTION_CONFIG.makeSignalRepository;
    newConfig.shouldIgnoreJid =
        typeof newConfig.shouldIgnoreJid === 'function' ? newConfig.shouldIgnoreJid : DEFAULT_CONNECTION_CONFIG.shouldIgnoreJid;
    newConfig.patchMessageBeforeSending =
        typeof newConfig.patchMessageBeforeSending === 'function'
            ? newConfig.patchMessageBeforeSending
            : DEFAULT_CONNECTION_CONFIG.patchMessageBeforeSending;
    newConfig.customUploadHosts = Array.isArray(newConfig.customUploadHosts)
        ? newConfig.customUploadHosts
        : DEFAULT_CONNECTION_CONFIG.customUploadHosts;
    // AunuBaileys (1.0.80, HB-139 + HB-174 + addendum HB-139,
    // re-applied P3): the numeric connection config was spread raw
    // above \u2014 an explicit undefined/NaN from the host (classically
    // `Number(env.X)` of an unset variable) silently replaced the
    // defaults, and every failure mode is silent: promiseTimeout(NaN)
    // never settles, a NaN/0/negative keepAliveIntervalMs collapses
    // setInterval to 1 ms, and a NaN/Infinity maxMsgRetryCount breaks
    // both retry gates at once. Sanitise once, here at the boundary:
    // timeouts/intervals must be positive finite (else the documented
    // default), the retry count must be finite (else the default),
    // and qrTimeout must be positive finite or absent. NOTE the
    // HB-199 lesson: values are never coerced \u2014 a non-number input
    // (e.g. the string '5abc') is not finite and falls back whole.
    const positiveFiniteOr = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    newConfig.connectTimeoutMs = positiveFiniteOr(newConfig.connectTimeoutMs, DEFAULT_CONNECTION_CONFIG.connectTimeoutMs ?? 20000);
    newConfig.defaultQueryTimeoutMs = positiveFiniteOr(newConfig.defaultQueryTimeoutMs, DEFAULT_CONNECTION_CONFIG.defaultQueryTimeoutMs ?? 60000);
    newConfig.keepAliveIntervalMs = positiveFiniteOr(newConfig.keepAliveIntervalMs, DEFAULT_CONNECTION_CONFIG.keepAliveIntervalMs ?? 25000);
    newConfig.maxMsgRetryCount =
        typeof newConfig.maxMsgRetryCount === 'number' && Number.isFinite(newConfig.maxMsgRetryCount)
            ? newConfig.maxMsgRetryCount
            : (DEFAULT_CONNECTION_CONFIG.maxMsgRetryCount ?? 5);
    if (newConfig.qrTimeout !== undefined &&
        !(typeof newConfig.qrTimeout === 'number' && Number.isFinite(newConfig.qrTimeout) && newConfig.qrTimeout > 0)) {
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
    ;
    sock.aunuHandler = new AunuHandler(sock);
    attachAunuAutoJoin(sock, newConfig);
    if (!sock.aunuLid) {
        ;
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
                // AunuBaileys (2.4.0, HB-470): pairs come from the
                // shared extractor — the live decoder fills
                // remoteJidAlt/participantAlt, never the senderPn/
                // participantPn fields this block used to read, so
                // the migrateSession trigger and the native-store
                // reconciliation below were dead on live traffic.
                const pairs = extractLIDPairsFromKey(key);
                for (const [pn, lid] of pairs) {
                    ;
                    sock.signalRepository?.migrateSession?.(pn, lid)?.catch?.(() => { });
                }
                // AunuBaileys P2b (LID reconciliation): pairs learned by our
                // layer are also written best-effort into the native v7
                // LIDMappingStore (signalRepository.lidMapping), so the
                // upstream signal paths see the same identities. Our
                // sock.aunuLid stays the authoritative public surface.
                if (pairs.length) {
                    ;
                    sock.signalRepository?.lidMapping
                        ?.storeLIDPNMappings?.(pairs.map(([pn, lid]) => ({ pn, lid })))
                        ?.catch?.(() => { });
                }
                // AunuBaileys P2b (LID reconciliation): when our store does
                // not know a PN yet, consult the native store asynchronously
                // and adopt its answer (the native API is async-only, so it
                // cannot serve aunuLid's synchronous lookups directly).
                const remoteJid = key.remoteJid;
                if (remoteJid && !key.fromMe && !sock.aunuLid.getLIDForPN(remoteJid)) {
                    ;
                    sock.signalRepository?.lidMapping
                        ?.getLIDForPN?.(remoteJid)
                        ?.then((lid) => {
                        if (lid) {
                            sock.aunuLid.addPair(remoteJid, lid, { silent: true });
                        }
                    })
                        ?.catch?.(() => { });
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
                    ;
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