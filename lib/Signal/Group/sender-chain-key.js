/* @ts-ignore */
import { calculateMAC } from 'libsignal/src/crypto.js';
import { SenderMessageKey } from './sender-message-key.js';
export class SenderChainKey {
    constructor(iteration, chainKey) {
        this.MESSAGE_KEY_SEED = Buffer.from([0x01]);
        this.CHAIN_KEY_SEED = Buffer.from([0x02]);
        // AunuBaileys (1.0.78, HB-162/HB-180): a stored string seed is
        // base64 (the house format), not UTF-8 text, and a numeric
        // string iteration must become a number — '5' + 1 === '51'
        // concatenation poisoned the chain. Stored records are
        // sanitised at load (sender-key-record.js); this is the same
        // normalisation for direct constructions.
        this.iteration = typeof iteration === 'string' && /^-?\d+$/.test(iteration.trim()) ? Number(iteration) : iteration;
        if (chainKey instanceof Buffer) {
            this.chainKey = chainKey;
        }
        else if (typeof chainKey === 'string') {
            this.chainKey = Buffer.from(chainKey, 'base64');
        }
        else {
            this.chainKey = Buffer.from(chainKey || []);
        }
    }
    getIteration() {
        return this.iteration;
    }
    getSenderMessageKey() {
        return new SenderMessageKey(this.iteration, this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey));
    }
    getNext() {
        return new SenderChainKey(this.iteration + 1, this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey));
    }
    getSeed() {
        return this.chainKey;
    }
    getDerivative(seed, key) {
        return calculateMAC(key, seed);
    }
}
//# sourceMappingURL=sender-chain-key.js.map