import * as keyhelper from './keyhelper.js';
import { SenderChainKey } from './sender-chain-key.js';
import { SenderKeyDistributionMessage } from './sender-key-distribution-message.js';
import { SenderKeyName } from './sender-key-name.js';
import { SenderKeyRecord } from './sender-key-record.js';
export class GroupSessionBuilder {
    constructor(senderKeyStore) {
        this.senderKeyStore = senderKeyStore;
    }
    async process(senderKeyName, senderKeyDistributionMessage) {
        // AunuBaileys (1.0.78, HB-168, re-applied P3b): a malformed
        // SKDM used to be stored without any validation — a
        // missing/empty distribution message produced a junk state
        // (keyId 0, empty chain seed, empty signing key) that passed
        // the load-time guard, and five of them (MAX_STATES) evicted
        // the author's good state, after which every legitimate
        // message from that author failed with 'No session found'.
        // Refuse anything that cannot possibly work: a numeric id
        // and iteration, a 32-byte chain key and a 32/33-byte signing
        // key (our own builder emits 32 + 33). The statement lives
        // HERE, at the wrapper over the npm libsignal package — the
        // vendored-internal v6 fix site no longer exists in v7.
        const id = senderKeyDistributionMessage.getId();
        const iteration = senderKeyDistributionMessage.getIteration();
        const chainKey = senderKeyDistributionMessage.getChainKey();
        const signatureKey = senderKeyDistributionMessage.getSignatureKey();
        if (!Number.isFinite(id) ||
            !Number.isFinite(iteration) ||
            !(chainKey instanceof Uint8Array) ||
            chainKey.length !== 32 ||
            !(signatureKey instanceof Uint8Array) ||
            (signatureKey.length !== 32 && signatureKey.length !== 33)) {
            return;
        }
        // AunuBaileys (2.6.0, HB-168 addendum): a 33-byte signing
        // key must start with the 0x05 version byte — libsignal's
        // scrubPubKeyFormat accepts a 33-byte key ONLY on that
        // prefix, so any other first byte stores a state that
        // throws 'Invalid public key' on every group decrypt.
        // A 32-byte key is bare and needs no prefix.
        if (signatureKey.length === 33 && signatureKey[0] !== 0x05) {
            return;
        }
        // AunuBaileys (2.6.0, HB-168 addendum): the chain
        // iteration is a uint32 on the wire, but the sender's
        // encrypt step computes iteration+1 — at 2^32-1 that wraps
        // to 0 and the receiver throws 'Received message with old
        // counter'. Cap at 2^31-1 (the same bound
        // generateSenderKeyId uses); a legitimate chain can never
        // reach it, so anything above is a dead end by construction.
        if (!Number.isInteger(iteration) || iteration < 0 || iteration > 2147483647) {
            return;
        }
        const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName);
        // AunuBaileys (2.6.0, HB-456): a re-delivered SKDM is
        // byte-identical to the state it already created, but
        // addSenderKeyState pushed it again and the MAX_STATES
        // shift evicted DISTINCT states — five replays of one
        // SKDM left [5,5,5,5,5] and broke decryption of messages
        // under the evicted keys. Skip an exact duplicate
        // (same keyId, chain seed and signing key) with no store
        // write. A genuine rotation — same keyId but a new chain
        // key — still adds and evicts the oldest, as before.
        // AunuBaileys (2.7.0, HB-456 addendum facet 1): the
        // iteration comparison above defeated the dedup after a
        // single group decrypt — the STORED state's chain
        // advances on every decrypt (GroupCipher steps the
        // chain: iteration +1 AND seed replaced by its HMAC
        // derivative), while a re-delivered SKDM still carries
        // its ORIGINAL iteration and seed, so the byte-identical
        // SKDM no longer matched, was pushed again, and evicted
        // a DISTINCT state. Neither field is immutable, so
        // compare the state's LINEAGE instead: same keyId and
        // signing key, and the stored seed must be exactly the
        // SKDM seed advanced by the iteration difference (or
        // vice versa when the SKDM is the ahead one) along the
        // chain derivation. A genuine rotation has a different
        // signing key and an unrelated seed, so it never
        // matches. The step count is capped at the same 2000
        // bound getSenderKey enforces — beyond it the states
        // are treated as distinct.
        const MAX_DEDUP_CHAIN_STEPS = 2000;
        const advanceSeed = (fromIteration, seed, steps) => {
            let chain = new SenderChainKey(fromIteration, seed);
            for (let i = 0; i < steps; i++) {
                chain = chain.getNext();
            }
            return Buffer.from(chain.getSeed());
        };
        const duplicate = senderKeyRecord.serialize().some(state => {
            if (state.senderKeyId !== id) {
                return false;
            }
            if (!Buffer.from(state.senderSigningKey.public).equals(Buffer.from(signatureKey))) {
                return false;
            }
            const storedIteration = state.senderChainKey.iteration;
            const storedSeed = Buffer.from(state.senderChainKey.seed);
            if (storedIteration >= iteration) {
                const steps = storedIteration - iteration;
                return steps <= MAX_DEDUP_CHAIN_STEPS && advanceSeed(iteration, chainKey, steps).equals(storedSeed);
            }
            const steps = iteration - storedIteration;
            return steps <= MAX_DEDUP_CHAIN_STEPS && advanceSeed(storedIteration, storedSeed, steps).equals(Buffer.from(chainKey));
        });
        if (duplicate) {
            return;
        }
        senderKeyRecord.addSenderKeyState(senderKeyDistributionMessage.getId(), senderKeyDistributionMessage.getIteration(), senderKeyDistributionMessage.getChainKey(), senderKeyDistributionMessage.getSignatureKey());
        await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
    }
    async create(senderKeyName) {
        const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName);
        if (senderKeyRecord.isEmpty()) {
            const keyId = keyhelper.generateSenderKeyId();
            const senderKey = keyhelper.generateSenderKey();
            const signingKey = keyhelper.generateSenderSigningKey();
            senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey);
            await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
        }
        const state = senderKeyRecord.getSenderKeyState();
        if (!state) {
            throw new Error('No session state available');
        }
        return new SenderKeyDistributionMessage(state.getKeyId(), state.getSenderChainKey().getIteration(), state.getSenderChainKey().getSeed(), state.getSigningKeyPublic());
    }
}
//# sourceMappingURL=group-session-builder.js.map