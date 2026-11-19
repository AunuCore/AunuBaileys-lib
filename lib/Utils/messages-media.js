import { Boom } from '@hapi/boom';
import { spawn } from 'child_process';
import * as Crypto from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { waproto } from '../../WAProto/index.js';
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js';
import { generateMessageIDV2 } from './generics.js';
import { readImageDimensions } from './safe-fetch.js';
const getTmpFilesDirectory = () => tmpdir();
// AunuBaileys (2.3.0, HB-392): media timeout values used to reach
// AbortSignal.timeout() raw — 0 aborted every fetch instantly and
// NaN/negative/Infinity threw a synchronous RangeError, while a fired
// signal surfaced as a raw DOMException TimeoutError with no
// statusCode. Sanitise like the upload path's effectiveTimeoutMs
// (finite positive wins, anything else falls back) and translate
// aborts to Boom 408 at the fetch choke point (getHttpStream).
export const sanitizeMediaTimeoutMs = (value, fallback = 120000) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
export const isMediaAbortError = (error) => {
    const name = error?.name;
    return name === 'TimeoutError' || name === 'AbortError';
};
export const destroyQuietly = (stream) => {
    // AunuBaileys (2.3.0, HB-208 addendum): catch blocks called
    // stream.destroy() bare — for an unusable `stream` member the
    // destroy itself threw and the tmp-file unlink after it never
    // ran, leaking a 0-byte file per failed call.
    try {
        ;
        stream?.destroy?.();
    }
    catch {
        // a broken stream must never mask the original error or skip cleanup
    }
};
// AunuBaileys (P2e port from v6): exported for the sticker-pack builder in
// messages.ts, and the @napi-rs/image backend is probed like in v6 — a host
// with only @napi-rs/image (no sharp/jimp) must still be able to convert
// sticker/cover images (the HB-164 gap in the pack path).
export const getImageProcessingLibrary = async () => {
    const [jimp, sharp, image] = await Promise.all([
        //@ts-ignore — optional peer: may be absent at build time
        import('jimp').catch(() => { }),
        //@ts-ignore
        import('sharp').catch(() => { }),
        //@ts-ignore
        import('@napi-rs/image').catch(() => { })
    ]);
    if (sharp) {
        return { sharp };
    }
    if (image) {
        return { image };
    }
    if (jimp) {
        return { jimp };
    }
    throw new Boom('No image processing library available');
};
// AunuBaileys (HB-277, P4): pixel/decompression-bomb guard, reusing
// the 1.0.85 link-preview defence (readImageDimensions + the same
// 40 MP cap) at every OTHER decode site. The byte caps at these
// sites (1 MB sticker / 5 MB cover / 16 MB profile picture) say
// nothing about pixels: a solid 281 KB PNG can declare 17000x17000
// (289 MP). sharp refuses that on its own (268 MP internal limit),
// but the @napi-rs/image backend has NO limit and decodes the full
// raster (measured +276 MB RSS for one image; four in parallel —
// the sticker-pack Promise.all pattern — OOM-killed the process),
// and jimp decodes the full raster too. Read the header dimensions
// BEFORE any backend sees the bytes; formats the header reader
// does not know keep the old behaviour (decode decides).
export const MAX_IMAGE_PIXELS = 40000000;
export const assertImageWithinPixelLimit = (buffer, context) => {
    const dims = readImageDimensions(buffer);
    if (dims && dims.width * dims.height > MAX_IMAGE_PIXELS) {
        throw new Boom(`${context}: image dimensions ${dims.width}x${dims.height} exceed the ${MAX_IMAGE_PIXELS} pixel limit`, { statusCode: 400 });
    }
};
export const hkdfInfoKey = (type) => {
    const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type];
    return `WhatsApp ${hkdfInfo} Keys`;
};
export const getRawMediaUploadData = async (media, mediaType, logger, opts) => {
    // AunuBaileys (2.2.0, HB-344 addendum): opts (incl. the host's
    // AbortSignal) used to be accepted and then DROPPED here —
    // getStream was called bare, so the newsletter raw-media path
    // streamed without any timeout even when the caller set one.
    const { stream } = await getStream(media, opts);
    logger?.debug('got stream for raw upload');
    const hasher = Crypto.createHash('sha256');
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
    const fileWriteStream = createWriteStream(filePath);
    // AunuBaileys (HB-273, P4): the write stream only had an 'error'
    // listener while a once('drain')/once('finish') await was pending.
    // An open/write failure (tmpdir gone, ENOSPC) that fired while the
    // loop was awaiting the next INPUT chunk had no listener at all —
    // an uncaught 'error' event that killed the process, bypassing
    // this try/catch entirely. Keep a persistent listener, and race
    // every drain-wait against the captured error: an error that
    // fired BEFORE the wait started would otherwise leave
    // once('drain') pending forever.
    let writeError;
    let rejectWriteError = () => { };
    const writeErrorPromise = new Promise((_resolve, reject) => {
        rejectWriteError = reject;
    });
    writeErrorPromise.catch(() => { });
    fileWriteStream.on('error', err => {
        if (!writeError) {
            writeError = err;
            rejectWriteError(err);
        }
    });
    let fileLength = 0;
    try {
        for await (const data of stream) {
            // AunuBaileys (2.1.0, HB-2026-1112-50 addendum): enforce the host-configured maxContentLength here, like encryptedStream does — the raw newsletter path used to ignore it entirely. Check first, before counting the chunk.
            if (opts?.maxContentLength && fileLength + data.length > opts.maxContentLength) {
                throw new Boom(`content length exceeded when reading raw media for upload`, { data: { mediaType } });
            }
            fileLength += data.length;
            hasher.update(data);
            if (!fileWriteStream.write(data)) {
                await Promise.race([once(fileWriteStream, 'drain'), writeErrorPromise]);
            }
        }
        if (writeError) {
            throw writeError;
        }
        fileWriteStream.end();
        await once(fileWriteStream, 'finish');
        stream.destroy();
        const fileSha256 = hasher.digest();
        logger?.debug('hashed data for raw upload');
        return {
            filePath: filePath,
            fileSha256,
            fileLength
        };
    }
    catch (error) {
        // AunuBaileys (2.3.0, HB-208 addendum): destroy quietly — a
        // throwing destroy here used to skip the unlink below.
        fileWriteStream.destroy();
        destroyQuietly(stream);
        try {
            await fs.unlink(filePath);
        }
        catch {
            //
        }
        throw error;
    }
};
/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(buffer, mediaType) {
    if (!buffer) {
        throw new Boom('Cannot derive from empty media key');
    }
    if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
    }
    // expand using HKDF to 112 bytes, also pass in the relevant app info
    const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80)
    };
}
/** Extracts video thumb using FFMPEG */
// AunuBaileys (1.0.85, HB-128, re-applied P3b): ffmpeg used to run
// through a shell string with NO timeout and NO kill — a wedged
// ffmpeg hung generateThumbnail, and with it the Promise.all inside
// prepareWAMessageMedia, so the video send never settled; stderr
// also accumulated without bound. Spawn with an argument array (no
// shell interpolation of path/time/size), SIGKILL after the
// timeout, and keep only the first 64 KiB of stderr (plenty for the
// error message).
const FFMPEG_THUMB_TIMEOUT_MS = 30000;
const FFMPEG_STDERR_CAP_BYTES = 64 * 1024;
const extractVideoThumb = async (path, destPath, time, size) => new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-ss', String(time), '-i', path, '-y', '-vf', `scale=${size.width}:-1`, '-vframes', '1', '-f', 'image2', destPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks = [];
    let stderrBytes = 0;
    ffmpeg.stderr.on('data', (chunk) => {
        if (stderrBytes >= FFMPEG_STDERR_CAP_BYTES) {
            return;
        }
        const keep = chunk.subarray(0, FFMPEG_STDERR_CAP_BYTES - stderrBytes);
        stderrChunks.push(keep);
        stderrBytes += keep.length;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ffmpeg.kill('SIGKILL');
    }, FFMPEG_THUMB_TIMEOUT_MS);
    timer.unref?.();
    ffmpeg.on('error', err => {
        clearTimeout(timer);
        reject(err);
    });
    ffmpeg.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
            resolve();
        }
        else if (timedOut) {
            reject(new Error(`ffmpeg timed out after ${FFMPEG_THUMB_TIMEOUT_MS}ms while extracting a video thumbnail`));
        }
        else {
            reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
        }
    });
});
export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    // TODO: Move entirely to sharp, removing jimp as it supports readable streams
    // This will have positive speed and performance impacts as well as minimizing RAM usage.
    if (bufferOrFilePath instanceof Readable) {
        bufferOrFilePath = await toBuffer(bufferOrFilePath);
    }
    // AunuBaileys (HB-277, P4): pixel-bomb guard BEFORE any backend
    // decodes — a file-path input is read into memory so its header
    // can be checked (the napi/jimp branches read it fully anyway,
    // and sharp accepts a Buffer identically).
    if (typeof bufferOrFilePath === 'string') {
        bufferOrFilePath = await fs.readFile(bufferOrFilePath);
    }
    assertImageWithinPixelLimit(bufferOrFilePath, 'extractImageThumb');
    const lib = await getImageProcessingLibrary();
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = lib.sharp.default(bufferOrFilePath);
        const dimensions = await img.metadata();
        const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer();
        return {
            buffer,
            original: {
                width: dimensions.width,
                height: dimensions.height
            }
        };
    }
    else if ('image' in lib && lib.image?.Transformer) {
        // AunuBaileys (P2e port from v6): @napi-rs/image backend — the
        // loader now returns it ahead of jimp (v6 order), so this branch
        // must exist or napi-only hosts regress to the throw below.
        if (!Buffer.isBuffer(bufferOrFilePath)) {
            bufferOrFilePath = await fs.readFile(bufferOrFilePath);
        }
        const img = new lib.image.Transformer(bufferOrFilePath);
        const dimensions = await img.metadata();
        const buffer = await img.resize(width, undefined, 0).jpeg(50);
        return {
            buffer,
            original: {
                width: dimensions.width,
                height: dimensions.height
            }
        };
    }
    else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
        const jimp = await lib.jimp.Jimp.read(bufferOrFilePath);
        const dimensions = {
            width: jimp.width,
            height: jimp.height
        };
        const buffer = await jimp
            .resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR })
            .getBuffer('image/jpeg', { quality: 50 });
        return {
            buffer,
            original: dimensions
        };
    }
    else {
        throw new Boom('No image processing library available');
    }
};
export const encodeBase64EncodedStringForUpload = (b64) => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''));
export const generateProfilePicture = async (mediaUpload, dimensions) => {
    let buffer;
    const { width: w = 640, height: h = 640 } = dimensions || {};
    if (Buffer.isBuffer(mediaUpload)) {
        buffer = mediaUpload;
    }
    else {
        // Use getStream to handle all WAMediaUpload types (Buffer, Stream, URL)
        // AunuBaileys (1.0.85, HB-219, re-applied P3b): a remote URL used to be
        // buffered with NO size cap and NO timeout — a huge or never-ending
        // response was accumulated in full before the image decode finally
        // rejected it, and a stalled server hung updateProfilePicture forever.
        // Bound both (16 MiB matches the product-image cap).
        const { stream } = await getStream(mediaUpload, { signal: AbortSignal.timeout(30000) });
        // Convert the resulting stream to a buffer, with a hard cap
        buffer = await toBufferWithLimit(stream, MAX_PROFILE_PICTURE_SOURCE_BYTES);
    }
    // AunuBaileys (HB-277, P4): the 16 MiB cap above bounds BYTES,
    // not pixels — check the header dimensions before the resize
    // decode below (the @napi-rs/image and jimp backends would
    // decode a 289 MP raster in full).
    assertImageWithinPixelLimit(buffer, 'generateProfilePicture');
    const lib = await getImageProcessingLibrary();
    let img;
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        img = lib.sharp
            .default(buffer)
            .resize(w, h)
            .jpeg({
            quality: 50
        })
            .toBuffer();
    }
    else if ('image' in lib && lib.image?.Transformer) {
        // AunuBaileys (P2e port from v6): @napi-rs/image backend, same
        // loader-order reasoning as extractImageThumb above.
        img = new lib.image.Transformer(buffer).resize(w, h, 0).jpeg(50);
    }
    else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'function') {
        const jimp = await lib.jimp.Jimp.read(buffer);
        const min = Math.min(jimp.width, jimp.height);
        const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min });
        img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 });
    }
    else {
        throw new Boom('No image processing library available');
    }
    return {
        img: await img
    };
};
/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message) => {
    const media = Object.values(message)[0];
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64');
};
export async function getAudioDuration(buffer) {
    let musicMetadata;
    try {
        //@ts-ignore — optional peer: may be absent at build time
        musicMetadata = (await import('music-metadata'));
    }
    catch {
        return undefined;
    }
    let metadata;
    const options = {
        duration: true
    };
    if (Buffer.isBuffer(buffer)) {
        metadata = await musicMetadata.parseBuffer(buffer, undefined, options);
    }
    else if (typeof buffer === 'string') {
        metadata = await musicMetadata.parseFile(buffer, options);
    }
    else {
        metadata = await musicMetadata.parseStream(buffer, undefined, options);
    }
    return metadata.format.duration;
}
/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer, logger) {
    try {
        // @ts-ignore
        const { default: decoder } = await import('audio-decode');
        let audioData;
        if (Buffer.isBuffer(buffer)) {
            audioData = buffer;
        }
        else if (typeof buffer === 'string') {
            const rStream = createReadStream(buffer);
            audioData = await toBuffer(rStream);
        }
        else {
            audioData = await toBuffer(buffer);
        }
        const audioBuffer = await decoder(audioData);
        const rawData = audioBuffer.getChannelData(0); // We only need to work with one channel of data
        const samples = 64; // Number of samples we want to have in our final data set
        const blockSize = Math.floor(rawData.length / samples); // the number of samples in each subdivision
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
            const blockStart = blockSize * i; // the location of the first sample in the block
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum = sum + Math.abs(rawData[blockStart + j]); // find the sum of all the samples in the block
            }
            filteredData.push(sum / blockSize); // divide the sum by the block size to get the average
        }
        // This guarantees that the largest data point will be set to 1, and the rest of the data will scale proportionally.
        const multiplier = Math.pow(Math.max(...filteredData), -1);
        const normalizedData = filteredData.map(n => n * multiplier);
        // Generate waveform like WhatsApp
        const waveform = new Uint8Array(normalizedData.map(n => Math.floor(100 * n)));
        return waveform;
    }
    catch (e) {
        logger?.debug('Failed to generate waveform: ' + e);
    }
}
export const toReadable = (buffer) => {
    const readable = new Readable({ read: () => { } });
    readable.push(buffer);
    readable.push(null);
    return readable;
};
export const toBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    stream.destroy();
    return Buffer.concat(chunks);
};
// AunuBaileys (1.0.85, HB-219, re-applied P3b): bounds for the remote fetch in
// generateProfilePicture (16 MiB matches the product-image cap).
const MAX_PROFILE_PICTURE_SOURCE_BYTES = 16 * 1024 * 1024;
export const toBufferWithLimit = async (stream, maxBytes) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes) {
            stream.destroy();
            throw new Boom(`content length exceeded ${maxBytes} bytes`, { statusCode: 413 });
        }
        chunks.push(chunk);
    }
    stream.destroy();
    return Buffer.concat(chunks);
};
export const getStream = async (item, opts) => {
    if (Buffer.isBuffer(item)) {
        return { stream: toReadable(item), type: 'buffer' };
    }
    // AunuBaileys (1.0.85, HB-208, re-applied P3b): unusable media used to
    // explode here as raw TypeErrors — 'stream' in undefined/null for a
    // missing media value, a toString deref for an object with no usable
    // url, a createReadStream type error for a numeric url. Reject all of
    // them with a clear Boom 400 instead.
    if (!item || typeof item !== 'object') {
        throw new Boom('Invalid media: expected a Buffer, a stream, or an object with a url', { statusCode: 400 });
    }
    if ('stream' in item) {
        // AunuBaileys (2.3.0, HB-208 addendum): the guard only tested
        // that the key EXISTS — {stream: null/42/{}} (and even a bare
        // string, whose characters were silently encrypted as media)
        // passed and exploded downstream as raw TypeErrors. Only a
        // real readable (async-iterable) stream is usable.
        const candidate = item.stream;
        const isUsableStream = candidate instanceof Readable ||
            (!!candidate &&
                typeof candidate === 'object' &&
                typeof candidate[Symbol.asyncIterator] === 'function');
        if (!isUsableStream) {
            throw new Boom('Invalid media: "stream" must be a readable stream', { statusCode: 400 });
        }
        return { stream: candidate, type: 'readable' };
    }
    if (typeof item.url !== 'string' && !(item.url instanceof URL)) {
        throw new Boom('Invalid media: expected a Buffer, a stream, or an object with a url', { statusCode: 400 });
    }
    // AunuBaileys (2.3.0, HB-208 addendum): a URL object with a
    // non-file/non-http scheme (e.g. ftp:) fell through to
    // createReadStream and threw a raw TypeError about the scheme.
    if (item.url instanceof URL && !['http:', 'https:', 'data:', 'file:'].includes(item.url.protocol)) {
        throw new Boom(`Invalid media URL scheme: ${item.url.protocol}`, { statusCode: 400 });
    }
    if (typeof item.url === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(item.url)) {
        const scheme = item.url.slice(0, item.url.indexOf(':') + 1).toLowerCase();
        if (!['http:', 'https:', 'data:', 'file:'].includes(scheme)) {
            throw new Boom(`Invalid media URL scheme: ${scheme}`, { statusCode: 400 });
        }
    }
    const urlStr = item.url.toString();
    if (urlStr.startsWith('data:')) {
        // AunuBaileys (HB-292, donor v6 HB-32): a data URL without the
        // comma separator used to explode as a raw TypeError from
        // Buffer.from(undefined) — reject it like the other unusable
        // media shapes above, with a Boom 400.
        const comma = urlStr.indexOf(',');
        if (comma === -1) {
            throw new Boom('Invalid data URL: missing comma separator', { statusCode: 400 });
        }
        const buffer = Buffer.from(urlStr.slice(comma + 1), 'base64');
        return { stream: toReadable(buffer), type: 'buffer' };
    }
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
        return { stream: await getHttpStream(item.url, opts), type: 'remote' };
    }
    return { stream: createReadStream(item.url), type: 'file' };
};
/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(file, mediaType, options) {
    let thumbnail;
    let originalImageDimensions;
    if (mediaType === 'image') {
        const { buffer, original } = await extractImageThumb(file);
        thumbnail = buffer.toString('base64');
        if (original.width && original.height) {
            originalImageDimensions = {
                width: original.width,
                height: original.height
            };
        }
    }
    else if (mediaType === 'video') {
        const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg');
        try {
            await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 });
            const buff = await fs.readFile(imgFilename);
            thumbnail = buff.toString('base64');
        }
        catch (err) {
            options.logger?.debug('could not generate video thumb: ' + err);
        }
        finally {
            // AunuBaileys (2.2.0, HB-2026-1112-10 addendum, remaining
            // facet): the unlink used to sit after readFile inside the
            // try — a readFile failure after a successful ffmpeg run
            // leaked the .jpg. Cleanup belongs in finally.
            await fs.unlink(imgFilename).catch(() => { });
        }
    }
    return {
        thumbnail,
        originalImageDimensions
    };
}
export const getHttpStream = async (url, options = {}) => {
    let response;
    try {
        response = await fetch(url.toString(), {
            dispatcher: options.dispatcher,
            method: 'GET',
            headers: options.headers,
            signal: options.signal
        });
    }
    catch (error) {
        // AunuBaileys (2.3.0, HB-392): a fired timeout signal used to
        // surface as a raw DOMException TimeoutError (no statusCode);
        // hosts branch on Boom status codes, so translate it here.
        if (isMediaAbortError(error)) {
            throw new Boom(`Media download timed out fetching ${url}`, { statusCode: 408, data: { url } });
        }
        throw error;
    }
    if (!response.ok) {
        throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } });
    }
    // AunuBaileys (2.3.0, HB-384): 204/205 responses carry a null
    // body — Readable.fromWeb(null) threw a raw TypeError with no
    // statusCode. Fail with a Boom instead; the real status rides
    // in `data` because Boom status codes must be >= 400.
    if (!response.body) {
        throw new Boom(`Failed to fetch stream from ${url}: empty response body`, {
            statusCode: 502,
            data: { url, status: response.status }
        });
    }
    // @ts-ignore Node18+ Readable.fromWeb exists
    return response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
};
// AunuBaileys (1.0.71, restored 2.0.5 HB-331): streaming sidecar —
// WhatsApp Web's seekable-play sidecar for video/audio: HMAC-SHA256
// (macKey), truncated to 10 bytes, over each 64 KiB window of
// iv+ciphertext+mac, with the last 16 bytes of the previous window
// prepended, so a recipient can verify and play a range without the
// whole file. Only attached when the container is streamable — a
// non-faststart mp4 (mdat before moov) must not advertise seekability,
// or the recipient's player fails instead of falling back to a plain
// download. The v6 implementation was lost in the v7 rebase; this is
// a faithful port.
const AUNU_SIDECAR_CHUNK_SIZE = 65536;
const AUNU_SIDECAR_HMAC_SIZE = 10;
const AUNU_SIDECAR_IV_SIZE = 16;
const AUNU_SIDECAR_SCAN_MAX_BYTES = 1024;
const AUNU_SIDECAR_MEDIA_TYPES = new Set(['video', 'audio', 'ptt', 'gif']);
const aunuReadU32 = (bytes, offset) => (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
/**
 * Walks the top-level ISO-BMFF boxes (mp4/mov/3gp/m4a) in the leading
 * bytes. Streamable only when `moov` precedes `mdat`; non-ISO-BMFF
 * payloads (ogg/opus voice notes) are streamable. Returns true / false,
 * or null while the head is too short to decide.
 */
export const aunuScanStreamable = (head) => {
    if (head.length < 8) {
        return null;
    }
    if (aunuReadU32(head, 4) !== 0x66747970 /* ftyp */) {
        return true;
    }
    let offset = 0;
    while (offset + 8 <= head.length) {
        const type = aunuReadU32(head, offset + 4);
        if (type === 0x6d6f6f76 /* moov */) {
            return true;
        }
        if (type === 0x6d646174 /* mdat */) {
            return false;
        }
        let size = aunuReadU32(head, offset);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > head.length) {
                return null;
            }
            if (aunuReadU32(head, offset + 8) !== 0) {
                return true;
            }
            size = aunuReadU32(head, offset + 12);
            headerSize = 16;
        }
        else if (size === 0) {
            return true;
        }
        if (size < headerSize) {
            return true;
        }
        offset += size;
        if (offset > AUNU_SIDECAR_SCAN_MAX_BYTES) {
            return true;
        }
    }
    return offset > AUNU_SIDECAR_SCAN_MAX_BYTES ? true : null;
};
class AunuSidecarAccumulator {
    constructor(macKey) {
        this.windowOffset = 0;
        this.totalPushed = 0;
        this.nextChunkStart = 0;
        this.digests = [];
        this.macKey = macKey;
        this.window = Buffer.alloc(AUNU_SIDECAR_IV_SIZE + AUNU_SIDECAR_CHUNK_SIZE);
    }
    push(data) {
        let srcOffset = 0;
        while (srcOffset < data.length) {
            const windowEnd = this.nextChunkStart + AUNU_SIDECAR_IV_SIZE + AUNU_SIDECAR_CHUNK_SIZE;
            const toCopy = Math.min(windowEnd - this.totalPushed, data.length - srcOffset);
            this.window.set(data.subarray(srcOffset, srcOffset + toCopy), this.windowOffset);
            this.windowOffset += toCopy;
            this.totalPushed += toCopy;
            srcOffset += toCopy;
            if (this.totalPushed === windowEnd) {
                this.flushChunk();
            }
        }
    }
    finish() {
        if (this.windowOffset > 0) {
            this.flushChunk();
        }
        return Buffer.concat(this.digests);
    }
    flushChunk() {
        const digest = Crypto.createHmac('sha256', this.macKey).update(this.window.subarray(0, this.windowOffset)).digest();
        this.digests.push(digest.subarray(0, AUNU_SIDECAR_HMAC_SIZE));
        this.nextChunkStart += AUNU_SIDECAR_CHUNK_SIZE;
        this.window.copyWithin(0, this.windowOffset - AUNU_SIDECAR_IV_SIZE, this.windowOffset);
        this.windowOffset = AUNU_SIDECAR_IV_SIZE;
    }
}
export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey } = {}) => {
    const { stream, type } = await getStream(media, opts);
    logger?.debug('fetched media stream');
    // AunuBaileys (P2e port from v6): a caller-supplied 32-byte mediaKey used
    // to be silently dropped and replaced with a random one — the
    // sticker-pack thumbnail was then encrypted under an unrecorded key.
    const mediaKey = providedMediaKey?.length === 32 ? Buffer.from(providedMediaKey) : Crypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);
    const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc');
    const encFileWriteStream = createWriteStream(encFilePath);
    let originalFileStream;
    let originalFilePath;
    if (saveOriginalFileIfRequired) {
        originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original');
        originalFileStream = createWriteStream(originalFilePath);
    }
    // AunuBaileys (HB-273, P4): persistent 'error' listeners on BOTH
    // write streams — see getRawMediaUploadData above. During the
    // chunk loop below, the only 'error' coverage used to be the
    // transient once('drain') awaits; an open/write failure in
    // between (ENOSPC, tmpdir removed) escaped as an uncaught 'error'
    // event and crashed the process. Capture the first error, race
    // every drain-wait against it, and throw it into the catch after
    // the loop.
    let writeError;
    let rejectWriteError = () => { };
    const writeErrorPromise = new Promise((_resolve, reject) => {
        rejectWriteError = reject;
    });
    writeErrorPromise.catch(() => { });
    const captureWriteError = (err) => {
        if (!writeError) {
            writeError = err;
            rejectWriteError(err);
        }
    };
    encFileWriteStream.on('error', captureWriteError);
    originalFileStream?.on('error', captureWriteError);
    let fileLength = 0;
    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const hmac = Crypto.createHmac('sha256', macKey).update(iv);
    const sha256Plain = Crypto.createHash('sha256');
    const sha256Enc = Crypto.createHash('sha256');
    const sidecar = AUNU_SIDECAR_MEDIA_TYPES.has(mediaType) ? new AunuSidecarAccumulator(macKey) : undefined;
    sidecar?.push(iv);
    let streamableVerdict = sidecar ? null : false;
    let head = Buffer.alloc(0);
    const onChunk = async (buff) => {
        sha256Enc.update(buff);
        hmac.update(buff);
        sidecar?.push(buff);
        // Handle backpressure: if write returns false, wait for drain
        if (!encFileWriteStream.write(buff)) {
            await Promise.race([once(encFileWriteStream, 'drain'), writeErrorPromise]);
        }
    };
    try {
        for await (const data of stream) {
            // AunuBaileys (1.0.72, HB-88, re-applied P3b): the cap
            // check used to run AFTER the increment while still
            // adding data.length — the current chunk was counted
            // twice, so the effective cap was one chunk below the
            // configured one and legitimate media just under the
            // cap was rejected. Check first, like
            // getRawMediaUploadData does.
            if (type === 'remote' &&
                opts?.maxContentLength &&
                fileLength + data.length > opts.maxContentLength) {
                throw new Boom(`content length exceeded when encrypting "${type}"`, {
                    data: { media, type }
                });
            }
            fileLength += data.length;
            if (originalFileStream) {
                if (!originalFileStream.write(data)) {
                    await Promise.race([once(originalFileStream, 'drain'), writeErrorPromise]);
                }
            }
            if (streamableVerdict === null) {
                // AunuBaileys (1.0.85, HB-220): the scan only ever
                // reads the leading ~1 KiB (it decides from box
                // headers/sizes in that prefix and forces a verdict
                // past AUNU_SIDECAR_SCAN_MAX_BYTES), but the WHOLE
                // chunk used to be concatenated into `head` and held
                // for the entire call — and for Buffer input the
                // whole media arrives as ONE chunk, so `head` was a
                // full second copy of the media. Retain only the
                // prefix the scan can consume; its verdicts are
                // unchanged.
                // AunuBaileys (2.2.0, HB-220 addendum): subarray is a
                // VIEW — for Buffer input the concat backing store is
                // the whole media, and the view kept it alive for the
                // entire call (the 1.0.85 fix only worked for streams).
                // Buffer.from copies just the retained prefix and
                // releases the backing store. (Buffer.slice would not
                // help — it is a view too.)
                head = Buffer.from(Buffer.concat([head, data]).subarray(0, AUNU_SIDECAR_SCAN_MAX_BYTES + 32));
                streamableVerdict = aunuScanStreamable(head);
                if (streamableVerdict === null && head.length > AUNU_SIDECAR_SCAN_MAX_BYTES) {
                    streamableVerdict = true;
                }
            }
            sha256Plain.update(data);
            await onChunk(aes.update(data));
        }
        // HB-273: a write failure captured during the loop aborts the
        // encrypt here, before the finish-wait below.
        if (writeError) {
            throw writeError;
        }
        await onChunk(aes.final());
        const mac = hmac.digest().slice(0, 10);
        sha256Enc.update(mac);
        sidecar?.push(mac);
        // HB-331: a non-faststart mp4 (mdat before moov) must not
        // advertise seekability — see aunuScanStreamable.
        const streamingSidecar = sidecar && streamableVerdict !== false ? sidecar.finish() : undefined;
        const fileSha256 = sha256Plain.digest();
        const fileEncSha256 = sha256Enc.digest();
        encFileWriteStream.write(mac);
        // HB-273: an already-failed stream never emits 'finish' — do
        // not wait on it.
        if (writeError) {
            throw writeError;
        }
        const encFinishPromise = once(encFileWriteStream, 'finish');
        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();
        encFileWriteStream.end();
        originalFileStream?.end?.();
        // AunuBaileys (2.3.0, HB-208 addendum): an async-iterable
        // stream without destroy() must not fail a finished encrypt.
        destroyQuietly(stream);
        // Wait for write streams to fully flush to disk
        // This helps reduce memory pressure by allowing OS to release buffers
        await encFinishPromise;
        await originalFinishPromise;
        logger?.debug('encrypted data successfully');
        return {
            mediaKey,
            originalFilePath,
            encFilePath,
            mac,
            fileEncSha256,
            fileSha256,
            fileLength,
            streamingSidecar
        };
    }
    catch (error) {
        // destroy all streams with error
        // AunuBaileys (2.3.0, HB-208 addendum): every destroy here is
        // quiet — a throwing destroy (e.g. an unusable input stream)
        // used to escape before the unlink below, leaking the tmp
        // files this catch exists to clean up.
        destroyQuietly(encFileWriteStream);
        destroyQuietly(originalFileStream);
        destroyQuietly(aes);
        destroyQuietly(hmac);
        destroyQuietly(sha256Plain);
        destroyQuietly(sha256Enc);
        destroyQuietly(stream);
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) {
                await fs.unlink(originalFilePath);
            }
        }
        catch (err) {
            logger?.error({ err }, 'failed deleting tmp files');
        }
        throw error;
    }
};
export const DEF_MEDIA_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
const toSmallestChunkSize = (num) => {
    return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
};
export const getUrlFromDirectPath = (directPath, host = DEF_MEDIA_HOST) => {
    // AunuBaileys (2.2.0, HB-2026-1112-114 addendum): directPath is
    // peer-controlled and was concatenated raw — a value starting
    // with '@' smuggles a whole new authority into the URL
    // (https://host@attacker/…), bypassing the media-host allowlist
    // that guards the `url` path below. A genuine directPath always
    // starts with '/'; anything else is refused here, at the one
    // construction site every caller shares.
    if (!directPath.startsWith('/')) {
        throw new Boom('Refusing to build a media URL from a malformed directPath (SSRF guard)', { statusCode: 400 });
    }
    return `https://${host}${directPath}`;
};
// Some media messages (stickers, voice notes, images) carry a `url` on `a.whatsapp.net`,
// which doesn't resolve. Their `directPath` is valid, so it must go to the default host.
const PLACEHOLDER_MEDIA_HOST = 'a.whatsapp.net';
// AunuBaileys (HB-114, re-applied P3): the media-host allowlist.
const WA_MEDIA_HOST_SUFFIXES = ['.whatsapp.net', '.fbcdn.net'];
const isWAMediaHost = (hostname) => !!hostname &&
    hostname !== PLACEHOLDER_MEDIA_HOST &&
    (hostname === 'whatsapp.net' || hostname === 'fbcdn.net' || WA_MEDIA_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix)));
const extractHost = (url) => {
    if (!url)
        return undefined;
    try {
        const host = new URL(url).host;
        return host === PLACEHOLDER_MEDIA_HOST ? undefined : host;
    }
    catch {
        return undefined;
    }
};
export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    // AunuBaileys (1.0.76, HB-114, re-applied P3): WhatsApp media is
    // only ever served from WhatsApp/Facebook CDN hosts. Upstream v7
    // already rebuilds the path from directPath and excludes the
    // a.whatsapp.net placeholder host \u2014 but it still honours ANY
    // host parsed from the sender-supplied `url` as the fallback, and
    // uses `url` verbatim when there is no directPath: a sender could
    // make the host GET an arbitrary https host (SSRF). Allowlist the
    // host: a non-WA host is never fetched \u2014 with a directPath we
    // fall back to the canonical media host (the path is globally
    // valid there); without one the download is refused.
    const rawHost = opts.host ?? extractHost(url);
    const fallbackHost = rawHost && isWAMediaHost(rawHost) ? rawHost : DEF_MEDIA_HOST;
    let downloadUrl;
    if (directPath) {
        downloadUrl = getUrlFromDirectPath(directPath, fallbackHost);
    }
    else if (url) {
        let urlHost;
        try {
            urlHost = new URL(url).hostname;
        }
        catch { }
        if (!isWAMediaHost(urlHost)) {
            throw new Boom('Refusing to download media from a non-WhatsApp host (SSRF guard)', { statusCode: 400 });
        }
        downloadUrl = url;
    }
    if (!downloadUrl) {
        throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 });
    }
    const keys = await getMediaKeys(mediaKey, type);
    return downloadEncryptedContent(downloadUrl, keys, opts);
};
/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv, macKey }, { startByte, endByte, options } = {}) => {
    let bytesFetched = 0;
    let startChunk = 0;
    let firstBlockIsIV = false;
    // if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0);
        if (chunk) {
            startChunk = chunk - AES_CHUNK_SIZE;
            bytesFetched = chunk;
            firstBlockIsIV = true;
        }
    }
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
    const headersInit = options?.headers ? options.headers : undefined;
    const headers = {
        ...(headersInit
            ? Array.isArray(headersInit)
                ? Object.fromEntries(headersInit)
                : headersInit
            : {}),
        Origin: DEFAULT_ORIGIN
    };
    if (startChunk || endChunk) {
        headers.Range = `bytes=${startChunk}-`;
        if (endChunk) {
            headers.Range += endChunk;
        }
    }
    // download the message
    const fetched = await getHttpStream(downloadUrl, {
        ...(options || {}),
        headers
    });
    let remainingBytes = Buffer.from([]);
    let aes;
    // AunuBaileys (1.0.76, HB-115, re-applied P3): the media MAC used
    // to be verified ONLY on the encrypt/upload path \u2014 a full
    // download was decrypted and handed to the consumer with no
    // integrity check at all. For FULL downloads (no byte range) with
    // a macKey available, verify it streaming: HMAC every ciphertext
    // byte except a held-back final 10, compare in final() with
    // timingSafeEqual. Ranged downloads fetch a slice that excludes
    // the MAC \u2014 they skip verification, exactly as in v6.
    const verifyMac = !!macKey && !startByte && !endByte;
    const macHmac = verifyMac ? Crypto.createHmac('sha256', macKey).update(iv) : null;
    let macTail = Buffer.alloc(0);
    const feedMac = (chunk) => {
        if (!macHmac) {
            return;
        }
        const joined = macTail.length ? Buffer.concat([macTail, chunk]) : chunk;
        if (joined.length > 10) {
            macHmac.update(joined.subarray(0, joined.length - 10));
            macTail = Buffer.from(joined.subarray(joined.length - 10));
        }
        else {
            macTail = Buffer.from(joined);
        }
    };
    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            // AunuBaileys (1.0.74, HB-96, re-applied P3b): with a
            // startByte but NO endByte, `endByte - bytesFetched` was
            // NaN and every chunk sliced to zero bytes (a silent
            // empty download). No endByte means "to the end of the
            // stream": end stays undefined. (When endByte IS set, an
            // end past this chunk clamps inside slice() exactly
            // like undefined did.)
            const end = endByte == null ? undefined : Math.max(endByte - bytesFetched, 0);
            push(bytes.slice(start, end));
            bytesFetched += bytes.length;
        }
        else {
            push(bytes);
        }
    };
    const output = new Transform({
        transform(chunk, _, callback) {
            feedMac(chunk);
            let data = remainingBytes.length ? Buffer.concat([remainingBytes, chunk]) : chunk;
            const decryptLength = toSmallestChunkSize(data.length);
            remainingBytes = data.slice(decryptLength);
            data = data.slice(0, decryptLength);
            if (!aes) {
                // AunuBaileys (1.0.85, HB-114/HB-158, re-applied P3b):
                // on the ranged path the IV is carved out of the first
                // 16 bytes of the body — when the first chunk(s) total
                // less than that, there is nothing to build a decipher
                // from yet. createDecipheriv used to sit OUTSIDE the
                // try below and threw a bare "Invalid initialization
                // vector" TypeError for exactly that download. Wait for
                // more bytes instead (a <16-byte slice means
                // decryptLength was 0, so everything is still in
                // remainingBytes), and keep the construction inside a
                // try so any failure surfaces as a proper stream error.
                if (firstBlockIsIV && data.length < AES_CHUNK_SIZE) {
                    callback();
                    return;
                }
                try {
                    let ivValue = iv;
                    if (firstBlockIsIV) {
                        ivValue = data.slice(0, AES_CHUNK_SIZE);
                        data = data.slice(AES_CHUNK_SIZE);
                    }
                    aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
                    // if an end byte that is not EOF is specified
                    // stop auto padding (PKCS7) -- otherwise throws an error for decryption
                    if (endByte) {
                        aes.setAutoPadding(false);
                    }
                }
                catch (error) {
                    callback(error);
                    return;
                }
            }
            try {
                pushBytes(aes.update(data), b => this.push(b));
                callback();
            }
            catch (error) {
                callback(error);
            }
        },
        final(callback) {
            // AunuBaileys (HB-290, donor v6 HB-12): a 200 response with
            // zero chunks leaves `aes` undefined, so final() threw a
            // bare TypeError. Fail with a meaningful error instead.
            if (!aes) {
                callback(new Boom('Empty media download: server returned no data to decrypt', { statusCode: 502 }));
                return;
            }
            try {
                pushBytes(aes.final(), b => this.push(b));
            }
            catch (error) {
                callback(error);
                return;
            }
            // AunuBaileys (HB-115, re-applied P3): reject tampered or
            // truncated media \u2014 the trailing 10 bytes must equal the
            // truncated HMAC over (iv + ciphertext).
            if (macHmac) {
                const expectedMac = macHmac.digest().subarray(0, 10);
                if (macTail.length !== 10 || !Crypto.timingSafeEqual(Buffer.from(macTail), expectedMac)) {
                    callback(new Boom('Downloaded media failed HMAC integrity verification \u2014 the file was tampered with or truncated in transit; refusing it', { statusCode: 400 }));
                    return;
                }
            }
            callback();
        }
    });
    // AunuBaileys (HB-289, donor v6 HB-52): stream.pipe() does NOT
    // forward source errors to the destination — a CDN drop
    // mid-download left the source 'error' unhandled (crashing the
    // process) and the consumer hanging forever. Destroy the
    // Transform with the source error instead.
    fetched.on('error', err => output.destroy(err));
    // AunuBaileys (2.2.0, HB-352): the reverse direction was open —
    // when the consumer destroys the returned stream, the CDN source
    // kept downloading in the background. Closing the output (for
    // any reason) now tears the source down with it.
    output.on('close', () => fetched.destroy());
    return fetched.pipe(output, { end: true });
};
export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype?.split(';')[0]?.split('/')[1];
    // AunuBaileys (HB-293, donor v6 HB-33 + 1.0.71 extension): the
    // media-content object itself can be undefined/null
    // ({imageMessage: undefined}, {}) — guard that too, not just the
    // mimetype deref.
    if (!message || typeof message !== 'object') {
        return undefined;
    }
    const type = Object.keys(message)[0];
    let extension;
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
        extension = '.jpeg';
    }
    else {
        const messageContent = message[type];
        extension = getExtension(messageContent?.mimetype);
    }
    return extension;
}
const isNodeRuntime = () => {
    return (typeof process !== 'undefined' &&
        process.versions?.node !== null &&
        typeof process.versions.bun === 'undefined' &&
        typeof globalThis.Deno === 'undefined');
};
// AunuBaileys (2.1.0, HB-302): cap for one media-upload response body.
const MAX_UPLOAD_RESPONSE_BYTES = 1048576;
export const uploadWithNodeHttp = async ({ url, filePath, headers, timeoutMs, agent }, redirectCount = 0) => {
    if (redirectCount > 5) {
        throw new Error('Too many redirects');
    }
    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === 'https:' ? await import('https') : await import('http');
    // Get file size for Content-Length header (required for Node.js streaming)
    const fileStats = await fs.stat(filePath);
    const fileSize = fileStats.size;
    return new Promise((resolve, reject) => {
        // AunuBaileys (2.3.0, HB-372): the request deadline used to be
        // created BEFORE `req`/`stream` existed — when
        // httpModule.request() threw synchronously (bad agent type,
        // invalid header characters, …) the promise rejected cleanly
        // but the orphaned timer later fired into the TDZ of both
        // consts and crashed the process with a ReferenceError. The
        // stream and request are created first now, a synchronous
        // throw rejects with no timer outstanding, and the deadline
        // is only armed once both exist.
        const stream = createReadStream(filePath);
        let req;
        try {
            req = httpModule.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Length': fileSize
                },
                agent,
                timeout: timeoutMs
            }, res => {
                clearTimeout(requestDeadline);
                // AunuBaileys (2.1.0, HB-302): the response body used to accumulate without a cap and without error/close handlers — a trickling response hung the upload forever and grew memory without bound. Cap the body, fail on error/close, and bound the whole response phase by a total deadline (the socket timeout above only fires on inactivity).
                let body = '';
                let bodyBytes = 0;
                let settled = false;
                const deadline = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        res.destroy();
                        reject(new Boom('Media upload response timed out', { statusCode: 408 }));
                    }
                }, timeoutMs || 120000);
                const settle = (fn) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(deadline);
                    fn();
                };
                // Handle redirects (3xx)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // Consume response to free resources
                    // AunuBaileys (2.2.0, HB-351 addendum): the recursive
                    // call opens its own stream — destroy this attempt's
                    // file stream or its fd leaks on every redirect.
                    stream.destroy();
                    clearTimeout(deadline);
                    const newUrl = new URL(res.headers.location, url).toString();
                    resolve(uploadWithNodeHttp({
                        url: newUrl,
                        filePath,
                        headers,
                        timeoutMs,
                        agent
                    }, redirectCount + 1));
                    return;
                }
                res.on('data', chunk => {
                    body += chunk;
                    bodyBytes += chunk.length;
                    if (bodyBytes > MAX_UPLOAD_RESPONSE_BYTES) {
                        settle(() => {
                            res.destroy();
                            reject(new Boom('Media upload response exceeded the size limit', { statusCode: 502 }));
                        });
                    }
                });
                res.on('error', err => settle(() => reject(err)));
                res.on('close', () => settle(() => reject(new Boom('Media upload response closed before completing', { statusCode: 502 }))));
                res.on('end', () => settle(() => {
                    try {
                        resolve(JSON.parse(body));
                    }
                    catch {
                        resolve(undefined);
                    }
                }));
            });
        }
        catch (err) {
            // AunuBaileys (2.3.0, HB-372): synchronous request()
            // failure — no deadline exists yet, just clean up.
            stream.destroy();
            reject(err);
            return;
        }
        // AunuBaileys (2.2.0, HB-302 addendum): the response phase got
        // its total deadline in 2.1.0, but the REQUEST phase (sending
        // the body to a stalling host) was bounded only by the socket
        // inactivity timeout. One deadline now covers the send phase;
        // it is cleared the moment a response starts (the response
        // phase then runs under its own deadline below).
        const requestDeadline = setTimeout(() => {
            stream.destroy();
            req.destroy();
            reject(new Boom('Media upload timed out', { statusCode: 408 }));
        }, timeoutMs || 120000);
        requestDeadline.unref?.();
        // AunuBaileys (2.2.0, HB-351): a failed or timed-out request
        // used to leave the file stream open — one leaked fd per
        // failed upload, accumulating until the process ran dry.
        // Every settle path now destroys the source stream too.
        req.on('error', err => {
            clearTimeout(requestDeadline);
            stream.destroy();
            reject(err);
        });
        req.on('timeout', () => {
            clearTimeout(requestDeadline);
            stream.destroy();
            req.destroy();
            reject(new Error('Upload timeout'));
        });
        stream.pipe(req);
        stream.on('error', err => {
            clearTimeout(requestDeadline);
            req.destroy();
            reject(err);
        });
    });
};
const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }) => {
    // Convert Node.js Readable to Web ReadableStream
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);
    // Native fetch only accepts Undici-style dispatchers, not generic https Agents.
    const dispatcher = typeof agent?.dispatch === 'function' ? agent : undefined;
    const response = await fetch(url, {
        ...(dispatcher ? { dispatcher } : {}),
        method: 'POST',
        body: webStream,
        headers,
        duplex: 'half',
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
    // AunuBaileys (2.1.0, HB-302): same response-body cap as uploadWithNodeHttp — response.json() used to buffer the whole body unbounded. Read through a reader so the cap is enforced while streaming.
    const reader = response.body?.getReader();
    if (!reader) {
        return undefined;
    }
    const decoder = new TextDecoder();
    let text = '';
    let receivedBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            receivedBytes += value.byteLength;
            if (receivedBytes > MAX_UPLOAD_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Boom('Media upload response exceeded the size limit', { statusCode: 502 });
            }
            text += decoder.decode(value, { stream: true });
        }
    }
    text += decoder.decode();
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
/**
 * Uploads media to WhatsApp servers.
 *
 * ## Why we have two upload implementations:
 *
 * Node.js's native `fetch` (powered by undici) has a known bug where it buffers
 * the entire request body in memory before sending, even when using streams.
 * This causes memory issues with large files (e.g., 1GB file = 1GB+ memory usage).
 * See: https://github.com/nodejs/undici/issues/4058
 *
 * Other runtimes (Bun, Deno, browsers) correctly stream the request body without
 * buffering, so we can use the web-standard Fetch API there.
 *
 * ## Future considerations:
 * Once the undici bug is fixed, we can simplify this to use only the Fetch API
 * across all runtimes. Monitor the GitHub issue for updates.
 */
const uploadMedia = async (params, logger) => {
    if (isNodeRuntime()) {
        logger?.debug('Using Node.js https module for upload (avoids undici buffering bug)');
        return uploadWithNodeHttp(params);
    }
    else {
        logger?.debug('Using web-standard Fetch API for upload');
        return uploadWithFetch(params);
    }
};
// AunuBaileys (1.0.85, HB-127, re-applied P3b): default ceiling for
// one media-upload POST.
const MEDIA_UPLOAD_DEFAULT_TIMEOUT_MS = 120000;
export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
        // AunuBaileys (1.0.85, HB-127, re-applied P3b): timeoutMs used to
        // be a pure pass-through of the host's mediaUploadTimeoutMs,
        // with no default anywhere — an upload host that black-holes
        // the connection (accepts TCP, never speaks) left the POST, and
        // with it prepareWAMessageMedia -> sendMessage, pending
        // FOREVER. Sanitise at the boundary: a finite positive value
        // is honored, anything else gets the default.
        const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : MEDIA_UPLOAD_DEFAULT_TIMEOUT_MS;
        // send a query JSON to obtain the url & auth token to upload our media
        let uploadInfo = await refreshMediaConn(false);
        let urls;
        const hosts = [...customUploadHosts, ...uploadInfo.hosts];
        // AunuBaileys (2.2.0, HB-366 + HB-137 facet 1): after a media
        // connection refresh, the FRESH hosts join the itinerary —
        // previously the refresh result was used only for its auth
        // token while the loop kept knocking on the stale host list
        // (and the catch path never refreshed at all). Hosts already
        // listed are not re-added, so every host is tried at most once
        // per refresh generation.
        const addFreshHosts = () => {
            for (const freshHost of uploadInfo.hosts) {
                if (!hosts.some(h => h.hostname === freshHost.hostname)) {
                    hosts.push(freshHost);
                }
            }
        };
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
        // Prepare common headers
        const customHeaders = (() => {
            const hdrs = options?.headers;
            if (!hdrs)
                return {};
            return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : hdrs;
        })();
        const headers = {
            ...customHeaders,
            'Content-Type': 'application/octet-stream',
            Origin: DEFAULT_ORIGIN
        };
        for (const { hostname } of hosts) {
            logger.debug(`uploading to "${hostname}"`);
            const auth = encodeURIComponent(uploadInfo.auth);
            const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
            let result;
            try {
                result = await uploadMedia({
                    url,
                    filePath,
                    headers,
                    timeoutMs: effectiveTimeoutMs,
                    agent: fetchAgent
                }, logger);
                if (result?.url || result?.direct_path) {
                    urls = {
                        mediaUrl: result.url,
                        directPath: result.direct_path,
                        meta_hmac: result.meta_hmac,
                        fbid: result.fbid,
                        ts: result.ts
                    };
                    break;
                }
                else {
                    uploadInfo = await refreshMediaConn(true);
                    addFreshHosts();
                    throw new Error(`upload failed, reason: ${JSON.stringify(result)}`);
                }
            }
            catch (error) {
                // HB-137 facet 1: a thrown attempt refreshes too, so the
                // iterations that follow can reach the fresh hosts.
                try {
                    uploadInfo = await refreshMediaConn(true);
                    addFreshHosts();
                }
                catch { }
                const isLast = hostname === hosts[hosts.length - 1]?.hostname;
                logger.warn({ trace: error?.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`);
            }
        }
        if (!urls) {
            throw new Boom('Media upload failed on all hosts', { statusCode: 500 });
        }
        return urls;
    };
};
const getMediaRetryKey = (mediaKey) => {
    return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });
};
/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export const encryptMediaRetryRequest = (key, mediaKey, meId) => {
    const recp = { stanzaId: key.id };
    const recpBuffer = waproto.ServerErrorReceipt.encode(recp).finish();
    const iv = Crypto.randomBytes(12);
    const retryKey = getMediaRetryKey(mediaKey);
    const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id));
    const req = {
        tag: 'receipt',
        attrs: {
            id: key.id,
            to: jidNormalizedUser(meId),
            type: 'server-error'
        },
        content: [
            // this encrypt node is actually pretty useless
            // the media is returned even without this node
            // keeping it here to maintain parity with WA Web
            {
                tag: 'encrypt',
                attrs: {},
                content: [
                    { tag: 'enc_p', attrs: {}, content: ciphertext },
                    { tag: 'enc_iv', attrs: {}, content: iv }
                ]
            },
            {
                tag: 'rmr',
                attrs: {
                    jid: key.remoteJid,
                    from_me: (!!key.fromMe).toString(),
                    // @ts-ignore
                    participant: key.participant || undefined
                }
            }
        ]
    };
    return req;
};
export const decodeMediaRetryNode = (node) => {
    const rmrNode = getBinaryNodeChild(node, 'rmr');
    // AunuBaileys (HB-291, donor v6 HB-11): a mediaretry receipt
    // without an <rmr> child used to throw here, silently stalling
    // the re-upload flow.
    if (!rmrNode) {
        return null;
    }
    const event = {
        key: {
            id: node.attrs.id,
            remoteJid: rmrNode.attrs.jid,
            fromMe: rmrNode.attrs.from_me === 'true',
            participant: rmrNode.attrs.participant
        }
    };
    const errorNode = getBinaryNodeChild(node, 'error');
    if (errorNode) {
        const errorCode = +errorNode.attrs.code;
        event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
            data: errorNode.attrs,
            statusCode: getStatusCodeForMediaRetry(errorCode)
        });
    }
    else {
        const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt');
        const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p');
        const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv');
        if (ciphertext && iv) {
            event.media = { ciphertext, iv };
        }
        else {
            event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 });
        }
    }
    return event;
};
export const decryptMediaRetryData = ({ ciphertext, iv }, mediaKey, msgId) => {
    const retryKey = getMediaRetryKey(mediaKey);
    const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));
    return waproto.MediaRetryNotification.decode(plaintext);
};
export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];
const MEDIA_RETRY_STATUS_MAP = {
    [waproto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [waproto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [waproto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [waproto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};
//# sourceMappingURL=messages-media.js.map