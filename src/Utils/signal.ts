import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { SignalRepositoryWithLIDStore } from '../Types'
import type {
	AuthenticationCreds,
	AuthenticationState,
	KeyPair,
	SignalIdentity,
	SignalKeyStore,
	SignedKeyPair
} from '../Types/Auth'
import {
	assertNodeErrorFree,
	type BinaryNode,
	type FullJid,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildUInt,
	getServerFromDomainType,
	jidDecode,
	S_WHATSAPP_NET,
	WAJIDDomains
} from '../WABinary'
import type { DeviceListData, ParsedDeviceInfo, USyncQueryResultList } from '../WAUSync'
import { Curve, generateSignalPubKey, keyMaterialToBuffer } from './crypto'
import { encodeBigEndian } from './generics'
import type { ILogger } from './logger'

// AunuBaileys (1.0.74, HB-98): key material is only ever a Buffer
// (or a base64 string in a hand-edited creds file). Anything else is
// a wrong-typed corrupt value, not key material.
const isKeyMaterial = (value: unknown): value is Uint8Array | string =>
	value instanceof Uint8Array || typeof value === 'string'

function chunk<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size))
	}

	return chunks
}

export const createSignalIdentity = (wid: string, accountSignatureKey: Uint8Array): SignalIdentity => {
	return {
		identifier: { name: wid, deviceId: 0 },
		identifierKey: generateSignalPubKey(accountSignatureKey)
	}
}

export const getPreKeys = async ({ get }: SignalKeyStore, min: number, limit: number) => {
	const idList: string[] = []
	for (let id = min; id < limit; id++) {
		idList.push(id.toString())
	}

	return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds: AuthenticationCreds, range: number) => {
	// AunuBaileys (1.0.72, HB-84, re-applied P3b): partial creds without
	// the pre-key counters used to produce NaN updates that were then
	// STORED, breaking pre-key upload permanently and silently. Fail
	// descriptively, like loadSignedPreKey (HB-26).
	if (!Number.isFinite(creds.nextPreKeyId) || !Number.isFinite(creds.firstUnuploadedPreKeyId)) {
		throw new Error(
			'AunuBaileys: creds.nextPreKeyId / creds.firstUnuploadedPreKeyId are missing — the auth state is incomplete or corrupt; restore a full backup or pair again'
		)
	}

	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	// AunuBaileys (1.0.80, HB-140 + HB-225, re-applied P3b with HB-84):
	// finite-but-INVERTED counters made `remaining` exceed `range` by
	// the size of the gap, so the loop below generated keys for the
	// GAP, not the request — a ~2^31 gap would freeze the process
	// synchronously, inside the keys transaction, at every login.
	if (avaliable < 0) {
		throw new Error(
			'AunuBaileys: creds pre-key counters are inverted (firstUnuploadedPreKeyId > nextPreKeyId) — the auth state is corrupt; restore a full backup or pair again'
		)
	}
	const remaining = range - avaliable
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	const newPreKeys: { [id: number]: KeyPair } = {}
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
			newPreKeys[i] = Curve.generateKeyPair()
		}
	}

	return {
		newPreKeys,
		lastPreKeyId,
		preKeysRange: [creds.firstUnuploadedPreKeyId, range] as const
	}
}

export const xmppSignedPreKey = (key: SignedKeyPair): BinaryNode => ({
	tag: 'skey',
	attrs: {},
	// AunuBaileys (1.0.78, HB-157, re-applied P3b): key material may
	// be a base64 string in a hand-edited creds file — the node writer
	// would otherwise publish the base64 TEXT as the key bytes.
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: keyMaterialToBuffer(key.keyPair.public) as Buffer },
		{ tag: 'signature', attrs: {}, content: keyMaterialToBuffer(key.signature) as Buffer }
	]
})

export const xmppPreKey = (pair: KeyPair, id: number): BinaryNode => ({
	tag: 'key',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
		{ tag: 'value', attrs: {}, content: keyMaterialToBuffer(pair.public) as Buffer }
	]
})

const isValidUInt = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n)

export const extractE2ESessionFromRetryReceipt = (receipt: BinaryNode) => {
	const keysNode = getBinaryNodeChild(receipt, 'keys')
	if (!keysNode) return null

	const typeBuf = getBinaryNodeChildBuffer(keysNode, 'type')
	if (!typeBuf || typeBuf.length !== 1 || typeBuf[0] !== KEY_BUNDLE_TYPE[0]) return null

	const identity = getBinaryNodeChildBuffer(keysNode, 'identity')
	const skey = getBinaryNodeChild(keysNode, 'skey')
	if (!identity || identity.length !== 32 || !skey) return null

	const registrationId = getBinaryNodeChildUInt(receipt, 'registration', 4)
	if (!isValidUInt(registrationId)) return null

	const signedPubKey = getBinaryNodeChildBuffer(skey, 'value')
	const signedSig = getBinaryNodeChildBuffer(skey, 'signature')
	const signedKeyId = getBinaryNodeChildUInt(skey, 'id', 3)
	if (!signedPubKey || signedPubKey.length !== 32 || !signedSig || !isValidUInt(signedKeyId)) {
		return null
	}

	const preKeyNode = getBinaryNodeChild(keysNode, 'key')
	let preKey: { keyId: number; publicKey: Uint8Array } | undefined
	if (preKeyNode) {
		const preKeyPub = getBinaryNodeChildBuffer(preKeyNode, 'value')
		const preKeyId = getBinaryNodeChildUInt(preKeyNode, 'id', 3)
		if (!preKeyPub || preKeyPub.length !== 32 || !isValidUInt(preKeyId)) {
			return null
		}

		preKey = { keyId: preKeyId, publicKey: generateSignalPubKey(preKeyPub) }
	}

	return {
		registrationId,
		identityKey: generateSignalPubKey(identity),
		signedPreKey: {
			keyId: signedKeyId,
			publicKey: generateSignalPubKey(signedPubKey),
			signature: signedSig
		},
		preKey
	}
}

export const parseAndInjectE2ESessions = async (
	node: BinaryNode,
	repository: SignalRepositoryWithLIDStore,
	logger?: ILogger
) => {
	// AunuBaileys (1.0.72, HB-67, re-applied P3b): a <key>/<skey>
	// without a <value> child used to throw inside
	// generateSignalPubKey — the per-entry catch then skipped the
	// WHOLE device entry, although the signed pre-key alone is enough
	// to build a session. Skip just that key. A non-finite keyId
	// (missing/short <id>) makes the key equally unusable — skip it
	// the same way (the finite check is shared with HB-263's site;
	// extractE2ESessionFromRetryReceipt above already validates the
	// same way via isValidUInt).
	const extractKey = (key: BinaryNode | undefined) => {
		if (!key) {
			return undefined
		}

		const value = getBinaryNodeChildBuffer(key, 'value')
		if (!value) {
			return undefined
		}

		const keyId = getBinaryNodeChildUInt(key, 'id', 3)
		if (!isValidUInt(keyId)) {
			return undefined
		}

		return {
			keyId,
			publicKey: generateSignalPubKey(value),
			signature: getBinaryNodeChildBuffer(key, 'signature')!
		}
	}
	const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user')

	// Most of the work in repository.injectE2ESession is CPU intensive, not IO
	// So Promise.all doesn't really help here,
	// but blocks even loop if we're using it inside keys.transaction, and it makes it "sync" actually
	// This way we chunk it in smaller parts and between those parts we can yield to the event loop
	// It's rare case when you need to E2E sessions for so many users, but it's possible
	const chunkSize = 100
	const chunks = chunk(nodes, chunkSize)

	for (const nodesChunk of chunks) {
		// AunuBaileys (1.0.68, HB-1, re-applied P3b): the old loop threw
		// on the FIRST bad <user> node (error child / missing identity
		// / missing jid), aborting session injection for every other
		// user in the response. Bad entries are skipped per node; the
		// rest of the chunk still injects.
		await Promise.all(
			nodesChunk.map(async node => {
				try {
					assertNodeErrorFree(node)
					const signedKey = getBinaryNodeChild(node, 'skey')
					const key = getBinaryNodeChild(node, 'key')
					const identity = getBinaryNodeChildBuffer(node, 'identity')
					const jid = node.attrs.jid
					if (!jid || !identity) {
						throw new Error('key-bundle entry is missing jid or identity')
					}

					const registrationId = getBinaryNodeChildUInt(node, 'registration', 4)

					await repository.injectE2ESession({
						jid,
						session: {
							registrationId: registrationId!,
							identityKey: generateSignalPubKey(identity),
							signedPreKey: extractKey(signedKey)!,
							preKey: extractKey(key)
						}
					})
				} catch (err) {
					logger?.warn(
						{ jid: node.attrs?.jid, err: (err as Error)?.message },
						'aunu: skipping bad key-bundle entry; other sessions continue'
					)
				}
			})
		)
	}
}

export const extractDeviceJids = (
	result: USyncQueryResultList[],
	myJid: string,
	myLid: string,
	excludeZeroDevices: boolean
) => {
	const { user: myUser, device: myDevice } = jidDecode(myJid)!

	const extracted: FullJid[] = []

	for (const userResult of result) {
		const { devices, id } = userResult as { devices: ParsedDeviceInfo; id: string }
		const decoded = jidDecode(id)!,
			{ user, server } = decoded
		let { domainType } = decoded
		const deviceList = devices?.deviceList as DeviceListData[]
		if (!Array.isArray(deviceList)) continue
		for (const { id: device, keyIndex, isHosted } of deviceList) {
			if (
				// AunuBaileys (HB-272, P4): defence in depth behind the
				// USync parser guard — a NaN device id (missing <device>
				// id attribute) satisfied the keyIndex clause below and
				// collapsed to the bare JID in jidEncode.
				Number.isFinite(device) &&
				(!excludeZeroDevices || device !== 0) && // if zero devices are not-excluded, or device is non zero
				((myUser !== user && myLid !== user) || myDevice !== device) && // either different user or if me user, not this device
				(device === 0 || !!keyIndex) // ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
			) {
				if (isHosted) {
					domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED
				}

				extracted.push({
					user,
					device,
					domainType,
					server: getServerFromDomainType(server, domainType)
				})
			}
		}
	}

	return extracted
}

/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
export const getNextPreKeys = async ({ creds, keys }: AuthenticationState, count: number) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)

	const update: Partial<AuthenticationCreds> = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}

	await keys.set({ 'pre-key': newPreKeys })

	const storedPreKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])

	// AunuBaileys (1.0.72, HB-83 + 1.0.74 HB-98, re-applied P3b): a
	// stored pre-key entry with a wrong shape ({} — valid JSON, no key
	// material) used to be uploaded as an EMPTY <value>; truthiness
	// alone also let a wrong-TYPED public (e.g. a number) through to
	// the node encoder, which threw "invalid children". Skip entries
	// without real key material here too.
	const preKeys: { [keyId: string]: KeyPair } = {}
	for (const [preKeyId, pair] of Object.entries(storedPreKeys)) {
		if (pair && isKeyMaterial(pair.public)) {
			preKeys[preKeyId] = pair
		}
	}

	return { update, preKeys }
}

export const getNextPreKeysNode = async (state: AuthenticationState, count: number) => {
	const { creds } = state
	// AunuBaileys (1.0.72, HB-68, re-applied P3b): the identity fields
	// are dereferenced bare below — partial creds turned that into a
	// bare TypeError and a reconnect loop at every boot. Fail
	// descriptively, like loadSignedPreKey (HB-26).
	if (
		!isKeyMaterial(creds.signedIdentityKey?.public) ||
		!isKeyMaterial(creds.signedPreKey?.keyPair?.public) ||
		!isKeyMaterial(creds.signedPreKey?.signature) ||
		typeof creds.signedPreKey?.keyId === 'undefined'
	) {
		throw new Error(
			'AunuBaileys: creds.signedIdentityKey / creds.signedPreKey are missing or incomplete — the auth state is incomplete or corrupt; restore a full backup or pair again'
		)
	}

	// AunuBaileys (1.0.79, addendum HB-80, re-applied P3b): a missing
	// registrationId silently became registration 00000000 in the
	// node below (encodeBigEndian does not throw on undefined).
	if (!Number.isFinite(creds.registrationId)) {
		throw new Error(
			'AunuBaileys: creds.registrationId is missing or invalid — the auth state is incomplete or corrupt; restore a full backup or pair again'
		)
	}

	const { update, preKeys } = await getNextPreKeys(state, count)

	const node: BinaryNode = {
		tag: 'iq',
		attrs: {
			xmlns: 'encrypt',
			type: 'set',
			to: S_WHATSAPP_NET
		},
		content: [
			{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
			// AunuBaileys (HB-157, re-applied P3b): publish the key
			// BYTES, not the base64 text of a string-stored key.
			{ tag: 'identity', attrs: {}, content: keyMaterialToBuffer(creds.signedIdentityKey.public) as Buffer },
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k]!, +k)) },
			xmppSignedPreKey(creds.signedPreKey)
		]
	}

	return { update, node }
}
