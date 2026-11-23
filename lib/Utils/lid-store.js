import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from '../WABinary/jid-utils.js';
/**
 * AunuBaileys (2.4.0, HB-470): extract the (pn, lid) pairs a message
 * key actually carries, in [pn, lid] order. The live decoder never
 * sets `senderPn`/`senderLid`/`participantPn`/`participantLid` — it
 * builds keys with `remoteJidAlt` (the chat partner's other address
 * form; for a fromMe DM that is the RECIPIENT's alt, per HB-337) and
 * `participantAlt` (the group author's other form). Reading only the
 * legacy fields made live-traffic learning a dead path: no pair was
 * ever learned from a real key. The legacy fields stay honoured for
 * hand-built keys (history-sync shapes, host-constructed keys).
 * Either field order is accepted — the pair is classified by JID
 * server, never by which field it arrived in — and duplicate pairs
 * within one key are returned once.
 */
export const extractLIDPairsFromKey = (key) => {
    if (!key) {
        return [];
    }
    const pairs = [];
    const seen = new Set();
    const consider = (a, b) => {
        if (!a || !b) {
            return;
        }
        let pn;
        let lid;
        if ((isPnUser(a) || isHostedPnUser(a)) && (isLidUser(b) || isHostedLidUser(b))) {
            pn = a;
            lid = b;
        }
        else if ((isLidUser(a) || isHostedLidUser(a)) && (isPnUser(b) || isHostedPnUser(b))) {
            pn = b;
            lid = a;
        }
        else {
            return;
        }
        const dedupeKey = `${pn}|${lid}`;
        if (seen.has(dedupeKey)) {
            return;
        }
        seen.add(dedupeKey);
        pairs.push([pn, lid]);
    };
    consider(key.senderPn, key.senderLid);
    consider(key.participantPn, key.participantLid);
    // The shapes the live decoder actually produces.
    consider(key.remoteJid, key.remoteJidAlt);
    consider(key.participant, key.participantAlt);
    // Legacy DM shape: remoteJid is the partner's PN while the stanza
    // only carried the sender's LID. senderLid describes the SENDER,
    // so for a fromMe key it would name US — never learn that pairing.
    if (!key.fromMe) {
        consider(key.remoteJid, key.senderLid);
    }
    return pairs;
};
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
    // AunuBaileys (1.0.80, HB-190 + addendum HB-145): `?? 5000`
    // let NaN through (the eviction comparison `size > NaN` is
    // always false — the store grew without bound) and let
    // negatives through (evictIfNeeded's while loop then spun
    // forever on an empty map: `size > -1` stays true while
    // delete(undefined) is a no-op — a wedged process, no error).
    // Sanitise at the boundary: finite values are floored and
    // clamped at 0 (0 = store nothing, which terminates),
    // non-finite values fall back to the default 5000.
    const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, Math.floor(options.maxEntries)) : 5000;
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
            // AunuBaileys (1.0.80, HB-190 defence in depth): with a
            // sanitised maxEntries (>= 0) this loop always
            // terminates, but never trust a loop whose only exit is
            // a size comparison — bail out if the map is somehow
            // already empty (the iterator's `done`, not the key's
            // value, is the empty signal).
            const oldest = pnToLid.keys().next();
            if (oldest.done) {
                break;
            }
            const oldestPn = oldest.value;
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
        // AunuBaileys (2.2.0, HB-336 addendum): hosted identities
        // (@hosted / @hosted.lid) are valid pairs too — the persistent
        // LIDMappingStore accepts them via isPnLike/isLidLike, and this
        // in-memory store used to silently drop every hosted pair.
        if (!(isPnUser(pn) || isHostedPnUser(pn)) || !(isLidUser(lid) || isHostedLidUser(lid))) {
            return false;
        }
        // AunuBaileys (2.4.0, SAPUAN HB-407): same choke-point rule
        // as LIDMappingStore — a user that is empty, non-digit or
        // all-zero ('0', the protobufjs absent-field default) is
        // not an identity and must never be learned, in either
        // direction.
        const pnUser = jidDecode(pn)?.user;
        const lidUser = jidDecode(lid)?.user;
        if (!pnUser || !lidUser || !/^\d+$/.test(pnUser) || !/^\d+$/.test(lidUser) || /^0+$/.test(pnUser) || /^0+$/.test(lidUser)) {
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
        // AunuBaileys (2.4.0, HB-470): pairs come from
        // extractLIDPairsFromKey — the decoder's Alt fields included —
        // and are deduped there, so one pair counts once even when a
        // key carries it in two shapes.
        let learned = 0;
        for (const [pn, lid] of extractLIDPairsFromKey(key)) {
            learned += addPair(pn, lid) ? 1 : 0;
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
        getLIDForPN: pnJid => (pnJid ? pnToLid.get(jidNormalizedUser(pnJid)) : undefined),
        getPNForLID: lidJid => (lidJid ? lidToPn.get(jidNormalizedUser(lidJid)) : undefined),
        // the other identity form of a known JID: PN for a known LID,
        // LID for a known PN; undefined for unknown or non-user JIDs
        getAltJid: jid => {
            if (!jid) {
                return undefined;
            }
            const norm = jidNormalizedUser(jid);
            if (isLidUser(norm) || isHostedLidUser(norm)) {
                return lidToPn.get(norm);
            }
            if (isPnUser(norm) || isHostedPnUser(norm)) {
                return pnToLid.get(norm);
            }
            return undefined;
        },
        hasPN: pnJid => (pnJid ? pnToLid.has(jidNormalizedUser(pnJid)) : false),
        hasLID: lidJid => (lidJid ? lidToPn.has(jidNormalizedUser(lidJid)) : false),
        deletePair: jid => {
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
        saveToFile: path => {
            // AunuBaileys (1.0.70): atomic tmp+rename — a crash mid-write
            // used to leave a truncated store file behind.
            const tmpPath = `${path}.tmp-${process.pid}`;
            // AunuBaileys (1.0.84, HB-120): 0600, like the auth
            // files (HB-116) — this file maps phone numbers to
            // LIDs and must not land world-readable.
            writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(pnToLid)), { mode: 0o600 });
            // AunuBaileys (2.2.0, HB-365): fsync before the rename
            // and the directory after it — tmp+rename alone is
            // atomic but not durable across an OS crash. Best-
            // effort: an un-fsyncable filesystem must not break
            // the store.
            try {
                const fd = openSync(tmpPath, 'r');
                try {
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
            }
            catch {
                // best-effort durability
            }
            renameSync(tmpPath, path);
            try {
                const dirFd = openSync(path.slice(0, path.lastIndexOf('/') + 1) || '.', 'r');
                try {
                    fsyncSync(dirFd);
                }
                finally {
                    closeSync(dirFd);
                }
            }
            catch {
                // directory fsync unsupported on some platforms
            }
        },
        loadFromFile: path => {
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
//# sourceMappingURL=lid-store.js.map