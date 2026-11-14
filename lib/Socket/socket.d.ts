import { Boom } from '@hapi/boom';
import { type NewChatMessageCapInfo, type ReachoutTimelockState, type SocketConfig, type WAVersion } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
import { BinaryInfo } from '../WAM/BinaryInfo.js';
import { USyncQuery } from '../WAUSync/index.js';
import { WebSocketClient } from './Client/index.js';
/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */
/**
 * AunuBaileys (P2f, donor v6 1.0.71): resolve the version a socket
 * connects with — a version the server already rejected as too old
 * (405) is replaced by the fetched latest one
 * (`latestVersionOverride`). v7's `config.version` is a static tuple
 * only (no resolver form), so resolution is just override-or-config.
 */
export declare const resolveSocketVersion: (config: SocketConfig, latestOverride?: WAVersion) => WAVersion;
export declare const makeSocket: (config: SocketConfig) => {
    ignoreKey: (rule: any) => () => void;
    clearIgnoredKeys: () => void;
    signalRepository: import("../Types/index.js").SignalRepositoryWithLIDStore;
    user: import("../Types/index.js").Contact | undefined;
    generateMessageTag: () => string;
    query: (node: BinaryNode, timeoutMs?: number) => Promise<any>;
    waitForMessage: <T>(msgId: string, timeoutMs?: number | undefined) => Promise<T | undefined>;
    waitForSocketOpen: () => Promise<void>;
    sendRawMessage: (data: Uint8Array | Buffer) => Promise<void>;
    sendNode: (frame: BinaryNode) => Promise<void>;
    logout: (msg?: string) => Promise<void>;
    end: (error: Error | undefined) => Promise<void>;
    registerSocketEndHandler: (handler: (error: Error | undefined) => void | Promise<void>) => void;
    onUnexpectedError: (err: Error | Boom, msg: string) => void;
    uploadPreKeys: (count?: number) => Promise<void>;
    uploadPreKeysToServerIfRequired: () => Promise<void>;
    digestKeyBundle: () => Promise<void>;
    rotateSignedPreKey: () => Promise<void>;
    requestPairingCode: (phoneNumber: string, customPairingCode?: string) => Promise<string>;
    updateServerTimeOffset: ({ attrs }: BinaryNode) => void;
    sendUnifiedSession: () => Promise<void>;
    wamBuffer: BinaryInfo;
    /** Waits for the connection to WA to reach a state */
    waitForConnectionUpdate: (check: (u: Partial<import("../Types/index.js").ConnectionState>) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
    sendWAMBuffer: (wamBuffer: Buffer) => Promise<any>;
    executeUSyncQuery: (usyncQuery: USyncQuery) => Promise<import("../index.js").USyncQueryResult | undefined>;
    onWhatsApp: (...phoneNumber: string[]) => Promise<{
        jid: string;
        exists: boolean;
    }[] | undefined>;
    fetchAccountReachoutTimelock: () => Promise<ReachoutTimelockState>;
    fetchNewChatMessageCap: () => Promise<NewChatMessageCapInfo>;
    aunuBanSentinel?: import("../Utils/index.js").AunuBanSentinel | undefined;
    type: "md";
    ws: WebSocketClient;
    ev: import("../Types/index.js").BaileysEventEmitter & {
        process(handler: (events: Partial<import("../Types/index.js").BaileysEventMap>) => void | Promise<void>): () => void;
        buffer(): void;
        createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
        flush(): boolean;
        isBuffering(): boolean;
        destroy(): void;
    };
    authState: {
        creds: import("../Types/index.js").AuthenticationCreds;
        keys: import("../Types/index.js").SignalKeyStoreWithTransaction;
    };
    aunuLid: import("../index.js").LIDStore;
    aunuIgnoreFilter: {
        add: (rule: any) => () => void;
        clear: () => void;
        readonly size: number;
        shouldDrop: (category: any, node: any, ownIds: any) => boolean;
    };
};
//# sourceMappingURL=socket.d.ts.map