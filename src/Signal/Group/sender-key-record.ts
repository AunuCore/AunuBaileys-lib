import { BufferJSON } from '../../Utils/generics'
import { SenderKeyState } from './sender-key-state'

export interface SenderKeyStateStructure {
	senderKeyId: number
	senderChainKey: {
		iteration: number
		seed: Uint8Array
	}
	senderSigningKey: {
		public: Uint8Array
		private?: Uint8Array
	}
	senderMessageKeys: Array<{
		iteration: number
		seed: Uint8Array
	}>
}

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
const storedSeedToBuffer = (value: unknown): Buffer | null => {
	if (Buffer.isBuffer(value)) {
		return value
	}

	if (typeof value === 'string') {
		return Buffer.from(value, 'base64')
	}

	// AunuBaileys (2.0.5, HB-327 healing): sender-key records written
	// by 2.0.0–2.0.4 stored every seed as {type:'Buffer',data:[...]}
	// because storeSenderKey stringified without BufferJSON.replacer.
	// Accept exactly that legacy shape — a plain object whose data is
	// an array of byte values — so records already on users' disks
	// heal on load. The callers' length checks (32 / 32-or-33) still
	// apply to the converted buffer, and anything else stays null.
	if (
		value !== null &&
		typeof value === 'object' &&
		(value as { type?: unknown }).type === 'Buffer' &&
		Array.isArray((value as { data?: unknown }).data)
	) {
		const data = (value as { data: unknown[] }).data
		if (data.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
			return Buffer.from(data as number[])
		}
	}

	return null
}
const storedCountToNumber = (value: unknown): number | null => {
	if (typeof value === 'number') {
		return Number.isInteger(value) ? value : null
	}

	if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
		const n = Number(value)
		return Number.isFinite(n) ? n : null
	}

	return null
}

const sanitizeSenderKeyStructure = (structure: SenderKeyStateStructure): SenderKeyStateStructure | null => {
	const chainKey: any = (structure as any)?.senderChainKey
	const signingKey: any = (structure as any)?.senderSigningKey
	if (!chainKey || typeof chainKey !== 'object' || !signingKey || typeof signingKey !== 'object') {
		return null
	}

	const seed = storedSeedToBuffer(chainKey.seed)
	if (!seed || seed.length !== 32) {
		return null
	}

	const iteration = storedCountToNumber(chainKey.iteration)
	if (iteration === null || iteration < 0) {
		return null
	}

	const signingPublic = storedSeedToBuffer(signingKey.public)
	if (!signingPublic || (signingPublic.length !== 32 && signingPublic.length !== 33)) {
		return null
	}

	const cleanSigning: { public: Buffer; private?: Buffer } = { public: signingPublic }
	if (typeof signingKey.private !== 'undefined') {
		const signingPrivate = storedSeedToBuffer(signingKey.private)
		// AunuBaileys (2.0.5, HB-327 second facet): SenderKeyState
		// ALWAYS serialises a private field — an empty buffer for
		// peer states, which by design have no signing private key
		// (it only exists for our own sender key). Requiring exactly
		// 32 bytes dropped every peer state on load, so group DECRYPT
		// stayed broken even with the serialisation fixed. A
		// zero-length private means "absent"; any other non-32
		// length is corrupt and still drops the state.
		if (!signingPrivate || (signingPrivate.length !== 32 && signingPrivate.length !== 0)) {
			return null
		}

		if (signingPrivate.length === 32) {
			cleanSigning.private = signingPrivate
		}
	}

	const keyId = storedCountToNumber((structure as any)?.senderKeyId)
	// AunuBaileys (HB-271, P4): a negative senderKeyId slipped through
	// here — HB-202 rejected negative chain/message-key iterations but
	// never this field. A wire id is a uint32 (>= 0) and the record
	// lookup is a strict ===, so a stored negative id is unreachable
	// dead weight that also wastes one of the MAX_STATES slots.
	if (keyId === null || keyId < 0) {
		return null
	}

	const messageKeys: Array<{ iteration: number; seed: Buffer }> = []
	if (Array.isArray((structure as any)?.senderMessageKeys)) {
		for (const entry of (structure as any).senderMessageKeys) {
			if (!entry || typeof entry !== 'object') {
				continue
			}

			const mkIteration = storedCountToNumber(entry.iteration)
			const mkSeed = storedSeedToBuffer(entry.seed)
			if (mkIteration === null || mkIteration < 0 || !mkSeed || mkSeed.length !== 32) {
				continue
			}

			messageKeys.push({ iteration: mkIteration, seed: mkSeed })
		}
	}

	return {
		senderKeyId: keyId,
		senderChainKey: { iteration, seed },
		senderSigningKey: cleanSigning,
		senderMessageKeys: messageKeys
	} as SenderKeyStateStructure
}

export class SenderKeyRecord {
	private readonly MAX_STATES = 5
	private readonly senderKeyStates: SenderKeyState[] = []

	constructor(serialized?: SenderKeyStateStructure[]) {
		// Only an array deserialises into states \u2014 a wrong-shaped
		// stored value is an empty record, not a bare TypeError, so
		// the group self-heal can re-establish the sender key.
		if (serialized && Array.isArray(serialized)) {
			for (const structure of serialized) {
				const clean = sanitizeSenderKeyStructure(structure)
				if (clean) {
					this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, clean))
				}
			}

			// AunuBaileys (2.3.0, addendum HB-345): the MAX_STATES
			// cap was enforced only on the ADD path (one shift per
			// addSenderKeyState) — a stored record carrying more
			// than 5 valid states loaded ALL of them and stayed
			// over the cap (round-trip stable). States are ordered
			// oldest → newest (getSenderKeyState() reads the tail),
			// so keep the newest MAX_STATES, exactly what repeated
			// adds would have converged to.
			if (this.senderKeyStates.length > this.MAX_STATES) {
				this.senderKeyStates.splice(0, this.senderKeyStates.length - this.MAX_STATES)
			}
		}
	}

	public isEmpty(): boolean {
		return this.senderKeyStates.length === 0
	}

	public getSenderKeyState(keyId?: number): SenderKeyState | undefined {
		if (keyId === undefined && this.senderKeyStates.length) {
			return this.senderKeyStates[this.senderKeyStates.length - 1]
		}

		return this.senderKeyStates.find(state => state.getKeyId() === keyId)
	}

	public addSenderKeyState(id: number, iteration: number, chainKey: Uint8Array, signatureKey: Uint8Array): void {
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey))
		if (this.senderKeyStates.length > this.MAX_STATES) {
			this.senderKeyStates.shift()
		}
	}

	public setSenderKeyState(
		id: number,
		iteration: number,
		chainKey: Uint8Array,
		keyPair: { public: Uint8Array; private: Uint8Array }
	): void {
		this.senderKeyStates.length = 0
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair))
	}

	public serialize(): SenderKeyStateStructure[] {
		return this.senderKeyStates.map(state => state.getStructure())
	}
	static deserialize(data: Uint8Array): SenderKeyRecord {
		let parsed: SenderKeyStateStructure[]
		try {
			const str = Buffer.from(data).toString('utf-8')
			parsed = JSON.parse(str, BufferJSON.reviver)
		} catch {
			// AunuBaileys (1.0.72, HB-69, re-applied P3b): a
			// truncated/corrupt stored record used to throw
			// SyntaxError out of loadSenderKey, failing every group
			// send to that group permanently with no self-heal. An
			// empty record lets the normal sender-key flow
			// re-establish the key. (Wrong-SHAPED parsed values are
			// handled by the constructor's sanitiser, HB-124.)
			return new SenderKeyRecord()
		}

		return new SenderKeyRecord(parsed)
	}
}
