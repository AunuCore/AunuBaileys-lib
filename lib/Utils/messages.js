import { Boom } from '@hapi/boom';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import {} from 'stream';
import { zip } from 'fflate';
import { proto } from '../../WAProto/index.js';
import { MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { prepareRichResponseMessage } from './rich-message-utils.js';
import { buildAunuA2UIWidget } from './aunu-a2ui.js';
import { wrapAunuViewOnce } from './aunu-view-once.js';
import { downloadContentFromMessage, encryptedStream, generateThumbnail, getAudioDuration, getAudioWaveform, getRawMediaUploadData, getImageProcessingLibrary, getStream, toBuffer, toBufferWithLimit } from './messages-media.js';
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
// AunuBaileys (1.0.71): WhatsApp call-link prefixes for event join
// links (baileys-rec 1.3.0 / @shanks-dev/baileys 0.1.2 Defaults).
const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/';
const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/';
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
/**
 * AunuBaileys (1.0.71): option identifier for an image poll —
 * WhatsApp hashes the option name, appends the base64 media hash,
 * and hashes that: `sha256(hex(sha256(name)) + base64(fileSha256))`.
 * A vote carries this hash, not the name, so it has to match byte
 * for byte. (Formula verified against @violetix/baileys 0.5.4.)
 */
export const hashImagePollOption = (optionName, fileSha256) => {
    const nameHash = sha256(Buffer.from(String(optionName), 'utf-8')).toString('hex');
    const mediaHashB64 = fileSha256 ? Buffer.from(fileSha256).toString('base64') : '';
    return sha256(Buffer.from(nameHash + mediaHashB64, 'utf-8')).toString('hex');
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
    // AunuBaileys (1.0.85, HB-208 + addendum): reject an unusable
    // media value HERE, before the cacheable-key computation below
    // derefs it — a null media used to explode in that computation
    // itself ('url' in null), and undefined / non-object media as a
    // raw TypeError further down in getStream. Hosts get a clear
    // Boom 400 at the boundary instead. ({} and { url: undefined }
    // pass this check and are rejected by the matching getStream
    // guard.)
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
    // AunuBaileys (1.0.71): count the pages of a PDF Buffer document
    // when the host did not supply pageCount — it flows into the
    // DocumentMessage via the ...uploadData spread below (both the
    // newsletter-raw and the encrypted paths). Only Buffers are
    // counted; URLs/streams/paths are left alone. '/Type /Page' (not
    // followed by 's') skips the '/Type /Pages' tree node itself.
    if (mediaType === 'document' && typeof uploadData.pageCount === 'undefined' && Buffer.isBuffer(uploadData.media)) {
        if (uploadData.media.subarray(0, 5).toString('latin1') === '%PDF-') {
            const pageMatches = uploadData.media.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
            uploadData.pageCount = pageMatches ? pageMatches.length : 0;
        }
    }
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }
    if (cacheableKey) {
        const mediaBuff = options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            // AunuBaileys (1.0.72): the cached object used to BE the
            // result, with the new send's data assigned over it — any
            // field ABSENT from the new send (a caption, a file name)
            // silently survived from the PREVIOUS send of the same
            // media URL. The cache may only contribute the media
            // TRANSPORT data (where the bytes live); the message is
            // rebuilt from THIS send's data, exactly like a miss.
            const cached = WAProto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            const cachedMedia = cached[key] || {};
            const transport = {};
            for (const field of ['url', 'directPath', 'mediaKey', 'mediaKeyTimestamp', 'fileEncSha256', 'fileSha256', 'fileLength', 'streamingSidecar']) {
                if (typeof cachedMedia[field] !== 'undefined' && cachedMedia[field] !== null) {
                    transport[field] = cachedMedia[field];
                }
            }
            const obj = WAProto.Message.fromObject({
                [key]: MessageTypeProto[mediaType].fromObject({
                    ...transport,
                    ...uploadData,
                    media: undefined
                })
            });
            if (uploadData.ptv) {
                obj.ptvMessage = obj.videoMessage;
                delete obj.videoMessage;
            }
            return obj;
        }
    }
    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter');
        const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger, options.options);
        const fileSha256B64 = fileSha256.toString('base64');
        // AunuBaileys (1.0.69): a throwing upload used to skip the
        // unlink, leaking a full-size file in the tmpdir.
        let mediaUrl;
        let directPath;
        try {
            ({ mediaUrl, directPath } = await options.upload(filePath, {
                fileEncSha256B64: fileSha256B64,
                mediaType: mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            }));
        }
        finally {
            await fs.unlink(filePath).catch(() => { });
        }
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
        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
        }
        return obj;
    }
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true;
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true;
    // AunuBaileys (1.0.72): waveform processing consumes the original
    // stream too (HB-74) — without it a ptt URL send could drop the
    // original and produce no waveform.
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation || requiresWaveformProcessing;
    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength, streamingSidecar } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
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
            ...(streamingSidecar ? { streamingSidecar } : {}),
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
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
// AunuBaileys: StickerPack (diadaptasi dari neoxr/baileys & @itsliaaa/baileys)
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
    // WebP must start with RIFF....WEBP
    if (buffer.length < 12 ||
        buffer[0] !== 0x52 ||
        buffer[1] !== 0x49 ||
        buffer[2] !== 0x46 ||
        buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 ||
        buffer[9] !== 0x45 ||
        buffer[10] !== 0x42 ||
        buffer[11] !== 0x50) {
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
async function prepareStickerPackMessage(stickerPack, options) {
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
    // AunuBaileys (1.0.71): the image library is loaded lazily now —
    // see HB-51 below; pure-WebP packs never need it.
    let lib;
    const loadLib = async () => {
        if (!lib) {
            lib = await getImageProcessingLibrary();
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
                    // failed EVERY non-WebP sticker (and an all-PNG
                    // pack failed outright via HB-97).
                    webpBuffer = await new imgLib.image.Transformer(buffer).webp();
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
            stickerData[fileName] = [new Uint8Array(webpBuffer), { level: 0 }];
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
    const stickerMetadata = (await Promise.all(stickerPromises)).filter(Boolean);
    // AunuBaileys (1.0.74): HB-97 — the input guard above only checks
    // the REQUESTED stickers; if every one of them failed (404, too
    // big, unconvertible) the pack used to upload happily with
    // `stickers: []` and report success. An all-failed pack is an
    // error; a partially-failed pack still succeeds.
    if (stickerMetadata.length === 0) {
        throw new Boom('All stickers in the pack failed to process — refusing to upload an empty sticker pack', { statusCode: 400 });
    }
    // Process and add cover/tray icon to the ZIP
    const trayIconFileName = `${stickerPackIdValue}.webp`;
    const { stream: coverStream } = await getStream(cover);
    // AunuBaileys (1.0.72): the pack cover had NO size limit at all
    // (HB-76); it is downscaled to 252px, so 5MB is generous headroom.
    const coverBuffer = await toBufferWithLimit(coverStream, 5 * 1024 * 1024);
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
            coverWebpBuffer = await new coverLib.image.Transformer(coverBuffer).webp();
        }
        else {
            throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting cover to WebP. Either install sharp or @napi-rs/image, or provide cover in WebP format.');
        }
    }
    // Add cover to ZIP data
    stickerData[trayIconFileName] = [new Uint8Array(coverWebpBuffer), { level: 0 }];
    const zipBuffer = await new Promise((resolve, reject) => {
        zip(stickerData, (err, data) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(Buffer.from(data));
            }
        });
    });
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
        await loadLib();
        if ('sharp' in lib && lib.sharp) {
            thumbnailBuffer = await lib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer();
        }
        else if ('image' in lib && lib.image?.Transformer) {
            // AunuBaileys (1.0.85, HB-164): @napi-rs/image backend —
            // the thumbnail used to fall through to a throw (and a
            // silently dropped pack thumbnail) on hosts whose only
            // image library is @napi-rs/image.
            thumbnailBuffer = await new lib.image.Transformer(coverBuffer).resize(252, 252).jpeg(50);
        }
        else if ('jimp' in lib && lib.jimp) {
            const jimpImage = await lib.jimp.Jimp.read(coverBuffer);
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
}

// AunuBaileys (1.0.71): native-flow button icon — a caller-supplied
// `icon` on a button object is upper-cased into its buttonParamsJson
// (donor: @violetix/baileys). Buttons without `icon`, or with
// unparseable params, come out byte-identical to before.
const withAunuButtonIcon = (button) => {
    let params = button.buttonParamsJson;
    if (typeof button.icon === 'string' && button.icon) {
        try {
            const parsed = typeof params === 'string' ? JSON.parse(params) : { ...(params ?? {}) };
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                params = JSON.stringify({ ...parsed, icon: button.icon.toUpperCase() });
            }
        }
        catch {
            // unparseable params stay untouched
        }
    }
    return {
        name: button.name,
        buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params ?? {})
    };
};
// AunuBaileys (1.0.83, HB-254): delete / pin / edit each carry a
// message KEY, and WAProto.Message.fromObject silently DROPS a key
// whose value is undefined — so { delete: undefined } used to relay
// a key-less REVOKE (pin and edit likewise) that "succeeded" but
// could never take effect, because the server had no key to act
// on. Mirror the pollUpdate branch's discipline: the argument
// must be a real key object carrying a message id.
const assertMessageKeyArg = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id) {
        throw new Boom(`"${field}" requires a valid message key (an object with a message id)`, { statusCode: 400 });
    }
};
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    let m = {};
    // AunuBaileys (1.0.71): `raw: true` — pass the content object
    // straight through to generateWAMessage() unprocessed (donor:
    // @violetix/baileys). The caller owns the proto shape entirely.
    if (message && typeof message === 'object' && 'raw' in message && !!message.raw) {
        // AunuBaileys (1.0.83, HB-165): work on a copy — the object
        // belongs to the caller, and deleting `raw` from it made a
        // second send of the same object silently lose the raw
        // passthrough entirely.
        const rawContent = { ...message };
        delete rawContent.raw;
        return rawContent;
    }
    // AunuBaileys: rich response — blok kode / tabel / tautan (dari @itsliaaa/baileys)
    if ('code' in message || 'links' in message || 'table' in message || 'richResponse' in message || 'html' in message || 'richHtml' in message) {
        m = prepareRichResponseMessage(message);
    }
    else if ('text' in message) {
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
    else if ('contacts' in message) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = WAProto.Message.ContactMessage.fromObject(message.contacts.contacts[0]);
        }
        else {
            m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.fromObject(message.contacts);
        }
    }
    else if ('location' in message) {
        m.locationMessage = WAProto.Message.LocationMessage.fromObject(message.location);
    }
    else if ('react' in message) {
        // AunuBaileys (1.0.83, HB-165): stamp the timestamp on a
        // copy — the caller's react object used to keep it, so a
        // re-send of the same object carried the first send's
        // (stale) timestamp. A non-object react keeps the original
        // behaviour (the deref below throws, caller-visible).
        const react = message.react && typeof message.react === 'object' ? { ...message.react } : message.react;
        if (!react.senderTimestampMs) {
            react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = WAProto.Message.ReactionMessage.fromObject(react);
    }
    else if ('delete' in message) {
        assertMessageKeyArg(message.delete, 'delete');
        m.protocolMessage = {
            key: message.delete,
            type: WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    }
    else if ('forward' in message) {
        m = generateForwardMessageContent(message.forward, message.force);
    }
    else if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean'
            ? message.disappearingMessagesInChat
                ? WA_DEFAULT_EPHEMERAL
                : 0
            : message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    }
    else if ('groupInvite' in message) {
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
                const resp = await axios.get(pfpUrl, { responseType: 'arraybuffer' });
                if (resp.status === 200) {
                    m.groupInviteMessage.jpegThumbnail = resp.data;
                }
            }
        }
    }
    else if ('pin' in message) {
        assertMessageKeyArg(message.pin, 'pin');
        m.pinInChatMessage = {};
        m.messageContextInfo = {};
        m.pinInChatMessage.key = message.pin;
        m.pinInChatMessage.type = message.type;
        m.pinInChatMessage.senderTimestampMs = Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;
    }
    else if ('buttonReply' in message) {
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
                // AunuBaileys (1.0.83, HB-253 family): an unknown
                // reply type used to fall through the switch,
                // leaving m empty — a content-less message was
                // relayed as if the reply had been sent. Fail
                // loudly instead.
                throw new Boom(`Unknown buttonReply type: ${message.type} (expected 'template' or 'plain')`, { statusCode: 400 });
        }
    }
    else if ('ptv' in message && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    }
    else if ('product' in message) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = WAProto.Message.ProductMessage.fromObject({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage
            }
        });
    }
    else if ('listReply' in message) {
        m.listResponseMessage = { ...message.listReply };
    }
    else if ('event' in message) {
        // AunuBaileys (1.0.71): EventMessage (Message field 75) existed
        // in our proto but generateWAMessageContent had no 'event'
        // branch, so events could not be sent at all. Behavioural shape
        // follows baileys-rec 1.3.0 (messages.js) — start/end accept a
        // Date, a seconds number, a millisecond number, or a date
        // string. A call link needs options.getCallLink (not provided by
        // this library today); without it `call` is ignored instead of
        // failing the send. Field names come from OUR WAProto
        // IEventMessage (name/description/location/joinLink/startTime/
        // endTime/isCanceled/extraGuestsAllowed/isScheduleCall).
        m.eventMessage = {};
        const eventToSeconds = (value) => {
            if (value instanceof Date) {
                return Math.floor(value.getTime() / 1000);
            }
            if (typeof value === 'number') {
                return value > 1e11 ? Math.floor(value / 1000) : value;
            }
            if (typeof value === 'string') {
                return Math.floor(new Date(value).getTime() / 1000);
            }
            return undefined;
        };
        const eventStart = eventToSeconds(message.event.startDate ?? message.event.startTime ?? message.event.start) ?? Math.floor(Date.now() / 1000);
        if (!Number.isFinite(eventStart)) {
            // AunuBaileys (1.0.72): an unparseable supplied start used
            // to slip past the ?? fallback as NaN and reach the wire
            // coerced to 0 — a silently broken event dated 1970.
            throw new Boom('Invalid event start time', { statusCode: 400 });
        }
        if (message.event.call && options.getCallLink) {
            const token = await options.getCallLink(message.event.call, { startTime: eventStart });
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        }
        m.messageContextInfo = {
            messageSecret: message.event.messageSecret || randomBytes(32)
        };
        m.eventMessage.name = message.event.name;
        m.eventMessage.description = message.event.description;
        m.eventMessage.startTime = eventStart;
        const eventEnd = eventToSeconds(message.event.endDate ?? message.event.endTime ?? message.event.end);
        if (typeof eventEnd !== 'undefined' && !Number.isFinite(eventEnd)) {
            throw new Boom('Invalid event end time', { statusCode: 400 });
        }
        m.eventMessage.endTime = eventEnd;
        m.eventMessage.isCanceled = message.event.isCancelled ?? false;
        m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
        m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
        m.eventMessage.location = message.event.location;
    }
    else if ('eventResponse' in message) {
        // AunuBaileys (1.0.71): an RSVP can NOT be sent as a plain
        // Message field — proto 6.7.24 has NO Message.eventResponseMessage
        // (EventResponseMessage only exists inside EventResponse /
        // LegacyMessage). Real RSVPs travel as encEventResponseMessage
        // (Message field 76): the EventResponseMessage encrypted with
        // the event creation key, the same pattern as poll votes and
        // enc reactions — and our receive side already understands it
        // (process-message decryptEventResponse). A plain
        // eventResponseMessage here would be silently dropped by
        // WAProto.Message.fromObject at the end of this function, so
        // fail loudly instead of pretending to send.
        throw new Boom('Event responses (RSVPs) are sent as encEventResponseMessage (Message field 76), encrypted with the event creation key — not yet implemented in AunuBaileys', { statusCode: 501 });
    }
    else if ('poll' in message) {
        // AunuBaileys (1.0.83, HB-165): the default stamps below
        // (selectableCount / toAnnouncementGroup) land on a copy of
        // the caller's content, not on the caller's poll object.
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
            // proto 6.7.24: V5 adalah FutureProofMessage — konten dibungkus di .message
            m.pollCreationMessageV5 = {
                message: {
                    pollCreationMessage: {
                        ...pollCreationMessage,
                        correctAnswer: { optionName: message.poll.correctAnswer.toString() },
                        pollType: 1,
                        selectableOptionsCount: 1
                    }
                }
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
    else if ('imagePoll' in message && message.imagePoll) {
        // AunuBaileys (1.0.71): image poll — the parent carries only
        // the option names and their hashes. The images themselves
        // travel as separate pollCreationOptionImageMessage children,
        // associated back to this message by MEDIA_POLL — sendMessage
        // sends those after the parent. (Flow verified against
        // @violetix/baileys 0.5.4.)
        if (!Array.isArray(message.imagePoll.options) || !message.imagePoll.options.length) {
            throw new Boom('Invalid imagePoll options', { statusCode: 400 });
        }
        const selectableOptionsCount = message.imagePoll.selectableCount ?? 1;
        if (selectableOptionsCount < 0 || selectableOptionsCount > message.imagePoll.options.length) {
            throw new Boom(`imagePoll.selectableCount should be >= 0 and <= ${message.imagePoll.options.length}`, {
                statusCode: 400
            });
        }
        const missingHash = message.imagePoll.options.find(option => !option.optionHash);
        if (missingHash) {
            throw new Boom('imagePoll options must be prepared with hashImagePollOption; send via sendMessage instead of building the content by hand', { statusCode: 400 });
        }
        m.pollCreationMessageV3 = {
            name: message.imagePoll.name,
            selectableOptionsCount,
            options: message.imagePoll.options.map(option => ({
                optionName: option.optionName,
                optionHash: option.optionHash
            })),
            pollContentType: proto.Message.PollContentType.IMAGE
        };
        m.messageContextInfo = {
            messageSecret: message.imagePoll.messageSecret || randomBytes(32)
        };
    }
    else if ('aiRich' in message) {
        // AunuBaileys: Meta AI-style rich response (AIRichResponseMessage)
        const subs = (message.aiRich.submessages || []).map((s) => {
            if (s.type === 'text' || (!s.type && s.text)) {
                return { messageText: { text: s.text || '' } };
            }
            if (s.type === 'code') {
                return { codeMetadata: { codeContent: s.code || s.text || '', codeLanguage: s.language || 'text' } };
            }
            if (s.type === 'latex') {
                return { latexMetadata: { text: s.text || '' } };
            }
            if (s.type === 'table') {
                return { tableMetadata: s.table };
            }
            if (s.type === 'map') {
                // AunuBaileys (1.0.71): AIRich map submessage (type 7,
                // mapMetadata) — see buildAunuMapMetadata in
                // rich-message-utils.js for the accepted shape.
                return { mapMetadata: s.map || s.mapMetadata || { centerLatitude: s.centerLatitude ?? s.latitude, centerLongitude: s.centerLongitude ?? s.longitude, latitudeDelta: s.latitudeDelta, longitudeDelta: s.longitudeDelta, annotations: s.annotations, showInfoList: s.showInfoList } };
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
                return { imageMetadata: { imageUrl: typeof imageUrl === 'string' ? { imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl, sourceUrl: imageUrl } : imageUrl, imageText: s.imageText, alignment: s.alignment, tapLinkUrl: s.tapLinkUrl } };
            }
            return s.raw || s;
        });
        m.richResponseMessage = {
            messageType: proto.AIRichResponseMessage.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
            submessages: subs
        };
        if ('text' in message) {
            // teks pendamping opsional diabaikan oleh proto bila rich response ada
        }
    }
    else if ('pollResult' in message) {
        // AunuBaileys: poll result snapshot (dari @itsliaaa/baileys)
        // AunuBaileys (1.0.88, HB-250): this branch validated NOTHING
        // while its siblings ('poll', 'imagePoll', 'contacts') all
        // Boom 400 on bad input — a missing/non-array votes died as
        // a raw TypeError, and a missing/non-numeric voteCount was
        // parseInt'd to NaN, which protobufjs silently coerces to 0
        // on the wire: the snapshot sent to the peer CLAIMED zero
        // votes for an option that actually had some. Mirror the
        // 'poll' branch: votes must be an array and every count a
        // finite integer (numeric strings stay accepted, as before).
        if (!Array.isArray(message.pollResult.votes)) {
            throw new Boom('pollResult.votes must be an array', { statusCode: 400 });
        }
        const pollResultSnapshotMessage = {
            name: message.pollResult.name,
            pollVotes: message.pollResult.votes.map(vote => {
                if (!vote || typeof vote !== 'object') {
                    throw new Boom('pollResult.votes entries must be objects', { statusCode: 400 });
                }
                const count = typeof vote.voteCount === 'string' ? parseInt(vote.voteCount, 10) : vote.voteCount;
                if (!Number.isInteger(count)) {
                    throw new Boom('pollResult voteCount must be a finite integer', { statusCode: 400 });
                }
                return {
                    optionName: vote.name,
                    optionVoteCount: count
                };
            })
        };
        if (message.pollResult.pollType === 1) {
            pollResultSnapshotMessage.pollType = proto.Message.PollCreationMessage.PollType.QUIZ;
            m.pollResultSnapshotMessageV3 = pollResultSnapshotMessage;
        }
        else {
            pollResultSnapshotMessage.pollType = proto.Message.PollCreationMessage.PollType.POLL;
            m.pollResultSnapshotMessage = pollResultSnapshotMessage;
        }
    }
    else if ('pollUpdate' in message) {
        if (!message.pollUpdate.key) {
            throw new Boom('Message key is required', { statusCode: 400 });
        }
        if (!message.pollUpdate.vote) {
            throw new Boom('Encrypted vote payload is required', { statusCode: 400 });
        }
        m.pollUpdateMessage = {
            metadata: message.pollUpdate.metadata,
            pollCreationMessageKey: message.pollUpdate.key,
            senderTimestampMs: Date.now(),
            vote: message.pollUpdate.vote
        };
    }
    else if ('paymentInviteServiceType' in message) {
        // AunuBaileys: payment invite (dari @itsliaaa/baileys)
        m.paymentInviteMessage = {
            expiryTimestamp: Date.now(),
            serviceType: message.paymentInviteServiceType
        };
    }
    else if ('orderText' in message) {
        // AunuBaileys: order message (dari @itsliaaa/baileys)
        if (message.thumbnail !== undefined && !Buffer.isBuffer(message.thumbnail)) {
            throw new Boom('Must provide thumbnail buffer in order message', { statusCode: 400 });
        }
        m.orderMessage = {
            itemCount: message.itemCount || 1,
            messageVersion: 1,
            orderTitle: message.orderTitle || 'AunuBaileys',
            status: proto.Message.OrderMessage.OrderStatus.INQUIRY,
            surface: proto.Message.OrderMessage.OrderSurface.CATALOG,
            totalAmount1000: message.totalAmount1000 || 1000,
            totalCurrencyCode: message.currency || 'IDR',
            thumbnail: message.thumbnail,
            message: message.orderText
        };
    }
    else if ('sharePhoneNumber' in message) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    }
    else if ('requestPhoneNumber' in message) {
        m.requestPhoneNumberMessage = {};
    }
    else if ('interactive' in message) {
        // AunuBaileys: interactive / native-flow (pola @itsliaaa/baileys, disederhanakan)
        const iMsg = message.interactive;
        const interactiveMessage = {
            body: iMsg.body ?? (iMsg.text ? { text: iMsg.text } : undefined),
            footer: iMsg.footer ?? (iMsg.footerText ? { text: iMsg.footerText } : undefined),
            header: iMsg.header,
            contextInfo: iMsg.contextInfo
        };
        if (iMsg.carousel) {
            interactiveMessage.carouselMessage = {
                cards: iMsg.carousel.map(card => ({
                    header: card.header ?? (card.title ? { title: card.title, hasMediaAttachment: !!card.imageMessage, imageMessage: card.imageMessage } : undefined),
                    body: { text: card.body || '' },
                    footer: card.footer ? { text: card.footer } : undefined,
                    nativeFlowMessage: { buttons: (card.buttons || []).map(withAunuButtonIcon) }
                })),
                messageVersion: 1
            };
        }
        else {
            interactiveMessage.nativeFlowMessage = {
                buttons: (iMsg.buttons || []).map(withAunuButtonIcon),
                messageParamsJson: iMsg.messageParamsJson || ''
            };
        }
        m = {
            interactiveMessage,
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }
        };
    }
    else if ('album' in message) {
        // AunuBaileys: album message (dari @itsliaaa/baileys)
        if (!Array.isArray(message.album)) {
            throw new Boom('Invalid album type. Expected an array.', { statusCode: 400 });
        }
        let videoCount = 0;
        let imageCount = 0;
        for (const item of message.album) {
            if (item.video) videoCount++;
            if (item.image) imageCount++;
            if (!item.video && !item.image) {
                // AunuBaileys (1.0.72): an item with neither (e.g.
                // { videoMessage: undefined }) used to pass counting
                // and abort the send MID-ALBUM — parent already
                // relayed, its expected counts no longer matching
                // what was actually delivered.
                throw new Boom('Invalid album item: every item must carry image or video media', { statusCode: 400 });
            }
        }
        if (videoCount + imageCount < 2) {
            throw new Boom('Minimum provide 2 media to upload album message', { statusCode: 400 });
        }
        m.albumMessage = { expectedImageCount: imageCount, expectedVideoCount: videoCount };
    }
    else if ('stickerPack' in message) {
        m = await prepareStickerPackMessage(message.stickerPack, options);
    }
    else if ('stickers' in message && 'cover' in message) {
        m = await prepareStickerPackMessage(message, options);
    }
    // AunuBaileys (1.0.71): an A2UI widget has no base content of its
    // own — the post-processing block below replaces `m` wholesale.
    // Without this it would fall through to the media branch and be
    // rejected as a media message.
    else if ('a2ui' in message) {
        if (message.a2ui == null) {
            throw new Boom('a2ui content requires a widget object', { statusCode: 400 });
        }
        m = {};
    }
    else {
        m = await prepareWAMessageMedia(message, options);
    }
    // AunuBaileys (1.0.71): A2UI widget — `nativeFlowMessage` is always
    // set, even empty: it is what the client keys the interactive render
    // off. `singleScreen` drops the surrounding bubble so the widget is
    // the whole message.
    if ('a2ui' in message && message.a2ui != null) {
        const interactiveMessage = {
            bloksWidget: buildAunuA2UIWidget(message.a2ui, {
                type: message.a2uiType,
                wrapped: message.a2uiWrapped !== false
            }),
            nativeFlowMessage: { messageParamsJson: '' }
        };
        if (!message.singleScreen) {
            interactiveMessage.header = { hasMediaAttachment: false };
            interactiveMessage.body = { text: message.text || '' };
            interactiveMessage.footer = { text: message.footer || '' };
        }
        m = {
            interactiveMessage,
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }
        };
    }
    // AunuBaileys: externalAdReply langsung sebagai opsi pesan (diadaptasi dari @itsliaaa/baileys;
    // tanpa fallback URL pihak ketiga — url kosong tetap kosong)
    if ('externalAdReply' in message && !!message.externalAdReply) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const ad = message.externalAdReply;
        if ('thumbnail' in ad && ad.thumbnail !== undefined && !Buffer.isBuffer(ad.thumbnail)) {
            throw new Boom('externalAdReply thumbnail must be a Buffer', { statusCode: 400 });
        }
        const externalAdReply = {
            title: ad.title,
            body: ad.body,
            mediaType: ad.mediaType ?? 1,
            mediaUrl: ad.url,
            sourceUrl: ad.url,
            thumbnail: ad.thumbnail,
            thumbnailUrl: ad.thumbnailUrl,
            renderLargerThumbnail: ad.largeThumbnail,
            showAdAttribution: ad.showAdAttribution
        };
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.externalAdReply = { ...key.contextInfo.externalAdReply, ...externalAdReply };
        }
        else if (key) {
            key.contextInfo = { externalAdReply };
        }
    }
    // AunuBaileys (1.0.71): lottie sticker — the whole message is
    // wrapped in lottieStickerMessage (donor: @violetix/baileys).
    if ('isLottie' in message && !!message.isLottie) {
        m = { lottieStickerMessage: { message: m } };
    }
    // AunuBaileys (1.0.71): universal view-once — `viewOnce` accepts
    // true | 'v1' | 'v2' | 'force' | { version, force } and wraps ANY
    // content type, not just media (donor: @prototypevip/baileys).
    if ('viewOnce' in message && message.viewOnce != null && message.viewOnce !== false) {
        m = wrapAunuViewOnce(m, message.viewOnce);
    }
    // AunuBaileys: viewOnceV2 / viewOnceV2Extension (dari @itsliaaa/baileys)
    else if ('viewOnceV2' in message && !!message.viewOnceV2) {
        m = { viewOnceMessageV2: { message: m } };
    }
    else if ('viewOnceV2Extension' in message && !!message.viewOnceV2Extension) {
        m = { viewOnceMessageV2Extension: { message: m } };
    }
    if (('mentions' in message && message.mentions?.length) ||
        ('mentionAll' in message && !!message.mentionAll)) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions;
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1;
            }
        }
        else if (key) {
            key.contextInfo = {
                ...(message.mentions?.length ? { mentionedJid: message.mentions } : {}),
                ...(message.mentionAll ? { nonJidMentions: 1 } : {})
            };
        }
    }
    // AunuBaileys: ephemeral (dari @itsliaaa/baileys)
    if ('ephemeral' in message && !!message.ephemeral) {
        m = { ephemeralMessage: { message: m } };
    }
    // AunuBaileys (1.0.71): group status — set contextInfo.isGroupStatus
    // and wrap the message into groupStatusMessageV2 (Message field 103).
    if ('groupStatus' in message && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if (key && typeof key === 'object' && 'contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key && typeof key === 'object') {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        // AunuBaileys (1.0.83, HB-165): the flag used to be deleted
        // from the CALLER's object here — a re-send of the same
        // content object silently lost its group-status wrapping.
        // The flag is already consumed into m; leave it in place.
    }
    // AunuBaileys (1.0.71): spoiler — set contextInfo.isSpoiler and wrap
    // the message into spoilerMessage (Message field 118).
    if ('spoiler' in message && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if (key && typeof key === 'object' && 'contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isSpoiler = message.spoiler;
        }
        else if (key && typeof key === 'object') {
            key.contextInfo = {
                isSpoiler: message.spoiler
            };
        }
        m = { spoilerMessage: { message: m } };
        // AunuBaileys (1.0.83, HB-165): same caller-object mutation
        // as the groupStatus block above — the flag stays on the
        // caller's object, so a re-send wraps identically.
    }
    // AunuBaileys: interactiveAsTemplate (dari @itsliaaa/baileys) — bungkus interactiveMessage
    // ke templateMessage; messageContextInfo (deviceListMetadata) dipertahankan di sisinya
    if ('interactiveAsTemplate' in message && !!message.interactiveAsTemplate) {
        if (!m.interactiveMessage) {
            throw new Boom('interactiveAsTemplate requires an interactive message', { statusCode: 400 });
        }
        m = {
            templateMessage: {
                interactiveMessageTemplate: m.interactiveMessage,
                templateId: message.templateId || 'template-' + Date.now()
            },
            ...(m.messageContextInfo ? { messageContextInfo: m.messageContextInfo } : {})
        };
    }
    if ('edit' in message) {
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
    if ('contextInfo' in message && !!message.contextInfo) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    // AunuBaileys (1.0.71): stamp a messageSecret unless one is already
    // present — the msmsg reply to this message can only be decrypted
    // with it (see lib/Utils/meta-ai-msmsg.js). Same exclusions as the
    // donor's shouldIncludeReportingToken().
    if (!m.messageContextInfo?.messageSecret && !m.reactionMessage && !m.encReactionMessage && !m.encEventResponseMessage && !m.pollUpdateMessage) {
        m.messageContextInfo = { ...(m.messageContextInfo || {}), messageSecret: randomBytes(32) };
    }
    return WAProto.Message.fromObject(m);
};
export const generateWAMessageFromContent = (jid, message, options) => {
    // set timestamp to now
    // if not specified
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    // AunuBaileys (1.0.86, HB-122): on the raw path the content
    // value can be a bare string ('conversation') or absent
    // entirely (key undefined). Quote and ephemeral contextInfo
    // can only be attached to an object-shaped value — the `in`
    // check and the property assignment below both threw raw
    // TypeErrors otherwise (Cannot use 'in' operator... /
    // Cannot create property 'contextInfo' on string...).
    const contextTarget = key ? innerMessage[key] : undefined;
    const canAttachContext = !!contextTarget && typeof contextTarget === 'object';
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;
    if (quoted) {
        const participant = quoted.key.fromMe
            ? userJid
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        // strip any redundant properties
        quotedMsg = proto.Message.fromObject({ [msgType]: quotedMsg[msgType] });
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
        // AunuBaileys (behaviour learned from @violetix/baileys): quoting
        // works inside newsletters too; only remoteJid stays withheld
        // for channels.
        if (!isJidNewsletter(jid) && jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && canAttachContext) {
            /* @ts-ignore */
            contextTarget.contextInfo = contextInfo;
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
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL,
            // AunuBaileys (protocol behaviour learned from @violetix/baileys):
            // WA Web stamps the chat's disappearing-mode setting alongside
            // the TTL; without it the receiving client warns the message
            // will not disappear. The setting timestamp passes through
            // when the caller tracks it.
            ...(options.ephemeralSettingTimestamp ? { ephemeralSettingTimestamp: options.ephemeralSettingTimestamp } : {}),
            disappearingMode: {
                initiator: proto.DisappearingMode.Initiator.CHANGED_IN_CHAT,
                trigger: options.disappearingModeTrigger ?? proto.DisappearingMode.Trigger.CHAT_SETTING
            }
        };
    }
    message = WAProto.Message.fromObject(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
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
            message?.spoilerMessage ||
            message?.groupStatusMessageV2 ||
            message?.editedMessage);
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
// AunuBaileys: 403 added — WhatsApp's media CDN answers 403 (not just 404/410)
// when a message's directPath/url auth has expired, which is exactly the stale-
// media case the phone re-upload exists for. Without it, downloads of older
// media failed permanently even though the sender's phone could re-upload.
// If the media is truly gone, the re-upload fails too and the error propagates.
const REUPLOAD_REQUIRED_STATUS = [410, 404, 403];
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            axios.isAxiosError(error) && // check if the message requires a reupload
            REUPLOAD_REQUIRED_STATUS.includes(error.response?.status)) {
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
        // AunuBaileys (1.0.85, HB-252): the content type derives
        // 'stickerPack' from stickerPackMessage, but the HKDF info
        // mapping only knows the upload-side name 'sticker-pack' —
        // downloads derived their keys from 'WhatsApp undefined
        // Keys' and ALWAYS failed with a misleading bad-decrypt
        // error. Normalise to the name the pack was encrypted with.
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
// AunuBaileys: penentu biz binary node (dari @itsliaaa/baileys)
export const shouldIncludeBizBinaryNode = (message) => !!(message.buttonsMessage ||
    message.listMessage ||
    message.templateMessage ||
    (message.interactiveMessage &&
        message.interactiveMessage.nativeFlowMessage));
//# sourceMappingURL=messages.js.map