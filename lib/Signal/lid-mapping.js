import { InternalCache } from '../Utils/internal-cache.js';
import { Mutex } from '../Utils/mutex.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../WABinary/index.js';
// AunuBaileys (2.1.0, HB-336): a hosted account's LID (@hosted.lid) and PN
// (@hosted) are LID/PN users too - the store validation and the reverse
// lookup below only accepted the plain @lid / @s.whatsapp.net forms, so
// every hosted pair was dropped with a warn and never persisted, which
// left updateBlockStatus and the tc-token reverse lookups unresolvable
// for hosted accounts (and re-fetched the mapping via USync on every call).
// Each side accepts plain-or-hosted independently: the USync round-trip
// may echo a hosted LID against a plain PN (the query is normalised to
// @s.whatsapp.net before it is sent), so the servers must not be
// required to match - the stored mapping is user-to-user only.
const isLidLike = (jid) => isLidUser(jid) || isHostedLidUser(jid);
const isPnLike = (jid) => isPnUser(jid) || isHostedPnUser(jid);
// AunuBaileys (2.3.0, HB-378): a stored lid-mapping VALUE is a user
// id — decimal digits, nothing else (the write path validates the
// JID shape before extracting the user; the read paths used to
// check only `typeof === 'string'`). A corrupt/hand-edited store
// value ('garbage!!not-a-lid') was trusted, cached for 3 days, and
// built into a JID, so resolveLIDSignalAddress keyed sessions by a
// garbage address and every lookup for that contact missed
// permanently. Values failing this shape are a MISS, never data —
// the same treatment HB-98 gave pre-keys and HB-124 sender keys.
const isValidStoredUser = (value) => typeof value === 'string' && /^\d+$/.test(value) && !/^0+$/.test(value);
// AunuBaileys (2.4.0, HB-407 + mirror addendum): the write path
// applies the same shape as the read path, plus the non-zero rule
// above. A protobufjs default (Long 0 for an absent int64/uint64
// field) used to become the pair { pn, '0@lid' } or { '0@s.whatsapp.net',
// lid } at producers such as the LID_MIGRATION_MAPPING_SYNC branch —
// the JID shape is valid and '0' is a digit, so it passed every
// existing guard, poisoned both directions, and (via the HB-358
// mirror eviction) retired the real forward entry. Rejecting
// empty / non-digit / all-zero users here, at the choke point,
// keeps the poison out no matter which producer built the pair.
const isValidPairUser = isValidStoredUser;
export class LIDMappingStore {
    hasFreshNegativeMapping(pnUser) {
        const expiresAt = this.negativeCache.get(pnUser);
        if (expiresAt === undefined) {
            return false;
        }
        if (expiresAt <= Date.now()) {
            this.negativeCache.delete(pnUser);
            return false;
        }
        return true;
    }
    recordNegativeMapping(pnUser) {
        this.negativeCache.delete(pnUser);
        this.negativeCache.set(pnUser, Date.now() + LIDMappingStore.NEGATIVE_CACHE_TTL_MS);
        if (this.negativeCache.size > LIDMappingStore.NEGATIVE_CACHE_MAX_ENTRIES) {
            const oldest = this.negativeCache.keys().next().value;
            if (oldest !== undefined) {
                this.negativeCache.delete(oldest);
            }
        }
    }
    clearNegativeMapping(pnUser) {
        this.negativeCache.delete(pnUser);
    }
    constructor(keys, logger, pnToLIDFunc, options) {
        this.mappingCache = new InternalCache({
            ttlMs: 3 * 24 * 60 * 60 * 1000, // 3 days (value preserved from
            // the lru-cache original, whose comment said 7 days)
            updateAgeOnGet: true,
            maxEntries: 10000
        });
        this.persistedPairs = new Map();
        // AunuBaileys (2.7.0, LAT-3 — latency audit 2026-11-25 #1;
        // partial amendment of the QUEUE section G hold on the
        // HB-2026-1112-60 family, authorised for THIS facet only):
        // a PN with no LID mapping used to pay a full USync fetch on
        // EVERY lookup, forever — the receive path alone resolves a
        // sender up to 6 times per message, 4 of them while holding
        // the per-peer transaction mutex. A negative result ("this PN
        // has no LID") is now cached for a short 60-second TTL:
        // pnUser -> expiry timestamp (ms, Date.now based — no timers
        // are held, so there is nothing extra to clean up in close()).
        // The cache is bounded (oldest entry dropped past the cap)
        // and a negative entry is invalidated IMMEDIATELY when a
        // positive mapping for the same PN is written or read back
        // from the store, on any path — a freshly learned mapping is
        // never hidden behind a negative entry. Positive lookup
        // behaviour is unchanged.
        this.negativeCache = new Map();
        this.inflightLIDLookups = new Map();
        this.inflightPNLookups = new Map();
        // AunuBaileys (2.3.0, HB-358): serialises whole storeLIDPNMappings
        // calls (reads + compute + commit + cache update) on this store.
        // The keys-transaction mutex only serialises the COMMIT — two
        // concurrent remaps of one PN both read the OLD LID first, so each
        // nulls only that old reverse and the loser's reverse entry
        // survives in the store (and the cache) even though the forward
        // mapping now points at the winner (run-0572, T2/T2b). Re-reading
        // inside the transaction is NOT the fix here: keys.get for a
        // cache-miss key re-acquires the same 'lid-mapping' mutex the
        // transaction already holds, and the Mutex is not re-entrant —
        // verified to hang forever. Serialising the whole call at this
        // layer makes the second caller's pre-commit reads observe the
        // first caller's committed state, so it nulls the loser's
        // reverse too. Never nested: no caller invokes this from inside
        // itself or from inside a keys transaction.
        this.storeMutex = new Mutex();
        this.keys = keys;
        this.pnToLIDFunc = pnToLIDFunc;
        this.logger = logger;
        // HB-432 gate: maxEntries must be a finite positive integer;
        // anything else (NaN, Infinity, 0, negative, fractional,
        // non-number) falls back to the documented default 10_000.
        const rawMax = options?.maxEntries;
        this.maxPersistentEntries =
            typeof rawMax === 'number' && Number.isFinite(rawMax) && Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 10000;
    }
    registerPersistedPair(pnUser, lidUser) {
        // refresh recency (LRU) on re-learn / read-back
        this.persistedPairs.delete(pnUser);
        this.persistedPairs.set(pnUser, lidUser);
    }
    async storeLIDPNMappings(pairs) {
        // AunuBaileys (2.3.0, HB-358): whole-call serialisation —
        // see storeMutex. The read/compute phase must not overlap
        // another call's commit, or the loser of a concurrent remap
        // keeps a live reverse entry (run-0572).
        return this.storeMutex.runExclusive(() => this.storeLIDPNMappingsInner(pairs));
    }
    async storeLIDPNMappingsInner(pairs) {
        if (pairs.length === 0)
            return;
        const validatedPairs = [];
        for (const { lid, pn } of pairs) {
            if (!((isLidLike(lid) && isPnLike(pn)) || (isPnLike(lid) && isLidLike(pn)))) {
                this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`);
                continue;
            }
            // AunuBaileys (2.2.0, HB-364): the validation above accepts
            // EITHER field orientation, but the extraction used to
            // assume the fields were already ordered — a swapped pair
            // ({ lid: <PN>, pn: <LID> }) was stored inverted, silently.
            // Normalise by shape, not by field position.
            const [lidJid, pnJid] = isLidLike(lid) ? [lid, pn] : [pn, lid];
            const lidDecoded = jidDecode(lidJid);
            const pnDecoded = jidDecode(pnJid);
            if (!lidDecoded || !pnDecoded)
                continue;
            // HB-407 + mirror (2.4.0): reject bogus users at the
            // choke point — see isValidPairUser.
            if (!isValidPairUser(lidDecoded.user) || !isValidPairUser(pnDecoded.user)) {
                this.logger.warn(`Invalid LID-PN mapping user: ${lid}, ${pn}`);
                continue;
            }
            validatedPairs.push({ pnUser: pnDecoded.user, lidUser: lidDecoded.user });
        }
        if (validatedPairs.length === 0)
            return;
        // AunuBaileys (2.4.0, HB-358 addendum facet 5): dedup INSIDE
        // the batch. Two PNs claiming one LID (or one PN claiming
        // two LIDs) in a single call used to write both forwards —
        // the reverse was last-wins while the loser's forward entry
        // dangled, and a later legitimate remap of the loser then
        // cascade-deleted the winner's reverse. Last pair wins in
        // both directions, exactly as sequential calls would end.
        const byPn = new Map();
        const byLid = new Map();
        for (const { pnUser, lidUser } of validatedPairs) {
            const prevLid = byPn.get(pnUser);
            if (prevLid && prevLid !== lidUser)
                byLid.delete(prevLid);
            const prevPn = byLid.get(lidUser);
            if (prevPn && prevPn !== pnUser)
                byPn.delete(prevPn);
            byPn.set(pnUser, lidUser);
            byLid.set(lidUser, pnUser);
        }
        let dedupedPairs = [...byPn.entries()].map(([pnUser, lidUser]) => ({ pnUser, lidUser }));
        // AunuBaileys (2.7.0, HB-432 addendum): the HB-432 eviction
        // below only iterates the pairs THIS instance has seen, so
        // a single batch larger than the cap landed whole — the
        // batch's own pairs were never eviction candidates. Prune
        // the batch itself against the cap first: the pairs later
        // in the batch are the fresher claims (last-wins dedup
        // above), so drop the earliest excess. Eviction is safe —
        // a dropped pair is simply re-fetched via USync when it is
        // next needed.
        if (dedupedPairs.length > this.maxPersistentEntries) {
            const excess = dedupedPairs.length - this.maxPersistentEntries;
            this.logger.warn({ excess, cap: this.maxPersistentEntries }, 'aunu: LID mapping batch exceeds the persistent cap; dropping the oldest pairs in the batch (HB-432 addendum)');
            dedupedPairs = dedupedPairs.slice(excess);
        }
        const cacheMissSet = new Set();
        const existingMappings = new Map();
        for (const { pnUser } of dedupedPairs) {
            const cached = this.mappingCache.get(`pn:${pnUser}`);
            // AunuBaileys (2.3.0, HB-378): cached values pass the
            // same shape check as stored ones.
            if (isValidStoredUser(cached)) {
                existingMappings.set(pnUser, cached);
            }
            else {
                cacheMissSet.add(pnUser);
            }
        }
        if (cacheMissSet.size > 0) {
            const cacheMisses = [...cacheMissSet];
            this.logger.trace(`Batch fetching ${cacheMisses.length} LID mappings from database`);
            const stored = await this.keys.get('lid-mapping', cacheMisses);
            for (const pnUser of cacheMisses) {
                const existingLidUser = stored[pnUser];
                if (isValidStoredUser(existingLidUser)) {
                    existingMappings.set(pnUser, existingLidUser);
                    this.mappingCache.set(`pn:${pnUser}`, existingLidUser);
                    this.mappingCache.set(`lid:${existingLidUser}`, pnUser);
                    this.registerPersistedPair(pnUser, existingLidUser);
                    // LAT-3: store-proven positive — drop any
                    // negative entry for this PN.
                    this.clearNegativeMapping(pnUser);
                }
            }
        }
        // AunuBaileys (2.3.0, addendum HB-358): the mirror direction
        // of the HB-358 remap — when a LID that currently maps to PN
        // A is stored against a NEW PN B (number change; the LID is
        // the stable side), PN A's forward entry must be retired
        // too, or the dead number keeps resolving to this LID
        // forever. Look up each incoming LID's current reverse
        // mapping.
        // AunuBaileys (2.4.0, HB-415 correction): the reverse is read
        // from the STORE unconditionally here, never from the cache —
        // the forward-read path above seeds the `lid:` cache entry
        // from the forward entry alone, so a cache hit would
        // "confirm" a reverse that is actually missing (torn write)
        // or stale in the store, and both the HB-358 mirror retire
        // and the HB-415 skip/repair decisions below must be made on
        // store truth. One batched read per store call is cheap;
        // this is a write path, not a hot read path.
        const reverseExisting = new Map();
        const reverseKeys = dedupedPairs.map(({ lidUser }) => `${lidUser}_reverse`);
        if (reverseKeys.length > 0) {
            const storedReverse = await this.keys.get('lid-mapping', reverseKeys);
            for (const { lidUser } of dedupedPairs) {
                const existingPnUser = storedReverse[`${lidUser}_reverse`];
                if (isValidStoredUser(existingPnUser)) {
                    reverseExisting.set(lidUser, existingPnUser);
                    // HB-432 addendum: a pair this read proves is
                    // persisted joins the cap index (see the class
                    // comment) — a same-call remap retires it again
                    // in the post-write bookkeeping below.
                    this.registerPersistedPair(existingPnUser, lidUser);
                }
            }
        }
        const pairMap = {};
        for (const { pnUser, lidUser } of dedupedPairs) {
            const existingLidUser = existingMappings.get(pnUser);
            if (existingLidUser === lidUser) {
                // AunuBaileys (2.4.0, HB-415 + addendum): skip only
                // when the REVERSE entry is confirmed present AND
                // pointing at this PN. The forward+reverse pair is
                // written as separate files, so a torn write can
                // leave the reverse missing (HB-415) or stale,
                // pointing at an old PN (addendum) — the old
                // forward-only skip then made the damage permanent,
                // because a re-store of the same pair never rewrote
                // anything. A missing/wrong reverse falls through
                // and the pair is written again in full.
                if (reverseExisting.get(lidUser) === pnUser) {
                    this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping');
                    this.registerPersistedPair(pnUser, lidUser);
                    // LAT-3: a confirmed positive mapping kills any
                    // negative entry for this PN at once.
                    this.clearNegativeMapping(pnUser);
                    continue;
                }
                this.logger.debug({ pnUser, lidUser }, 'LID mapping reverse missing or stale, repairing');
            }
            pairMap[pnUser] = lidUser;
        }
        if (Object.keys(pairMap).length === 0)
            return;
        this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`);
        const batchData = {};
        for (const [pnUser, lidUser] of Object.entries(pairMap)) {
            batchData[pnUser] = lidUser;
            batchData[`${lidUser}_reverse`] = pnUser;
            // AunuBaileys (2.2.0, HB-358): a remap (same PN, new LID)
            // must retire the OLD LID's reverse entry — it used to
            // survive in the store (and in the cache below), so the
            // stale LID kept resolving back to this PN indefinitely.
            const existingLidUser = existingMappings.get(pnUser);
            if (existingLidUser && existingLidUser !== lidUser) {
                batchData[`${existingLidUser}_reverse`] = null;
            }
            // AunuBaileys (2.3.0, addendum HB-358): mirror direction —
            // retire the OLD PN's forward entry when this LID moves
            // to a new PN, unless that PN is itself being remapped
            // in this same batch (its pairMap entry wins).
            const existingPnUser = reverseExisting.get(lidUser);
            if (existingPnUser && existingPnUser !== pnUser && !(existingPnUser in pairMap)) {
                batchData[existingPnUser] = null;
            }
        }
        // AunuBaileys (2.4.0, HB-432): prune the persistent store
        // LRU-first inside this same transaction when the projected
        // pair count would exceed the cap. Pairs in this batch and
        // pairs already scheduled for deletion above are never
        // eviction candidates.
        const evictedPairs = [];
        {
            const projected = new Set(this.persistedPairs.keys());
            for (const pnUser of Object.keys(pairMap))
                projected.add(pnUser);
            let excess = projected.size - this.maxPersistentEntries;
            if (excess > 0) {
                for (const [oldPn, oldLid] of this.persistedPairs) {
                    if (excess <= 0)
                        break;
                    if (oldPn in pairMap)
                        continue;
                    if (batchData[oldPn] === null)
                        continue;
                    // Only null the reverse when it still belongs to
                    // this pair (it may have been remapped in-batch).
                    const reverseOwner = Object.entries(pairMap).find(([, l]) => l === oldLid)?.[0];
                    batchData[oldPn] = null;
                    if (!reverseOwner) {
                        batchData[`${oldLid}_reverse`] = null;
                    }
                    evictedPairs.push({ pnUser: oldPn, lidUser: oldLid });
                    excess--;
                }
            }
        }
        // AunuBaileys (2.4.0, HB-459): when this call runs NESTED
        // inside an outer keys transaction, our keys.transaction
        // only joins the outer mutations — the outer frame can
        // still roll back after we return, discarding the write.
        // Updating the cache (or the HB-432 index) then would claim
        // a mapping the store never persisted, and the cached claim
        // suppresses every later re-store for the cache TTL.
        // Capture the nesting BEFORE opening our transaction; when
        // nested, skip all post-write bookkeeping so cache and
        // store stay in sync (the mapping is re-learned and
        // persisted by a later non-nested call).
        let nestedInOuterTx = false;
        try {
            nestedInOuterTx = typeof this.keys.isInTransaction === 'function' && this.keys.isInTransaction();
        }
        catch {
            nestedInOuterTx = false;
        }
        await this.keys.transaction(async () => {
            await this.keys.set({ 'lid-mapping': batchData });
        }, 'lid-mapping');
        if (nestedInOuterTx) {
            this.logger.trace('LID mapping written inside an outer transaction; cache update deferred until a committed write');
            return;
        }
        // Update cache after successful DB write
        for (const [pnUser, lidUser] of Object.entries(pairMap)) {
            this.mappingCache.set(`pn:${pnUser}`, lidUser);
            this.mappingCache.set(`lid:${lidUser}`, pnUser);
            this.registerPersistedPair(pnUser, lidUser);
            // LAT-3: the positive write invalidates the negative
            // entry for this PN immediately (any write path —
            // USync results and signal-identity writes alike —
            // funnels through this method).
            this.clearNegativeMapping(pnUser);
            // HB-358: evict the remapped-away LID's reverse cache too
            const existingLidUser = existingMappings.get(pnUser);
            if (existingLidUser && existingLidUser !== lidUser) {
                this.mappingCache.delete(`lid:${existingLidUser}`);
            }
            // Addendum HB-358 (2.3.0): evict the old PN's forward
            // cache entry on a LID remap, same guard as the store.
            const existingPnUser = reverseExisting.get(lidUser);
            if (existingPnUser && existingPnUser !== pnUser && !(existingPnUser in pairMap)) {
                this.mappingCache.delete(`pn:${existingPnUser}`);
                this.persistedPairs.delete(existingPnUser);
            }
        }
        // HB-432: reflect the pruned pairs in cache + index too.
        for (const { pnUser, lidUser } of evictedPairs) {
            this.persistedPairs.delete(pnUser);
            this.mappingCache.delete(`pn:${pnUser}`);
            if (!Object.values(pairMap).includes(lidUser)) {
                this.mappingCache.delete(`lid:${lidUser}`);
            }
        }
    }
    async getLIDForPN(pn) {
        return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null;
    }
    async getLIDsForPNs(pns) {
        if (pns.length === 0)
            return null;
        const sortedPns = [...new Set(pns)].sort();
        const cacheKey = sortedPns.join(',');
        const inflight = this.inflightLIDLookups.get(cacheKey);
        if (inflight) {
            this.logger.trace(`Coalescing getLIDsForPNs request for ${sortedPns.length} PNs`);
            return inflight;
        }
        const promise = this._getLIDsForPNsImpl(pns);
        this.inflightLIDLookups.set(cacheKey, promise);
        try {
            return await promise;
        }
        finally {
            this.inflightLIDLookups.delete(cacheKey);
        }
    }
    async _getLIDsForPNsImpl(pns) {
        const usyncFetch = {};
        const successfulPairs = {};
        const pending = [];
        const addResolvedPair = (pn, decoded, lidUser) => {
            const normalizedLidUser = lidUser.toString();
            if (!normalizedLidUser) {
                this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`);
                return false;
            }
            // Push the PN device ID to the LID to maintain device separation
            const pnDevice = decoded.device !== undefined ? decoded.device : 0;
            const deviceSpecificLid = `${normalizedLidUser}${!!pnDevice ? `:${pnDevice}` : ``}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`;
            this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`);
            successfulPairs[pn] = { lid: deviceSpecificLid, pn };
            return true;
        };
        for (const pn of pns) {
            if (!isPnUser(pn) && !isHostedPnUser(pn))
                continue;
            const decoded = jidDecode(pn);
            if (!decoded)
                continue;
            const pnUser = decoded.user;
            const cached = this.mappingCache.get(`pn:${pnUser}`);
            // AunuBaileys (2.3.0, HB-378): a cached value that is not
            // a digit user id is a miss, not a mapping — drop it so
            // it cannot poison later lookups.
            if (cached !== undefined && !isValidStoredUser(cached)) {
                this.mappingCache.delete(`pn:${pnUser}`);
            }
            if (isValidStoredUser(cached)) {
                // LAT-3: a positive cache hit supersedes any
                // negative entry for this PN.
                this.clearNegativeMapping(pnUser);
                if (!addResolvedPair(pn, decoded, cached)) {
                    this.logger.warn(`Invalid entry for ${pn} (pair not resolved)`);
                    continue;
                }
                continue;
            }
            // LAT-3: a fresh negative entry means a recent USync
            // fetch already established this PN has no LID — do
            // not pay another store read + fetch for it until the
            // TTL lapses or a positive mapping lands.
            if (this.hasFreshNegativeMapping(pnUser)) {
                continue;
            }
            pending.push({ pn, pnUser, decoded });
        }
        if (pending.length) {
            const pnUsers = [...new Set(pending.map(item => item.pnUser))];
            const stored = await this.keys.get('lid-mapping', pnUsers);
            for (const pnUser of pnUsers) {
                const lidUser = stored[pnUser];
                if (isValidStoredUser(lidUser)) {
                    this.mappingCache.set(`pn:${pnUser}`, lidUser);
                    this.mappingCache.set(`lid:${lidUser}`, pnUser);
                    // HB-432 addendum: register store-proven pairs
                    // on the pure read path too (see class comment).
                    this.registerPersistedPair(pnUser, lidUser);
                    // LAT-3: store-proven positive — drop any
                    // negative entry for this PN.
                    this.clearNegativeMapping(pnUser);
                }
            }
            for (const { pn, pnUser, decoded } of pending) {
                const cached = this.mappingCache.get(`pn:${pnUser}`);
                if (isValidStoredUser(cached)) {
                    if (!addResolvedPair(pn, decoded, cached)) {
                        this.logger.warn(`Invalid entry for ${pn} (pair not resolved)`);
                        continue;
                    }
                }
                else {
                    this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`);
                    const device = decoded.device || 0;
                    let normalizedPn = jidNormalizedUser(pn);
                    if (isHostedPnUser(normalizedPn)) {
                        normalizedPn = `${pnUser}@s.whatsapp.net`;
                    }
                    if (!usyncFetch[normalizedPn]) {
                        usyncFetch[normalizedPn] = [device];
                    }
                    else {
                        usyncFetch[normalizedPn]?.push(device);
                    }
                }
            }
        }
        if (Object.keys(usyncFetch).length > 0) {
            const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch)); // this function already adds LIDs to mapping
            if (result && result.length > 0) {
                // AunuBaileys (2.5.0, HB-430 facet 2): persisting
                // the fetched pairs must not fail the lookup — the
                // pairs are already in hand and the caller
                // (assertSessions) degrades on the same throw.
                // Warn and build from result anyway.
                try {
                    await this.storeLIDPNMappings(result);
                }
                catch (err) {
                    this.logger.warn({ err }, 'failed to persist LID mappings from USync; continuing with the fetched pairs');
                }
                for (const pair of result) {
                    const pnDecoded = jidDecode(pair.pn);
                    const pnUser = pnDecoded?.user;
                    if (!pnUser)
                        continue;
                    const lidUser = jidDecode(pair.lid)?.user;
                    if (!lidUser)
                        continue;
                    // AunuBaileys (2.1.0, HB-336 sub-facet): trust the pair the server
                    // returned - its LID/PN servers are the truth. The old device === 99
                    // heuristic disagreed with the cache path (addResolvedPair uses the
                    // PN's server) and labelled a hosted LID as @lid for device 0.
                    const lidServer = jidDecode(pair.lid)?.server === 'hosted.lid' ? 'hosted.lid' : 'lid';
                    const pnServer = pnDecoded?.server === 'hosted' ? 'hosted' : 's.whatsapp.net';
                    // AunuBaileys (2.1.0, HB-286): the server may echo a differently-shaped pn than the key we fetched under — skip such pairs instead of throwing.
                    const devices = usyncFetch[pair.pn];
                    if (!devices) {
                        // AunuBaileys (2.6.0, HB-286 addendum): the
                        // skip above was still correct as a guard, but
                        // it dropped the pair from the RETURN value
                        // even though the pair was already persisted
                        // (storeLIDPNMappings ran on the whole result
                        // above) — so the in-flight caller got null
                        // once and only the NEXT call hit the cache.
                        // Return the echoed pair itself, with the
                        // device the echo carries (default 0); the
                        // fetched devices list only ever widened it
                        // to the caller's devices.
                        const echoDevice = pnDecoded.device ?? 0;
                        const deviceSpecificLid = `${lidUser}${echoDevice ? `:${echoDevice}` : ``}@${lidServer}`;
                        const deviceSpecificPn = `${pnUser}${echoDevice ? `:${echoDevice}` : ``}@${pnServer}`;
                        this.logger.trace(`getLIDForPN: USYNC echo-shape mismatch for ${pair.pn} — returning the echoed pair (device ${echoDevice})`);
                        successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn };
                        continue;
                    }
                    for (const device of devices) {
                        const deviceSpecificLid = `${lidUser}${!!device ? `:${device}` : ``}@${lidServer}`;
                        this.logger.trace(`getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`);
                        const deviceSpecificPn = `${pnUser}${!!device ? `:${device}` : ``}@${pnServer}`;
                        successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn };
                    }
                }
            }
            else {
                this.logger.warn('USync fetch yielded no results for pending PNs');
            }
            // LAT-3: the fetch just answered for every PN in
            // usyncFetch — record a short-lived negative entry for
            // each one it did NOT resolve, so sequential lookups
            // within the TTL skip the store read + fetch entirely.
            // Only when a fetch actually ran: without a
            // pnToLIDFunc nothing was asked, so nothing is cached.
            if (this.pnToLIDFunc) {
                const resolvedUsers = new Set();
                for (const pair of result ?? []) {
                    const resolvedUser = jidDecode(pair.pn)?.user;
                    if (resolvedUser) {
                        resolvedUsers.add(resolvedUser);
                    }
                }
                for (const normalizedPn of Object.keys(usyncFetch)) {
                    const fetchedUser = jidDecode(normalizedPn)?.user;
                    if (!fetchedUser) {
                        continue;
                    }
                    if (resolvedUsers.has(fetchedUser)) {
                        this.clearNegativeMapping(fetchedUser);
                    }
                    else {
                        this.recordNegativeMapping(fetchedUser);
                    }
                }
            }
        }
        return Object.values(successfulPairs).length > 0 ? Object.values(successfulPairs) : null;
    }
    async getPNForLID(lid) {
        return (await this.getPNsForLIDs([lid]))?.[0]?.pn || null;
    }
    async getPNsForLIDs(lids) {
        if (lids.length === 0)
            return null;
        const sortedLids = [...new Set(lids)].sort();
        const cacheKey = sortedLids.join(',');
        const inflight = this.inflightPNLookups.get(cacheKey);
        if (inflight) {
            this.logger.trace(`Coalescing getPNsForLIDs request for ${sortedLids.length} LIDs`);
            return inflight;
        }
        const promise = this._getPNsForLIDsImpl(lids);
        this.inflightPNLookups.set(cacheKey, promise);
        try {
            return await promise;
        }
        finally {
            this.inflightPNLookups.delete(cacheKey);
        }
    }
    async _getPNsForLIDsImpl(lids) {
        const successfulPairs = {};
        const pending = [];
        const addResolvedPair = (lid, decoded, pnUser) => {
            // AunuBaileys (2.3.0, HB-378): digit-shape check, not
            // just typeof — see isValidStoredUser.
            if (!isValidStoredUser(pnUser)) {
                return false;
            }
            const lidDevice = decoded.device !== undefined ? decoded.device : 0;
            const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`;
            this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`);
            successfulPairs[lid] = { lid, pn: pnJid };
            return true;
        };
        for (const lid of lids) {
            if (!isLidLike(lid))
                continue;
            const decoded = jidDecode(lid);
            if (!decoded)
                continue;
            const lidUser = decoded.user;
            const cached = this.mappingCache.get(`lid:${lidUser}`);
            // AunuBaileys (2.3.0, HB-378): garbage cache values are
            // evicted and treated as a miss (see _getLIDsForPNsImpl).
            if (cached !== undefined && !isValidStoredUser(cached)) {
                this.mappingCache.delete(`lid:${lidUser}`);
            }
            if (isValidStoredUser(cached)) {
                addResolvedPair(lid, decoded, cached);
                continue;
            }
            pending.push({ lid, lidUser, decoded });
        }
        if (pending.length) {
            const reverseKeys = [...new Set(pending.map(item => `${item.lidUser}_reverse`))];
            const stored = await this.keys.get('lid-mapping', reverseKeys);
            for (const { lid, lidUser, decoded } of pending) {
                let pnUser = this.mappingCache.get(`lid:${lidUser}`);
                if (!isValidStoredUser(pnUser)) {
                    pnUser = stored[`${lidUser}_reverse`];
                    if (isValidStoredUser(pnUser)) {
                        this.mappingCache.set(`lid:${lidUser}`, pnUser);
                        this.mappingCache.set(`pn:${pnUser}`, lidUser);
                        // HB-432 addendum: register store-proven
                        // pairs on the pure read path too.
                        this.registerPersistedPair(pnUser, lidUser);
                        // LAT-3: store-proven positive — drop any
                        // negative entry for this PN.
                        this.clearNegativeMapping(pnUser);
                    }
                    else {
                        pnUser = undefined;
                    }
                }
                if (isValidStoredUser(pnUser)) {
                    addResolvedPair(lid, decoded, pnUser);
                }
                else {
                    this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`);
                }
            }
        }
        return Object.values(successfulPairs).length ? Object.values(successfulPairs) : null;
    }
    /**
     * Close the cache and release resources
     */
    close() {
        // AunuBaileys (2.2.0, HB-346): close(), not clear() —
        // clear() left the purge timer alive past socket end.
        this.mappingCache.close();
        // LAT-3: the negative cache holds only timestamps (no
        // timers), but drop it with the rest of the state.
        this.negativeCache.clear();
    }
}
LIDMappingStore.NEGATIVE_CACHE_TTL_MS = 60000;
LIDMappingStore.NEGATIVE_CACHE_MAX_ENTRIES = 1000;
//# sourceMappingURL=lid-mapping.js.map