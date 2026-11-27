import { waproto } from '../../WAProto/index.js';
import type { BinaryNode } from '../WABinary/index.js';
import type { WAMessageKey } from '../Types/index.js';
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
export declare const SCHEDULED_MSG_MAX_PER_CHAT = 30;
export declare const SCHEDULED_MSG_RETENTION_MS: number;
export declare const SCHEDULED_MESSAGE_NACK_CODE = 419;
export type ScheduledMessageSeal = {
    /** conditionalRevealMessage proto payload, ready to place on a Message */
    conditionalRevealMessage: waproto.Message.IConditionalRevealMessage;
    /** the 32-byte reveal key — hand it to buildScheduledMsgMetaNode, never log it */
    revealKey: Buffer;
    revealKeyId: string;
};
export declare const assertScheduledRevealTime: (revealAtMs: number, nowMs?: number) => void;
/** Seal an inner message (or raw plaintext bytes) for a scheduled reveal. */
export declare const encodeScheduledMessage: (inner: waproto.IMessage | Buffer | Uint8Array, revealKey?: Buffer) => ScheduledMessageSeal;
/** Open a sealed scheduled message. Returns the raw plaintext bytes. */
export declare const decodeScheduledMessage: (sealed: {
    encPayload?: Uint8Array | null;
    encIv?: Uint8Array | null;
}, revealKey: Buffer) => Buffer;
/** Decode a sealed scheduled message back into the inner Message proto. */
export declare const decodeScheduledMessageContent: (sealed: {
    encPayload?: Uint8Array | null;
    encIv?: Uint8Array | null;
}, revealKey: Buffer) => waproto.Message;
/** The `<meta type="scheduled_message" st="<unix-s>">` node carrying the reveal key. */
export declare const buildScheduledMsgMetaNode: (revealAtMs: number, seal: ScheduledMessageSeal) => BinaryNode;
/** Build the full scheduled-message Message proto + its meta node. */
export declare const buildScheduledMessage: (inner: waproto.IMessage, revealAtMs: number, revealKey?: Buffer) => {
    message: waproto.Message;
    metaNode: BinaryNode;
    revealKey: Buffer<ArrayBufferLike>;
    revealKeyId: string;
};
/** Protocol message that cancels a previously scheduled message. */
export declare const buildUnscheduleProtocolMessage: (key: WAMessageKey) => waproto.IMessage;
//# sourceMappingURL=scheduled-message.d.ts.map