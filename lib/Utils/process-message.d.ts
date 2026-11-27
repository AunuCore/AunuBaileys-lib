import { waproto } from '../../WAProto/index.js';
import type { AuthenticationCreds, BaileysEventEmitter, CacheStore, Chat, HistorySyncSink, SignalKeyStoreWithTransaction, SignalRepositoryWithLIDStore, SocketConfig, WAMessage, WAMessageKey } from '../Types/index.js';
import type { ILogger } from './logger.js';
type ProcessMessageContext = {
    shouldProcessHistoryMsg: boolean;
    /** AunuBaileys (2.7.0, Zapo D4): SocketConfig.history.sink, when set */
    historySyncSink?: HistorySyncSink;
    placeholderResendCache?: CacheStore;
    creds: AuthenticationCreds;
    keyStore: SignalKeyStoreWithTransaction;
    ev: BaileysEventEmitter;
    logger?: ILogger;
    options: RequestInit;
    signalRepository: SignalRepositoryWithLIDStore;
    getMessage: SocketConfig['getMessage'];
};
export declare function storeTcTokensFromHistorySync(chats: Chat[], signalRepository: SignalRepositoryWithLIDStore, keyStore: SignalKeyStoreWithTransaction, logger?: ILogger): Promise<void>;
/** Cleans a received message to further processing */
export declare const cleanMessage: (message: WAMessage, meId: string | undefined, meLid: string | undefined) => void;
export declare const isRealMessage: (message: WAMessage) => boolean;
export declare const shouldIncrementChatUnread: (message: WAMessage) => boolean;
/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
export declare const getChatId: ({ remoteJid, participant, fromMe }: WAMessageKey) => string;
type PollContext = {
    /** normalised jid of the person that created the poll */
    pollCreatorJid: string;
    /** ID of the poll creation message */
    pollMsgId: string;
    /** poll creation message enc key */
    pollEncKey: Uint8Array;
    /** jid of the person that voted */
    voterJid: string;
};
type EventContext = {
    /** normalised jid of the person that created the event */
    eventCreatorJid: string;
    /** ID of the event creation message */
    eventMsgId: string;
    /** event creation message enc key */
    eventEncKey: Uint8Array;
    /** jid of the person that responded */
    responderJid: string;
};
/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
export declare function decryptPollVote({ encPayload, encIv }: waproto.Message.IPollEncValue, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }: PollContext): waproto.Message.PollVoteMessage;
/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
export declare function decryptEventResponse({ encPayload, encIv }: waproto.Message.IPollEncValue, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }: EventContext): waproto.Message.EventResponseMessage;
declare const processMessage: (message: WAMessage, { shouldProcessHistoryMsg, historySyncSink, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }: ProcessMessageContext) => Promise<{
    historySyncDownloadFailed: boolean;
}>;
export default processMessage;
//# sourceMappingURL=process-message.d.ts.map