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
        sock.aunuSessionWatchdog = attachSessionWatchdog(sock, newConfig.sessionWatchdog === true ? undefined : newConfig.sessionWatchdog);
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