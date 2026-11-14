import * as keyhelper from './keyhelper.js';
import { SenderKeyDistributionMessage } from './sender-key-distribution-message.js';
import { SenderKeyName } from './sender-key-name.js';
import { SenderKeyRecord } from './sender-key-record.js';
export class GroupSessionBuilder {
    constructor(senderKeyStore) {
        this.senderKeyStore = senderKeyStore;
    }
    async process(senderKeyName, senderKeyDistributionMessage) {
        // AunuBaileys (1.0.78, HB-168): a malformed SKDM used to be
        // stored without any validation — a missing/empty distribution
        // message produced a junk state (keyId 0, empty chain seed,
        // empty signing key) that passed the load-time guard, and five
        // of them (MAX_STATES) evicted the author's good state, after
        // which every legitimate message from that author failed with
        // 'No session found'. Refuse anything that cannot possibly
        // work: a numeric id and iteration, a 32-byte chain key and a
        // 32/33-byte signing key (our own builder emits 32 + 33).
        const id = senderKeyDistributionMessage.getId();
        const iteration = senderKeyDistributionMessage.getIteration();
        const chainKey = senderKeyDistributionMessage.getChainKey();
        const signatureKey = senderKeyDistributionMessage.getSignatureKey();
        if (!Number.isFinite(id) || !Number.isFinite(iteration) ||
            !Buffer.isBuffer(chainKey) || chainKey.length !== 32 ||
            !Buffer.isBuffer(signatureKey) || (signatureKey.length !== 32 && signatureKey.length !== 33)) {
            return;
        }
        const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName);
        senderKeyRecord.addSenderKeyState(id, iteration, chainKey, signatureKey);
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