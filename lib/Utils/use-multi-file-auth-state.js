import { Mutex } from 'async-mutex';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Use a Map to store mutexes for each file path
const fileLocks = new Map();
// Get or create a mutex for a specific file path
const getFileLock = (path) => {
    let mutex = fileLocks.get(path);
    if (!mutex) {
        mutex = new Mutex();
        fileLocks.set(path, mutex);
        // AunuBaileys (1.0.70): the lock map grew without bound (one
        // entry per key file). Evict the oldest entries that are not
        // currently held — a held lock is never evicted, so no second
        // mutex can ever be created for the same path mid-write.
        while (fileLocks.size > 1000) {
            const [oldestPath, oldestMutex] = fileLocks.entries().next().value;
            if (oldestMutex.isLocked()) {
                break;
            }
            fileLocks.delete(oldestPath);
        }
    }
    return mutex;
};
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (folder, logger) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                // AunuBaileys: atomic write (tmp + rename) anti-korupsi sesi — terinspirasi @itsliaaa/baileys
                const tmpPath = `${filePath}.tmp-${process.pid}`;
                await writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer));
                await rename(tmpPath, filePath);
            }
            catch (err) {
                // AunuBaileys: a failed persist (full disk, permissions) must
                // be visible where it happens — it otherwise surfaces one
                // boot later as a random logout. Still thrown.
                logger?.error({ file, err: err?.message || String(err) }, 'aunu: failed to persist auth file');
                throw err;
            }
            finally {
                release();
            }
        });
    };
    const readData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return await mutex.acquire().then(async (release) => {
                try {
                    const data = await readFile(filePath, { encoding: 'utf-8' });
                    return JSON.parse(data, BufferJSON.reviver);
                }
                finally {
                    release();
                }
            });
        }
        catch (error) {
            // AunuBaileys: a missing file is a normal first run and stays
            // silent; anything else (corrupt JSON, unreadable file) means
            // stored state is being silently discarded — say so, loudly.
            if (error?.code !== 'ENOENT') {
                logger?.error({ file, err: error?.message || String(error) }, 'aunu: auth file unreadable or corrupt — treating as missing');
            }
            return null;
        }
    };
    const removeData = async (file) => {
        try {
            const filePath = join(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return mutex.acquire().then(async (release) => {
                try {
                    await unlink(filePath);
                }
                catch {
                }
                finally {
                    release();
                }
            });
        }
        catch { }
    };
    const folderInfo = await stat(folder).catch(() => { });
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
        }
    }
    else {
        await mkdir(folder, { recursive: true });
    }
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
    const creds = (await readData('creds.json')) || initAuthCreds();
    let credsWriteInFlight = null;
    let credsWriteQueued = false;
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            // AunuBaileys: coalesce the write bursts. creds.update fires many
            // times per second during pairing (registration, pre-key uploads,
            // identity pushes); upstream queued one full atomic write per call
            // on the file mutex, so pairing did dozens of redundant full-file
            // writes. Concurrent callers now share one in-flight write, and a
            // call landing mid-write schedules exactly ONE follow-up write so
            // the file always ends with the LATEST creds.
            if (credsWriteInFlight) {
                credsWriteQueued = true;
                return credsWriteInFlight;
            }
            credsWriteInFlight = (async () => {
                try {
                    do {
                        credsWriteQueued = false;
                        await writeData(creds, 'creds.json');
                    } while (credsWriteQueued);
                }
                catch (err) {
                    // writeData already logged it; this log covers callers
                    // who fire-and-forget saveCreds (the socket does).
                    logger?.error({ err: err?.message || String(err) }, 'aunu: saveCreds failed');
                    throw err;
                }
                finally {
                    credsWriteInFlight = null;
                }
            })();
            return credsWriteInFlight;
        }
    };
};
//# sourceMappingURL=use-multi-file-auth-state.js.map