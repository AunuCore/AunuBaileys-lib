import { Boom } from '@hapi/boom';
import axios, {} from 'axios';
import { createHash, randomBytes } from 'crypto';
import { platform, release } from 'os';
import { proto } from '../../WAProto/index.js';
import version from '../Defaults/baileys-version.json' with { type: 'json' };
const baileysVersion = version.version;
import { DisconnectReason } from '../Types/index.js';
import { getAllBinaryNodeChildren, jidDecode } from '../WABinary/index.js';
const PLATFORM_MAP = {
    aix: 'AIX',
    darwin: 'Mac OS',
    win32: 'Windows',
    android: 'Android',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'Solaris',
    linux: undefined,
    haiku: undefined,
    cygwin: undefined,
    netbsd: undefined
};
export const Browsers = {
    ubuntu: browser => ['Ubuntu', browser, '22.04.4'],
    macOS: browser => ['Mac OS', browser, '14.4.1'],
    baileys: browser => ['Baileys', browser, '6.5.0'],
    windows: browser => ['Windows', browser, '10.0.22631'],
    /** AunuBaileys: sesi yang tampil sebagai Android */
    android: browser => ['Android', browser, '14'],
    /** The appropriate browser based on your OS & release */
    appropriate: browser => [PLATFORM_MAP[platform()] || 'Ubuntu', browser, release()]
};
export const getPlatformId = (browser) => {
    const platformType = proto.DeviceProps.PlatformType[browser.toUpperCase()];
    return platformType ? platformType.toString() : '1'; //chrome
};
export const BufferJSON = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replacer: (k, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
        }
        return value;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviver: (_, value) => {
        if (typeof value === 'object' && !!value && (value.buffer === true || value.type === 'Buffer')) {
            const val = value.data || value.value;
            return typeof val === 'string' ? Buffer.from(val, 'base64') : Buffer.from(val || []);
        }
        return value;
    }
};
export const getKeyAuthor = (key, meId = 'me') => (key?.fromMe ? meId : key?.participant || key?.remoteJid) || '';
export const writeRandomPadMax16 = (msg) => {
    const pad = randomBytes(1);
    const padLength = (pad[0] & 0x0f) + 1;
    return Buffer.concat([msg, Buffer.alloc(padLength, padLength)]);
};
export const unpadRandomMax16 = (e) => {
    const t = new Uint8Array(e);
    if (0 === t.length) {
        throw new Error('unpadPkcs7 given empty bytes');
    }
    var r = t[t.length - 1];
    if (r > t.length) {
        throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
    }
    return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
};
export const encodeWAMessage = (message) => writeRandomPadMax16(proto.Message.encode(message).finish());
export const generateRegistrationId = () => {
    return Uint16Array.from(randomBytes(2))[0] & 16383;
};
export const encodeBigEndian = (e, t = 4) => {
    let r = e;
    const a = new Uint8Array(t);
    for (let i = t - 1; i >= 0; i--) {
        a[i] = 255 & r;
        r >>>= 8;
    }
    return a;
};
export const toNumber = (t) => typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : t.low) : t || 0;
/** unix timestamp of a date in seconds */
export const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000);
export const debouncedTimeout = (intervalMs = 1000, task) => {
    let timeout;
    return {
        start: (newIntervalMs, newTask) => {
            task = newTask || task;
            intervalMs = newIntervalMs || intervalMs;
            timeout && clearTimeout(timeout);
            timeout = setTimeout(() => task?.(), intervalMs);
        },
        cancel: () => {
            timeout && clearTimeout(timeout);
            timeout = undefined;
        },
        setTask: (newTask) => (task = newTask),
        setInterval: (newInterval) => (intervalMs = newInterval)
    };
};
export const delay = (ms) => delayCancellable(ms).delay;
export const delayCancellable = (ms) => {
    const stack = new Error().stack;
    let timeout;
    let reject;
    const delay = new Promise((resolve, _reject) => {
        timeout = setTimeout(resolve, ms);
        reject = _reject;
    });
    const cancel = () => {
        clearTimeout(timeout);
        reject(new Boom('Cancelled', {
            statusCode: 500,
            data: {
                stack
            }
        }));
    };
    return { delay, cancel };
};
export async function promiseTimeout(ms, promise) {
    if (!ms) {
        return new Promise(promise);
    }
    const stack = new Error().stack;
    // Create a promise that rejects in <ms> milliseconds
    const { delay, cancel } = delayCancellable(ms);
    const p = new Promise((resolve, reject) => {
        delay
            .then(() => reject(new Boom('Timed Out', {
            statusCode: DisconnectReason.timedOut,
            data: {
                stack
            }
        })))
            .catch(err => reject(err));
        promise(resolve, reject);
    }).finally(cancel);
    return p;
}
// inspired from whatsmeow code
// https://github.com/tulir/whatsmeow/blob/64bc969fbe78d31ae0dd443b8d4c80a5d026d07a/send.go#L42
export const generateMessageIDV2 = (userId) => {
    const data = Buffer.alloc(8 + 20 + 16);
    data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    if (userId) {
        const id = jidDecode(userId);
        if (id?.user) {
            data.write(id.user, 8);
            data.write('@c.us', 8 + id.user.length);
        }
    }
    const random = randomBytes(16);
    random.copy(data, 28);
    const hash = createHash('sha256').update(data).digest();
    return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18);
};
// generate a random ID to attach to a message
export const generateMessageID = () => '3EB0' + randomBytes(18).toString('hex').toUpperCase();
export function bindWaitForEvent(ev, event) {
    return async (check, timeoutMs) => {
        let listener;
        let closeListener;
        await promiseTimeout(timeoutMs, (resolve, reject) => {
            closeListener = ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                    reject(lastDisconnect?.error || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed }));
                }
            };
            ev.on('connection.update', closeListener);
            listener = async (update) => {
                // AunuBaileys (1.0.67): a throwing host predicate used to
                // become an unhandled rejection AND leave the wait
                // promise pending forever; reject the wait instead.
                try {
                    if (await check(update)) {
                        resolve();
                    }
                }
                catch (err) {
                    reject(err);
                }
            };
            ev.on(event, listener);
        }).finally(() => {
            ev.off(event, listener);
            ev.off('connection.update', closeListener);
        });
    };
}
export const bindWaitForConnectionUpdate = (ev) => bindWaitForEvent(ev, 'connection.update');
/**
 * utility that fetches latest baileys version from the master branch.
 * Use to ensure your WA connection is always on the latest version
 */
// AunuBaileys: last-good cache for the fetched WA version. The endpoint's
// value is the server-accepted truth (a bundled version can be a rejected
// beta build — see 1.0.13), so once a fetch succeeds in this process, a
// later network failure must fall back to that fetched value, not silently
// downgrade to the bundled one. Repeated calls within the TTL also skip
// the network entirely; consumers typically call this on every reconnect.
const BAILEYS_VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
// AunuBaileys (1.0.71): build an abort signal honouring an optional
// caller signal plus a timeout (default 10s). AbortSignal.any lets
// either side — the caller's signal or the timeout — abort the fetch.
const makeTimeoutSignal = (timeoutMs, callerSignal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
};
let lastGoodBaileysVersion = null;
let lastGoodBaileysVersionAt = 0;
export const fetchLatestBaileysVersion = async (options = {}) => {
    const URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';
    // AunuBaileys (1.0.71): timeoutMs/signal — a hung version fetch must
    // not stall the reconnect path that awaits this (default 10s).
    const { cacheTtlMs = BAILEYS_VERSION_CACHE_TTL_MS, forceRefresh = false, timeoutMs = 10000, signal: callerSignal, ...axiosOptions } = options;
    if (!forceRefresh && lastGoodBaileysVersion && (Date.now() - lastGoodBaileysVersionAt) < cacheTtlMs) {
        return {
            version: lastGoodBaileysVersion,
            isLatest: true
        };
    }
    try {
        const result = await axios.get(URL, {
            ...axiosOptions,
            responseType: 'json',
            signal: makeTimeoutSignal(timeoutMs, callerSignal)
        });
        lastGoodBaileysVersion = result.data.version;
        lastGoodBaileysVersionAt = Date.now();
        return {
            version: result.data.version,
            isLatest: true
        };
    }
    catch (error) {
        return {
            version: lastGoodBaileysVersion ?? baileysVersion,
            isLatest: false,
            error
        };
    }
};
/**
 * A utility that fetches the latest web version of whatsapp.
 * Use to ensure your WA connection is always on the latest version
 */
// AunuBaileys (1.0.70): same monotonic last-good cache as
// fetchLatestBaileysVersion — a failed fetch must fall back to the last
// fetched version, never silently downgrade to the bundled one (that
// downgrade looped on 408s, upstream issue #2777).
let lastGoodWaWebVersion = null;
let lastGoodWaWebVersionAt = 0;
export const fetchLatestWaWebVersion = async (options = {}) => {
    // AunuBaileys (1.0.71): same timeoutMs/signal support as
    // fetchLatestBaileysVersion — the 405 path awaits this fetch.
    const { cacheTtlMs = BAILEYS_VERSION_CACHE_TTL_MS, forceRefresh = false, timeoutMs = 10000, signal: callerSignal, ...axiosOptions } = options;
    if (!forceRefresh && lastGoodWaWebVersion && (Date.now() - lastGoodWaWebVersionAt) < cacheTtlMs) {
        return {
            version: lastGoodWaWebVersion,
            isLatest: true
        };
    }
    try {
        const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
            ...axiosOptions,
            responseType: 'json',
            signal: makeTimeoutSignal(timeoutMs, callerSignal)
        });
        const regex = /\\?"client_revision\\?":\s*(\d+)/;
        const match = data.match(regex);
        if (!match?.[1]) {
            return {
                version: lastGoodWaWebVersion ?? baileysVersion,
                isLatest: false,
                error: {
                    message: 'Could not find client revision in the fetched content'
                }
            };
        }
        const clientRevision = match[1];
        lastGoodWaWebVersion = [2, 3000, +clientRevision];
        lastGoodWaWebVersionAt = Date.now();
        return {
            version: lastGoodWaWebVersion,
            isLatest: true
        };
    }
    catch (error) {
        return {
            version: lastGoodWaWebVersion ?? baileysVersion,
            isLatest: false,
            error
        };
    }
};
/** unique message tag prefix for MD clients */
export const generateMdTagPrefix = () => {
    const bytes = randomBytes(4);
    return `${bytes.readUInt16BE()}.${bytes.readUInt16BE(2)}-`;
};
const STATUS_MAP = {
    sender: proto.WebMessageInfo.Status.SERVER_ACK,
    played: proto.WebMessageInfo.Status.PLAYED,
    read: proto.WebMessageInfo.Status.READ,
    'read-self': proto.WebMessageInfo.Status.READ
};
/**
 * Given a type of receipt, returns what the new status of the message should be
 * @param type type from receipt
 */
export const getStatusFromReceiptType = (type) => {
    const status = STATUS_MAP[type];
    if (typeof type === 'undefined') {
        return proto.WebMessageInfo.Status.DELIVERY_ACK;
    }
    return status;
};
const CODE_MAP = {
    conflict: DisconnectReason.connectionReplaced
};
/**
 * Stream errors generally provide a reason, map that to a baileys DisconnectReason
 * @param reason the string reason given, eg. "conflict"
 */
export const getErrorCodeFromStreamError = (node) => {
    const [reasonNode] = getAllBinaryNodeChildren(node);
    let reason = reasonNode?.tag || 'unknown';
    // AunuBaileys (1.0.67): sanitise the code — a non-numeric value
    // (NaN) or an HTTP code below 400 makes `new Boom` throw inside the
    // stream:error handler; fall back to badSession in those cases.
    let statusCode = +(node.attrs.code || CODE_MAP[reason] || DisconnectReason.badSession);
    if (!Number.isFinite(statusCode) || statusCode < 400 || statusCode > 599) {
        statusCode = DisconnectReason.badSession;
    }
    if (statusCode === DisconnectReason.restartRequired) {
        reason = 'restart required';
    }
    return {
        reason,
        statusCode
    };
};
export const getCallStatusFromNode = ({ tag, attrs }) => {
    let status;
    switch (tag) {
        case 'offer':
        case 'offer_notice':
            status = 'offer';
            break;
        case 'terminate':
            if (attrs.reason === 'timeout') {
                status = 'timeout';
            }
            else {
                //fired when accepted/rejected/timeout/caller hangs up
                status = 'terminate';
            }
            break;
        case 'reject':
            status = 'reject';
            break;
        case 'accept':
            status = 'accept';
            break;
        default:
            status = 'ringing';
            break;
    }
    return status;
};
const UNEXPECTED_SERVER_CODE_TEXT = 'Unexpected server response: ';
export const getCodeFromWSError = (error) => {
    // AunuBaileys (1.0.77, HB-133): an error that already carries a
    // valid Boom status code keeps it. Re-deriving the code from the
    // message text lost real codes — promiseTimeout's Boom
    // 'Timed Out' (408) was re-wrapped as a 500 by mapWebSocketError
    // because the textual timeout check below is case-sensitive
    // ('Timed Out' vs 'timed out').
    const existingCode = error?.output?.statusCode;
    if (Number.isFinite(existingCode) && existingCode >= 400 && existingCode <= 599) {
        return existingCode;
    }
    let statusCode = 500;
    if (error?.message?.includes(UNEXPECTED_SERVER_CODE_TEXT)) {
        const code = +error?.message.slice(UNEXPECTED_SERVER_CODE_TEXT.length);
        if (!Number.isNaN(code) && code >= 400) {
            statusCode = code;
        }
    }
    else if (
    // AunuBaileys (1.0.67): error.code can be numeric (e.g. WS close
    // 1006) — only call startsWith on strings.
    (typeof error?.code === 'string' && error.code.startsWith('E')) ||
        error?.message?.toLowerCase().includes('timed out')) {
        // handle ETIMEOUT, ENOTFOUND etc
        statusCode = 408;
    }
    return statusCode;
};
/**
 * Is the given platform WA business
 * @param platform AuthenticationCreds.platform
 */
export const isWABusinessPlatform = (platform) => {
    return platform === 'smbi' || platform === 'smba';
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function trimUndefined(obj) {
    for (const key in obj) {
        if (typeof obj[key] === 'undefined') {
            delete obj[key];
        }
    }
    return obj;
}
const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';
export function bytesToCrockford(buffer) {
    let value = 0;
    let bitCount = 0;
    const crockford = [];
    for (const element of buffer) {
        value = (value << 8) | (element & 0xff);
        bitCount += 8;
        while (bitCount >= 5) {
            crockford.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31));
            bitCount -= 5;
        }
    }
    if (bitCount > 0) {
        crockford.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31));
    }
    return crockford.join('');
}
export function encodeNewsletterMessage(message) {
    return proto.Message.encode(message).finish();
}
//# sourceMappingURL=generics.js.map