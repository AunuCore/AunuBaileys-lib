import type { AuthenticationState } from '../Types/index.js';
import type { ILogger } from './logger.js';
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export declare const useMultiFileAuthState: (folder: string, logger?: ILogger) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
}>;
//# sourceMappingURL=use-multi-file-auth-state.d.ts.map