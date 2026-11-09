import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
import { AunuHandler } from '../Utils/aunu-handler.js';
import { makeLIDStore } from '../Utils/lid-store.js';
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
    const sock = makeCommunitiesSocket(newConfig);
    sock.aunuHandler = new AunuHandler(sock);
    sock.aunuLid = makeLIDStore();
    sock.ev.on('messages.upsert', (upsert) => {
        try {
            sock.aunuLid.learnFromUpsert(upsert);
        }
        catch {
            // identity learning must never break message handling
        }
    });
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map