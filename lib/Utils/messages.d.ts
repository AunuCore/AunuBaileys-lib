import { type Transform } from 'stream';
import { waproto } from '../../WAProto/index.js';
import type { AnyMediaMessageContent, AnyMessageContent, MessageContentGenerationOptions, MessageGenerationOptions, MessageGenerationOptionsFromContent, MessageUserReceipt, PollVoteOptions, StickerPackInfo, WAMessage, WAMessageContent, WAMessageKey } from '../Types/index.js';
export type { PollVoteOptions };
import type { ILogger } from './logger.js';
import { type MediaDownloadOptions } from './messages-media.js';
type ExtractByKey<T, K extends PropertyKey> = T extends Record<K, any> ? T : never;
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export declare const extractUrlFromText: (text: string) => string | undefined;
export declare const generateLinkPreviewIfRequired: (text: string, getUrlInfo: MessageGenerationOptions["getUrlInfo"], logger: MessageGenerationOptions["logger"]) => Promise<import("../Types/index.js").WAUrlInfo | undefined>;
export declare const prepareWAMessageMedia: (message: AnyMediaMessageContent, options: MessageContentGenerationOptions) => Promise<waproto.Message>;
export declare const prepareDisappearingMessageSettingContent: (ephemeralExpiration?: number) => waproto.Message;
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export declare const generateForwardMessageContent: (message: WAMessage, forceForward?: boolean) => waproto.IMessage;
export declare const hasNonNullishProperty: <K extends PropertyKey>(message: AnyMessageContent, key: K) => message is ExtractByKey<AnyMessageContent, K>;
/**
 * Write the "sound-sha256" EXIF into a WebP sticker (2.7.0, D-1081-A).
 * Replaces any existing EXIF chunk, sets the VP8X EXIF flag (a VP8X
 * header is synthesised for plain VP8/VP8L files), and rebuilds the
 * RIFF size. Throws Boom 400 for a non-WebP input or a WebP whose
 * canvas size cannot be determined when a VP8X header is needed.
 */
export declare const addSoundSha256ToStickerWebP: (webp: Buffer, soundSha256Hex: string) => Buffer;
export declare const prepareStickerPackMessage: (stickerPack: StickerPackInfo, options: MessageContentGenerationOptions) => Promise<{
    stickerPackMessage: waproto.Message.IStickerPackMessage;
}>;
/**
 * Encrypt a poll vote (AES-GCM over the sha256 of each selected option).
 * Key derivation mirrors decryptPollVote (src/Utils/process-message.ts)
 * exactly — same sign / key0 / decKey / AAD construction — so a vote
 * encrypted here decrypts there, and a vote we receive decrypts with
 * the same context.
 */
export declare const encryptPollVote: ({ pollMsgId, pollCreatorJid, pollEncKey, voterJid, selectedOptions }: {
    pollMsgId: string;
    pollCreatorJid: string;
    pollEncKey: Uint8Array;
    voterJid: string;
    selectedOptions: string[];
}) => waproto.Message.IPollEncValue;
/**
 * AunuBaileys (2.5.0, Kage LID addressing delta, run-0932): resolve
 * our own participant in the addressing namespace of the destination
 * chat. WhatsApp may identify the local account by PN or LID depending
 * on the destination — a group/status chat addressed by LID must carry
 * our LID as participant, not our PN. Re-implementation (tree style) of
 * kage-baileys' lib/Utils/lid-addressing.js (credited there to
 * @this-xys/baileys 2.0.0); the two TODO sites in
 * generateWAMessageFromContent (:1486, :1548) are wired to these
 * helpers by the coordinator — see GROUP-C-REPORT.md for the exact
 * patch — because that function belongs to Group B this batch.
 */
export declare const getMeParticipant: (targetJid: string, userJid: string, userJidLid?: string) => string;
export declare const getQuotedParticipant: (quoted: WAMessage | undefined | null, jid: string, userJid: string, userJidLid?: string) => string | undefined;
export declare const generateWAMessageContent: (message: AnyMessageContent, options: MessageContentGenerationOptions) => Promise<waproto.Message>;
export declare const generateWAMessageFromContent: (jid: string, message: WAMessageContent, options: MessageGenerationOptionsFromContent) => WAMessage;
export declare const generateWAMessage: (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => Promise<WAMessage>;
/** Get the key to access the true type of content */
export declare const getContentType: (content: waproto.IMessage | undefined) => keyof waproto.IMessage | undefined;
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export declare const normalizeMessageContent: (content: WAMessageContent | null | undefined) => WAMessageContent | undefined;
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export declare const extractMessageContent: (content: WAMessageContent | undefined | null) => WAMessageContent | undefined;
/**
 * Returns the device predicted by message ID
 */
export declare const getDevice: (id: string) => "web" | "unknown" | "android" | "ios" | "desktop";
/** Upserts a receipt in the message */
export declare const updateMessageWithReceipt: (msg: Pick<WAMessage, "userReceipt">, receipt: MessageUserReceipt) => void;
/** Update the message with a new reaction */
export declare const updateMessageWithReaction: (msg: Pick<WAMessage, "reactions">, reaction: waproto.IReaction) => void;
export interface PollLIDOptions {
    lidStore?: {
        getPNForLID(jid: string): string | undefined;
    };
}
/** Update the message with a new poll update */
export declare const updateMessageWithPollUpdate: (msg: Pick<WAMessage, "pollUpdates">, update: waproto.IPollUpdate, options?: PollLIDOptions) => void;
/** Update the message with a new event response */
export declare const updateMessageWithEventResponse: (msg: Pick<WAMessage, "eventResponses">, update: waproto.IEventResponse) => void;
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export declare function getAggregateVotesInPollMessage({ message, pollUpdates }: Pick<WAMessage, 'pollUpdates' | 'message'>, meId?: string, options?: PollLIDOptions): unknown[];
type ResponseAggregation = {
    response: string;
    responders: string[];
};
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export declare function getAggregateResponsesInEventMessage({ eventResponses }: Pick<WAMessage, 'eventResponses'>, meId?: string): ResponseAggregation[];
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export declare const aggregateMessageKeysNotFromMe: (keys: WAMessageKey[]) => {
    jid: string;
    participant: string | undefined;
    messageIds: string[];
}[];
type DownloadMediaMessageContext = {
    reuploadRequest: (msg: WAMessage) => Promise<WAMessage>;
    logger: ILogger;
};
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export declare const downloadMediaMessage: <Type extends "buffer" | "stream">(message: WAMessage, type: Type, options: MediaDownloadOptions, ctx?: DownloadMediaMessageContext) => Promise<Type extends "buffer" ? Buffer<ArrayBufferLike> : Transform>;
/** Checks whether the given message is a media message; if it is returns the inner content */
export declare const assertMediaContent: (content: waproto.IMessage | null | undefined) => waproto.Message.IDocumentMessage | waproto.Message.IImageMessage | waproto.Message.IVideoMessage | waproto.Message.IAudioMessage | waproto.Message.IStickerMessage;
export declare const shouldIncludeBizBinaryNode: (message: waproto.IMessage) => boolean;
//# sourceMappingURL=messages.d.ts.map