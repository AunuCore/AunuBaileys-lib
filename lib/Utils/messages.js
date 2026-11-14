import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import {} from 'stream';
import { proto } from '../../WAProto/index.js';
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { assertImageWithinPixelLimit, downloadContentFromMessage, encryptedStream, generateThumbnail, getAudioDuration, getAudioWaveform, getImageProcessingLibrary, getRawMediaUploadData, getStream, toBufferWithLimit } from './messages-media.js';
import { shouldIncludeReportingToken } from './reporting-utils.js';
import { prepareRichResponseMessage } from './rich-message-utils.js';
const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
};
const MessageTypeProto = {
    image: WAProto.Message.ImageMessage,
    video: WAProto.Message.VideoMessage,
    audio: WAProto.Message.AudioMessage,
    sticker: WAProto.Message.StickerMessage,
    document: WAProto.Message.DocumentMessage
};
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        }
        catch (error) {
            // ignore if fails
            logger?.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    let assertedColor;
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
    }
    else {
        let hex = color.trim().replace('#', '');
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0');
        }
        assertedColor = parseInt(hex, 16);
        return assertedColor;
    }
};
export const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
        }
    }
    if (!mediaType) {
        throw new Boom('Invalid media type', { statusCode: 400 });
    }
    const uploadData = {
        ...message,
        media: message[mediaType]
    };
    delete uploadData[mediaType];
    // AunuBaileys (1.0.85, HB-208 + addendum, re-applied P3b): reject an
    // unusable media value HERE, before the cacheable-key computation below
    // derefs it — a null media used to explode in that computation itself
    // ('url' in null), and undefined / non-object media as a raw TypeError
    // further down in getStream. Hosts get a clear Boom 400 at the boundary
    // instead. ({} and { url: undefined } pass this check and are rejected
    // by the matching getStream guard.)
    if (typeof uploadData.media !== 'object' || uploadData.media === null) {
        throw new Boom(`Invalid media for "${mediaType}": expected a Buffer, a stream, or an object with a url`, { statusCode: 400 });
    }
    // check if cacheable + generate cache key
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString();
    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file';
    }
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }
    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            const obj = proto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            Object.assign(obj[key], { ...uploadData, media: undefined });
            return obj;
        }
    }
    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter');
        const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger);
        const fileSha256B64 = fileSha256.toString('base64');
        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        });
        await fs.unlink(filePath);
        const obj = WAProto.Message.fromObject({
            // todo: add more support here
            [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined
            })
        });
        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage;
            delete obj.videoMessage;
        }
        if (obj.stickerMessage) {
            obj.stickerMessage.stickerSentTs = Date.now();
        }
        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
        }
        return obj;
    }
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined';
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true;
    // AunuBaileys (1.0.72, HB-74, re-applied P3b): waveform
    // processing consumes the original stream too — without it a
    // ptt URL send could drop the original and produce no waveform.
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation || requiresWaveformProcessing;
    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options
    });
    const fileEncSha256B64 = fileEncSha256.toString('base64');
    const [{ mediaUrl, directPath }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            });
            logger?.debug({ mediaType, cacheableKey }, 'uploaded media');
            return result;
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger?.debug('set dimensions');
                    }
                    logger?.debug('generated thumbnail');
                }
                if (requiresDurationComputation) {
                    uploadData.seconds = await getAudioDuration(originalFilePath);
                    logger?.debug('computed audio duration');
                }
                if (requiresWaveformProcessing) {
                    uploadData.waveform = await getAudioWaveform(originalFilePath, logger);
                    logger?.debug('processed waveform');
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor);
                    logger?.debug('computed backgroundColor audio status');
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })()
    ]).finally(async () => {
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) {
                await fs.unlink(originalFilePath);
            }
            logger?.debug('removed tmp files');
        }
        catch (error) {
            logger?.warn('failed to remove tmp file');
        }
    });
    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
};
export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
    ephemeralExpiration = ephemeralExpiration || 0;
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration
                }
            }
        }
    };
    return WAProto.Message.fromObject(content);
};
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message;
    if (!content) {
        throw new Boom('no content in message', { statusCode: 400 });
    }
    // hacky copy
    content = normalizeMessageContent(content);
    content = proto.Message.decode(proto.Message.encode(content).finish());
    let key = Object.keys(content)[0];
    let score = content?.[key]?.contextInfo?.forwardingScore || 0;
    score += message.key.fromMe && !forceForward ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    const key_ = content?.[key];
    if (score > 0) {
        key_.contextInfo = { forwardingScore: score, isForwarded: true };
    }
    else {
        key_.contextInfo = {};
    }
    return content;
};
export const hasNonNullishProperty = (message, key) => {
    return (typeof message === 'object' &&
        message !== null &&
        key in message &&
        message[key] !== null &&
        message[key] !== undefined);
};
function hasOptionalProperty(obj, key) {
    return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null;
}
// AunuBaileys (1.0.83, HB-254, re-applied P3b): delete / pin / edit each carry a
// message KEY, and WAProto.Message.fromObject silently DROPS a key whose
// value is undefined — so { delete: undefined } used to relay a key-less
// REVOKE (pin and edit likewise) that 'succeeded' but could never take
// effect, because the server had no key to act on. Mirror the pollUpdate
// branch's discipline: the argument must be a real key object carrying a
// message id.
const assertMessageKeyArg = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id) {
        throw new Boom(`"${field}" requires a valid message key (an object with a message id)`, { statusCode: 400 });
    }
};
// AunuBaileys: StickerPack (adapted from neoxr/baileys & @itsliaaa/baileys) —
// P2e port from v6 lib/Utils/messages.js. The v7 tree carried only the proto
// type name; the builder, the send routing and the public content types were
// absent, so `sendMessage(jid, { stickerPack })` fell through to the media
// branch and failed. Validation and limits are v6's, unchanged.
function isWebPBuffer(buffer) {
    return (buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50);
}
function isAnimatedWebP(buffer) {
    if (!isWebPBuffer(buffer)) {
        return false;
    }
    // Parse chunks starting after RIFF header (12 bytes)
    let offset = 12;
    while (offset < buffer.length - 8) {
        const chunkFourCC = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        if (chunkFourCC === 'VP8X') {
            // VP8X extended header, check animation flag (bit 1 at offset+8)
            const flagsOffset = offset + 8;
            if (flagsOffset < buffer.length) {
                const flags = buffer[flagsOffset];
                if (flags & 0x02) {
                    return true;
                }
            }
        }
        else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
            // ANIM or ANMF chunks indicate animation
            return true;
        }
        // Move to next chunk (chunk size + 8 bytes header, padded to even)
        offset += 8 + chunkSize + (chunkSize % 2);
    }
    return false;
}
// Minimal stored (level 0) ZIP writer — v6 used fflate's `zip` with
// `{ level: 0 }` for every entry; the v7 tree carries no zip dependency
// (P2b proved fflate unneeded), so the pack archive is built directly.
// Stored entries keep this byte-compatible with any standard unzipper.
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();
const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
const buildStoredZip = (files) => {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const [fileName, data] of Object.entries(files)) {
        const nameBuf = Buffer.from(fileName, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuf, Buffer.from(data));
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralBuf, end]);
};
export const prepareStickerPackMessage = async (stickerPack, options) => {
    // AunuBaileys (1.0.71): a pack without stickers/cover (or no pack
    // at all) used to throw a raw TypeError from the length/getStream
    // derefs below — fail with a clear Boom instead.
    if (!stickerPack || typeof stickerPack !== 'object') {
        throw new Boom('Invalid sticker pack', { statusCode: 400 });
    }
    const { stickers, name, publisher, packId, description, cover } = stickerPack;
    if (!Array.isArray(stickers) || stickers.length === 0) {
        throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 });
    }
    if (!cover) {
        throw new Boom('Sticker pack requires a cover image', { statusCode: 400 });
    }
    if (stickers.length > 60) {
        throw new Boom('Sticker pack exceeds the maximum limit of 60 stickers', { statusCode: 400 });
    }
    const stickerPackIdValue = packId || generateMessageIDV2();
    // AunuBaileys (1.0.71): the image library is loaded lazily —
    // pure-WebP packs never need it.
    let lib;
    const loadLib = async () => {
        if (!lib) {
            lib = (await getImageProcessingLibrary());
        }
        return lib;
    };
    const stickerData = {};
    const stickerPromises = stickers.map(async (s, i) => {
        try {
            const { stream } = await getStream(s.data);
            // AunuBaileys (1.0.72): cap matches the 1MB post-buffer
            // sticker limit enforced below — a remote sticker URL used
            // to be buffered entirely before that check (HB-76).
            const buffer = await toBufferWithLimit(stream, 1024 * 1024);
            let webpBuffer;
            let isAnimated = false;
            const isWebP = isWebPBuffer(buffer);
            if (isWebP) {
                // Already WebP - preserve original to keep exif metadata and animation
                webpBuffer = buffer;
                isAnimated = isAnimatedWebP(buffer);
            }
            else {
                // AunuBaileys (HB-277, P4): pixel-bomb guard before the
                // conversion decode — the 1 MB cap above bounds bytes,
                // not pixels, and the @napi-rs/image backend decodes a
                // 289 MP raster in full. (A WebP sticker is preserved
                // as-is above and never decoded here.) The throw is
                // caught by this sticker's own try/catch: skip + warn,
                // like any other unconvertible sticker.
                assertImageWithinPixelLimit(buffer, `Sticker at index ${i}`);
                // AunuBaileys (1.0.71): only load the image library when
                // a non-WebP sticker actually needs converting — pure
                // WebP packs used to pay the import cost for nothing.
                const imgLib = await loadLib();
                if ('sharp' in imgLib && imgLib.sharp) {
                    // Convert to WebP, preserving metadata
                    webpBuffer = await imgLib.sharp.default(buffer).webp().toBuffer();
                    // Non-WebP inputs converted to WebP are not animated
                    isAnimated = false;
                }
                else if ('image' in imgLib && imgLib.image?.Transformer) {
                    // AunuBaileys (1.0.85, HB-164): the @napi-rs/image
                    // backend converts to WebP fine (extractImageThumb
                    // already uses it) — the pack path used to ignore
                    // it, so a host with @napi-rs/image but no sharp
                    // failed EVERY non-WebP sticker.
                    webpBuffer = Buffer.from(await new imgLib.image.Transformer(buffer).webp());
                    isAnimated = false;
                }
                else {
                    throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting sticker to WebP. Either install sharp or @napi-rs/image, or provide stickers in WebP format.');
                }
            }
            if (webpBuffer.length > 1024 * 1024) {
                throw new Boom(`Sticker at index ${i} exceeds the 1MB size limit`, { statusCode: 400 });
            }
            const hash = sha256(webpBuffer).toString('base64').replace(/\//g, '-');
            const fileName = `${hash}.webp`;
            stickerData[fileName] = new Uint8Array(webpBuffer);
            return {
                fileName,
                mimetype: 'image/webp',
                isAnimated: s.isAnimated || isAnimated,
                emojis: s.emojis || [],
                accessibilityLabel: s.accessibilityLabel || '',
                isLottie: s.isLottie || false
            };
        }
        catch (e) {
            options.logger?.warn(`Skipping sticker ${i}: ${e.message}`);
            return null;
        }
    });
    const stickerMetadata = (await Promise.all(stickerPromises)).filter((s) => !!s);
    // AunuBaileys (1.0.74): HB-97 — the input guard above only checks
    // the REQUESTED stickers; if every one of them failed (404, too
    // big, unconvertible) the pack used to upload happily with
    // `stickers: []` and report success. An all-failed pack is an
    // error; a partially-failed pack still succeeds.
    if (stickerMetadata.length === 0) {
        throw new Boom('All stickers in the pack failed to process — refusing to upload an empty sticker pack', {
            statusCode: 400
        });
    }
    // Process and add cover/tray icon to the ZIP
    const trayIconFileName = `${stickerPackIdValue}.webp`;
    const { stream: coverStream } = await getStream(cover);
    // AunuBaileys (1.0.72): the pack cover had NO size limit at all
    // (HB-76); it is downscaled to 252px, so 5MB is generous headroom.
    const coverBuffer = await toBufferWithLimit(coverStream, 5 * 1024 * 1024);
    // AunuBaileys (HB-277, P4): pixel-bomb guard for the cover — it
    // is decoded below for the WebP conversion AND again for the
    // pack thumbnail (even when it arrives as WebP and skips the
    // conversion), so the header check happens once, up front,
    // before either decode.
    assertImageWithinPixelLimit(coverBuffer, 'Sticker pack cover');
    let coverWebpBuffer;
    const isCoverWebP = isWebPBuffer(coverBuffer);
    if (isCoverWebP) {
        // Already WebP - preserve original to keep exif metadata
        coverWebpBuffer = coverBuffer;
    }
    else {
        const coverLib = await loadLib();
        if ('sharp' in coverLib && coverLib.sharp) {
            coverWebpBuffer = await coverLib.sharp.default(coverBuffer).webp().toBuffer();
        }
        else if ('image' in coverLib && coverLib.image?.Transformer) {
            // AunuBaileys (1.0.85, HB-164): @napi-rs/image backend,
            // same gap as the sticker conversion above.
            coverWebpBuffer = Buffer.from(await new coverLib.image.Transformer(coverBuffer).webp());
        }
        else {
            throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting cover to WebP. Either install sharp or @napi-rs/image, or provide cover in WebP format.');
        }
    }
    // Add cover to ZIP data
    stickerData[trayIconFileName] = new Uint8Array(coverWebpBuffer);
    const zipBuffer = buildStoredZip(stickerData);
    const stickerPackSize = zipBuffer.length;
    const stickerPackUpload = await encryptedStream(zipBuffer, 'sticker-pack', {
        logger: options.logger,
        opts: options.options
    });
    // AunuBaileys (1.0.69): try/finally so a failed upload cannot leak
    // the sticker-pack tmp file.
    let stickerPackUploadResult;
    try {
        stickerPackUploadResult = await options.upload(stickerPackUpload.encFilePath, {
            fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
            mediaType: 'sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs
        });
    }
    finally {
        await fs.unlink(stickerPackUpload.encFilePath).catch(() => { });
    }
    const stickerPackMessage = {
        name: name,
        publisher: publisher,
        stickerPackId: stickerPackIdValue,
        packDescription: description,
        stickerPackOrigin: WAProto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
        stickerPackSize: stickerPackSize,
        stickers: stickerMetadata,
        fileSha256: stickerPackUpload.fileSha256,
        fileEncSha256: stickerPackUpload.fileEncSha256,
        mediaKey: stickerPackUpload.mediaKey,
        directPath: stickerPackUploadResult.directPath,
        fileLength: stickerPackUpload.fileLength,
        mediaKeyTimestamp: unixTimestampSeconds(),
        trayIconFileName: trayIconFileName
    };
    try {
        // Reuse the cover buffer we already processed for thumbnail generation
        let thumbnailBuffer;
        // AunuBaileys (1.0.72): the library may not be loaded yet —
        // a pure-WebP pack never triggered loadLib() above, and the
        // 'sharp' in lib check then threw on undefined, silently
        // dropping the pack thumbnail (HB-75).
        const thumbLib = await loadLib();
        if ('sharp' in thumbLib && thumbLib.sharp) {
            thumbnailBuffer = await thumbLib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer();
        }
        else if ('image' in thumbLib && thumbLib.image?.Transformer) {
            // AunuBaileys (1.0.85, HB-164): @napi-rs/image backend —
            // the thumbnail used to fall through to a throw (and a
            // silently dropped pack thumbnail) on hosts whose only
            // image library is @napi-rs/image.
            thumbnailBuffer = Buffer.from(await new thumbLib.image.Transformer(coverBuffer).resize(252, 252).jpeg(50));
        }
        else if ('jimp' in thumbLib && thumbLib.jimp) {
            const jimpImage = await thumbLib.jimp.Jimp.read(coverBuffer);
            thumbnailBuffer = await jimpImage.resize({ w: 252, h: 252 }).getBuffer('image/jpeg');
        }
        else {
            throw new Error('No image processing library available for thumbnail generation');
        }
        if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
            throw new Error('Failed to generate thumbnail buffer');
        }
        const thumbUpload = await encryptedStream(thumbnailBuffer, 'thumbnail-sticker-pack', {
            logger: options.logger,
            opts: options.options,
            mediaKey: stickerPackUpload.mediaKey // Use same mediaKey as the sticker pack ZIP
        });
        // AunuBaileys (1.0.69): same try/finally leak fix as the pack.
        let thumbUploadResult;
        try {
            thumbUploadResult = await options.upload(thumbUpload.encFilePath, {
                fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'),
                mediaType: 'thumbnail-sticker-pack',
                timeoutMs: options.mediaUploadTimeoutMs
            });
        }
        finally {
            await fs.unlink(thumbUpload.encFilePath).catch(() => { });
        }
        Object.assign(stickerPackMessage, {
            thumbnailDirectPath: thumbUploadResult.directPath,
            thumbnailSha256: thumbUpload.fileSha256,
            thumbnailEncSha256: thumbUpload.fileEncSha256,
            thumbnailHeight: 252,
            thumbnailWidth: 252,
            imageDataHash: sha256(thumbnailBuffer).toString('base64')
        });
    }
    catch (e) {
        options.logger?.warn?.(`Thumbnail generation failed: ${e}`);
    }
    return { stickerPackMessage };
};
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    let m = {};
    // AunuBaileys P2c wiring: rich response — blok kode / tabel / tautan
    // (the first branch of v6 lib/Utils/messages.js generateWAMessageContent,
    // supplied by prepareRichResponseMessage from './rich-message-utils').
    // The v7 native chain had no equivalent branch, so these content keys
    // used to fall through to prepareWAMessageMedia; the check mirrors v6
    // (`'code' in message || ...`) and runs before the text branch, as in v6.
    if ('code' in message ||
        'links' in message ||
        'table' in message ||
        'richResponse' in message ||
        'html' in message ||
        'richHtml' in message) {
        m = prepareRichResponseMessage(message);
    }
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor);
        }
        if (options.font) {
            extContent.font = options.font;
        }
        m.extendedTextMessage = extContent;
    }
    else if (hasNonNullishProperty(message, 'contacts')) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0]);
        }
        else {
            m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts);
        }
    }
    else if (hasNonNullishProperty(message, 'location')) {
        m.locationMessage = WAProto.Message.LocationMessage.create(message.location);
    }
    else if (hasNonNullishProperty(message, 'react')) {
        // AunuBaileys (1.0.83, HB-165, re-applied P3b): stamp the
        // timestamp on a copy — the caller's react object used to keep
        // it, so a re-send of the same object carried the first send's
        // (stale) timestamp. A non-object react keeps the original
        // behaviour (the deref below throws, caller-visible).
        const react = message.react && typeof message.react === 'object' ? { ...message.react } : message.react;
        if (!react.senderTimestampMs) {
            react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = WAProto.Message.ReactionMessage.create(react);
    }
    else if (hasNonNullishProperty(message, 'delete')) {
        assertMessageKeyArg(message.delete, 'delete');
        m.protocolMessage = {
            key: message.delete,
            type: WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    }
    else if (hasNonNullishProperty(message, 'forward')) {
        m = generateForwardMessageContent(message.forward, message.force);
    }
    else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean'
            ? message.disappearingMessagesInChat
                ? WA_DEFAULT_EPHEMERAL
                : 0
            : message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    }
    else if (hasNonNullishProperty(message, 'groupInvite')) {
        m.groupInviteMessage = {};
        m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
        m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration;
        m.groupInviteMessage.caption = message.groupInvite.text;
        m.groupInviteMessage.groupJid = message.groupInvite.jid;
        m.groupInviteMessage.groupName = message.groupInvite.subject;
        //TODO: use built-in interface and get disappearing mode info etc.
        //TODO: cache / use store!?
        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
            if (pfpUrl) {
                const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher });
                if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    m.groupInviteMessage.jpegThumbnail = buf;
                }
            }
        }
    }
    else if (hasNonNullishProperty(message, 'pin')) {
        assertMessageKeyArg(message.pin, 'pin');
        m.pinInChatMessage = {};
        m.messageContextInfo = {};
        m.pinInChatMessage.key = message.pin;
        m.pinInChatMessage.type = message.type;
        m.pinInChatMessage.senderTimestampMs = Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;
    }
    else if (hasNonNullishProperty(message, 'buttonReply')) {
        switch (message.type) {
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                };
                break;
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                };
                break;
            default:
                // AunuBaileys (1.0.83, HB-253 family, re-applied P3b): an unknown
                // reply type used to fall through the switch, leaving m empty — a
                // content-less message was relayed as if the reply had been sent.
                // Fail loudly instead.
                throw new Boom(`Unknown buttonReply type: ${message.type} (expected 'template' or 'plain')`, { statusCode: 400 });
        }
    }
    else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    }
    else if (hasNonNullishProperty(message, 'product')) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = WAProto.Message.ProductMessage.create({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage
            }
        });
    }
    else if (hasNonNullishProperty(message, 'listReply')) {
        m.listResponseMessage = { ...message.listReply };
    }
    else if (hasNonNullishProperty(message, 'event')) {
        m.eventMessage = {};
        const startTime = Math.floor(message.event.startDate.getTime() / 1000);
        if (message.event.call && options.getCallLink) {
            const token = await options.getCallLink(message.event.call, { startTime });
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.event.messageSecret || randomBytes(32)
        };
        m.eventMessage.name = message.event.name;
        m.eventMessage.description = message.event.description;
        m.eventMessage.startTime = startTime;
        m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined;
        m.eventMessage.isCanceled = message.event.isCancelled ?? false;
        m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
        m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
        m.eventMessage.location = message.event.location;
    }
    else if (hasNonNullishProperty(message, 'poll')) {
        // AunuBaileys (1.0.83, HB-165, re-applied P3b): the default
        // stamps below land on a copy of the caller's content, not on
        // the caller's poll object — a re-send of the same object used
        // to inherit the first send's stamped defaults.
        message = { ...message, poll: { ...message.poll } };
        (_a = message.poll).selectableCount || (_a.selectableCount = 0);
        (_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false);
        if (!Array.isArray(message.poll.values)) {
            throw new Boom('Invalid poll values', { statusCode: 400 });
        }
        if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
            throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
                statusCode: 400
            });
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.poll.messageSecret || randomBytes(32)
        };
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName })),
            endTime: message.poll.endDate ? message.poll.endDate.getTime() : undefined,
            hideParticipantName: message.poll.hideVoter ?? false,
            allowAddOption: message.poll.canAddOption ?? false
        };
        if (message.poll.toAnnouncementGroup) {
            // poll v2 is for community announcement groups (single select and multiple)
            m.pollCreationMessageV2 = pollCreationMessage;
        }
        else if (message.poll.pollType === 1) {
            // AunuBaileys: kuis (dari @itsliaaa/baileys) — untuk newsletter
            if (!message.poll.correctAnswer) {
                throw new Boom('No "correctAnswer" provided for quiz', { statusCode: 400 });
            }
            // AunuBaileys v7 adaptation: in the v6 tree V5 was a
            // FutureProofMessage and the content was wrapped in .message;
            // in this v7 proto pollCreationMessageV5 (111) is a plain
            // PollCreationMessage, so the quiz payload is assigned directly.
            m.pollCreationMessageV5 = {
                ...pollCreationMessage,
                correctAnswer: { optionName: message.poll.correctAnswer.toString() },
                pollType: proto.Message.PollType.QUIZ,
                selectableOptionsCount: 1
            };
        }
        else if (message.poll.hideVoter || message.poll.canAddOption) {
            // AunuBaileys (1.0.71): only poll v6 carries
            // hideParticipantName / allowAddOption; older versions drop them.
            m.pollCreationMessageV6 = pollCreationMessage;
        }
        else {
            if (message.poll.selectableCount === 1) {
                //poll v3 is for single select polls
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                // poll for multiple choice polls
                m.pollCreationMessage = pollCreationMessage;
            }
        }
    }
    else if (hasNonNullishProperty(message, 'aiRich')) {
        // AunuBaileys (ported P2d): Meta AI-style rich response
        // (AIRichResponseMessage) — the v6 lib/Utils/messages.js 'aiRich'
        // branch, whose consumer is AIRich.build() from './builders'.
        // v7 proto adaptations (WAProto flattened AIRichResponse* to the
        // top level; field names and numbers are unchanged):
        //  - text: v6 wrote `messageText: { text }`, but messageText is a
        //    plain string in BOTH protos, so protobufjs coerced the v6
        //    object to "[object Object]" on the wire (proven against the
        //    v6 WAProto). Here the string is written directly.
        //  - code: v6 wrote `codeMetadata: { codeContent, codeLanguage }`,
        //    but codeContent is not a field of AIRichResponseCodeMetadata
        //    in either proto — the content lives in codeBlocks[] — so v6
        //    silently dropped the code on the wire. Here it is wrapped as
        //    a single code block, the shape prepareRichResponseMessage
        //    produces via tokenizeCode.
        //  - each submessage also carries its messageType (v6 omitted it;
        //    the rich-message-utils unified-response builder switches on
        //    it, and the values are the proto's own submessage types).
        //  - latex / table / map / inlineImage shapes are identical in
        //    both protos and are carried over verbatim.
        // Guardrail: every submessage is validated item by item — a
        // present value of the wrong type throws Boom 400 for this
        // content (like the sibling 'poll' branch) instead of being
        // silently coerced by protobufjs into garbage on the wire.
        const aiRichSubString = (value, field) => {
            if (value === undefined || value === null) {
                return '';
            }
            if (typeof value !== 'string') {
                throw new Boom(`aiRich submessage field "${field}" must be a string`, { statusCode: 400 });
            }
            return value;
        };
        if (message.aiRich.submessages !== undefined && !Array.isArray(message.aiRich.submessages)) {
            throw new Boom('aiRich.submessages must be an array', { statusCode: 400 });
        }
        const subs = (message.aiRich.submessages || []).map(s => {
            if (!s || typeof s !== 'object') {
                throw new Boom('aiRich submessages must be objects', { statusCode: 400 });
            }
            if (s.type === 'text' || (!s.type && s.text)) {
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TEXT,
                    messageText: aiRichSubString(s.text, 'text')
                };
            }
            if (s.type === 'code') {
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_CODE,
                    codeMetadata: {
                        codeLanguage: aiRichSubString(s.language || 'text', 'language'),
                        codeBlocks: [{ codeContent: aiRichSubString(s.code || s.text, 'code') }]
                    }
                };
            }
            if (s.type === 'latex') {
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_LATEX,
                    latexMetadata: { text: aiRichSubString(s.text, 'text') }
                };
            }
            if (s.type === 'table') {
                if (!s.table || typeof s.table !== 'object') {
                    throw new Boom('aiRich table submessage requires a table object', { statusCode: 400 });
                }
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_TABLE,
                    tableMetadata: s.table
                };
            }
            if (s.type === 'map') {
                // AunuBaileys (1.0.71): AIRich map submessage (type 7,
                // mapMetadata) — see buildAunuMapMetadata in
                // rich-message-utils.ts for the accepted shape.
                const mapSource = s.map || s.mapMetadata;
                if (mapSource !== undefined && (typeof mapSource !== 'object' || mapSource === null)) {
                    throw new Boom('aiRich map submessage requires a map object', { statusCode: 400 });
                }
                if (s.annotations !== undefined && !Array.isArray(s.annotations)) {
                    throw new Boom('aiRich map annotations must be an array', { statusCode: 400 });
                }
                for (const coord of [
                    s.centerLatitude,
                    s.latitude,
                    s.centerLongitude,
                    s.longitude,
                    s.latitudeDelta,
                    s.longitudeDelta
                ]) {
                    if (coord !== undefined && (typeof coord !== 'number' || !Number.isFinite(coord))) {
                        throw new Boom('aiRich map coordinates must be finite numbers', { statusCode: 400 });
                    }
                }
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_MAP,
                    mapMetadata: mapSource || {
                        centerLatitude: s.centerLatitude ?? s.latitude,
                        centerLongitude: s.centerLongitude ?? s.longitude,
                        latitudeDelta: s.latitudeDelta,
                        longitudeDelta: s.longitudeDelta,
                        annotations: s.annotations,
                        showInfoList: s.showInfoList
                    }
                };
            }
            if (s.type === 'inlineImage') {
                // AunuBaileys (1.0.71): inline-image submessage (type 3,
                // imageMetadata) — same shape prepareRichResponseMessage
                // already accepts via content.inlineImage. imageUrl is
                // a proto ImageURL OBJECT ({imagePreviewUrl,
                // imageHighResUrl, sourceUrl}), not a bare string —
                // fromObject at the end of this function rejects a
                // string, so normalise it here.
                const imageUrl = s.imageUrl || s.url || s.inlineImage;
                if (imageUrl !== undefined &&
                    typeof imageUrl !== 'string' &&
                    (typeof imageUrl !== 'object' || imageUrl === null)) {
                    throw new Boom('aiRich inlineImage url must be a string or an ImageURL object', { statusCode: 400 });
                }
                return {
                    messageType: proto.AIRichResponseSubMessageType.AI_RICH_RESPONSE_INLINE_IMAGE,
                    imageMetadata: {
                        imageUrl: typeof imageUrl === 'string'
                            ? { imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl, sourceUrl: imageUrl }
                            : imageUrl,
                        imageText: s.imageText,
                        alignment: s.alignment,
                        tapLinkUrl: s.tapLinkUrl
                    }
                };
            }
            if (s.raw !== undefined && (typeof s.raw !== 'object' || s.raw === null)) {
                throw new Boom('aiRich raw submessage must be an object', { statusCode: 400 });
            }
            return s.raw || s;
        });
        m.richResponseMessage = {
            messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
            submessages: subs
        };
        // A companion 'text' on the same content is ignored when the rich
        // response is present, exactly as in v6.
    }
    else if (hasNonNullishProperty(message, 'album')) {
        m.albumMessage = {
            expectedImageCount: message.album.expectedImageCount,
            expectedVideoCount: message.album.expectedVideoCount
        };
    }
    else if ('stickerPack' in message) {
        // AunuBaileys (P2e port from v6): sticker-pack send branch —
        // absent in v7, the content fell through to prepareWAMessageMedia.
        m = await prepareStickerPackMessage(message.stickerPack, options);
    }
    else if ('stickers' in message && 'cover' in message) {
        // AunuBaileys (P2e port from v6): flat sticker-pack form.
        m = await prepareStickerPackMessage(message, options);
    }
    else if (hasNonNullishProperty(message, 'sharePhoneNumber')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    }
    else if (hasNonNullishProperty(message, 'requestPhoneNumber')) {
        m.requestPhoneNumberMessage = {};
    }
    else if (hasNonNullishProperty(message, 'limitSharing')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
            limitSharing: {
                sharingLimited: message.limitSharing === true,
                trigger: 1,
                limitSharingSettingTimestamp: Date.now(),
                initiatedByMe: true
            }
        };
    }
    else {
        m = await prepareWAMessageMedia(message, options);
    }
    if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
        m = { viewOnceMessage: { message: m } };
    }
    if ((hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
        (hasOptionalProperty(message, 'mentionAll') && message.mentionAll)) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if (key && 'contextInfo' in key) {
            key.contextInfo = key.contextInfo || {};
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions;
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1;
            }
        }
        else if (key) {
            key.contextInfo = {
                mentionedJid: message.mentions,
                nonJidMentions: message.mentionAll ? 1 : 0
            };
        }
    }
    if (hasOptionalProperty(message, 'edit') && message.edit) {
        assertMessageKeyArg(message.edit, 'edit');
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        };
    }
    if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    if (hasOptionalProperty(message, 'albumParentKey') && !!message.albumParentKey) {
        m.messageContextInfo = {
            ...m.messageContextInfo,
            messageAssociation: {
                associationType: WAProto.MessageAssociation.AssociationType.MEDIA_ALBUM,
                parentMessageKey: message.albumParentKey
            }
        };
    }
    if (shouldIncludeReportingToken(m)) {
        m.messageContextInfo = m.messageContextInfo || {};
        if (!m.messageContextInfo.messageSecret) {
            m.messageContextInfo.messageSecret = randomBytes(32);
        }
    }
    return WAProto.Message.create(m);
};
export const generateWAMessageFromContent = (jid, message, options) => {
    // set timestamp to now
    // if not specified
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    // AunuBaileys (1.0.86, HB-122, re-applied P3b): on the raw path the
    // content value can be a bare string ('conversation') or absent
    // entirely (key undefined). Quote and ephemeral contextInfo can
    // only be attached to an object-shaped value — the `in` check and
    // the property assignment below both threw raw TypeErrors
    // otherwise (Cannot use 'in' operator... / Cannot create property
    // 'contextInfo' on string...).
    const contextTarget = key ? innerMessage[key] : undefined;
    const canAttachContext = !!contextTarget && typeof contextTarget === 'object';
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;
    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe
            ? userJid // TODO: Add support for LIDs
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        // strip any redundant properties
        quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] });
        const quotedContent = quotedMsg[msgType];
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo;
        }
        const contextInfo = (canAttachContext && 'contextInfo' in contextTarget && contextTarget.contextInfo) || {};
        contextInfo.participant = jidNormalizedUser(participant);
        contextInfo.stanzaId = quoted.key.id;
        contextInfo.quotedMessage = quotedMsg;
        // if a participant is quoted, then it must be a group
        // hence, remoteJid of group must also be entered
        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && canAttachContext) {
            /* @ts-ignore */
            innerMessage[key].contextInfo = contextInfo;
        }
    }
    if (
    // if we want to send a disappearing message
    !!options?.ephemeralExpiration &&
        // and it's not a protocol message -- delete, toggle disappear message
        key !== 'protocolMessage' &&
        // already not converted to disappearing message
        key !== 'ephemeralMessage' &&
        // newsletters don't support ephemeral messages
        !isJidNewsletter(jid) &&
        // and a string/absent content value cannot carry one (HB-122)
        canAttachContext) {
        /* @ts-ignore */
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
            //ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
        };
    }
    message = WAProto.Message.create(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined, // TODO: Add support for LIDs
        status: WAMessageStatus.PENDING
    };
    return WAProto.WebMessageInfo.fromObject(messageJSON);
};
export const generateWAMessage = async (jid, content, options) => {
    // ensure msg ID is with every log
    options.logger = options?.logger?.child({ msgId: options.messageId });
    // Pass jid in the options to generateWAMessageContent
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options);
};
/** Get the key to access the true type of content */
export const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
};
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined;
    }
    // set max iterations to prevent an infinite loop
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
    function getFutureProofMessage(message) {
        return (message?.ephemeralMessage ||
            message?.viewOnceMessage ||
            message?.documentWithCaptionMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension ||
            message?.editedMessage ||
            message?.associatedChildMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2);
    }
};
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export const extractMessageContent = (content) => {
    const extractFromTemplateMessage = (msg) => {
        if (msg.imageMessage) {
            return { imageMessage: msg.imageMessage };
        }
        else if (msg.documentMessage) {
            return { documentMessage: msg.documentMessage };
        }
        else if (msg.videoMessage) {
            return { videoMessage: msg.videoMessage };
        }
        else if (msg.locationMessage) {
            return { locationMessage: msg.locationMessage };
        }
        else {
            return {
                conversation: 'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
            };
        }
    };
    content = normalizeMessageContent(content);
    if (content?.buttonsMessage) {
        return extractFromTemplateMessage(content.buttonsMessage);
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate);
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate);
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate);
    }
    // AunuBaileys (P4, farm delta adopted from spencer-baileys@1.0.5):
    // a PTV (video note) IS a VideoMessage on the wire — the upload
    // side builds ptvMessage by moving the videoMessage object
    // verbatim (see prepareWAMessageMedia) — but under its own key
    // it was invisible to assertMediaContent, which threw 'given
    // message is not a media message' for a perfectly downloadable
    // video note (downloadMediaMessage itself already worked: the
    // 'ptv' HKDF entry maps to 'Video', identical to 'video').
    // Normalise the key here, in the one extraction choke point:
    // the only in-tree consumers are downloadMediaMessage (neutral —
    // same HKDF info either way) and assertMediaContent (fixed).
    // The mapping is lossless (same proto type, same object) and
    // any sibling keys (messageContextInfo) are preserved.
    if (content?.ptvMessage) {
        const { ptvMessage, ...rest } = content;
        return { ...rest, videoMessage: ptvMessage };
    }
    return content;
};
/**
 * Returns the device predicted by message ID
 */
export const getDevice = (id) => /^3A.{18}$/.test(id)
    ? 'ios'
    : /^3E.{20}$/.test(id)
        ? 'web'
        : /^(.{21}|.{32})$/.test(id)
            ? 'android'
            : /^(3F|.{18}$)/.test(id)
                ? 'desktop'
                : 'unknown';
/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) {
        Object.assign(recp, receipt);
    }
    else {
        msg.userReceipt.push(receipt);
    }
};
/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key);
    const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text = reaction.text || '';
    reactions.push(reaction);
    msg.reactions = reactions;
};
/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg, update, options) => {
    // AunuBaileys: normalize the voter through the LID store when one is
    // given, so a vote arriving in the other identity form REPLACES the
    // voter's earlier update instead of piling up as a second voter.
    const resolveVoter = (key) => {
        const author = getKeyAuthor(key);
        return options?.lidStore?.getPNForLID?.(author) || author;
    };
    const authorID = resolveVoter(update.pollUpdateMessageKey);
    const reactions = (msg.pollUpdates || []).filter(r => resolveVoter(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) {
        reactions.push(update);
    }
    msg.pollUpdates = reactions;
};
/** Update the message with a new event response */
export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey);
    const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID);
    responses.push(update);
    msg.eventResponses = responses;
};
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId, options) {
    // AunuBaileys (1.0.71): normalise first (a poll wrapped in an
    // ephemeral/viewOnce/spoiler shell still aggregates), and read V5/V6
    // options too — a V6 poll used to aggregate as all-"Unknown".
    message = normalizeMessageContent(message);
    const opts = message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV2?.options ||
        message?.pollCreationMessageV3?.options ||
        message?.pollCreationMessageV5?.message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV5?.options ||
        message?.pollCreationMessageV6?.options ||
        [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = sha256(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        };
        return acc;
    }, {});
    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) {
            continue;
        }
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            let data = voteHashMap[hash];
            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                };
                data = voteHashMap[hash];
            }
            // AunuBaileys: voters are canonicalized to their phone-number
            // JID through the LID store when one is given, and deduped per
            // option — without this, one person voting first as PN and
            // later as LID counted as two different voters.
            const voter = getKeyAuthor(update.pollUpdateMessageKey, meId);
            const canonicalVoter = options?.lidStore?.getPNForLID?.(voter) || voter;
            if (!data.voters.includes(canonicalVoter)) {
                data.voters.push(canonicalVoter);
            }
        }
    }
    return Object.values(voteHashMap);
}
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = {
            response: type,
            responders: []
        };
    }
    for (const update of eventResponses || []) {
        const responseType = update.eventResponse || 'UNKNOWN';
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
        }
    }
    return Object.values(responseMap);
}
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                };
            }
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};
const REUPLOAD_REQUIRED_STATUS = [410, 404];
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            typeof error?.status === 'number' && // treat errors with status as HTTP failures requiring reupload
            REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...');
            // request reupload
            message = await ctx.reuploadRequest(message);
            const result = await downloadMsg();
            return result;
        }
        throw error;
    });
    return result;
    async function downloadMsg() {
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new Boom('No message present', { statusCode: 400, data: message });
        }
        const contentType = getContentType(mContent);
        let mediaType = contentType?.replace('Message', '');
        // AunuBaileys (1.0.85, HB-252, P2e port from v6): the content type
        // derives 'stickerPack' from stickerPackMessage, but the HKDF info
        // mapping only knows the upload-side name 'sticker-pack' —
        // downloads derived their keys from 'WhatsApp undefined Keys' and
        // ALWAYS failed with a misleading bad-decrypt error. Normalise to
        // the name the pack was encrypted with.
        if (mediaType === 'stickerPack') {
            mediaType = 'sticker-pack';
        }
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new Boom(`"${contentType}" message is not a media message`);
        }
        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            };
            mediaType = 'thumbnail-link';
        }
        else {
            download = media;
        }
        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            return Buffer.concat(bufferArray);
        }
        return stream;
    }
};
/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage ||
        content?.imageMessage ||
        content?.videoMessage ||
        content?.audioMessage ||
        content?.stickerMessage;
    if (!mediaContent) {
        throw new Boom('given message is not a media message', { statusCode: 400, data: content });
    }
    return mediaContent;
};
//# sourceMappingURL=messages.js.map