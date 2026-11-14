import * as keyhelper from './keyhelper'
import { SenderKeyDistributionMessage } from './sender-key-distribution-message'
import { SenderKeyName } from './sender-key-name'
import { SenderKeyRecord } from './sender-key-record'

interface SenderKeyStore {
	loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>
	storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
}

export class GroupSessionBuilder {
	private readonly senderKeyStore: SenderKeyStore

	constructor(senderKeyStore: SenderKeyStore) {
		this.senderKeyStore = senderKeyStore
	}

	public async process(
		senderKeyName: SenderKeyName,
		senderKeyDistributionMessage: SenderKeyDistributionMessage
	): Promise<void> {
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
		const id = senderKeyDistributionMessage.getId()
		const iteration = senderKeyDistributionMessage.getIteration()
		const chainKey = senderKeyDistributionMessage.getChainKey()
		const signatureKey = senderKeyDistributionMessage.getSignatureKey()
		if (
			!Number.isFinite(id) ||
			!Number.isFinite(iteration) ||
			!(chainKey instanceof Uint8Array) ||
			chainKey.length !== 32 ||
			!(signatureKey instanceof Uint8Array) ||
			(signatureKey.length !== 32 && signatureKey.length !== 33)
		) {
			return
		}

		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)
		senderKeyRecord.addSenderKeyState(
			senderKeyDistributionMessage.getId(),
			senderKeyDistributionMessage.getIteration(),
			senderKeyDistributionMessage.getChainKey(),
			senderKeyDistributionMessage.getSignatureKey()
		)
		await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
	}

	public async create(senderKeyName: SenderKeyName): Promise<SenderKeyDistributionMessage> {
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)

		if (senderKeyRecord.isEmpty()) {
			const keyId = keyhelper.generateSenderKeyId()
			const senderKey = keyhelper.generateSenderKey()
			const signingKey = keyhelper.generateSenderSigningKey()

			senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey)
			await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
		}

		const state = senderKeyRecord.getSenderKeyState()
		if (!state) {
			throw new Error('No session state available')
		}

		return new SenderKeyDistributionMessage(
			state.getKeyId(),
			state.getSenderChainKey().getIteration(),
			state.getSenderChainKey().getSeed(),
			state.getSigningKeyPublic()
		)
	}
}
