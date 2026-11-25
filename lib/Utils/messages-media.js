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
// AunuBaileys (2.6.0, HB-392 addendum 2): Node timers are 32-bit —
// a finite value above 2^31-1 ms overflowed to ~1 ms, so a host
// that configured a huge mediaUploadTimeoutMs failed every media
// send instantly. Clamp to the largest usable timeout.
const MAX_TIMEOUT_MS = 2147483647;
export const sanitizeMediaTimeoutMs = (value, fallback = 120000) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TIMEOUT_MS) : fallback;
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
// AunuBaileys (2.6.0, HB-208 addendum situs ke-4): a host stream
// may yield string chunks (fs.createReadStream with an encoding,
// Readable.from([...strings])) — every consumer below assumes
// Buffer chunks (Buffer.concat, data.length as bytes). Normalise
// at this one choke point: strings become UTF-8 Buffers (the same
// encoding hasher.update(string) already used), Uint8Arrays become
// Buffers, anything else is a Boom 400 instead of a raw TypeError.
export const asMediaBufferChunk = (chunk) => {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk);
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk);
    }
    throw new Boom('Invalid media stream: chunks must be Buffers', { statusCode: 400 });
};
// AunuBaileys (2.6.0, HB-392 addendum run-0613): an abort that
// fires mid-body used to surface as a raw DOMException
// TimeoutError from the iteration loops below — the HB-392 fix
// only translated the fetch() call itself. Translate it at the
// rethrow, so hosts that branch on Boom status codes see 408.
const toMediaTimeoutBoom = (error) => isMediaAbortError(error)
    ? new Boom('Media download timed out while reading the response body', { statusCode: 408 })
    : error;
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
// still does not know (anything outside PNG/GIF/JPEG/WebP/BMP/
// TIFF/AVIF/HEIC) keep the old behaviour (decode decides).
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
        for await (const rawChunk of stream) {
            // AunuBaileys (2.6.0, HB-208 addendum situs ke-4): a
            // string chunk counts characters in data.length, not
            // bytes — normalise before counting, hashing or writing.
            const data = asMediaBufferChunk(rawChunk);
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
        // AunuBaileys (2.6.0, HB-208 addendum run-0655): a bare
        // async-iterable stream has no destroy() — the bare call
        // threw here AFTER the whole file was read, failing a
        // finished upload.
        destroyQuietly(stream);
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
        throw toMediaTimeoutBoom(error);
    }
};
/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(buffer, mediaType) {
    if (!buffer) {
        throw new Boom('Cannot derive from empty media key');
    }
    if (typeof buffer === 'string') {
        // AunuBaileys (2.7.0, HB-482): only the literal 'data:;base64,'
        // used to be stripped — a standard data:<mediatype>;base64,
        // URL was decoded whole, prefix included, deriving garbage
        // keys. Strip any data:*;base64, prefix.
        buffer = Buffer.from(buffer.replace(/^data:[^,]*;base64,/, ''), 'base64');
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
// AunuBaileys (2.7.0, HB-487 + addendum): host-supplied image
// dimensions used to flow straight into sharp / @napi-rs/image /
// jimp — 0, negative, NaN, fractional or absurd values threw raw
// library errors, and a huge-but-valid thumb width upscaled
// without bound. Validate at the boundary: positive integers
// within a sane cap, otherwise Boom 400.
const MAX_PROFILE_PICTURE_DIMENSION = 4096;
const MAX_THUMBNAIL_WIDTH = 1024;
const assertValidImageDimension = (value, name, max) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
        throw new Boom(`Invalid image ${name}: expected an integer between 1 and ${max}`, { statusCode: 400 });
    }
};
export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    assertValidImageDimension(width, 'thumbnail width', MAX_THUMBNAIL_WIDTH);
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
    else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'function') {
        // AunuBaileys (2.6.0, HB-468): the guard used to read
        // === 'object' — jimp exports Jimp as a function (class),
        // so this branch was dead and jimp-only hosts got a bogus
        // 'No image processing library available'. Mirrors the
        // generateProfilePicture guard below.
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
    assertValidImageDimension(w, 'width', MAX_PROFILE_PICTURE_DIMENSION);
    assertValidImageDimension(h, 'height', MAX_PROFILE_PICTURE_DIMENSION);
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
    try {
        for await (const rawChunk of stream) {
            chunks.push(asMediaBufferChunk(rawChunk));
        }
    }
    catch (error) {
        // AunuBaileys (2.6.0, HB-208 addendum run-0655): the bare
        // stream.destroy() below threw for a bare async-iterable
        // (no destroy method) AFTER the whole stream was read.
        destroyQuietly(stream);
        throw toMediaTimeoutBoom(error);
    }
    // AunuBaileys (2.6.0, HB-208 addendum run-0655): see above.
    destroyQuietly(stream);
    return Buffer.concat(chunks);
};
// AunuBaileys (1.0.85, HB-219, re-applied P3b): bounds for the remote fetch in
// generateProfilePicture (16 MiB matches the product-image cap).
const MAX_PROFILE_PICTURE_SOURCE_BYTES = 16 * 1024 * 1024;
export const toBufferWithLimit = async (stream, maxBytes) => {
    const chunks = [];
    let size = 0;
    try {
        for await (const rawChunk of stream) {
            const chunk = asMediaBufferChunk(rawChunk);
            size += chunk.length;
            if (size > maxBytes) {
                destroyQuietly(stream);
                throw new Boom(`content length exceeded ${maxBytes} bytes`, { statusCode: 413 });
            }
            chunks.push(chunk);
        }
    }
    catch (error) {
        // AunuBaileys (2.6.0, HB-208 addendum run-0655): both bare
        // stream.destroy() calls here threw for a bare
        // async-iterable AFTER the bytes were read — the limit
        // throw and the success path alike.
        destroyQuietly(stream);
        throw toMediaTimeoutBoom(error);
    }
    // AunuBaileys (2.6.0, HB-208 addendum run-0655): see above.
    destroyQuietly(stream);
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
    // AunuBaileys (2.6.0, HB-423 + addendum): dispatch on the
    // NORMALISED string — trim leading/trailing whitespace and
    // lowercase the scheme before comparing. The validator above
    // accepts uppercase schemes and file:, but the old dispatch
    // compared case-sensitively and had no file: branch, so a valid
    // 'HTTP://…', 'DATA:…' or 'file:///…' string fell through to
    // createReadStream and died with a misleading ENOENT — and a
    // string with leading whitespace (' https://…') failed the
    // same way, since it matched no branch at all.
    const urlStr = typeof item.url === 'string' ? item.url.trim() : item.url.toString();
    const lowerUrlStr = urlStr.toLowerCase();
    if (typeof item.url === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
        const scheme = urlStr.slice(0, urlStr.indexOf(':') + 1).toLowerCase();
        if (!['http:', 'https:', 'data:', 'file:'].includes(scheme)) {
            throw new Boom(`Invalid media URL scheme: ${scheme}`, { statusCode: 400 });
        }
    }
    if (lowerUrlStr.startsWith('data:')) {
        // AunuBaileys (HB-292, donor v6 HB-32): a data URL without the
        // comma separator used to explode as a raw TypeError from
        // Buffer.from(undefined) — reject it like the other unusable
        // media shapes above, with a Boom 400.
        const comma = urlStr.indexOf(',');
        if (comma === -1) {
            throw new Boom('Invalid data URL: missing comma separator', { statusCode: 400 });
        }
        // AunuBaileys (2.6.0, HB-2026-1112-32 addendum 2):
        // Buffer.from is lenient — it silently drops characters
        // outside the base64 alphabet and truncates a payload whose
        // length is not a multiple of 4, so a corrupt data URL used
        // to "succeed" as 0-byte media. Require strict canonical
        // base64 first: alphabet + '=' padding only at the end,
        // total length a multiple of 4, non-empty.
        const payload = urlStr.slice(comma + 1);
        if (payload.length === 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
            throw new Boom('Invalid data URL: payload is not valid base64', { statusCode: 400 });
        }
        const buffer = Buffer.from(payload, 'base64');
        return { stream: toReadable(buffer), type: 'buffer' };
    }
    if (lowerUrlStr.startsWith('http://') || lowerUrlStr.startsWith('https://')) {
        return { stream: await getHttpStream(urlStr, opts), type: 'remote' };
    }
    if (lowerUrlStr.startsWith('file:')) {
        // AunuBaileys (2.6.0, HB-423 / HB-208 addendum run-0819):
        // a file: string used to fall through to createReadStream
        // as a literal path ('file:///tmp/x' → ENOENT), while the
        // same URL as a URL object worked. Parse it and read the
        // file it names instead.
        let fileUrl;
        try {
            fileUrl = new URL(urlStr);
        }
        catch {
            throw new Boom(`Invalid media file URL: ${urlStr}`, { statusCode: 400 });
        }
        return { stream: createReadStream(fileUrl), type: 'file' };
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
// AunuBaileys (2.6.0, HB-417/HB-466): downloadEncryptedContent
// must validate the ranged response (206 + Content-Range) and the
// redirect target — but getHttpStream used to return only the body
// stream and throw the status/headers away. This variant returns
// them alongside the stream; getHttpStream below stays the
// stream-only shape its callers expect.
export const getHttpStreamResponse = async (url, options = {}) => {
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
    const stream = response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
    return { stream, status: response.status, headers: response.headers, url: response.url };
};
export const getHttpStream = async (url, options = {}) => {
    return (await getHttpStreamResponse(url, options)).stream;
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
        for await (const rawChunk of stream) {
            // AunuBaileys (2.6.0, HB-208 addendum situs ke-4): a
            // string chunk counts characters in data.length, not
            // bytes — normalise before the cap check, the file
            // length, the hashes and the sidecar scan.
            const data = asMediaBufferChunk(rawChunk);
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
                // AunuBaileys (2.6.0, HB-220 addendum 2): the line
                // below still ran Buffer.concat([head, data]) FIRST
                // and sliced after — for Buffer input that allocated
                // one full transient copy of the media per send.
                // Only concat the prefix the scan can still use;
                // concat itself copies, so no backing store is kept.
                const headCapacity = AUNU_SIDECAR_SCAN_MAX_BYTES + 32;
                if (head.length < headCapacity) {
                    head = Buffer.concat([head, data.subarray(0, headCapacity - head.length)]);
                }
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
        throw toMediaTimeoutBoom(error);
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
    // AunuBaileys (2.7.0, HB-2026-1112-96 facet 2 + facet 3): a
    // negative or NaN endByte used to be accepted silently — no
    // Range header was sent, the 206 check was skipped and the
    // download resolved as a silent 0-byte success (NaN < 0 is
    // false, so a lone `< 0` guard cannot close this; a string
    // 'abc' slipped through the same way). A negative startByte,
    // by contrast, already failed hard. Validate both bounds
    // symmetrically before any fetch.
    if (startByte != null && (typeof startByte !== 'number' || !Number.isFinite(startByte) || startByte < 0)) {
        throw new Boom('Invalid media download range: startByte must be a finite number >= 0', { statusCode: 400 });
    }
    if (endByte != null && (typeof endByte !== 'number' || !Number.isFinite(endByte) || endByte < 0)) {
        throw new Boom('Invalid media download range: endByte must be a finite number >= 0', { statusCode: 400 });
    }
    if (startByte != null && endByte != null && endByte < startByte) {
        throw new Boom('Invalid media download range: endByte must be >= startByte', { statusCode: 400 });
    }
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
    // AunuBaileys (2.6.0, HB-2026-1112-96 addendum run-0921):
    // endByte: 0 used to be treated as "absent" — the truthiness
    // check below made endChunk undefined, so no Range header was
    // sent at all and a 0-byte range silently returned the WHOLE
    // file. A 0 endByte is a real bound: test for null, not truth.
    const endChunk = endByte != null ? toSmallestChunkSize(endByte) + AES_CHUNK_SIZE : undefined;
    const headersInit = options?.headers ? options.headers : undefined;
    const headers = {
        ...(headersInit
            ? Array.isArray(headersInit)
                ? Object.fromEntries(headersInit)
                : headersInit
            : {}),
        Origin: DEFAULT_ORIGIN
    };
    const rangeRequested = Boolean(startChunk || endChunk);
    if (rangeRequested) {
        headers.Range = `bytes=${startChunk}-`;
        if (endChunk) {
            headers.Range += endChunk;
        }
    }
    // download the message
    // AunuBaileys (2.6.0, HB-417/HB-466/HB-465): the ranged response
    // is validated below — status, Content-Range and redirect
    // target — so the stream (not just the body) is fetched here.
    const { stream: fetched, status: responseStatus, headers: responseHeaders, url: finalUrl } = await getHttpStreamResponse(downloadUrl, {
        ...(options || {}),
        headers
    });
    // AunuBaileys (2.6.0, HB-465): fetch follows redirects by
    // default — a media host that 302s elsewhere used to hand us
    // an arbitrary host's bytes. Only the WhatsApp media hosts (or
    // a redirect that stays on the origin we asked) may serve the
    // body; anything else is refused before a byte is consumed.
    const initialOrigin = new URL(downloadUrl).origin;
    const finalOrigin = new URL(finalUrl || downloadUrl).origin;
    if (finalOrigin !== initialOrigin && !isWAMediaHost(new URL(finalUrl || downloadUrl).hostname)) {
        fetched.destroy();
        throw new Boom(`Refusing to download media from a redirect target outside the WhatsApp media hosts: ${finalOrigin}`, {
            statusCode: 502
        });
    }
    // AunuBaileys (2.6.0, HB-417/HB-466): a ranged request that
    // comes back as anything but 206 — or a 206 whose Content-Range
    // does not start where the range did — used to be decrypted as
    // if the requested slice had arrived, silently returning bytes
    // from the wrong offset (a host that ignores Range answers 200
    // with the full body; the decryptor then treats the file's
    // first block as the pre-range IV). The decryption below
    // assumes the slice; refuse anything else.
    let promisedCiphertextBytes;
    if (rangeRequested) {
        if (responseStatus !== 206) {
            fetched.destroy();
            throw new Boom(`Media download refused: ranged request answered with HTTP ${responseStatus}, not 206`, { statusCode: 502 });
        }
        const contentRange = responseHeaders.get('content-range');
        const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim()) : null;
        if (!match || Number(match[1]) !== startChunk || Number(match[2]) < Number(match[1])) {
            fetched.destroy();
            throw new Boom('Media download refused: ranged response is missing a valid Content-Range for the requested range', { statusCode: 502 });
        }
        promisedCiphertextBytes = Number(match[2]) - Number(match[1]) + 1;
    }
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
    // AunuBaileys (2.6.0, HB-2026-1112-96 addendum run-0921): the
    // old !endByte test treated endByte: 0 as a full download and
    // ran the whole-file MAC check over a ranged slice.
    const verifyMac = !!macKey && startByte == null && endByte == null;
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
        // AunuBaileys (2.6.0, HB-2026-1112-96 addendum run-0921):
        // the old truthiness gate treated endByte: 0 as "no range"
        // and pushed the whole plaintext. A 0 endByte is a real
        // bound: test for null, not truth.
        if (startByte != null || endByte != null) {
            // A startByte of undefined means "from 0" — say so
            // explicitly instead of relying on NaN slicing to 0.
            const start = startByte == null || bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
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
    // AunuBaileys (2.6.0, HB-417 addendum run-0662): count the
    // ciphertext bytes that actually arrive — a 206 with the right
    // Content-Range can still arrive short (proxy/CDN truncation,
    // clean EOF), and with endByte set there is no padding check
    // and no MAC to catch it. Checked in final() below.
    let ciphertextReceived = 0;
    const output = new Transform({
        transform(chunk, _, callback) {
            ciphertextReceived += chunk.length;
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
                    // AunuBaileys (2.6.0, HB-2026-1112-96 addendum
                    // run-0921): endByte: 0 must disable padding too
                    // — with it on, final() would strip "padding"
                    // from the first plaintext block and could throw
                    // a spurious bad-decrypt on a 0-byte range.
                    if (endByte != null) {
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
            // AunuBaileys (2.6.0, HB-474): PKCS7 unpadding used to run
            // BEFORE the MAC check, and its raw Node crypto error
            // ('bad decrypt') was returned straight to the caller —
            // a truncated or flipped last ciphertext block surfaced
            // as an unclassifiable raw error instead of the Boom 400
            // HMAC failure. Capture the padding error and let the
            // MAC check below have the last word: truncation/flip
            // also fails the MAC, so the caller gets the same Boom
            // 400. Only when there is no MAC to verify (ranged
            // download or no macKey) does the padding error itself
            // become the failure, as a Boom 400. No plaintext leaks
            // either way — a failed final() pushes nothing.
            let paddingError;
            try {
                pushBytes(aes.final(), b => this.push(b));
            }
            catch (error) {
                paddingError = error;
            }
            // AunuBaileys (2.6.0, HB-417 addendum run-0662): refuse
            // a ranged body that delivered fewer ciphertext bytes
            // than its Content-Range promised — the short plaintext
            // used to be returned silently. (Checked against the
            // Content-Range promise, not endByte - startByte: an
            // endByte past EOF legitimately clamps the range, and
            // that clamped length is what the server promised.)
            if (promisedCiphertextBytes !== undefined && ciphertextReceived < promisedCiphertextBytes) {
                callback(new Boom(`Truncated ranged media download: received ${ciphertextReceived} of ${promisedCiphertextBytes} promised bytes`, { statusCode: 502 }));
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
            // AunuBaileys (2.6.0, HB-474): no MAC was available to
            // overrule the padding failure — fail on it, as a Boom 400.
            if (paddingError) {
                callback(new Boom('Downloaded media failed PKCS7 padding verification — the file was tampered with or truncated in transit; refusing it', { statusCode: 400 }));
                return;
            }
            callback();
        }
    });
    // AunuBaileys (HB-289, donor v6 HB-52): stream.pipe() does NOT
    // forward source errors to the destination — a CDN drop
    // mid-download left the source 'error' unhandled (crashing the
    // process) and the consumer hanging forever. Destroy the
    // Transform with the source error instead.
    // AunuBaileys (2.6.0, HB-392 addendum run-0613): translate a
    // mid-body abort to Boom 408 here too — the fetch-phase
    // translation in getHttpStream never sees it.
    fetched.on('error', err => output.destroy(toMediaTimeoutBoom(err)));
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
// AunuBaileys (2.6.0, HB-451/HB-457/HB-465): one resolver for
// every upload redirect, shared by uploadWithNodeHttp and
// uploadWithFetch —
//   * HB-451: a malformed Location used to throw out of `new
//     URL()` inside the async response callback, escaping the
//     promise as an uncaught exception that killed the process.
//     It is a Boom 502 here instead. Non-HTTP(S) targets are
//     refused the same way (the old code followed e.g. ftp:
//     and then POSTed through the http module regardless).
//   * HB-457: a relative (or same-origin) Location used to drop
//     the upload URL's ?auth= + ?token= query — the recursive
//     POST went out unauthenticated. The original query is kept
//     when the target stays on the same origin; a cross-origin
//     target never inherits it.
//   * HB-465: a redirect to a host outside the WhatsApp media
//     hosts is refused outright — the encrypted file must not be
//     POSTed to an arbitrary host.
const resolveUploadRedirectUrl = (location, currentUrl) => {
    let target;
    try {
        target = new URL(location, currentUrl);
    }
    catch {
        throw new Boom(`Refusing to follow malformed upload redirect Location: ${location}`, { statusCode: 502 });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Boom(`Refusing to follow upload redirect to a non-HTTP(S) target: ${target.protocol}`, {
            statusCode: 502
        });
    }
    const current = new URL(currentUrl);
    if (target.origin === current.origin) {
        if (!target.search && current.search) {
            target.search = current.search;
        }
    }
    else if (!isWAMediaHost(target.hostname)) {
        throw new Boom(`Refusing to follow upload redirect to a non-WhatsApp media host: ${target.hostname}`, {
            statusCode: 502
        });
    }
    return target.toString();
};
export const uploadWithNodeHttp = async ({ url, filePath, headers, timeoutMs, agent }, redirectCount = 0) => {
    // AunuBaileys (2.6.0, HB-392 addendum 2): a timeout past the
    // 32-bit timer ceiling overflows Node's setTimeout to ~1 ms —
    // clamp here too, so a direct caller cannot bypass the
    // sanitizeMediaTimeoutMs clamp in getWAUploadToServer.
    if (timeoutMs != null) {
        timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
    }
    if (redirectCount > 5) {
        // AunuBaileys (2.6.0, HB-302 addendum ke-3): the siblings
        // in this function all reject Boom — the redirect cap used
        // to reject a plain Error with no statusCode.
        throw new Boom('Too many redirects', { statusCode: 502 });
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
                    // AunuBaileys (2.6.0, HB-351 addendum 4): the
                    // first attempt's socket + ClientRequest were
                    // never destroyed on redirect — the socket
                    // lingered until the SERVER closed it, unbounded
                    // by timeoutMs. Destroy it next to the file
                    // stream.
                    req.destroy();
                    clearTimeout(deadline);
                    let newUrl;
                    try {
                        newUrl = resolveUploadRedirectUrl(res.headers.location, url);
                    }
                    catch (error) {
                        settle(() => reject(error));
                        return;
                    }
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
            // AunuBaileys (2.6.0, HB-302 addendum run-0790): this
            // socket-timeout handler used to reject a plain Error
            // ('Upload timeout') — and it systematically won the
            // race against the response-phase deadline, so a
            // trickling response never surfaced the Boom 408 the
            // deadline was built for. Reject the same Boom 408.
            reject(new Boom('Media upload timed out', { statusCode: 408 }));
        });
        stream.pipe(req);
        stream.on('error', err => {
            clearTimeout(requestDeadline);
            req.destroy();
            reject(err);
        });
    });
};
export const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }, redirectCount = 0) => {
    // AunuBaileys (2.6.0, HB-392 addendum 2): same clamp as
    // uploadWithNodeHttp — AbortSignal.timeout overflows the same
    // way past the 32-bit ceiling.
    if (timeoutMs != null) {
        timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
    }
    // AunuBaileys (2.6.0, HB-302 addendum ke-3): same redirect cap
    // as uploadWithNodeHttp, same Boom 502.
    if (redirectCount > 5) {
        throw new Boom('Too many redirects', { statusCode: 502 });
    }
    // Convert Node.js Readable to Web ReadableStream
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);
    // Native fetch only accepts Undici-style dispatchers, not generic https Agents.
    const dispatcher = typeof agent?.dispatch === 'function' ? agent : undefined;
    try {
        const response = await fetch(url, {
            ...(dispatcher ? { dispatcher } : {}),
            method: 'POST',
            body: webStream,
            headers,
            duplex: 'half',
            // AunuBaileys (2.6.0, HB-465): fetch follows redirects
            // by default — to an arbitrary host, with the encrypted
            // file re-POSTed (or downgraded to GET) behind our back.
            // Follow them manually through the same resolver as the
            // Node path instead.
            redirect: 'manual',
            signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (location) {
                await response.body?.cancel().catch(() => { });
                return uploadWithFetch({ url: resolveUploadRedirectUrl(location, url), filePath, headers, timeoutMs, agent }, redirectCount + 1);
            }
        }
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
    }
    finally {
        // AunuBaileys (2.6.0, HB-351 addendum 3): the file stream
        // was never destroyed when fetch rejected before consuming
        // the body — one leaked fd per failed attempt, and
        // getWAUploadToServer retries across hosts. Destroy it on
        // every path out (a no-op once the body was fully read).
        nodeStream.destroy();
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
        // AunuBaileys (2.6.0, HB-392 addendum 2): clamp to the
        // 32-bit timer ceiling like sanitizeMediaTimeoutMs does —
        // a huge finite value overflowed to ~1 ms and failed every
        // upload instantly.
        const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
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
        const statusCode = getStatusCodeForMediaRetry(errorCode);
        // AunuBaileys (2.6.0, HB-2026-1112-42 addendum): the map
        // sends ResultType.SUCCESS to 200, and Boom rejects any
        // status below 400 — forwarding it threw 'First argument
        // must be a number (400+): 200' inside processNotification
        // and the messages.media-update event was lost. A SUCCESS
        // code is a success, not an error: skip the Boom and let
        // the key-only update emit. Any other mapped status is
        // >= 400; an unmapped code stays undefined and Boom
        // defaults it to 500, as before.
        if (statusCode === undefined || statusCode >= 400) {
            event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
                data: errorNode.attrs,
                statusCode
            });
        }
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
    // AunuBaileys (2.7.0, HB-427 facet 3): malformed enc_p / enc_iv
    // from a peer's retry notification used to surface as raw Node
    // crypto errors (invalid IV, invalid tag length, auth failure),
    // which updateMediaMessage rethrew verbatim. Its neighbouring
    // guards answer Boom 502 — validate the shape here and wrap
    // the decrypt/decode in the same Boom 502.
    if (!(ciphertext instanceof Uint8Array) ||
        ciphertext.length <= 16 ||
        !(iv instanceof Uint8Array) ||
        iv.length === 0) {
        throw new Boom('Media retry data failed to decrypt', { statusCode: 502 });
    }
    try {
        const retryKey = getMediaRetryKey(mediaKey);
        const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));
        return waproto.MediaRetryNotification.decode(plaintext);
    }
    catch (error) {
        if (error instanceof Boom) {
            throw error;
        }
        throw new Boom('Media retry data failed to decrypt', { statusCode: 502 });
    }
};
export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];
const MEDIA_RETRY_STATUS_MAP = {
    [waproto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [waproto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [waproto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [waproto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};
//# sourceMappingURL=messages-media.js.map