import { proto } from '../../WAProto/index.js';
import { makeLibSignalRepository } from '../Signal/libsignal.js';
import { Browsers } from '../Utils/index.js';
import logger from '../Utils/logger.js';
import defaultVersion from './baileys-version.json' with { type: 'json' };
const { version } = defaultVersion;
export const UNAUTHORIZED_CODES = [401, 403, 419];
export const DEFAULT_ORIGIN = 'https://web.whatsapp.com';
export const DEF_CALLBACK_PREFIX = 'CB:';
export const DEF_TAG_PREFIX = 'TAG:';
export const PHONE_CONNECTION_CB = 'CB:Pong';
export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60;
export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';
export const DICT_VERSION = 3;
export const KEY_BUNDLE_TYPE = Buffer.from([5]);
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]); // last is "DICT_VERSION"
/** from: https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url */
export const URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g;
export const WA_CERT_DETAILS = {
    SERIAL: 0
};
export const PROCESSABLE_HISTORY_TYPES = [
    proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.Message.HistorySyncNotification.HistorySyncType.PUSH_NAME,
    proto.Message.HistorySyncNotification.HistorySyncType.RECENT,
    proto.Message.HistorySyncNotification.HistorySyncType.FULL,
    proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND
];
export const DEFAULT_CONNECTION_CONFIG = {
    version: version,
    browser: Browsers.ubuntu('Chrome'),
    waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    logger: logger.child({ class: 'baileys' }),
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000,
    customUploadHosts: [],
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    fireInitQueries: true,
    auth: undefined,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    patchMessageBeforeSending: msg => msg,
    shouldSyncHistoryMessage: () => true,
    shouldIgnoreJid: () => false,
    linkPreviewImageThumbnailWidth: 192,
    transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
    generateHighQualityLinkPreview: false,
    options: {},
    appStateMacVerification: {
        patch: false,
        snapshot: false
    },
    countryCode: 'US',
    getMessage: async () => undefined,
    cachedGroupMetadata: async () => undefined,
    makeSignalRepository: makeLibSignalRepository
};
export const MEDIA_PATH_MAP = {
    image: '/mms/image',
    video: '/mms/video',
    document: '/mms/document',
    audio: '/mms/audio',
    sticker: '/mms/image',
    'sticker-pack': '/mms/sticker-pack',
    'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack',
    'thumbnail-link': '/mms/image',
    'product-catalog-image': '/product/image',
    'md-app-state': '',
    'md-msg-hist': '/mms/md-app-state'
};
export const MEDIA_HKDF_KEY_MAPPING = {
    audio: 'Audio',
    document: 'Document',
    gif: 'Video',
    image: 'Image',
    ppic: '',
    product: 'Image',
    ptt: 'Audio',
    sticker: 'Image',
    video: 'Video',
    'thumbnail-document': 'Document Thumbnail',
    'thumbnail-image': 'Image Thumbnail',
    'thumbnail-video': 'Video Thumbnail',
    'thumbnail-link': 'Link Thumbnail',
    'md-msg-hist': 'History',
    'md-app-state': 'App State',
    'product-catalog-image': '',
    'payment-bg-image': 'Payment Background',
    ptv: 'Video'
};
export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP);
export const MIN_PREKEY_COUNT = 5;
export const INITIAL_PREKEY_COUNT = 812;
export const DEFAULT_CACHE_TTLS = {
    SIGNAL_STORE: 5 * 60, // 5 minutes
    MSG_RETRY: 60 * 60, // 1 hour
    CALL_OFFER: 5 * 60, // 5 minutes
    USER_DEVICES: 5 * 60 // 5 minutes
};
//# sourceMappingURL=index.js.map
// AunuBaileys: peta path upload khusus newsletter (dari @itsliaaa/baileys)
export const NEWSLETTER_MEDIA_PATH_MAP = {
    image: '/newsletter/newsletter-image',
    video: '/newsletter/newsletter-video',
    audio: '/newsletter/newsletter-audio',
    document: '/newsletter/newsletter-document',
    sticker: '/newsletter/newsletter-sticker',
    gif: '/newsletter/newsletter-gif',
    ptt: '/newsletter/newsletter-ptt',
    ptv: '/newsletter/newsletter-ptv',
    'music-artwork': '/mms/newsletter-music-artwork',
    'sticker-pack': '/newsletter/newsletter-sticker-pack',
    'thumbnail-link': '/newsletter/newsletter-thumbnail-link',
    'waffle-image': '/mms/waffle-image',
    'waffle-video': '/mms/waffle-video'
};
// AunuBaileys: payload label AI (dari @itsliaaa/baileys)
export const BIZ_BOT_SUPPORT_PAYLOAD = '{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}';
