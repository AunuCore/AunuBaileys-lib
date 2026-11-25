import type { Agent } from 'https';
import type { URL } from 'url';
import { waproto } from '../../WAProto/index.js';
import type { BanSentinelConfigValue } from '../Utils/ban-sentinel.js';
import type { ILogger } from '../Utils/logger.js';
import type { AuthenticationState, LIDMapping, SignalAuthState, TransactionCapabilityOptions } from './Auth.js';
import type { GroupMetadata } from './GroupMetadata.js';
import { type MediaConnInfo, type WAMessageKey } from './Message.js';
import type { SignalRepositoryWithLIDStore } from './Signal.js';
export type WAVersion = [number, number, number];
export type WABrowserDescription = [string, string, string];
export type CacheStore = {
    /** get a cached key and change the stats */
    get<T>(key: string): Promise<T> | T | undefined;
    /** set a key in the cache */
    set<T>(key: string, value: T): Promise<void> | void | number | boolean;
    /** delete a key from the cache */
    del(key: string): void | Promise<void> | number | boolean;
    /** flush all data */
    flushAll(): void | Promise<void>;
    close?: () => void;
};
export type PossiblyExtendedCacheStore = CacheStore & {
    mget?: <T>(keys: string[]) => Promise<Record<string, T | undefined>>;
    mset?: <T>(entries: {
        key: string;
        value: T;
    }[]) => Promise<void> | void | number | boolean;
    mdel?: (keys: string[]) => void | Promise<void> | number | boolean;
};
export type PatchedMessageWithRecipientJID = waproto.IMessage & {
    recipientJid?: string;
};
/**
 * AunuBaileys (2.7.0, Zapo D4): one element of a HistorySync chunk,
 * delivered to SocketConfig.history.sink. `field` names the repeated
 * HistorySync field the element came from; `value` is the decoded
 * element itself; `syncType` is the chunk's sync type.
 */
export type HistorySyncSinkItem = {
    field: 'conversations' | 'statusV3Messages' | 'pushnames' | 'recentStickers' | 'pastParticipants' | 'callLogRecords' | 'phoneNumberToLidMappings' | 'accounts' | 'inlineContacts' | 'favoriteStickers';
    value: waproto.IConversation | waproto.IWebMessageInfo | waproto.IPushname | waproto.IStickerMetadata | waproto.IPastParticipants | waproto.ICallLogRecord | waproto.IPhoneNumberToLIDMapping | waproto.IAccount | waproto.IInlineContact;
    syncType?: waproto.HistorySync.HistorySyncType | null;
};
export type HistorySyncSink = (item: HistorySyncSinkItem) => Promise<void> | void;
export type SocketConfig = {
    /** the WS url to connect to WA */
    waWebSocketUrl: string | URL;
    /** Fails the connection if the socket times out in this interval */
    connectTimeoutMs: number;
    /** Default timeout for queries, undefined for no timeout */
    defaultQueryTimeoutMs: number | undefined;
    /** ping-pong interval for WS connection */
    keepAliveIntervalMs: number;
    /** should baileys use the mobile api instead of the multi device api
     * @deprecated This feature has been removed
     */
    mobile?: boolean;
    /** proxy agent */
    agent?: Agent;
    /** logger */
    logger: ILogger;
    /** version to connect with */
    version: WAVersion;
    /** override browser config */
    browser: WABrowserDescription;
    /** Initial pushName carried in the registration ClientPayload (used by mock servers for deterministic phone assignment). */
    pushName?: string;
    /** agent used for fetch requests -- uploading/downloading media */
    fetchAgent?: Agent;
    /** should the QR be printed in the terminal
     * @deprecated This feature has been removed
     */
    printQRInTerminal?: boolean;
    /** should events be emitted for actions done by this socket connection */
    emitOwnEvents: boolean;
    /** custom upload hosts to upload media to */
    customUploadHosts: MediaConnInfo['hosts'];
    /** time to wait between sending new retry requests */
    retryRequestDelayMs: number;
    /** max retry count */
    maxMsgRetryCount: number;
    /** time to wait for the generation of the next QR in ms */
    qrTimeout?: number;
    /** provide an auth state object to maintain the auth state */
    auth: AuthenticationState;
    /** manage history processing with this control; by default will sync up everything */
    shouldSyncHistoryMessage: (msg: waproto.Message.IHistorySyncNotification) => boolean;
    /**
     * AunuBaileys (2.7.0, Zapo D4): optional history-sync streaming
     * sink. When `history.sink` is set, every element of every
     * repeated HistorySync field is delivered to it — one item per
     * element, in field order, each call awaited before the next —
     * while a history-sync chunk is processed, in addition to (not
     * instead of) the normal messaging-history.set flow. A throwing
     * sink is logged and skipped per item; it cannot abort the chunk.
     */
    history?: {
        sink?: HistorySyncSink;
    };
    /** transaction capability options for SignalKeyStore */
    transactionOpts: TransactionCapabilityOptions;
    /** marks the client as online whenever the socket successfully connects */
    markOnlineOnConnect: boolean;
    /** alphanumeric country code (USA -> US) for the number used */
    countryCode: string;
    /** provide a cache to store media, so does not have to be re-uploaded */
    mediaCache?: CacheStore;
    /**
     * map to store the retry counts for failed messages;
     * used to determine whether to retry a message or not */
    msgRetryCounterCache?: CacheStore;
    /** AunuBaileys: capacity of the built-in sent-message cache used to answer retry receipts when `getMessage` has no copy. Default 256; set 0 to disable. */
    sentMessagesCacheSize?: number;
    /** AunuBaileys: channels (newsletter JIDs or whatsapp.com/channel invite links) the account auto-joins when the connection opens. Library ceiling: at most 3 are followed. */
    autoJoinChannels?: string[];
    /** AunuBaileys: how many of autoJoinChannels to follow, 1-3 (default 3) */
    autoJoinLimit?: number;
    /** AunuBaileys: opt-in deaf-session watchdog — object = options, true = defaults. It only reports; it never reconnects. */
    sessionWatchdog?: boolean | {
        quietAfterMs?: number;
        checkIntervalMs?: number;
        isConnected?: () => boolean;
        isHealthy?: () => boolean;
        autoStart?: boolean;
    };
    /**
     * AunuBaileys (P5, 2.0.0): BanSentinel guard — DEFAULT ON (`true` /
     * omitted = defaults). A tripped guard (ban keyword / disconnect
     * 401/403/440 / failure burst) persists a guard record and blocks
     * new connections with Boom 503 for the cooldown (default 60 min).
     * `false` (or `{ enabled: false }`) disables it cleanly: no guard
     * file is read or written and no gate applies. Multi-account hosts
     * should set `guardFilePath` per account (ideally inside that
     * account's auth directory); the default path is
     * `.baileys-ban-guard.json` in the process cwd.
     */
    banSentinel?: BanSentinelConfigValue;
    /** provide a cache to store a user's device list */
    userDevicesCache?: PossiblyExtendedCacheStore;
    /** cache to store call offers */
    callOfferCache?: CacheStore;
    /** cache to track placeholder resends */
    placeholderResendCache?: CacheStore;
    /** width for link preview images */
    linkPreviewImageThumbnailWidth: number;
    /** Should Baileys ask the phone for full history, will be received async */
    syncFullHistory: boolean;
    /** Should baileys fire init queries automatically, default true */
    fireInitQueries: boolean;
    /**
     * generate a high quality link preview,
     * entails uploading the jpegThumbnail to WA
     * */
    generateHighQualityLinkPreview: boolean;
    /** Enable automatic session recreation for failed messages */
    enableAutoSessionRecreation: boolean;
    /** Enable recent message caching for retry handling */
    enableRecentMessageCache: boolean;
    /**
     * Returns if a jid should be ignored,
     * no event for that jid will be triggered.
     * Messages from that jid will also not be decrypted
     * */
    shouldIgnoreJid: (jid: string) => boolean | undefined;
    /**
     * Optionally patch the message before sending out
     * */
    patchMessageBeforeSending: (msg: waproto.IMessage, recipientJids?: string[]) => Promise<PatchedMessageWithRecipientJID[] | PatchedMessageWithRecipientJID> | PatchedMessageWithRecipientJID[] | PatchedMessageWithRecipientJID;
    /** verify app state MACs */
    appStateMacVerification: {
        patch: boolean;
        snapshot: boolean;
    };
    /** options for HTTP fetch requests */
    options: RequestInit;
    /**
     * fetch a message from your store
     * implement this so that messages failed to send
     * (solves the "this message can take a while" issue) can be retried
     * */
    getMessage: (key: WAMessageKey) => Promise<waproto.IMessage | undefined>;
    /** cached group metadata, use to prevent redundant requests to WA & speed up msg sending */
    cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>;
    makeSignalRepository: (auth: SignalAuthState, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>) => SignalRepositoryWithLIDStore;
};
//# sourceMappingURL=Socket.d.ts.map