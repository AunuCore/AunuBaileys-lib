import type { waproto } from '../../WAProto/index.js'
import type { Contact } from './Contact'
import type { MinimalMessage } from './Message'

export type KeyPair = { public: Uint8Array; private: Uint8Array }
export type SignedKeyPair = {
	keyPair: KeyPair
	signature: Uint8Array
	keyId: number
	timestampS?: number
}

export type ProtocolAddress = {
	name: string // jid
	deviceId: number
}
export type SignalIdentity = {
	identifier: ProtocolAddress
	identifierKey: Uint8Array
}

export type LIDMapping = {
	pn: string
	lid: string
}

export type LTHashState = {
	version: number
	hash: Buffer
	indexValueMap: {
		[indexMacBase64: string]: { valueMac: Uint8Array | Buffer }
	}
}

export type SignalCreds = {
	readonly signedIdentityKey: KeyPair
	readonly signedPreKey: SignedKeyPair
	readonly registrationId: number
}

export type AccountSettings = {
	/** unarchive chats when a new message is received */
	unarchiveChats: boolean
	/** the default mode to start new conversations with */
	defaultDisappearingMode?: Pick<waproto.IConversation, 'ephemeralExpiration' | 'ephemeralSettingTimestamp'>
}

export type AuthenticationCreds = SignalCreds & {
	readonly noiseKey: KeyPair
	readonly pairingEphemeralKeyPair: KeyPair
	advSecretKey: string

	me?: Contact
	account?: waproto.IADVSignedDeviceIdentity
	signalIdentities?: SignalIdentity[]
	myAppStateKeyId?: string
	firstUnuploadedPreKeyId: number
	nextPreKeyId: number

	lastAccountSyncTimestamp?: number
	platform?: string

	processedHistoryMessages: MinimalMessage[]
	/** number of times history & app state has been synced */
	accountSyncCounter: number
	accountSettings: AccountSettings
	registered: boolean
	pairingCode: string | undefined
	lastPropHash: string | undefined
	routingInfo: Buffer | undefined
	additionalData?: any | undefined
}

export type SignalDataTypeMap = {
	'pre-key': KeyPair
	session: Uint8Array
	'sender-key': Uint8Array
	'sender-key-memory': { [jid: string]: boolean }
	'app-state-sync-key': waproto.Message.IAppStateSyncKeyData
	'app-state-sync-version': LTHashState
	'lid-mapping': string
	'device-list': string[]
	tctoken: { token: Buffer; timestamp?: string; senderTimestamp?: number }
	'identity-key': Uint8Array
}

export type SignalDataSet = { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }

type Awaitable<T> = T | Promise<T>

export type SignalKeyStore = {
	get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Awaitable<{ [id: string]: SignalDataTypeMap[T] }>
	set(data: SignalDataSet): Awaitable<void>
	/** clear all the data in the store */
	clear?(): Awaitable<void>
}

export type SignalKeyStoreWithTransaction = SignalKeyStore & {
	isInTransaction: () => boolean
	transaction<T>(exec: () => Promise<T>, key: string): Promise<T>
}

export type TransactionCapabilityOptions = {
	maxCommitRetries: number
	delayBetweenTriesMs: number
	/**
	 * AunuBaileys (2.9.0, HB-2026-1112-60 addendum 3): liveness
	 * watchdog for transaction work() — if a single work() has not
	 * settled after this many ms it is reported via
	 * onStuckTransaction (the transaction itself is NOT force-settled:
	 * its mutex stays held, so recovery is ending the socket and
	 * reconnecting with a fresh store). Defaults to 120_000.
	 */
	stuckTransactionTimeoutMs?: number
	/** Called once per transaction whose work() outlives stuckTransactionTimeoutMs. */
	onStuckTransaction?: (info: { key: string; durationMs: number }) => void
}

export type SignalAuthState = {
	creds: SignalCreds
	keys: SignalKeyStore | SignalKeyStoreWithTransaction
}

export type AuthenticationState = {
	creds: AuthenticationCreds
	keys: SignalKeyStore
}
