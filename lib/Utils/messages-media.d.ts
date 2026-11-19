import { Boom } from '@hapi/boom';
import type { Agent } from 'https';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { waproto } from '../../WAProto/index.js';
import { type MediaType } from '../Defaults/index.js';
import type { DownloadableMessage, MediaConnInfo, MediaDecryptionKeyInfo, SocketConfig, WAMediaUpload, WAMediaUploadFunction, WAMessageContent, WAMessageKey } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
import type { ILogger } from './logger.js';
export declare const sanitizeMediaTimeoutMs: (value: unknown, fallback?: number) => number;
export declare const isMediaAbortError: (error: unknown) => boolean;
export declare const destroyQuietly: (stream: unknown) => void;
export declare const getImageProcessingLibrary: () => Promise<{
    sharp: typeof import("sharp");
    image?: undefined;
    jimp?: undefined;
} | {
    image: {
        default: typeof import("@napi-rs/image");
        compressJpeg(input: Uint8Array, options?: import("@napi-rs/image").JpegCompressOptions | undefined | null, signal?: AbortSignal | undefined | null): Promise<Buffer>;
        compressJpegSync(input: Uint8Array, options?: import("@napi-rs/image").JpegCompressOptions | undefined | null): Buffer;
        losslessCompressPng(input: Uint8Array, options?: import("@napi-rs/image").PNGLosslessOptions | undefined | null, signal?: AbortSignal | undefined | null): Promise<Buffer>;
        losslessCompressPngSync(input: Buffer, options?: import("@napi-rs/image").PNGLosslessOptions | undefined | null): Buffer;
        pngQuantize(input: Uint8Array, options?: import("@napi-rs/image").PngQuantOptions | undefined | null, signal?: AbortSignal | undefined | null): Promise<Buffer>;
        pngQuantizeSync(input: Uint8Array, options?: import("@napi-rs/image").PngQuantOptions | undefined | null): Buffer;
        __napiBindingTarget: "native" | "wasm32-wasi" | "wasm32-wasip1";
        Transformer: typeof import("@napi-rs/image").Transformer;
        BlendMode: typeof import("@napi-rs/image").BlendMode;
        ChromaSubsampling: typeof import("@napi-rs/image").ChromaSubsampling;
        CompressionType: typeof import("@napi-rs/image").CompressionType;
        FastResizeFilter: typeof import("@napi-rs/image").FastResizeFilter;
        FilterType: typeof import("@napi-rs/image").FilterType;
        Gravity: typeof import("@napi-rs/image").Gravity;
        JsColorType: typeof import("@napi-rs/image").JsColorType;
        Orientation: typeof import("@napi-rs/image").Orientation;
        PngRowFilter: typeof import("@napi-rs/image").PngRowFilter;
        ResizeFilterType: typeof import("@napi-rs/image").ResizeFilterType;
        ResizeFit: typeof import("@napi-rs/image").ResizeFit;
    };
    sharp?: undefined;
    jimp?: undefined;
} | {
    jimp: any;
    sharp?: undefined;
    image?: undefined;
}>;
export declare const MAX_IMAGE_PIXELS = 40000000;
export declare const assertImageWithinPixelLimit: (buffer: Buffer, context: string) => void;
export declare const hkdfInfoKey: (type: MediaType) => string;
export declare const getRawMediaUploadData: (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger, opts?: RequestInit & {
    maxContentLength?: number;
}) => Promise<{
    filePath: string;
    fileSha256: Buffer<ArrayBufferLike>;
    fileLength: number;
}>;
/** generates all the keys required to encrypt/decrypt & sign a media message */
export declare function getMediaKeys(buffer: Uint8Array | string | null | undefined, mediaType: MediaType): Promise<MediaDecryptionKeyInfo>;
export declare const extractImageThumb: (bufferOrFilePath: Readable | Buffer | string, width?: number) => Promise<{
    buffer: any;
    original: {
        width: any;
        height: any;
    };
}>;
export declare const encodeBase64EncodedStringForUpload: (b64: string) => string;
export declare const generateProfilePicture: (mediaUpload: WAMediaUpload, dimensions?: {
    width: number;
    height: number;
}) => Promise<{
    img: Buffer<ArrayBufferLike>;
}>;
/** gets the SHA256 of the given media message */
export declare const mediaMessageSHA256B64: (message: WAMessageContent) => string | null | undefined;
export declare function getAudioDuration(buffer: Buffer | string | Readable): Promise<number | undefined>;
/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export declare function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger): Promise<Uint8Array<ArrayBuffer> | undefined>;
export declare const toReadable: (buffer: Buffer) => Readable;
export declare const toBuffer: (stream: Readable) => Promise<Buffer<ArrayBuffer>>;
export declare const toBufferWithLimit: (stream: Readable, maxBytes: number) => Promise<Buffer<ArrayBuffer>>;
export declare const getStream: (item: WAMediaUpload, opts?: RequestInit & {
    maxContentLength?: number;
}) => Promise<{
    readonly stream: Readable;
    readonly type: "buffer";
} | {
    readonly stream: Readable;
    readonly type: "readable";
} | {
    readonly stream: Readable;
    readonly type: "remote";
} | {
    readonly stream: import("fs").ReadStream;
    readonly type: "file";
}>;
/** generates a thumbnail for a given media, if required */
export declare function generateThumbnail(file: string, mediaType: 'video' | 'image', options: {
    logger?: ILogger;
}): Promise<{
    thumbnail: string | undefined;
    originalImageDimensions: {
        width: number;
        height: number;
    } | undefined;
}>;
export declare const getHttpStream: (url: string | URL, options?: RequestInit & {
    isStream?: true;
}) => Promise<Readable>;
/**
 * Walks the top-level ISO-BMFF boxes (mp4/mov/3gp/m4a) in the leading
 * bytes. Streamable only when `moov` precedes `mdat`; non-ISO-BMFF
 * payloads (ogg/opus voice notes) are streamable. Returns true / false,
 * or null while the head is too short to decide.
 */
export declare const aunuScanStreamable: (head: Buffer) => boolean | null;
type EncryptedStreamOptions = {
    saveOriginalFileIfRequired?: boolean;
    logger?: ILogger;
    opts?: RequestInit;
    /** AunuBaileys (P2e port from v6): caller-supplied media key (32 bytes) — the sticker-pack thumbnail is encrypted under the pack's own key */
    mediaKey?: Buffer | Uint8Array;
};
export declare const encryptedStream: (media: WAMediaUpload, mediaType: MediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey }?: EncryptedStreamOptions) => Promise<{
    mediaKey: Buffer<ArrayBufferLike>;
    originalFilePath: string | undefined;
    encFilePath: string;
    mac: Buffer<ArrayBuffer>;
    fileEncSha256: Buffer<ArrayBufferLike>;
    fileSha256: Buffer<ArrayBufferLike>;
    fileLength: number;
    streamingSidecar: Buffer<ArrayBufferLike> | undefined;
}>;
export declare const DEF_MEDIA_HOST = "mmg.whatsapp.net";
export type MediaDownloadOptions = {
    startByte?: number;
    endByte?: number;
    options?: RequestInit;
    /** Optional media host override; falls back to DEF_MEDIA_HOST when not provided. */
    host?: string;
};
export declare const getUrlFromDirectPath: (directPath: string, host?: string) => string;
export declare const downloadContentFromMessage: ({ mediaKey, directPath, url }: DownloadableMessage, type: MediaType, opts?: MediaDownloadOptions) => Promise<Transform>;
/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export declare const downloadEncryptedContent: (downloadUrl: string, { cipherKey, iv, macKey }: MediaDecryptionKeyInfo, { startByte, endByte, options }?: MediaDownloadOptions) => Promise<Transform>;
export declare function extensionForMediaMessage(message: WAMessageContent): string | undefined;
type MediaUploadResult = {
    url?: string;
    direct_path?: string;
    meta_hmac?: string;
    ts?: number;
    fbid?: number;
};
export type UploadParams = {
    url: string;
    filePath: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    agent?: Agent;
};
export declare const uploadWithNodeHttp: ({ url, filePath, headers, timeoutMs, agent }: UploadParams, redirectCount?: number) => Promise<MediaUploadResult | undefined>;
export declare const getWAUploadToServer: ({ customUploadHosts, fetchAgent, logger, options }: SocketConfig, refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>) => WAMediaUploadFunction;
/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export declare const encryptMediaRetryRequest: (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => BinaryNode;
export declare const decodeMediaRetryNode: (node: BinaryNode) => {
    key: WAMessageKey;
    media?: {
        ciphertext: Uint8Array;
        iv: Uint8Array;
    };
    error?: Boom;
} | null;
export declare const decryptMediaRetryData: ({ ciphertext, iv }: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
}, mediaKey: Uint8Array, msgId: string) => waproto.MediaRetryNotification;
export declare const getStatusCodeForMediaRetry: (code: number) => 200 | 412 | 404 | 418;
export {};
//# sourceMappingURL=messages-media.d.ts.map