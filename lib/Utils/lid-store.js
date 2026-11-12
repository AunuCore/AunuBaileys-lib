import { readFileSync, renameSync, writeFileSync } from 'fs';
import { jidNormalizedUser, isJidUser, isLidUser } from '../WABinary/jid-utils.js';
/**
 * AunuBaileys LID identity store.
 *
 * WhatsApp is migrating identities from phone-number JIDs
 * (`<number>@s.whatsapp.net`) to LIDs (`<id>@lid`). Incoming message
 * stanzas already carry both forms (`sender_pn`/`sender_lid`,
 * `participant_pn`/`participant_lid`), so this store learns the
 * PN <-> LID pairs from live traffic and answers bidirectional
 * lookups locally — no server round-trip, no extra IQ queries.
 *
 * The socket attaches an auto-learning instance as `sock.aunuLid`.
 * A standalone store can also be created with `makeLIDStore()` and
 * fed manually via `learnFromMessage` / `addPair`.
 */
export const makeLIDStore = (options = {}) => {
    const maxEntries = options.maxEntries ?? 5000;
    // AunuBaileys (1.0.71): optional listener fired when a genuinely
    // NEW or changed PN<->LID pair is learned (re-learning an already
    // known pair does not fire). The socket wires it to 'lid-mapping.update'.
    const onPairLearned = options.onPairLearned;
    const pnToLid = new Map();
    const lidToPn = new Map();
    const touch = (map, key, value) => {
        // refresh recency for LRU eviction
        map.delete(key);
        map.set(key, value);
    };
    const evictIfNeeded = () => {
        while (pnToLid.size > maxEntries) {
            const oldestPn = pnToLid.keys().next().value;
            const lid = pnToLid.get(oldestPn);
            pnToLid.delete(oldestPn);
            if (lid) {
                lidToPn.delete(lid);
            }
        }
    };
    const addPair = (pnJid, lidJid, opts = {}) => {
        if (!pnJid || !lidJid) {
            return false;
        }
        const pn = jidNormalizedUser(pnJid);
        const lid = jidNormalizedUser(lidJid);
        if (!isJidUser(pn) || !isLidUser(lid)) {
            return false;
        }
        // keep both directions consistent if either side was remapped
        const prevLid = pnToLid.get(pn);
        if (prevLid && prevLid !== lid) {
            lidToPn.delete(prevLid);
        }
        const prevPn = lidToPn.get(lid);
        if (prevPn && prevPn !== pn) {
            pnToLid.delete(prevPn);
        }
        const isNewPair = pnToLid.get(pn) !== lid || lidToPn.get(lid) !== pn;
        touch(pnToLid, pn, lid);
        touch(lidToPn, lid, pn);
        evictIfNeeded();
        if (isNewPair && !opts.silent) {
            try {
                onPairLearned?.({ pn, lid });
            }
            catch {
                // a listener must never break identity learning
            }
        }
        return true;
    };
    const learnFromKey = (key) => {
        if (!key) {
            return 0;
        }
        let learned = 0;
        if (key.senderPn && key.senderLid) {
            learned += addPair(key.senderPn, key.senderLid) ? 1 : 0;
        }
        if (key.participantPn && key.participantLid) {
            learned += addPair(key.participantPn, key.participantLid) ? 1 : 0;
        }
        // a DM chat partner: remoteJid may be the PN while the stanza
        // only carried the sender LID (or the reverse)
        if (key.remoteJid && key.senderLid && isJidUser(key.remoteJid) && !key.fromMe) {
            learned += addPair(key.remoteJid, key.senderLid) ? 1 : 0;
        }
        return learned;
    };
    const learnFromMessage = (msg) => learnFromKey(msg?.key);
    const learnFromUpsert = (upsert) => {
        let learned = 0;
        for (const msg of upsert?.messages ?? []) {
            learned += learnFromMessage(msg);
        }
        return learned;
    };
    const store = {
        addPair,
        learnFromKey,
        learnFromMessage,
        learnFromUpsert,
        getLIDForPN: (pnJid) => (pnJid ? pnToLid.get(jidNormalizedUser(pnJid)) : undefined),
        getPNForLID: (lidJid) => (lidJid ? lidToPn.get(jidNormalizedUser(lidJid)) : undefined),
        // the other identity form of a known JID: PN for a known LID,
        // LID for a known PN; undefined for unknown or non-user JIDs
        getAltJid: (jid) => {
            if (!jid) {
                return undefined;
            }
            const norm = jidNormalizedUser(jid);
            if (isLidUser(norm)) {
                return lidToPn.get(norm);
            }
            if (isJidUser(norm)) {
                return pnToLid.get(norm);
            }
            return undefined;
        },
        hasPN: (pnJid) => (pnJid ? pnToLid.has(jidNormalizedUser(pnJid)) : false),
        hasLID: (lidJid) => (lidJid ? lidToPn.has(jidNormalizedUser(lidJid)) : false),
        deletePair: (jid) => {
            if (!jid) {
                return false;
            }
            const norm = jidNormalizedUser(jid);
            const lid = pnToLid.get(norm);
            if (lid) {
                pnToLid.delete(norm);
                lidToPn.delete(lid);
                return true;
            }
            const pn = lidToPn.get(norm);
            if (pn) {
                lidToPn.delete(norm);
                pnToLid.delete(pn);
                return true;
            }
            return false;
        },
        clear: () => {
            pnToLid.clear();
            lidToPn.clear();
        },
        get size() {
            return pnToLid.size;
        },
        toJSON: () => Object.fromEntries(pnToLid),
        saveToFile: (path) => {
            // AunuBaileys (1.0.70): atomic tmp+rename — a crash mid-write
            // used to leave a truncated store file behind.
            const tmpPath = `${path}.tmp-${process.pid}`;
            writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(pnToLid)));
            renameSync(tmpPath, path);
        },
        loadFromFile: (path) => {
            try {
                const data = JSON.parse(readFileSync(path, 'utf-8'));
                let loaded = 0;
                for (const [pn, lid] of Object.entries(data)) {
                    // silent: restoring a persisted store is not learning
                    loaded += addPair(pn, lid, { silent: true }) ? 1 : 0;
                }
                return loaded;
            }
            catch (err) {
                // AunuBaileys (1.0.70): a load failure used to be
                // swallowed silently — say so, the pairs are re-learned
                // from traffic anyway.
                options.logger?.warn?.({ err: err?.message || String(err) }, 'aunu: failed to load LID store file; starting empty');
                return 0;
            }
        }
    };
    return store;
};
