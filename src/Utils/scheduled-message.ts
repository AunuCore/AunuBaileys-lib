import { Boom } from '@hapi/boom'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { waproto } from '../../WAProto/index.js'
import type { BinaryNode } from '../WABinary'
import type { WAMessageKey } from '../Types'

/**
 * AunuBaileys (2.8.0, D-1102): scheduled messages — builder-only.
 *
 * Clean-room implementation from the mechanism recorded in the
 * heartbeat ledger (run-1166): the inner message is sealed with
 * AES-256-GCM under a random 32-byte reveal key and carried as a
 * `conditionalRevealMessage` (type SCHEDULED_MESSAGE); the reveal
 * key travels out-of-band in a `<meta type="scheduled_message">`
 * node so the server can hand it back at the scheduled time, and
 * cancelling is a protocolMessage of type MESSAGE_UNSCHEDULE.
 * The GCM auth tag (16 bytes) is appended to the ciphertext in
 * `encPayload` — the proto has no separate tag field. Retention is
 * capped at 30 days and a chat may hold at most 30 scheduled
 * messages; the recorded NACK code for a rejected reveal is 419.
 * No socket send is wired here: the recorded donor surface was
 * builder-only too, and the reveal-side notification ops
 * (NotificationScheduledMessagePost / Reveal) are unmodelled.
 */

export const SCHEDULED_MSG_MAX_PER_CHAT = 30
export const SCHEDULED_MSG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const SCHEDULED_MESSAGE_NACK_CODE = 419

const REVEAL_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

export type ScheduledMessageSeal = {
	/** conditionalRevealMessage proto payload, ready to place on a Message */
	conditionalRevealMessage: waproto.Message.IConditionalRevealMessage
	/** the 32-byte reveal key — hand it to buildScheduledMsgMetaNode, never log it */
	revealKey: Buffer
	revealKeyId: string
}

function assertRevealKey(key: unknown): asserts key is Buffer {
	if (!Buffer.isBuffer(key) || key.length !== REVEAL_KEY_BYTES) {
		throw new Boom(`scheduled message reveal key must be a ${REVEAL_KEY_BYTES}-byte Buffer`, { statusCode: 400 })
	}
}

export const assertScheduledRevealTime = (revealAtMs: number, nowMs = Date.now()) => {
	if (typeof revealAtMs !== 'number' || !Number.isFinite(revealAtMs)) {
		throw new Boom('scheduled message reveal time must be a finite timestamp in milliseconds', { statusCode: 400 })
	}

	if (revealAtMs <= nowMs) {
		throw new Boom('scheduled message reveal time must be in the future', { statusCode: 400 })
	}

	if (revealAtMs - nowMs > SCHEDULED_MSG_RETENTION_MS) {
		throw new Boom('scheduled message reveal time exceeds the 30-day retention window', { statusCode: 400 })
	}
}

/** Seal an inner message (or raw plaintext bytes) for a scheduled reveal. */
export const encodeScheduledMessage = (
	inner: waproto.IMessage | Buffer | Uint8Array,
	revealKey: Buffer = randomBytes(REVEAL_KEY_BYTES)
): ScheduledMessageSeal => {
	assertRevealKey(revealKey)
	const plaintext = Buffer.isBuffer(inner) || inner instanceof Uint8Array ? Buffer.from(inner) : Buffer.from(waproto.Message.encode(waproto.Message.create(inner)).finish())
	const iv = randomBytes(GCM_IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', revealKey, iv, { authTagLength: GCM_TAG_BYTES })
	const encPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
	// Local identifier for the key slot: the first 16 bytes of the
	// key, hex — unique per key without exposing the whole key in
	// message bodies that get logged.
	const revealKeyId = revealKey.subarray(0, 16).toString('hex')
	return {
		conditionalRevealMessage: {
			encPayload,
			encIv: iv,
			conditionalRevealMessageType: waproto.Message.ConditionalRevealMessage.ConditionalRevealMessageType.SCHEDULED_MESSAGE,
			revealKeyId
		},
		revealKey: Buffer.from(revealKey),
		revealKeyId
	}
}

/** Open a sealed scheduled message. Returns the raw plaintext bytes. */
export const decodeScheduledMessage = (
	sealed: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null },
	revealKey: Buffer
): Buffer => {
	assertRevealKey(revealKey)
	const { encPayload, encIv } = sealed || {}
	if (!encPayload || !encIv || encIv.length !== GCM_IV_BYTES || encPayload.length <= GCM_TAG_BYTES) {
		throw new Boom('scheduled message payload is missing or malformed', { statusCode: 400 })
	}

	const payload = Buffer.from(encPayload)
	const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES)
	const authTag = payload.subarray(payload.length - GCM_TAG_BYTES)
	const decipher = createDecipheriv('aes-256-gcm', revealKey, Buffer.from(encIv), { authTagLength: GCM_TAG_BYTES })
	decipher.setAuthTag(authTag)
	try {
		return Buffer.concat([decipher.update(ciphertext), decipher.final()])
	} catch {
		throw new Boom('scheduled message failed its integrity check (wrong reveal key or corrupted payload)', {
			statusCode: 400
		})
	}
}

/** Decode a sealed scheduled message back into the inner Message proto. */
export const decodeScheduledMessageContent = (
	sealed: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null },
	revealKey: Buffer
): waproto.Message => {
	return waproto.Message.decode(decodeScheduledMessage(sealed, revealKey))
}

/** The `<meta type="scheduled_message" st="<unix-s>">` node carrying the reveal key. */
export const buildScheduledMsgMetaNode = (revealAtMs: number, seal: ScheduledMessageSeal): BinaryNode => {
	assertScheduledRevealTime(revealAtMs)
	return {
		tag: 'meta',
		attrs: {
			type: 'scheduled_message',
			st: Math.floor(revealAtMs / 1000).toString()
		},
		content: [
			{
				tag: 'key',
				attrs: { rkid: seal.revealKeyId },
				content: Buffer.from(seal.revealKey.toString('base64'), 'utf-8')
			}
		]
	}
}

/** Build the full scheduled-message Message proto + its meta node. */
export const buildScheduledMessage = (
	inner: waproto.IMessage,
	revealAtMs: number,
	revealKey: Buffer = randomBytes(REVEAL_KEY_BYTES)
) => {
	assertScheduledRevealTime(revealAtMs)
	const seal = encodeScheduledMessage(inner, revealKey)
	return {
		message: waproto.Message.create({ conditionalRevealMessage: seal.conditionalRevealMessage }),
		metaNode: buildScheduledMsgMetaNode(revealAtMs, seal),
		revealKey: seal.revealKey,
		revealKeyId: seal.revealKeyId
	}
}

/** Protocol message that cancels a previously scheduled message. */
export const buildUnscheduleProtocolMessage = (key: WAMessageKey): waproto.IMessage => {
	if (!key || typeof key !== 'object' || typeof key.id !== 'string' || !key.id) {
		throw new Boom('unschedule requires the scheduled message key (with an id)', { statusCode: 400 })
	}

	return {
		protocolMessage: {
			key,
			type: waproto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE
		}
	}
}
