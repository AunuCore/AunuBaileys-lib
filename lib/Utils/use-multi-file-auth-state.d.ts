import type { ILogger } from './logger.js';
import type { AuthenticationState } from '../Types/index.js';
export declare const isValidCredsShape: (creds: any) => boolean;
export declare const useMultiFileAuthState: (folder: string, logger?: ILogger) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}>;
//# sourceMappingURL=use-multi-file-auth-state.d.ts.map