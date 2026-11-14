import { BufferJSON } from '../../Utils/generics.js';
import { SenderKeyState } from './sender-key-state.js';
// AunuBaileys (1.0.78, HB-124/HB-162/HB-180/HB-197): stored sender-key
// states used to be checked for EXISTENCE only — a hand-edited or
// corrupt sender-key-*.json could carry a number where a seed belongs
// (raw TypeError on every group decrypt/encrypt), a base64 string the
// chain key decoded as UTF-8 (silently wrong keys), a string iteration
// ('5' + 1 === '51' — concatenation poisoned the chain and bricked
// group sends with 'Over 2000 messages into the future!'), a missing
// iteration (NaN — every SKM went out with wire iteration 0 forever),
// or a string/missing senderKeyId (strict === lookup always missed).
// Normalise what has a documented house format (base64 strings,
// numeric strings) and DROP what cannot be made valid — a dropped
// state self-heals via a fresh SKDM / a fresh own state, a poisoned
// one never does. Key material produced by our own serializer always
// satisfies these shapes (32-byte seeds, 32/33-byte signing public).
const storedSeedToBuffer = (value) => Buffer.isBuffer(value)
    ? value
    : (typeof value === 'string' ? Buffer.from(value, 'base64') : null);
const storedCountToNumber = (value) => {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : null;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
};
const sanitizeSenderKeyStructure = (structure) => {
    const chainKey = structure.senderChainKey;
    const signingKey = structure.senderSigningKey;
    if (!chainKey || typeof chainKey !== 'object' || !signingKey || typeof signingKey !== 'object') {
        return null;
    }
    const seed = storedSeedToBuffer(chainKey.seed);
    if (!seed || seed.length !== 32) {
        return null;
    }
    const iteration = storedCountToNumber(chainKey.iteration);
    // AunuBaileys (1.0.88, HB-202): a NEGATIVE iteration passes the
    // integer check above, but protobufjs encodes the field as
    // uint32 — it wraps (-5 -> 4294967291), so peers fail every
    // message from this state until a 3-strike resync heals it.
    // The finite/integer check alone cannot see this; reject
    // negatives exactly like missing values.
    if (iteration === null || iteration < 0) {
        return null;
    }
    const signingPublic = storedSeedToBuffer(signingKey.public);
    if (!signingPublic || (signingPublic.length !== 32 && signingPublic.length !== 33)) {
        return null;
    }
    const cleanSigning = { public: signingPublic };
    if (typeof signingKey.private !== 'undefined') {
        const signingPrivate = storedSeedToBuffer(signingKey.private);
        if (!signingPrivate || signingPrivate.length !== 32) {
            return null;
        }
        cleanSigning.private = signingPrivate;
    }
    const keyId = storedCountToNumber(structure.senderKeyId);
    if (keyId === null) {
        return null;
    }
    // senderMessageKeys: drop individual entries that cannot be used
    // (HB-124 addenda) instead of dropping the whole state — the chain
    // itself is still good.
    const messageKeys = [];
    if (Array.isArray(structure.senderMessageKeys)) {
        for (const entry of structure.senderMessageKeys) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const mkIteration = storedCountToNumber(entry.iteration);
            const mkSeed = storedSeedToBuffer(entry.seed);
            // (1.0.88, HB-202): negative message-key iterations wrap
            // on the wire the same way — skip those entries too.
            if (mkIteration === null || mkIteration < 0 || !mkSeed || mkSeed.length !== 32) {
                continue;
            }
            messageKeys.push({ iteration: mkIteration, seed: mkSeed });
        }
    }
    return {
        senderKeyId: keyId,
        senderChainKey: { iteration, seed },
        senderSigningKey: cleanSigning,
        senderMessageKeys: messageKeys
    };
};
export class SenderKeyRecord {
    constructor(serialized) {
        this.MAX_STATES = 5;
        this.senderKeyStates = [];
        // AunuBaileys (1.0.71): only an array deserializes into states
        // — a wrong-shaped stored value (e.g. {}) used to throw a bare
        // TypeError here; treat it as an empty record instead so the
        // group self-heal can re-establish the sender key.
        if (serialized && Array.isArray(serialized)) {
            for (const structure of serialized) {
                // AunuBaileys (1.0.72): a state entry without its
                // chain/signing keys (e.g. [{}] from a wrong-shaped
                // store) used to load "fine" and then throw a bare
                // TypeError on every group send, forever (HB-69).
                // Skip entries that cannot possibly work.
                // (1.0.78, HB-124/HB-162/HB-180/HB-197): existence is
                // not enough — sanitise the field TYPES (see
                // sanitizeSenderKeyStructure above) and skip states
                // that stay invalid after normalisation.
                if (!structure || typeof structure !== 'object') {
                    continue;
                }
                const clean = sanitizeSenderKeyStructure(structure);
                if (!clean) {
                    continue;
                }
                this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, clean));
            }
        }
    }
    isEmpty() {
        return this.senderKeyStates.length === 0;
    }
    getSenderKeyState(keyId) {
        if (keyId === undefined && this.senderKeyStates.length) {
            return this.senderKeyStates[this.senderKeyStates.length - 1];
        }
        return this.senderKeyStates.find(state => state.getKeyId() === keyId);
    }
    addSenderKeyState(id, iteration, chainKey, signatureKey) {
        this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey));
        if (this.senderKeyStates.length > this.MAX_STATES) {
            this.senderKeyStates.shift();
        }
    }
    setSenderKeyState(id, iteration, chainKey, keyPair) {
        this.senderKeyStates.length = 0;
        this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair));
    }
    serialize() {
        return this.senderKeyStates.map(state => state.getStructure());
    }
    static deserialize(data) {
        let parsed;
        try {
            if (typeof data === 'string') {
                parsed = JSON.parse(data, BufferJSON.reviver);
            }
            else if (data instanceof Uint8Array) {
                const str = Buffer.from(data).toString('utf-8');
                parsed = JSON.parse(str, BufferJSON.reviver);
            }
            else {
                parsed = data;
            }
        }
        catch {
            // AunuBaileys (1.0.72): a truncated/corrupt stored record
            // used to throw SyntaxError out of loadSenderKey, failing
            // every group send to that group permanently with no
            // self-heal (HB-69). An empty record lets the normal
            // sender-key flow re-establish the key.
            return new SenderKeyRecord();
        }
        return new SenderKeyRecord(parsed);
    }
}
//# sourceMappingURL=sender-key-record.js.map