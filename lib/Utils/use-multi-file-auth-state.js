import { Mutex } from './mutex.js';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { waproto } from '../../WAProto/index.js';
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
// AunuBaileys (2.4.0, HB-2026-1113-143 addendum 2 + HB-151 facets
// 3/4): key material is checked by DECODED LENGTH, not just type —
// Curve keys are exactly 32 bytes private / 32 or 33 bytes public
// (33 = version-prefixed), the signed-pre-key signature is 64 bytes
// and advSecretKey decodes to 32 bytes. String material is base64
// (the HB-157 house format, same decoding as keyMaterialToBuffer).
const keyMaterialLength = (value) => Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.from(value, 'base64').length : undefined;
const isCredsKeyPair = (kp) => !!kp &&
    typeof kp === 'object' &&
    keyMaterialLength(kp.private) === 32 &&
    (keyMaterialLength(kp.public) === 32 || keyMaterialLength(kp.public) === 33);
// AunuBaileys (2.4.0, HB-315 addendum 2): when `me` is present it
// must carry an own JID the login path can actually use — the same
// rules generateLoginNode enforces (all-digit user, user server,
// finite device). A partial me ({}, { lid }, { id: 123 },
// { id: 'abc@…' }) used to pass this gate and loop every boot on
// Boom 400 'Invalid own JID for login node'.
const isValidOwnJid = (id) => {
    if (typeof id !== 'string') {
        return false;
    }
    const match = /^(\d+)(?::(\d+))?@s\.whatsapp\.net$/.exec(id);
    if (!match) {
        return false;
    }
    const userValue = BigInt(match[1]);
    return userValue > 0n && userValue <= 9223372036854775807n;
};
// AunuBaileys (2.6.0, HB-477): shared with use-nyx-auth-state — the
// recovery gate there must be this same strict gate, never a second
// copy that can drift from it (see use-nyx-auth-state.ts).
export const isValidCredsShape = (creds) => !!creds &&
    typeof creds === 'object' &&
    !Array.isArray(creds) &&
    isCredsKeyPair(creds.noiseKey) &&
    isCredsKeyPair(creds.signedIdentityKey) &&
    isCredsKeyPair(creds.signedPreKey?.keyPair) &&
    keyMaterialLength(creds.signedPreKey?.signature) === 64 &&
    Number.isFinite(creds.signedPreKey?.keyId) &&
    Number.isFinite(creds.registrationId) &&
    typeof creds.advSecretKey === 'string' &&
    Buffer.from(creds.advSecretKey, 'base64').length === 32 &&
    isCredsKeyPair(creds.pairingEphemeralKeyPair) &&
    // AunuBaileys (2.4.0, HB-151 facet 6 + facet 1): a present
    // processedHistoryMessages must be an array — a string/number
    // poisoned the first history chunk's isLatest classification
    // and spread into per-character entries on persist.
    (creds.processedHistoryMessages === undefined || Array.isArray(creds.processedHistoryMessages)) &&
    // AunuBaileys (2.4.0, HB-151 facet 2, SAPUAN): a present
    // accountSyncCounter must be a finite number — a string turned
    // the `+ 1` increments at the sync sites into concatenation.
    (creds.accountSyncCounter === undefined || Number.isFinite(creds.accountSyncCounter)) &&
    // AunuBaileys (2.4.0, HB-151 facet 3b, SAPUAN): a present
    // registered flag must be boolean — the string 'false' read
    // truthy and blocked pairing as 'already registered'.
    (creds.registered === undefined || typeof creds.registered === 'boolean') &&
    // AunuBaileys (2.4.0, HB-151 facet 5, SAPUAN): a present
    // routingInfo must be a Buffer — any other truthy value made
    // makeNoiseHandler compute Buffer.alloc(NaN) and throw a bare
    // RangeError at every socket construction.
    (creds.routingInfo === undefined || creds.routingInfo === null || Buffer.isBuffer(creds.routingInfo)) &&
    // AunuBaileys (2.4.0, HB-315 addendum 2): see isValidOwnJid.
    (creds.me === undefined || creds.me === null || isValidOwnJid(creds.me?.id));
export const useMultiFileAuthState = async (folder, logger) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                await atomicWriteFile(filePath, JSON.stringify(data, BufferJSON.replacer), file);
            }
            catch (err) {
                // AunuBaileys (2.1.0, HB-318, donor v6): a failed persist (full disk, permissions) must be visible where it happens — it otherwise surfaces one boot later as a random logout. Still thrown.
                logger?.error({ file, err: err?.message || String(err) }, 'aunu: failed to persist auth file');
                throw err;
            }
            finally {
                release();
            }
        });
    };
    // Raw byte write of one auth file, through the same atomic
    // tmp+rename path as writeData. Used by the HB-2026-1112-38
    // rollback: the snapshot bytes go back verbatim, never
    // re-serialised (a re-serialise could not reproduce a file
    // whose JSON is corrupt, and would not be byte-exact).
    const writeRawData = async (contents, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                await atomicWriteFile(filePath, contents, file);
            }
            finally {
                release();
            }
        });
    };
    // Raw byte snapshot of one auth file — NO JSON parsing, so a
    // corrupt-but-present file snapshots as its exact bytes and
    // rolls back to them. ENOENT / ENAMETOOLONG / ENOTDIR mean
    // "the file cannot exist" and read as null (absent); any other
    // read error throws, so the caller aborts before mutating
    // anything.
    const readRawData = async (file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                return await readFile(filePath, { encoding: 'utf-8' });
            }
            catch (error) {
                const code = error?.code;
                if (code === 'ENOENT' || code === 'ENAMETOOLONG' || code === 'ENOTDIR') {
                    return null;
                }
                throw error;
            }
            finally {
                release();
            }
        });
    };
    // Atomic tmp+rename write of exact bytes (0600, fsync the file
    // before the rename and the directory after it). Shared by
    // writeData (JSON) and writeRawData (rollback bytes).
    const atomicWriteFile = async (filePath, contents, logFile) => {
        // AunuBaileys (2.1.0, HB-303, donor v6): atomic tmp+rename — a crash mid-write used to leave a truncated auth file behind (a lost WhatsApp identity). Write the tmp file 0600; the rename carries the mode onto the target, so pre-existing looser files also self-heal to 0600 on their next save.
        const tmpPath = `${filePath}.tmp-${process.pid}`;
        try {
            await writeFile(tmpPath, contents, { mode: 0o600 });
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
                logger?.warn({ file: logFile, err: syncErr?.message || String(syncErr) }, 'aunu: fsync of auth tmp file failed');
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
            await unlink(tmpPath).catch(() => { });
            throw err;
        }
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
        // AunuBaileys (2.4.0, HB-116 addendum, run-0813): the auth
        // folder itself must not be world-listable — HB-116 closed
        // the FILES at 0600 but the folder was created with the OS
        // default (0755), leaking peer JIDs via file names + mtimes.
        await mkdir(folder, { recursive: true, mode: 0o700 });
    }
    // AunuBaileys (2.4.0, HB-116 addendum): a pre-existing folder
    // keeps its old mode after the mkdir fix above, so tighten it on
    // every boot as well. Best-effort: a filesystem that refuses the
    // chmod must not brick auth loading.
    await chmod(folder, 0o700).catch(() => { });
    // AunuBaileys (2.2.0, HB-2026-1112-14 addendum): sweep tmp
    // files orphaned by crashed/killed writers (the per-write
    // catch removes its own; a SIGKILLed process cannot). Only
    // OUR tmp shape is touched.
    try {
        const entries = await readdir(folder);
        await Promise.all(entries
            .filter(name => name.includes('.tmp-'))
            .map(async (name) => {
            // AunuBaileys (2.4.0, HB-2026-1112-14 addendum 2,
            // SAPUAN): the indiscriminate sweep also deleted
            // tmp files of writers still alive in another
            // process (or a second socket in this one) sharing
            // the folder — their rename then failed ENOENT and
            // the save was lost. Only sweep a tmp whose writer
            // pid is provably dead; a non-pid suffix falls back
            // to an age check (older than one hour).
            const suffix = name.slice(name.lastIndexOf('.tmp-') + '.tmp-'.length);
            if (/^\d+$/.test(suffix)) {
                const pid = Number(suffix);
                if (pid === process.pid) {
                    return;
                }
                try {
                    process.kill(pid, 0);
                    return; // writer still alive — leave its tmp alone
                }
                catch (killErr) {
                    if (killErr?.code !== 'ESRCH') {
                        return; // EPERM etc. — the pid exists, treat as alive
                    }
                }
            }
            else {
                const info = await stat(join(folder, name)).catch(() => undefined);
                if (!info || Date.now() - info.mtimeMs < 3600000) {
                    return;
                }
            }
            await unlink(join(folder, name)).catch(() => { });
        }));
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
                            value = waproto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    // Collect the targets first — no I/O yet.
                    const writes = [];
                    // Removals are collected as THUNKS, not promises:
                    // invoking removeData() would start the unlink
                    // immediately, defeating the ordering below.
                    const removals = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            if (value) {
                                writes.push({ file, value });
                            }
                            else {
                                removals.push(() => removeData(file));
                            }
                        }
                    }
                    // AunuBaileys (2.6.0, HB-2026-1112-38): the writes
                    // used to fan out in a parallel Promise.all — one
                    // failing write (disk full, ENAMETOOLONG) left
                    // its siblings landed, a half-committed
                    // transaction the retry loop then replayed on top
                    // of. Make the batch atomic across files: snapshot
                    // every target's current bytes first, write
                    // SEQUENTIALLY in deterministic (sorted) order,
                    // and on the first failure roll every
                    // already-written file back to its snapshot (or
                    // unlink it, when it did not exist) and rethrow
                    // the ORIGINAL error. A snapshot read error aborts
                    // before anything is mutated. Removals still run
                    // only after every write has succeeded (HB-350
                    // ordering, unchanged). In-process writers are
                    // serialised by the transaction writeMutex around
                    // state.set, so the snapshot+write window cannot
                    // interleave with another commit in this process;
                    // cross-process sharing of one auth folder is out
                    // of scope. A restored store reads as the
                    // pre-commit values, so the HB-473 floating
                    // retry's freshness check still passes and the
                    // retry replays the whole commit normally.
                    writes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
                    const snapshots = new Map();
                    for (const { file } of writes) {
                        snapshots.set(file, await readRawData(file));
                    }
                    const written = [];
                    // AunuBaileys (2.8.0, HB-2026-1112-38 addendum): the
                    // exact bytes THIS commit wrote per file, for the
                    // rollback freshness check below.
                    const writtenContents = new Map();
                    try {
                        for (const { file, value } of writes) {
                            await writeData(value, file);
                            written.push(file);
                            writtenContents.set(file, JSON.stringify(value, BufferJSON.replacer));
                        }
                    }
                    catch (err) {
                        // Roll back in reverse order, best-effort: a
                        // failed rollback is logged loudly but never
                        // masks the original error.
                        for (const file of written.reverse()) {
                            try {
                                // AunuBaileys (2.8.0, HB-2026-1112-38
                                // addendum): a SECOND writer sharing this
                                // folder (its own transaction wrapper, its
                                // own writeMutex) may have committed a
                                // newer value to this file after we wrote
                                // ours. Rolling back over it would silently
                                // erase that commit. Only restore a file
                                // whose current bytes are still exactly
                                // the bytes this commit wrote; a file that
                                // has moved on belongs to the other writer.
                                const currentBytes = await readRawData(file).catch(() => undefined);
                                if (currentBytes !== undefined && currentBytes !== writtenContents.get(file)) {
                                    logger?.warn({ file }, 'aunu: skipping rollback of an auth file another writer has since updated — keeping the newer commit');
                                    continue;
                                }
                                const snapshot = snapshots.get(file);
                                if (snapshot === null || snapshot === undefined) {
                                    await removeData(file);
                                }
                                else {
                                    await writeRawData(snapshot, file);
                                }
                            }
                            catch (rollbackErr) {
                                logger?.error({ file, err: rollbackErr?.message || String(rollbackErr) }, 'aunu: failed to roll back auth file after a failed multi-file commit — store may be half-committed');
                            }
                        }
                        throw err;
                    }
                    // AunuBaileys (2.4.0, LINTAS HB-350 addendum):
                    // removals (in practice pre-key files) used to run
                    // in the same Promise.all fan-out as the writes —
                    // a fast unlink landed even when a sibling write
                    // (e.g. the session record) was still in flight or
                    // failed outright, so a redelivered pre-key message
                    // died permanently with 'Invalid PreKey ID'. Delete
                    // only after every write has succeeded; a failed
                    // write propagates and the removals never run.
                    await Promise.all(removals.map(run => run()));
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
//# sourceMappingURL=use-multi-file-auth-state.js.map