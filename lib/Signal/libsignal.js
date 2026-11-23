// @ts-ignore
import * as libsignal from 'libsignal';
// @ts-ignore
import { PreKeyWhisperMessage } from 'libsignal/src/protobufs.js';
import { BufferJSON, generateSignalPubKey } from '../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidEncode, transferDevice, WAJIDDomains } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
import { LIDMappingStore } from './lid-mapping.js';
// AunuBaileys (2.3.0, HB-338): libsignal@6.0.0 prints whole
// SessionEntry objects to stdout (session_record.js closeSession /
// openSession / removeOldSessions — console.warn/info with the entry
// as an argument), and a SessionEntry carries the session's rootKey,
// ephemeral privKey and chain/message keys — live session key
// material in any host log that captures stdout. node_modules must
// not be patched, so redact at OUR load time instead: replace ONLY
// the serialisation/debug surface of the SessionEntry prototype
// (the util.inspect custom hook and toJSON) with the entry's own
// toString(), which exposes nothing but the peer's public base key.
// The crypto/ratchet paths never read these hooks — serialize() is
// a separate method and stays untouched — and the whole patch is
// wrapped so a libsignal shape change can never break loading.
try {
    const sessionEntryProto = (() => {
        const recordClass = libsignal.SessionRecord;
        const entry = recordClass?.createEntry?.();
        return entry ? Object.getPrototypeOf(entry) : undefined;
    })();
    if (sessionEntryProto) {
        const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
        if (typeof sessionEntryProto[inspectCustom] !== 'function') {
            sessionEntryProto[inspectCustom] = function () {
                return this.toString();
            };
        }
        if (typeof sessionEntryProto['toJSON'] !== 'function') {
            sessionEntryProto['toJSON'] = function () {
                return this.toString();
            };
        }
    }
}
catch {
    // Redaction is best-effort defence in depth — never fail the load.
}
// AunuBaileys (1.0.74, HB-98, re-applied P3b): key material is only
// ever a Buffer (or a base64 string in a hand-edited creds file).
// Anything else is a wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => value instanceof Uint8Array || typeof value === 'string';
// AunuBaileys (1.0.78, HB-157 house rule, re-applied P3b): string
// key material is base64 — decode it as such instead of
// Buffer.from()'s UTF-8, which produced garbage keys.
const storedKeyToBuffer = (value) => typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
/** Extract identity key from PreKeyWhisperMessage for identity change detection */
function extractIdentityFromPkmsg(ciphertext) {
    try {
        if (!ciphertext || ciphertext.length < 2) {
            return undefined;
        }
        // Version byte check (version 3)
        const version = ciphertext[0];
        if ((version & 0xf) !== 3) {
            return undefined;
        }
        // Parse protobuf (skip version byte)
        const preKeyProto = PreKeyWhisperMessage.decode(ciphertext.slice(1));
        if (preKeyProto.identityKey?.length === 33) {
            return new Uint8Array(preKeyProto.identityKey);
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const storage = signalStorage(auth, lidMapping);
    // AunuBaileys (2.3.0, HB-94 addendum): resolve a wire address
    // string ("user[_domain].device") to the canonical LID form via
    // the same mapping path loadSession/storeSession use. A failed
    // or absent mapping falls back to the raw address — never a new
    // throwing path.
    const resolveWireAddr = async (addrStr) => {
        const dotIdx = addrStr.lastIndexOf('.');
        if (dotIdx < 0) {
            return addrStr;
        }
        const userPart = addrStr.slice(0, dotIdx);
        const device = addrStr.slice(dotIdx + 1);
        const [user, domainTypeRaw] = userPart.split('_');
        const domainType = parseInt(domainTypeRaw || '0');
        if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) {
            return addrStr;
        }
        const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
        let lidForPN = null;
        try {
            lidForPN = await lidMapping.getLIDForPN(pnJid);
        }
        catch {
            lidForPN = null;
        }
        if (lidForPN) {
            try {
                return jidToSignalProtocolAddress(lidForPN).toString();
            }
            catch {
                return addrStr;
            }
        }
        return addrStr;
    };
    // AunuBaileys (2.3.0, HB-94 addendum): transactions used to be
    // keyed by the caller's raw JID spelling, so a decrypt keyed by
    // the peer's LID and an encrypt keyed by the same peer's PN ran
    // under DIFFERENT mutexes over the SAME wire session record —
    // last-commit-wins lost one side's ratchet advance (a lost
    // outgoing message in the run-0549 harness). Key every session
    // transaction by the resolved wire address instead; unmapped
    // peers keep the raw-JID key (today's behaviour).
    const txKeyForJid = async (jid) => {
        try {
            return await resolveWireAddr(jidToSignalProtocolAddress(jid).toString());
        }
        catch {
            return jid;
        }
    };
    // AunuBaileys (2.4.0, HB-469): sender-key names were built from
    // the author's RAW JID spelling, while session records resolve
    // PN -> LID first — an SKDM processed under the PN spelling was
    // stored under a different name than the LID-spelled skmsg
    // lookup, so group messages from that author never decrypted
    // (and deleteSenderKey under the other spelling silently
    // missed). Canonicalise the name to the resolved wire address,
    // mirroring txKeyForJid. An author JID whose address cannot be
    // built at all (HB-424 addendum: device 99 on a non-hosted
    // server) yields null — the group heads below degrade to a
    // sender-key-unavailable failure / a skip instead of throwing
    // the raw converter error out of the decrypt path.
    const canonicalSenderKeyName = async (group, authorJid) => {
        try {
            const addrStr = await resolveWireAddr(jidToSignalProtocolAddress(authorJid).toString());
            // ProtocolAddress has no string parser in this libsignal
            // build — rebuild it from the "user[_domain].device"
            // parts, the same split resolveWireAddr performs.
            const dotIdx = addrStr.lastIndexOf('.');
            const name = dotIdx >= 0 ? addrStr.slice(0, dotIdx) : addrStr;
            const parsedDevice = dotIdx >= 0 ? parseInt(addrStr.slice(dotIdx + 1)) : 0;
            const deviceId = Number.isNaN(parsedDevice) ? 0 : parsedDevice;
            return new SenderKeyName(group, new libsignal.ProtocolAddress(name, deviceId));
        }
        catch {
            return null;
        }
    };
    // AunuBaileys (2.3.0, HB-398): in a LID-addressed group our
    // sender-key name must be built from the identity the group
    // uses for us — our LID *including our own device*. creds.me.lid
    // carries no device, so the name collapsed to device 0, which
    // is the PHONE's address: the phone's SKDM then landed in our
    // own sender-key record as a peer state (no signing private),
    // our encrypt picked that newest state and threw
    // 'Incorrect private key length: 0', and repeated phone SKDMs
    // evicted our real state. Re-attach our own device (from
    // creds.me.id) to a device-less LID identity before naming.
    const ownSenderIdentity = (meId) => {
        try {
            const decoded = jidDecode(meId);
            // SignalCreds does not declare `me`, but the runtime
            // creds object is the host's full AuthenticationCreds —
            // read it through a narrow shape; absent = no device to
            // re-attach, and the raw identity stands.
            const myId = auth.creds.me?.id;
            const myDevice = myId ? jidDecode(myId)?.device : undefined;
            if (decoded &&
                (isLidUser(meId) || isHostedLidUser(meId)) &&
                !decoded.device &&
                typeof myDevice === 'number' &&
                myDevice > 0) {
                return jidEncode(decoded.user, decoded.server, myDevice);
            }
        }
        catch {
            // fall through to the raw identity
        }
        return meId;
    };
    const parsedKeys = auth.keys;
    // AunuBaileys (2.4.0, HB-449): the migratedSessionCache that
    // used to live here was never invalidated — a fresh PN session
    // created after the first migration (peer re-key, transient
    // LID-lookup fallback) was skipped by every later
    // migrateSession for the cache's whole 3-day TTL and stayed
    // orphaned. It is gone: migrateSession's discovery read (and
    // the authoritative re-read inside each per-device
    // transaction) decides from the store itself.
    const ensureSenderKeyAndCreateSkdm = async (group, meId) => {
        // AunuBaileys (2.3.0, HB-398): see ownSenderIdentity above.
        const senderName = jidToSignalSenderKeyName(group, ownSenderIdentity(meId));
        const senderNameStr = senderName.toString();
        const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
        if (!senderKey) {
            await storage.storeSenderKey(senderName, new SenderKeyRecord());
        }
        // AunuBaileys (2.3.0, HB-398 addendum, legacy poison):
        // ownSenderIdentity only stops NEW poisoning — a record
        // poisoned pre-2.3.0 still throws 'Incorrect private key
        // length: 0' on every encrypt (GroupCipher signs with the
        // newest state's signing private), while decrypt keeps
        // working on the same record, so the decrypt self-heal
        // never fires and every group send fails permanently.
        // Our own states always carry a signing private (create()
        // generates one); a newest state without one can only be a
        // peer SKDM that landed in our record. Drop trailing
        // private-less states before create() runs — a surviving
        // older own state keeps encrypting on its existing chain
        // (no rotation, receivers keep decrypting); if none
        // survives the record is empty and create() mints a fresh
        // key, distributed by the send path as usual. Only the
        // newest state matters for encrypt/create, so older states
        // are left untouched, and peer records are never touched —
        // this helper only ever names OUR OWN sender key.
        const record = await storage.loadSenderKey(senderName);
        const states = record.serialize();
        let kept = states.length;
        while (kept > 0) {
            const priv = states[kept - 1]?.senderSigningKey?.private;
            if (priv && priv.length > 0) {
                break;
            }
            kept -= 1;
        }
        if (kept < states.length) {
            logger.warn({ group, dropped: states.length - kept, kept }, 'HB-398 legacy poison: dropping own sender-key states without a signing private');
            await storage.storeSenderKey(senderName, new SenderKeyRecord(states.slice(0, kept)));
        }
        const skdm = await new GroupSessionBuilder(storage).create(senderName);
        return { senderName, skdm };
    };
    const repository = {
        async decryptGroupMessage({ group, authorJid, msg }) {
            // AunuBaileys (2.4.0, HB-469): canonical sender-key name
            // (see canonicalSenderKeyName). An unbuildable author
            // (HB-424 addendum) fails as sender-key-unavailable —
            // the classifier-excluded class — instead of aborting
            // the whole decrypt-failure path with a converter throw.
            const senderName = await canonicalSenderKeyName(group, authorJid);
            if (!senderName) {
                throw new Error('No session found to decrypt message');
            }
            const cipher = new GroupCipher(storage, senderName);
            // Use transaction to ensure atomicity
            return parsedKeys.transaction(async () => {
                return cipher.decrypt(msg);
            }, group);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            // AunuBaileys (2.4.0, HB-469 + HB-424 addendum):
            // canonical name; an unbuildable author's SKDM can
            // never be addressed, so skip it instead of throwing.
            const senderName = await canonicalSenderKeyName(item.groupId, authorJid);
            if (!senderName) {
                logger.warn({ authorJid }, 'aunu: skipping sender-key distribution from an unbuildable author JID');
                return;
            }
            const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            // AunuBaileys (HB-240, re-applied P3): NO sender-key read or
            // store may happen outside the per-group transaction below.
            // The pre-transaction block that used to sit here re-checked
            // and stored an empty record unserialised: a concurrent
            // encryptGroupMessage transaction could create the real key
            // between this read and this store, and the empty record
            // then overwrote it. All four group paths (encrypt,
            // getSenderKeyDistributionMessage, decrypt,
            // processSenderKeyDistributionMessage) now run entirely
            // inside parsedKeys.transaction(..., groupId) \u2014 the
            // keyed transaction serialises per group, a superset of
            // the (group, sender) pair, so no parallel path for the
            // same pair remains. The check-and-store is duplicated
            // INSIDE the transaction, where it is race-free.
            return parsedKeys.transaction(async () => {
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new SenderKeyRecord());
                }
                await builder.process(senderName, senderMsg);
            }, item.groupId);
        },
        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const session = new libsignal.SessionCipher(storage, addr);
            // Extract the sender's identity key from the pkmsg, but do
            // NOT save it yet (HB-350 below).
            let pendingIdentity;
            if (type === 'pkmsg') {
                const identityKey = extractIdentityFromPkmsg(ciphertext);
                if (identityKey) {
                    pendingIdentity = { addrStr: addr.toString(), identityKey };
                }
            }
            async function doDecrypt() {
                let result;
                switch (type) {
                    case 'pkmsg':
                        result = await session.decryptPreKeyWhisperMessage(ciphertext);
                        break;
                    case 'msg':
                        result = await session.decryptWhisperMessage(ciphertext);
                        break;
                }
                return result;
            }
            // If it's not a sync message, we need to ensure atomicity
            // For regular messages, we use a transaction to ensure atomicity
            // AunuBaileys (2.3.0, HB-94 addendum): keyed by the
            // resolved wire address, not the raw JID (see txKeyForJid).
            const result = await parsedKeys.transaction(async () => {
                if (type !== 'msg') {
                    return await doDecrypt();
                }
                // AunuBaileys (2.4.0, HB-446): libsignal's
                // decryptWithSessions tries the open session first,
                // and doDecryptWhisperMessage steps its ratchet
                // (maybeStepRatchet) BEFORE the MAC is verified —
                // when the open session then fails and an ARCHIVED
                // session wins, decryptWhisperMessage persists the
                // WHOLE record, including the open session whose
                // ratchet was just wrecked by the failed attempt:
                // one stale message permanently corrupted the live
                // session. Snapshot the record first; after a
                // successful decrypt, restore every session except
                // the winner (the entry whose `used` timestamp the
                // decrypt advanced) from the snapshot. If the
                // winner cannot be identified (its `used` did not
                // change), leave the record exactly as libsignal
                // persisted it — no restore is the safe direction.
                const addrStr = addr.toString();
                let snapshot;
                try {
                    const before = await storage.loadSession(addrStr);
                    if (before) {
                        snapshot = before.serialize();
                    }
                }
                catch {
                    snapshot = undefined;
                }
                const plaintext = await doDecrypt();
                if (snapshot) {
                    try {
                        const after = await storage.loadSession(addrStr);
                        if (after) {
                            const snapSessions = snapshot._sessions;
                            const afterSessions = after.serialize()._sessions;
                            let winnerKey;
                            for (const [key, entry] of Object.entries(afterSessions)) {
                                if (entry.indexInfo?.used !== snapSessions[key]?.indexInfo?.used) {
                                    winnerKey = key;
                                    break;
                                }
                            }
                            if (winnerKey) {
                                const snapRecord = libsignal.SessionRecord.deserialize(snapshot);
                                const afterRecord = after;
                                let restored = false;
                                for (const key of Object.keys(snapSessions)) {
                                    if (key === winnerKey) {
                                        continue;
                                    }
                                    const current = afterSessions[key];
                                    if (!current || JSON.stringify(current) !== JSON.stringify(snapSessions[key])) {
                                        afterRecord.sessions[key] = snapRecord.sessions[key];
                                        restored = true;
                                    }
                                }
                                if (restored) {
                                    await storage.storeSession(addrStr, after);
                                    logger.debug({ jid }, 'aunu: restored non-winning sessions from the pre-decrypt snapshot (HB-446)');
                                }
                            }
                        }
                    }
                    catch {
                        // The restore is best-effort: the plaintext is
                        // already recovered, and a restore failure must
                        // never turn a successful decrypt into a stub.
                    }
                }
                return plaintext;
            }, await txKeyForJid(jid));
            // AunuBaileys (2.2.0, HB-350): saveIdentity clears the
            // session when the identity changed — running it BEFORE
            // decryption was verified meant any undecryptable pkmsg
            // carrying a different identity key destroyed a healthy
            // session. Only a successfully decrypted message may
            // replace the identity (and the session with it).
            // AunuBaileys (2.3.0, addendum HB-350): the post-decrypt
            // saveIdentity call itself was unguarded — a store failure
            // inside it (keys.get/keys.set) threw out of
            // decryptMessage and discarded plaintext that had ALREADY
            // decrypted, feeding the stub/retry/self-heal machinery
            // for a message we actually hold. Log and keep the result:
            // the identity write is bookkeeping, the plaintext is not.
            if (pendingIdentity) {
                try {
                    const identityChanged = await storage.saveIdentity(pendingIdentity.addrStr, pendingIdentity.identityKey);
                    if (identityChanged) {
                        logger.info({ jid, addr: pendingIdentity.addrStr }, 'identity key changed or new contact, session will be re-established');
                    }
                }
                catch (err) {
                    logger.warn({ err, jid, addr: pendingIdentity.addrStr }, 'aunu: saveIdentity failed after a successful decrypt; keeping the plaintext and continuing');
                }
            }
            return result;
        },
        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            // Use transaction to ensure atomicity
            // AunuBaileys (2.3.0, HB-94 addendum): resolved-address
            // transaction key (see txKeyForJid).
            return parsedKeys.transaction(async () => {
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            }, await txKeyForJid(jid));
        },
        async encryptGroupMessage({ group, meId, data }) {
            return parsedKeys.transaction(async () => {
                const { senderName, skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                const ciphertext = await new GroupCipher(storage, senderName).encrypt(data);
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() };
            }, group);
        },
        async getSenderKeyDistributionMessage({ group, meId }) {
            return parsedKeys.transaction(async () => {
                const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                return skdm.serialize();
            }, group);
        },
        async hasSenderKey({ group, meId }) {
            // AunuBaileys (2.3.0, HB-398): probe the same canonical
            // sender name the encrypt path builds.
            const senderName = jidToSignalSenderKeyName(group, ownSenderIdentity(meId)).toString();
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName]);
            return !!key;
        },
        async getSessionInfo(jid) {
            const addr = jidToSignalProtocolAddress(jid).toString();
            // AunuBaileys (2.3.0, HB-371): loadSession now surfaces
            // transient store errors instead of swallowing them —
            // this read-only probe keeps its old contract (null =
            // unknown) so its callers never inherit the throw.
            let session;
            try {
                session = (await storage.loadSession(addr));
            }
            catch {
                return null;
            }
            if (!session) {
                return null;
            }
            const open = session.getOpenSession?.();
            const baseKey = open?.indexInfo?.baseKey;
            const registrationId = open?.registrationId;
            if (!baseKey || typeof registrationId !== 'number') {
                return null;
            }
            return { baseKey: new Uint8Array(baseKey), registrationId };
        },
        async injectE2ESession({ jid, session }) {
            logger.trace({ jid }, 'injecting E2EE session');
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            return parsedKeys.transaction(async () => {
                // libsignal runtime accepts an absent prekey (initOutgoing checks `device.preKey && ...`)
                // but the bundled .d.ts marks it required.
                await cipher.initOutgoing(session);
            }, 
            // AunuBaileys (2.3.0, HB-94 addendum): resolved-address
            // transaction key (see txKeyForJid).
            await txKeyForJid(jid));
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },
        // Optimized direct access to LID mapping store
        lidMapping,
        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid);
                const session = await storage.loadSession(addr.toString());
                if (!session) {
                    return { exists: false, reason: 'no session' };
                }
                if (!session.haveOpenSession()) {
                    return { exists: false, reason: 'no open session' };
                }
                return { exists: true };
            }
            catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },
        async deleteSenderKey(group, authorJid) {
            // AunuBaileys (re-applied P3): v6 repository parity \u2014 the
            // decrypt-failure self-heal deletes the stale sender-key
            // record for (group, author); v7 had no such method.
            // AunuBaileys (2.4.0, HB-469): canonical name, so the
            // delete lands on the record the decrypt path reads,
            // whichever spelling the author arrived under; an
            // unbuildable author (HB-424 addendum) is a no-op.
            const senderName = await canonicalSenderKeyName(group, authorJid);
            if (!senderName) {
                return;
            }
            const senderNameStr = senderName.toString();
            // AunuBaileys (2.4.0, HB-94 addendum run-0590): this used
            // to be a BARE keys.set — a group decrypt transaction
            // that started while the bare write was in flight loaded
            // the pre-delete record and its commit landed after the
            // delete, resurrecting the record the self-heal had just
            // removed. Run the delete inside the per-group
            // transaction (the same key every group path uses), so
            // it serialises against decrypt/process/encrypt: the
            // delete either lands fully before a decrypt loads, or
            // fully after its commit.
            await parsedKeys.transaction(async () => {
                await auth.keys.set({ 'sender-key': { [senderNameStr]: null } });
            }, group);
        },
        async deleteSession(jids) {
            if (!jids.length)
                return;
            // AunuBaileys (2.4.0, HB-440): the batch used to resolve
            // EVERY address before its single commit — one
            // unbuildable JID (a :99 device from a devices-remove
            // notification) threw in the resolution loop and NO
            // entry was deleted. Isolate per JID, like
            // parseAndInjectE2ESessions (HB-1): log and skip the
            // bad entry, delete the rest.
            for (const jid of jids) {
                let addr;
                let resolved;
                try {
                    addr = jidToSignalProtocolAddress(jid).toString();
                    resolved = await resolveWireAddr(addr);
                }
                catch (err) {
                    logger.warn({ jid, err }, 'aunu: skipping unbuildable JID in deleteSession; other sessions continue');
                    continue;
                }
                const sessionUpdates = { [addr]: null };
                // AunuBaileys (2.3.0, HB-377): loadSession/storeSession
                // resolve a PN address to its LID wire form, so the
                // record usually lives under the LID key — deleting
                // only the raw PN key was a silent no-op and the
                // self-heal never actually removed the session. Null
                // the resolved key too (a null write to a key that
                // holds nothing is harmless).
                if (resolved !== addr) {
                    sessionUpdates[resolved] = null;
                }
                // AunuBaileys (2.4.0, HB-94 addendum run-0646): one
                // transaction PER resolved address, keyed by that
                // address alone — the same key the peer's
                // decrypt/encrypt transactions use. The old batch
                // key (a joined list of every address) shared a
                // mutex with NOTHING, so a single-peer decrypt that
                // was in flight during a multi-JID delete loaded the
                // pre-delete record and its later commit resurrected
                // exactly that device's session.
                await parsedKeys.transaction(async () => {
                    await auth.keys.set({ session: sessionUpdates });
                }, resolved);
            }
        },
        close() {
            lidMapping.close();
        },
        async migrateSession(fromJid, toJid) {
            // TODO: use usync to handle this entire mess
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid)))
                return { migrated: 0, skipped: 0, total: 0 };
            // Only support PN to LID migration
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
                return { migrated: 0, skipped: 0, total: 1 };
            }
            const { user } = jidDecode(fromJid);
            logger.debug({ fromJid }, 'bulk device migration - loading all user devices');
            // Get user's device list from storage
            const { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
            // AunuBaileys (2.1.0, HB-317): a stored device-list of the wrong shape (string/number from a corrupt auth state) used to throw here and NACK-loop the peer's messages — treat it as absent.
            if (!Array.isArray(userDevices)) {
                return { migrated: 0, skipped: 0, total: 0 };
            }
            const { device: fromDevice } = jidDecode(fromJid);
            const fromDeviceStr = fromDevice?.toString() || '0';
            if (!userDevices.includes(fromDeviceStr)) {
                userDevices.push(fromDeviceStr);
            }
            // AunuBaileys (2.4.0, HB-449): no migrated-session
            // cache filter — it was never invalidated, so a PN
            // session created after the first migration was
            // skipped forever. Every listed device is a discovery
            // candidate; the store read below decides.
            const uncachedDevices = userDevices;
            // AunuBaileys (2.3.0, HB-395): session records live under
            // the canonical WIRE address (jidToSignalProtocolAddress),
            // which carries a `_<domainType>` suffix for non-WhatsApp
            // domains — a hosted peer's sessions sit under
            // `user_128.<device>`, and its device 99 under
            // `user_128.99`. The old lookup built bare `${user}.${device}`
            // keys and the reconstruction below hardcoded
            // `@s.whatsapp.net`, so for hosted peers (and for device
            // 99 generally) the lookup missed every record and the
            // migration silently migrated nothing. Build each
            // device's JID from the SOURCE JID's own server and key
            // the lookup by its wire address.
            const fromServer = jidDecode(fromJid).server;
            const deviceJidFor = (device) => device === '0'
                ? `${user}@${fromServer}`
                : device === '99'
                    ? `${user}:99@hosted`
                    : `${user}:${device}@${fromServer}`;
            const wireKeyToJid = new Map();
            for (const device of uncachedDevices) {
                const deviceJid = deviceJidFor(device);
                try {
                    wireKeyToJid.set(jidToSignalProtocolAddress(deviceJid).toString(), deviceJid);
                }
                catch {
                    // An unbuildable device JID has no session to migrate.
                }
            }
            // Bulk check session existence only for uncached devices
            const deviceSessionKeys = [...wireKeyToJid.keys()];
            const existingSessions = await parsedKeys.get('session', deviceSessionKeys);
            // Step 3: Convert existing sessions to JIDs (only migrate sessions that exist)
            const deviceJids = [];
            for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
                if (sessionData) {
                    const deviceJid = wireKeyToJid.get(sessionKey);
                    if (deviceJid) {
                        deviceJids.push(deviceJid);
                    }
                }
            }
            logger.debug({
                fromJid,
                totalDevices: userDevices.length,
                devicesWithSessions: deviceJids.length,
                devices: deviceJids
            }, 'bulk device migration complete - all user devices processed');
            const migrationOps = [];
            for (const jid of deviceJids) {
                const lidWithDevice = transferDevice(jid, toJid);
                // AunuBaileys (2.3.0, HB-395): an unbuildable
                // migration TARGET (e.g. device 99 under a plain
                // @lid address, which jidToSignalProtocolAddress
                // rejects) used to throw here and abort the WHOLE
                // migration inside the transaction — skip that
                // device instead, mirroring the discovery pass
                // above, which skips unbuildable source JIDs.
                let fromAddr;
                let toAddr;
                try {
                    fromAddr = jidToSignalProtocolAddress(jid);
                    toAddr = jidToSignalProtocolAddress(lidWithDevice);
                }
                catch {
                    continue;
                }
                migrationOps.push({
                    fromJid: jid,
                    toJid: lidWithDevice,
                    fromAddr,
                    toAddr
                });
            }
            // AunuBaileys (2.4.0, HB-409 + addendum TOCTOU): one
            // transaction PER DEVICE, keyed by the target LID wire
            // address — the same key the peer's decrypt/encrypt
            // transactions resolve to (txKeyForJid maps the PN
            // spelling onto it too). The old single transaction
            // used a bespoke `migrate-N-sessions-<user>` key that
            // serialised against NOTHING, and it never read the
            // target: a live LID session was overwritten with the
            // PN session's bytes, deterministically (HB-409) and
            // by race whenever a concurrent pkmsg decrypt created
            // the LID session between the discovery read and the
            // migration commit (addendum). Inside the per-device
            // transaction both records are re-read under the lock:
            // a target with an open session WINS (skip the copy),
            // and no decrypt for this peer can interleave between
            // the re-read and the commit.
            let migratedCount = 0;
            for (const op of migrationOps) {
                const pnAddrStr = op.fromAddr.toString();
                const lidAddrStr = op.toAddr.toString();
                const didMigrate = await parsedKeys.transaction(async () => {
                    const fresh = await parsedKeys.get('session', [pnAddrStr, lidAddrStr]);
                    const pnSession = fresh[pnAddrStr];
                    if (!pnSession) {
                        return false;
                    }
                    // AunuBaileys (2.2.0, HB-2026-1112-110 addendum): a
                    // corrupt stored record used to throw out of
                    // deserialize and abort the WHOLE migration —
                    // treat it as absent, like loadSession does.
                    let fromSession;
                    try {
                        fromSession = libsignal.SessionRecord.deserialize(pnSession);
                    }
                    catch {
                        fromSession = undefined;
                    }
                    if (!fromSession?.haveOpenSession()) {
                        return false;
                    }
                    // HB-409: never overwrite a live target session.
                    // A corrupt target deserialises to absent (the
                    // loadSession rule), so it may be replaced.
                    // AunuBaileys (2.4.0, HB-409 × HB-449): one
                    // exception, decided by establishment recency.
                    // HB-449's case: after an earlier migration the
                    // peer RE-KEYED under the PN spelling, so the
                    // source record holds a session ESTABLISHED
                    // LATER than the target's open session was
                    // created or last used — the target is the stale
                    // previous generation and the source is the
                    // peer's current session; moving it is the
                    // migration's whole point. HB-409's case is the
                    // mirror image: the target session is the newer
                    // or equally-current one (established via real
                    // LID traffic after the PN session), and it
                    // wins. Same open baseKey on both sides means
                    // the session is already migrated — skip. Any
                    // missing/non-finite timestamp also skips: when
                    // recency cannot be proven, the target wins.
                    const targetSession = fresh[lidAddrStr];
                    if (targetSession) {
                        let target;
                        try {
                            target = libsignal.SessionRecord.deserialize(targetSession);
                        }
                        catch {
                            target = undefined;
                        }
                        if (target?.haveOpenSession()) {
                            const openInfo = (record) => record.getOpenSession?.()?.indexInfo;
                            const fromInfo = openInfo(fromSession);
                            const targetInfo = openInfo(target);
                            const fromKey = fromInfo?.baseKey ? Buffer.from(fromInfo.baseKey).toString('base64') : undefined;
                            const targetKey = targetInfo?.baseKey
                                ? Buffer.from(targetInfo.baseKey).toString('base64')
                                : undefined;
                            const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
                            const sourceIsNewerGeneration = !!fromKey &&
                                !!targetKey &&
                                fromKey !== targetKey &&
                                isTime(fromInfo?.created) &&
                                isTime(targetInfo?.created) &&
                                isTime(targetInfo?.used) &&
                                fromInfo.created > targetInfo.created &&
                                fromInfo.created > targetInfo.used;
                            if (!sourceIsNewerGeneration) {
                                return false;
                            }
                        }
                    }
                    await parsedKeys.set({
                        session: { [lidAddrStr]: fromSession.serialize(), [pnAddrStr]: null }
                    });
                    return true;
                }, lidAddrStr);
                if (didMigrate) {
                    migratedCount++;
                }
            }
            if (migratedCount > 0) {
                logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete');
            }
            const totalOps = migrationOps.length;
            return { migrated: migratedCount, skipped: totalOps - migratedCount, total: totalOps };
        }
    };
    return repository;
}
const jidToSignalProtocolAddress = (jid) => {
    // AunuBaileys (2.1.0, sweep): jidDecode returns undefined for a JID
    // without '@' — the bare `!` died as a raw TypeError one line down.
    const decoded = jidDecode(jid);
    if (!decoded) {
        throw new Error(`Cannot derive a Signal ProtocolAddress from JID "${jid}": jidDecode returned nothing`);
    }
    const { user, device, server, domainType } = decoded;
    if (!user) {
        throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`);
    }
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    const finalDevice = device || 0;
    if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
        throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid);
    }
    return new libsignal.ProtocolAddress(signalUser, finalDevice);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new SenderKeyName(group, jidToSignalProtocolAddress(user));
};
function signalStorage({ creds, keys }, lidMapping) {
    // Shared function to resolve PN signal address to LID if mapping exists
    const resolveLIDSignalAddress = async (id) => {
        if (id.includes('.')) {
            const [deviceId, device] = id.split('.');
            const [user, domainType_] = deviceId.split('_');
            const domainType = parseInt(domainType_ || '0');
            if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
                return id;
            const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
            // AunuBaileys (2.2.0, HB-343 + HB-353): the mapping lookup
            // can throw (USync/IQ failure) — that throw used to escape
            // storeSession/saveIdentity/loadIdentityKey unguarded and,
            // via loadSession's blanket catch, masquerade as "no
            // session record". A failed lookup is a mapping MISS:
            // fall back to the raw id, exactly like the timeout path.
            let lidForPN = null;
            try {
                lidForPN = await lidMapping.getLIDForPN(pnJid);
            }
            catch {
                lidForPN = null;
            }
            if (lidForPN) {
                const lidAddr = jidToSignalProtocolAddress(lidForPN);
                return lidAddr.toString();
            }
        }
        return id;
    };
    // AunuBaileys (2.4.0, HB-94 addendum run-0590): saveIdentity's
    // session-clearing write used to be a BARE keys.set — a decrypt
    // transaction that started while the bare write was in flight
    // loaded the pre-clear record and its commit landed after the
    // clear, resurrecting the session the identity change had just
    // reset. The implementation below is wrapped by saveIdentity
    // in a transaction keyed by the resolved wire address (the
    // same key decrypt/encrypt use); when saveIdentity is called
    // from inside a decrypt (libsignal's initIncoming), the
    // transaction wrapper joins the in-flight context instead, so
    // the behaviour there is unchanged.
    const saveIdentityForWire = async (wireJid, identityKey) => {
        const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid]);
        // AunuBaileys (2.1.0, HB-98 addendum): a stored identity key in string form (a legacy/corrupt auth file) used to throw a bare TypeError from .every here, leaving the peer permanently unreadable with no self-heal. Normalise to bytes first; a value that is neither bytes nor a string counts as absent and is overwritten below.
        const existingKeyBytes = existingKey instanceof Uint8Array
            ? existingKey
            : typeof existingKey === 'string'
                ? storedKeyToBuffer(existingKey)
                : undefined;
        const keysMatch = existingKeyBytes?.length === identityKey.length &&
            existingKeyBytes.every((byte, i) => byte === identityKey[i]);
        if (existingKeyBytes && !keysMatch) {
            // Identity changed - clear session and update key
            await keys.set({
                session: { [wireJid]: null },
                'identity-key': { [wireJid]: identityKey }
            });
            return true;
        }
        if (!existingKeyBytes) {
            // New contact - Trust on First Use (TOFU)
            await keys.set({ 'identity-key': { [wireJid]: identityKey } });
            return true;
        }
        return false;
    };
    return {
        loadSession: async (id) => {
            // AunuBaileys (2.3.0, HB-371 + addendum): the blanket
            // catch here made a TRANSIENT store read failure (I/O
            // error, locked DB, closed store) indistinguishable from
            // "no session" — libsignal then threw 'No session
            // record', the decrypt-failure classifier treated it as
            // an unrecoverable session-layer failure, and the
            // self-heal deleted a HEALTHY session on the first
            // message (the retry sites compounded it via
            // validateSession). Separate the cases: a keys.get
            // failure is rethrown as itself, so the failure surfaces
            // with its real text and never matches the session-error
            // classifiers; only a genuinely absent record — or one
            // whose bytes no longer deserialise (corrupt records
            // self-heal through the normal reset path) — is null.
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: sess } = await keys.get('session', [wireJid]);
            if (sess) {
                try {
                    return libsignal.SessionRecord.deserialize(sess);
                }
                catch {
                    return null;
                }
            }
            return null;
        },
        storeSession: async (id, session) => {
            const wireJid = await resolveLIDSignalAddress(id);
            await keys.set({ session: { [wireJid]: session.serialize() } });
        },
        isTrustedIdentity: () => {
            return true; // TOFU - Trust on First Use (same as WhatsApp Web)
        },
        loadIdentityKey: async (id) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: key } = await keys.get('identity-key', [wireJid]);
            return key || undefined;
        },
        saveIdentity: async (id, identityKey) => {
            const wireJid = await resolveLIDSignalAddress(id);
            // HB-94 addendum run-0590: see saveIdentityForWire —
            // run the read/clear in a transaction keyed by the
            // wire address when a transaction capability exists;
            // a plain key store (no transaction) keeps the bare
            // path, exactly as before.
            const txKeys = keys;
            if (typeof txKeys.transaction === 'function') {
                return txKeys.transaction(async () => saveIdentityForWire(wireJid, identityKey), wireJid);
            }
            return saveIdentityForWire(wireJid, identityKey);
        },
        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                // AunuBaileys (1.0.71 + 1.0.74 HB-98, re-applied P3b):
                // a pre-key file that is JSON-valid but wrong-shaped
                // (e.g. {}) or wrong-TYPED (e.g. a number) used to
                // throw a bare TypeError from Buffer.from here,
                // failing that peer's pkmsg forever with no self-heal
                // match. Return undefined instead — libsignal raises
                // the diagnosable `PreKeyError: Invalid PreKey ID`.
                if (!isKeyMaterial(key.private) || !isKeyMaterial(key.public)) {
                    return undefined;
                }
                return {
                    privKey: storedKeyToBuffer(key.private),
                    pubKey: storedKeyToBuffer(key.public)
                };
            }
        },
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),
        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            // AunuBaileys (1.0.71, HB-26, re-applied P3b): the original
            // guard only checked the keyPair object itself —
            // {keyPair:{}} or {keyPair:{public}} slipped through and
            // threw a bare TypeError on EVERY pkmsg. Check the fields,
            // like getOurIdentity does. A partial/corrupt creds
            // restore otherwise fails every pre-key message with a
            // cryptic TypeError and never heals — say what is wrong.
            if (!isKeyMaterial(key?.keyPair?.private) || !isKeyMaterial(key?.keyPair?.public)) {
                throw new Error('AunuBaileys: creds.signedPreKey is missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            return {
                privKey: storedKeyToBuffer(key.keyPair.private),
                pubKey: storedKeyToBuffer(key.keyPair.public)
            };
        },
        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return SenderKeyRecord.deserialize(key);
            }
            return new SenderKeyRecord();
        },
        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            // AunuBaileys (2.0.5, HB-327): serialize() carries the
            // chain/iteration seeds as Buffers — without BufferJSON.replacer
            // they land on disk as {type:'Buffer',data:[...]}, a shape
            // BufferJSON.reviver does not restore, so the HB-124 sanitizer
            // dropped every state on load and ALL group encrypt/decrypt
            // failed. The replacer stores them as base64 strings, the
            // only form the reviver accepts.
            const serialized = JSON.stringify(key.serialize(), BufferJSON.replacer);
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } });
        },
        getOurRegistrationId: () => creds.registrationId,
        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            // AunuBaileys (HB-26/HB-98, re-applied P3b): same
            // field-level guard as loadSignedPreKey — a partial
            // creds restore dereferenced bare here and threw a bare
            // TypeError on every pkmsg.
            if (!isKeyMaterial(signedIdentityKey?.private) || !isKeyMaterial(signedIdentityKey?.public)) {
                throw new Error('AunuBaileys: creds.signedIdentityKey is missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again');
            }
            return {
                privKey: storedKeyToBuffer(signedIdentityKey.private),
                pubKey: Buffer.from(generateSignalPubKey(storedKeyToBuffer(signedIdentityKey.public)))
            };
        }
    };
}
//# sourceMappingURL=libsignal.js.map