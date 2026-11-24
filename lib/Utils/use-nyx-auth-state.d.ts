import type { AuthenticationState } from '../Types/index.js';
import type { ILogger } from './logger.js';
export declare const useNyxAuthState: (folder: string, logger?: ILogger) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}>;
/**
 * Pack a session folder into one portable Buffer: every file in
 * the folder (except tmp + quarantined files) as base64. With a
 * password the bundle is gzipped and AES-256-GCM encrypted with a
 * scrypt-derived key (random salt/IV per export); without one it
 * is plain JSON. The plain form contains live session keys — treat
 * it like a private key.
 */
export declare const exportSessionBackup: (folder: string, opts?: {
    password?: string;
}) => Promise<Buffer>;
/**
 * Restore a backup produced by exportSessionBackup into a folder:
 * the bundle is fully validated first (format, version, safe file
 * names, strict base64 payloads, and a creds.json that passes the
 * shared strict creds gate; a wrong password fails the GCM auth-tag
 * check), then every file is staged to tmp and renamed into place.
 * A failure during the rename rolls every already-replaced file back
 * to its previous bytes, so a failed import leaves the folder exactly
 * as it was. Files the bundle does not carry are left alone.
 */
export declare const importSessionBackup: (folder: string, backup: Buffer, opts?: {
    password?: string;
}) => Promise<void>;
//# sourceMappingURL=use-nyx-auth-state.d.ts.map