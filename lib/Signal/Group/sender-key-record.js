import { BufferJSON } from '../../Utils/generics.js';
import { SenderKeyState } from './sender-key-state.js';
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
                if (!structure || typeof structure !== 'object' ||
                    !structure.senderChainKey || !structure.senderSigningKey) {
                    continue;
                }
                this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, structure));
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