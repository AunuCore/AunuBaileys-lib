import type { WAMessage } from '../Types/index.js';
import type { SignalRepositoryWithLIDStore } from '../Types/Signal.js';
import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
export declare const getDecryptionJid: (sender: string, repository: SignalRepositoryWithLIDStore) => Promise<string>;
export declare const NO_MESSAGE_FOUND_ERROR_TEXT = "Message absent from node";
export declare const MISSING_KEYS_ERROR_TEXT = "Key used already or never filled";
export declare const setBotMessageSecret: (id: string, secret: string | Uint8Array, chatJid?: string) => void;
export declare const getBotMessageSecret: (id: string) => Buffer<ArrayBufferLike> | undefined;
export declare const getBotRecentSecretsChatCount: () => number;
export declare const ACCOUNT_RESTRICTED_TEXT = "Your account has been restricted";
export declare const DECRYPTION_RETRY_CONFIG: {
    maxRetries: number;
    baseDelayMs: number;
    sessionRecordErrors: string[];
};
/** NACK reason codes we send to the server (client → server) */
export declare const NACK_REASONS: {
    SenderReachoutTimelocked: number;
    ParsingError: number;
    UnrecognizedStanza: number;
    UnrecognizedStanzaClass: number;
    UnrecognizedStanzaType: number;
    InvalidProtobuf: number;
    InvalidHostedCompanionStanza: number;
    MissingMessageSecret: number;
    SignalErrorOldCounter: number;
    MessageDeletedOnPeer: number;
    UnhandledError: number;
    UnsupportedAdminRevoke: number;
    UnsupportedLIDGroup: number;
    DBOperationFailed: number;
};
/**
 * Server-side error codes returned in ack stanzas (server → client) that we
 * currently have dedicated handlers for. Extend as more handlers are added.
 * Distinct from the client-side NackReason enum (WAWebCreateNackFromStanza).
 */
export declare const SERVER_ERROR_CODES: {
    /**
     * 1:1 message missing privacy token (tctoken). Usually means the account is
     * restricted: WhatsApp blocks starting new chats but preserves existing ones,
     * since established chats already carry a tctoken.
     */
    readonly MessageAccountRestriction: "463";
    /** Stanza validation failure (SMAX_INVALID) — likely stale device session */
    readonly SmaxInvalid: "479";
};
export declare const extractAddressingContext: (stanza: BinaryNode) => {
    addressingMode: string;
    senderAlt: string | undefined;
    recipientAlt: string | undefined;
};
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export declare function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string): {
    fullMessage: WAMessage;
    author: string;
    sender: string;
};
export declare const decryptMessageNode: (stanza: BinaryNode, meId: string, meLid: string, repository: SignalRepositoryWithLIDStore, logger: ILogger) => {
    fullMessage: WAMessage;
    category: string | undefined;
    author: string;
    decrypt(): Promise<void>;
};
/**
 * AunuBaileys: true when a decrypt failure text is libsignal's session-layer
 * aggregate — the stored session record(s) could not decrypt the message at
 * all ("No matching sessions found for message", "No session record",
 * "No sessions available"). This class includes the unfillable counter gap
 * ("Over 2000 messages into the future!") thrown when the stored session
 * state has regressed behind the sender's ratchet, e.g. after a backup
 * restore; such a session can never decrypt again and must be reset.
 */
export declare const isUnrecoverableSessionError: (text: string | undefined) => boolean;
/**
 * AunuBaileys: true when a decrypt failure text is a MAC verification
 * failure ("Bad MAC") — the stored session/sender-key state and the
 * sender's state disagree about the message authentication code, the
 * classic symptom of a desynchronised ratchet on either side.
 */
export declare const isBadMacError: (text: string | undefined) => boolean;
/**
 * AunuBaileys (1.0.78, HB-223): true when a GROUP decrypt failure says
 * nothing about the author's 1-1 E2E session — the sender key simply
 * is not here yet (no record, or no state for that author: they just
 * joined, or our own self-heal deleted it), or the skmsg payload
 * itself is malformed (proto decode error, signature shape). Counting
 * these toward the 3-strike session reset deleted healthy E2E
 * sessions and reported a misleading `healed: true`; the only correct
 * response is the retry receipt, which makes the peer redistribute
 * its sender key. The CIPHERTEXT stub upsert still happens.
 */
export declare const isSenderKeyUnavailableError: (text: string | undefined) => boolean;
//# sourceMappingURL=decode-wa-message.d.ts.map