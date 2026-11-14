/* @ts-ignore */
import * as libsignal from 'libsignal';
import { generateSignalPubKey } from '../Utils/index.js';
import { jidDecode } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
// AunuBaileys (1.0.74): HB-98 — key material is only ever a Buffer
// (or a string in a hand-edited creds file). Anything else is a
// wrong-typed corrupt value, not key material.
const isKeyMaterial = (value) => Buffer.isBuffer(value) || typeof value === 'string';
// AunuBaileys (1.0.78, HB-157): string key material is base64 (the
// house format) — decode it as such instead of Buffer.from()'s UTF-8,
// which produced 44-byte garbage keys and failed every new session.
const storedKeyToBuffer = (value) => typeof value === 'string' ? Buffer.from(value, 'base64') : value;
export function makeLibSignalRepository(auth) {
    const storage = signalStorage(auth);
    // AunuBaileys (1.0.78, HB-240): in-flight serialisation for
    // encryptGroupMessage, per group — see that method.
    const groupEncryptChains = new Map();
    return {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new GroupCipher(storage, senderName);
            return cipher.decrypt(msg);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new SenderKeyRecord());
            }
            await builder.process(senderName, senderMsg);
        },
        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const session = new libsignal.SessionCipher(storage, addr);
            let result;
            switch (type) {
                case 'pkmsg':
                    result = await session.decryptPreKeyWhisperMessage(ciphertext);
                    break;
                case 'msg':
                    result = await session.decryptWhisperMessage(ciphertext);
                    break;
                default:
                    throw new Error(`Unknown message type: ${type}`);
            }
            return result;
        },
        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            const { type: sigType, body } = await cipher.encrypt(data);
            const type = sigType === 3 ? 'pkmsg' : 'msg';
            return { type, ciphertext: Buffer.from(body, 'binary') };
        },
        async encryptGroupMessage({ group, meId, data }) {
            // AunuBaileys (1.0.78, HB-240): serialise per group.
            // GroupSessionBuilder.create() runs OUTSIDE GroupCipher's
            // per-group queueJob, so two concurrent first-sends to the
            // same group (empty sender-key record) both created a
            // fresh key and overwrote each other — the loser returned
            // an SKDM that did not match the ciphertext it encrypted
            // (which used the winner's stored state), and every peer
            // failed that first message. Chain the whole
            // create+encrypt per group; different groups still run in
            // parallel.
            const run = async () => {
                const senderName = jidToSignalSenderKeyName(group, meId);
                const builder = new GroupSessionBuilder(storage);
                const senderNameStr = senderName.toString();
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new SenderKeyRecord());
                }
                const senderKeyDistributionMessage = await builder.create(senderName);
                const session = new GroupCipher(storage, senderName);
                const ciphertext = await session.encrypt(data);
                return {
                    ciphertext,
                    senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
                };
            };
            const prev = groupEncryptChains.get(group) ?? Promise.resolve();
            const chained = prev.then(run);
            // the stored chain must never stay rejected, or one failed
            // send would poison every later send to the group
            const stored = chained.catch(() => { });
            groupEncryptChains.set(group, stored);
            // AunuBaileys (1.0.88, HB-256): the map used to keep one
            // entry per group FOREVER (a settled promise + the group
            // string, ~81 bytes each — small, but unbounded over the
            // socket's life: 6000 groups measured +477 KiB retained
            // after every store record was gone). Drop the entry
            // once its chain settles; the identity check protects a
            // NEWER chain for the same group from being deleted by
            // an older one, and `stored` never rejects, so this
            // cannot float an unhandled rejection.
            stored.then(() => {
                if (groupEncryptChains.get(group) === stored) {
                    groupEncryptChains.delete(group);
                }
            });
            return chained;
        },
        async deleteSenderKey(group, authorJid) {
            const senderNameStr = jidToSignalSenderKeyName(group, authorJid).toString();
            await auth.keys.set({ 'sender-key': { [senderNameStr]: null } });
        },
        async deleteSession(jid) {
            const addr = jidToSignalProtocolAddress(jid).toString();
            await auth.keys.set({ session: { [addr]: null } });
        },
        async migrateSession(fromJid, toJid) {
            // AunuBaileys: move a stored session record to another address
            // form of the same identity (PN -> LID). The raw record is
            // moved untouched; an existing target record is never
            // overwritten. Returns true when a record was moved.
            const fromAddr = jidToSignalProtocolAddress(fromJid).toString();
            const toAddr = jidToSignalProtocolAddress(toJid).toString();
            if (fromAddr === toAddr) {
                return false;
            }
            return auth.keys.transaction(async () => {
            const { [fromAddr]: record } = await auth.keys.get('session', [fromAddr]);
            if (!record) {
                return false;
            }
            const { [toAddr]: existing } = await auth.keys.get('session', [toAddr]);
            if (existing) {
                return false;
            }
            await auth.keys.set({ session: { [toAddr]: record, [fromAddr]: null } });
            return true;
            });
        },
        async injectE2ESession({ jid, session }) {
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            await cipher.initOutgoing(session);
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        }
    };
}
const jidToSignalProtocolAddress = (jid) => {
    const { user, device } = jidDecode(jid);
    return new libsignal.ProtocolAddress(user, device || 0);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new SenderKeyName(group, jidToSignalProtocolAddress(user));
};
function signalStorage({ creds, keys }) {
    return {
        loadSession: async (id) => {
            const { [id]: sess } = await keys.get('session', [id]);
            if (sess) {
                try {
                    return libsignal.SessionRecord.deserialize(sess);
                }
                catch (err) {
                    // AunuBaileys (1.0.71): a malformed stored session
                    // record used to throw a bare TypeError from inside
                    // SessionRecord.deserialize (e.g. a v1 entry whose
                    // inner session is {}), which matches no self-heal
                    // classifier and misleads diagnostics. Say what is
                    // actually wrong; the 3-strike self-heal still clears
                    // the poisoned record via deleteSession.
                    // (1.0.78, HB-110): the conversion used to cover only
                    // TypeError — a record with a non-v1 version throws a
                    // plain Error('Error migrating SessionRecord') from
                    // libsignal and escaped raw. Convert EVERY
                    // deserialize failure; the behaviour (3-strike
                    // self-heal) is identical, only the message improves.
                    throw new Error(`AunuBaileys: stored session record for ${id} is corrupt or malformed and cannot be deserialized; delete the session and re-establish it`);
                }
            }
        },
        // TODO: Replace with libsignal.SessionRecord when type exports are added to libsignal
        storeSession: async (id, session) => {
            await keys.set({ session: { [id]: session.serialize() } });
        },
        isTrustedIdentity: () => {
            return true;
        },
        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                // AunuBaileys (1.0.71): a pre-key file that is JSON-valid
                // but wrong-shaped (e.g. {}) used to throw a bare
                // TypeError from Buffer.from(undefined) here, failing
                // that peer's pkmsg forever with no self-heal match.
                // Return undefined instead — libsignal raises the
                // diagnosable `PreKeyError: Invalid PreKey ID`.
                // (1.0.74, HB-98: wrong-TYPED material — e.g. a number —
                // slipped past the truthiness check and threw the bare
                // TypeError from Buffer.from anyway; same treatment.)
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
            // AunuBaileys (1.0.71): the 1.0.66 guard only checked the
            // keyPair object itself — {keyPair:{}} or {keyPair:{public}}
            // slipped through and threw a bare TypeError on EVERY pkmsg.
            // Check the fields, like getOurIdentity does (HB-26).
            if (!isKeyMaterial(key?.keyPair?.private) || !isKeyMaterial(key?.keyPair?.public)) {
                // AunuBaileys: a partial/corrupt creds restore (creds
                // present, signedPreKey gone) otherwise fails EVERY
                // pre-key message with a cryptic TypeError and never
                // heals. Say what is actually wrong, once, clearly.
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
            const serialized = JSON.stringify(key.serialize());
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } });
        },
        getOurRegistrationId: () => creds.registrationId,
        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            // AunuBaileys (1.0.70): a partial/corrupt creds file used to
            // throw a bare TypeError here on EVERY pkmsg, forever, with
            // no self-heal classifier matching it. Fail descriptively
            // so the host knows a re-pair is the fix.
            if (!isKeyMaterial(signedIdentityKey?.private) || !isKeyMaterial(signedIdentityKey?.public)) {
                throw new Error('Our signed identity key is missing or incomplete — the auth state is corrupt; re-pair the device');
            }
            return {
                privKey: storedKeyToBuffer(signedIdentityKey.private),
                pubKey: generateSignalPubKey(signedIdentityKey.public)
            };
        }
    };
}
//# sourceMappingURL=libsignal.js.map