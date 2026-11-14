// AunuCore fork compat — ekspor yang dulu disediakan fork Baileys populer (lilys/canta)
// dan diandalkan banyak script bot. Implementasi bersih, ditulis dari kontrak resmi Baileys.
/**
 * Registry pesan yang sudah diproses (dedup antar handler).
 * Script lama mengharapkan ekspor ini ada; isinya Map id-pesan -> true.
 */
export const processedMessages = new Map();
/**
 * Signal key store murni in-memory, kompatibel dengan kontrak SignalKeyStore
 * resmi (get/set/clear) — pasangan makeCacheableSignalKeyStore untuk sesi
 * yang tidak perlu persisten di disk.
 */
export const initInMemoryKeyStore = () => {
    const data = new Map();
    const k = (type, id) => `${type}:${id}`;
    return {
        get: async (type, ids) => {
            const out = {};
            for (const id of ids) {
                const key = k(type, id);
                if (data.has(key)) {
                    out[id] = data.get(key);
                }
            }
            return out;
        },
        set: async (dataset) => {
            for (const type in dataset) {
                for (const id in dataset[type]) {
                    const v = dataset[type][id];
                    if (v) {
                        data.set(k(type, id), v);
                    }
                    else {
                        data.delete(k(type, id));
                    }
                }
            }
        },
        clear: async () => {
            data.clear();
        }
    };
};
//# sourceMappingURL=fork-compat.js.map