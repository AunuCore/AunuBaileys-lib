import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types/index.js';
import type { ILogger } from '../Utils/logger.js';
export declare class LIDMappingStore {
    private readonly mappingCache;
    private readonly keys;
    private readonly logger;
    private readonly maxPersistentEntries;
    private readonly persistedPairs;
    private readonly negativeCache;
    private static readonly NEGATIVE_CACHE_TTL_MS;
    private static readonly NEGATIVE_CACHE_MAX_ENTRIES;
    private hasFreshNegativeMapping;
    private recordNegativeMapping;
    private clearNegativeMapping;
    private pnToLIDFunc?;
    private readonly inflightLIDLookups;
    private readonly inflightPNLookups;
    private readonly storeMutex;
    constructor(keys: SignalKeyStoreWithTransaction, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>, options?: {
        maxEntries?: number;
    });
    private registerPersistedPair;
    storeLIDPNMappings(pairs: LIDMapping[]): Promise<void>;
    private storeLIDPNMappingsInner;
    getLIDForPN(pn: string): Promise<string | null>;
    getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null>;
    private _getLIDsForPNsImpl;
    getPNForLID(lid: string): Promise<string | null>;
    getPNsForLIDs(lids: string[]): Promise<LIDMapping[] | null>;
    private _getPNsForLIDsImpl;
    /**
     * Close the cache and release resources
     */
    close(): void;
}
//# sourceMappingURL=lid-mapping.d.ts.map