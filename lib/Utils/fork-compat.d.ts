/**
 * Registry pesan yang sudah diproses (dedup antar handler).
 * Script lama mengharapkan ekspor ini ada; isinya Map id-pesan -> true.
 */
export declare const processedMessages: Map<string, boolean>;
/**
 * Signal key store murni in-memory, kompatibel dengan kontrak SignalKeyStore
 * resmi (get/set/clear) — pasangan makeCacheableSignalKeyStore untuk sesi
 * yang tidak perlu persisten di disk.
 */
export declare const initInMemoryKeyStore: () => {
    get: (type: string, ids: string[]) => Promise<{
        [id: string]: any;
    }>;
    set: (dataset: {
        [type: string]: {
            [id: string]: any;
        };
    }) => Promise<void>;
    clear: () => Promise<void>;
};
//# sourceMappingURL=fork-compat.d.ts.map