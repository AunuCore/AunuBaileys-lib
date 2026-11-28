import type { AuthenticationCreds, CacheStore, SignalKeyStore, SignalKeyStoreWithTransaction, TransactionCapabilityOptions } from '../Types/index.js';
import type { ILogger } from './logger.js';
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export declare function makeCacheableSignalKeyStore(store: SignalKeyStore, logger?: ILogger, _cache?: CacheStore): SignalKeyStore & {
    close(): void;
};
export declare const addTransactionCapability: (state: SignalKeyStore, logger: ILogger, { maxCommitRetries, delayBetweenTriesMs, stuckTransactionTimeoutMs, onStuckTransaction }?: Partial<TransactionCapabilityOptions>) => SignalKeyStoreWithTransaction & {
    disposeTransactionStorage: () => void;
    close?: () => void;
};
/**
 * Returns the authenticated user's JID, or throws a Boom-401 if creds are not yet authenticated.
 * Use this anywhere we'd otherwise reach for `creds.me!.id` to fail fast with a descriptive error.
 */
export declare const assertMeId: (creds: AuthenticationCreds) => string;
export declare const initAuthCreds: () => AuthenticationCreds;
//# sourceMappingURL=auth-utils.d.ts.map