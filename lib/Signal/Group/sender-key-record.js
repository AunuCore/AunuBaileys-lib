import { BufferJSON } from '../../Utils/generics.js';
import { SenderKeyState } from './sender-key-state.js';
// AunuBaileys (1.0.78, HB-124/HB-162/HB-180/HB-197 + 1.0.88 HB-202;
// HB-223 choke point, re-applied P3): stored sender-key states used
// to be built from the serialised structures with ZERO validation \u2014
// a number where a seed belongs (raw TypeError on every group
// decrypt/encrypt), a base64 string decoded as UTF-8 (silently wrong
// keys), a string iteration ('5' + 1 === '51' \u2014 concatenation
// poisoned the chain), a missing iteration (NaN \u2014 wire iteration 0
// forever), a negative iteration (protobufjs wraps it as uint32), or
// a string senderKeyId (strict === lookup always missed).
// Normalise what has a documented house format (base64 strings,
// numeric strings) and DROP what cannot be made valid \u2014 a dropped
// state self-heals via a fresh SKDM; a poisoned one never does.
const storedSeedToBuffer = (value) => Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'base64') : null;
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
    const chainKey = structure?.senderChainKey;
    const signingKey = structure?.senderSigningKey;
    if (!chainKey || typeof chainKey !== 'object' || !signingKey || typeof signingKey !== 'object') {
        return null;
    }
    const seed = storedSeedToBuffer(chainKey.seed);
    if (!seed || seed.length !== 32) {
        return null;
    }
    const iteration = storedCountToNumber(chainKey.iteration);
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
    const keyId = storedCountToNumber(structure?.senderKeyId);
    // AunuBaileys (HB-271, P4): a negative senderKeyId slipped through
    // here — HB-202 rejected negative chain/message-key iterations but
    // never this field. A wire id is a uint32 (>= 0) and the record
    // lookup is a strict ===, so a stored negative id is unreachable
    // dead weight that also wastes one of the MAX_STATES slots.
    if (keyId === null || keyId < 0) {
        return null;
    }
    const messageKeys = [];
    if (Array.isArray(structure?.senderMessageKeys)) {
        for (const entry of structure.senderMessageKeys) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const mkIteration = storedCountToNumber(entry.iteration);
            const mkSeed = storedSeedToBuffer(entry.seed);
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
        // Only an array deserialises into states \u2014 a wrong-shaped
        // stored value is an empty record, not a bare TypeError, so
        // the group self-heal can re-establish the sender key.
        if (serialized && Array.isArray(serialized)) {
            for (const structure of serialized) {
                const clean = sanitizeSenderKeyStructure(structure);
                if (clean) {
                    this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, clean));
                }
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
            const str = Buffer.from(data).toString('utf-8');
            parsed = JSON.parse(str, BufferJSON.reviver);
        }
        catch {
            // AunuBaileys (1.0.72, HB-69, re-applied P3b): a
            // truncated/corrupt stored record used to throw
            // SyntaxError out of loadSenderKey, failing every group
            // send to that group permanently with no self-heal. An
            // empty record lets the normal sender-key flow
            // re-establish the key. (Wrong-SHAPED parsed values are
            // handled by the constructor's sanitiser, HB-124.)
            return new SenderKeyRecord();
        }
        return new SenderKeyRecord(parsed);
    }
}
//# sourceMappingURL=sender-key-record.js.map