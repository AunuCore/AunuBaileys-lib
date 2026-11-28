import * as libsignal from 'libsignal';
import type { LIDMapping, SignalAuthState } from '../Types/index.js';
import type { SignalRepositoryWithLIDStore } from '../Types/Signal.js';
import type { ILogger } from '../Utils/logger.js';
import type { SenderKeyStore } from './Group/group_cipher.js';
import { LIDMappingStore } from './lid-mapping.js';
export declare function makeLibSignalRepository(auth: SignalAuthState, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>): SignalRepositoryWithLIDStore;
export declare function signalStorage({ creds, keys }: SignalAuthState, lidMapping: LIDMappingStore): SenderKeyStore & libsignal.SignalStorage & {
    loadIdentityKey(id: string): Promise<Uint8Array | undefined>;
    saveIdentity(id: string, identityKey: Uint8Array, preserveSession?: boolean): Promise<boolean>;
};
//# sourceMappingURL=libsignal.d.ts.map