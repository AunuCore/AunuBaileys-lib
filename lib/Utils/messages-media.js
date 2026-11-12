import { Boom } from '@hapi/boom';
import axios, {} from 'axios';
import { spawn } from 'child_process';
import * as Crypto from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_ORIGIN, NEWSLETTER_MEDIA_PATH_MAP, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js';
import { generateMessageIDV2 } from './generics.js';
const getTmpFilesDirectory = () => tmpdir();
export const getImageProcessingLibrary = async () => {
    //@ts-ignore
    const [jimp, sharp, image] = await Promise.all([import('jimp').catch(() => { }), import('sharp').catch(() => { }), import('@napi-rs/image').catch(() => { })]);
    if (sharp) {
        return { sharp };
    }
    // AunuBaileys: backend @napi-rs/image (dari @itsliaaa/baileys) — di atas jimp
    if (image) {
        return { image };
    }
    if (jimp) {
        return { jimp };
    }
    throw new Boom('No image processing library available');
};
export const hkdfInfoKey = (type) => {
    const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type];
    return `WhatsApp ${hkdfInfo} Keys`;
};
export const getRawMediaUploadData = async (media, mediaType, logger, opts) => {
    const { stream } = await getStream(media);
    logger?.debug('got stream for raw upload');
    const hasher = Crypto.createHash('sha256');
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
    const fileWriteStream = createWriteStream(filePath);
    let fileLength = 0;
    try {
        for await (const data of stream) {
            // AunuBaileys (1.0.71): the newsletter raw path never
            // received the opts channel, so maxContentLength was
            // ignored here while the regular (encrypted) path enforced
            // it — a remote URL could fill the disk unchecked.
            if (opts?.maxContentLength && fileLength + data.length > opts.maxContentLength) {
                throw new Boom(`content length exceeded when fetching raw media`, {
                    data: { media, mediaType }
                });
            }
            fileLength += data.length;
            hasher.update(data);
            if (!fileWriteStream.write(data)) {
                await once(fileWriteStream, 'drain');
            }
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
        fileWriteStream.destroy();
        stream.destroy();
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
    const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80)
    };
}
/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (path, destPath, time, size) => new Promise((resolve, reject) => {
    // AunuBaileys: spawn dengan array argumen, tanpa shell (dari @itsliaaa/baileys) —
    // path/waktu/ukuran tidak lagi diinterpolasi ke string perintah shell
    const ffmpeg = spawn('ffmpeg', [
        '-ss', String(time),
        '-i', path,
        '-y',
        '-vf', `scale=${size.width}:-1`,
        '-vframes', '1',
        '-f', 'image2',
        destPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks = [];
    ffmpeg.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
        if (code === 0) {
            resolve();
        }
        else {
            reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
        }
    });
});
export const extractImageThumb = async (bufferOrFilePath, width = 32, maxBytes) => {
    // TODO: Move entirely to sharp, removing jimp as it supports readable streams
    // This will have positive speed and performance impacts as well as minimizing RAM usage.
    if (bufferOrFilePath instanceof Readable) {
        // AunuBaileys (1.0.72): callers fetching a REMOTE stream (link
        // previews) pass a cap — the whole stream used to be buffered
        // in memory, and an endless stream was never aborted (HB-89).
        bufferOrFilePath = maxBytes ? await toBufferWithLimit(bufferOrFilePath, maxBytes) : await toBuffer(bufferOrFilePath);
    }
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
        // AunuBaileys: backend @napi-rs/image
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
    else if ('jimp' in lib && (typeof lib.jimp?.Jimp === 'object' || typeof lib.jimp?.Jimp === 'function')) {
        // AunuBaileys: jimp v1 mengekspos Jimp sebagai class (function), bukan object
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
        const { stream } = await getStream(mediaUpload);
        // Convert the resulting stream to a buffer
        buffer = await toBuffer(stream);
    }
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
        // AunuBaileys: backend @napi-rs/image
        img = new lib.image.Transformer(buffer).resize(w, h, 0).jpeg(50);
    }
    else if ('jimp' in lib && (typeof lib.jimp?.Jimp === 'object' || typeof lib.jimp?.Jimp === 'function')) {
        // AunuBaileys: jimp v1 mengekspos Jimp sebagai class (function), bukan object
        const jimp = await lib.jimp.Jimp.read(buffer);
        const min = Math.min(jimp.width, jimp.height);
        // AunuBaileys: crop dari TENGAH (sebelumnya pojok kiri-atas memotong subjek)
        const cropped = jimp.crop({ x: Math.floor((jimp.width - min) / 2), y: Math.floor((jimp.height - min) / 2), w: min, h: min });
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
    const musicMetadata = await import('music-metadata');
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
/**
 * AunuBaileys (1.0.72): toBuffer with a hard byte cap — the stream is
 * destroyed and a Boom thrown as soon as the cap is exceeded, instead
 * of accumulating an unbounded remote stream in memory first and
 * checking afterwards (HB-76/87/89).
 */
export const toBufferWithLimit = async (stream, maxBytes) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) {
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
    if ('stream' in item) {
        return { stream: item.stream, type: 'readable' };
    }
    const urlStr = item.url.toString();
    if (urlStr.startsWith('data:')) {
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
            // AunuBaileys (1.0.69): a failed read used to skip the
            // unlink, leaking the full-size frame file in the tmpdir.
            await fs.unlink(imgFilename).catch(() => { });
        }
    }
    return {
        thumbnail,
        originalImageDimensions
    };
}
export const getHttpStream = async (url, options = {}) => {
    const fetched = await axios.get(url.toString(), { ...options, responseType: 'stream' });
    return fetched.data;
};
// AunuBaileys (1.0.71): streaming sidecar — WhatsApp Web's seekable-play
// sidecar for video/audio: HMAC-SHA256(macKey), truncated to 10 bytes,
// over each 64 KiB window of iv+ciphertext+mac, with the last 16 bytes of
// the previous window prepended, so a recipient can verify and play a
// range without the whole file. Only attached when the container is
// streamable — a non-faststart mp4 (mdat before moov) must not advertise
// seekability, or the recipient's player fails instead of falling back
// to a plain download.
const AUNU_SIDECAR_CHUNK_SIZE = 65536;
const AUNU_SIDECAR_HMAC_SIZE = 10;
const AUNU_SIDECAR_IV_SIZE = 16;
const AUNU_SIDECAR_SCAN_MAX_BYTES = 1024;
const AUNU_SIDECAR_MEDIA_TYPES = new Set(['video', 'audio', 'ptt', 'gif']);
const aunuReadU32 = (bytes, offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
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
        this.macKey = macKey;
        this.window = Buffer.alloc(AUNU_SIDECAR_IV_SIZE + AUNU_SIDECAR_CHUNK_SIZE);
        this.windowOffset = 0;
        this.totalPushed = 0;
        this.nextChunkStart = 0;
        this.digests = [];
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
    // AunuBaileys (1.0.69): a caller-supplied 32-byte mediaKey used to
    // be silently dropped and replaced with a random one — the
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
        // AunuBaileys (1.0.69): the encrypted write used to ignore
        // backpressure, buffering unbounded memory on large media or a
        // slow tmpdir. Await drain like the original-file write below.
        sha256Enc.update(buff);
        hmac.update(buff);
        sidecar?.push(buff);
        if (!encFileWriteStream.write(buff)) {
            await once(encFileWriteStream, 'drain');
        }
    };
    try {
        for await (const data of stream) {
            // AunuBaileys (1.0.72): the cap check used to run AFTER the
            // increment while still adding data.length — the current
            // chunk was counted twice, so the effective cap was one
            // chunk below the configured one and legitimate media just
            // under the cap was rejected (HB-88). Check first, like
            // getRawMediaUploadData does.
            if (type === 'remote' && opts?.maxContentLength && fileLength + data.length > opts.maxContentLength) {
                throw new Boom(`content length exceeded when encrypting "${type}"`, {
                    data: { media, type }
                });
            }
            fileLength += data.length;
            if (originalFileStream) {
                if (!originalFileStream.write(data)) {
                    await once(originalFileStream, 'drain');
                }
            }
            if (streamableVerdict === null) {
                head = Buffer.concat([head, data]);
                streamableVerdict = aunuScanStreamable(head);
                if (streamableVerdict === null && head.length > AUNU_SIDECAR_SCAN_MAX_BYTES) {
                    streamableVerdict = true;
                }
            }
            sha256Plain.update(data);
            await onChunk(aes.update(data));
        }
        await onChunk(aes.final());
        const mac = hmac.digest().slice(0, 10);
        sha256Enc.update(mac);
        sidecar?.push(mac);
        // AunuBaileys (1.0.71): a non-faststart mp4 (mdat before moov)
        // must not advertise seekability — see aunuScanStreamable.
        const streamingSidecar = sidecar && streamableVerdict !== false ? sidecar.finish() : undefined;
        const fileSha256 = sha256Plain.digest();
        const fileEncSha256 = sha256Enc.digest();
        encFileWriteStream.write(mac);
        encFileWriteStream.end();
        originalFileStream?.end?.();
        // AunuBaileys (1.0.69): end() used to return before the tmp
        // file flushed, so the uploader could read a truncated
        // ciphertext. Wait for both streams to finish first.
        await once(encFileWriteStream, 'finish');
        if (originalFileStream) {
            await once(originalFileStream, 'finish');
        }
        stream.destroy();
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
        encFileWriteStream.destroy();
        originalFileStream?.destroy?.();
        aes.destroy();
        hmac.destroy();
        sha256Plain.destroy();
        sha256Enc.destroy();
        stream.destroy();
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
const DEF_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
const toSmallestChunkSize = (num) => {
    return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
};
export const getUrlFromDirectPath = (directPath, fallbackHost) => `https://${fallbackHost || DEF_HOST}${directPath}`;
// AunuBaileys (1.0.76): Hunt-ronde-3 — WhatsApp media is only ever served
// from WhatsApp/Facebook CDN hosts. A sender-supplied URL whose host is
// anything else is not a media URL, it is an SSRF attempt (the bot would
// happily GET an internal https host with the sender's directPath glued
// on). Non-WA hosts are never fetched: with a directPath we fall back to
// the canonical media host (the path is globally valid there); without
// one the download is refused.
const WA_MEDIA_HOST_SUFFIXES = ['.whatsapp.net', '.fbcdn.net'];
const isWAMediaHost = (hostname) => !!hostname &&
    (hostname === 'whatsapp.net' || hostname === 'fbcdn.net' ||
        WA_MEDIA_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)));
export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    // AunuBaileys (1.0.69): the sender-supplied URL used to be trusted
    // verbatim (host + path) — a remote peer could trigger a GET to an
    // arbitrary https host. Like upstream v7, only the host is taken
    // from the URL; the path is rebuilt from our own directPath.
    // AunuBaileys (1.0.76): the host is now ALSO allowlisted (above) —
    // a non-WA host falls back to mmg.whatsapp.net instead of being fetched.
    let downloadUrl;
    if (directPath) {
        let host;
        try {
            host = new URL(url || '').hostname || undefined;
        }
        catch { }
        if (!isWAMediaHost(host)) {
            host = undefined;
        }
        downloadUrl = getUrlFromDirectPath(directPath, host);
    }
    else {
        let parsed;
        try {
            parsed = new URL(url || '');
        }
        catch { }
        downloadUrl = parsed?.protocol === 'https:' && isWAMediaHost(parsed.hostname) ? url : undefined;
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
    const headers = {
        ...(options?.headers || {}),
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
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    let remainingBytes = Buffer.from([]);
    let aes;
    // AunuBaileys (1.0.76): Hunt-ronde-3 — the downloaded ciphertext used
    // to be decrypted with NO integrity check: the 10-byte HMAC-SHA256
    // (macKey, iv || ciphertext) that WhatsApp appends to every media
    // file was silently dropped with the trailing partial block, so a
    // tampering server/CDN could alter media undetected (AES-CBC padding
    // only catches damage to the final block). For FULL downloads (no
    // byte range) with a macKey available, verify it: HMAC every
    // ciphertext byte except a held-back final 10, compare in final().
    // Ranged downloads fetch a slice that excludes the MAC — they skip
    // verification, exactly like before. Consumers of the stream still
    // receive plaintext progressively, but a failed check errors the
    // stream in final(), so buffered consumers (downloadMediaMessage
    // 'buffer') discard the content wholesale.
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
            macTail = joined.subarray(joined.length - 10);
        }
        else {
            macTail = joined;
        }
    };
    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            // AunuBaileys (1.0.74): HB-96 — with a startByte but NO
            // endByte, `endByte - bytesFetched` was NaN and every chunk
            // sliced to zero bytes (a silent empty download). No
            // endByte means "to the end of the stream": end stays
            // undefined. (When endByte IS set, an end past this chunk
            // clamps inside slice() exactly like undefined did.)
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
            let data = Buffer.concat([remainingBytes, chunk]);
            const decryptLength = toSmallestChunkSize(data.length);
            remainingBytes = data.slice(decryptLength);
            data = data.slice(0, decryptLength);
            if (!aes) {
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
            try {
                pushBytes(aes.update(data), b => this.push(b));
                callback();
            }
            catch (error) {
                callback(error);
            }
        },
        final(callback) {
            // AunuBaileys (1.0.69): a 200 response with zero chunks left
            // `aes` undefined, so final() threw a bare TypeError. Fail
            // with a meaningful error instead.
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
            if (macHmac) {
                const expectedMac = macHmac.digest().subarray(0, 10);
                if (macTail.length !== 10 || !Crypto.timingSafeEqual(Buffer.from(macTail), expectedMac)) {
                    callback(new Boom('Downloaded media failed HMAC integrity verification — the file was tampered with or truncated in transit; refusing it', { statusCode: 400 }));
                    return;
                }
            }
            callback();
        }
    });
    // AunuBaileys (1.0.71): stream.pipe() does NOT forward source
    // errors to the destination — a CDN drop mid-download left the
    // source 'error' unhandled and crashed the process. Destroy the
    // Transform with the source error so the consumer sees it instead.
    fetched.on('error', (err) => output.destroy(err));
    return fetched.pipe(output, { end: true });
};
export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype?.split(';')[0]?.split('/')[1];
    // AunuBaileys (1.0.71): 1.0.69 guarded the mimetype deref, but the
    // media-content object itself could still be undefined/null
    // ({imageMessage: undefined}, {}) — guard that too.
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
export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs, newsletter }) => {
        // send a query JSON to obtain the url & auth token to upload our media
        let uploadInfo = await refreshMediaConn(false);
        let urls;
        const hosts = [...customUploadHosts, ...uploadInfo.hosts];
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
        for (const { hostname } of hosts) {
            logger.debug(`uploading to "${hostname}"`);
            const auth = encodeURIComponent(uploadInfo.auth); // the auth token
            const mediaPathMap = newsletter ? NEWSLETTER_MEDIA_PATH_MAP : MEDIA_PATH_MAP;
            let url = `https://${hostname}${mediaPathMap[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
            if (newsletter) {
                url += '&server_thumb_gen=1';
                if (mediaType === 'video' || mediaType === 'gif' || mediaType === 'ptv') {
                    url += '&server_transcode=1';
                }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let result;
            try {
                const body = await axios.post(url, createReadStream(filePath), {
                    ...options,
                    maxRedirects: 0,
                    headers: {
                        ...(options.headers || {}),
                        'Content-Type': 'application/octet-stream',
                        Origin: DEFAULT_ORIGIN
                    },
                    httpsAgent: fetchAgent,
                    timeout: timeoutMs,
                    responseType: 'json',
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                });
                result = body.data;
                if (result?.url || result?.directPath) {
                    urls = {
                        mediaUrl: result.url,
                        directPath: result.direct_path
                    };
                    break;
                }
                else {
                    uploadInfo = await refreshMediaConn(true);
                    throw new Error(`upload failed, reason: ${JSON.stringify(result)}`);
                }
            }
            catch (error) {
                if (axios.isAxiosError(error)) {
                    result = error.response?.data;
                }
                const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname;
                logger.warn({ trace: error.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`);
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
export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
    const recp = { stanzaId: key.id };
    const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish();
    const iv = Crypto.randomBytes(12);
    const retryKey = await getMediaRetryKey(mediaKey);
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
    // AunuBaileys (1.0.69): a mediaretry receipt without an <rmr>
    // child used to throw here, silently stalling the re-upload flow.
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
export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => {
    const retryKey = await getMediaRetryKey(mediaKey);
    const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));
    return proto.MediaRetryNotification.decode(plaintext);
};
export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];
const MEDIA_RETRY_STATUS_MAP = {
    [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};
/**
 * AunuBaileys: tulis metadata EXIF stiker (nama pack, penerbit, emoji) ke
 * buffer WebP — format chunk EXIF standar ekosistem WhatsApp (header TIFF
 * mini + JSON metadata). Chunk EXIF lama diganti, bukan ditumpuk. Mengikuti
 * gagasan @itsliaaa/starseal; implementasi orisinal di sini.
 */
export const addStickerExif = (webpBuffer, metadata = {}) => {
    if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 12 ||
        webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('addStickerExif: input bukan buffer WebP (RIFF) yang valid');
    }
    const json = {
        'sticker-pack-id': metadata.packId || 'aunubaileys',
        'sticker-pack-name': metadata.packname || '',
        'sticker-pack-publisher': metadata.author || '',
        'emojis': Array.isArray(metadata.emojis) ? metadata.emojis : ['🖤'],
        ...(metadata.categories ? { 'categories': metadata.categories } : {})
    };
    const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
    const header = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    header.writeUInt32LE(jsonBytes.length, 14);
    const exifPayload = Buffer.concat([header, jsonBytes]);
    // pisahkan chunk-chunk RIFF yang ada (selain EXIF lama)
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= webpBuffer.length) {
        const type = webpBuffer.toString('ascii', offset, offset + 4);
        const size = webpBuffer.readUInt32LE(offset + 4);
        const total = 8 + size + (size % 2);
        if (type !== 'EXIF') {
            chunks.push(webpBuffer.subarray(offset, offset + total));
        }
        offset += total;
    }
    const exifChunk = Buffer.alloc(8 + exifPayload.length + (exifPayload.length % 2));
    exifChunk.write('EXIF', 0, 'ascii');
    exifChunk.writeUInt32LE(exifPayload.length, 4);
    exifPayload.copy(exifChunk, 8);
    const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks, exifChunk]);
    const out = Buffer.alloc(8 + body.length);
    out.write('RIFF', 0, 'ascii');
    out.writeUInt32LE(body.length, 4);
    body.copy(out, 8);
    return out;
};
//# sourceMappingURL=messages-media.js.map