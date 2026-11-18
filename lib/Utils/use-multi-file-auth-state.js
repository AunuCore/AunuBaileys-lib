import { Mutex } from './mutex.js';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
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
const MAX_FILE_LOCKS = 1000;
const getFileLock = (path) => {
    let mutex = fileLocks.get(path);
    if (!mutex) {
        mutex = new Mutex();
        fileLocks.set(path, mutex);
        // AunuBaileys (2.1.0, HB-296, donor v6): one Mutex per auth file forever grew this map without bound — evict the oldest UNLOCKED entry past the cap (a locked one is in use and must stay).
        if (fileLocks.size > MAX_FILE_LOCKS) {
            for (const [key, m] of fileLocks) {
                if (key !== path && !m.isLocked()) {
                    fileLocks.delete(key);
                    break;
                }
            }
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
// AunuBaileys (HB-151, re-applied P3): the shape a complete creds
// state must have at load (see the load site below).
const isCredsKeyPair = (kp) => !!kp &&
    typeof kp === 'object' &&
    (Buffer.isBuffer(kp.private) || typeof kp.private === 'string') &&
    (Buffer.isBuffer(kp.public) || typeof kp.public === 'string');
const isValidCredsShape = (creds) => !!creds &&
    typeof creds === 'object' &&
    !Array.isArray(creds) &&
    isCredsKeyPair(creds.noiseKey) &&
    isCredsKeyPair(creds.signedIdentityKey) &&
    isCredsKeyPair(creds.signedPreKey?.keyPair) &&
    (Buffer.isBuffer(creds.signedPreKey?.signature) || typeof creds.signedPreKey?.signature === 'string') &&
    Number.isFinite(creds.signedPreKey?.keyId) &&
    Number.isFinite(creds.registrationId) &&
    typeof creds.advSecretKey === 'string' &&
    creds.advSecretKey.length > 0 &&
    isCredsKeyPair(creds.pairingEphemeralKeyPair);
export const useMultiFileAuthState = async (folder, logger) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                // AunuBaileys (2.1.0, HB-303, donor v6): atomic tmp+rename — a crash mid-write used to leave a truncated auth file behind (a lost WhatsApp identity). Write the tmp file 0600; the rename carries the mode onto the target, so pre-existing looser files also self-heal to 0600 on their next save.
                const tmpPath = `${filePath}.tmp-${process.pid}`;
                await writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 });
                // AunuBaileys (2.2.0, HB-365): tmp+rename is atomic but
                // not DURABLE — without fsync, an OS crash / power loss
                // can roll the renamed file back to the old (or no)
                // contents even though the write 'succeeded'. fsync
                // the file before the rename and the directory after
                // it. Best-effort: a filesystem that cannot fsync must
                // not brick auth writes, so failures only log.
                try {
                    const tmpHandle = await open(tmpPath, 'r');
                    try {
                        await tmpHandle.sync();
                    }
                    finally {
                        await tmpHandle.close();
                    }
                }
                catch (syncErr) {
                    logger?.warn({ file, err: syncErr?.message || String(syncErr) }, 'aunu: fsync of auth tmp file failed');
                }
                await rename(tmpPath, filePath);
                try {
                    const dirHandle = await open(folder, 'r');
                    try {
                        await dirHandle.sync();
                    }
                    finally {
                        await dirHandle.close();
                    }
                }
                catch {
                    // directory fsync is unsupported on some platforms — the file fsync above is the critical half
                }
            }
            catch (err) {
                // AunuBaileys (2.2.0, HB-2026-1112-14 addendum): a
                // failed write used to leak its tmp file forever;
                // remove it (the boot sweep below covers the rest).
                await unlink(`${filePath}.tmp-${process.pid}`).catch(() => { });
                // AunuBaileys (2.1.0, HB-318, donor v6): a failed persist (full disk, permissions) must be visible where it happens — it otherwise surfaces one boot later as a random logout. Still thrown.
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
            // AunuBaileys (2.1.0, HB-318, donor v6): a missing file is a normal first run and stays silent; anything else (corrupt JSON, unreadable file) means stored state is being silently discarded — say so, loudly.
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
    // AunuBaileys (2.2.0, HB-2026-1112-14 addendum): sweep tmp
    // files orphaned by crashed/killed writers (the per-write
    // catch removes its own; a SIGKILLed process cannot). Only
    // OUR tmp shape is touched.
    try {
        const entries = await readdir(folder);
        await Promise.all(entries
            .filter(name => name.includes('.tmp-'))
            .map(name => unlink(join(folder, name)).catch(() => { })));
    }
    catch {
        // a sweep failure must never block boot
    }
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
    const storedCreds = await readData('creds.json');
    // AunuBaileys (1.0.79, HB-151 + 1.0.88 HB-80 addendum, re-applied
    // P3): a creds.json that parses to {} / a partial object used to be
    // accepted as a complete auth state (it is truthy) and every
    // downstream consumer then failed in its own misleading way.
    // Validate the shape at this one load choke point; a
    // present-but-invalid creds is discarded, exactly like corrupt
    // JSON. Key material follows the HB-98 test (Buffer or base64
    // string); ids must be finite numbers.
    const creds = isValidCredsShape(storedCreds)
        ? storedCreds
        : (() => {
            // AunuBaileys (2.1.0, HB-318, donor v6): a present-but-invalid creds.json used to be discarded silently — say so, loudly.
            if (storedCreds) {
                logger?.error({ file: 'creds.json' }, 'aunu: creds.json does not have the shape of a complete auth state — discarding it and starting fresh; restore a full backup or pair again');
            }
            return initAuthCreds();
        })();
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
            return writeData(creds, 'creds.json');
        }
    };
};
//# sourceMappingURL=use-multi-file-auth-state.js.map