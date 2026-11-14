import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
export type IdentityChangeResult = {
    action: 'no_identity_node';
} | {
    action: 'invalid_notification';
} | {
    action: 'skipped_companion_device';
    device: number;
} | {
    action: 'skipped_self_primary';
} | {
    action: 'debounced';
} | {
    action: 'skipped_offline';
} | {
    action: 'skipped_no_session';
} | {
    action: 'session_refreshed';
} | {
    action: 'session_refresh_failed';
    error: unknown;
};
/**
 * The debounce cache surface the handler needs — synchronously
 * readable/writable, TTL handled by the implementation. The socket
 * supplies the internal cache (P9); hosts may supply any object with
 * this shape.
 */
export type IdentityDebounceCache = {
    get: (key: string) => boolean | undefined;
    set: (key: string, value: boolean) => unknown;
};
export type IdentityChangeContext = {
    meId: string | undefined;
    meLid: string | undefined;
    validateSession: (jid: string) => Promise<{
        exists: boolean;
        reason?: string;
    }>;
    assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
    debounceCache: IdentityDebounceCache;
    logger: ILogger;
    /**
     * Invoked right before `assertSessions` is called for an existing-session identity change.
     * Used to kick off fire-and-forget side effects (e.g. tctoken re-issuance) in the same
     * order WA Web does — i.e. before the E2E session is re-established.
     * Must not throw; implementations are responsible for their own error handling.
     */
    onBeforeSessionRefresh?: (jid: string) => void;
};
export declare function handleIdentityChange(node: BinaryNode, ctx: IdentityChangeContext): Promise<IdentityChangeResult>;
//# sourceMappingURL=identity-change-handler.d.ts.map